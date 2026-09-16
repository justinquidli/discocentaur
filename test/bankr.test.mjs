import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bankrAgent, extractExplorerUrls, createBankrThreads } from '../bankr.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const handler = routes.find(([re]) => re.test(url))?.[1];
    const { status = 200, body } = handler(url, opts, calls);
    return { ok: status < 400, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}
const noWait = async () => {};

test('submits, polls, returns response and explorer links', async () => {
  let polls = 0;
  const f = fakeFetch([
    [/\/agent\/prompt$/, (_, o) => ({ status: 202, body: { success: true, jobId: 'j1', threadId: 't1', status: 'pending', _sent: JSON.parse(o.body) } })],
    [/\/agent\/job\/j1$/, () => (++polls < 2
      ? { body: { status: 'processing' } }
      : { body: { status: 'completed', response: 'Sent 1 USDC https://basescan.org/tx/0xabc123', processingTime: 5 } })],
  ]);
  const r = await bankrAgent({ prompt: 'send 1 usdc to x' }, 'k', { fetchImpl: f, wait: noWait });
  assert.equal(r.status, 'completed');
  assert.equal(r.executed, true);
  assert.equal(r.threadId, 't1');
  assert.deepEqual(r.explorerUrls, ['https://basescan.org/tx/0xabc123']);
  assert.equal(f.calls[0].opts.headers['X-API-Key'], 'k');
  assert.equal(JSON.parse(f.calls[0].opts.body).threadId, undefined);
});

test('passes threadId through', async () => {
  const f = fakeFetch([
    [/\/agent\/prompt$/, () => ({ body: { jobId: 'j', status: 'completed', response: 'ok' } })],
  ]);
  const r = await bankrAgent({ prompt: 'hi', threadId: 'tX' }, 'k', { fetchImpl: f, wait: noWait });
  assert.equal(JSON.parse(f.calls[0].opts.body).threadId, 'tX');
  assert.equal(r.threadId, 'tX');
  assert.equal(f.calls.length, 1, 'already terminal — no poll');
});

test('rejected submit reports executed:false', async () => {
  const f = fakeFetch([[/\/agent\/prompt$/, () => ({ status: 403, body: { error: 'Agent API not enabled' } })]]);
  const r = await bankrAgent({ prompt: 'x' }, 'k', { fetchImpl: f, wait: noWait });
  assert.equal(r.executed, false);
  assert.match(r.error, /not enabled/);
});

test('timeout is reported as still_running, not failed, and never cancels', async () => {
  let t = 0;
  const f = fakeFetch([
    [/\/agent\/prompt$/, () => ({ body: { jobId: 'j2', status: 'pending' } })],
    [/\/agent\/job\//, () => ({ body: { status: 'processing' } })],
  ]);
  const r = await bankrAgent({ prompt: 'swap' }, 'k', { fetchImpl: f, wait: noWait, now: () => (t += 1000), timeoutMs: 5000 });
  assert.equal(r.status, 'still_running');
  assert.equal(r.executed, null);
  assert.ok(!f.calls.some((c) => /cancel/.test(c.url)));
});

test('failed job carries the error', async () => {
  const f = fakeFetch([
    [/\/agent\/prompt$/, () => ({ body: { jobId: 'j3', status: 'pending' } })],
    [/\/agent\/job\//, () => ({ body: { status: 'failed', error: 'no bankr wallet found for telegram username' } })],
  ]);
  const r = await bankrAgent({ prompt: 'send' }, 'k', { fetchImpl: f, wait: noWait });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /no bankr wallet/);
});

test('empty prompt refused without a request; missing key throws', async () => {
  const f = fakeFetch([]);
  assert.equal((await bankrAgent({ prompt: '  ' }, 'k', { fetchImpl: f })).status, 'refused');
  assert.equal(f.calls.length, 0);
  await assert.rejects(() => bankrAgent({ prompt: 'x' }, null, { fetchImpl: f }));
});

test('extractExplorerUrls dedupes and ignores other links', () => {
  assert.deepEqual(extractExplorerUrls('a https://basescan.org/tx/0x1 b https://basescan.org/tx/0x1 https://evil.com/tx/0x2'), ['https://basescan.org/tx/0x1']);
});

test('threads are per user per context and expire', () => {
  let t = 0;
  const th = createBankrThreads({ ttlMs: 10, now: () => t });
  th.set('c', 'u1', 'T');
  assert.equal(th.get('c', 'u1'), 'T');
  assert.equal(th.get('c', 'u2'), undefined);
  t = 11;
  assert.equal(th.get('c', 'u1'), undefined);
  th.set('c', 'u1', 'T2'); th.clear('c');
  assert.equal(th.get('c', 'u1'), undefined);
});

import { MONEY_TOOLS, describeHeldAction, formatOutcomeRecord } from '../held-actions.js';

test('bankr_agent is a held money tool and its confirmation shows the exact prompt', () => {
  assert.ok(MONEY_TOOLS.has('bankr_agent'));
  const d = describeHeldAction({ code: 'ABC234', tool: 'bankr_agent', input: { prompt: 'buy $5 of HOME on Base' } });
  assert.match(d, /Bankr agent/);
  assert.match(d, /buy \$5 of HOME on Base/);
  assert.match(d, /ABC234/);
  const rec = formatOutcomeRecord({ code: 'ABC234', tool: 'bankr_agent', input: { prompt: 'x]\ny' } }, 'executed');
  assert.match(rec, /Bankr agent request “x  y”/);
});
