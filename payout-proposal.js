// Bridge to the contributor-payout agent.
//
// A proposal is a dry run: nothing is signed and no contributor gets a wallet
// provisioned. Paying (payoutExecute) happens only after the owner's !confirm,
// and reads every amount from the saved round file — a Discord message can
// name a round, and nothing else about what moves.
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

// A model that asks for the same proposal twice gets the same answer. Scoring
// is not deterministic, so without this a second call returns a DIFFERENT split
// and the user ends up confirming numbers they never read.
const recent = new Map();
const RECENT_TTL_MS = Number(process.env.PAYOUT_REPROPOSE_TTL_MS ?? 15 * 60 * 1000);

export async function payoutProposal({ repo: rawRepo, since = '14d', token = 'USDC', budget }) {
  const repo = normaliseRepo(rawRepo);
  if (!REPO.test(repo)) return { status: 'refused', error: `could not read a repo out of "${String(rawRepo ?? '').slice(0, 80)}" — paste its GitHub URL, or give owner/name` };
  if (!SINCE.test(since)) return { status: 'refused', error: 'since must look like 14d or 48h' };
  if (!TOKEN.test(token)) return { status: 'refused', error: 'token must be a symbol or a 0x address' };
  if (!/^\d+(\.\d+)?$/.test(String(budget ?? ''))) return { status: 'refused', error: 'budget must be a number' };
  if (!existsSync(resolve(DIR, 'payout.js'))) return { status: 'refused', error: `contributor-payout not found at ${DIR}` };

  // Keyed on the repo alone. A model that re-asks rarely re-asks identically —
  // "3d" becomes "72h", the symbol becomes a contract address — and any
  // difference used to produce a second, different split for the same request.
  const key = repo.toLowerCase();
  const seen = recent.get(key);
  if (seen && Date.now() - seen.at < RECENT_TTL_MS && existsSync(roundPath(seen.label))) {
    return { ...seen.result, reused: true };
  }

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
  const result = { status: 'ok', executed: false, label: wrote ? label : null, proposal: trim(out) };
  if (wrote) recent.set(key, { label, result, at: Date.now() });
  return result;
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

  const all = (out + err).split('\n').filter(Boolean);
  // Keep the END of the output: the tx hashes are the last thing printed, and
  // truncating from the start threw away the only part that proves anything.
  const tail = all.slice(-14).join('\n').slice(-1400);

  if (signal === 'SIGKILL') {
    return { status: 'unknown', error: `timed out after ${EXEC_TIMEOUT_MS / 1000}s — check ledger.json and Basescan before re-running`, output: tail };
  }
  if (code !== 0) return { status: 'failed', executed: false, error: tail || `exited ${code}` };

  // Exit 0 does NOT mean paid. payout.js exits 0 when the rails reject a plan
  // and when there is nothing to pay, so success is proven by transactions in
  // the output, never by the exit code.
  const hashes = [...(out + err).matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0]);
  const sent = /^Sent\.$/m.test(out) && hashes.length > 0;
  if (!sent) {
    const why = /Rails rejected|✗/.test(out) ? 'the rails rejected the plan'
      : /Nothing to pay/.test(out) ? 'every contributor was allocated 0'
      : /Cancelled/.test(out) ? 'the run was cancelled'
      : 'the run finished without broadcasting anything';
    return { status: 'not_paid', executed: false, error: `No payment was made: ${why}.`, output: tail };
  }
  return { status: 'ok', executed: true, label, txHashes: hashes, output: tail };
}

/**
 * A one-screen summary of a saved round, read straight from the file.
 * The bot prints this when it asks for confirmation, so what a person approves
 * is the actual split — not whatever the model chose to say about it.
 */
export function summariseRound(label) {
  if (!LABEL.test(label ?? '')) return null;
  const path = roundPath(label);
  if (!existsSync(path)) return null;
  let r;
  try { r = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  const lines = (r.contributors ?? []).map(
    (c) => `  @${c.github} — ${c.amount} ${r.token?.symbol ?? ''} (${c.share})`,
  );
  return [
    `${r.repo} · ${r.total} ${r.token?.symbol ?? ''} to ${lines.length} contributor(s)`,
    ...lines,
    r.summary ? `\n${r.summary}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Every parameter must be traceable to what the user actually wrote.
 *
 * The failures here were never the scorer: they were the model supplying a
 * parameter nobody asked for — a 14d window when the user said 3 days, a
 * budget or repo it inferred — and the result looking perfectly reasonable.
 * A wrong window silently pays a different set of people. So rather than
 * trusting the extraction, check it against the message and refuse when a
 * value cannot be found there.
 */
const WINDOW_WORDS = {
  today: '1d', yesterday: '2d', week: '7d', fortnight: '14d', month: '30d', quarter: '90d',
};

export function groundCheck({ repo, budget, since }, userText) {
  const text = String(userText ?? '').toLowerCase();
  if (!text) return null; // nothing to check against (confirm path, tests)

  const name = normaliseRepo(repo).split('/')[1]?.toLowerCase();
  if (!name || !text.includes(name)) {
    return `the repo "${normaliseRepo(repo)}" does not appear in the request`;
  }

  const amount = String(budget).replace(/[,_]/g, '');
  if (!text.replace(/[,_]/g, '').includes(amount)) {
    return `the budget "${budget}" does not appear in the request`;
  }

  const m = String(since ?? '').match(/^(\d+)([dh])$/);
  if (!m) return `the window "${since}" is not a number of days or hours`;
  const [, qty, unit] = m;
  const unitWord = unit === 'd' ? 'day' : 'hour';
  const spelled = new RegExp(`\\b${qty}\\s*(${unitWord}s?|${unit})\\b`);
  const phrase = Object.entries(WINDOW_WORDS).some(([word, w]) => w === since && text.includes(word));
  if (!spelled.test(text) && !phrase) {
    return `the window "${since}" does not appear in the request`;
  }
  return null;
}
