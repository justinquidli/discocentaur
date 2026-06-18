/**
 * Claudetaur — Claude-powered Discord bot with Quidli Connect integration
 *
 * Features:
 * - Claude assistant with per-channel conversation history
 * - Quidli Connect API: lookup wallet addresses for Discord users
 * - x402 payment support (pay-per-request in USDC on Base, no API key needed)
 * - Per-user Quidli API keys: DM !connect YOUR_KEY to use your own Smart Send wallet
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createWalletClient, http, parseUnits, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from 'discord.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const {
  DISCORD_TOKEN,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
  DISCORD_ACTIVE_CHANNELS = '',
  DISCORD_ALLOWED_USERS = '',
  SYSTEM_PROMPT = 'You are a helpful assistant in a Discord server powered by Quidli Connect. You can: (1) look up ETH/SOL wallet addresses for people by their social identity (Discord, Farcaster, email, etc.) using quidli_lookup; (2) send tokens to people using quidli_drop; (3) check web3 reputation scores using quidli_score. Be concise and friendly.',
  BOT_WALLET_PRIVATE_KEY,
  BOT_WALLET_ADDRESS,
  QUIDLI_API_KEY,               // Optional — if set, skips x402 payment
  DISCORD_ALLOWED_ROLES = '',   // Comma-separated role names allowed to use the bot
  MASTER_ENCRYPTION_KEY,        // 64 hex chars (32 bytes) — used to encrypt stored API keys
  BOT_OWNER_ID,                 // Discord user ID of the bot owner — uses host QUIDLI_API_KEY for drops automatically
} = process.env;

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is required');
if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
if (!BOT_WALLET_PRIVATE_KEY && !QUIDLI_API_KEY) {
  throw new Error('Either BOT_WALLET_PRIVATE_KEY or QUIDLI_API_KEY is required');
}

const ACTIVE_CHANNELS = new Set(
  DISCORD_ACTIVE_CHANNELS.split(',').map((s) => s.trim()).filter(Boolean)
);
const ALLOWED_USERS = new Set(
  DISCORD_ALLOWED_USERS.split(',').map((s) => s.trim()).filter(Boolean)
);
const ALLOWED_ROLES = new Set(
  DISCORD_ALLOWED_ROLES.split(',').map((s) => s.trim()).filter(Boolean)
);

const DISCORD_MSG_LIMIT = 1900;
const EDIT_THROTTLE_MS = 750;
const QUIDLI_BASE_URL = 'https://api.connect.quid.li';

// ─── Encryption helpers ───────────────────────────────────────────────────────

// AES-256-GCM encryption using MASTER_ENCRYPTION_KEY from .env.
// If no key is set, values are stored in plaintext (with a warning on startup).
const encKey = MASTER_ENCRYPTION_KEY ? Buffer.from(MASTER_ENCRYPTION_KEY, 'hex') : null;

function encrypt(plaintext) {
  if (!encKey) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store as iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  if (!encKey) return stored;
  const [ivHex, tagHex, dataHex] = stored.split(':');
  const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8');
}

// ─── Per-user key store ───────────────────────────────────────────────────────

const db = new DatabaseSync('./users.db');
db.exec(`CREATE TABLE IF NOT EXISTS user_keys (
  discord_id TEXT PRIMARY KEY,
  api_key    TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)`);

function getUserApiKey(discordId) {
  const row = db.prepare('SELECT api_key FROM user_keys WHERE discord_id = ?').get(discordId);
  if (!row) return null;
  return decrypt(row.api_key);
}

function setUserApiKey(discordId, apiKey) {
  db.prepare('INSERT OR REPLACE INTO user_keys (discord_id, api_key) VALUES (?, ?)').run(discordId, encrypt(apiKey));
}

function deleteUserApiKey(discordId) {
  db.prepare('DELETE FROM user_keys WHERE discord_id = ?').run(discordId);
}

// ─── Wallet (for x402 payments) ───────────────────────────────────────────────

let walletClient;
if (BOT_WALLET_PRIVATE_KEY) {
  const account = privateKeyToAccount(BOT_WALLET_PRIVATE_KEY);
  walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });
}

// ─── Quidli API ───────────────────────────────────────────────────────────────

/**
 * Call Quidli with x402 payment fallback.
 * If QUIDLI_API_KEY is set, uses that instead of paying.
 */
async function quidliFetch(path, options = {}, apiKey = QUIDLI_API_KEY) {
  const url = `${QUIDLI_BASE_URL}${path}`;

  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    ...(options.headers ?? {}),
  };

  const res = await fetch(url, { ...options, headers });

  // x402: payment required — handle the payment flow (only when using host wallet, not per-user keys)
  if (res.status === 402 && walletClient && !apiKey) {
    const paymentDetails = await res.json();
    console.log('[x402] payment required:', JSON.stringify(paymentDetails, null, 2));

    // Extract payment info from the 402 response
    // x402 standard: paymentDetails.accepts[] contains payment options
    const payment = paymentDetails.accepts?.[0];
    if (!payment) throw new Error('No payment method offered by x402 response');

    const { scheme, network, asset, amount, payTo } = payment;

    if (scheme !== 'exact' || asset?.symbol !== 'USDC') {
      throw new Error(`Unsupported x402 payment scheme: ${scheme} / ${asset?.symbol}`);
    }

    // USDC on Base has 6 decimals
    const amountInUnits = BigInt(amount);

    // USDC contract on Base
    const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    // Transfer USDC to payTo address
    const txHash = await walletClient.sendTransaction({
      to: USDC_BASE,
      data: encodeFunctionData({
        abi: [{
          name: 'transfer',
          type: 'function',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        }],
        functionName: 'transfer',
        args: [payTo, amountInUnits],
      }),
    });

    console.log(`[x402] paid ${amount} USDC, tx: ${txHash}`);

    // Retry the original request with the payment proof
    const retryRes = await fetch(url, {
      ...options,
      headers: {
        ...headers,
        'X-Payment': JSON.stringify({ txHash, network, scheme }),
      },
    });

    if (!retryRes.ok) {
      const body = await retryRes.text();
      throw new Error(`Quidli error after payment ${retryRes.status}: ${body}`);
    }
    return retryRes;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Quidli error ${res.status}: ${body}`);
  }

  return res;
}

/**
 * Lookup wallet addresses for Discord users by username or ID.
 * Handles async processing (polls follow-up if needed).
 */
async function quidliLookup(recipients) {
  const res = await quidliFetch('/lookup', {
    method: 'POST',
    body: JSON.stringify({ recipients }),
  });

  const data = await res.json();

  if (data.status === 'completed') {
    return data.results;
  }

  if (data.status === 'processing' && data.pendingRequestId) {
    // Poll follow-up until completed (max 10 attempts, 2s apart)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const followUp = await quidliFetch(`/lookup/follow-up/${data.pendingRequestId}`);
      const followData = await followUp.json();
      if (followData.status === 'completed') {
        // Re-run the original lookup to get addresses
        const retry = await quidliFetch('/lookup', {
          method: 'POST',
          body: JSON.stringify({ recipients }),
        });
        const retryData = await retry.json();
        return retryData.results ?? [];
      }
    }
    throw new Error('Lookup timed out after processing');
  }

  throw new Error(`Unexpected lookup status: ${data.status}`);
}

// ─── Discord role lookup ──────────────────────────────────────────────────────

// guild is set once the client is ready
let activeGuild = null;
let membersFetchedAt = 0;
const MEMBERS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function ensureMembersFetched() {
  if (!activeGuild) throw new Error('Guild not available');
  const now = Date.now();
  if (now - membersFetchedAt > MEMBERS_CACHE_TTL) {
    await activeGuild.members.fetch();
    membersFetchedAt = now;
  }
}

async function getDiscordRoleMembers(roleQuery, excludeIds = []) {
  await ensureMembersFetched();
  // Match by ID or name (case-insensitive)
  const role = activeGuild.roles.cache.find(
    (r) => r.id === roleQuery || r.name.toLowerCase() === roleQuery.toLowerCase()
  );
  if (!role) throw new Error(`Role "${roleQuery}" not found in this server`);
  const excluded = new Set(excludeIds);
  return role.members
    .filter((m) => !m.user.bot && !excluded.has(m.id))
    .map((m) => ({
      type: 'discord',
      id: m.id,
      username: m.user.username,
      displayName: m.displayName,
    }));
}

// ─── Quidli drop ─────────────────────────────────────────────────────────────

async function quidliDrop({ recipients, amountInWeiPerRecipient, chainId = 8453, tokenContract }, apiKey = QUIDLI_API_KEY) {
  // Quidli requires exactly one of id or username per recipient — prefer id if both are set
  recipients = recipients.map(({ type, id, username }) => {
    if (id) return { type, id };
    if (username) return { type, username };
    return { type };
  });
  if (!apiKey) {
    throw new Error('No Quidli API key available for this drop. DM me `!connect <your-api-key>` to link your account, or ask the bot owner to configure a host key.');
  }
  const idempotencyKey = crypto.randomUUID();
  const res = await quidliFetch('/drop', {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey, chainId, tokenContract, amountInWeiPerRecipient, recipients }),
  }, apiKey);
  return res.json();
}

// ─── Quidli score ─────────────────────────────────────────────────────────────

async function quidliScore({ users, filter }) {
  const body = { users };
  if (filter) body.filter = filter;
  const res = await quidliFetch('/scores', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Claude tools ─────────────────────────────────────────────────────────────

const RECIPIENT_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['discord', 'email', 'phone', 'twitter', 'telegram', 'farcaster', 'github', 'linkedin'],
      description: 'The social platform type',
    },
    id: { type: 'string', description: 'Numeric user ID on that platform. Use EITHER id OR username, never both.' },
    username: { type: 'string', description: 'Handle/username on that platform. Use EITHER id OR username, never both.' },
  },
  required: ['type'],
};

const tools = [
  {
    name: 'quidli_lookup',
    description:
      'Look up the Ethereum and Solana wallet addresses for one or more people by their social identity (Discord, email, Farcaster, GitHub, Telegram, LinkedIn, Twitter, phone). Use whenever someone asks for a wallet address.',
    input_schema: {
      type: 'object',
      properties: {
        recipients: { type: 'array', items: RECIPIENT_SCHEMA, description: 'List of social identities to look up' },
      },
      required: ['recipients'],
    },
  },
  {
    name: 'discord_get_role_members',
    description:
      'Get all Discord members who have a specific role. Use this when someone mentions a role using @. When a role is mentioned, the message contains the role name and its Role ID in parentheses — always use the Role ID (the numeric string) as the roleName parameter, not the display name. Bots are always excluded. Always pass the sender\'s Discord ID in excludeIds.',
    input_schema: {
      type: 'object',
      properties: {
        roleName: { type: 'string', description: 'The Discord Role ID (numeric string from the Role ID field in the mention, e.g. "921399859892850688")' },
        excludeIds: { type: 'array', items: { type: 'string' }, description: 'Discord user IDs to exclude (always include the sender\'s Discord ID here)' },
      },
      required: ['roleName'],
    },
  },
  {
    name: 'quidli_drop',
    description:
      'Send tokens to one or more people by their social identity using Quidli Smart Send. Requires Smart Send to be enabled at connect.quid.li and QUIDLI_API_KEY set. Use whenever someone asks to send, tip, or drop tokens/USDC to a person.',
    input_schema: {
      type: 'object',
      properties: {
        recipients: { type: 'array', items: RECIPIENT_SCHEMA, description: 'List of recipients' },
        amountInWeiPerRecipient: { type: 'string', description: 'Amount in wei (smallest unit) per recipient. E.g. "1000000" for 1 USDC (6 decimals).' },
        tokenContract: { type: 'string', description: 'Token contract address. USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        chainId: { type: 'number', description: 'Chain ID. Base = 8453 (default).' },
      },
      required: ['recipients', 'amountInWeiPerRecipient', 'tokenContract'],
    },
  },
  {
    name: 'quidli_score',
    description:
      'Get the web3 reputation/social score for a user (Quidli score, Neynar, Lens, Ethos). Accepts any social identity — Discord, Farcaster, email, etc. The Quidli registry resolves identities across platforms automatically. Use when someone asks about reputation, trustworthiness, or social standing.',
    input_schema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['discord', 'email', 'phone', 'twitter', 'telegram', 'farcaster', 'github', 'linkedin'] },
              id: { type: 'string', description: 'The user ID or handle' },
              value: { type: 'string', description: 'The user ID or handle (alias for id)' },
            },
            required: ['type'],
          },
        },
        filter: {
          type: 'object',
          description: 'Optional: filter results to users meeting a minimum score threshold',
          properties: {
            type: { type: 'string', enum: ['quidli_score', 'lens_score', 'neynar_score', 'ethos_twitter_reputation', 'ethos_wallet_reputation'] },
            minScore: { type: 'number' },
          },
        },
      },
      required: ['users'],
    },
  },
];

async function runTool(name, input, { senderId, botId, senderApiKey, senderUser } = {}) {
  if (name === 'discord_get_role_members') {
    // Always exclude the sender and the bot, regardless of what Claude passes
    const alwaysExclude = [senderId, botId].filter(Boolean);
    const excludeIds = [...new Set([...(input.excludeIds ?? []), ...alwaysExclude])];
    const members = await getDiscordRoleMembers(input.roleName, excludeIds);
    return JSON.stringify(members, null, 2);
  }
  if (name === 'quidli_lookup') {
    const results = await quidliLookup(input.recipients);
    return JSON.stringify(results, null, 2);
  }
  if (name === 'quidli_drop') {
    // Key priority: personal key → owner fallback to host key → block
    const isOwner = BOT_OWNER_ID && senderId === BOT_OWNER_ID;
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) {
      // DM the user privately so the setup instructions don't appear in the channel
      if (senderUser) {
        senderUser.send(
          'To send tokens, you need to connect your Quidli account first.\n\n' +
          'Get your API key at https://connect.quid.li, then DM me:\n`!connect <your-api-key>`'
        ).catch(() => {});
      }
      return JSON.stringify({
        error: 'User has no Quidli API key connected. I\'ve sent them a DM with setup instructions. Let them know to check their DMs.',
      });
    }
    const result = await quidliDrop(input, keyToUse);
    return JSON.stringify(result, null, 2);
  }
  if (name === 'quidli_score') {
    const result = await quidliScore(input);
    return JSON.stringify(result, null, 2);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ─── Anthropic client ─────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Conversation history ─────────────────────────────────────────────────────

const histories = new Map();
const MAX_HISTORY = 40;

function getHistory(channelId) {
  if (!histories.has(channelId)) histories.set(channelId, []);
  return histories.get(channelId);
}

function addToHistory(channelId, role, content) {
  const history = getHistory(channelId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ─── Discord helpers ──────────────────────────────────────────────────────────

function chunkText(text, limit = DISCORD_MSG_LIMIT) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }
  return chunks;
}

function createThrottledEditor(replyMessage) {
  let pending = null;
  let timer = null;
  let lastEdit = 0;
  let extraMessages = [];

  async function flush() {
    if (pending === null) return;
    const text = pending;
    pending = null;

    const chunks = chunkText(text);
    const primary = chunks[0] ?? '…';
    const overflow = chunks.slice(1);

    try {
      await replyMessage.edit(primary);
      lastEdit = Date.now();

      for (let i = 0; i < overflow.length; i++) {
        if (extraMessages[i]) {
          await extraMessages[i].edit(overflow[i]);
        } else {
          const msg = await replyMessage.channel.send(overflow[i]);
          extraMessages.push(msg);
        }
      }
    } catch (err) {
      console.warn('[discord] edit failed:', err.message);
    }
  }

  return {
    update(newText) {
      pending = newText;
      const now = Date.now();
      const delay = Math.max(0, EDIT_THROTTLE_MS - (now - lastEdit));
      if (!timer) {
        timer = setTimeout(async () => {
          timer = null;
          await flush();
        }, delay);
      }
    },
    async finalize(finalText) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = finalText;
      await flush();
    },
  };
}

// ─── Message handler ──────────────────────────────────────────────────────────

async function handleMessage(message) {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(message.client.user);
  const isActiveChannel = ACTIVE_CHANNELS.has(message.channelId);

  if (!isMentioned && !isActiveChannel) return;

  if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(message.author.id)) {
    await message.reply('You are not authorized to use this bot.').catch(() => {});
    return;
  }

  if (ALLOWED_ROLES.size > 0) {
    const memberRoles = message.member?.roles.cache.map((r) => r.name) ?? [];
    const hasRole = memberRoles.some((r) => ALLOWED_ROLES.has(r));
    if (!hasRole) {
      const roleList = [...ALLOWED_ROLES].map((r) => `\`${r}\``).join(', ');
      await message.reply(`Only ${roleList} members can engage with me.`).catch(() => {});
      return;
    }
  }

  // Replace @user mentions with "username (Discord ID: 123456)"
  // Replace @role mentions with "roleName (Role ID: 123456)"
  // Strip the bot's own mention
  const botId = message.client.user.id;
  let text = message.content
    .replace(/<@!?(\d+)>/g, (match, userId) => {
      if (userId === botId) return '';
      const member = message.guild?.members.cache.get(userId);
      const name = member?.displayName ?? member?.user?.username ?? userId;
      return `@${name} (Discord ID: ${userId})`;
    })
    .replace(/<@&(\d+)>/g, (match, roleId) => {
      const role = message.guild?.roles.cache.get(roleId);
      const name = role?.name ?? roleId;
      return `@${name} (Role ID: ${roleId})`;
    })
    .trim();

  if (!text) {
    await message.reply('What can I help you with?').catch(() => {});
    return;
  }

  const contextId = message.channel.isThread?.()
    ? message.channelId
    : `${message.guildId ?? 'dm'}-${message.channelId}`;

  const replyMsg = await message.reply('_Thinking…_').catch((err) => {
    console.error('[discord] reply failed:', err.message);
    return null;
  });
  if (!replyMsg) return;

  const editor = createThrottledEditor(replyMsg);

  // Prefix with sender identity so Claude knows who "me/I/my" refers to
  const senderName = message.member?.displayName ?? message.author.username;
  const senderApiKey = getUserApiKey(message.author.id);
  const isOwner = BOT_OWNER_ID && message.author.id === BOT_OWNER_ID;
  const walletNote = senderApiKey
    ? '[User has a personal Quidli API key connected — drops will use their Smart Send wallet]'
    : isOwner
      ? '[User is the bot owner — drops will use the host Smart Send wallet]'
      : '[User has NO personal Quidli API key — do NOT execute any drops. If they request a drop, tell them they must first DM me `!connect <your-api-key>` to link their Quidli account (get a key at connect.quid.li). Do not proceed with any token transfer.]';
  const contextualText = `[Sent by @${senderName} (Discord ID: ${message.author.id})] ${walletNote}\n${text}`;
  addToHistory(contextId, 'user', contextualText);

  let accumulated = '';

  try {
    // Agentic loop: Claude can call tools, then continue responding
    let messages = getHistory(contextId);

    while (true) {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      // Collect any text from this turn
      for (const block of response.content) {
        if (block.type === 'text') {
          accumulated += block.text;
          editor.update(accumulated || '_Thinking…_');
        }
      }

      // If Claude wants to use a tool, run it and continue
      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

        // Add Claude's response to messages
        messages = [...messages, { role: 'assistant', content: response.content }];

        // Run all tools and collect results
        const toolResults = await Promise.all(
          toolUseBlocks.map(async (block) => {
            editor.update((accumulated || '_Thinking…_') + '\n_Looking up…_');
            try {
              const result = await runTool(block.name, block.input, {
                senderId: message.author.id,
                botId: message.client.user.id,
                senderApiKey,
                senderUser: message.author,
              });
              return {
                type: 'tool_result',
                tool_use_id: block.id,
                content: result,
              };
            } catch (err) {
              console.error(`[tool] ${block.name} error:`, err.message);
              return {
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Error: ${err.message}`,
                is_error: true,
              };
            }
          })
        );

        messages = [...messages, { role: 'user', content: toolResults }];
        continue; // loop back to let Claude respond to tool results
      }

      // Claude is done
      break;
    }

    const finalText = accumulated || '_(no response)_';
    await editor.finalize(finalText);
    addToHistory(contextId, 'assistant', finalText);

  } catch (err) {
    console.error('[claude] error:', err);
    const history = getHistory(contextId);
    if (history.at(-1)?.role === 'user') history.pop();
    await editor.finalize(`⚠️ Error: ${err.message}`);
  }
}

// ─── DM command handler ───────────────────────────────────────────────────────

async function handleDM(message) {
  const content = message.content.trim();

  if (content.startsWith('!connect ')) {
    const apiKey = content.slice('!connect '.length).trim();
    if (!apiKey) {
      await message.reply('Please provide your API key: `!connect <your-api-key>`');
      return;
    }
    setUserApiKey(message.author.id, apiKey);
    await message.reply(
      '✅ Connected! Drops will now use your Smart Send wallet.\n\n' +
      '⚠️ Your API key is stored encrypted and only has access to your Smart Send balance — not your main wallet. ' +
      'Keep only amounts you\'re comfortable with for sending. DM `!revoke` anytime to disconnect.'
    );
    return;
  }

  if (content === '!revoke') {
    const had = getUserApiKey(message.author.id);
    deleteUserApiKey(message.author.id);
    await message.reply(had
      ? '🗑️ Your API key has been removed. You won\'t be able to send tokens to others until you reconnect with `!connect <your-api-key>`.'
      : "You don't have a key stored. Nothing to remove.");
    return;
  }

  await message.reply(
    'Available commands:\n' +
    '`!connect <your-api-key>` — link your Quidli account so drops use your own Smart Send wallet\n' +
    '`!revoke` — remove your stored API key\n\n' +
    'Get a Quidli API key at https://connect.quid.li'
  );
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Claudetaur ready — logged in as ${c.user.tag}`);
  console.log(`   Model: ${CLAUDE_MODEL}`);
  console.log(`   Quidli: ${QUIDLI_API_KEY ? 'API key' : 'x402 payments'}`);
  console.log(`   Key storage: ${encKey ? 'encrypted (AES-256-GCM)' : '⚠️  plaintext — set MASTER_ENCRYPTION_KEY to encrypt'}`);
  if (ACTIVE_CHANNELS.size > 0) {
    console.log(`   Active channels: ${[...ACTIVE_CHANNELS].join(', ')}`);
  } else {
    console.log('   Mode: respond when @mentioned');
  }
  // Store the first guild for role lookups
  activeGuild = c.guilds.cache.first() ?? null;
  if (activeGuild) console.log(`   Guild: ${activeGuild.name}`);
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  // DMs: handle !connect / !revoke commands
  if (!message.guild) {
    handleDM(message).catch((err) => console.error('[dm] unhandled error:', err));
    return;
  }
  handleMessage(message).catch((err) =>
    console.error('[bot] unhandled error:', err)
  );
});

client.login(DISCORD_TOKEN);
