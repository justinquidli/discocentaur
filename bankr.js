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

// ─── Swap via Bankr, funded from Connect ─────────────────────────────────────
// Connect can't swap, so a swap runs in the Bankr wallet. By default the sell
// side comes from the user's Connect Smart Send wallet and the proceeds go back
// there:
//   0. resolve recipients to wallets (if any)            — nothing moved yet
//   1. read both wallets; stop if Bankr has no gas or the source lacks funds
//   2. Connect → Bankr: drop the sell amount to the Bankr address
//   3. wait for Bankr to see it
//   4. quote + swap in Bankr (idempotency key)
//   5. Bankr → Connect: transfer exactly what the swap returned
//   6. wait for Connect to see it
//   7. drop to recipients, split evenly — or stop, with the tokens in Connect
// source:'bankr' skips 2–3 and swaps what's already in Bankr.
//
// Every amount moved is one an API reported. Any failed or uncertain step
// stops the chain and says where the funds are. Nothing is retried
// automatically: a timed-out drop may still land, /wallet/transfer has no
// idempotency key, and a 502/504 swap may already be on-chain.

export const BANKR_CHAINS = { base: 8453, mainnet: 1, polygon: 137, arbitrum: 42161 };
const NATIVE_SYMBOL = { base: 'ETH', mainnet: 'ETH', arbitrum: 'ETH', polygon: 'POL' };
// Minimum native balance in the Bankr wallet before anything moves. A Base
// swap + transfer costs well under this; it only has to be "not empty".
export const MIN_BANKR_GAS = { base: '0.00005', arbitrum: '0.00005', polygon: '0.05', mainnet: '0.003' };
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

/** "1.5" → 1500000n at 6 decimals. Extra fractional digits are truncated, never rounded up. */
export function parseUnits(amount, decimals) {
  const m = String(amount ?? '').trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) return 0n;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt((m[1] || '0') + frac);
}

/** Asset entry for `token` in a connect_drop_balance response. */
function connectAsset(balance, token) {
  const native = isNativeToken(token);
  return (balance?.assets ?? []).find((x) => native
    ? x.type === 'native'
    : String(x.tokenContract ?? '').toLowerCase() === String(token).toLowerCase());
}

export function connectBalanceOf(balance, token) {
  return BigInt(connectAsset(balance, token)?.balanceInWei ?? '0');
}

/** Balance of `token` in a Bankr /wallet/portfolio response, as a decimal string. */
export function bankrBalanceOf(portfolio, chain, token) {
  const c = portfolio?.balances?.[chain];
  if (!c) return '0';
  if (isNativeToken(token)) return String(c.nativeBalance ?? '0');
  const t = (c.tokenBalances ?? []).find((x) => String(x?.token?.baseToken?.address ?? '').toLowerCase() === String(token).toLowerCase());
  return String(t?.token?.balance ?? '0');
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

async function bankrPortfolio(chain, apiKey, { fetchImpl, baseUrl }) {
  // showLowValueTokens: without it, anything under $1 (e.g. a 0.10 USDC test) is hidden.
  const res = await fetchImpl(`${baseUrl}/wallet/portfolio?chains=${encodeURIComponent(chain)}&showLowValueTokens=true`, {
    headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Bankr portfolio HTTP ${res.status}: ${String(json.error ?? json.message ?? '').slice(0, 200)}`);
  return json;
}

const errText = (r) => String(r.json?.error ?? r.json?.message ?? `HTTP ${r.status}`).slice(0, 300);

/**
 * @param input { sellToken, buyToken, sellAmount, chain?, recipients?, source?: 'connect'|'bankr', slippageBps? }
 * @param deps  { bankrKey, getConnectBalance(chainId), drop({recipients, amountInWeiPerRecipient, chainId, tokenContract}),
 *                resolveRecipients(list), explorerUrl(chainId, hash), uuid(), minGas? }
 */
export async function bankrSwapAndDrop(input, deps, {
  fetchImpl = fetch, baseUrl = BANKR_BASE_URL, pollMs = 4000, arrivalTimeoutMs = 120_000,
  now = () => Date.now(), wait = sleep,
} = {}) {
  const {
    bankrKey, getConnectBalance, drop,
    resolveRecipients = async (r) => ({ recipients: r }),
    explorerUrl = () => null, uuid = () => crypto.randomUUID(),
  } = deps;
  const chain = String(input.chain ?? 'base').toLowerCase();
  const chainId = BANKR_CHAINS[chain];
  const source = String(input.source ?? 'connect').toLowerCase();
  const steps = [];
  const explorerUrls = [];
  const done = (status, message, extra = {}) => ({ status, message, steps, explorerUrls, ...extra });
  const note = (step, ok, detail, hash) => {
    const url = hash ? explorerUrl(chainId, hash) : null;
    if (url) explorerUrls.push(url);
    steps.push({ step, ok, ...(detail ? { detail } : {}), ...(hash ? { hash } : {}), ...(url ? { explorerUrl: url } : {}) });
  };
  const http = { fetchImpl, baseUrl, timeoutMs: 30_000 };

  // ── Validate before touching anything ──
  if (!chainId) return done('refused', `Unsupported chain "${chain}". Use one of: ${Object.keys(BANKR_CHAINS).join(', ')}.`);
  if (!['connect', 'bankr'].includes(source)) return done('refused', 'source must be "connect" or "bankr".');
  const sellNative = isNativeToken(input.sellToken);
  const buyNative = isNativeToken(input.buyToken);
  if (!sellNative && !EVM_ADDR_RE.test(input.sellToken ?? '')) return done('refused', 'sellToken must be a contract address or "native".');
  if (!buyNative && !EVM_ADDR_RE.test(input.buyToken ?? '')) return done('refused', 'buyToken must be a contract address or "native".');
  if (sellNative === buyNative && (sellNative || input.sellToken.toLowerCase() === input.buyToken.toLowerCase())) return done('refused', 'sellToken and buyToken are the same.');
  if (!/^\d+(\.\d+)?$/.test(String(input.sellAmount ?? '')) || Number(input.sellAmount) <= 0) return done('refused', 'sellAmount must be a positive decimal number, e.g. "5".');
  const recipients = Array.isArray(input.recipients) ? input.recipients : [];
  if (!bankrKey) return done('refused', 'No Bankr key linked.');
  const sellToken = sellNative ? NATIVE_SENTINEL : input.sellToken;
  const buyToken = buyNative ? NATIVE_SENTINEL : input.buyToken;
  const nativeSym = NATIVE_SYMBOL[chain];

  // ── 0. Recipients → wallets ──
  let payees = [];
  if (recipients.length) {
    try {
      const res = await resolveRecipients(recipients);
      if (res.error) return done('refused', `${res.error} Nothing was moved.`, { stage: 'recipients', failedRecipients: res.failed });
      payees = res.recipients;
    } catch (err) {
      return done('failed', `Could not resolve recipients, nothing was moved: ${err.message}`, { stage: 'recipients' });
    }
    note('recipients_resolved', true, `${payees.length} wallet${payees.length === 1 ? '' : 's'}`);
  }

  // ── 1. Read both wallets; preflight ──
  let cBal, connectAddress, bPort, bankrAddress;
  try {
    cBal = await getConnectBalance(chainId);
    connectAddress = cBal?.walletAddress;
    if (!EVM_ADDR_RE.test(connectAddress ?? '')) throw new Error('no Smart Send wallet address in the balance response');
  } catch (err) {
    return done('failed', `Could not read the Connect wallet, nothing was moved: ${err.message}`, { stage: 'preflight' });
  }
  try {
    bPort = await bankrPortfolio(chain, bankrKey, http);
    bankrAddress = bPort?.evmAddress;
    if (!EVM_ADDR_RE.test(bankrAddress ?? '')) throw new Error('no EVM address in the portfolio response');
  } catch (err) {
    return done('failed', `Could not read the Bankr wallet, nothing was moved: ${err.message}`, { stage: 'preflight' });
  }

  const minGas = parseUnits(deps.minGas?.[chain] ?? MIN_BANKR_GAS[chain], 18);
  const bankrNative = parseUnits(bankrBalanceOf(bPort, chain, 'native'), 18);
  if (bankrNative < minGas) {
    return done('refused',
      `Your Bankr wallet has ${formatUnits(bankrNative, 18)} ${nativeSym} on ${chain}, which isn't enough for gas. ` +
      `Add at least ${formatUnits(minGas, 18)} ${nativeSym} on ${chain} to ${bankrAddress}, then ask again. Nothing was moved.`,
      { stage: 'gas', bankrAddress });
  }

  let sellDecimals, sellRaw;
  const cSell = connectAsset(cBal, sellToken);
  if (source === 'connect') {
    if (!cSell) return done('refused', `Your Connect wallet (${connectAddress}) has none of that token on ${chain}. Nothing was moved.`, { stage: 'funds' });
    sellDecimals = Number(cSell.decimals);
    sellRaw = parseUnits(input.sellAmount, sellDecimals);
    if (sellRaw <= 0n) return done('refused', 'sellAmount rounds to zero for this token.');
    const have = BigInt(cSell.balanceInWei ?? '0');
    if (have < sellRaw) {
      return done('refused', `Your Connect wallet has ${formatUnits(have, sellDecimals)} ${cSell.symbol ?? ''}, less than ${input.sellAmount}. Nothing was moved.`.replace(/\s+/g, ' '), { stage: 'funds' });
    }
    if (!sellNative && connectBalanceOf(cBal, 'native') === 0n) {
      return done('refused', `Your Connect wallet has no ${nativeSym} on ${chain} for gas. Nothing was moved.`, { stage: 'funds' });
    }
  }
  note('preflight', true, `Connect ${connectAddress}, Bankr ${bankrAddress}, Bankr gas ${formatUnits(bankrNative, 18)} ${nativeSym}`);
  const buyBefore = connectBalanceOf(cBal, buyToken);

  // Where the sell funds are, for every message after step 2.
  let where = source === 'connect' ? 'in your Connect wallet' : 'in your Bankr wallet';

  // ── 2–3. Connect → Bankr ──
  if (source === 'connect') {
    const bankrSellBefore = parseUnits(bankrBalanceOf(bPort, chain, sellToken), sellDecimals);
    let moved;
    try {
      moved = await drop({ recipients: [{ type: 'wallet', id: bankrAddress }], amountInWeiPerRecipient: sellRaw.toString(), chainId, tokenContract: sellNative ? null : sellToken });
    } catch (err) {
      return done('unknown', `Sending ${input.sellAmount} to your Bankr wallet failed or timed out (${err.message.slice(0, 200)}). It may still land — check both wallets before asking again. Nothing was swapped.`, { stage: 'fund_bankr' });
    }
    if (!moved?.transferHash) {
      return done('failed', `Couldn't send ${input.sellAmount} to your Bankr wallet: ${String(moved?.error ?? moved?.message ?? 'no transfer hash').slice(0, 200)}. The funds should still be in Connect.`, { stage: 'fund_bankr' });
    }
    if (moved.explorerUrl) explorerUrls.push(moved.explorerUrl);
    steps.push({ step: 'connect_to_bankr', ok: true, hash: moved.transferHash, ...(moved.explorerUrl ? { explorerUrl: moved.explorerUrl } : {}) });
    where = 'on its way to (or already in) your Bankr wallet';

    const target = bankrSellBefore + sellRaw;
    const started = now();
    let seen = bankrSellBefore;
    while (seen < target) {
      if (now() - started > arrivalTimeoutMs) {
        return done('partial', `Sent ${input.sellAmount} to your Bankr wallet, but Bankr hasn't shown it yet, so nothing was swapped. It's ${where}. Check the Bankr wallet before asking again.`, { stage: 'bankr_arrival' });
      }
      await wait(pollMs);
      try { seen = parseUnits(bankrBalanceOf(await bankrPortfolio(chain, bankrKey, http), chain, sellToken), sellDecimals); } catch { /* keep waiting */ }
    }
    where = 'in your Bankr wallet (not swapped)';
    note('arrived_in_bankr', true);
  }

  // ── 4. Quote + swap ──
  const legs = { fromChain: chain, toChain: chain, fromToken: sellToken, toToken: buyToken, amount: String(input.sellAmount) };
  const slip = input.slippageBps ? { slippageBps: input.slippageBps } : {};
  const q = await bankrPost('/wallet/swap-quote', { ...legs, ...slip }, bankrKey, http).catch((err) => ({ ok: false, status: 0, json: { error: err.message } }));
  if (!q.ok || !q.json?.minBuyAmount) return done(source === 'connect' ? 'partial' : 'failed', `Bankr quote failed, nothing was swapped: ${errText(q)}. The ${input.sellAmount} is ${where}.`, { stage: 'quote' });
  const quote = q.json;
  const decimals = Number(quote.to?.decimals);
  const symbol = quote.to?.symbol ?? 'tokens';
  const sellSym = quote.from?.symbol ?? cSell?.symbol ?? '';

  if (source === 'bankr') {
    const d = Number(quote.from?.decimals);
    const have = Number.isInteger(d) ? parseUnits(bankrBalanceOf(bPort, chain, sellToken), d) : null;
    if (have !== null && have < parseUnits(input.sellAmount, d)) {
      return done('refused', `Your Bankr wallet has ${formatUnits(have, d)} ${sellSym}, less than ${input.sellAmount}. Nothing was moved.`, { stage: 'funds' });
    }
  }
  note('quote', true, `${input.sellAmount} ${sellSym} → ≥${quote.minBuyAmount} ${symbol}`);

  let swap;
  try {
    swap = await bankrPost('/wallet/swap', {
      ...legs, ...slip, minBuyAmount: quote.minBuyAmount,
      ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
      idempotencyKey: uuid(),
    }, bankrKey, { ...http, timeoutMs: 90_000 });
  } catch (err) {
    return done('unknown', `The swap request timed out (${err.message}). It may have executed — check the Bankr wallet before asking again.`, { stage: 'swap' });
  }
  if (swap.status === 502 || swap.status === 504) {
    return done('unknown', `Bankr says the swap may be on-chain but unconfirmed (${errText(swap)}). Check the Bankr wallet before asking again.`, { stage: 'swap' });
  }
  if (!swap.ok) return done(source === 'connect' ? 'partial' : 'failed', `Bankr refused the swap: ${errText(swap)}. The ${input.sellAmount} ${sellSym} is ${where}.`, { stage: 'swap' });
  if (!swap.json.success) {
    note('swap', false, 'reverted on-chain (gas was spent, no tokens exchanged)', swap.json.hash);
    return done(source === 'connect' ? 'partial' : 'failed', `The swap reverted on-chain; no tokens were exchanged. The ${input.sellAmount} ${sellSym} is ${where}.`, { stage: 'swap' });
  }
  const receivedRaw = BigInt(swap.json.amountReceivedRaw ?? '0');
  if (receivedRaw <= 0n || !Number.isInteger(decimals)) {
    note('swap', true, 'filled, but the received amount was not reported', swap.json.hash);
    return done('partial', `The swap filled but Bankr did not report how much ${symbol} came back, so nothing was moved to Connect. The ${symbol} is in your Bankr wallet.`, { stage: 'swap' });
  }
  const receivedHuman = formatUnits(receivedRaw, decimals);
  note('swap', true, `received ${receivedHuman} ${symbol}`, swap.json.hash);

  // ── 5. Bankr → Connect ──
  let xfer;
  try {
    xfer = await bankrPost('/wallet/transfer', {
      tokenAddress: buyNative ? '0x0000000000000000000000000000000000000000' : buyToken,
      recipientAddress: connectAddress, amount: receivedHuman, isNativeToken: buyNative, chain,
    }, bankrKey, { ...http, timeoutMs: 90_000 });
  } catch (err) {
    return done('unknown', `Swap done, but the transfer back to Connect timed out (${err.message}) and may or may not have gone out. ${receivedHuman} ${symbol} is in your Bankr wallet or on its way to ${connectAddress}. Check both wallets before asking again.`, { stage: 'transfer' });
  }
  if (!xfer.ok || !xfer.json?.success) {
    return done('partial', `Swap done, but moving it back to Connect failed: ${errText(xfer)}. ${receivedHuman} ${symbol} is in your Bankr wallet.`, { stage: 'transfer' });
  }
  note('bankr_to_connect', true, `${receivedHuman} ${symbol} → ${connectAddress}`, xfer.json.txHash);

  // ── 6. Wait for Connect ──
  const target = buyBefore + receivedRaw;
  const started = now();
  let seen = buyBefore;
  while (seen < target) {
    if (now() - started > arrivalTimeoutMs) {
      return done('partial', `Swapped and sent back, but Connect hasn't shown the ${symbol} yet${payees.length ? ', so nothing was sent to recipients' : ''}. It's in (or about to reach) your Connect wallet.`, { stage: 'connect_arrival', received: receivedHuman, symbol, chainId });
    }
    await wait(pollMs);
    try { seen = connectBalanceOf(await getConnectBalance(chainId), buyToken); } catch { /* keep waiting */ }
  }
  note('arrived_in_connect', true);

  const swapped = `Swapped ${input.sellAmount} ${sellSym} for ${receivedHuman} ${symbol}`.replace(/\s+/g, ' ');
  if (!payees.length) {
    return done('completed', `${swapped}. It's in your Connect wallet, ready to send.`, { received: receivedHuman, symbol, tokenContract: buyNative ? null : buyToken, chainId });
  }

  // ── 7. Drop ──
  const per = receivedRaw / BigInt(payees.length);
  if (per <= 0n) return done('partial', `${swapped}, but that's too little to split across ${payees.length} people. It's in your Connect wallet.`, { stage: 'drop' });
  let dropped;
  try {
    dropped = await drop({ recipients: payees, amountInWeiPerRecipient: per.toString(), chainId, tokenContract: buyNative ? null : buyToken });
  } catch (err) {
    return done('unknown', `${swapped} and moved it to Connect; the send failed or timed out (${err.message.slice(0, 200)}). It may still land — check your Connect wallet before asking again.`, { stage: 'drop' });
  }
  if (!dropped?.transferHash) {
    return done('partial', `${swapped} and moved it to Connect; the send did not go through (${String(dropped?.error ?? dropped?.message ?? 'no transfer hash').slice(0, 200)}). The ${symbol} is in your Connect wallet.`, { stage: 'drop', dropResult: dropped });
  }
  if (dropped.explorerUrl) explorerUrls.push(dropped.explorerUrl);
  steps.push({ step: 'drop', ok: true, hash: dropped.transferHash, ...(dropped.explorerUrl ? { explorerUrl: dropped.explorerUrl } : {}) });
  return done('completed',
    `${swapped} and sent ${formatUnits(per, decimals)} ${symbol} each to ${payees.length} recipient${payees.length === 1 ? '' : 's'}.`,
    { received: receivedHuman, perRecipient: formatUnits(per, decimals), symbol, dropResult: dropped });
}
