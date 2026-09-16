/**
 * Bankr Agent API client (https://docs.bankr.bot/agent-api/overview).
 *
 * Bankr is a natural-language trading/wallet agent: one prompt in, one answer
 * out, executed against the Bankr wallet that owns the API key. It can swap,
 * transfer, buy and sell — so a call can spend, and the bot treats it as a
 * money tool (see MONEY_TOOLS in held-actions.js).
 *
 * The API is async: POST /agent/prompt returns a jobId, GET /agent/job/:id is
 * polled until a terminal status. A job that is still running when we stop
 * waiting has NOT been cancelled — it may still execute — so the result says
 * so explicitly, and the model is told never to resubmit it.
 *
 * Side-effect free (fetch is injectable) so tests can import it.
 */

export const BANKR_BASE_URL = 'https://api.bankr.bot';
export const BANKR_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const EXPLORER_TX_RE = /https?:\/\/(?:optimistic\.etherscan\.io|etherscan\.io|polygonscan\.com|basescan\.org|arbiscan\.io|snowtrace\.io|solscan\.io)\/tx\/[A-Za-z0-9]+/g;

/** Explorer links Bankr itself returned — the only ones the bot may vouch for. */
export function extractExplorerUrls(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return [...new Set(text.match(EXPLORER_TX_RE) ?? [])];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Submit a prompt and wait for it.
 * @returns {Promise<{status: string, executed: boolean|null, jobId?: string, threadId?: string,
 *   response?: string, error?: string, explorerUrls: string[], message?: string}>}
 */
export async function bankrAgent({ prompt, threadId } = {}, apiKey, {
  fetchImpl = fetch, baseUrl = BANKR_BASE_URL, pollMs = 2000, timeoutMs = 120_000, now = () => Date.now(), wait = sleep,
} = {}) {
  if (!apiKey) throw new Error('No Bankr API key');
  const text = String(prompt ?? '').trim();
  if (!text) return { status: 'refused', executed: false, error: 'Empty prompt', explorerUrls: [] };
  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

  const submitRes = await fetchImpl(`${baseUrl}/agent/prompt`, {
    method: 'POST', headers,
    body: JSON.stringify(threadId ? { prompt: text, threadId } : { prompt: text }),
    signal: AbortSignal.timeout(20_000),
  });
  const submitted = await submitRes.json().catch(() => ({}));
  if (!submitRes.ok || !submitted.jobId) {
    // Nothing was queued, so nothing can have executed.
    const msg = submitted.error || submitted.message || `HTTP ${submitRes.status}`;
    return { status: 'failed', executed: false, error: `Bankr rejected the prompt: ${String(msg).slice(0, 300)}`, httpStatus: submitRes.status, explorerUrls: [] };
  }

  const { jobId } = submitted;
  const tid = submitted.threadId ?? threadId;
  const started = now();
  let job = submitted;
  while (!BANKR_TERMINAL.has(job.status)) {
    if (now() - started > timeoutMs) {
      return {
        status: 'still_running', executed: null, jobId, threadId: tid, explorerUrls: [],
        message: 'Bankr is still working on this job. It was NOT cancelled and may still execute. ' +
          'Do not resubmit it; tell the user it is still processing and to check their Bankr wallet shortly.',
      };
    }
    await wait(pollMs);
    try {
      const r = await fetchImpl(`${baseUrl}/agent/job/${encodeURIComponent(jobId)}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (r.ok) job = await r.json();
    } catch { /* transient — keep polling until the deadline */ }
  }

  const out = {
    status: job.status,
    executed: job.status === 'completed' ? true : null,
    jobId, threadId: tid,
    response: typeof job.response === 'string' ? job.response.slice(0, 4000) : undefined,
    explorerUrls: extractExplorerUrls([job.response, job.richData, job.transactions]),
  };
  if (job.status === 'failed') out.error = String(job.error ?? job.response ?? 'Bankr job failed').slice(0, 500);
  if (job.status === 'cancelled') out.executed = false;
  if (job.processingTime != null) out.processingTimeMs = job.processingTime;
  return out;
}

/** Bankr threads are per-conversation per-user, so one user's context never leaks to another. */
export function createBankrThreads({ ttlMs = 4 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const m = new Map();
  const k = (contextId, senderId) => `${contextId}:${senderId}`;
  return {
    get(contextId, senderId) {
      const e = m.get(k(contextId, senderId));
      if (!e) return undefined;
      if (now() - e.at > ttlMs) { m.delete(k(contextId, senderId)); return undefined; }
      return e.threadId;
    },
    set(contextId, senderId, threadId) {
      if (threadId) m.set(k(contextId, senderId), { threadId, at: now() });
    },
    clear(contextId) {
      for (const key of m.keys()) if (key.startsWith(`${contextId}:`)) m.delete(key);
    },
  };
}

// ─── Swap in Bankr, then distribute with Connect ─────────────────────────────
// Deterministic Wallet API calls (not the natural-language agent), so every
// amount the bot moves is one it read back from an API response:
//   1. read the sender's Connect Smart Send address + current balance
//   2. quote + swap in the Bankr wallet (idempotency key)
//   3. transfer exactly what the swap returned to the Connect address
//   4. wait until Connect sees the balance arrive
//   5. drop it, split evenly, to the recipients
// Any step that fails or is uncertain stops the chain and says where the funds
// are. Nothing is ever retried automatically: /wallet/transfer has no
// idempotency key, and a 502/504 on swap may already be on-chain.

export const BANKR_CHAINS = { base: 8453, mainnet: 1, polygon: 137, arbitrum: 42161 };
export const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function isNativeToken(t) {
  const s = String(t ?? '').toLowerCase();
  return s === 'native' || s === NATIVE_SENTINEL || s === '0x0000000000000000000000000000000000000000';
}

export function formatUnits(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Balance in base units of `token` in a connect_drop_balance response. */
export function connectBalanceOf(balance, token) {
  const native = isNativeToken(token);
  const a = (balance?.assets ?? []).find((x) => native
    ? x.type === 'native'
    : String(x.tokenContract ?? '').toLowerCase() === String(token).toLowerCase());
  return BigInt(a?.balanceInWei ?? '0');
}

async function bankrPost(path, body, apiKey, { fetchImpl, baseUrl, timeoutMs }) {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

const errText = (r) => String(r.json?.error ?? r.json?.message ?? `HTTP ${r.status}`).slice(0, 300);

/**
 * @param input { sellToken, buyToken, sellAmount, chain?, recipients, slippageBps? }
 * @param deps  { bankrKey, getConnectBalance(chainId) → parsed balance JSON,
 *                drop({recipients, amountInWeiPerRecipient, chainId, tokenContract}) → drop result,
 *                explorerUrl(chainId, hash) → url|null, uuid() }
 */
export async function bankrSwapAndDrop(input, deps, {
  fetchImpl = fetch, baseUrl = BANKR_BASE_URL, pollMs = 4000, arrivalTimeoutMs = 120_000,
  now = () => Date.now(), wait = sleep,
} = {}) {
  const { bankrKey, getConnectBalance, drop, resolveRecipients = async (r) => ({ recipients: r }), explorerUrl = () => null, uuid = () => crypto.randomUUID() } = deps;
  const chain = String(input.chain ?? 'base').toLowerCase();
  const chainId = BANKR_CHAINS[chain];
  const steps = [];
  const explorerUrls = [];
  const done = (status, message, extra = {}) => ({ status, message, steps, explorerUrls, ...extra });
  const note = (step, ok, detail, hash) => {
    const url = hash ? explorerUrl(chainId, hash) : null;
    if (url) explorerUrls.push(url);
    steps.push({ step, ok, ...(detail ? { detail } : {}), ...(hash ? { hash } : {}), ...(url ? { explorerUrl: url } : {}) });
  };

  // ── Validate before touching anything ──
  if (!chainId) return done('refused', `Unsupported chain "${chain}". Use one of: ${Object.keys(BANKR_CHAINS).join(', ')}.`);
  const sellNative = isNativeToken(input.sellToken);
  const buyNative = isNativeToken(input.buyToken);
  if (!sellNative && !EVM_ADDR_RE.test(input.sellToken ?? '')) return done('refused', 'sellToken must be a contract address or "native".');
  if (!buyNative && !EVM_ADDR_RE.test(input.buyToken ?? '')) return done('refused', 'buyToken must be a contract address or "native".');
  if (!/^\d+(\.\d+)?$/.test(String(input.sellAmount ?? '')) || Number(input.sellAmount) <= 0) return done('refused', 'sellAmount must be a positive decimal number, e.g. "5".');
  const recipients = Array.isArray(input.recipients) ? input.recipients : [];
  if (!recipients.length) return done('refused', 'No recipients. Resolve the group members first.');
  if (!bankrKey) return done('refused', 'No Bankr key linked.');
  const sellToken = sellNative ? NATIVE_SENTINEL : input.sellToken;
  const buyToken = buyNative ? NATIVE_SENTINEL : input.buyToken;
  const http = { fetchImpl, baseUrl, timeoutMs: 30_000 };

  // ── 0. Recipients → wallets, before any money moves ──
  let payees;
  try {
    const res = await resolveRecipients(recipients);
    if (res.error) return done('refused', `${res.error} Nothing was swapped.`, { stage: 'recipients', failedRecipients: res.failed });
    payees = res.recipients;
  } catch (err) {
    return done('failed', `Could not resolve recipients, nothing was swapped: ${err.message}`, { stage: 'recipients' });
  }
  note('recipients_resolved', true, `${payees.length} wallet${payees.length === 1 ? '' : 's'}`);

  // ── 1. Connect destination ──
  let before, connectAddress;
  try {
    const bal = await getConnectBalance(chainId);
    connectAddress = bal?.walletAddress;
    if (!EVM_ADDR_RE.test(connectAddress ?? '')) throw new Error('no Smart Send wallet address in the balance response');
    before = connectBalanceOf(bal, buyToken);
  } catch (err) {
    return done('failed', `Could not read the Connect wallet, nothing was swapped: ${err.message}`, { stage: 'connect_balance' });
  }
  note('connect_wallet', true, connectAddress);

  // ── 2. Quote + swap ──
  const legs = { fromChain: chain, toChain: chain, fromToken: sellToken, toToken: buyToken, amount: String(input.sellAmount) };
  const q = await bankrPost('/wallet/swap-quote', { ...legs, ...(input.slippageBps ? { slippageBps: input.slippageBps } : {}) }, bankrKey, http);
  if (!q.ok || !q.json?.minBuyAmount) return done('failed', `Bankr quote failed, nothing was swapped: ${errText(q)}`, { stage: 'quote' });
  const quote = q.json;
  const decimals = Number(quote.to?.decimals);
  const symbol = quote.to?.symbol ?? 'tokens';
  note('quote', true, `${input.sellAmount} ${quote.from?.symbol ?? ''} → ≥${quote.minBuyAmount} ${symbol}`.trim());

  let swap;
  try {
    swap = await bankrPost('/wallet/swap', {
      ...legs, minBuyAmount: quote.minBuyAmount,
      ...(input.slippageBps ? { slippageBps: input.slippageBps } : {}),
      ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
      idempotencyKey: uuid(),
    }, bankrKey, { ...http, timeoutMs: 90_000 });
  } catch (err) {
    return done('unknown', `The swap request timed out (${err.message}). It may have executed — check the Bankr wallet before trying again.`, { stage: 'swap' });
  }
  if (swap.status === 502 || swap.status === 504) {
    return done('unknown', `Bankr says the swap may be on-chain but unconfirmed (${errText(swap)}). Check the Bankr wallet before trying again.`, { stage: 'swap' });
  }
  if (!swap.ok) return done('failed', `Bankr swap rejected, nothing was swapped: ${errText(swap)}`, { stage: 'swap' });
  if (!swap.json.success) {
    note('swap', false, 'reverted on-chain (gas was spent, no tokens exchanged)', swap.json.hash);
    return done('failed', 'The swap reverted on-chain. No tokens were exchanged.', { stage: 'swap' });
  }
  const receivedRaw = BigInt(swap.json.amountReceivedRaw ?? '0');
  if (receivedRaw <= 0n || !Number.isInteger(decimals)) {
    note('swap', true, 'filled, but the received amount was not reported', swap.json.hash);
    return done('partial', `The swap filled but Bankr did not report how much ${symbol} came back, so nothing was moved to Connect. The ${symbol} is in the Bankr wallet.`, { stage: 'swap' });
  }
  const receivedHuman = formatUnits(receivedRaw, decimals);
  note('swap', true, `received ${receivedHuman} ${symbol}`, swap.json.hash);

  // ── 3. Bankr → Connect ──
  let xfer;
  try {
    xfer = await bankrPost('/wallet/transfer', {
      tokenAddress: buyNative ? '0x0000000000000000000000000000000000000000' : buyToken,
      recipientAddress: connectAddress, amount: receivedHuman, isNativeToken: buyNative, chain,
    }, bankrKey, { ...http, timeoutMs: 90_000 });
  } catch (err) {
    return done('unknown', `Swap done, but the transfer to Connect timed out (${err.message}) and may or may not have gone out. ${receivedHuman} ${symbol} is in the Bankr wallet or on its way to ${connectAddress}. Do not retry — check both wallets.`, { stage: 'transfer' });
  }
  if (!xfer.ok || !xfer.json?.success) {
    return done('partial', `Swap done, but moving it to Connect failed: ${errText(xfer)}. ${receivedHuman} ${symbol} is in the Bankr wallet.`, { stage: 'transfer' });
  }
  note('transfer_to_connect', true, `${receivedHuman} ${symbol} → ${connectAddress}`, xfer.json.txHash);

  // ── 4. Wait for Connect to see it ──
  const target = before + receivedRaw;
  const started = now();
  let seen = before;
  while (seen < target) {
    if (now() - started > arrivalTimeoutMs) {
      return done('partial', `Swap and transfer done, but Connect hasn't shown the ${symbol} yet, so nothing was dropped. Ask again in a minute to send it — it's in the Connect wallet (or about to be).`, { stage: 'arrival', received: receivedHuman, symbol, tokenContract: buyNative ? null : buyToken, chainId });
    }
    await wait(pollMs);
    try { seen = connectBalanceOf(await getConnectBalance(chainId), buyToken); } catch { /* keep waiting */ }
  }
  note('arrived_in_connect', true);

  // ── 5. Drop ──
  const per = receivedRaw / BigInt(payees.length);
  if (per <= 0n) return done('partial', `${receivedHuman} ${symbol} is too little to split across ${payees.length} people. It's in the Connect wallet.`, { stage: 'drop' });
  let dropped;
  try {
    dropped = await drop({ recipients: payees, amountInWeiPerRecipient: per.toString(), chainId, tokenContract: buyNative ? null : buyToken });
  } catch (err) {
    return done('partial', `Swap and transfer done; the drop failed (${err.message.slice(0, 200)}). ${receivedHuman} ${symbol} is in the Connect wallet. Check before retrying — a timed-out drop may still land.`, { stage: 'drop' });
  }
  if (!dropped?.transferHash) {
    return done('partial', `Swap and transfer done; the drop did not go through (${String(dropped?.error ?? dropped?.message ?? 'no transfer hash').slice(0, 200)}). ${receivedHuman} ${symbol} is in the Connect wallet.`, { stage: 'drop', dropResult: dropped });
  }
  if (dropped.explorerUrl) explorerUrls.push(dropped.explorerUrl);
  steps.push({ step: 'drop', ok: true, hash: dropped.transferHash, ...(dropped.explorerUrl ? { explorerUrl: dropped.explorerUrl } : {}) });
  return done('completed',
    `Swapped ${input.sellAmount} ${quote.from?.symbol ?? ''} for ${receivedHuman} ${symbol} in Bankr, moved it to Connect, and sent ${formatUnits(per, decimals)} ${symbol} each to ${payees.length} recipient${payees.length === 1 ? '' : 's'}.`.replace(/\s+/g, ' '),
    { received: receivedHuman, perRecipient: formatUnits(per, decimals), symbol, dropResult: dropped });
}
