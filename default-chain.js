// The chain a send uses when the request doesn't name one. Set per bot with
// DEFAULT_CHAIN in .env: any chain Connect sends on, by name or chain ID.
// Base is the default because it's the only chain where Connect sponsors gas.

export const SOLANA_CHAIN_ID = 1399811149;

// USDC addresses are Circle's native USDC, each checked onchain (symbol,
// name, 6 decimals) on 2026-11-27. null = not verified: the bot asks for the
// token's address there instead of guessing one.
export const CHAINS = {
  base: { id: 8453, name: 'Base', native: 'ETH', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', sponsored: true },
  solana: { id: SOLANA_CHAIN_ID, name: 'Solana', native: 'SOL', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', aliases: ['sol'] },
  ethereum: { id: 1, name: 'Ethereum', native: 'ETH', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', aliases: ['eth', 'mainnet'] },
  arbitrum: { id: 42161, name: 'Arbitrum', native: 'ETH', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', aliases: ['arbitrum one', 'arb'] },
  optimism: { id: 10, name: 'Optimism', native: 'ETH', usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', aliases: ['op', 'op mainnet'] },
  polygon: { id: 137, name: 'Polygon', native: 'POL', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', aliases: ['matic'] },
  avalanche: { id: 43114, name: 'Avalanche', native: 'AVAX', usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', aliases: ['avax'] },
  worldchain: { id: 480, name: 'World Chain', native: 'ETH', usdc: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', aliases: ['world chain', 'world'] },
  celo: { id: 42220, name: 'Celo', native: 'CELO', usdc: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' },
  monad: { id: 143, name: 'Monad', native: 'MON', usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' },
  arc: { id: 5042, name: 'Arc', native: 'USDC', usdc: null, nativeIsUsdc: true },
  robinhood: { id: 4663, name: 'Robinhood Chain', native: 'ETH', usdc: null, aliases: ['robinhood chain'] },
};

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** The CHAINS entry for a name, alias or chain ID, or null. */
export function findChain(value) {
  const v = norm(value);
  if (!v) return null;
  return Object.entries(CHAINS).find(([key, c]) =>
    v === key || v === String(c.id) || v === norm(c.name) || (c.aliases ?? []).includes(v))?.[1] ?? null;
}

// Returns { chain, warning }. Unknown values fall back to Base with a warning
// rather than stopping the bot.
export function parseDefaultChain(value) {
  if (!norm(value)) return { chain: CHAINS.base, warning: null };
  const chain = findChain(value);
  if (chain) return { chain, warning: null };
  return { chain: CHAINS.base, warning: `DEFAULT_CHAIN="${value}" isn't a chain Labr knows (try base, solana, arbitrum, polygon...); using Base.` };
}

/** Startup check against Connect's live list ([{ chainId, features }]). Warning text or null. */
export function defaultChainWarning(chain, connectChains) {
  if (!Array.isArray(connectChains) || !connectChains.length) return null;
  const hit = connectChains.find((c) => Number(c?.chainId) === chain.id);
  if (hit && hit.features?.drop !== false) return null;
  return `DEFAULT_CHAIN is ${chain.name}, but Connect doesn't send on it right now. Sends that name no chain will fail until it's back or DEFAULT_CHAIN changes.`;
}

export function gasNote(chain) {
  if (chain.sponsored) return `Gas on ${chain.name} is sponsored, so the sender needs no ${chain.native}.`;
  if (chain.nativeIsUsdc) return `On ${chain.name} gas is paid in USDC, so keep a little extra USDC in the wallet.`;
  if (chain.id === SOLANA_CHAIN_ID) return 'On Solana the sender pays a small network fee in SOL, so their Connect wallet needs a little SOL as well as the token.';
  return `On ${chain.name} the sender pays gas in ${chain.native}, so their Connect wallet needs some ${chain.native} as well as the token.`;
}

// Appended to the system prompt. It comes last, so it wins over any
// "Base is the default" line in an older custom prompt file.
export function defaultChainPrompt(chain) {
  const lines = [`- When a request names no chain, use ${chain.name} (chainId ${chain.id}) for sends, balances and lookups. This overrides any other default mentioned above.`];
  if (chain.usdc) lines.push(`- USDC on ${chain.name}: tokenContract=${chain.usdc}, 6 decimals (1 USDC = 1000000). For ${chain.native}, the native token, leave tokenContract out.`);
  else if (chain.nativeIsUsdc) lines.push(`- On ${chain.name}, USDC is the native token: leave tokenContract out, and read its decimals from connect_drop_balance before sending.`);
  else lines.push(`- No USDC address is known for ${chain.name}. For ${chain.native}, the native token, leave tokenContract out; for any other token, ask the user for its contract address on ${chain.name}. Never guess one.`);
  const verified = Object.values(CHAINS).filter((c) => c.usdc && c.id !== chain.id);
  lines.push(`- USDC on other chains, only when the user names that chain: ${verified.map((c) => `${c.name} ${c.usdc}`).join('; ')}. All 6 decimals.`);
  lines.push(`- ${gasNote(chain)}`);
  return `\n\n## Default chain for this server\n${lines.join('\n')}`;
}
