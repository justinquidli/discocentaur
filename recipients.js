/**
 * Resolves social recipients to wallet addresses before a drop, via
 * connect_lookup, and the drop is then sent to { type: 'wallet', id }.
 * Kept because it is the path proven to work: Connect's /drop rejected social
 * recipients outright on 2026-09-15/16, and a send with a Discord display name
 * failed to resolve on 2026-09-23.
 *
 * The address depends on the chain. connect_lookup returns ethWalletAddress
 * AND solWalletAddress (shape seen live 2026-09-23). A Solana drop goes to the
 * Solana address, everything else to the EVM one. Before this, every recipient
 * got the EVM address and a pasted Solana address was rejected, so no Solana
 * drop could run.
 *
 * Per-recipient amounts (amountInWei) are carried through, in order.
 *
 * All-or-nothing: if any recipient can't be resolved, nothing is sent and the
 * caller is told which ones — never a silent partial drop.
 *
 * Side-effect free (lookup and wait are injected) so tests can import it.
 */

export const SOLANA_CHAIN_ID = 1399811149;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
// Base58, 32–44 chars: no 0, O, I or l.
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isSolanaChain = (chainId) => Number(chainId) === SOLANA_CHAIN_ID;

const keyOf = (type, v) => `${String(type).toLowerCase()}:${String(v ?? '').replace(/^@/, '').toLowerCase()}`;

/**
 * @param recipients [{type, id?, username?, amountInWei?}]
 * @param lookup async (recipients) => parsed connect_lookup response
 * @param opts.chainId the chain the drop goes out on; picks the address type
 * @returns {Promise<{ recipients: {type:'wallet', id:string, amountInWei?:string}[] } | { error: string, failed: string[] }>}
 */
export async function resolveRecipientsToWallets(recipients, lookup, { chainId = 8453, tries = 6, waitMs = 2000, wait = sleep } = {}) {
  const solana = isSolanaChain(chainId);
  const ADDR_RE = solana ? SOL_ADDR_RE : EVM_ADDR_RE;
  const field = solana ? 'solWalletAddress' : 'ethWalletAddress';
  const kind = solana ? 'Solana' : 'EVM';

  const list = (Array.isArray(recipients) ? recipients : []).map((r) => ({ ...(r ?? {}) }));
  if (!list.length) return { error: 'No recipients.', failed: [] };

  const social = [];
  for (const r of list) {
    if (r.type === 'wallet') {
      const addr = r.id ?? r.username;
      if (!ADDR_RE.test(addr ?? '')) {
        return { error: `Invalid ${kind} wallet address "${addr}" for chain ${chainId}. Nothing was sent.`, failed: [String(addr)] };
      }
    } else {
      social.push(r.id != null && r.id !== ''
        ? { type: r.type, id: String(r.id) }
        : { type: r.type, username: String(r.username ?? '').replace(/^@/, '') });
    }
  }

  const resolved = new Map();
  if (social.length) {
    let res;
    for (let i = 0; i < tries; i++) {
      res = await lookup(social);
      if (res?.status !== 'processing') break;
      if (i < tries - 1) await wait(waitMs);
    }
    if (res?.status === 'processing') {
      return { error: 'Connect is still creating wallets for some recipients. Nothing was sent. Try again in a few seconds.', failed: [] };
    }
    for (const x of res?.results ?? []) {
      if (ADDR_RE.test(x?.[field] ?? '')) resolved.set(keyOf(x.type, x.value), x[field]);
    }
  }

  const out = [];
  const failed = [];
  for (const r of list) {
    const amount = r.amountInWei != null ? { amountInWei: r.amountInWei } : {};
    if (r.type === 'wallet') {
      out.push({ type: 'wallet', id: r.id ?? r.username, ...amount });
      continue;
    }
    const who = r.id != null && r.id !== '' ? String(r.id) : r.username;
    const addr = resolved.get(keyOf(r.type, who));
    if (addr) out.push({ type: 'wallet', id: addr, ...amount });
    else failed.push(`${r.type}:${who}`);
  }
  if (failed.length) {
    return { error: `Could not resolve a ${kind} wallet for: ${failed.join(', ')}. Nothing was sent.`, failed };
  }
  return { recipients: out };
}
