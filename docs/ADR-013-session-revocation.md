# docs/ADR-013 — Session revocation: stateless sessions stay, with an 8h cap and secret rotation as the emergency kill switch

**Status:** Proposed
**Date:** 2026-10-05
**Revision:** 1
**Authors:** Scholars Profile System development team
**Resolves:** #1454 (from #1439 Finding 4, Low)
**Supersedes:** —
**Superseded by:** —

## Context

Sessions are stateless, AEAD-sealed iron-session cookies with no server-side store (`lib/auth/session.ts`). To validate a request, `readSessionValue` unseals the cookie and checks the sealed `exp`, and nothing more. Logout (`app/api/auth/logout/route.ts`) clears only the caller's own cookie. A copy of the cookie held somewhere else stays valid until its `exp`.

What already limits a leaked cookie:

- `httpOnly`, so page script cannot read the cookie, which is the main way cookies get stolen.
- `secure` and `SameSite=lax`.
- A hard cap at sealing time: `ttlSeconds = min(SESSION_MAX_AGE_SECONDS, MAX_SESSION_TTL_SECONDS)`, where the cap is 8h (`lib/auth/config.ts`). `readSessionValue` also re-checks the sealed `exp`, so raising the TTL later cannot extend a cookie that has already been issued.
- `SESSION_MAX_AGE_SECONDS` is not set in the app task definition (`cdk/lib/app-stack.ts`), so prod runs at the 8h cap.

#1454 asks for one of two outcomes: a way to invalidate an issued session before its `exp`, or a recorded decision that TTL limits plus SLO are enough.

## Decision

**D1. No per-session revocation store.** We will not add a `jti` with a TTL-bounded denylist. That design adds a store read to every authenticated request. It ties authentication availability to that store and gives up the stateless cookie design. The risk it would remove is rated Low, and the cap below already limits it.

**D2. The emergency kill switch is rotating the cookie secret.** Changing `SESSION_COOKIE_SECRET` makes every outstanding cookie fail to unseal. `readSessionValue` returns `null` for "sealed with a different key", so this logs out everyone at once. The procedure: write a new value of 32+ characters to the app's session-cookie secret in Secrets Manager, then force a new deployment of the app service, because tasks read the secret only at start. The cost is that every signed-in editor has to log in again. That is acceptable for an incident and too blunt for routine use, which is why D1 is not replaced by "rotate on every logout".

**D3. Keep the 8h cap. Shortening it is a lever, not a default.** `SESSION_MAX_AGE_SECONDS` can shrink the window with no code change: a per-env task-def entry in `cdk/lib/app-stack.ts` and a manual `cdk deploy Sps-App-<env>`. We leave it at 8h. A full working day without logging in again matters for the people who do curation in `/edit`, and D2 covers the case where a known leak needs ending before `exp`.

**D4. SAML Single Logout is deferred, not rejected.** IdP-initiated SLO would end the app session when the user logs out at WCM. It is the only option here that improves the routine case, but it needs WCM IdP work (an SLO endpoint registered on the SP), and #649 shows that WCM-side SP changes are slow. Revisit it if the IdP registration is reopened for the staging ACS.

## Consequences

- A user's own logout still cannot invalidate a copied cookie. The exposure is bounded by `httpOnly` and by an 8h maximum.
- Revoking one user's session alone (for example a departed editor) is not possible. The options are revoking everyone (D2), or removing the user's grants: the cookie carries only the CWID and `getEffectiveEditSession` (`lib/auth/effective-identity.ts`) re-reads every role on each request, so a valid session whose grants were removed opens nothing role-gated in `/edit`.
- The secret-rotation procedure belongs in `docs/OPERATIONS-RUNBOOK.md` when this ADR is accepted.

## Alternatives considered

| Option | Why not now |
|---|---|
| `jti` + denylist checked in `readSessionValue` | A store read on every request, auth availability coupled to the store, for a Low finding (D1) |
| Shorten the TTL to 2–4h | Possible with no code change, but it costs editors a mid-day re-login, and D2 already covers known leaks (D3) |
| Rotate the secret on every logout | Logs out every other user too |
| SAML SLO | Needs WCM IdP changes; deferred (D4) |
