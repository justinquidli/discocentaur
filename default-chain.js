// The chain a send uses when the request doesn't name one. Set per bot with
// DEFAULT_CHAIN=base|solana in .env. Base is the default because it's the only
// chain where Connect sponsors gas; Solana-only teams pick Solana once.

export const SOLANA_CHAIN_ID = 1399811149;

export const CHAINS = {
  base: {
    id: 8453,
    name: 'Base',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    native: 'ETH',
    gasNote: 'Gas on Base is sponsored, so the sender needs no ETH.',
  },
  solana: {
    id: SOLANA_CHAIN_ID,
    name: 'Solana',
    usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    native: 'SOL',
    gasNote: 'On Solana the sender pays a small network fee in SOL, so their Connect wallet needs a little SOL as well as the token.',
  },
};

// Returns { chain, warning }. Unknown values fall back to Base with a warning
// rather than stopping the bot.
export function parseDefaultChain(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return { chain: CHAINS.base, warning: null };
  const hit = Object.entries(CHAINS).find(([key, c]) => v === key || v === String(c.id));
  if (hit) return { chain: hit[1], warning: null };
  return { chain: CHAINS.base, warning: `DEFAULT_CHAIN="${value}" isn't supported (use base or solana); using Base.` };
}

// Appended to the system prompt. It comes last, so it wins over any
// "Base is the default" line in an older custom prompt file.
export function defaultChainPrompt(chain) {
  const other = chain.id === CHAINS.base.id ? CHAINS.solana : CHAINS.base;
  return `\n\n## Default chain for this server
- When a request names no chain, use ${chain.name} (chainId ${chain.id}) for sends, balances and lookups. This overrides any other default mentioned above.
- USDC on ${chain.name}: tokenContract=${chain.usdc}, 6 decimals (1 USDC = 1000000). For ${chain.native}, the native token, leave tokenContract out.
- USDC on ${other.name}, only when the user asks for ${other.name}: tokenContract=${other.usdc}, 6 decimals.
- ${chain.gasNote}`;
}
