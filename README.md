# DiscoCentaur

A Claude-powered Discord bot with [Quidli Connect](https://connect.quid.li) integration. Ask it in plain English to look up wallets, check reputation scores, and send tokens — all without anyone needing to share a wallet address.

## What it can do

- **Look up wallets** — resolve any Discord user, Farcaster handle, email, GitHub, Telegram, LinkedIn, or phone number to their ETH/SOL wallet address
- **Check reputation scores** — get a composite web3 reputation score (Neynar, Lens, Ethos) for any user by their social identity
- **Send tokens** — drop USDC or other tokens to individuals or entire Discord roles via Quidli Smart Send
- **Role-based access** — restrict bot usage to specific Discord roles
- **Role member resolution** — mention a Discord role and the bot resolves all its members automatically

## How it works

```
Discord message → Claude (claude-sonnet-4-6)
               → Quidli Connect API (lookup / scores / drop)
               → edit Discord reply in real time
```

Claude decides when to call the Quidli API based on natural language. You don't need to use specific commands — just ask naturally.

**Examples:**
```
@DiscoCentaur what's the wallet for @luis?
@DiscoCentaur check the reputation score for ahn.eth on Farcaster
@DiscoCentaur send 5 USDC to everyone in @devs
@DiscoCentaur what's my wallet?
```

## Prerequisites

- Node.js 18+
- A Discord bot application
- An Anthropic API key
- A Quidli Connect API key (from [connect.quid.li](https://connect.quid.li))
- *(Optional)* A funded bot wallet for x402 pay-per-request on `/lookup` without an API key

## Setup

### 1. Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**.
2. Go to **Bot**. Copy the **Token** — this is your `DISCORD_TOKEN`.
3. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent**
   - **Server Members Intent**
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
| `QUIDLI_API_KEY` | ✅* | API key from [connect.quid.li](https://connect.quid.li). Required for `/scores` and `/drop`. |
| `BOT_WALLET_PRIVATE_KEY` | ✅* | Private key of a funded wallet for x402 pay-per-request on `/lookup`. Required if `QUIDLI_API_KEY` is not set. |
| `BOT_WALLET_ADDRESS` | — | Wallet address (informational, not used in code) |
| `CLAUDE_MODEL` | — | Claude model to use. Defaults to `claude-sonnet-4-6` |
| `SYSTEM_PROMPT` | — | Override the default system prompt |
| `DISCORD_ACTIVE_CHANNELS` | — | Comma-separated channel IDs where the bot responds to all messages (not just @mentions) |
| `DISCORD_ALLOWED_USERS` | — | Comma-separated Discord user IDs allowed to use the bot. Empty = everyone |
| `DISCORD_ALLOWED_ROLES` | — | Comma-separated Discord role names allowed to use the bot. Empty = everyone |

*At least one of `QUIDLI_API_KEY` or `BOT_WALLET_PRIVATE_KEY` is required.

### 3. Enable Smart Send (for token drops)

To use the `/drop` endpoint:

1. Log in at [connect.quid.li](https://connect.quid.li)
2. Go to **Smart Send** and toggle it on
3. Fund the Smart Send wallet with tokens and ETH for gas

### 4. Install and run

```bash
npm install
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Authentication modes

**API key (recommended):** Set `QUIDLI_API_KEY` in `.env`. All requests use your key with no per-request cost beyond your Quidli plan.

**x402 (pay-per-request):** Set `BOT_WALLET_PRIVATE_KEY` with a wallet funded with USDC and ETH on Base. The bot pays automatically when the API returns a 402. No API key needed for `/lookup`.

## Troubleshooting

**Bot doesn't respond:** Check that Message Content Intent and Server Members Intent are enabled in the Discord Developer Portal.

**Role lookups return wrong members:** Make sure you're using the Discord role picker (type `@` and select from the dropdown) rather than typing the role name as plain text.

**Drop returns 400:** Ensure Smart Send is enabled and the Smart Send wallet is funded at [connect.quid.li](https://connect.quid.li).

**Score returns 404:** Confirm `QUIDLI_API_KEY` is set in `.env` — the `/scores` endpoint requires an API key.
