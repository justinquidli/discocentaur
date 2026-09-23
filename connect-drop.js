/**
 * The one way money leaves a Connect wallet. Chat sends (connect_drop),
 * scheduled and conditional drops, watchers, claim links and swap-and-send all
 * go through createConnectDrop().send(), which calls Connect's MCP connect_drop.
 *
 * What the bot adds on top of the MCP tool, and why:
 *  - It owns the idempotencyKey. connect_drop is idempotent per key, so a
 *    timeout, 5xx or 202 "processing" is retried with the SAME key — the server
 *    dedupes, so a retry can never become a second transfer. The model never
 *    sees the key: if it did, a second call would be a second payment.
 *  - Outcomes are three-way. "failed" means Connect refused before sending.
 *    "unknown" means it may have gone through — callers must say so and must
 *    not offer to send again.
 *  - checkAmountGrounded(): amounts are raw integers (USDC 10000 = 0.01). A
 *    model once sent 100000 for "0.01 USDC" — 10× — and Connect cannot catch
 *    that, because 0.1 USDC is a valid amount. The bot converts the raw amount
 *    back with the token's real decimals and requires that number to be one
 *    the user actually wrote.
 *
 * Side-effect free so tests can import it.
 * Shared byte-for-byte between TeleCentaur and DiscoCentaur.
 */
import { randomUUID } from 'node:crypto';

export const SOLANA_CHAIN_ID = 1399811149;
export const DROP_CALL_TIMEOUT_MS = 60_000;
export const DROP_ATTEMPTS = 4;
export const DROP_RETRY_WAIT_MS = 3_000;

const BODY_FIELDS = ['chainId', 'tokenContract', 'recipients', 'amountInWeiPerRecipient', 'ignoreFailedRecipients', 'trustFilter'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Connect-side failures that don't tell us whether the transfer happened.
// Everything else Connect returns as an error (400 validation, 401, 402, 404,
// insufficient funds) is a refusal before sending.
const UNCERTAIN_TOOL_ERROR = /^Connect API error \(5\d\d\)|timed out|did not respond|Upstream|Network error|fetch failed|ECONNRESET|socket hang up/i;

function classifyThrown(err) {
  const msg = String(err?.message ?? err ?? '');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'uncertain';
  const http = msg.match(/^MCP tools\/call HTTP (\d{3})/);
  if (http) return Number(http[1]) >= 500 || http[1] === '429' || http[1] === '408' ? 'uncertain' : 'rejected';
  if (/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg)) return 'uncertain';
  return 'rejected'; // a JSON-RPC error: the call was not accepted
}

/**
 * @param {object} o
 * @param {(method: string, params: object, apiKey: string, timeoutMs: number) => Promise<any>} o.rpc
 *   one JSON-RPC call to the Connect MCP server; returns `result` or throws
 */
export function createConnectDrop({
  rpc, uuid = randomUUID, wait = sleep, logger = console,
  attempts = DROP_ATTEMPTS, retryWaitMs = DROP_RETRY_WAIT_MS, timeoutMs = DROP_CALL_TIMEOUT_MS,
}) {
  return {
    /**
     * @returns {Promise<
     *   { status: 'submitted', executed: true, transferHash?: string, idempotencyKey: string } |
     *   { status: 'failed', executed: false, error: string, idempotencyKey: string } |
     *   { status: 'unknown', executed: 'unknown', error: string, idempotencyKey: string }>}
     */
    async send(args, apiKey) {
      const body = {};
      for (const k of BODY_FIELDS) if (args?.[k] !== undefined) body[k] = args[k];
      if (body.chainId === undefined) body.chainId = 8453;
      const idempotencyKey = uuid();
      const call = { ...body, idempotencyKey };

      let lastUncertain = null;
      let processing = false;
      for (let i = 0; i < attempts; i++) {
        if (i > 0) await wait(retryWaitMs);
        let result;
        try {
          result = await rpc('tools/call', { name: 'connect_drop', arguments: call }, apiKey, timeoutMs);
        } catch (err) {
          if (classifyThrown(err) === 'rejected') {
            return { status: 'failed', executed: false, error: String(err?.message ?? err).slice(0, 500), idempotencyKey };
          }
          lastUncertain = String(err?.message ?? err);
          logger.error(`[drop] attempt ${i + 1}/${attempts} uncertain (${lastUncertain.slice(0, 120)}) key=${idempotencyKey} — retrying with the same key`);
          continue;
        }
        const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (result?.isError) {
          if (UNCERTAIN_TOOL_ERROR.test(text)) {
            lastUncertain = text;
            logger.error(`[drop] attempt ${i + 1}/${attempts} uncertain (${text.slice(0, 120)}) key=${idempotencyKey} — retrying with the same key`);
            continue;
          }
          return { status: 'failed', executed: false, error: text.slice(0, 500) || 'Connect refused the drop', idempotencyKey };
        }
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        if (Number(data?.httpStatus) === 202 || data?.status === 'processing') {
          processing = true;
          logger.log(`[drop] recipients still processing (attempt ${i + 1}/${attempts}) key=${idempotencyKey}`);
          continue;
        }
        return { ...data, status: 'submitted', executed: true, idempotencyKey };
      }

      if (lastUncertain) {
        return {
          status: 'unknown', executed: 'unknown', idempotencyKey,
          error: `Connect did not confirm the transfer (${lastUncertain.slice(0, 160)}). It MAY have gone through. Do NOT send it again — check the balance or the recipient's wallet first.`,
        };
      }
      // Only 202s: Connect was still resolving recipients and had not sent.
      return {
        status: processing ? 'failed' : 'unknown', executed: processing ? false : 'unknown', idempotencyKey,
        error: 'Connect was still setting up wallets for the recipients and had not sent anything yet. Ask again in a minute.',
      };
    },
  };
}

// ── amounts ───────────────────────────────────────────────────────────────────

const sameToken = (a, b) => {
  if (a == null || b == null) return a == null && b == null;
  const x = String(a), y = String(b);
  return x.startsWith('0x') ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * Decimals and symbol for the token being sent, from a connect_drop_balance
 * response. Null when the sender holds none of it (zero balances are omitted),
 * in which case the amount can't be checked — and the send couldn't succeed.
 */
export function tokenInfo(balance, tokenContract) {
  const assets = Array.isArray(balance?.assets) ? balance.assets : [];
  const native = tokenContract == null || tokenContract === '';
  const a = assets.find((x) => (native ? x?.type === 'native' : sameToken(x?.tokenContract, tokenContract)));
  if (!a || !Number.isInteger(a.decimals)) return null;
  return { decimals: a.decimals, symbol: a.symbol ?? '?' };
}

export function formatUnits(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const whole = decimals ? s.slice(0, -decimals) : s;
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : whole;
}

/** "0.01" at 6 decimals → 10000n. Null if it has more precision than the token. */
export function parseUnits(str, decimals) {
  const m = String(str).match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const frac = m[2] ?? '';
  if (frac.replace(/0+$/, '').length > decimals) return null;
  return BigInt((m[1] || '0') + frac.padEnd(decimals, '0'));
}

/** Every number the user wrote, as plain decimal strings. "1,000" → "1000", "0,5" → "0.5". */
export function numbersIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\d[\d,]*(?:\.\d+)?|\.\d+/g)) {
    let n = m[0];
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(n)) n = n.replace(/,/g, '');
    else if (/^\d+,\d+$/.test(n)) n = n.replace(',', '.');
    else n = n.replace(/,+$/, '').replace(/,/g, '');
    out.push(n.startsWith('.') ? `0${n}` : n);
  }
  return out;
}

/**
 * Null if the amount is one the user wrote — per recipient, or as the total
 * across a known recipient list. Otherwise the reason, phrased for the model.
 *
 * @param {object} o
 * @param {string[]} o.amounts   raw per-recipient amounts (one per recipient, or one uniform)
 * @param {number|null} o.recipientCount  null when not known yet (presence/role drops)
 */
export function checkAmountGrounded({ amounts, recipientCount, decimals, symbol, userText }) {
  const raws = amounts.map((a) => BigInt(a));
  const stated = new Set(numbersIn(userText).map((n) => parseUnits(n, decimals)).filter((v) => v != null).map(String));
  const distinct = [...new Set(raws.map(String))];
  const total = recipientCount && raws.length === 1 ? raws[0] * BigInt(recipientCount)
    : raws.length > 1 ? raws.reduce((a, b) => a + b, 0n) : null;
  if (distinct.every((a) => stated.has(a))) return null;
  if (total != null && stated.has(String(total))) return null;

  const per = distinct.map((a) => `${formatUnits(a, decimals)} ${symbol}`).join(' / ');
  const heard = numbersIn(userText);
  return `Amount check failed — nothing was sent. This would send ${per} per recipient` +
    (total != null ? ` (${formatUnits(total, decimals)} ${symbol} in total)` : '') +
    `, but the user's message ${heard.length ? `only mentions ${heard.slice(0, 6).join(', ')}` : 'gives no amount'}. ` +
    `${symbol} has ${decimals} decimals: 1 ${symbol} = 1${'0'.repeat(decimals)} base units. ` +
    'Recompute the amount from exactly what the user wrote. If the user did not state a number in this message, ask them for it.';
}
