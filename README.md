# DiscoCentaur

A Claude-powered Discord bot with [Quidli Connect](https://connect.quid.li) integration. Ask it in plain English to look up wallets, check reputation scores, and send tokens — all without anyone needing to share a wallet address.

## What it can do

- **Send tokens** — drop USDC or other tokens to individuals or entire Discord roles via Quidli Smart Send
- **Look up wallets** — resolve any Discord user, Farcaster handle, Twitter, email, GitHub, Telegram, or phone number to their ETH/SOL wallet address
- **Check reputation scores** — get a composite web3 reputation score (Neynar, Lens, Ethos) for any user by social identity
- **Check your balance** — native and ERC-20 balances for your Smart Send wallet, so the bot can tell you what's short before a drop fails
- **Schedule drops** — send tokens at a future time, surviving bot restarts
- **Presence-based drops** — target only online/idle/dnd members at execution time, not when scheduled
- **Conditional drops** — "if BTC is above $100k, send everyone 1 USDC" — evaluated automatically using real-time web search
- **Channel watchers** — send tokens to the first person who types a trigger phrase
- **Cancel / reschedule** — manage pending scheduled drops and watchers
- **Per-user API keys** — users can DM `!connect <key>` to link their own Quidli account
- **Web search** — real-time data via Brave Search for conditional drops and factual questions
- **Multi-LLM support** — switch between Claude, Gemini, OpenAI, OpenRouter, Hermes (Nous Portal, 200+ models), and Minds AI per channel
- **Bring your own key** — users DM `!llm <provider> <key>` to run on their own credits
- **Role-based access** — restrict bot usage to specific Discord roles

## How it works

```
Discord message → LLM (Claude / Gemini / OpenAI / OpenRouter / Hermes / Minds AI)
               → Quidli Connect, over two paths:
                   • MCP  — lookup / scores / balance (discovered at runtime)
                   • REST — drop / exposed / scheduling
               → edit Discord reply in real time
```

The LLM decides when to call tools based on natural language. No commands needed — just ask naturally.

**Examples:**
```
@DiscoCentaur send 1 USDC to @Guillaume
@DiscoCentaur send 0.01 USDC to everyone in @Dev
@DiscoCentaur what's the wallet for ahn.eth on Farcaster?
@DiscoCentaur what's my balance on base?
@DiscoCentaur schedule a drop of 5 USDC to @team in 2 hours
@DiscoCentaur if the USA wins tonight, send everyone 1 USDC
@DiscoCentaur send 0.01 USDC to the first person who types "gm" here today
@DiscoCentaur switch to gemini
@DiscoCentaur switch to claude
@DiscoCentaur switch to minds
```

## Prerequisites

- Node.js 22+ (uses built-in `node:sqlite`)
- A Discord bot application
- An Anthropic API key
- A Quidli Connect API key (from [connect.quid.li](https://connect.quid.li))
- *(Optional)* Brave Search API key for web search and conditional drops
- *(Optional)* Gemini, OpenAI, or Nous Portal API keys for multi-LLM switching
  — a free [Nous Portal](https://portal.nousresearch.com) account unlocks tool-calling models at no cost

## Setup

### 1. Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**.
2. Go to **Bot**. Copy the **Token** — this is your `DISCORD_TOKEN`.
3. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent**
   - **Server Members Intent**
   - **Presence Intent** *(required for presence-based drops)*
4. Go to **OAuth2 → URL Generator**, select scope `bot` and permissions:
   - Read Messages / View Channels
   - Send Messages
   - Read Message History
5. Open the generated URL in a browser and invite the bot to your server.

### 2. Configure environment variables

```bash
cp .env.example .env
# Fill in your values
```

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from the Discord Developer Portal |
| `ANTHROPIC_API_KEY` | ✅ | API key from [console.anthropic.com](https://console.anthropic.com) |
| `QUIDLI_API_KEY` | ✅ | API key from [connect.quid.li](https://connect.quid.li) |
| `MASTER_ENCRYPTION_KEY` | ✅ | 64 hex chars (32 bytes) — encrypts stored user API keys. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `BOT_OWNER_ID` | ✅* | Your Discord user ID. Grants you the host Quidli wallet without `!connect`, **and** is the only account that can use the host's LLM keys by default. Leave it unset and nobody can — every user must bring their own key. |
| `BRAVE_SEARCH_API_KEY` | — | From [brave.com/search/api](https://brave.com/search/api) — required for web search and conditional drops |
| `CLAUDE_MODEL` | — | Defaults to `claude-sonnet-4-6` |
| `DEFAULT_LLM_PROVIDER` | — | `anthropic` (default), `gemini`, `openai`, or `hermes` |
| `GEMINI_API_KEY` | — | From [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | — | Defaults to `gemini-2.5-flash` |
| `OPENAI_API_KEY` | — | From [platform.openai.com](https://platform.openai.com) |
| `OPENAI_MODEL` | — | Defaults to `gpt-4o` |
| `NOUS_API_KEY` | — | From [portal.nousresearch.com](https://portal.nousresearch.com) — one key, 200+ models |
| `NOUS_MODEL` | — | Defaults to `tencent/hy3:free` (free tier, supports tool calling) |
| `HOST_KEY_ALLOWED_USERS` | — | Handles/IDs allowed to spend the host's LLM keys. Empty = owner only |
| `HOST_KEY_ALLOWED_ROLES` | — | Discord role names allowed to spend the host's LLM keys |
| `DISCORD_ACTIVE_CHANNELS` | — | Comma-separated channel IDs where the bot responds to all messages (not just @mentions) |
| `DISCORD_ALLOWED_ROLES` | — | Comma-separated Discord role names allowed to use the bot. Empty = everyone |
| `DISCORD_ALLOWED_USERS` | — | Comma-separated Discord user IDs allowed to use the bot. Empty = everyone |
| `BOT_WALLET_PRIVATE_KEY` | — | Private key of a funded wallet for x402 pay-per-request. Note: lookup, scores and balance now go over MCP, which authenticates by API key only — so x402 no longer covers them |
| `SYSTEM_PROMPT` | — | Override the default system prompt |

### 3. Enable Smart Send (for token drops)

1. Log in at [connect.quid.li](https://connect.quid.li)
2. Go to **Smart Send** and toggle it on
3. Fund the Smart Send wallet with tokens and ETH for gas

### 4. Install and run

```bash
npm install
npm start
```

For production with pm2:
```bash
pm2 start bot.js --name claudetaur
pm2 save
```

## Per-user API keys

Users can link their own Quidli account so drops use their Smart Send wallet:

```
DM @DiscoCentaur: !connect <your-api-key>
DM @DiscoCentaur: !revoke
```

Get a key at [connect.quid.li](https://connect.quid.li). Keys are stored encrypted with AES-256-GCM.

**Note:** wallet lookup, reputation scores and balance run on the *asker's* key (see below), so
users who haven't run `!connect` will be prompted to. Drops already required a key, so this
makes the whole Connect surface consistent rather than adding a new gate.

## Quidli Connect over MCP

Connect exposes itself as an MCP server, and the bot consumes part of its surface that way
rather than hand-writing REST calls. Three tools are discovered at startup:

| Tool | Replaces |
|---|---|
| `connect_lookup` | the old hand-written `quidli_lookup` |
| `connect_scores_batch` | the old hand-written `quidli_score` |
| `connect_drop_balance` | nothing — new capability |

How it works:

- `MCP_TOOL_ALLOWLIST` in `bot.js` controls which discovered tools are offered. It's deliberately
  narrow: Connect also exposes `connect_drop`, which would duplicate the hardcoded `quidli_drop`
  and leave the model choosing between two tools that do the same thing.
- Discovery happens once at startup via plain JSON-RPC over POST. The server is stateless and
  reads `x-api-key` per request, so there's no initialize handshake and no MCP SDK dependency.
- Each call uses the **sender's** key. The host key is used only for the bot owner, the same rule
  the REST tools follow.
- If Connect is unreachable at startup the bot runs normally on the hardcoded tools. If an
  allowlisted tool is missing from discovery, startup logs a loud warning — some of these
  *replace* hardcoded tools, so a silent miss would quietly delete a capability.

Point it elsewhere with `CONNECT_MCP_URL` (defaults to `https://mcp.connect.quid.li/`).

To add another Connect tool: add its name to `MCP_TOOL_ALLOWLIST`, delete the hardcoded
equivalent if there is one, and update the system prompt to reference the new tool name.
Check the live names first:

```bash
curl -s -X POST https://mcp.connect.quid.li/ \
  -H "x-api-key: $QUIDLI_API_KEY" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"'
```

## Multi-LLM switching

Switch the active LLM per channel at any time:

```
@DiscoCentaur switch to gemini
@DiscoCentaur switch to claude
@DiscoCentaur switch to openai
@DiscoCentaur switch to hermes
@DiscoCentaur switch to openrouter
```

Naming a model in the phrase selects it too — `switch to fable`, `switch to opus`,
`switch to kimi`, `switch to llama`, `switch to deepseek`, `switch to mistral`.

The choice persists across bot restarts (stored in SQLite). Each provider maintains its own conversation history.

### Who can use the host's keys

The host's Anthropic / Gemini / OpenAI / Nous keys are spendable **only** by
`BOT_OWNER_ID`, anyone in `HOST_KEY_ALLOWED_USERS`, and members of any role in
`HOST_KEY_ALLOWED_ROLES`. Everybody else must connect their own key *for the provider
currently in use* — a Gemini key does not unlock the host's Nous key. Unauthorized
users get told to either connect a key or ask the owner for access, and they can't
switch the channel's provider either.

OpenRouter and Minds are per-user by design and never touch host credentials.

### Bring your own key

Any user can run on their own credits by DMing the bot. Keys are stored AES-256-GCM
encrypted (set `MASTER_ENCRYPTION_KEY`) and used instead of the host's:

```
!llm anthropic <key>
!llm gemini <key>
!llm openai <key>
!llm openrouter <key> [model]
!llm hermes <key> [model]
!llm-remove
```

### Hermes / Nous Portal

`switch to hermes` routes the channel through [Nous Portal](https://portal.nousresearch.com), an
OpenAI-compatible gateway to 200+ models under one key. Set `NOUS_API_KEY` to give everyone the
host default (`NOUS_MODEL`, defaults to `tencent/hy3:free` — free tier and supports tool calling).

Users can bring their own key and pick any model:

```
!llm hermes <your-nous-key> anthropic/claude-sonnet-4.6
!llm hermes <your-nous-key> tencent/hy3:free
```

Model slugs are vendor-prefixed; free variants end in `:free`. Note that Nous's own docs advise
against the `Hermes-4-*` models for rapid tool-calling loops — prefer an agentic model for drops
and lookups.

### OpenRouter

`switch to openrouter` routes through [openrouter.ai](https://openrouter.ai) — 100+ models on one
key. There's no host-level OpenRouter key: it's per-user only, so each person DMs `!llm openrouter
<key>` first. Default model is `openai/gpt-4o`.

### Minds AI (experimental)

Minds AI is a platform by Animoca Brands that lets you deploy custom AI agents trained on your own data. DiscoCentaur can route messages to your personal Mind via Discord.

**How to connect your Mind:**

1. Get a Builder API key at [build.hellominds.ai/console](https://build.hellominds.ai/console) (sign in → Keys → Create)
2. DM the bot:
   ```
   !minds <builder-api-key>
   ```
   If you have more than one Mind, specify which one:
   ```
   !minds <builder-api-key> <mind-name>
   ```
3. Switch the channel to Minds mode: `@DiscoCentaur switch to minds`

**Per-user privacy:** Each user connects their own Builder API key. The bot uses it to call the Minds API on their behalf — no one else can access your Mind, and the bot owner's Mind is never shared. Keys are stored encrypted with AES-256-GCM.

**Other DM commands:**
```
!minds-remove   — disconnect your Minds credentials
```

> **⚠️ Experimental.** The Minds API is in active development and can be intermittently unreliable — requests sometimes time out on their side with no error. If your Mind stops responding, wait a few minutes and try again. For anything critical, switch to Claude.

> **Performance depends on the model.** Claude delivers the best results and is the recommended provider for all actions. It was purpose-built for agentic tool use and handles the full feature set reliably — drops, role-based sends, scheduling, conditional drops, presence filters, and multi-step lookups.
>
> Gemini and OpenAI are included as options but have significant limitations in practice: they tend to narrate what they would do instead of executing tools, hallucinate results, and fail on multi-step chains. Use them for casual conversation only. For anything involving tokens or scheduling, switch to Claude.

## Scheduled & conditional drops

```
@DiscoCentaur send 1 USDC to @team in 3 hours
@DiscoCentaur send 0.01 USDC to everyone online tomorrow at 9am
@DiscoCentaur if ETH hits $5000 today, send 0.5 USDC to @holders
@DiscoCentaur list my scheduled drops
@DiscoCentaur cancel drop <id>
```

Scheduled drops survive bot restarts. Conditional drops use Brave Search to evaluate the condition at the scheduled check time.

## Channel watchers

```
@DiscoCentaur send 0.01 USDC to the first person who types "gm" here
@DiscoCentaur give 1 USDC to the first 3 people who say "wagmi" in this channel
@DiscoCentaur list my watchers
@DiscoCentaur cancel watcher <id>
```

## Role management

Access to DiscoCentaur is controlled by `DISCORD_ALLOWED_ROLES` in `.env`. Only members with those roles can interact with the bot or switch providers.

**Granting access:**
Assign the allowed role to a user in Discord (Server Settings → Roles, or right-click the user). There is no bot command for this — it's managed through Discord's native role system.

**Notifying new members:**
Discord doesn't proactively notify users when they receive a role. Options:
- **Manual** — tell the user directly that they now have access and can use `@DiscoCentaur`
- **Automated** — a future version of DiscoCentaur can listen to the `GuildMemberUpdate` event and automatically DM new members when they receive an allowed role, with onboarding instructions. This is not yet built in but is a planned improvement.

**Changing allowed roles:**
Edit `DISCORD_ALLOWED_ROLES` in `.env` and restart the bot (`pm2 restart claudetaur`). Multiple roles are comma-separated:
```
DISCORD_ALLOWED_ROLES=Team Quidli,Admins,Moderators
```

**If a user tries to access without permission:**
The bot replies in-channel telling them which role is required. They won't be able to switch providers or trigger any actions until the role is granted.

## Tool-loop safety

Every user message is capped at **25 tool round-trips** (`MAX_TOOL_ROUNDS`) across all
providers. A drop typically uses 3–15 (resolve → lookup retries → drop), so the cap only
trips on a model that's looping. This matters because the model mints each
`quidli_drop` idempotency key, so an unbounded loop would issue repeated *distinct*
transfers rather than harmless retries. On hitting the cap the bot stops and says so.

Two related guards on the OpenAI-compatible path (OpenAI, OpenRouter, Hermes):

- Tool calls are executed whenever present, regardless of `finish_reason` — some providers
  label them `stop`, and requiring `tool_calls` would silently skip execution
- Except when `finish_reason` is `length`: a response cut off by the token limit may carry
  half-written JSON arguments, so it's rejected rather than run
- Arguments that fail to parse return an error to the model instead of calling the tool
  with `{}`

## Troubleshooting

**"Stopped after 25 tool steps":** The model looped without finishing. Retry with a simpler
request, or switch providers — nothing after the cap was executed.

**Bot doesn't respond:** Check that Message Content Intent, Server Members Intent, and Presence Intent are all enabled in the Discord Developer Portal.

**Role lookups return wrong members:** Use the Discord role picker (type `@` and select from the dropdown) rather than typing the role name as plain text.

**Drop returns 400:** Ensure Smart Send is enabled and funded at [connect.quid.li](https://connect.quid.li).

**Score returns 404:** Confirm `QUIDLI_API_KEY` is set in `.env`.

**Conditional drop fires at wrong time:** Make sure `BRAVE_SEARCH_API_KEY` is set — without it the bot can't look up event schedules and will guess the check time.

**Gemini not calling tools:** This is a known limitation of Gemini Flash/Pro for multi-step tool use. Switch back to Claude for any action that involves drops, lookups, or scheduling.
