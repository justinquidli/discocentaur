// Read-only bridge to the contributor-payout agent.
//
// The bot can ask for a PROPOSAL and nothing else: the child process runs a dry
// run, so no wallet is touched, nothing is signed, and no contributor gets a
// wallet provisioned. Execution stays on the operator's terminal on purpose —
// a Discord message is untrusted input, and nothing reachable from one should
// be able to move money.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = process.env.PAYOUT_DIR || resolve(process.cwd(), '../contributor-payout');
const TIMEOUT_MS = Number(process.env.PAYOUT_TIMEOUT_MS ?? 180_000);
const EXEC_TIMEOUT_MS = Number(process.env.PAYOUT_EXEC_TIMEOUT_MS ?? 600_000);
const MAX_CHARS = 1500; // Discord hard-caps at 2000; leave room for the model's reply.

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * People paste the URL, not the path — nobody thinks of a repo as "owner/name".
 * Accept any github.com link (with or without scheme, .git, trailing slash, or
 * a deeper path like /pull/3) and reduce it to owner/name.
 */
export function normaliseRepo(value) {
  let v = String(value ?? '').trim();
  v = v.replace(/^<|>$/g, '');                       // Discord wraps pasted links
  v = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  v = v.replace(/^github\.com\//i, '');
  v = v.replace(/\.git$/i, '');
  const parts = v.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : v;
}
const SINCE = /^\d{1,3}[dh]$/;
const TOKEN = /^(0x[0-9a-fA-F]{40}|[A-Za-z0-9]{1,12})$/;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;

const roundPath = (label) => resolve(DIR, 'rounds', `${label}.json`);

/** Run the payout CLI and hand back its output. */
function run(args, timeoutMs) {
  return new Promise((done) => {
    const child = spawn('node', args, { cwd: DIR, env: process.env });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); done({ code: -1, out, err: e.message }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, out, err });
    });
  });
}

/** Keep only the part a reader cares about: the PRs, the split, the shares. */
function trim(out) {
  const start = out.indexOf('\n\n' + out.match(/^\S+\/\S+: \d+ merged/m)?.[0]);
  const body = start > 0 ? out.slice(start) : out;
  // A proposal ends at the share table: resolution and payer balances are
  // execution concerns and only confuse someone reading this in a chat.
  const stop = body.search(/^(Skipping Connect resolution|Resolving GitHub usernames|Payer \()/m);
  const cut = stop > 0 ? body.slice(0, stop) : body;
  const cleaned = cut.replace(/^\s*>\s.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length > MAX_CHARS ? cleaned.slice(0, MAX_CHARS) + '\n… (truncated)' : cleaned;
}

export async function payoutProposal({ repo: rawRepo, since = '14d', token = 'USDC', budget }) {
  const repo = normaliseRepo(rawRepo);
  if (!REPO.test(repo)) return { status: 'refused', error: `could not read a repo out of "${String(rawRepo ?? '').slice(0, 80)}" — paste its GitHub URL, or give owner/name` };
  if (!SINCE.test(since)) return { status: 'refused', error: 'since must look like 14d or 48h' };
  if (!TOKEN.test(token)) return { status: 'refused', error: 'token must be a symbol or a 0x address' };
  if (!/^\d+(\.\d+)?$/.test(String(budget ?? ''))) return { status: 'refused', error: 'budget must be a number' };
  if (!existsSync(resolve(DIR, 'payout.js'))) return { status: 'refused', error: `contributor-payout not found at ${DIR}` };

  // The label ties this proposal to a file on disk, so the split that gets
  // executed later is the one people actually read here — not a second,
  // possibly different answer from the model.
  const label = `dc-${repo.replace(/[^A-Za-z0-9]+/g, '-')}-${Date.now().toString(36)}`;

  // --payer connect keeps the signing wallet out of this process entirely;
  // --skip-resolve means nobody gets a wallet provisioned by a chat message.
  const { code, signal, out, err } = await run([
    '--env-file=.env', 'payout.js',
    '--repo', repo, '--since', since, '--token', token,
    '--budget', String(budget), '--payer', 'connect', '--skip-resolve', '--round', label,
  ], TIMEOUT_MS);

  if (signal === 'SIGKILL') return { status: 'error', error: `timed out after ${TIMEOUT_MS / 1000}s` };
  if (code !== 0) {
    const reason = (err || out).split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
    return { status: 'error', executed: false, error: reason || `exited ${code}` };
  }
  const wrote = existsSync(roundPath(label));
  return { status: 'ok', executed: false, label: wrote ? label : null, proposal: trim(out) };
}

/**
 * Pay a proposal that already exists on disk. Everything comes from the round
 * file, not from the caller: the repo, the token and every amount. A chat
 * message can name a label, and nothing else about what moves.
 */
export async function payoutExecute({ label }) {
  if (!LABEL.test(label ?? '')) return { status: 'refused', error: 'label must be a round label' };
  const path = roundPath(label);
  if (!existsSync(path)) return { status: 'refused', error: `no round called ${label}` };

  let round;
  try { round = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { return { status: 'refused', error: `round ${label} is unreadable: ${e.message}` }; }
  if (round.status === 'paid') return { status: 'refused', error: `round ${label} was already paid` };
  if (!Array.isArray(round.contributors) || round.contributors.length === 0) {
    return { status: 'refused', error: `round ${label} has no contributors` };
  }

  const { code, signal, out, err } = await run([
    '--env-file=.env', 'payout.js',
    '--repo', round.repo, '--token', round.token.address, '--budget', String(round.total),
    '--payer', 'dynamic', '--plan-file', `rounds/${label}.json`, '--round', label,
    '--execute', '--yes', '--comment',
  ], EXEC_TIMEOUT_MS);

  const tail = (out + err).split('\n').filter(Boolean).slice(-12).join('\n').slice(0, 1200);
  if (signal === 'SIGKILL') {
    return { status: 'unknown', error: `timed out after ${EXEC_TIMEOUT_MS / 1000}s — check ledger.json and Basescan before re-running`, output: tail };
  }
  if (code !== 0) return { status: 'failed', executed: false, error: tail || `exited ${code}` };
  return { status: 'ok', executed: true, label, output: tail };
}
