# DiscoCentaur

A Claude-powered Discord bot with [Quidli Connect](https://connect.quid.li) integration. Ask it in plain English to look up wallets, check reputation scores, and send tokens — all without anyone needing to share a wallet address.

## What it can do

- **Send tokens** — drop USDC or other tokens to individuals or entire Discord roles via Quidli Smart Send
- **Look up wallets** — resolve any Discord user, Farcaster handle, Twitter, email, GitHub, Telegram, or phone number to their ETH/SOL wallet address
- **Check reputation scores** — get a composite web3 reputation score (Neynar, Lens, Ethos) for any user by social identity
- **Schedule drops** — send tokens at a future time, surviving bot restarts
- **Presence-based drops** — target only online/idle/dnd members at execution time, not when scheduled
- **Conditional drops** — "if BTC is above $100k, send everyone 1 USDC" — evaluated automatically using real-time web search
- **Channel watchers** — send tokens to the first person who types a trigger phrase
- **Cancel / reschedule** — manage pending scheduled drops and watchers
- **Per-user API keys** — users can DM `!connect <key>` to link their own Quidli account
- **Web search** — real-time data via Brave Search for conditional drops and factual questions
- **Multi-LLM support** — switch between Claude, Gemini, and OpenAI per channel
- **Role-based access** — restrict bot usage to specific Discord roles

## How it works

```
Discord message → LLM (Claude / Gemini / OpenAI)
               → Quidli Connect API (lookup / scores / drop)
               → edit Discord reply in real time
```

The LLM decides when to call tools based on natural language. No commands needed — just ask naturally.

**Examples:**
```
@DiscoCentaur send 1 USDC to @Guillaume
@DiscoCentaur send 0.01 USDC to everyone in @Dev
@DiscoCentaur what's the wallet for ahn.eth on Farcaster?
@DiscoCentaur schedule a drop of 5 USDC to @team in 2 hours
@DiscoCentaur if the USA wins tonight, send everyone 1 USDC
@DiscoCentaur send 0.01 USDC to the first person who types "gm" here today
@DiscoCentaur switch to gemini
@DiscoCentaur switch to claude
```

## Prerequisites

- Node.js 22+ (uses built-in `node:sqlite`)
- A Discord bot application
- An Anthropic API key
- A Quidli Connect API key (from [connect.quid.li](https://connect.quid.li))
- *(Optional)* Brave Search API key for web search and conditional drops
- *(Optional)* Gemini or OpenAI API keys for multi-LLM switching

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
| `BOT_OWNER_ID` | — | Your Discord user ID — you can trigger drops using the host Quidli wallet without `!connect` |
| `BRAVE_SEARCH_API_KEY` | — | From [brave.com/search/api](https://brave.com/search/api) — required for web search and conditional drops |
| `CLAUDE_MODEL` | — | Defaults to `claude-sonnet-4-6` |
| `DEFAULT_LLM_PROVIDER` | — | `anthropic` (default), `gemini`, or `openai` |
| `GEMINI_API_KEY` | — | From [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | — | Defaults to `gemini-2.5-flash` |
| `OPENAI_API_KEY` | — | From [platform.openai.com](https://platform.openai.com) |
| `OPENAI_MODEL` | — | Defaults to `gpt-4o` |
| `DISCORD_ACTIVE_CHANNELS` | — | Comma-separated channel IDs where the bot responds to all messages (not just @mentions) |
| `DISCORD_ALLOWED_ROLES` | — | Comma-separated Discord role names allowed to use the bot. Empty = everyone |
| `DISCORD_ALLOWED_USERS` | — | Comma-separated Discord user IDs allowed to use the bot. Empty = everyone |
| `BOT_WALLET_PRIVATE_KEY` | — | Private key of a funded wallet for x402 pay-per-request on `/lookup` |
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

## Multi-LLM switching

Switch the active LLM per channel at any time:

```
@DiscoCentaur switch to gemini
@DiscoCentaur switch to claude
@DiscoCentaur switch to openai
```

The choice persists across bot restarts (stored in SQLite). Each provider maintains its own conversation history.

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

## Troubleshooting

**Bot doesn't respond:** Check that Message Content Intent, Server Members Intent, and Presence Intent are all enabled in the Discord Developer Portal.

**Role lookups return wrong members:** Use the Discord role picker (type `@` and select from the dropdown) rather than typing the role name as plain text.

**Drop returns 400:** Ensure Smart Send is enabled and funded at [connect.quid.li](https://connect.quid.li).

**Score returns 404:** Confirm `QUIDLI_API_KEY` is set in `.env`.

**Conditional drop fires at wrong time:** Make sure `BRAVE_SEARCH_API_KEY` is set — without it the bot can't look up event schedules and will guess the check time.

**Gemini not calling tools:** This is a known limitation of Gemini Flash/Pro for multi-step tool use. Switch back to Claude for any action that involves drops, lookups, or scheduling.
