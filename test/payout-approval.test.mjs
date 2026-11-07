import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPayoutApprover, outcomeMessage } from '../payout-approval.js';

const approver = { sub: 'sub1', acr: 'orb', amr: ['pop'], authTime: 1 };

function setup({ outcome = { status: 'approved', approver }, hash = () => 'h1', execute, audit, stopping = false } = {}) {
  const events = [];
  const executed = [];
  let release;
  const doneP = new Promise((r) => { release = () => r(outcome); });
  const gate = {
    async begin({ label, planHash }) { return { id: 'a1', userCode: 'UC', verificationUri: 'u', verificationUriComplete: 'uc', expiresInSec: 1200, done: doneP, label, planHash }; },
    cancel() { return true; },
  };
  const ap = createPayoutApprover({
    gate, roundHash: hash,
    execute: execute ?? (async ({ label }) => { executed.push(label); return { status: 'ok', executed: true, label, output: 'paid' }; }),
    audit: audit ?? ((e) => events.push(e)),
    isStopping: () => stopping,
    log: { error() {} },
  });
  const results = [];
  let got;
  const finished = new Promise((r) => { got = r; });
  const request = () => ap.request({ label: 'r1', senderId: 'u1', onResult: async (r) => { results.push(r); got(r); } });
  return { ap, request, release, results, finished, executed, events };
}

test('approved: pays once, records who approved', async () => {
  const s = setup();
  const req = await s.request();
  assert.equal(req.ok, true);
  assert.deepEqual(s.executed, [], 'nothing paid before approval');
  s.release();
  const r = await s.finished;
  assert.equal(r.ok, true);
  assert.deepEqual(s.executed, ['r1']);
  assert.deepEqual(s.events.map((e) => e.event), ['payout_start', 'payout_result']);
  assert.equal(s.events[0].sub, 'sub1');
  assert.equal(s.results.length, 1);
});

for (const status of ['denied', 'expired', 'cancelled', 'wrong_human', 'insufficient_assurance', 'stale', 'invalid_token', 'replayed', 'unavailable', 'rate_limited', 'failed']) {
  test(`${status}: nothing is paid`, async () => {
    const s = setup({ outcome: { status } });
    await s.request();
    s.release();
    const r = await s.finished;
    assert.equal(r.ok, false);
    assert.equal(r.executed, false);
    assert.equal(r.result, undefined);
    assert.deepEqual(s.executed, []);
    assert.match(r.text, /Nothing was paid/);
  });
}

test('the saved round changed after approval: not paid', async () => {
  let h = 'h1';
  const s = setup({ hash: () => h });
  await s.request();
  h = 'h2';
  s.release();
  const r = await s.finished;
  assert.equal(r.status, 'plan_changed');
  assert.deepEqual(s.executed, []);
  assert.ok(s.events.some((e) => e.event === 'plan_changed'));
});

test('cannot record the approval: not paid', async () => {
  const s = setup({ audit: () => { throw new Error('disk full'); } });
  await s.request();
  s.release();
  const r = await s.finished;
  assert.equal(r.status, 'not_recorded');
  assert.deepEqual(s.executed, []);
});

test('a payout run that throws is reported as unknown, not as unpaid', async () => {
  const s = setup({ execute: async () => { throw new Error('child died'); } });
  await s.request();
  s.release();
  const r = await s.finished;
  assert.equal(r.status, 'unknown');
  assert.equal(r.result.status, 'unknown');
  assert.match(r.text, /⚠️/);
});

test('refuses while the bot is shutting down', async () => {
  const s = setup({ stopping: true });
  const req = await s.request();
  assert.equal(req.ok, false);
  assert.equal(req.code, 'restarting');
});

test('unreadable round: nothing to approve', async () => {
  const s = setup({ hash: () => null });
  const req = await s.request();
  assert.equal(req.ok, false);
  assert.equal(req.code, 'no_round');
});

test('a round being paid cannot be paid twice', async () => {
  let finishRun;
  const s = setup({ execute: () => new Promise((r) => { finishRun = () => r({ status: 'ok', executed: true }); }) });
  await s.request();
  s.release();
  await new Promise((r) => setTimeout(r, 10));
  const second = await s.request();
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already_pending');
  finishRun();
  await s.finished;
});

test('every status has a message that says nothing was paid (except results)', () => {
  assert.match(outcomeMessage('denied'), /Nothing was paid/);
  assert.match(outcomeMessage('something-new'), /Nothing was paid/);
});
