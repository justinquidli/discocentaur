// The same payment twice in a row is almost always a mistake: a message sent
// twice, a paste, a retry after a slow reply. The second one waits for
// !confirm / /confirm instead of paying again.
//
// A send is claimed before it runs, so two copies arriving at the same moment
// can't both pass. A send that fails is released, so retrying it is not held.

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/^@/, '');

export function paymentKey(senderId, input) {
  const recipients = (Array.isArray(input?.recipients) ? input.recipients : [])
    .map((r) => `${norm(r?.type)}:${norm(r?.id ?? r?.username ?? r?.value)}`)
    .sort()
    .join(',');
  return [String(senderId), norm(input?.chainId), norm(input?.tokenContract) || 'native', norm(input?.amountInWeiPerRecipient), recipients].join('|');
}

export function createRepeatGuard({ windowMs = 120_000, now = () => Date.now() } = {}) {
  const seen = new Map(); // key -> time claimed
  const prune = () => { const t = now(); for (const [k, at] of seen) if (t - at > windowMs) seen.delete(k); };
  return {
    /** Seconds since the same payment was sent or started, or null. Claims it when null. */
    claim(senderId, input) {
      prune();
      const key = paymentKey(senderId, input);
      const at = seen.get(key);
      if (at != null) return Math.max(1, Math.round((now() - at) / 1000));
      seen.set(key, now());
      return null;
    },
    /** A confirmed or completed send counts as sent now. */
    mark(senderId, input) { seen.set(paymentKey(senderId, input), now()); },
    /** The send failed: a retry is not a repeat. */
    release(senderId, input) { seen.delete(paymentKey(senderId, input)); },
  };
}

export function repeatNote(secondsAgo, cmd = '!') {
  const when = secondsAgo < 60 ? `${secondsAgo}s` : `${Math.round(secondsAgo / 60)} min`;
  return `-# You sent this same payment ${when} ago. \`${cmd}confirm\` to pay it again, or \`${cmd}cancel\`.`;
}
