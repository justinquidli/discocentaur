import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createWorldGate, loadWorldConfig, validateIdToken, ACR_ORB } from '../world-id.js';

const ISS = 'https://auth.test';
const T0 = 1_800_000_000_000;
const cfg = { ok: true, missing: [], issuer: ISS, clientId: 'cid', clientSecret: 'super-secret-value', treasurers: ['sub1'], acr: [ACR_ORB] };

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const keys = createLocalJWKSet({ keys: [jwk] });
const { privateKey: otherKey } = await generateKeyPair('RS256');

let jtiN = 0;
async function mint({ sub = 'sub1', acr = ORB(), amr = ['pop'], authTime = T0 / 1000, aud = 'cid', iss = ISS, jti = `j${++jtiN}`, key = privateKey, exp = T0 / 1000 + 600 } = {}) {
  const claims = { auth_time: authTime, amr };
  if (acr) claims.acr = acr;
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(iss).setAudience(aud).setSubject(sub).setJti(jti).setIssuedAt(T0 / 1000).setExpirationTime(exp).sign(key);
}
function ORB() { return ACR_ORB; }

function harness({ tokens = [], audit, deviceBody = {}, maxPending } = {}) {
  let t = T0;
  const calls = [];
  const sleeps = [];
  const queue = [...tokens];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url: String(url), body });
    const json = (status, obj) => ({ ok: status < 400, status, json: async () => obj });
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return json(200, { issuer: ISS, device_authorization_endpoint: `${ISS}/api/v1/device_authorization`, token_endpoint: `${ISS}/api/v1/token`, jwks_uri: `${ISS}/jwks` });
    }
    if (String(url).endsWith('/device_authorization')) {
      return json(200, { device_code: 'DEVICE-SECRET', user_code: 'ABCD-1234', verification_uri: `${ISS}/device`, verification_uri_complete: `${ISS}/device?c=ABCD-1234`, expires_in: 1200, interval: 1, ...deviceBody });
    }
    const next = queue.shift() ?? { status: 400, body: { error: 'authorization_pending' } };
    const b = typeof next.body === 'function' ? await next.body() : next.body;
    return json(next.status, b);
  };
  const gate = createWorldGate({
    cfg, fetchImpl, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, keysFor: () => keys,
    audit, log: { error() {} }, maxPending,
  });
  return { gate, calls, sleeps, advance: (ms) => { t += ms; } };
}
const pending = { status: 400, body: { error: 'authorization_pending' } };
const ok = async (opts) => ({ status: 200, body: async () => ({ id_token: await mint(opts) }) });
const okTok = (opts) => ({ status: 200, body: async () => ({ id_token: await mint(opts) }) });
const begin = (g, extra = {}) => g.begin({ label: 'r1', planHash: 'h1', senderId: 'u1', ...extra });

test('config reports what is missing and defaults to Orb only', () => {
  const c = loadWorldConfig({});
  assert.equal(c.ok, false);
  assert.deepEqual(c.missing, ['WORLD_ID_CLIENT_ID', 'WORLD_ID_CLIENT_SECRET', 'WORLD_ID_TREASURER_SUBS']);
  assert.deepEqual(c.acr, [ACR_ORB]);
  const full = loadWorldConfig({ WORLD_ID_CLIENT_ID: 'a', WORLD_ID_CLIENT_SECRET: 'b', WORLD_ID_TREASURER_SUBS: 'x, y', WORLD_ID_ISSUER: 'https://sandbox.auth.world.org/' });
  assert.equal(full.ok, true);
  assert.deepEqual(full.treasurers, ['x', 'y']);
  assert.equal(full.issuer, 'https://sandbox.auth.world.org');
});

test('approved: polls until the human approves, secrets stay inside', async () => {
  const events = [];
  const h = harness({ tokens: [pending, pending, okTok()], audit: (e) => events.push(e) });
  const a = await begin(h.gate);
  assert.equal(a.userCode, 'ABCD-1234');
  assert.ok(!JSON.stringify(a).includes('DEVICE-SECRET'), 'device code never returned');
  const out = await a.done;
  assert.equal(out.status, 'approved');
  assert.equal(out.approver.sub, 'sub1');
  assert.ok(!JSON.stringify(out).includes('super-secret-value'));
  assert.ok(!JSON.stringify(events).includes('super-secret-value') && !JSON.stringify(events).includes('DEVICE-SECRET'), 'audit has no secrets');
  assert.equal(events.at(-1).outcome, 'approved');
  const device = h.calls.find((c) => c.url.endsWith('/device_authorization')).body;
  assert.equal(device.scope, 'openid');
  assert.match(device.claims, /acr/);
  assert.equal(h.gate.pendingCount, 0);
});

for (const [name, tok, status] of [
  ['denied', { status: 400, body: { error: 'access_denied' } }, 'denied'],
  ['server expiry', { status: 400, body: { error: 'expired_token' } }, 'expired'],
  ['503 is never approval', { status: 503, body: {} }, 'unavailable'],
  ['429 ends the attempt', { status: 429, body: {} }, 'rate_limited'],
  ['invalid_grant stops', { status: 400, body: { error: 'invalid_grant' } }, 'failed'],
  ['someone else', okTok({ sub: 'intruder' }), 'wrong_human'],
  ['passkey is not a proof', okTok({ amr: ['pop', 'user', 'mfa'] }), 'insufficient_assurance'],
  ['unverified account (no acr)', okTok({ acr: null }), 'insufficient_assurance'],
  ['selfie-level acr', okTok({ acr: 'https://world.org/oidc/acr/selfie' }), 'insufficient_assurance'],
  ['stale auth_time', okTok({ authTime: T0 / 1000 - 3600 }), 'stale'],
  ['wrong audience', okTok({ aud: 'someone-else' }), 'invalid_token'],
  ['wrong issuer', okTok({ iss: 'https://evil.test' }), 'invalid_token'],
  ['forged signature', okTok({ key: otherKey }), 'invalid_token'],
  ['expired token', okTok({ exp: T0 / 1000 - 100 }), 'invalid_token'],
]) {
  test(`pays nothing: ${name}`, async () => {
    const h = harness({ tokens: [tok] });
    const out = await (await begin(h.gate)).done;
    assert.equal(out.status, status);
    assert.equal(out.approver, undefined, 'no approver on a refusal');
  });
}

test('slow_down widens the polling interval', async () => {
  const h = harness({ tokens: [{ status: 400, body: { error: 'slow_down' } }, pending, okTok()] });
  const out = await (await begin(h.gate)).done;
  assert.equal(out.status, 'approved');
  assert.deepEqual(h.sleeps.slice(0, 3), [1000, 6000, 6000]);
});

test('attempt expires on the client clock too', async () => {
  const h = harness({ tokens: [], deviceBody: { expires_in: 3, interval: 1 } });
  const out = await (await begin(h.gate)).done;
  assert.equal(out.status, 'expired');
});

test('a token cannot be replayed', async () => {
  const jti = 'same-jti';
  const h = harness({ tokens: [okTok({ jti }), okTok({ jti })] });
  assert.equal((await (await begin(h.gate)).done).status, 'approved');
  assert.equal((await (await begin(h.gate, { label: 'r2', senderId: 'u2' })).done).status, 'replayed');
});

test('one pending approval per sender and per round; cap on total', async () => {
  const h = harness({ tokens: [], maxPending: 2 });
  const a = await begin(h.gate);
  await assert.rejects(begin(h.gate, { label: 'r2' }), (e) => e.code === 'already_pending');
  await assert.rejects(begin(h.gate, { senderId: 'u2' }), (e) => e.code === 'already_pending');
  await begin(h.gate, { label: 'r3', senderId: 'u3' });
  await assert.rejects(begin(h.gate, { label: 'r4', senderId: 'u4' }), (e) => e.code === 'busy');
  h.gate.cancelAll();
  assert.equal((await a.done).status, 'cancelled');
});

test('simultaneous requests cannot both get through', async () => {
  const h = harness({ tokens: [] });
  const results = await Promise.allSettled([begin(h.gate), begin(h.gate)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  h.gate.cancelAll();
});

test('if the approval cannot be recorded it is not an approval', async () => {
  const h = harness({ tokens: [okTok()], audit: () => { throw new Error('disk full'); } });
  const out = await (await begin(h.gate)).done;
  assert.equal(out.status, 'failed');
});

test('not configured: refuses to start', async () => {
  const gate = createWorldGate({ cfg: loadWorldConfig({}) });
  assert.equal(gate.configured, false);
  await assert.rejects(begin(gate), (e) => e.code === 'not_configured');
});

test('enrolment is host-only', async () => {
  const h = harness({ tokens: [okTok({ sub: 'new-person' })] });
  await assert.rejects(begin(h.gate, { enroll: true }), /host script/);
});

test('validateIdToken: enrolment skips only the allowlist', async () => {
  const base = { cfg, keys, startedAtSec: T0 / 1000, nowSec: T0 / 1000 + 5 };
  const v = await validateIdToken(await mint({ sub: 'new-person' }), { ...base, enroll: true });
  assert.equal(v.ok, true);
  const bad = await validateIdToken(await mint({ sub: 'new-person', amr: ['pop', 'mfa'] }), { ...base, enroll: true });
  assert.equal(bad.status, 'insufficient_assurance');
});

test('diagnostic switch: claims can be left out of the device request, validation still enforces acr', async () => {
  let t = T0;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url: String(url), body });
    const json = (status, obj) => ({ ok: status < 400, status, json: async () => obj });
    if (String(url).endsWith('/.well-known/openid-configuration')) return json(200, { issuer: ISS, device_authorization_endpoint: `${ISS}/api/v1/device_authorization`, token_endpoint: `${ISS}/api/v1/token`, jwks_uri: `${ISS}/jwks` });
    if (String(url).endsWith('/device_authorization')) return json(200, { device_code: 'D', user_code: 'U', expires_in: 1200, interval: 1 });
    return json(200, { id_token: await mint({ acr: 'https://world.org/oidc/acr/selfie' }) });
  };
  const gate = createWorldGate({ cfg, fetchImpl, now: () => t, sleep: async (ms) => { t += ms; }, keysFor: () => keys, sendClaims: false, log: { error() {} } });
  const out = await (await begin(gate)).done;
  assert.equal(calls.find((c) => c.url.endsWith('/device_authorization')).body.claims, undefined);
  assert.equal(out.status, 'insufficient_assurance', 'a non-Orb acr is still refused without the claims request');
});
