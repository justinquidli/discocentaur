/**
 * World ID Agent Pass approval (OIDC Device Authorization Grant, RFC 8628).
 *
 * What this proves: a unique, verified human whose World ID is on the treasurer
 * allowlist just completed a fresh proof on their phone. What it does NOT
 * prove: what they approved. World's approval page shows only the requester
 * name and a code — `binding_message` is unsupported — so the caller must bind
 * the attempt to the exact plan (see payout-approval.js, which hashes the
 * round file) and show the plan itself.
 *
 * Fails closed everywhere: any outcome other than `approved` means nothing is
 * paid. The ID token is validated here, in the backend, and is never logged,
 * returned to the model, or written to the audit file. The client secret and
 * device code never leave this module.
 *
 * Not in SHARED_FILES: this exists only in DiscoCentaur.
 */
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const DEFAULT_ISSUER = 'https://auth.world.org';
export const ACR_ORB = 'https://world.org/oidc/acr/orb';

const SKEW_S = 10;            // clock tolerance for exp/iat/auth_time
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_S = 5;
const MAX_LIFETIME_S = 20 * 60; // device codes live 20 minutes; never trust a longer expires_in

export class WorldError extends Error {
  constructor(code, message) { super(message); this.name = 'WorldError'; this.code = code; }
}

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Reads config from env. `ok` is false until everything required is set. */
export function loadWorldConfig(env = process.env) {
  const issuer = (env.WORLD_ID_ISSUER || DEFAULT_ISSUER).trim().replace(/\/+$/, '');
  const clientId = (env.WORLD_ID_CLIENT_ID || '').trim();
  const clientSecret = (env.WORLD_ID_CLIENT_SECRET || '').trim();
  const treasurers = list(env.WORLD_ID_TREASURER_SUBS);
  const acr = list(env.WORLD_ID_ACCEPTED_ACR);
  const missing = [];
  if (!clientId) missing.push('WORLD_ID_CLIENT_ID');
  if (!clientSecret) missing.push('WORLD_ID_CLIENT_SECRET');
  if (!treasurers.length) missing.push('WORLD_ID_TREASURER_SUBS');
  return { ok: missing.length === 0, missing, issuer, clientId, clientSecret, treasurers, acr: acr.length ? acr : [ACR_ORB] };
}

/**
 * Validate an ID token against the saved policy. Returns { ok:true, approver }
 * or { ok:false, status, reason }. Pure given its inputs, so tests drive it
 * with locally signed tokens.
 *
 * Policy:
 *  - RS256 signature from the issuer's JWKS, exact iss, aud = our client id, exp present
 *  - auth_time belongs to THIS attempt (not before it started) and is not in the future
 *  - acr is one of the accepted classes (exact match)
 *  - amr shows a World ID proof ('pop') and NOT a passkey ('mfa'): a passkey
 *    asserts account control, not a fresh proof
 *  - jti not seen before
 *  - sub is on the treasurer allowlist (skipped only when enrolling)
 */
export async function validateIdToken(idToken, { cfg, keys, startedAtSec, nowSec, seenJti = new Set(), enroll = false }) {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: cfg.issuer,
      audience: cfg.clientId,
      algorithms: ['RS256'],
      clockTolerance: SKEW_S,
      currentDate: new Date(nowSec * 1000),
      requiredClaims: ['exp', 'iat', 'sub'],
    }));
  } catch (e) {
    return { ok: false, status: 'invalid_token', reason: `signature or claims check failed (${e?.code ?? e?.name ?? 'error'})` };
  }

  if (typeof payload.sub !== 'string' || !payload.sub) return { ok: false, status: 'invalid_token', reason: 'no subject' };

  const authTime = payload.auth_time;
  if (typeof authTime !== 'number') return { ok: false, status: 'invalid_token', reason: 'no auth_time' };
  if (authTime > nowSec + SKEW_S) return { ok: false, status: 'invalid_token', reason: 'auth_time is in the future' };
  if (authTime < startedAtSec - SKEW_S) return { ok: false, status: 'stale', reason: 'authentication happened before this approval was requested' };

  if (typeof payload.acr !== 'string' || !cfg.acr.includes(payload.acr)) {
    return { ok: false, status: 'insufficient_assurance', reason: `acr ${payload.acr ?? '(none)'} is not an accepted class` };
  }
  const amr = Array.isArray(payload.amr) ? payload.amr : [];
  if (!amr.includes('pop') || amr.includes('mfa')) {
    return { ok: false, status: 'insufficient_assurance', reason: 'authentication was not a fresh World ID proof' };
  }

  if (payload.jti) {
    if (seenJti.has(payload.jti)) return { ok: false, status: 'replayed', reason: 'token was already used' };
    seenJti.add(payload.jti);
  }

  if (!enroll && !cfg.treasurers.includes(payload.sub)) {
    return { ok: false, status: 'wrong_human', reason: 'this World ID is not a registered treasurer' };
  }

  return { ok: true, approver: { sub: payload.sub, acr: payload.acr, amr, authTime, jti: payload.jti ?? null } };
}

async function postForm(fetchImpl, url, fields, timeoutMs) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, body };
}

const defaultSleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * One gate per process. `begin()` starts a device attempt and returns what the
 * human needs (code + link) plus `done`, a promise that ALWAYS resolves — never
 * rejects — with the outcome.
 */
export function createWorldGate({
  cfg,
  fetchImpl = fetch,
  now = Date.now,
  sleep = defaultSleep,
  keysFor = (meta) => createRemoteJWKSet(new URL(meta.jwks_uri)),
  audit = () => {},
  allowEnroll = false,
  maxPending = 3,
  log = console,
  debug = false,
  sendClaims = true, // diagnostic only: false drops the acr `claims` extension; validation still enforces acr
} = {}) {
  const pending = new Map();      // attempt id -> attempt
  const seenJti = new Set();
  let metaPromise = null;
  let keys = null;

  async function discover() {
    const url = `${cfg.issuer}/.well-known/openid-configuration`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new WorldError('unavailable', `World discovery returned ${res.status}`);
    const meta = await res.json();
    if (String(meta.issuer ?? '').replace(/\/+$/, '') !== cfg.issuer) throw new WorldError('failed', 'World discovery issuer does not match the configured issuer');
    for (const k of ['device_authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (!String(meta[k] ?? '').startsWith('https://')) throw new WorldError('failed', `World discovery has no https ${k}`);
    }
    keys = keysFor(meta);
    return meta;
  }
  const getMeta = () => (metaPromise ??= discover().catch((e) => { metaPromise = null; throw e; }));

  function outcomeOf(attempt, status, extra = {}) {
    return { status, attemptId: attempt.id, label: attempt.label, planHash: attempt.planHash, ...extra };
  }

  async function run(attempt, meta) {
    let intervalMs = attempt.intervalS * 1000;
    for (;;) {
      if (attempt.cancelled) return outcomeOf(attempt, 'cancelled');
      if (now() >= attempt.expiresAtMs) return outcomeOf(attempt, 'expired');
      await sleep(intervalMs, attempt.abort.signal);
      if (attempt.cancelled) return outcomeOf(attempt, 'cancelled');
      const remaining = attempt.expiresAtMs - now();
      if (remaining <= 0) return outcomeOf(attempt, 'expired');

      let r;
      try {
        r = await postForm(fetchImpl, meta.token_endpoint, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          device_code: attempt.deviceCode,
        }, Math.min(REQUEST_TIMEOUT_MS, remaining));
      } catch {
        intervalMs = Math.min(intervalMs * 2, 30_000); // connection timeout: back off, keep within the attempt's lifetime
        continue;
      }

      if (debug) log.error?.(`[world] poll -> http ${r.status} ${r.body?.error ?? (typeof r.body?.id_token === 'string' ? 'id_token' : 'no error field')}${r.body?.error_description ? ` | ${String(r.body.error_description).slice(0, 200)}` : ''}`);
      if (r.status === 200 && typeof r.body.id_token === 'string') {
        const v = await validateIdToken(r.body.id_token, {
          cfg, keys, startedAtSec: Math.floor(attempt.startedAtMs / 1000), nowSec: Math.floor(now() / 1000), seenJti, enroll: attempt.enroll,
        });
        if (!v.ok) return outcomeOf(attempt, v.status, { reason: v.reason });
        return outcomeOf(attempt, attempt.enroll ? 'enrolled' : 'approved', { approver: v.approver });
      }

      const err = r.body?.error;
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') { intervalMs += 5000; continue; }
      if (err === 'access_denied') return outcomeOf(attempt, 'denied');
      if (err === 'expired_token') return outcomeOf(attempt, 'expired');
      if (r.status === 503) return outcomeOf(attempt, 'unavailable');
      if (r.status === 429) return outcomeOf(attempt, 'rate_limited');
      return outcomeOf(attempt, 'failed', { reason: typeof err === 'string' ? err : `http ${r.status}` });
    }
  }

  return {
    get configured() { return cfg.ok; },
    get pendingCount() { return pending.size; },

    async begin({ label, planHash, senderId, channelId = null, enroll = false }) {
      if (!cfg.ok) throw new WorldError('not_configured', `World ID approval is not configured (missing ${cfg.missing.join(', ')})`);
      if (enroll && !allowEnroll) throw new WorldError('failed', 'enrolment is only available from the host script');
      if (pending.size >= maxPending) throw new WorldError('busy', 'Too many approvals are waiting. Finish or let one expire first.');
      for (const a of pending.values()) {
        if (a.senderId === senderId) throw new WorldError('already_pending', 'You already have a payout waiting for World ID approval. Approve or decline that one first.');
        if (label && a.label === label) throw new WorldError('already_pending', `Round ${label} is already waiting for World ID approval.`);
      }

      // Reserve the slot BEFORE any network call: two simultaneous requests must
      // not both pass the checks above before either is registered.
      const attempt = {
        id: randomUUID(), label, planHash, senderId, channelId, enroll,
        deviceCode: null, intervalS: DEFAULT_INTERVAL_S, startedAtMs: 0, expiresAtMs: 0,
        cancelled: false, abort: new AbortController(),
      };
      pending.set(attempt.id, attempt);
      const release = () => pending.delete(attempt.id);

      let meta;
      try { meta = await getMeta(); } catch (e) { release(); throw e; }
      const claims = JSON.stringify({ id_token: { acr: { essential: true, values: cfg.acr } } });
      let r;
      try {
        r = await postForm(fetchImpl, meta.device_authorization_endpoint, {
          client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: 'openid', ...(sendClaims ? { claims } : {}),
        }, REQUEST_TIMEOUT_MS);
        if (debug) log.error?.(`[world] device start -> http ${r.status} fields: ${Object.keys(r.body ?? {}).join(',')} interval=${r.body?.interval} expires_in=${r.body?.expires_in} claims_sent=${sendClaims}`);
      } catch {
        release();
        throw new WorldError('unavailable', 'Could not reach World ID. Nothing was paid; try again shortly.');
      }
      if (r.status === 429) { release(); throw new WorldError('rate_limited', 'World ID is rate-limiting approvals. Try again in a minute.'); }
      if (r.status !== 200 || !r.body.device_code || !r.body.user_code) {
        release();
        throw new WorldError('failed', `World ID refused to start an approval (${r.body?.error ?? `http ${r.status}`}).`);
      }

      const startedAtMs = now();
      const lifetimeS = Math.min(Number(r.body.expires_in) || MAX_LIFETIME_S, MAX_LIFETIME_S);
      attempt.deviceCode = r.body.device_code; // never leaves this module
      attempt.intervalS = Math.max(1, Number(r.body.interval) || DEFAULT_INTERVAL_S);
      attempt.startedAtMs = startedAtMs;
      attempt.expiresAtMs = startedAtMs + lifetimeS * 1000;

      const done = run(attempt, meta)
        .catch((e) => outcomeOf(attempt, 'failed', { reason: e?.message ?? 'error' }))
        .then((outcome) => {
          pending.delete(attempt.id);
          try {
            audit({
              event: 'world_approval', ts: new Date().toISOString(), attemptId: attempt.id, label, planHash, senderId,
              outcome: outcome.status, reason: outcome.reason ?? null,
              sub: outcome.approver?.sub ?? null, acr: outcome.approver?.acr ?? null, amr: outcome.approver?.amr ?? null, authTime: outcome.approver?.authTime ?? null,
            });
          } catch (e) {
            log.error?.('[world] audit write failed:', e?.message ?? e);
            if (outcome.status === 'approved') return outcomeOf(attempt, 'failed', { reason: 'approval could not be recorded' });
          }
          return outcome;
        });

      return {
        id: attempt.id,
        userCode: r.body.user_code,
        verificationUri: r.body.verification_uri ?? null,
        verificationUriComplete: r.body.verification_uri_complete ?? null,
        expiresInSec: lifetimeS,
        done,
      };
    },

    cancel(id) {
      const a = pending.get(id);
      if (!a) return false;
      a.cancelled = true; a.abort.abort();
      return true;
    },
    cancelAll() { for (const id of [...pending.keys()]) this.cancel(id); },
  };
}
