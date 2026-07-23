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
import { createMindsClient, isReplyHistoryRow } from '@animocabrands/minds-client-lib';
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
  SYSTEM_PROMPT: SYSTEM_PROMPT_OVERRIDE,
  BOT_WALLET_PRIVATE_KEY,
  BOT_WALLET_ADDRESS,
  QUIDLI_API_KEY,               // Optional — if set, skips x402 payment
  DISCORD_ALLOWED_ROLES = '',   // Comma-separated role names allowed to use the bot
  MASTER_ENCRYPTION_KEY,        // 64 hex chars (32 bytes) — used to encrypt stored API keys
  BOT_OWNER_ID,                 // Discord user ID of the bot owner — uses host QUIDLI_API_KEY for drops automatically
  BRAVE_SEARCH_API_KEY,         // Brave Search API key for web search tool
  // Multi-LLM provider support
  DEFAULT_LLM_PROVIDER = 'anthropic', // anthropic | gemini | openai | minds
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-2.0-flash',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o',
  REQUIRE_USER_LLM_KEY = 'false', // Set to 'true' to require users to bring their own LLM key
  // Minds (Animoca Brands) — per-user credentials registered via DM: !minds <key> [mind-name]
} = process.env;

const REQUIRE_USER_LLM = REQUIRE_USER_LLM_KEY === 'true';

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

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = SYSTEM_PROMPT_OVERRIDE || `
You are DiscoCentaur, a Discord bot that sends crypto tokens to people using Quidli Connect. Your job is to EXECUTE — not explain, not ask for confirmation, not hedge. When someone asks you to do something, do it.

## Core philosophy
- Bias toward action. If you have enough info to act, act.
- Never ask "are you sure?" or "shall I proceed?" — if they asked, they're sure.
- Only ask the user for more info after you've exhausted all tool options.
- Be concise. One sentence for success, one sentence for failure.

## Sending tokens (quidli_drop)
- ALWAYS call quidli_lookup for every recipient FIRST, before calling quidli_drop. quidli_lookup auto-generates a wallet for recipients who aren't in the Quidli registry yet — it may take a few seconds while it processes, but it will resolve them. Only after quidli_lookup succeeds for a recipient should you call quidli_drop for them.
- USDC on Base: chainId=8453, tokenContract=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 1 USDC = 1000000 amountInWeiPerRecipient (6 decimals).
- Always generate a fresh UUID for idempotencyKey.
- After success, always show the basescan URL: https://basescan.org/tx/<transferHash>
- If quidli_drop still returns an error like "Some recipients could not be resolved" even after a successful quidli_lookup, tell the user exactly that and point them to https://connect.quid.li (the ONLY correct URL — never invent or guess a different domain).
- Use EXACTLY one of "id" or "username" per recipient, never both.

## Looking up wallets (quidli_lookup)
Call quidli_lookup whenever the user asks for a wallet address, AND always before every quidli_drop (see above) — it resolves identities and auto-generates wallets for people not yet in the registry.

Supported identity types: discord, farcaster, twitter, telegram, email, github, linkedin, phone.

When a lookup fails, work through ALL available identifiers before giving up:
1. If a Discord mention is in the message, try { type: "discord", id: "<DISCORD_ID>" } first (ID is in the message context as "(Discord ID: 123456)"), then { type: "discord", username: "<display_name>" }
2. If a Farcaster handle is mentioned (e.g. @name.eth or /name), try { type: "farcaster", username: "<handle>" }
3. If a Twitter/X handle is mentioned, try { type: "twitter", username: "<handle>" }
4. If a Telegram username is mentioned, try { type: "telegram", username: "<handle>" }
5. If an email is mentioned, try { type: "email", id: "<email>" }
6. If a GitHub username is mentioned, try { type: "github", username: "<handle>" }
7. If none of the above work, ask the user which other social handles the person has (Farcaster, Twitter, email, etc.) and try those.
Only after exhausting all available identifiers, tell the user the person isn't in the Quidli registry yet.

The same multi-identity fallback applies to quidli_drop and quidli_score — always try the most specific identifier first, then fall back through others.

## Looking up linked accounts (quidli_exposed)
Use quidli_exposed when someone asks what accounts a person has linked, or when you only have a username and need a numeric ID. Returns all platforms linked to that identity (email, wallet, smart_wallet, telegram, discord, etc.).
- If you have a Discord username but no numeric ID, call quidli_exposed with { type: "discord", username: "<handle>" } to get their numeric ID, then use that for drops.

## Identity summary ("tell me about myself", "who am I?")
When someone asks about themselves — "tell me about myself", "who am I?", "what do you know about me?", "summarize my profile", "based on my socials" — do ALL of the following:
1. Call quidli_exposed with their Discord ID (from the message context) to get all linked accounts
2. Call quidli_score with their Discord ID to get their web3 reputation scores
3. For each professional/social platform in the exposed results (GitHub, LinkedIn, Twitter, Farcaster), call web_search to look up their public profile — find their employer, job title, notable projects, bio, or anything publicly known about them
Then synthesize everything into a warm, conversational paragraph: who they are professionally, what they build or work on, their on-chain presence and wallet addresses, and their reputation standing. Make it feel like a smart introduction, not a data dump. If LinkedIn or GitHub is linked, lean into those for professional context.

## Resolving Discord mentions
Every message includes context like: "@Guillaume (Discord ID: 712682660786602035)". Always extract and use the Discord ID — it's more reliable than display names. If only a username is available, use quidli_exposed to resolve it first.

## Checking reputation (quidli_score)
Use quidli_score when asked about trust, reputation, or scores. Pass the most specific identity available.

## Web search (web_search)
Use web_search for any real-world facts: prices, scores, event results, news. Always search before answering factual questions about the world.

## Tool honesty — CRITICAL
NEVER claim a drop, conditional drop, watcher, or any action was completed unless you have an actual tool result in your context confirming it. This means:
- Do NOT write "Done!", "That's set!", or report a jobId unless you received it from a real tool response.
- Do NOT fabricate jobIds, transaction hashes, wallet addresses, or any other IDs.
- If you described doing something but have no tool result to back it up, say so immediately and call the tool for real.
- After any scheduling action, always quote the actual jobId from the tool response in your confirmation.

## Scheduling drops (schedule_drop)
Use schedule_drop when asked to send tokens at a future time. Store presenceFilter instead of recipients if the drop should target online users at execution time, not now.

## Conditional drops (conditional_drop)
Use conditional_drop when a drop depends on a real-world outcome ("if X wins", "if BTC hits $100k").
ALWAYS use web_search first to find the event's scheduled end time in UTC. Pass that time as checkAt (ISO 8601 UTC string, e.g. "2026-06-27T22:30:00Z") with a 30-minute buffer after the expected end. Never guess — search for the exact UTC time.

## Channel watchers (create_watcher)
Use create_watcher when asked to send tokens to whoever types a specific phrase. The watcher fires automatically when triggered.

## Cancelling / rescheduling
Use cancel_scheduled_drop or reschedule_drop for scheduled drops. Use cancel_watcher for watchers. Use list_scheduled_drops / list_watchers to show what's pending.

## Presence-based drops (discord_get_members_by_status)
Use discord_get_members_by_status to get currently online/idle/dnd members. For scheduled presence drops, store the filter — don't resolve recipients until execution time.

## Tool retry behavior
If a tool call returns an error or empty result:
1. Analyze what went wrong.
2. Try a different approach (different identity type, different parameters).
3. Only report failure to the user after at least 2 attempts.

## Response format
- Success: state what you did + basescan URL if applicable. One or two sentences max.
- Failure: state what you tried and what the user can do next. No raw JSON, no stack traces.
- Never show internal error messages verbatim to the user.
`.trim();

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
  // If not in iv:tag:data format, it was stored before encryption was enabled — return as-is
  const parts = stored.split(':');
  if (parts.length !== 3) return stored;
  try {
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8');
  } catch {
    return stored;
  }
}

// ─── Per-user key store ───────────────────────────────────────────────────────

const db = new DatabaseSync('./users.db');
db.exec(`CREATE TABLE IF NOT EXISTS user_keys (
  discord_id      TEXT PRIMARY KEY,
  api_key         TEXT NOT NULL,
  minds_alias     TEXT,
  minds_api_key   TEXT,
  minds_name      TEXT,
  created_at      INTEGER DEFAULT (unixepoch())
)`);
// Add columns if upgrading from older schema
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_alias TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_api_key TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_name TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_mind_id TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_alias_created_at INTEGER`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN llm_provider TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN llm_api_key TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN llm_model TEXT`); } catch { /* already exists */ }

// Per-provider LLM keys — a user can store anthropic, gemini, openai, and openrouter keys side by side
db.exec(`CREATE TABLE IF NOT EXISTS user_llm_keys (
  user_id  TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_key  TEXT NOT NULL,
  model    TEXT,
  PRIMARY KEY (user_id, provider)
)`);
// One-time migration from the legacy single-key columns (idempotent)
db.exec(`INSERT OR IGNORE INTO user_llm_keys (user_id, provider, api_key, model)
  SELECT discord_id, llm_provider, llm_api_key, llm_model FROM user_keys
  WHERE llm_provider IS NOT NULL AND llm_api_key IS NOT NULL`);
db.exec(`CREATE TABLE IF NOT EXISTS scheduled_drops (
  id         TEXT PRIMARY KEY,
  sender_id  TEXT NOT NULL,
  channel_id TEXT,
  drop_input TEXT NOT NULL,
  execute_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  executed   INTEGER DEFAULT 0
)`);
try { db.exec(`ALTER TABLE scheduled_drops ADD COLUMN channel_id TEXT`); } catch { }
db.exec(`CREATE TABLE IF NOT EXISTS watchers (
  id            TEXT PRIMARY KEY,
  sender_id     TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  trigger_phrase TEXT NOT NULL,
  drop_input    TEXT NOT NULL,
  max_winners   INTEGER DEFAULT 1,
  winner_count  INTEGER DEFAULT 0,
  winner_ids    TEXT DEFAULT '[]',
  created_at    INTEGER DEFAULT (unixepoch()),
  fired         INTEGER DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS channel_settings (
  context_id TEXT PRIMARY KEY,
  provider   TEXT NOT NULL DEFAULT 'anthropic',
  model      TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
)`);
// Channel-level model override (e.g. "switch to fable" / "switch to kimi") — for upgrades
try { db.exec(`ALTER TABLE channel_settings ADD COLUMN model TEXT`); } catch { /* already exists */ }

function getUserApiKey(discordId) {
  const row = db.prepare('SELECT api_key FROM user_keys WHERE discord_id = ?').get(discordId);
  if (!row) return null;
  return decrypt(row.api_key);
}

function setUserApiKey(discordId, apiKey) {
  db.prepare(`INSERT INTO user_keys (discord_id, api_key) VALUES (?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET api_key = excluded.api_key`)
    .run(discordId, encrypt(apiKey));
}

function deleteUserApiKey(discordId) {
  db.prepare("UPDATE user_keys SET api_key = '' WHERE discord_id = ?").run(discordId);
}

function getUserLlmKeyFor(discordId, provider) {
  const row = db.prepare('SELECT api_key, model FROM user_llm_keys WHERE user_id = ? AND provider = ?').get(discordId, provider);
  if (!row?.api_key) return null;
  return { provider, apiKey: decrypt(row.api_key), model: row.model ?? null };
}

function hasAnyUserLlmKey(discordId) {
  return !!db.prepare('SELECT 1 FROM user_llm_keys WHERE user_id = ? LIMIT 1').get(discordId);
}

function setUserLlmKey(discordId, provider, apiKey, model) {
  db.prepare(`INSERT INTO user_llm_keys (user_id, provider, api_key, model)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET api_key = excluded.api_key, model = COALESCE(excluded.model, user_llm_keys.model)`)
    .run(discordId, provider, encrypt(apiKey), model ?? null);
}

function setUserLlmModel(discordId, provider, model) {
  db.prepare('UPDATE user_llm_keys SET model = ? WHERE user_id = ? AND provider = ?').run(model, discordId, provider);
}

function deleteUserLlmKey(discordId, provider) {
  if (provider) {
    db.prepare('DELETE FROM user_llm_keys WHERE user_id = ? AND provider = ?').run(discordId, provider);
  } else {
    db.prepare('DELETE FROM user_llm_keys WHERE user_id = ?').run(discordId);
  }
  // Clear legacy columns so the migration doesn't resurrect removed keys
  db.prepare('UPDATE user_keys SET llm_provider = NULL, llm_api_key = NULL, llm_model = NULL WHERE discord_id = ?').run(discordId);
}

function getUserMindsCredentials(discordId) {
  const row = db.prepare('SELECT minds_alias, minds_api_key, minds_name, minds_mind_id, minds_alias_created_at FROM user_keys WHERE discord_id = ?').get(discordId);
  if (!row?.minds_alias || !row?.minds_api_key) return null;
  return {
    alias: row.minds_alias,
    apiKey: decrypt(row.minds_api_key),
    name: row.minds_name ?? 'Minds',
    mindId: row.minds_mind_id ?? null,
    aliasCreatedAt: row.minds_alias_created_at ?? null,
  };
}

function setUserMindsCredentials(discordId, apiKey, alias, mindName, mindId) {
  db.prepare(`INSERT INTO user_keys (discord_id, api_key, minds_alias, minds_api_key, minds_name, minds_mind_id, minds_alias_created_at)
    VALUES (?, '', ?, ?, ?, ?, unixepoch())
    ON CONFLICT(discord_id) DO UPDATE SET
      minds_alias = excluded.minds_alias,
      minds_api_key = excluded.minds_api_key,
      minds_name = excluded.minds_name,
      minds_mind_id = excluded.minds_mind_id,
      minds_alias_created_at = excluded.minds_alias_created_at`)
    .run(discordId, alias, encrypt(apiKey), mindName ?? null, mindId ?? null);
}

function deleteUserMindsCredentials(discordId) {
  db.prepare('UPDATE user_keys SET minds_alias = NULL, minds_api_key = NULL, minds_name = NULL, minds_mind_id = NULL, minds_alias_created_at = NULL WHERE discord_id = ?').run(discordId);
}

// ─── Scheduled drops ─────────────────────────────────────────────────────────

async function executeScheduledDrop(jobId) {
  const job = db.prepare('SELECT * FROM scheduled_drops WHERE id = ? AND executed = 0').get(jobId);
  if (!job) return; // already executed, cancelled, or missing

  db.prepare('UPDATE scheduled_drops SET executed = 1 WHERE id = ?').run(jobId);

  const stored = JSON.parse(job.drop_input);
  const isOwner = BOT_OWNER_ID && job.sender_id === BOT_OWNER_ID;
  const senderApiKey = getUserApiKey(job.sender_id);
  const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);

  try {
    if (!keyToUse) throw new Error('No API key available — sender may have revoked their key.');

    // If a presenceFilter was stored, resolve recipients NOW (at execution time)
    let dropInput = { ...stored };
    if (stored.presenceFilter) {
      const { statuses, roleId, excludeIds = [] } = stored.presenceFilter;
      const liveMembers = await getMembersByStatus(statuses, roleId, [job.sender_id, ...excludeIds]);
      if (liveMembers.length === 0) {
        const user = await client.users.fetch(job.sender_id).catch(() => null);
        if (user) await user.send(`⚠️ Your scheduled drop ran but no members matched the status filter at execution time.`).catch(() => {});
        return;
      }
      dropInput.recipients = liveMembers;
      delete dropInput.presenceFilter;
    }

    const result = await quidliDrop(dropInput, keyToUse);
    if (result.transferHash) result.basescanUrl = `https://basescan.org/tx/${result.transferHash}`;

    // DM the sender
    const user = await client.users.fetch(job.sender_id).catch(() => null);
    if (user) {
      const recipientCount = dropInput.recipients?.length ?? 1;
      await user.send(
        `✅ Your scheduled drop executed!\n` +
        `Sent to ${recipientCount} recipient${recipientCount !== 1 ? 's' : ''}.\n` +
        (result.basescanUrl ? `Transaction: ${result.basescanUrl}` : '')
      ).catch(() => {});
    }
    // DM each Discord recipient
    if (result.transferHash) {
      const discordRecipients = (dropInput.recipients ?? []).filter((r) => r.type === 'discord' && r.id);
      for (const r of discordRecipients) {
        const recipientUser = await client.users.fetch(r.id).catch(() => null);
        if (recipientUser) {
          recipientUser.send(
            `🎉 You just received tokens!\n` +
            `Transaction: https://basescan.org/tx/${result.transferHash}`
          ).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error(`[scheduled-drop] ${jobId} failed:`, err.message);
    const user = await client.users.fetch(job.sender_id).catch(() => null);
    if (user) {
      await user.send(`⚠️ Your scheduled drop failed: ${err.message}`).catch(() => {});
    }
  }
}

function scheduleDropJob(jobId, executeAt) {
  const delay = Math.max(0, executeAt - Date.now());
  setTimeout(() => executeScheduledDrop(jobId), delay);
}

function loadPendingDrops() {
  const pending = db.prepare('SELECT id, drop_input, execute_at FROM scheduled_drops WHERE executed = 0').all();
  for (const job of pending) {
    const stored = JSON.parse(job.drop_input);
    const isConditional = stored.type === 'conditional';
    const executeAt = job.execute_at * 1000;
    const delay = Math.max(0, executeAt - Date.now());
    if (isConditional) {
      setTimeout(() => executeConditionalDrop(job.id), delay);
    } else {
      scheduleDropJob(job.id, executeAt);
    }
    console.log(`[scheduled-drop] re-queued ${isConditional ? 'conditional' : 'regular'} ${job.id} (executes in ${Math.round(delay / 60000)}m)`);
  }
}

// ─── Web search (Brave) ───────────────────────────────────────────────────────

async function braveSearch(query) {
  if (!BRAVE_SEARCH_API_KEY) throw new Error('BRAVE_SEARCH_API_KEY is not set');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_SEARCH_API_KEY,
      },
    });
    if (!res.ok) throw new Error(`Brave Search error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    console.log(`[brave-search] "${query}" → ${data.web?.results?.length ?? 0} results`);
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Conditional drop executor ────────────────────────────────────────────────

async function executeConditionalDrop(jobId) {
  const job = db.prepare('SELECT * FROM scheduled_drops WHERE id = ? AND executed = 0').get(jobId);
  if (!job) return;

  db.prepare('UPDATE scheduled_drops SET executed = 1 WHERE id = ?').run(jobId);

  const stored = JSON.parse(job.drop_input);
  const { condition, dropParams } = stored;

  const senderUser = await client.users.fetch(job.sender_id).catch(() => null);

  try {
    // Use Claude to evaluate the condition via web search
    const evalNow = new Date();
    const evalMessages = [
      {
        role: 'user',
        content: `You are a condition evaluator. Determine if the following condition is currently true or false.\n\nCurrent date/time: ${evalNow.toUTCString()}\nCondition: "${condition}"\n\nInstructions:\n1. Search the web using specific, targeted queries. Include the current year (${evalNow.getFullYear()}) in queries about events.\n2. After gathering evidence, output ONLY a raw JSON object on a single line — no markdown, no explanation:\n{"result": true} or {"result": false}`,
      },
    ];

    const evalTools = [{
      name: 'web_search',
      description: 'Search the web for current information',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }];

    let evalMessages2 = evalMessages;
    let conditionMet = false;

    for (let i = 0; i < 5; i++) {
      const evalRes = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        tools: evalTools,
        messages: evalMessages2,
      });

      if (evalRes.stop_reason === 'tool_use') {
        const toolBlocks = evalRes.content.filter((b) => b.type === 'tool_use');
        const toolResults = await Promise.all(toolBlocks.map(async (tb) => {
          const searchResults = await braveSearch(tb.input.query);
          return { type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(searchResults) };
        }));
        evalMessages2 = [
          ...evalMessages2,
          { role: 'assistant', content: evalRes.content },
          { role: 'user', content: toolResults },
        ];
        continue;
      }

      // Parse the final answer
      const text = evalRes.content.find((b) => b.type === 'text')?.text ?? '';
      const match = text.match(/\{.*"result"\s*:\s*(true|false).*\}/s);
      if (match) conditionMet = match[1] === 'true';
      break;
    }

    if (!conditionMet) {
      if (senderUser) await senderUser.send(`❌ Condition not met: "${condition}"\nDrop cancelled.`).catch(() => {});
      return;
    }

    // Condition met — execute the drop
    const isOwner = BOT_OWNER_ID && job.sender_id === BOT_OWNER_ID;
    const senderApiKey = getUserApiKey(job.sender_id);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) throw new Error('No API key available — sender may have revoked their key.');

    let resolvedDrop = { ...dropParams };
    if (dropParams.presenceFilter) {
      const { statuses, roleId, excludeIds = [] } = dropParams.presenceFilter;
      resolvedDrop.recipients = await getMembersByStatus(statuses, roleId, [job.sender_id, ...excludeIds]);
      delete resolvedDrop.presenceFilter;
    }

    const result = await quidliDrop(resolvedDrop, keyToUse);
    if (result.transferHash) result.basescanUrl = `https://basescan.org/tx/${result.transferHash}`;

    if (senderUser) {
      const recipientCount = resolvedDrop.recipients?.length ?? 1;
      await senderUser.send(
        `✅ Condition met: "${condition}"\n` +
        `Drop executed to ${recipientCount} recipient${recipientCount !== 1 ? 's' : ''}.\n` +
        (result.basescanUrl ? `Transaction: ${result.basescanUrl}` : '')
      ).catch(() => {});
    }

    // DM recipients
    if (result.transferHash) {
      for (const r of (resolvedDrop.recipients ?? []).filter((r) => r.type === 'discord' && r.id)) {
        const u = await client.users.fetch(r.id).catch(() => null);
        if (u) u.send(`🎉 You received tokens!\nTransaction: https://basescan.org/tx/${result.transferHash}`).catch(() => {});
      }
    }

  } catch (err) {
    console.error(`[conditional-drop] ${jobId} failed:`, err.message);
    if (senderUser) await senderUser.send(`⚠️ Conditional drop failed: ${err.message}`).catch(() => {});
  }
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

// ─── Discord message search ───────────────────────────────────────────────────

async function searchDiscordMessages({ query, channelId, withinMinutes = 60, excludeIds = [], currentChannelId }) {
  const targetChannelId = channelId || currentChannelId;
  if (!targetChannelId) throw new Error('No channel ID available');

  const channel = await client.channels.fetch(targetChannelId).catch(() => null);
  if (!channel) throw new Error(`Channel ${targetChannelId} not found or not accessible`);
  if (!channel.isTextBased()) throw new Error('Channel is not a text channel');

  const since = Date.now() - withinMinutes * 60 * 1000;
  const excluded = new Set(excludeIds);
  const matchingUsers = new Map(); // id → user info

  let lastId = null;
  let done = false;

  while (!done) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    for (const msg of messages.values()) {
      if (msg.createdTimestamp < since) { done = true; break; }
      if (msg.author.bot) continue;
      if (excluded.has(msg.author.id)) continue;
      if (query && !msg.content.toLowerCase().includes(query.toLowerCase())) continue;
      if (!matchingUsers.has(msg.author.id)) {
        matchingUsers.set(msg.author.id, {
          type: 'discord',
          id: msg.author.id,
          username: msg.author.username,
          displayName: msg.member?.displayName ?? msg.author.username,
        });
      }
    }

    lastId = messages.last()?.id;
    if (messages.size < 100) break;
  }

  return [...matchingUsers.values()];
}

// ─── Presence-based member lookup ────────────────────────────────────────────

async function getMembersByStatus(statuses, roleId, excludeIds = []) {
  await ensureMembersFetched();
  const statusSet = new Set(statuses.map((s) => s.toLowerCase()));
  const excluded = new Set(excludeIds);

  let members = activeGuild.members.cache;

  // Filter by role if requested
  if (roleId) {
    const role = activeGuild.roles.cache.find(
      (r) => r.id === roleId || r.name.toLowerCase() === roleId.toLowerCase()
    );
    if (!role) throw new Error(`Role "${roleId}" not found`);
    members = role.members;
  }

  return members
    .filter((m) => {
      if (m.user.bot) return false;
      if (excluded.has(m.id)) return false;
      const presence = m.presence?.status ?? 'offline';
      return statusSet.has(presence);
    })
    .map((m) => ({
      type: 'discord',
      id: m.id,
      username: m.user.username,
      displayName: m.displayName,
      status: m.presence?.status ?? 'offline',
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

// ─── Quidli exposed ───────────────────────────────────────────────────────────

async function quidliExposed(recipient) {
  const res = await quidliFetch('/lookup/exposed', { method: 'POST', body: JSON.stringify({ recipient }) });
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
    name: 'web_search',
    description:
      'Search the web for current information — match results, news, prices, scores, anything real-time. Use whenever the user asks about something that may have happened recently or you need up-to-date facts.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'conditional_drop',
    description:
      'Schedule a token drop that only executes if a real-world condition is true at a future check time (e.g. "if France wins tonight", "if BTC is above $100k tomorrow morning"). ' +
      'IMPORTANT: Only use this if the condition can be verified as a clear YES or NO via a web search. ' +
      'If the condition is ambiguous or cannot be verified objectively, refuse and ask the user to rephrase. ' +
      'ALWAYS use web_search first to find the event\'s scheduled end time in UTC. Pass that time as checkAt (ISO 8601 UTC string, e.g. "2026-06-27T22:30:00Z") with a 30-minute buffer after the expected end. Never guess — search for the exact UTC time.',
    input_schema: {
      type: 'object',
      properties: {
        condition: { type: 'string', description: 'The condition to evaluate, stated as a clear yes/no question. E.g. "Did France win their FIFA World Cup match today?"' },
        checkAt: { type: 'string', description: 'ISO 8601 UTC timestamp for when to evaluate the condition, e.g. "2026-06-27T22:30:00Z". Use web_search to find the event\'s scheduled end time in UTC, then add a 30-minute buffer.' },
        recipients: { type: 'array', items: RECIPIENT_SCHEMA, description: 'Explicit list of recipients. Use this OR presenceFilter, not both.' },
        presenceFilter: {
          type: 'object',
          description: 'Resolve recipients by presence status at execution time.',
          properties: {
            statuses: { type: 'array', items: { type: 'string', enum: ['online', 'idle', 'dnd', 'offline'] } },
            roleId: { type: 'string' },
            excludeIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['statuses'],
        },
        amountInWeiPerRecipient: { type: 'string' },
        tokenContract: { type: 'string' },
        chainId: { type: 'number' },
      },
      required: ['condition', 'checkAt', 'amountInWeiPerRecipient', 'tokenContract'],
    },
  },
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
    name: 'discord_search_messages',
    description:
      'Search recent messages in a Discord channel and return the unique users who sent matching messages. Use when asked to find users based on what they typed (e.g. "everyone who said gm in the last hour", "users who mentioned launch today"). If no channelId is specified, searches the current channel.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for in messages (case-insensitive). Omit to match all messages.' },
        channelId: { type: 'string', description: 'Discord channel ID to search. Omit to search the current channel.' },
        withinMinutes: { type: 'number', description: 'How far back to search in minutes. Default: 60.' },
        excludeIds: { type: 'array', items: { type: 'string' }, description: 'Discord user IDs to exclude from results.' },
      },
    },
  },
  {
    name: 'discord_get_members_by_status',
    description:
      'Get Discord members filtered by their online status (online, idle, dnd, offline). Use when someone wants to send tokens only to members who are currently active or online. Requires the Presence Intent to be enabled in the Discord Developer Portal.',
    input_schema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['online', 'idle', 'dnd', 'offline'] },
          description: 'List of statuses to include. E.g. ["online", "idle"] for active members.',
        },
        roleId: { type: 'string', description: 'Optional: only include members with this role (name or ID).' },
        excludeIds: { type: 'array', items: { type: 'string' }, description: 'Discord user IDs to exclude (always include the sender\'s ID).' },
      },
      required: ['statuses'],
    },
  },
  {
    name: 'schedule_drop',
    description:
      'Schedule a Quidli token drop to execute in the future (e.g. "in 1 hour", "in 30 minutes"). The job is stored in the database so it survives bot restarts. Use when someone says "send X in N minutes/hours" or "schedule a drop for later". Do NOT use for immediate drops — use quidli_drop for those.',
    input_schema: {
      type: 'object',
      properties: {
        delayMinutes: { type: 'number', description: 'How many minutes from now to execute the drop.' },
        recipients: { type: 'array', items: RECIPIENT_SCHEMA, description: 'Explicit list of recipients. Use this OR presenceFilter, not both.' },
        presenceFilter: {
          type: 'object',
          description: 'Instead of a fixed recipient list, resolve recipients by presence status at execution time. Use when the user says things like "everyone online in 1 hour".',
          properties: {
            statuses: { type: 'array', items: { type: 'string', enum: ['online', 'idle', 'dnd', 'offline'] } },
            roleId: { type: 'string', description: 'Optional role name or ID to further filter members.' },
            excludeIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['statuses'],
        },
        amountInWeiPerRecipient: { type: 'string', description: 'Amount in wei per recipient.' },
        tokenContract: { type: 'string', description: 'Token contract address.' },
        chainId: { type: 'number', description: 'Chain ID. Base = 8453 (default).' },
      },
      required: ['delayMinutes', 'amountInWeiPerRecipient', 'tokenContract'],
    },
  },
  {
    name: 'list_scheduled_drops',
    description: 'List all pending (not yet executed) scheduled drops for the current user. Use when someone asks what drops they have scheduled or wants to see their queue.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reschedule_drop',
    description:
      'Update the check time of a pending scheduled or conditional drop. Use when someone says "push it back", "change the time", or "recheck the time". ' +
      'ALWAYS use web_search first to find the event\'s scheduled end time in UTC. Pass that time as newCheckAt (ISO 8601 UTC string, e.g. "2026-06-27T22:30:00Z") with a 30-minute buffer after the expected end. Never guess — search for the exact UTC time. ' +
      'Get the job ID from list_scheduled_drops if needed.',
    input_schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID to reschedule.' },
        newCheckAt: { type: 'string', description: 'New absolute UTC time to check/execute, as an ISO 8601 string e.g. "2026-06-27T22:30:00Z".' },
      },
      required: ['jobId', 'newCheckAt'],
    },
  },
  {
    name: 'cancel_scheduled_drop',
    description: 'Cancel a pending scheduled drop by its job ID. Use when someone wants to cancel a drop they scheduled. Get the job ID from list_scheduled_drops first if needed.',
    input_schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID of the scheduled drop to cancel.' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'create_watcher',
    description:
      'Watch a Discord channel for a trigger phrase and automatically send tokens to whoever types it first. Use when someone says "send X to the first person who types Y" or "reward anyone who says Z in this channel". The drop fires automatically without any @mention needed.',
    input_schema: {
      type: 'object',
      properties: {
        triggerPhrase: { type: 'string', description: 'The phrase to watch for (case-insensitive match).' },
        channelId: { type: 'string', description: 'Channel to watch. Omit to use the current channel.' },
        maxWinners: { type: 'number', description: 'How many people can win. Default 1 ("first person only").' },
        amountInWeiPerRecipient: { type: 'string', description: 'Amount in wei per winner.' },
        tokenContract: { type: 'string', description: 'Token contract address.' },
        chainId: { type: 'number', description: 'Chain ID. Base = 8453 (default).' },
      },
      required: ['triggerPhrase', 'amountInWeiPerRecipient', 'tokenContract'],
    },
  },
  {
    name: 'list_watchers',
    description: 'List all active channel watchers for the current user.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_watcher',
    description: 'Cancel an active channel watcher. Get the watcher ID from list_watchers if needed.',
    input_schema: {
      type: 'object',
      properties: {
        watcherId: { type: 'string', description: 'The watcher ID to cancel.' },
      },
      required: ['watcherId'],
    },
  },
  {
    name: 'quidli_exposed',
    description: "Look up all linked social accounts and wallets for a person. Use when someone asks 'what accounts does X have?', 'what's linked to this email/handle?', or when you need to resolve a username to a numeric ID before sending. Returns all platforms linked to that identity (email, wallet, smart_wallet, discord, telegram, etc.).",
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['discord', 'email', 'phone', 'twitter', 'telegram', 'farcaster', 'github', 'linkedin'],
            },
            id: { type: 'string', description: 'Numeric ID or email. Use EITHER id OR username.' },
            username: { type: 'string', description: 'Handle/username. Use EITHER id OR username.' },
          },
          required: ['type'],
        },
      },
      required: ['recipient'],
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

// Tracks basescan URLs produced during a single handleMessage turn so they can
// always be shown — even if the LLM forgets to include them in its response.
const _pendingBasescanUrls = [];

async function runTool(name, input, { senderId, botId, senderApiKey, senderUser, currentChannelId } = {}) {
  console.log(`[tool] ${name}`, JSON.stringify(input).slice(0, 120));
  if (name === 'web_search') {
    const results = await braveSearch(input.query);
    return JSON.stringify(results, null, 2);
  }
  if (name === 'conditional_drop') {
    const isOwner = BOT_OWNER_ID && senderId === BOT_OWNER_ID;
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) {
      if (senderUser) {
        senderUser.send(
          'To schedule conditional drops, connect your Quidli account first.\n\n' +
          'Get your API key at https://connect.quid.li, then DM me:\n`!connect <your-api-key>`'
        ).catch(() => {});
      }
      return JSON.stringify({ error: 'No Quidli API key connected. Sent a DM with setup instructions.' });
    }
    const { condition, checkAt, ...dropParams } = input;
    const checkAtMs = new Date(checkAt).getTime();
    if (isNaN(checkAtMs)) return JSON.stringify({ error: 'Invalid checkAt timestamp. Provide an ISO 8601 UTC string, e.g. "2026-06-27T22:30:00Z".' });
    const executeAt = Math.floor(checkAtMs / 1000);
    const jobId = crypto.randomUUID();
    // Store type=conditional so the executor knows to evaluate the condition first
    db.prepare('INSERT INTO scheduled_drops (id, sender_id, drop_input, execute_at) VALUES (?, ?, ?, ?)')
      .run(jobId, senderId, JSON.stringify({ type: 'conditional', condition, dropParams }), executeAt);
    setTimeout(() => executeConditionalDrop(jobId), Math.max(0, checkAtMs - Date.now()));
    return JSON.stringify({
      success: true,
      jobId,
      condition,
      checkAt: new Date(executeAt * 1000).toISOString(),
      message: `Conditional drop set. I'll check "${condition}" at ${new Date(executeAt * 1000).toUTCString()} and DM you the outcome.`,
    });
  }
  if (name === 'create_watcher') {
    const isOwner = BOT_OWNER_ID && senderId === BOT_OWNER_ID;
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) {
      if (senderUser) senderUser.send('To create watchers, connect your Quidli account first.\n\nGet your API key at https://connect.quid.li, then DM me:\n`!connect <your-api-key>`').catch(() => {});
      return JSON.stringify({ error: 'No Quidli API key connected. Sent a DM with setup instructions.' });
    }
    const watcherId = crypto.randomUUID();
    const dropInput = { amountInWeiPerRecipient: input.amountInWeiPerRecipient, tokenContract: input.tokenContract, chainId: input.chainId ?? 8453 };
    db.prepare('INSERT INTO watchers (id, sender_id, channel_id, trigger_phrase, drop_input, max_winners) VALUES (?, ?, ?, ?, ?, ?)')
      .run(watcherId, senderId, input.channelId ?? currentChannelId, input.triggerPhrase, JSON.stringify(dropInput), input.maxWinners ?? 1);
    return JSON.stringify({ success: true, watcherId, message: `Watching for "${input.triggerPhrase}" in this channel. First person to type it gets the drop.` });
  }
  if (name === 'list_watchers') {
    const watchers = db.prepare('SELECT id, trigger_phrase, channel_id, max_winners, winner_count FROM watchers WHERE sender_id = ? AND fired = 0').all(senderId);
    return JSON.stringify(watchers, null, 2);
  }
  if (name === 'cancel_watcher') {
    const watcher = db.prepare('SELECT id, sender_id FROM watchers WHERE id = ? AND fired = 0').get(input.watcherId);
    if (!watcher) return JSON.stringify({ error: 'No active watcher found with that ID.' });
    if (watcher.sender_id !== senderId) return JSON.stringify({ error: 'You can only cancel your own watchers.' });
    db.prepare('UPDATE watchers SET fired = 1 WHERE id = ?').run(input.watcherId);
    return JSON.stringify({ success: true, message: 'Watcher cancelled.' });
  }
  if (name === 'discord_get_role_members') {
    // Always exclude the sender and the bot, regardless of what Claude passes
    const alwaysExclude = [senderId, botId].filter(Boolean);
    const excludeIds = [...new Set([...(input.excludeIds ?? []), ...alwaysExclude])];
    const members = await getDiscordRoleMembers(input.roleName, excludeIds);
    return JSON.stringify(members, null, 2);
  }
  if (name === 'discord_get_members_by_status') {
    const alwaysExclude = [senderId, botId].filter(Boolean);
    const excludeIds = [...new Set([...(input.excludeIds ?? []), ...alwaysExclude])];
    const members = await getMembersByStatus(input.statuses, input.roleId, excludeIds);
    return JSON.stringify(members, null, 2);
  }
  if (name === 'list_scheduled_drops') {
    const jobs = db.prepare('SELECT id, drop_input, execute_at FROM scheduled_drops WHERE sender_id = ? AND executed = 0 ORDER BY execute_at ASC').all(senderId);
    if (jobs.length === 0) return JSON.stringify({ pending: [] });
    return JSON.stringify({
      pending: jobs.map((j) => ({
        jobId: j.id,
        scheduledFor: new Date(j.execute_at * 1000).toISOString(),
        drop: JSON.parse(j.drop_input),
      })),
    }, null, 2);
  }
  if (name === 'reschedule_drop') {
    const job = db.prepare('SELECT id, sender_id, drop_input FROM scheduled_drops WHERE id = ? AND executed = 0').get(input.jobId);
    if (!job) return JSON.stringify({ error: 'No pending drop found with that ID.' });
    if (job.sender_id !== senderId) return JSON.stringify({ error: 'You can only reschedule your own drops.' });
    const checkAtMs = new Date(input.newCheckAt).getTime();
    if (isNaN(checkAtMs)) return JSON.stringify({ error: 'Invalid newCheckAt timestamp. Provide an ISO 8601 UTC string, e.g. "2026-06-27T22:30:00Z".' });
    const newExecuteAt = Math.floor(checkAtMs / 1000);
    db.prepare('UPDATE scheduled_drops SET execute_at = ? WHERE id = ?').run(newExecuteAt, input.jobId);
    // Re-queue with new time
    const stored = JSON.parse(job.drop_input);
    const isConditional = stored.type === 'conditional';
    const delay = Math.max(0, checkAtMs - Date.now());
    if (isConditional) {
      setTimeout(() => executeConditionalDrop(input.jobId), delay);
    } else {
      setTimeout(() => executeScheduledDrop(input.jobId), delay);
    }
    return JSON.stringify({
      success: true,
      newCheckAt: new Date(newExecuteAt * 1000).toISOString(),
      message: `Rescheduled — will check at ${new Date(newExecuteAt * 1000).toISOString()}.`,
    });
  }
  if (name === 'cancel_scheduled_drop') {
    const job = db.prepare('SELECT id, sender_id FROM scheduled_drops WHERE id = ? AND executed = 0').get(input.jobId);
    if (!job) return JSON.stringify({ error: 'No pending drop found with that ID.' });
    if (job.sender_id !== senderId) return JSON.stringify({ error: 'You can only cancel your own scheduled drops.' });
    db.prepare('UPDATE scheduled_drops SET executed = 1 WHERE id = ?').run(input.jobId);
    return JSON.stringify({ success: true, message: 'Scheduled drop cancelled.' });
  }
  if (name === 'schedule_drop') {
    const isOwner = BOT_OWNER_ID && senderId === BOT_OWNER_ID;
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) {
      if (senderUser) {
        senderUser.send(
          'To schedule token drops, you need to connect your Quidli account first.\n\n' +
          'Get your API key at https://connect.quid.li, then DM me:\n`!connect <your-api-key>`'
        ).catch(() => {});
      }
      return JSON.stringify({ error: 'User has no Quidli API key connected. Sent them a DM with setup instructions.' });
    }
    const { delayMinutes, ...dropInput } = input;
    const executeAt = Math.floor((Date.now() + delayMinutes * 60 * 1000) / 1000); // unix seconds
    const jobId = crypto.randomUUID();
    db.prepare('INSERT INTO scheduled_drops (id, sender_id, drop_input, execute_at) VALUES (?, ?, ?, ?)')
      .run(jobId, senderId, JSON.stringify(dropInput), executeAt);
    scheduleDropJob(jobId, executeAt * 1000);
    const executeDate = new Date(executeAt * 1000);
    return JSON.stringify({
      success: true,
      jobId,
      scheduledFor: executeDate.toISOString(),
      message: `Drop scheduled for ${delayMinutes} minute${delayMinutes !== 1 ? 's' : ''} from now. I'll DM you when it executes.`,
    });
  }
  if (name === 'discord_search_messages') {
    const alwaysExclude = [senderId, botId].filter(Boolean);
    const excludeIds = [...new Set([...(input.excludeIds ?? []), ...alwaysExclude])];
    const results = await searchDiscordMessages({ ...input, excludeIds, currentChannelId });
    return JSON.stringify(results, null, 2);
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
    if (result.transferHash) {
      result.basescanUrl = `https://basescan.org/tx/${result.transferHash}`;
      _pendingBasescanUrls.push(result.basescanUrl);
    }
    console.log('[drop] result:', JSON.stringify(result, null, 2));
    // DM each Discord recipient to let them know they received tokens
    if (result.transferHash) {
      const discordRecipients = (input.recipients ?? []).filter((r) => r.type === 'discord' && r.id);
      for (const r of discordRecipients) {
        const recipientUser = await client.users.fetch(r.id).catch(() => null);
        if (recipientUser) {
          recipientUser.send(
            `🎉 You just received tokens from someone in your server!\n` +
            `Transaction: https://basescan.org/tx/${result.transferHash}`
          ).catch(() => {});
        }
      }
    }
    return JSON.stringify(result, null, 2);
  }
  if (name === 'quidli_score') {
    const result = await quidliScore(input);
    return JSON.stringify(result, null, 2);
  }
  if (name === 'quidli_exposed') {
    return JSON.stringify(await quidliExposed(input.recipient), null, 2);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ─── LLM clients ─────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function getAnthropicClient(userApiKey) {
  if (userApiKey) return new Anthropic({ apiKey: userApiKey });
  return anthropic;
}

async function getGeminiClient(userApiKey) {
  const key = userApiKey || GEMINI_API_KEY;
  if (!key) throw new Error('No Gemini API key available. DM me `!llm gemini <key>` to connect your own.');
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey: key });
}

async function getOpenAIClient(userApiKey, baseURL) {
  const key = userApiKey || OPENAI_API_KEY;
  if (!key) throw new Error('No OpenAI API key available. DM me `!llm openai <key>` to connect your own.');
  const { default: OpenAI } = await import('openai');
  return new OpenAI({ apiKey: key, ...(baseURL ? { baseURL } : {}) });
}

// ─── Tool format converters ───────────────────────────────────────────────────

// Gemini: { functionDeclarations: [{ name, description, parameters }] }
function getGeminiTools() {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
  }];
}

// OpenAI: [{ type: 'function', function: { name, description, parameters } }]
function getOpenAITools() {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// ─── Provider switching ───────────────────────────────────────────────────────

// Per-channel LLM provider — persisted to SQLite so restarts don't reset it
function getChannelProvider(contextId) {
  const row = db.prepare('SELECT provider FROM channel_settings WHERE context_id = ?').get(contextId);
  return row?.provider ?? DEFAULT_LLM_PROVIDER;
}

function getChannelModel(contextId) {
  const row = db.prepare('SELECT model FROM channel_settings WHERE context_id = ?').get(contextId);
  return row?.model ?? null;
}

// Switching providers always resets the model (null unless a specific model was named)
function setChannelProvider(contextId, provider, model = null) {
  db.prepare(`INSERT INTO channel_settings (context_id, provider, model, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(context_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, updated_at = unixepoch()`)
    .run(contextId, provider, model);
}

function detectProviderSwitch(text) {
  const lower = text.toLowerCase();
  // Match "switch to X", "use X", "change to X", "switch X on", etc.
  if (/(switch|change|use|swap)\s+(to\s+)?(gemini|google)/.test(lower)) return 'gemini';
  if (/(switch|change|use|swap)\s+(to\s+)?(openai|gpt|chatgpt|open\s*ai)/.test(lower)) return 'openai';
  if (/(switch|change|use|swap)\s+(to\s+)?(claude|anthropic|fable|opus|haiku|sonnet)/.test(lower)) return 'anthropic';
  if (/(switch|change|use|swap)\s+(to\s+)?(openrouter|open\s*router|kimi|llama|mistral|deepseek)/.test(lower)) return 'openrouter';
  // Also match "gemini mode", "claude mode"
  if (/\bgemini\s+mode\b/.test(lower)) return 'gemini';
  if (/\bopenai\s+mode\b/.test(lower)) return 'openai';
  if (/\b(claude|fable|opus|haiku|sonnet)\s+mode\b/.test(lower)) return 'anthropic';
  if (/\b(openrouter|kimi|llama|mistral|deepseek)\s+mode\b/.test(lower)) return 'openrouter';
  if (/(switch|change|use|swap)\s+(to\s+)?minds/.test(lower)) return 'minds';
  if (/\bminds\s+mode\b/.test(lower)) return 'minds';
  return null;
}

// Map friendly model names to OpenRouter slugs. Named model in a switch phrase
// (e.g. "switch to kimi") sets the user's OpenRouter model too.
const OPENROUTER_MODEL_ALIASES = {
  kimi: 'moonshotai/kimi-k2.6',
  llama: 'meta-llama/llama-3.3-70b-instruct',
  deepseek: 'deepseek/deepseek-chat',
  mistral: 'mistralai/mistral-large',
};

// Claude via OpenRouter for BYOLLM users who only have an OpenRouter key
const OPENROUTER_CLAUDE_SLUG = 'anthropic/claude-sonnet-4.6';

// Named Claude models for "switch to fable" etc.
const ANTHROPIC_MODEL_ALIASES = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
};

function detectOpenRouterModel(text) {
  const lower = text.toLowerCase();
  for (const [alias, slug] of Object.entries(OPENROUTER_MODEL_ALIASES)) {
    if (lower.includes(alias)) return slug;
  }
  return null;
}

function detectAnthropicModel(text) {
  const lower = text.toLowerCase();
  for (const [alias, slug] of Object.entries(ANTHROPIC_MODEL_ALIASES)) {
    if (lower.includes(alias)) return slug;
  }
  return null;
}

// ─── Conversation history (per-provider) ─────────────────────────────────────

const anthropicHistories = new Map(); // { role: 'user'|'assistant', content: string }[]
const geminiHistories    = new Map(); // { role: 'user'|'model', parts: [...] }[]
const openaiHistories    = new Map(); // { role: 'user'|'assistant', content: string }[]
const MAX_HISTORY = 40;

// Minds responses often use HTML — strip to plain text before passing to Claude
function stripHtml(text) {
  return text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

// True if the Mind's response contains a resolved wallet address and either action language or an amount
function looksLikePendingAction(text) {
  const hasWallet = /0x[0-9a-fA-F]{40}/i.test(text);
  const hasActionLanguage = /\b(confirm|fire it?|proceed|approve|go ahead|ready to|shall i|execute|let me know|either path|two paths?|two options?|option \d|queued|send is|drop is)\b/i.test(text);
  const hasAmount = /\b(usdc|usdt|wei|eth)\b/i.test(text);
  return hasWallet && (hasActionLanguage || hasAmount);
}

// True if the user's message is a positive confirmation
function isPositiveConfirmation(text) {
  const t = text.trim().toLowerCase();
  if (t.length > 120) return false;
  return /\b(yes|yep|yup|yeah|go|do it|fire it|fire|confirm(ed)?|sure|ok(ay)?|proceed|send it|send now|execute|approved?|absolutely|👍|✅|correct|affirmative|let'?s go|go ahead|sounds good|looks good|perfect|please do|go for it|make it so|just send|send it now|do it now|go for it|just do it)\b/i.test(t);
}

function getAnthropicHistory(contextId) {
  if (!anthropicHistories.has(contextId)) anthropicHistories.set(contextId, []);
  return anthropicHistories.get(contextId);
}

function getGeminiHistory(contextId) {
  if (!geminiHistories.has(contextId)) geminiHistories.set(contextId, []);
  return geminiHistories.get(contextId);
}

function getOpenAIHistory(contextId) {
  if (!openaiHistories.has(contextId)) openaiHistories.set(contextId, []);
  return openaiHistories.get(contextId);
}

// ─── Friendly error messages ──────────────────────────────────────────────────

function friendlyProviderError(provider, err) {
  const msg = err.message ?? String(err);
  // Quota / rate limit
  if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('rate limit')) {
    const providerName = provider === 'gemini' ? 'Gemini' : provider === 'openai' ? 'OpenAI' : 'Anthropic';
    return `⚠️ ${providerName} API quota exceeded. You can:\n• Wait a moment and try again\n• Switch back to Claude with \`switch to claude\`\n• Add billing to your ${providerName} account`;
  }
  // Auth errors
  if (msg.includes('401') || msg.includes('403') || msg.includes('invalid') && msg.toLowerCase().includes('key')) {
    return `⚠️ Invalid API key for ${provider}. Check your \`.env\` and restart the bot.`;
  }
  // Generic fallback — still friendlier than raw JSON
  return `⚠️ ${provider} error: ${msg.slice(0, 200)}`;
}

// ─── Provider agentic loops ───────────────────────────────────────────────────

async function runAnthropicLoop(contextId, contextualText, editor, toolCtx, userLlmKey, modelOverride) {
  const history = getAnthropicHistory(contextId);
  history.push({ role: 'user', content: contextualText });
  const client = getAnthropicClient(userLlmKey);
  const modelUsed = modelOverride || CLAUDE_MODEL;
  console.log(`[api-call] anthropic model="${modelUsed}" baseURL="api.anthropic.com" usingUserKey=${!!userLlmKey}`);

  // Work on a snapshot so intermediate tool-call turns don't pollute history
  let messages = [...history];
  let accumulated = '';

  while (true) {
    const response = await client.messages.create({
      model: modelUsed,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text') {
        accumulated += block.text;
        editor.update(accumulated || '_Thinking…_');
      }
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      messages = [...messages, { role: 'assistant', content: response.content }];
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          editor.update((accumulated || '_Thinking…_') + '\n_Looking up…_');
          try {
            const result = await runTool(block.name, block.input, toolCtx);
            return { type: 'tool_result', tool_use_id: block.id, content: result };
          } catch (err) {
            console.error(`[tool] ${block.name} error:`, err.message);
            return { type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
          }
        })
      );
      messages = [...messages, { role: 'user', content: toolResults }];
      continue;
    }

    break;
  }

  history.push({ role: 'assistant', content: accumulated });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return accumulated;
}

async function runGeminiLoop(contextId, contextualText, editor, toolCtx, userLlmKey) {
  const ai = await getGeminiClient(userLlmKey);
  const history = getGeminiHistory(contextId);
  history.push({ role: 'user', parts: [{ text: contextualText }] });

  let contents = [...history];
  let accumulated = '';

  while (true) {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      systemInstruction: SYSTEM_PROMPT,
      contents,
      tools: getGeminiTools(),
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];

    for (const part of parts) {
      if (part.text) {
        accumulated += part.text;
        editor.update(accumulated || '_Thinking…_');
      }
    }

    const funcCalls = parts.filter((p) => p.functionCall);
    if (funcCalls.length === 0) break;

    // Add model turn (with function calls) to local content list
    contents = [...contents, { role: 'model', parts }];

    editor.update((accumulated || '_Thinking…_') + '\n_Looking up…_');
    const funcResponses = await Promise.all(
      funcCalls.map(async (part) => {
        const { name, args } = part.functionCall;
        console.log(`[tool/gemini] ${name}`, JSON.stringify(args).slice(0, 120));
        try {
          const result = await runTool(name, args, toolCtx);
          return { functionResponse: { name, response: { result } } };
        } catch (err) {
          console.error(`[tool/gemini] ${name} error:`, err.message);
          return { functionResponse: { name, response: { error: err.message } } };
        }
      })
    );

    contents = [...contents, { role: 'user', parts: funcResponses }];
  }

  history.push({ role: 'model', parts: [{ text: accumulated }] });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return accumulated;
}

async function runOpenAILoop(contextId, contextualText, editor, toolCtx, userLlmKey, { baseURL, model } = {}) {
  const openai = await getOpenAIClient(userLlmKey, baseURL);
  const modelToUse = model || OPENAI_MODEL;
  console.log(`[api-call] openai-compatible model="${modelToUse}" baseURL="${baseURL || 'api.openai.com (default)'}" usingUserKey=${!!userLlmKey}`);
  const history = getOpenAIHistory(contextId);
  history.push({ role: 'user', content: contextualText });

  // Prepend system message each call (not stored in history)
  let messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ];
  let accumulated = '';

  while (true) {
    const response = await openai.chat.completions.create({
      model: modelToUse,
      messages,
      tools: getOpenAITools(),
      tool_choice: 'auto',
    });

    const choice = response.choices[0];
    const msg = choice.message;

    if (msg.content) {
      accumulated += msg.content;
      editor.update(accumulated || '_Thinking…_');
    }

    if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) break;

    messages = [...messages, msg];

    editor.update((accumulated || '_Thinking…_') + '\n_Looking up…_');
    const toolResults = await Promise.all(
      msg.tool_calls.map(async (tc) => {
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        console.log(`[tool/openai] ${tc.function.name}`, JSON.stringify(args).slice(0, 120));
        try {
          const result = await runTool(tc.function.name, args, toolCtx);
          return { role: 'tool', tool_call_id: tc.id, content: result };
        } catch (err) {
          console.error(`[tool/openai] ${tc.function.name} error:`, err.message);
          return { role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` };
        }
      })
    );

    messages = [...messages, ...toolResults];
  }

  history.push({ role: 'assistant', content: accumulated });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return accumulated;
}

const MINDS_ALIAS_MAX_AGE_S = 4 * 60 * 60; // rotate conversation thread every 4 hours

// Async fire-and-forget Minds handler. Sends the message, updates Discord when the reply arrives.
// Not awaited from handleMessage — returns immediately so Discord stays responsive.
async function runMindsBackground(contextId, text, replyMsg, senderId, mindName) {
  let creds = getUserMindsCredentials(senderId);
  if (!creds) {
    await replyMsg.edit(
      '⚠️ You need to connect your Minds agent.\n' +
      'DM me `!minds <builder-api-key>` to connect.\n' +
      'Get a Builder API key at https://build.hellominds.ai/console'
    ).catch(() => {});
    return;
  }

  // Rotate alias if older than 4 hours to prevent Minds falling back to email
  if (creds.mindId && creds.aliasCreatedAt) {
    const ageS = Math.floor(Date.now() / 1000) - creds.aliasCreatedAt;
    if (ageS > MINDS_ALIAS_MAX_AGE_S) {
      try {
        const rotateClient = createMindsClient({ builderApiKey: creds.apiKey });
        const newAlias = `dc${senderId.slice(-8)}${randomBytes(2).toString('hex')}`;
        await rotateClient.ensureConversation(newAlias, creds.mindId);
        setUserMindsCredentials(senderId, creds.apiKey, newAlias, creds.name, creds.mindId);
        creds = getUserMindsCredentials(senderId);
        console.log(`[minds] Rotated alias for ${senderId} → ${newAlias}`);
      } catch (err) {
        console.error('[minds-rotate] failed:', err.message);
        // Continue with old alias rather than failing
      }
    }
  }

  const { alias, apiKey } = creds;
  const userText = text.replace(/^\[Current date.*?\]\n\[Sent by.*?\]\s*/s, '').trim();
  const mindsClient = createMindsClient({ builderApiKey: apiKey });

  let afterFingerprint;
  try {
    afterFingerprint = await mindsClient.getLatestHistoryFingerprint(alias);
  } catch { /* first message */ }

  try {
    await mindsClient.sendMessage({ alias, messageText: userText });
  } catch (err) {
    await replyMsg.edit(`⚠️ Failed to send to Minds: ${err.message.slice(0, 200)}`).catch(() => {});
    return;
  }

  await replyMsg.edit('⏳ Sent to your Mind…').catch(() => {});

  try {
    const outcome = await mindsClient.waitForReply({
      alias,
      timeoutMs: 300000, // 5 minutes
      sentMessageText: userText,
      ...(afterFingerprint !== undefined ? { afterFingerprint } : {}),
    });

    let responseText;
    if (outcome.timedOut) {
      responseText = '⏳ Your Mind is taking longer than expected. Check with `minds history discord` or try again.';
    } else {
      responseText = stripHtml(outcome.reply?.messageText || '_(no response)_');
    }

    const finalText = responseText + `\n-# Minds (${mindName})`;
    const chunks = chunkText(finalText);
    await replyMsg.edit(chunks[0] ?? '…').catch(() => {});
    for (let i = 1; i < chunks.length; i++) {
      await replyMsg.channel.send(chunks[i]).catch(() => {});
    }
  } catch (err) {
    console.error('[minds-bg] error:', err.message);
    if (/alias.*not found/i.test(err.message)) {
      await replyMsg.edit(
        '⚠️ Your Minds alias is no longer valid.\n' +
        'DM me `!minds <builder-api-key>` to reconnect.'
      ).catch(() => {});
    } else {
      await replyMsg.edit(`⚠️ Minds error: ${err.message.slice(0, 200)}`).catch(() => {});
    }
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

  const isDM = !message.guild;
  const isMentioned = message.mentions.has(message.client.user);
  const isActiveChannel = ACTIVE_CHANNELS.has(message.channelId);

  // DMs are always engaged; in servers, require a mention or an active channel
  if (!isDM && !isMentioned && !isActiveChannel) return;

  if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(message.author.id)) {
    await message.reply('You are not authorized to use this bot.').catch(() => {});
    return;
  }

  if (!isDM && ALLOWED_ROLES.size > 0) {
    const memberRoles = message.member?.roles.cache.map((r) => r.name) ?? [];
    const hasRole = memberRoles.some((r) => ALLOWED_ROLES.has(r));
    if (!hasRole) {
      const roleList = [...ALLOWED_ROLES].map((r) => `\`${r}\``).join(', ');
      await message.reply(`Only ${roleList} members can engage with me.`).catch(() => {});
      return;
    }
  }

  // Owner check — used for BYOLLM exemption and wallet note below
  const isOwner = BOT_OWNER_ID && message.author.id === BOT_OWNER_ID;

  // Peek at provider intent before BYOLLM check — Minds doesn't need an LLM key
  const switchPeek = detectProviderSwitch(message.content);
  const isMindsContext = switchPeek === 'minds' || getChannelProvider(message.channelId) === 'minds';

  // BYOLLM enforcement — if host requires users to bring their own key (owner is always exempt)
  // Minds users bypass this — they authenticate via Minds credentials, not LLM keys
  if (REQUIRE_USER_LLM && !isOwner && !isMindsContext && !hasAnyUserLlmKey(message.author.id)) {
    await message.reply(
      'This bot requires you to connect your own AI API key.\n\n' +
      'DM me to set it up:\n' +
      '`!llm anthropic <key>` — from console.anthropic.com\n' +
      '`!llm gemini <key>` — from aistudio.google.com/apikey\n' +
      '`!llm openai <key>` — from platform.openai.com\n' +
      '`!llm openrouter <key>` — from openrouter.ai (100+ models)\n\n' +
      'Or use Minds — connect your Minds AI agent:\n' +
      '`!minds <alias> <builderApiKey>`'
    ).catch(() => {});
    return;
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

  // ── Provider switch detection ─────────────────────────────────────────────
  const switchTarget = detectProviderSwitch(text);
  if (switchTarget) {
    // Validate API key exists before switching
    if (switchTarget === 'gemini' && !GEMINI_API_KEY) {
      await message.reply('⚠️ `GEMINI_API_KEY` is not set in `.env`. Add it and restart the bot.').catch(() => {});
      return;
    }
    if (switchTarget === 'openai' && !OPENAI_API_KEY) {
      await message.reply('⚠️ `OPENAI_API_KEY` is not set in `.env`. Add it and restart the bot.').catch(() => {});
      return;
    }

    let namedModel = null;
    if (switchTarget === 'openrouter') {
      const orKey = getUserLlmKeyFor(message.author.id, 'openrouter');
      if (!orKey) {
        await message.reply(
          '⚠️ You need an OpenRouter key for that model.\n' +
          'DM me `!llm openrouter <key>` to set up. Get one at openrouter.ai/keys'
        ).catch(() => {});
        return;
      }
      // "switch to kimi" names a model; plain "switch to openrouter" keeps the user's stored default
      namedModel = detectOpenRouterModel(text) || orKey.model || 'openai/gpt-4o';
    } else if (switchTarget === 'anthropic') {
      // "switch to fable/opus/haiku/sonnet" names a model; plain "switch to claude" uses the default
      namedModel = detectAnthropicModel(text);
    }

    setChannelProvider(contextId, switchTarget, namedModel);
    // Clear all in-memory histories for this channel so the new provider starts fresh
    anthropicHistories.delete(contextId);
    geminiHistories.delete(contextId);
    openaiHistories.delete(contextId);
    const modelName = switchTarget === 'gemini' ? GEMINI_MODEL
      : switchTarget === 'openai' ? OPENAI_MODEL
      : switchTarget === 'minds' ? 'Minds'
      : (namedModel || CLAUDE_MODEL);
    await message.reply(`🔀 Switched to **${modelName}**. Starting a fresh conversation.`).catch(() => {});
    return;
  }

  const provider = getChannelProvider(contextId);

  const replyMsg = await message.reply('_Thinking…_').catch((err) => {
    console.error('[discord] reply failed:', err.message);
    return null;
  });
  if (!replyMsg) return;

  const editor = createThrottledEditor(replyMsg);

  // Prefix with sender identity so the LLM knows who "me/I/my" refers to
  const senderName = message.member?.displayName ?? message.author.username;
  const senderApiKey = getUserApiKey(message.author.id);
  const walletNote = senderApiKey
    ? '[User has a personal Quidli API key connected — drops will use their Smart Send wallet]'
    : isOwner
      ? '[User is the bot owner — drops will use the host Smart Send wallet]'
      : '[User has NO personal Quidli API key — do NOT execute any drops. If they request a drop, tell them they must first DM me `!connect <your-api-key>` to link their Quidli account (get a key at connect.quid.li). Do not proceed with any token transfer.]';
  const now = new Date();
  const timeContext = `[Current date and time: ${now.toUTCString()} | Local ISO: ${now.toISOString()}]`;
  const contextualText = `${timeContext}\n[Sent by @${senderName} (Discord ID: ${message.author.id})] ${walletNote}\n${text}`;

  const toolCtx = {
    senderId: message.author.id,
    botId: message.client.user.id,
    senderApiKey,
    senderUser: message.author,
    currentChannelId: message.channelId,
  };

  let accumulated = '';
  let modelLabel = CLAUDE_MODEL;

  // Clear any leftover basescan URLs from a previous turn
  _pendingBasescanUrls.length = 0;

  // The channel's switched provider decides what runs. Each user's messages use
  // their own key for that provider if they have one, else the host key.
  const effectiveProvider = provider;
  const chModel = getChannelModel(contextId); // channel-level model override, set by e.g. "switch to fable"
  const anthKey = getUserLlmKeyFor(message.author.id, 'anthropic');
  const orKey = getUserLlmKeyFor(message.author.id, 'openrouter');

  try {
    if (effectiveProvider === 'gemini') {
      accumulated = await runGeminiLoop(contextId, contextualText, editor, toolCtx, getUserLlmKeyFor(message.author.id, 'gemini')?.apiKey ?? null);
      modelLabel = GEMINI_MODEL;
    } else if (effectiveProvider === 'openai') {
      accumulated = await runOpenAILoop(contextId, contextualText, editor, toolCtx, getUserLlmKeyFor(message.author.id, 'openai')?.apiKey ?? null);
      modelLabel = OPENAI_MODEL;
    } else if (effectiveProvider === 'openrouter') {
      if (!orKey) {
        await editor.finalize(
          '⚠️ This channel is in OpenRouter mode, but you don\'t have an OpenRouter key connected.\n' +
          'DM me `!llm openrouter <key>` to set up (openrouter.ai/keys), or say "switch to claude" to change modes.'
        );
        return;
      }
      const orModel = chModel || orKey.model || 'openai/gpt-4o';
      accumulated = await runOpenAILoop(contextId, contextualText, editor, toolCtx, orKey.apiKey, {
        baseURL: 'https://openrouter.ai/api/v1',
        model: orModel,
      });
      modelLabel = orModel;
    } else if (effectiveProvider === 'minds') {
      const creds = getUserMindsCredentials(message.author.id);
      const mindName = creds?.name ?? 'unknown';

      // If this looks like a confirmation, re-fetch Minds history to check for a pending action.
      // Using getHistory instead of in-memory state so handoffs survive bot restarts.
      let handoffText = null;
      if (creds && isPositiveConfirmation(text)) {
        try {
          const mindsClient = createMindsClient({ builderApiKey: creds.apiKey });
          const history = await mindsClient.getHistory(creds.alias, { limit: 10 });
          const lastMindReply = history.findLast((row) => isReplyHistoryRow(row));
          if (lastMindReply) {
            const age = Date.now() - new Date(lastMindReply.createdAt).getTime();
            const pendingText = stripHtml(lastMindReply.messageText ?? '');
            if (age < 60 * 60 * 1000 && looksLikePendingAction(pendingText)) {
              handoffText =
                `${timeContext}\n[Sent by @${senderName} (Discord ID: ${message.author.id})] ${walletNote}\n` +
                `The user's Minds AI agent researched and prepared the following action plan. ` +
                `The user has now confirmed it. Execute it immediately using your tools — no further confirmation needed:\n\n` +
                `---\n${pendingText}\n---\n\n` +
                `User confirmed: "${text}"`;
            }
          }
        } catch (err) {
          console.error('[minds-history] error:', err.message);
          await replyMsg.edit('⚠️ Could not verify pending action — please try again.').catch(() => {});
          return;
        }
      }

      if (handoffText) {
        accumulated = await runAnthropicLoop(contextId, handoffText, editor, toolCtx, anthKey?.apiKey ?? null);
        modelLabel = `${CLAUDE_MODEL} (via Minds)`;
      } else {
        // Async path — fire and forget, background function edits the reply when Mind responds
        runMindsBackground(contextId, contextualText, replyMsg, message.author.id, mindName)
          .catch((err) => console.error('[minds-bg] unhandled:', err.message));
        return;
      }
    } else {
      // anthropic (default). BYOLLM users without an Anthropic key but with an
      // OpenRouter key get Claude routed through OpenRouter on their own credits.
      if (REQUIRE_USER_LLM && !isOwner && !anthKey && orKey) {
        accumulated = await runOpenAILoop(contextId, contextualText, editor, toolCtx, orKey.apiKey, {
          baseURL: 'https://openrouter.ai/api/v1',
          model: OPENROUTER_CLAUDE_SLUG,
        });
        modelLabel = `${OPENROUTER_CLAUDE_SLUG} (via OpenRouter)`;
      } else {
        accumulated = await runAnthropicLoop(contextId, contextualText, editor, toolCtx, anthKey?.apiKey ?? null, chModel);
        modelLabel = chModel || CLAUDE_MODEL;
      }
    }

    // Append any basescan URLs the LLM forgot to include
    let finalText = accumulated || '_(no response)_';
    for (const url of _pendingBasescanUrls) {
      if (!finalText.includes(url)) {
        finalText += `\n🔗 ${url}`;
      }
    }
    _pendingBasescanUrls.length = 0;

    finalText += `\n-# ${modelLabel}`;
    await editor.finalize(finalText);

  } catch (err) {
    console.error(`[${provider}] error:`, err);
    // Roll back the unpaired user message so history stays consistent
    if (provider === 'gemini') {
      const h = getGeminiHistory(contextId);
      if (h.at(-1)?.role === 'user') h.pop();
    } else if (provider === 'openai') {
      const h = getOpenAIHistory(contextId);
      if (h.at(-1)?.role === 'user') h.pop();
    } else {
      // anthropic or minds-handoff-to-claude
      const h = getAnthropicHistory(contextId);
      if (h.at(-1)?.role === 'user') h.pop();
    }
    await editor.finalize(friendlyProviderError(provider, err));
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

  if (content.startsWith('!minds ')) {
    const parts = content.slice('!minds '.length).trim().split(/\s+/);
    const apiKey = parts[0];
    const mindName = parts[1] || null;

    if (!apiKey) {
      await message.reply(
        'Usage:\n' +
        '`!minds <builder-api-key>` — connect your first enabled Mind\n' +
        '`!minds <builder-api-key> <mind-name>` — connect a specific Mind\n\n' +
        'Get a Builder API key at https://build.hellominds.ai/console'
      );
      return;
    }

    try {
      const client = createMindsClient({ builderApiKey: apiKey });
      const minds = await client.listMinds();
      const enabledMinds = minds.filter((m) => m.isEnabled);

      if (enabledMinds.length === 0) {
        await message.reply('❌ No enabled Minds found on your account. Visit https://build.hellominds.ai to set one up.');
        return;
      }

      let selectedMind;
      if (mindName) {
        selectedMind = enabledMinds.find((m) => m.name.toLowerCase() === mindName.toLowerCase());
        if (!selectedMind) {
          const names = enabledMinds.map((m) => `\`${m.name}\``).join(', ');
          await message.reply(`❌ Mind \`${mindName}\` not found or not enabled.\nYour enabled Minds: ${names}`);
          return;
        }
      } else {
        selectedMind = enabledMinds[0];
      }

      const userAlias = `dc${message.author.id.slice(-8)}${randomBytes(2).toString('hex')}`;
      await client.ensureConversation(userAlias, selectedMind.mindId);
      setUserMindsCredentials(message.author.id, apiKey, userAlias, selectedMind.name, selectedMind.mindId);

      const otherMinds = enabledMinds.filter((m) => m.mindId !== selectedMind.mindId);
      const switchHint = otherMinds.length > 0
        ? `\n\nTo use a different Mind: \`!minds <key> <mind-name>\`\nYour other enabled Minds: ${otherMinds.map((m) => `\`${m.name}\``).join(', ')}`
        : '';

      await message.reply(`✅ Connected to your **${selectedMind.name}** Mind. When the channel is in Minds mode, your messages will go to this Mind.${switchHint}`);
    } catch (err) {
      await message.reply(`❌ Failed to connect: ${err.message}`);
    }
    return;
  }

  if (content === '!minds-remove') {
    deleteUserMindsCredentials(message.author.id);
    await message.reply('🗑️ Your Minds credentials have been removed.');
    return;
  }

  if (content.startsWith('!llm ')) {
    const parts = content.slice('!llm '.length).trim().split(/\s+/);
    const provider = parts[0]?.toLowerCase();
    const apiKey = parts[1];
    const model = parts[2] || null; // optional, only used for openrouter

    if (!provider || !apiKey) {
      await message.reply(
        'Usage: `!llm <provider> <api-key>`\n\n' +
        'Providers:\n' +
        '  `anthropic`  — from console.anthropic.com\n' +
        '  `gemini`     — from aistudio.google.com/apikey\n' +
        '  `openai`     — from platform.openai.com\n' +
        '  `openrouter` — from openrouter.ai (access 100+ models)\n\n' +
        'For OpenRouter, you can optionally specify a model:\n' +
        '  `!llm openrouter <key> [model]`\n' +
        '  Example: `!llm openrouter sk-or-... meta-llama/llama-3-70b-instruct`\n' +
        '  Default model: openai/gpt-4o\n\n' +
        'Your key is stored encrypted and used instead of the host key. DM `!llm-remove` to disconnect.'
      );
      return;
    }

    if (!['anthropic', 'gemini', 'openai', 'openrouter'].includes(provider)) {
      await message.reply('Unknown provider. Use: `anthropic`, `gemini`, `openai`, or `openrouter`');
      return;
    }

    setUserLlmKey(message.author.id, provider, apiKey, model);
    const modelNote = provider === 'openrouter' ? ` (model: ${model || 'openai/gpt-4o'})` : '';
    await message.reply(
      `✅ Connected your ${provider} key${modelNote}. Your messages will now use your own ${provider} credits.\n\n` +
      '⚠️ Your key is stored encrypted. DM `!llm-remove` anytime to disconnect.'
    );
    return;
  }

  if (content === '!llm-remove' || content.startsWith('!llm-remove ')) {
    const prov = content.slice('!llm-remove'.length).trim().toLowerCase() || null;
    deleteUserLlmKey(message.author.id, prov);
    await message.reply(prov
      ? `🗑️ Your ${prov} key has been removed.`
      : '🗑️ All your LLM keys have been removed. The bot will use host keys going forward.');
    return;
  }

  if (content === '!help' || content === '!commands') {
    await message.reply(
      'Available commands:\n' +
      '`!connect <your-api-key>` — link your Quidli account so drops use your own Smart Send wallet\n' +
      '`!revoke` — remove your stored API key\n' +
      '`!llm <provider> <api-key>` — bring your own LLM key (anthropic, gemini, openai, or openrouter for 100+ models)\n' +
      '`!llm-remove` — remove your LLM key\n' +
      '`!minds <builder-api-key>` — connect your Minds agent (key from https://build.hellominds.ai/console)\n' +
      '`!minds <builder-api-key> <mind-name>` — connect a specific Mind if you have more than one\n' +
      '`!minds-remove` — remove your Minds credentials\n\n' +
      'Get a Quidli API key at https://connect.quid.li'
    );
    return;
  }

  // Anything else in a DM: full agent conversation, same as in a server channel
  await handleMessage(message);
}

// ─── Channel watchers ─────────────────────────────────────────────────────────

async function checkWatchers(message) {
  const watchers = db.prepare('SELECT * FROM watchers WHERE channel_id = ? AND fired = 0').all(message.channelId);
  if (watchers.length === 0) return;

  for (const watcher of watchers) {
    if (!message.content.toLowerCase().includes(watcher.trigger_phrase.toLowerCase())) continue;
    if (message.author.id === watcher.sender_id) continue; // creator can't win their own watcher

    const winnerIds = JSON.parse(watcher.winner_ids);
    if (winnerIds.includes(message.author.id)) continue; // already won

    winnerIds.push(message.author.id);
    const newCount = watcher.winner_count + 1;
    const done = newCount >= watcher.max_winners ? 1 : 0;
    db.prepare('UPDATE watchers SET winner_count = ?, winner_ids = ?, fired = ? WHERE id = ?')
      .run(newCount, JSON.stringify(winnerIds), done, watcher.id);

    const isOwner = BOT_OWNER_ID && watcher.sender_id === BOT_OWNER_ID;
    const senderApiKey = getUserApiKey(watcher.sender_id);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) {
      console.log(`[watcher] ${watcher.id} triggered but no API key for sender ${watcher.sender_id}`);
      continue;
    }

    try {
      const dropInput = {
        ...JSON.parse(watcher.drop_input),
        recipients: [{ type: 'discord', id: message.author.id }],
      };
      const result = await quidliDrop(dropInput, keyToUse);
      if (result.transferHash) {
        const url = `https://basescan.org/tx/${result.transferHash}`;
        message.author.send(`🎉 You triggered the drop by typing "${watcher.trigger_phrase}"! Tokens are on the way.\nTransaction: ${url}`).catch(() => {});
        const sender = await client.users.fetch(watcher.sender_id).catch(() => null);
        if (sender) sender.send(`✅ Watcher triggered! ${message.author.username} typed "${watcher.trigger_phrase}".\nTransaction: ${url}`).catch(() => {});
      }
      console.log(`[watcher] ${watcher.id} fired for ${message.author.username}`);
    } catch (err) {
      console.error(`[watcher] drop failed:`, err.message);
    }
  }
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,   // needed for online/idle/dnd status — enable in Developer Portal
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  const defaultModel = DEFAULT_LLM_PROVIDER === 'gemini' ? GEMINI_MODEL
    : DEFAULT_LLM_PROVIDER === 'openai' ? OPENAI_MODEL
    : CLAUDE_MODEL;
  console.log(`✅ Claudetaur ready — logged in as ${c.user.tag}`);
  console.log(`   Default LLM: ${DEFAULT_LLM_PROVIDER} (${defaultModel})`);
  if (GEMINI_API_KEY) console.log(`   Gemini: ${GEMINI_MODEL} ✓`);
  if (OPENAI_API_KEY) console.log(`   OpenAI: ${OPENAI_MODEL} ✓`);
  console.log(`   Minds: per-user keys (DM !minds <key> to register)`);
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
  // Re-queue any scheduled drops that survived a restart
  loadPendingDrops();
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  // DMs: handle !connect / !revoke commands
  if (!message.guild) {
    handleDM(message).catch((err) => console.error('[dm] unhandled error:', err));
    return;
  }
  // Check channel watchers on every message (no @mention needed)
  checkWatchers(message).catch((err) => console.error('[watcher] error:', err));
  handleMessage(message).catch((err) =>
    console.error('[bot] unhandled error:', err)
  );
});

client.login(DISCORD_TOKEN);
