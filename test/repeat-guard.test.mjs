// The same payment twice within two minutes waits for confirmation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRepeatGuard, paymentKey, repeatNote } from '../repeat-guard.js';

const send = (over = {}) => ({ chainId: 1399811149, tokenContract: 'EPjF', amountInWeiPerRecipient: '10000', recipients: [{ type: 'discord', id: '731' }], ...over });

test('a second identical send is caught; the first is not', () => {
  let t = 0;
  const g = createRepeatGuard({ now: () => t });
  assert.equal(g.claim('me', send()), null);
  t = 4000;
  assert.equal(g.claim('me', send()), 4, 'two copies of one message');
});

test('different sender, amount, chain, token or recipient is a new payment', () => {
  const g = createRepeatGuard({ now: () => 0 });
  assert.equal(g.claim('me', send()), null);
  for (const [who, s] of [['you', send()], ['me', send({ amountInWeiPerRecipient: '20000' })], ['me', send({ chainId: 8453 })],
    ['me', send({ tokenContract: undefined })], ['me', send({ recipients: [{ type: 'discord', id: '999' }] })]]) {
    assert.equal(g.claim(who, s), null);
  }
});

test('recipient order and case do not matter', () => {
  const a = send({ recipients: [{ type: 'github', username: '@Kai' }, { type: 'discord', id: '1' }] });
  const b = send({ recipients: [{ type: 'discord', id: '1' }, { type: 'GitHub', username: 'kai' }] });
  assert.equal(paymentKey('me', a), paymentKey('me', b));
});

test('after the window it runs again; a released (failed) send is not a repeat', () => {
  let t = 0;
  const g = createRepeatGuard({ now: () => t, windowMs: 120_000 });
  g.claim('me', send());
  t = 121_000;
  assert.equal(g.claim('me', send()), null, 'outside the window');
  g.release('me', send());
  assert.equal(g.claim('me', send()), null, 'released');
});

test('the note says how long ago and how to go ahead', () => {
  assert.match(repeatNote(4, '!'), /4s ago.*`!confirm`.*`!cancel`/);
  assert.match(repeatNote(90, '/'), /2 min ago.*`\/confirm`/);
});
