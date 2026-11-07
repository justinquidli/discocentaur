# World ID Agent Pass — integration debrief

Project: DiscoCentaur (Discord bot) — World ID approval gates crypto payouts to contributors.
Integration: OIDC Device Authorization Grant, `client_secret_post`, production issuer `https://auth.world.org`.

## What was built
A payout is proposed and the split saved as a round file. The owner gets a World ID link by DM. The
payout runs only if the ID token validates (signature, issuer, audience, expiry, `auth_time` of this
attempt, Orb-class `acr`, a World ID proof in `amr` and not a passkey, unused `jti`, allowlisted
`sub`) **and** the round file still matches the hash the owner was shown **and** the approval was
written to an audit log first. Any other outcome — denied, expired, wrong person, stale, replayed,
World unavailable, edited round — pays nothing. Verified by 46 new tests and `npm run demo:world`
(local stand-in for World; dummy payout).

## Status of the live run — please read
**The approved path was NOT demonstrated against live World.** On 7 Nov 2026 (about 09:48–10:20 IST)
the device request was created correctly on both the sandbox and production issuers (the approval
page shows the app name, "Requires Orb", and the matching code). In the World App the proof was
shared (the app showed "successfully shared proofs anonymously"), but the token endpoint kept returning
`authorization_pending` and the approval page reset without an error. Tried: QR scan from a desktop
page and the phone route, several times. The docs say an unmet essential `acr` returns
`access_denied`, so this does not look like an assurance mismatch. Transaction references: …1fe3e205, …13c6582d, …3240c2a5.
The denied/expired/wrong-human/tampered-round paths are demonstrated with local signed tokens.

## Time to first success
- The first device request was created at about 09:48 IST on 7 Nov, as soon as sandbox credentials were in place (production followed about 10 minutes later).
- No successful live approval yet (see above). The sandbox route would add the TestFlight invite
  plus about one hour of identity issuance.

## Friction
1. **Sandbox access has no self-serve path.** A test identity needs the sandbox app via TestFlight
   from an "integration contact", then about an hour of issuance during which the app looks ready
   but authentication can fail.
2. **A stuck approval gives no signal.** The app reports success; the token endpoint stays
   `authorization_pending` with no error, status or diagnostic. There is nothing to check on either side.
3. **The human never sees the action.** `binding_message` is unsupported, so the approval page shows
   only the requester name and a code. For payments the application has to display and bind the
   action itself, and the ID token carries no action information.
4. **Client secrets are shown once** and masked afterwards, and a portal session can expire while
   the one-time secret is on screen.
5. **The approval page looked different in the two browsers used** (a QR and "Continue with World ID" in one, passkey only in the other), and a passkey cannot satisfy a proof-based requirement, which is easy to misread.

## Missing capability or documentation
- A troubleshooting entry for "device grant stays `authorization_pending` after the app shows success".
- A status or introspection endpoint for a pending device authorization.
- A way to see per-client recent authorization attempts and their failure reasons in the portal.
- A documented account-eligibility check before sign-up (`account_not_eligible` is mentioned only
  in the troubleshooting table).

## Highest-impact improvement
**Signed action binding for the device grant** (`binding_message` shown to the human and signed into
the ID token, or an action-approval receipt). World currently proves who approved but not what, so
every integrator re-implements hash binding and the human approves blind. Second: make a stuck
device authorization observable.
