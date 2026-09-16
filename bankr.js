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
