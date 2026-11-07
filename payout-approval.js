/**
 * Payout approval: ties a World ID check to one specific saved round.
 *
 * Flow: hash the round file -> start a World ID device attempt bound to that
 * hash -> when (and only when) the attempt is approved, re-hash the round; if
 * it changed, refuse -> record who approved -> run the payout once.
 *
 * World proves WHO approved, never WHAT. The hash is what makes "what" hold:
 * the round the owner was shown is byte-for-byte the round that gets paid.
 *
 * Discord-free so tests can import it. Every non-approved outcome pays nothing.
 */

const MESSAGES = {
  denied: 'You declined in World ID. Nothing was paid.',
  expired: 'The World ID approval expired (codes last 20 minutes). Nothing was paid.',
  cancelled: 'The approval was cancelled. Nothing was paid.',
  wrong_human: 'That World ID is not a registered treasurer. Nothing was paid.',
  insufficient_assurance: 'That World ID check did not meet the required assurance (a fresh Orb-verified proof). Nothing was paid.',
  stale: 'That authentication was not fresh for this approval. Nothing was paid.',
  invalid_token: 'World ID\'s response failed validation. Nothing was paid.',
  replayed: 'That World ID response was already used. Nothing was paid.',
  unavailable: 'World ID is unavailable right now. Nothing was paid — ask again shortly.',
  rate_limited: 'World ID is rate-limiting approvals. Nothing was paid — try again in a minute.',
  failed: 'The World ID approval failed. Nothing was paid.',
  plan_changed: 'The saved round changed after you were shown it, so it was not paid. Ask for a fresh proposal.',
  restarting: 'The bot is restarting. Nothing was paid — ask again in a minute.',
  not_recorded: 'The approval could not be recorded, so nothing was paid.',
};

export const outcomeMessage = (status) => MESSAGES[status] ?? MESSAGES.failed;

/** One-screen result for the channel, same shape the old confirm path used. */
export function formatPayoutResult(result, label) {
  const icon = { ok: '✅', unknown: '⚠️', not_paid: '⚠️' }[result?.status] ?? '❌';
  const detail = result?.status === 'ok' ? result.output : (result?.error ?? result?.output ?? 'no detail');
  return `${icon} round \`${result?.label ?? label ?? '?'}\`:\n\`\`\`\n${String(detail).slice(0, 1500)}\n\`\`\``;
}

export function createPayoutApprover({
  gate, roundHash, execute, audit = () => {}, track = (p) => p, isStopping = () => false, log = console,
}) {
  const executing = new Set(); // labels whose payout is running right now

  async function settle({ label, planHash, senderId }, outcome, { onApproved, onResult }) {
    const say = async (r) => { try { await onResult(r); } catch (e) { log.error?.('[payout-approval] result delivery failed:', e?.message ?? e); } };
    const refuse = (status, extra = {}) => say({ ok: false, executed: false, status, text: outcomeMessage(status), ...extra });

    if (outcome.status !== 'approved') return refuse(outcome.status, { reason: outcome.reason });
    if (isStopping()) return refuse('restarting');

    // The round the owner saw must be the round that is paid.
    if (roundHash(label) !== planHash) {
      try { audit({ event: 'plan_changed', ts: new Date().toISOString(), label, planHash, senderId, sub: outcome.approver.sub }); } catch { /* already refusing */ }
      return refuse('plan_changed');
    }
    if (executing.has(label)) return refuse('failed', { reason: 'already being paid' });

    executing.add(label);
    try {
      // Fail closed: if we cannot record who approved, we do not pay.
      try {
        audit({ event: 'payout_start', ts: new Date().toISOString(), label, planHash, senderId, sub: outcome.approver.sub, acr: outcome.approver.acr, authTime: outcome.approver.authTime });
      } catch (e) {
        log.error?.('[payout-approval] audit write failed:', e?.message ?? e);
        return refuse('not_recorded');
      }
      try { await onApproved?.(outcome.approver); } catch { /* progress message only */ }

      let result;
      try {
        result = await track(execute({ label }));
      } catch (e) {
        // A throw after the child started may still have paid: report unknown, never "nothing paid".
        result = { status: 'unknown', error: `payout run threw (${String(e?.message ?? e).slice(0, 200)}) — check the Connect wallet before asking again` };
      }
      try { audit({ event: 'payout_result', ts: new Date().toISOString(), label, planHash, senderId, sub: outcome.approver.sub, status: result.status, txHashes: result.txHashes ?? [] }); } catch { /* result is already known */ }
      return say({ ok: result.status === 'ok', executed: !!result.executed, status: result.status, result, text: formatPayoutResult(result, label) });
    } finally {
      executing.delete(label);
    }
  }

  return {
    /**
     * Start an approval. Returns { ok:true, userCode, verificationUri(Complete), expiresInSec, cancel }
     * or { ok:false, error, code }. `onResult` is called exactly once later with the outcome;
     * `onApproved` (optional) is called after approval but before the payout starts.
     */
    async request({ label, senderId, channelId = null, onApproved, onResult }) {
      if (isStopping()) return { ok: false, code: 'restarting', error: outcomeMessage('restarting') };
      if (executing.has(label)) return { ok: false, code: 'already_pending', error: `Round ${label} is already being paid.` };
      const planHash = roundHash(label);
      if (!planHash) return { ok: false, code: 'no_round', error: `Round ${label} could not be read, so there is nothing to approve.` };

      let attempt;
      try {
        attempt = await gate.begin({ label, planHash, senderId, channelId });
      } catch (e) {
        return { ok: false, code: e?.code ?? 'failed', error: e?.message ?? 'could not start the approval' };
      }
      attempt.done
        .then((outcome) => settle({ label, planHash, senderId }, outcome, { onApproved, onResult }))
        .catch((e) => log.error?.('[payout-approval] settle failed:', e?.message ?? e));

      return {
        ok: true, planHash,
        userCode: attempt.userCode, verificationUri: attempt.verificationUri, verificationUriComplete: attempt.verificationUriComplete,
        expiresInSec: attempt.expiresInSec, cancel: () => gate.cancel(attempt.id),
      };
    },
  };
}
