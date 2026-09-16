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

import { bankrSwapAndDrop, formatUnits, parseUnits, connectBalanceOf, bankrBalanceOf } from '../bankr.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HOME = '0xb9a1e52f3ed678b01ff5e256fde43f26f9c01ba3';
const CONNECT = '0x02d592CC297ae3b3945F7dCDb0BeD447F0F87d17';
const BANKR = '0x64a59e25a1104cdb60926f29e5bdbcfcbd156256';
const W1 = '0x503a04D04E00d9b0C0898e2D7A16B857BE6cdAF0';
const W2 = '0x6a48ADE3bE3F9f0b8B4c9af61Bb654A219311699';
const RECEIVED = 4612046650000000000000n; // 4612.04665 HOME

// A tiny two-wallet world. Balances only change when the fake APIs "execute",
// so every wait-for-arrival loop is tested against real state, not a script.
function world(o = {}) {
  const w = {
    connect: { usdc: 5_968_974n, eth: 1_521_837_516_182_189n, home: 0n, ...(o.connect ?? {}) },
    bankr: { usdc: '0', eth: '0.0003', home: '0', ...(o.bankr ?? {}) },
    calls: [], drops: [],
  };
  const lagBankr = o.lagBankr ?? 0; // portfolio reads that still show the old balance
  let bankrReads = 0;
  const fetchImpl = async (url, opts = {}) => {
    w.calls.push({ url, opts });
    const body = opts.body ? JSON.parse(opts.body) : null;
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (/\/wallet\/portfolio/.test(url)) {
      bankrReads++;
      const b = (o.freezeBankr || bankrReads <= lagBankr) ? w.bankrStart ?? w.bankr : w.bankr;
      return reply(200, { evmAddress: BANKR, balances: { base: { nativeBalance: b.eth, tokenBalances: [
        { token: { balance: b.usdc, baseToken: { address: USDC, symbol: 'USDC' } } },
        { token: { balance: b.home, baseToken: { address: HOME, symbol: 'HOME' } } },
      ] } } });
    }
    if (/swap-quote$/.test(url)) return reply(200, { from: { symbol: 'USDC', decimals: 6 }, to: { symbol: 'HOME', decimals: 18 }, minBuyAmount: '4000', quoteId: 'q1' });
    if (/\/wallet\/swap$/.test(url)) {
      if (o.swap) return reply(...o.swap);
      w.bankr.usdc = formatUnits(parseUnits(w.bankr.usdc, 6) - parseUnits(body.amount, 6), 6);
      w.bankr.home = formatUnits(parseUnits(w.bankr.home, 18) + RECEIVED, 18);
      return reply(200, { success: true, hash: '0xswap', amountReceivedRaw: RECEIVED.toString() });
    }
    if (/\/wallet\/transfer$/.test(url)) {
      if (o.transfer) return reply(...o.transfer);
      w.bankr.home = formatUnits(parseUnits(w.bankr.home, 18) - parseUnits(body.amount, 18), 18);
      if (!o.freezeConnect) w.connect.home += parseUnits(body.amount, 18);
      return reply(200, { success: true, txHash: '0xback' });
    }
    throw new Error(`unexpected ${url}`);
  };
  w.bankrStart = { ...w.bankr };
  const deps = {
    bankrKey: 'k', uuid: () => 'uuid-1',
    explorerUrl: (c, h) => `https://basescan.org/tx/${h}`,
    resolveRecipients: o.resolveRecipients ?? (async (list) => ({ recipients: list.map((_, i) => ({ type: 'wallet', id: [W1, W2][i] })) })),
    getConnectBalance: async () => ({ walletAddress: CONNECT, assets: [
      { type: 'native', tokenContract: null, symbol: 'ETH', decimals: 18, balanceInWei: w.connect.eth.toString() },
      { type: 'erc20', tokenContract: USDC, symbol: 'USDC', decimals: 6, balanceInWei: w.connect.usdc.toString() },
      ...(w.connect.home ? [{ type: 'erc20', tokenContract: HOME, symbol: 'HOME', decimals: 18, balanceInWei: w.connect.home.toString() }] : []),
    ] }),
    drop: async (a) => {
      w.drops.push(a);
      const toBankr = a.recipients.length === 1 && a.recipients[0].id === BANKR;
      if (toBankr && o.fundDrop) return o.fundDrop();
      if (!toBankr && o.payDrop) return o.payDrop();
      const amt = BigInt(a.amountInWeiPerRecipient) * BigInt(a.recipients.length);
      if (toBankr) {
        w.connect.usdc -= amt;
        if (!o.freezeBankr) w.bankr.usdc = formatUnits(parseUnits(w.bankr.usdc, 6) + amt, 6);
        return { transferHash: '0xfund', explorerUrl: 'https://basescan.org/tx/0xfund' };
      }
      w.connect.home -= amt;
      return { transferHash: '0xpay', explorerUrl: 'https://basescan.org/tx/0xpay' };
    },
  };
  const run = (input, opts = {}) => bankrSwapAndDrop(
    { sellToken: USDC, buyToken: HOME, sellAmount: '1', ...input }, deps,
    { fetchImpl, wait: async () => {}, ...opts });
  const hit = (re) => w.calls.filter((c) => re.test(c.url));
  return { w, deps, run, hit };
}
const TWO = [{ type: 'telegram', username: 'a' }, { type: 'discord', id: '2' }];
const clock = () => { let t = 0; return () => (t += 10_000); };

test('Connect → Bankr → swap → Connect → recipients, amounts read back at each step', async () => {
  const { w, run, hit } = world({ lagBankr: 2 });
  const r = await run({ recipients: TWO, sendAll: true });
  assert.equal(r.status, 'completed', r.message);
  assert.equal(w.drops.length, 2);
  assert.deepEqual(w.drops[0], { recipients: [{ type: 'wallet', id: BANKR }], amountInWeiPerRecipient: '1000000', chainId: 8453, tokenContract: USDC });
  assert.equal(JSON.parse(hit(/\/wallet\/swap$/)[0].opts.body).idempotencyKey, 'uuid-1');
  const back = JSON.parse(hit(/transfer$/)[0].opts.body);
  assert.deepEqual([back.recipientAddress, back.amount], [CONNECT, '4612.04665']);
  assert.deepEqual(w.drops[1].recipients, [{ type: 'wallet', id: W1 }, { type: 'wallet', id: W2 }]);
  assert.equal(w.drops[1].amountInWeiPerRecipient, (RECEIVED / 2n).toString());
  assert.equal(w.connect.usdc, 4_968_974n);
  assert.equal(w.connect.home, 0n);
  assert.deepEqual(r.explorerUrls, ['https://basescan.org/tx/0xfund', 'https://basescan.org/tx/0xswap', 'https://basescan.org/tx/0xback', 'https://basescan.org/tx/0xpay']);
  assert.ok(hit(/portfolio/).every((c) => /showLowValueTokens=true/.test(c.url)));
});

test('no recipients: swap lands back in Connect and waits there', async () => {
  const { w, run } = world();
  const r = await run({});
  assert.equal(r.status, 'completed', r.message);
  assert.match(r.message, /ready to send/);
  assert.equal(w.drops.length, 1, 'only the funding drop');
  assert.equal(w.connect.home, RECEIVED);
});

test('no gas in Bankr: stops before anything moves and says how much to add, and where', async () => {
  const { w, run, hit } = world({ bankr: { eth: '0' } });
  const r = await run({ recipients: TWO, sendAll: true });
  assert.equal(r.status, 'refused');
  assert.equal(r.stage, 'gas');
  assert.match(r.message, /Add at least 0\.00005 ETH on base to 0x64a59e25/);
  assert.match(r.message, /Nothing was moved/);
  assert.equal(w.drops.length, 0);
  assert.equal(hit(/swap|transfer/).length, 0);
});

test('source=bankr also requires gas', async () => {
  const { w, run } = world({ bankr: { eth: '0.00001', usdc: '5' } });
  const r = await run({ source: 'bankr' });
  assert.equal(r.stage, 'gas');
  assert.equal(w.drops.length, 0);
});

test('not enough in Connect: refused, nothing moved', async () => {
  const { w, run, hit } = world();
  const r = await run({ sellAmount: '10' });
  assert.equal(r.status, 'refused');
  assert.match(r.message, /5\.968974 USDC, less than 10/);
  assert.equal(w.drops.length + hit(/swap|transfer/).length, 0);
});

test('no ETH in Connect for the funding drop: refused', async () => {
  const { w, run } = world({ connect: { eth: 0n } });
  const r = await run({});
  assert.equal(r.status, 'refused');
  assert.equal(w.drops.length, 0);
});

test('funding drop throws → unknown, never swaps', async () => {
  const { run, hit } = world({ fundDrop: () => { throw new Error('timeout'); } });
  const r = await run({});
  assert.equal(r.status, 'unknown');
  assert.match(r.message, /may still land/);
  assert.equal(hit(/swap/).length, 0);
});

test('funding drop without a hash → failed, funds still in Connect', async () => {
  const { run, hit } = world({ fundDrop: () => ({ error: 'insufficient' }) });
  const r = await run({});
  assert.equal(r.status, 'failed');
  assert.match(r.message, /still be in Connect/);
  assert.equal(hit(/swap/).length, 0);
});

test('funds never show up in Bankr → partial, never swaps', async () => {
  const { run, hit } = world({ freezeBankr: true });
  const r = await run({}, { now: clock(), arrivalTimeoutMs: 30_000 });
  assert.equal(r.status, 'partial');
  assert.equal(r.stage, 'bankr_arrival');
  assert.equal(hit(/swap/).length, 0);
});

test('swap reverts after funding → partial, says the funds are in Bankr unswapped', async () => {
  const { run, hit } = world({ swap: [200, { success: false, hash: '0xrev' }] });
  const r = await run({ recipients: TWO, sendAll: true });
  assert.equal(r.status, 'partial');
  assert.match(r.message, /in your Bankr wallet \(not swapped\)/);
  assert.equal(hit(/transfer/).length, 0);
});

test('swap 504 → unknown, one attempt only', async () => {
  const { run, hit } = world({ swap: [504, { error: 'slow' }] });
  const r = await run({});
  assert.equal(r.status, 'unknown');
  assert.equal(hit(/\/wallet\/swap$/).length, 1);
  assert.equal(hit(/transfer/).length, 0);
});

test('transfer back fails → partial, swapped tokens in Bankr, no send', async () => {
  const { w, run } = world({ transfer: [403, { error: 'recipient not allowed' }] });
  const r = await run({ recipients: TWO, sendAll: true });
  assert.equal(r.status, 'partial');
  assert.match(r.message, /recipient not allowed.*in your Bankr wallet/);
  assert.equal(w.drops.length, 1);
});

test('Connect never shows the swapped tokens → partial, no send', async () => {
  const { w, run } = world({ freezeConnect: true });
  const r = await run({ recipients: TWO, sendAll: true }, { now: clock(), arrivalTimeoutMs: 30_000 });
  assert.equal(r.status, 'partial');
  assert.equal(r.stage, 'connect_arrival');
  assert.equal(w.drops.length, 1);
});

test('final send throws → unknown', async () => {
  const { run } = world({ payDrop: () => { throw new Error('timeout'); } });
  const r = await run({ recipients: TWO, sendAll: true });
  assert.equal(r.status, 'unknown');
  assert.match(r.message, /check your Connect wallet/);
});

test('unresolvable recipient → refused before any call', async () => {
  const { w, run } = world({ resolveRecipients: async () => ({ error: 'Could not resolve a wallet for: telegram:a.', failed: ['telegram:a'] }) });
  const r = await run({ recipients: TWO, sendAll: true });
  assert.equal(r.status, 'refused');
  assert.equal(w.calls.length + w.drops.length, 0);
});

test('source=bankr swaps what is already there, no funding drop', async () => {
  const { w, run } = world({ bankr: { usdc: '3' } });
  const r = await run({ source: 'bankr', recipients: TWO, sendAll: true });
  assert.equal(r.status, 'completed', r.message);
  assert.equal(w.drops.length, 1);
  assert.notEqual(w.drops[0].recipients[0].id, BANKR);
});

test('source=bankr with too little in Bankr → refused before the swap', async () => {
  const { run, hit } = world({ bankr: { usdc: '0.5' } });
  const r = await run({ source: 'bankr' });
  assert.equal(r.status, 'refused');
  assert.equal(hit(/\/wallet\/swap$/).length, 0);
});

test('bad inputs refused before any call', async () => {
  const { w, run } = world();
  for (const bad of [{ buyToken: 'HOME' }, { sellAmount: '-1' }, { chain: 'solana' }, { buyToken: USDC }, { source: 'wallet' }]) {
    const r = await run(bad);
    assert.equal(r.status, 'refused', JSON.stringify(bad));
  }
  assert.equal(w.calls.length + w.drops.length, 0);
});

test('Guillaume case: "send 500 DEGEN", top up with a swap → sends exactly 500, keeps the rest', async () => {
  const { w, run } = world({ connect: { home: 277n * 10n ** 18n } });
  const r = await run({ recipients: [TWO[0]], amountPerRecipient: '500' });
  assert.equal(r.status, 'completed', r.message);
  assert.equal(w.drops.at(-1).amountInWeiPerRecipient, (500n * 10n ** 18n).toString());
  assert.equal(w.connect.home, 277n * 10n ** 18n + RECEIVED - 500n * 10n ** 18n);
  assert.equal(r.totalSent, '500');
  assert.equal(r.leftInConnect, formatUnits(w.connect.home, 18));
  assert.match(r.message, /sent 500 HOME each to 1 recipient \(500 total\)\. About 4389\.04665 HOME is left/);
});

test('fixed amount per recipient × 2', async () => {
  const { w, run } = world();
  const r = await run({ recipients: TWO, amountPerRecipient: '100.5' });
  assert.equal(r.status, 'completed', r.message);
  assert.equal(w.drops.at(-1).amountInWeiPerRecipient, (1005n * 10n ** 17n).toString());
  assert.equal(r.totalSent, '201');
});

test('fixed amount the swap cannot cover → refused before anything moves', async () => {
  const { w, run, hit } = world({ connect: { home: 277n * 10n ** 18n } });
  const r = await run({ recipients: TWO, amountPerRecipient: '2500' }); // needs 5000; 277 + ≥4000 = 4277
  assert.equal(r.status, 'refused');
  assert.equal(r.stage, 'amount');
  assert.match(r.message, /needs 5000 HOME.*has 277 .*only guaranteed to return 4000/);
  assert.equal(w.drops.length, 0);
  assert.equal(hit(/\/wallet\/swap$|transfer/).length, 0);
});

test('existing balance counts toward a fixed amount', async () => {
  const { run } = world({ connect: { home: 1000n * 10n ** 18n } });
  const r = await run({ recipients: TWO, amountPerRecipient: '2500' }); // 1000 + ≥4000 ≥ 5000
  assert.equal(r.status, 'completed', r.message);
});

test('recipients without an amount or sendAll → refused, nothing called', async () => {
  const { w, run } = world();
  for (const bad of [{ recipients: TWO }, { recipients: TWO, amountPerRecipient: '1', sendAll: true }, { amountPerRecipient: '1' }, { sendAll: true }, { recipients: TWO, amountPerRecipient: 'lots' }]) {
    const r = await run(bad);
    assert.equal(r.status, 'refused', JSON.stringify(bad));
  }
  assert.equal(w.calls.length + w.drops.length, 0);
});

test('helpers', () => {
  assert.equal(formatUnits(1500000n, 6), '1.5');
  assert.equal(formatUnits(0n, 6), '0');
  assert.equal(parseUnits('0.1', 6), 100000n);
  assert.equal(parseUnits('1.1234567', 6), 1123456n, 'truncates, never rounds up');
  assert.equal(parseUnits('5', 18), 5n * 10n ** 18n);
  assert.equal(connectBalanceOf({ assets: [{ type: 'erc20', tokenContract: HOME, balanceInWei: '7' }] }, HOME.toUpperCase().replace('0X', '0x')), 7n);
  const port = { balances: { base: { nativeBalance: '0.1', tokenBalances: [{ token: { balance: '2.5', baseToken: { address: USDC.toUpperCase().replace('0X', '0x') } } }] } } };
  assert.equal(bankrBalanceOf(port, 'base', USDC), '2.5');
  assert.equal(bankrBalanceOf(port, 'base', 'native'), '0.1');
  assert.equal(bankrBalanceOf(port, 'polygon', USDC), '0');
});
