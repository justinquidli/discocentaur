#!/usr/bin/env node
// Demo of the World ID payout gate, run against a LOCAL STAND-IN for World IdP.
//
//   node scripts/demo-world-gate.mjs
//
// What is real: world-id.js (device flow, polling rules, ID-token validation)
// and payout-approval.js (plan-hash binding, audit-before-pay, fail closed).
// What is NOT real: the World server. A stand-in answers discovery, the device
// endpoint and the token endpoint with locally signed tokens, and the payout
// itself is a dummy that moves no money. This is not a live World approval.
// For that, see the README ("Live run") and the integration debrief.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createWorldGate, ACR_ORB } from '../world-id.js';
import { createPayoutApprover } from '../payout-approval.js';

const ISS = 'https://standin.world.test';
const T0 = 1_800_000_000_000;
const TREASURER = 'standin-sub-treasurer';
const cfg = { ok: true, missing: [], issuer: ISS, clientId: 'standin-client', clientSecret: 'standin-secret', treasurers: [TREASURER], acr: [ACR_ORB] };

const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
const { privateKey: forgedKey } = await generateKeyPair('RS256');

let n = 0;
const mint = ({ sub = TREASURER, acr = ACR_ORB, amr = ['pop'], authTime = T0 / 1000, key = privateKey, jti = `jti-${++n}` } = {}) => {
  const claims = { auth_time: authTime, amr };
  if (acr) claims.acr = acr;
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISS).setAudience(cfg.clientId).setSubject(sub).setJti(jti).setIssuedAt(T0 / 1000).setExpirationTime(T0 / 1000 + 600).sign(key);
};

const pending = { status: 400, body: { error: 'authorization_pending' } };
const approve = (opts) => ({ status: 200, body: async () => ({ id_token: await mint(opts) }), approving: true });

const scenarios = [
  { name: 'Approved by the registered treasurer', polls: [pending, pending, approve()], expect: { paid: true } },
  { name: 'Treasurer declines in World ID', polls: [pending, { status: 400, body: { error: 'access_denied' } }], expect: { paid: false, status: 'denied' } },
  { name: 'Approval never completed (expires)', polls: [], deviceBody: { expires_in: 3 }, expect: { paid: false, status: 'expired' } },
  { name: 'A different human approves', polls: [approve({ sub: 'someone-else' })], expect: { paid: false, status: 'wrong_human' } },
  { name: 'Passkey login instead of a fresh proof', polls: [approve({ amr: ['pop', 'user', 'mfa'] })], expect: { paid: false, status: 'insufficient_assurance' } },
  { name: 'Account without Orb-level assurance', polls: [approve({ acr: null })], expect: { paid: false, status: 'insufficient_assurance' } },
  { name: 'Forged token (wrong signing key)', polls: [approve({ key: forgedKey })], expect: { paid: false, status: 'invalid_token' } },
  { name: 'Authentication older than this request', polls: [approve({ authTime: T0 / 1000 - 3600 })], expect: { paid: false, status: 'stale' } },
  { name: 'Round file edited after the owner saw it', polls: [approve()], tamper: true, expect: { paid: false, status: 'plan_changed' } },
  { name: 'Approval cannot be written to the audit log', polls: [approve()], auditFails: true, expect: { paid: false, status: 'failed' } },
  { name: 'World ID unavailable (HTTP 503)', polls: [{ status: 503, body: {} }], expect: { paid: false, status: 'unavailable' } },
];

async function run(sc) {
  const dir = mkdtempSync(join(tmpdir(), 'world-demo-'));
  const roundFile = join(dir, 'round.json');
  writeFileSync(roundFile, JSON.stringify({ label: 'demo-round', split: { alice: 60, bob: 40 }, total: '100 USDC' }));
  const roundHash = () => createHash('sha256').update(readFileSync(roundFile)).digest('hex');

  let clock = T0;
  const queue = [...sc.polls];
  const events = [];
  const paid = [];
  const fetchImpl = async (url, init = {}) => {
    const json = (status, obj) => ({ ok: status < 400, status, json: async () => obj });
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return json(200, { issuer: ISS, device_authorization_endpoint: `${ISS}/device_authorization`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks` });
    }
    if (String(url).endsWith('/device_authorization')) {
      return json(200, { device_code: 'standin-device-code', user_code: 'DEMO-CODE', verification_uri: `${ISS}/device`, verification_uri_complete: `${ISS}/device?c=DEMO-CODE`, expires_in: 1200, interval: 1, ...(sc.deviceBody ?? {}) });
    }
    const next = queue.shift() ?? pending;
    if (next.approving && sc.tamper) writeFileSync(roundFile, JSON.stringify({ label: 'demo-round', split: { mallory: 100 }, total: '100 USDC' }));
    return json(next.status, typeof next.body === 'function' ? await next.body() : next.body);
  };
  const audit = (e) => { if (sc.auditFails) throw new Error('disk full'); events.push(e); };
  const gate = createWorldGate({ cfg, fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, keysFor: () => keys, audit, log: { error() {} } });
  const approver = createPayoutApprover({
    gate, roundHash, audit, log: { error() {} },
    execute: async ({ label }) => { paid.push(label); return { status: 'ok', executed: true, label, output: '(dummy payout: no money moved)' }; },
  });

  let finish;
  const done = new Promise((r) => { finish = r; });
  const req = await approver.request({ label: 'demo-round', senderId: 'demo-owner', onResult: async (r) => finish(r) });
  if (!req.ok) return { ok: false, status: req.code, paid: false, text: req.error };
  const result = await done;
  return { ok: result.ok, status: result.ok ? 'approved' : result.status, paid: paid.length > 0, text: result.text, events };
}

console.log('World ID payout gate — LOCAL STAND-IN for World IdP, dummy payout (no money moves)\n');
let failures = 0;
for (const sc of scenarios) {
  const r = await run(sc);
  const good = r.paid === sc.expect.paid && (sc.expect.status ? r.status === sc.expect.status : true);
  if (!good) failures++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${sc.name}`);
  console.log(`      outcome: ${r.status}   payout executed: ${r.paid ? 'YES' : 'no'}${r.paid === sc.expect.paid ? '' : '   <-- UNEXPECTED'}`);
}

// Replay: the same signed response must not approve two payouts.
{
  const sameJti = 'replayed-jti';
  let clock = T0;
  const events = [];
  const fetchImpl = async (url) => {
    const json = (status, obj) => ({ ok: status < 400, status, json: async () => obj });
    if (String(url).endsWith('/.well-known/openid-configuration')) return json(200, { issuer: ISS, device_authorization_endpoint: `${ISS}/device_authorization`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks` });
    if (String(url).endsWith('/device_authorization')) return json(200, { device_code: 'd', user_code: 'U', expires_in: 1200, interval: 1 });
    return json(200, { id_token: await mint({ jti: sameJti }) });
  };
  const gate = createWorldGate({ cfg, fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, keysFor: () => keys, audit: (e) => events.push(e), log: { error() {} } });
  const a = await (await gate.begin({ label: 'r1', senderId: 'a' })).done;
  const b = await (await gate.begin({ label: 'r2', senderId: 'b' })).done;
  const good = a.status === 'approved' && b.status === 'replayed';
  if (!good) failures++;
  console.log(`${good ? 'PASS' : 'FAIL'}  The same World ID response used twice`);
  console.log(`      first: ${a.status}   second: ${b.status}\n`);
}

console.log(failures ? `${failures} scenario(s) did not behave as expected.` : 'All scenarios behaved as expected: only the first one paid.');
process.exit(failures ? 1 : 0);
