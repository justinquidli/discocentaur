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

import { bankrSwapAndDrop, formatUnits, connectBalanceOf } from '../bankr.js';

const HOME = '0xb9a1e52f3ed678b01ff5e256fde43f26f9c01ba3';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CONNECT = '0x02d592CC297ae3b3945F7dCDb0BeD447F0F87d17';
const bal = (raw) => ({ walletAddress: CONNECT, assets: [{ type: 'erc20', tokenContract: HOME, balanceInWei: raw }] });
const quoteOk = () => ({ body: { from: { symbol: 'USDC' }, to: { symbol: 'HOME', decimals: 18 }, minBuyAmount: '40000', quoteId: 'q1' } });
const input = { sellToken: USDC, buyToken: HOME, sellAmount: '1', recipients: [{ type: 'telegram', id: '1' }, { type: 'telegram', id: '2' }, { type: 'telegram', id: '3' }] };

function harness({ swap, transfer, balances, dropResult }) {
  let i = 0;
  const drops = [];
  const f = fakeFetch([
    [/swap-quote$/, quoteOk],
    [/\/wallet\/swap$/, swap ?? (() => ({ body: { success: true, hash: '0xs', amountReceivedRaw: '46120466500000000000000' } }))],
    [/\/wallet\/transfer$/, transfer ?? (() => ({ body: { success: true, txHash: '0xt' } }))],
  ]);
  const deps = {
    bankrKey: 'k', uuid: () => 'u',
    getConnectBalance: async () => bal(balances[Math.min(i++, balances.length - 1)]),
    drop: async (a) => { drops.push(a); return dropResult ?? { transferHash: '0xd', explorerUrl: 'https://basescan.org/tx/0xd' }; },
    explorerUrl: (c, h) => `https://basescan.org/tx/${h}`,
  };
  return { f, deps, drops };
}

test('swap → transfer → wait → drop splits exactly what was received', async () => {
  const h = harness({ balances: ['100', '100', '46120466500000000000100'] });
  const r = await bankrSwapAndDrop(input, h.deps, { fetchImpl: h.f, wait: noWait });
  assert.equal(r.status, 'completed', r.message);
  const xfer = JSON.parse(h.f.calls.find((c) => /transfer$/.test(c.url)).opts.body);
  assert.equal(xfer.amount, '46120.4665');
  assert.equal(xfer.recipientAddress, CONNECT);
  const sw = JSON.parse(h.f.calls.find((c) => /\/wallet\/swap$/.test(c.url)).opts.body);
  assert.equal(sw.minBuyAmount, '40000');
  assert.equal(sw.idempotencyKey, 'u');
  assert.equal(h.drops.length, 1);
  assert.equal(h.drops[0].amountInWeiPerRecipient, (46120466500000000000000n / 3n).toString());
  assert.equal(h.drops[0].tokenContract, HOME);
  assert.deepEqual(r.explorerUrls, ['https://basescan.org/tx/0xs', 'https://basescan.org/tx/0xt', 'https://basescan.org/tx/0xd']);
});

test('reverted swap stops before transfer', async () => {
  const h = harness({ balances: ['0'], swap: () => ({ body: { success: false, hash: '0xr' } }) });
  const r = await bankrSwapAndDrop(input, h.deps, { fetchImpl: h.f, wait: noWait });
  assert.equal(r.status, 'failed');
  assert.ok(!h.f.calls.some((c) => /transfer$/.test(c.url)));
  assert.equal(h.drops.length, 0);
});

test('504 on swap is unknown and never retried', async () => {
  const h = harness({ balances: ['0'], swap: () => ({ status: 504, body: { error: 'slow' } }) });
  const r = await bankrSwapAndDrop(input, h.deps, { fetchImpl: h.f, wait: noWait });
  assert.equal(r.status, 'unknown');
  assert.equal(h.f.calls.filter((c) => /\/wallet\/swap$/.test(c.url)).length, 1);
  assert.ok(!h.f.calls.some((c) => /transfer$/.test(c.url)));
});

test('failed transfer leaves funds in Bankr and does not drop', async () => {
  const h = harness({ balances: ['0'], transfer: () => ({ status: 403, body: { error: 'read only' } }) });
  const r = await bankrSwapAndDrop(input, h.deps, { fetchImpl: h.f, wait: noWait });
  assert.equal(r.status, 'partial');
  assert.match(r.message, /Bankr wallet/);
  assert.equal(h.drops.length, 0);
});

test('funds not arriving in Connect → no drop', async () => {
  let t = 0;
  const h = harness({ balances: ['0'] });
  const r = await bankrSwapAndDrop(input, h.deps, { fetchImpl: h.f, wait: noWait, now: () => (t += 10_000), arrivalTimeoutMs: 30_000 });
  assert.equal(r.status, 'partial');
  assert.equal(r.stage, 'arrival');
  assert.equal(h.drops.length, 0);
});

test('bad inputs are refused before any request', async () => {
  const h = harness({ balances: ['0'] });
  for (const bad of [{ buyToken: 'HOME' }, { sellAmount: '-1' }, { recipients: [] }, { chain: 'solana' }]) {
    const r = await bankrSwapAndDrop({ ...input, ...bad }, h.deps, { fetchImpl: h.f, wait: noWait });
    assert.equal(r.status, 'refused', JSON.stringify(bad));
  }
  assert.equal(h.f.calls.length, 0);
});

test('unresolvable recipient stops before any Bankr call', async () => {
  const h = harness({ balances: ['0'] });
  h.deps.resolveRecipients = async () => ({ error: 'Could not resolve a wallet for: telegram:3.', failed: ['telegram:3'] });
  const r = await bankrSwapAndDrop(input, h.deps, { fetchImpl: h.f, wait: noWait });
  assert.equal(r.status, 'refused');
  assert.equal(h.f.calls.length, 0);
  assert.equal(h.drops.length, 0);
});

test('drop receives the resolved wallets, not the social handles', async () => {
  const W = '0x503a04D04E00d9b0C0898e2D7A16B857BE6cdAF0';
  const h = harness({ balances: ['0', '46120466500000000000000'] });
  h.deps.resolveRecipients = async (list) => ({ recipients: list.map(() => ({ type: 'wallet', id: W })) });
  const r = await bankrSwapAndDrop(input, h.deps, { fetchImpl: h.f, wait: noWait });
  assert.equal(r.status, 'completed', r.message);
  assert.deepEqual(h.drops[0].recipients[0], { type: 'wallet', id: W });
});

test('native buy uses the sentinel for Bankr and null for Connect', async () => {
  const h = harness({ balances: ['0', '5'], swap: () => ({ body: { success: true, hash: '0xs', amountReceivedRaw: '6' } }) });
  h.deps.getConnectBalance = (() => { let n = 0; return async () => ({ walletAddress: CONNECT, assets: n++ ? [{ type: 'native', balanceInWei: '6' }] : [] }); })();
  const r = await bankrSwapAndDrop({ ...input, buyToken: 'native', recipients: input.recipients.slice(0, 2) }, h.deps, { fetchImpl: h.f, wait: noWait });
  assert.equal(r.status, 'completed', r.message);
  assert.equal(JSON.parse(h.f.calls[0].opts.body).toToken, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal(JSON.parse(h.f.calls.find((c) => /transfer$/.test(c.url)).opts.body).isNativeToken, true);
  assert.equal(h.drops[0].tokenContract, null);
  assert.equal(h.drops[0].amountInWeiPerRecipient, '3');
});

test('formatUnits / connectBalanceOf', () => {
  assert.equal(formatUnits(1500000n, 6), '1.5');
  assert.equal(formatUnits(5n, 6), '0.000005');
  assert.equal(formatUnits(0n, 6), '0');
  assert.equal(connectBalanceOf(bal('7'), HOME.toUpperCase().replace('0X', '0x')), 7n);
  assert.equal(connectBalanceOf(bal('7'), USDC), 0n);
});
