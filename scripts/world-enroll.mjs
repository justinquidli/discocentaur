#!/usr/bin/env node
// One-time, host-only: learn a treasurer's World ID subject so it can be put on
// the allowlist. Deliberately NOT a Discord command — if enrolment were
// reachable from chat, whoever held the owner's Discord account could enrol
// their own World ID and the approval step would protect nothing.
//
//   node scripts/world-enroll.mjs
//
// Needs WORLD_ID_CLIENT_ID and WORLD_ID_CLIENT_SECRET (and WORLD_ID_ISSUER for
// the sandbox) in .env. Prints the subject; it never prints the token.
import 'dotenv/config';
import { createWorldGate, loadWorldConfig } from '../world-id.js';

const cfg = loadWorldConfig();
if (!cfg.clientId || !cfg.clientSecret) {
  console.error('Set WORLD_ID_CLIENT_ID and WORLD_ID_CLIENT_SECRET in .env first.');
  process.exit(2);
}

// The allowlist is what we are about to build, so it may be empty here.
const gate = createWorldGate({ cfg: { ...cfg, ok: true }, allowEnroll: true, debug: !!process.env.WORLD_ID_DEBUG });

let attempt;
try {
  attempt = await gate.begin({ senderId: 'host-enrol', enroll: true });
} catch (e) {
  console.error(`Could not start: ${e.message}`);
  process.exit(1);
}

console.log(`\nIssuer: ${cfg.issuer}`);
console.log(`Open ${attempt.verificationUriComplete ?? attempt.verificationUri ?? '(see World app)'}`);
console.log(`Code:  ${attempt.userCode}`);
console.log(`Approve in the World app within ${Math.round(attempt.expiresInSec / 60)} minutes. Only approve a check you started.\n`);

const out = await attempt.done;
if (out.status !== 'enrolled') {
  console.error(`Not enrolled: ${out.status}${out.reason ? ` — ${out.reason}` : ''}`);
  process.exit(1);
}
console.log('Enrolled. Add this to .env, then restart the bot (pm2 restart <name> --update-env):\n');
console.log(`WORLD_ID_TREASURER_SUBS=${out.approver.sub}\n`);
console.log(`(acr ${out.approver.acr}, amr ${JSON.stringify(out.approver.amr)}). Several treasurers: comma-separate their subjects.`);
