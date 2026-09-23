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

// ── chains (2026-09-23: every Solana drop failed — EVM address, EVM-only regex) ──

const SOL_G = '5FM2b3jnxzu122hinVQVQsNZUVwuWpmpoVbzokG5oU4R';
const SOL_J = '8vo1awED98mwqDa4qR9JyMsk7qJYiwnTSG4EnXGyWXRh';
const both = async () => ({ status: 'completed', results: [
  { type: 'discord', value: '731076204307677226', ethWalletAddress: A, solWalletAddress: SOL_G },
] });

test('Solana drops get the Solana address, EVM drops the EVM one', async () => {
  const sol = await resolveRecipientsToWallets([{ type: 'discord', id: '731076204307677226' }], both, { chainId: 1399811149 });
  assert.deepEqual(sol.recipients, [{ type: 'wallet', id: SOL_G }]);
  const base = await resolveRecipientsToWallets([{ type: 'discord', id: '731076204307677226' }], both, { chainId: 8453 });
  assert.deepEqual(base.recipients, [{ type: 'wallet', id: A }]);
  const dflt = await resolveRecipientsToWallets([{ type: 'discord', id: '731076204307677226' }], both);
  assert.deepEqual(dflt.recipients, [{ type: 'wallet', id: A }], 'default stays EVM (Bankr swap-and-send)');
});

test('a pasted Solana address is accepted on Solana and refused on EVM', async () => {
  const sol = await resolveRecipientsToWallets([{ type: 'wallet', id: SOL_G }], async () => {}, { chainId: 1399811149 });
  assert.deepEqual(sol.recipients, [{ type: 'wallet', id: SOL_G }]);
  const evm = await resolveRecipientsToWallets([{ type: 'wallet', id: SOL_G }], async () => {}, { chainId: 8453 });
  assert.match(evm.error, /Invalid EVM wallet address/);
  const evmOnSol = await resolveRecipientsToWallets([{ type: 'wallet', id: A }], async () => {}, { chainId: 1399811149 });
  assert.match(evmOnSol.error, /Invalid Solana wallet address/);
});

test('a lookup with no Solana address fails a Solana drop — never falls back to EVM', async () => {
  const r = await resolveRecipientsToWallets([{ type: 'discord', id: '1' }],
    async () => ({ status: 'completed', results: [{ type: 'discord', value: '1', ethWalletAddress: A }] }), { chainId: 1399811149 });
  assert.match(r.error, /Could not resolve a Solana wallet for: discord:1\. Nothing was sent/);
});

test('per-recipient amounts survive resolution, in order', async () => {
  const r = await resolveRecipientsToWallets(
    [{ type: 'wallet', id: SOL_J, amountInWei: '5' }, { type: 'discord', id: '731076204307677226', amountInWei: '7' }],
    both, { chainId: 1399811149 });
  assert.deepEqual(r.recipients, [{ type: 'wallet', id: SOL_J, amountInWei: '5' }, { type: 'wallet', id: SOL_G, amountInWei: '7' }]);
});
