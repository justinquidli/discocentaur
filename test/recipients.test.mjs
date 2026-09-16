import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecipientsToWallets } from '../recipients.js';

const A = '0x503a04D04E00d9b0C0898e2D7A16B857BE6cdAF0';
const B = '0x6a48ADE3bE3F9f0b8B4c9af61Bb654A219311699';
const noWait = async () => {};

test('maps social recipients to wallets using the lookup value (shape seen live 2026-09-16)', async () => {
  const r = await resolveRecipientsToWallets(
    [{ type: 'telegram', username: '@JustinAhn' }, { type: 'github', username: 'justinquidli' }],
    async () => ({ status: 'completed', results: [
      { type: 'github', value: 'justinquidli', ethWalletAddress: B },
      { type: 'telegram', value: 'justinahn', ethWalletAddress: A },
    ] }),
  );
  assert.deepEqual(r.recipients, [{ type: 'wallet', id: A }, { type: 'wallet', id: B }]);
});

test('retries while processing', async () => {
  let n = 0;
  const r = await resolveRecipientsToWallets([{ type: 'email', id: 'x@y.com' }], async () => (++n < 3
    ? { status: 'processing' }
    : { status: 'completed', results: [{ type: 'email', value: 'x@y.com', ethWalletAddress: A }] }), { wait: noWait });
  assert.equal(n, 3);
  assert.equal(r.recipients[0].id, A);
});

test('any unresolved recipient fails the whole set', async () => {
  const r = await resolveRecipientsToWallets(
    [{ type: 'telegram', id: '1' }, { type: 'telegram', id: '2' }],
    async () => ({ status: 'completed', results: [{ type: 'telegram', value: '1', ethWalletAddress: A }], failed: [{ type: 'telegram', value: '2' }] }),
  );
  assert.deepEqual(r.failed, ['telegram:2']);
  assert.equal(r.recipients, undefined);
});

test('wallets pass through without a lookup; bad addresses refused', async () => {
  let called = false;
  const ok = await resolveRecipientsToWallets([{ type: 'wallet', id: A }], async () => { called = true; });
  assert.deepEqual(ok.recipients, [{ type: 'wallet', id: A }]);
  assert.equal(called, false);
  assert.ok((await resolveRecipientsToWallets([{ type: 'wallet', id: '0x12' }], async () => {})).error);
  assert.ok((await resolveRecipientsToWallets([], async () => {})).error);
});

test('still processing after all tries → error, no recipients', async () => {
  const r = await resolveRecipientsToWallets([{ type: 'email', id: 'x@y.com' }], async () => ({ status: 'processing' }), { wait: noWait, tries: 2 });
  assert.match(r.error, /still creating/);
});
