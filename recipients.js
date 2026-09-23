/**
 * Connect's POST /drop currently rejects social recipients
 * ("recipients.0.property type should not exist") even though its published
 * schema allows them — observed 2026-09-15 and in both bots' logs 2026-09-16.
 * Lookup does work, so every drop resolves social recipients to wallets first
 * and sends to { type: 'wallet', id: <address> }.
 *
 * All-or-nothing: if any recipient can't be resolved, nothing is sent and the
 * caller is told which ones — never a silent partial drop.
 *
 * Side-effect free (lookup and wait are injected) so tests can import it.
 */

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const keyOf = (type, v) => `${String(type).toLowerCase()}:${String(v ?? '').replace(/^@/, '').toLowerCase()}`;

/**
 * @param recipients [{type, id?, username?}]
 * @param lookup async (recipients) => parsed connect_lookup response
 * @returns {Promise<{ recipients: {type:'wallet', id:string}[] } | { error: string, failed: string[] }>}
 */
export async function resolveRecipientsToWallets(recipients, lookup, { tries = 6, waitMs = 2000, wait = sleep } = {}) {
  const list = (Array.isArray(recipients) ? recipients : []).map(({ type, id, username }) => ({ type, id, username }));
  if (!list.length) return { error: 'No recipients.', failed: [] };

  const wallets = [];
  const social = [];
  for (const r of list) {
    if (r.type === 'wallet') {
      const addr = r.id ?? r.username;
      if (!EVM_ADDR_RE.test(addr ?? '')) return { error: `Invalid wallet address "${addr}".`, failed: [String(addr)] };
      wallets.push(addr);
    } else {
      social.push(r.id ? { type: r.type, id: String(r.id) } : { type: r.type, username: String(r.username ?? '').replace(/^@/, '') });
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
      return { error: 'Connect is still creating wallets for some recipients. Try again in a few seconds.', failed: [] };
    }
    for (const x of res?.results ?? []) {
      if (EVM_ADDR_RE.test(x.ethWalletAddress ?? '')) resolved.set(keyOf(x.type, x.value), x.ethWalletAddress);
    }
  }

  const failed = [];
  for (const r of social) {
    const addr = resolved.get(keyOf(r.type, r.id ?? r.username));
    if (addr) wallets.push(addr);
    else failed.push(`${r.type}:${r.id ?? r.username}`);
  }
  if (failed.length) {
    return { error: `Could not resolve a wallet for: ${failed.join(', ')}. Nothing was sent.`, failed };
  }
  return { recipients: wallets.map((id) => ({ type: 'wallet', id })) };
}
