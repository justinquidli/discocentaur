/**
 * Graceful shutdown and stored-key decryption. Shared byte-for-byte with the
 * other bot (see scripts/shared-files.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCipheriv, randomBytes } from 'node:crypto';

import { createShutdown } from '../shutdown.js';
import { createSecretBox, looksEncrypted } from '../secrets.js';

const quiet = () => {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// ── shutdown ─────────────────────────────────────────────────────────────────

test('shutdown stops intake first, waits for an in-flight drop, then exits 0', async () => {
  const order = [];
  const logger = quiet();
  const sd = createShutdown({ graceMs: 1000, logger, exit: (c) => order.push(`exit ${c}`) });
  sd.onStop(() => order.push('stop intake'));
  const drop = deferred();
  sd.track(drop.promise.then(() => order.push('drop done')), 'quidli_drop');

  const done = sd.shutdown('SIGINT');
  assert.equal(sd.stopping, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ['stop intake'], 'does not exit while the drop is in flight');
  drop.resolve();
  await done;
  assert.deepEqual(order, ['stop intake', 'drop done', 'exit 0']);
  assert.match(logger.lines.at(-1), /clean exit/);
});

test('work started during the grace period is waited for too', async () => {
  const exits = [];
  const sd = createShutdown({ graceMs: 1000, logger: quiet(), exit: (c) => exits.push(c) });
  const first = deferred();
  const second = deferred();
  sd.track(first.promise.then(() => { sd.track(second.promise, 'follow-up'); }), 'first');
  const done = sd.shutdown('SIGTERM');
  first.resolve();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [], 'still waiting on the follow-up');
  second.resolve();
  await done;
  assert.deepEqual(exits, [0]);
});

test('a hung action does not block exit past the grace period', async () => {
  const logger = quiet();
  const exits = [];
  const sd = createShutdown({ graceMs: 30, logger, exit: (c) => exits.push(c) });
  sd.track(new Promise(() => {}), 'bankr_agent');
  await sd.shutdown('SIGINT');
  assert.deepEqual(exits, [0]);
  assert.match(logger.lines.join('\n'), /still running after 30 ms.*bankr_agent/);
});

test('a failed action and a failing stop hook still end in exit', async () => {
  const exits = [];
  const sd = createShutdown({ graceMs: 1000, logger: quiet(), exit: (c) => exits.push(c) });
  sd.onStop(() => { throw new Error('Bot is not running!'); });
  sd.track(Promise.reject(new Error('HTTP 500')), 'quidli_drop').catch(() => {});
  await sd.shutdown('SIGINT');
  assert.deepEqual(exits, [0]);
  assert.equal(sd.inflightCount, 0);
});

test('a second signal does not run shutdown twice', async () => {
  const proc = new EventEmitter();
  const exits = [];
  const sd = createShutdown({ graceMs: 1000, logger: quiet(), exit: (c) => exits.push(c) });
  let stops = 0;
  sd.onStop(() => { stops++; });
  sd.install(proc);
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  await sd.shutdown('again');
  assert.equal(stops, 1);
  assert.deepEqual(exits, [0]);
});

test('track returns the original promise result', async () => {
  const sd = createShutdown({ logger: quiet(), exit: () => {} });
  assert.equal(await sd.track(Promise.resolve(42)), 42);
  await assert.rejects(sd.track(Promise.reject(new Error('x'))), /x/);
});

// ── secrets ──────────────────────────────────────────────────────────────────

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

test('round-trips, and reads values written by the old in-bot encrypt()', () => {
  const box = createSecretBox(KEY, { logger: quiet() });
  const enc = box.encrypt('qk_live_123');
  assert.ok(looksEncrypted(enc));
  assert.equal(box.decrypt(enc), 'qk_live_123');

  // The exact format bot.js wrote before secrets.js existed.
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
  const data = Buffer.concat([c.update('legacy-key', 'utf8'), c.final()]);
  const legacy = `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${data.toString('hex')}`;
  assert.equal(box.decrypt(legacy), 'legacy-key');
});

test('plaintext stored before encryption was enabled passes through, colons included', () => {
  const box = createSecretBox(KEY, { logger: quiet() });
  assert.equal(box.decrypt('sk-plain'), 'sk-plain');
  assert.equal(box.decrypt('a:b:c'), 'a:b:c', 'three parts is not enough to be ciphertext');
  assert.equal(box.decrypt(''), null);
  assert.equal(box.decrypt(null), null);
});

test('a key encrypted under a different master key is null, logged once — never the ciphertext', () => {
  const enc = createSecretBox(OTHER, { logger: quiet() }).encrypt('secret');
  const logger = quiet();
  const box = createSecretBox(KEY, { logger });
  assert.equal(box.decrypt(enc), null);
  assert.equal(box.decrypt(enc), null);
  assert.equal(logger.lines.length, 1, 'one warning per stored value, not per message');
  assert.match(logger.lines[0], /MASTER_ENCRYPTION_KEY changed/);
  assert.ok(!logger.lines[0].includes(enc), 'the full ciphertext is not logged');
});

test('encrypted value with no master key set is null, not passed on as a key', () => {
  const enc = createSecretBox(KEY, { logger: quiet() }).encrypt('secret');
  const logger = quiet();
  const box = createSecretBox('', { logger });
  assert.equal(box.enabled, false);
  assert.equal(box.decrypt(enc), null);
  assert.match(logger.lines[0], /not set/);
  assert.equal(box.encrypt('x'), 'x', 'no key: stored as plaintext, as before');
});

test('a malformed master key fails at startup, not on the first /connect', () => {
  assert.throws(() => createSecretBox('abcd'), /64 hex characters/);
});
