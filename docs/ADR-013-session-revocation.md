# docs/ADR-013 — Session revocation: stateless sessions stay, with an 8h cap, a 2h idle timeout, and secret rotation as the emergency kill switch

**Status:** Accepted (2026-10-06)
**Date:** 2026-10-05
**Revision:** 2 (2026-11-03: adds D5, the 2h idle timeout)
**Authors:** Scholars Profile System development team
**Resolves:** #1454 (from #1439 Finding 4, Low)
**Supersedes:** —
**Superseded by:** —

## Context

Sessions are stateless, AEAD-sealed iron-session cookies with no server-side store (`lib/auth/session.ts`). To validate a request, `readSessionValue` unseals the cookie and checks the sealed `exp`, and nothing more. Logout (`app/api/auth/logout/route.ts`) clears only the caller's own cookie. A copy of the cookie held somewhere else stays valid until its `exp`.

What already limits a leaked cookie:

- `httpOnly`, so page script cannot read the cookie, which is the main way cookies get stolen.
- `secure` and `SameSite=lax`.
- The `__Host-sps_session` name. The `__Host-` prefix makes the browser require `Secure`, `Path=/` and no `Domain`, so a sibling subdomain cannot set, overwrite or shadow the session cookie (ASVS 5.0 V3.3.3).
- A hard cap at sealing time: `ttlSeconds = min(SESSION_MAX_AGE_SECONDS, MAX_SESSION_TTL_SECONDS)`, where the cap is 8h (`lib/auth/config.ts`). `readSessionValue` also re-checks the sealed `exp`, so raising the TTL later cannot extend a cookie that has already been issued.
- `SESSION_MAX_AGE_SECONDS` is not set in the app task definition (`cdk/lib/app-stack.ts`), so prod runs at the 8h cap.

#1454 asks for one of two outcomes: a way to invalidate an issued session before its `exp`, or a recorded decision that TTL limits plus SLO are enough.

## Decision

**D1. No per-session revocation store.** We will not add a `jti` with a TTL-bounded denylist. That design adds a store read to every authenticated request. It ties authentication availability to that store and gives up the stateless cookie design. The risk it would remove is rated Low, and the cap below already limits it.

**D2. The emergency kill switch is rotating the cookie secret.** Changing `SESSION_COOKIE_SECRET` makes every outstanding cookie fail to unseal. `readSessionValue` returns `null` for "sealed with a different key", so this logs out everyone at once. The procedure: write a new value of 32+ characters to the app's session-cookie secret in Secrets Manager, then force a new deployment of the app service, because tasks read the secret only at start. The cost is that every signed-in editor has to log in again. That is acceptable for an incident and too blunt for routine use, which is why D1 is not replaced by "rotate on every logout".

**D3. Keep the 8h cap. Shortening it is a lever, not a default.** `SESSION_MAX_AGE_SECONDS` can shrink the window with no code change: a per-env task-def entry in `cdk/lib/app-stack.ts` and a manual `cdk deploy Sps-App-<env>`. We leave it at 8h. A full working day without logging in again matters for the people who do curation in `/edit`, and D2 covers the case where a known leak needs ending before `exp`.

**D4. SAML Single Logout is deferred, not rejected.** IdP-initiated SLO would end the app session when the user logs out at WCM. It is the only option here that improves the routine case, but it needs WCM IdP work (an SLO endpoint registered on the SP), and #649 shows that WCM-side SP changes are slow. Revisit it if the IdP registration is reopened for the staging ACS.

**D5. A 2h idle timeout on top of the 8h cap (added 2026-11-03, Revision 2).** An `/edit` session unused for 2h is rejected, even though its 8h `exp` has not passed. This is a documented risk decision for ASVS 5.0 V7.1.1 (session timeouts are documented and justified) and V7.3.1 (an inactivity timeout enforces re-authentication).

How it works, still with no server-side store (D1 stands):

- The sealed payload carries `lastSeen` (epoch seconds) next to `iat` and `exp`. `readSessionValue` rejects the session when `now - lastSeen` exceeds the idle timeout, and still rejects it when `now` passes `exp`.
- The proxy (`proxy.ts`) slides the window. On an authenticated `/edit*`, `/api/edit*` or `/api/impersonation*` request whose `lastSeen` is at least 5 minutes old, it re-seals the cookie with `lastSeen` = now and sets it on the response. The re-seal keeps the original `iat` and `exp`, and its seal ttl and cookie `maxAge` are the time remaining to that `exp`, so activity never extends the 8h cap. The proxy is the only layer that sees every gated request and can set a response cookie; Server Components cannot.
- Activity on public pages does not count. Those requests take the proxy's public fast path and never touch the session.
- An idle-expired session takes the normal unauthenticated path: a redirect to SSO login for a page, a bare 401 for an API call.
- Cookies sealed before this revision carry no `lastSeen`. They are accepted and stamped on their next gated request rather than measured from `iat`, which would have signed out every editor whose session started more than 2h before the deploy. Their `exp` still bounds them, so none outlives the 8h cap.
- `SESSION_IDLE_TIMEOUT_SECONDS` overrides the 7200s default, clamped to between 60s and the absolute ttl. The default is right for both environments, so it is not wired in the task definitions.

Why 2h:

- SPS uses WCM SSO only and holds no password. A stolen cookie grants an `/edit` session, not a credential that works anywhere else.
- Most of what `/edit` shows is public profile data.
- `getEffectiveEditSession` re-reads every role on each request, so removing a grant takes effect immediately, idle or not.
- The 8h absolute cap is kept (D3).
- Re-login goes through WCM SSO and is usually one click while the IdP session is alive, so the cost of a timeout is small.
- NIST SP 800-63B AAL2's 30-minute inactivity timeout was considered and rejected as disproportionate for this console. Curation work in `/edit` routinely pauses for longer than 30 minutes (reading a paper, checking a source system), and a re-login that often would push editors toward working around the console, without a matching gain given the points above.

## Consequences

- A user's own logout still cannot invalidate a copied cookie. The exposure is bounded by `httpOnly`, by an 8h maximum, and (since D5) by 2h of non-use: a copied cookie stays valid only while someone keeps using it.
- Since D5, an editor who leaves `/edit` idle for 2h signs in again through WCM SSO. Gated responses carry a refreshed `Set-Cookie` at most once every 5 minutes.
- Revoking one user's session alone (for example a departed editor) is not possible. The options are revoking everyone (D2), or removing the user's grants: the cookie carries only the CWID and `getEffectiveEditSession` (`lib/auth/effective-identity.ts`) re-reads every role on each request, so a valid session whose grants were removed opens nothing role-gated in `/edit`.
- The secret-rotation procedure belongs in `docs/OPERATIONS-RUNBOOK.md` when this ADR is accepted.

## Alternatives considered

| Option | Why not now |
|---|---|
| `jti` + denylist checked in `readSessionValue` | A store read on every request, auth availability coupled to the store, for a Low finding (D1) |
| Shorten the TTL to 2–4h | Possible with no code change, but it costs editors a mid-day re-login, and D2 already covers known leaks (D3) |
| Rotate the secret on every logout | Logs out every other user too |
| SAML SLO | Needs WCM IdP changes; deferred (D4) |
| 30-minute idle timeout (NIST 800-63B AAL2) | Disproportionate for an SSO-only console over mostly public data with per-request role checks; 2h chosen instead (D5) |
| Re-seal the cookie on every request | A `Set-Cookie` on every gated response for no security gain; the 5-minute refresh threshold is immaterial against a 2h window (D5) |
