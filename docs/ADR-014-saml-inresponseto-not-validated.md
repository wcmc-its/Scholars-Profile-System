# docs/ADR-014 — SAML InResponseTo is not validated; single-use, ACS binding and signature checks carry the load

**Status:** Proposed
**Date:** 2026-11-03
**Revision:** 1
**Authors:** Scholars Profile System development team
**Resolves:** ASVS review finding "SAML `validateInResponseTo` set to never"
**Supersedes:** —
**Superseded by:** —

## Context

The SAML SP (`lib/auth/saml.ts`, B01 #100) configures node-saml with `validateInResponseTo: ValidateInResponseTo.never` (`lib/auth/saml.ts:63`). node-saml therefore does not check that a SAMLResponse's `InResponseTo` matches an AuthnRequest this SP issued, and it accepts an unsolicited (IdP-initiated) response that carries no `InResponseTo` at all.

An ASVS review flagged this. This ADR records why the setting is `never`, what limits the exposure, and what enabling the check would take.

### History

- **#361 (4cef74a4, 2026-05-17), the B01 SSO foundation**, set `never` on purpose. The comment it shipped with: "Stateless: no server-side request-ID cache, so InResponseTo is not checked against one (B01 plan OQ6). Replay protection rests on the assertion signature, a tight NotOnOrAfter window, and the audience." The reason was statelessness across tasks. It was not chosen to support IdP-initiated login.
- **#1451 (1f6d9212, 2026-07-03), resolving #1439**, re-examined the setting while adding the single-use assertion store, and kept `never` on purpose. From the PR body: "`validateInResponseTo` intentionally stays `never`. node-saml's request-id cache is in-process and would not hold across tasks, so enabling it would intermittently fail legitimate logins; the shared store is the load-bearing control instead." The comment at `lib/auth/saml.ts:54-62` says the same.
- **#3154 (d2ef852d, 2026-10-26)** added the ACS binding and assertion-age checks (`checkResponseBinding`). These narrow what an unsolicited response can do.

### Does SPS need IdP-initiated login?

The repo contains no evidence that it does. Every login goes through the SP: `/edit` and `/api/edit*` redirect unauthenticated users to `app/api/auth/saml/login/route.ts`, which builds an AuthnRequest and carries the return path in `RelayState`. Nothing refers to an IdP portal, an app tile, or an unsolicited-SSO URL. IdP-initiated login works today only as a side effect of `never`. The callback treats a missing or unsafe `RelayState` as the default path (`app/api/auth/saml/callback/route.ts:149`), so an unsolicited response would land on `/edit`.

### Deployment constraint

The app runs as one Fargate task in staging and two in prod, with autoscaling above that (`cdk/lib/app-stack.ts`, `desiredCount` / `appMaxCount`). The ALB target group has no stickiness. node-saml's default `cacheProvider` is an in-process map, so an AuthnRequest issued on one task and a response validated on another would fail.

## Decision

**D1. Keep `validateInResponseTo: never`.** Do not change the code. The controls below already cover the main risks of accepting unsolicited responses: forgery, replay, cross-environment use, and stale assertions. What remains is login CSRF. Closing it properly needs per-browser request binding, not just a shared cache (D3). That is new state on the login path, for a residual risk rated Low.

**D2. Compensating controls (what an accepted response must satisfy):**

| Control | Where |
|---|---|
| Assertion must be signed by a trusted IdP cert. Response-envelope signature is configurable. | `lib/auth/saml.ts:37` (`idpCert`), `:47` (`wantAssertionsSigned: true`), `:48` (`wantAuthnResponseSigned`) |
| Issuer must equal the configured IdP entity ID | `lib/auth/saml.ts:67` (`idpIssuer`). `SAML_IDP_ENTITY_ID` is set in the task def, `cdk/lib/app-stack.ts:1434` |
| Audience must equal this SP's entity ID | `lib/auth/saml.ts:42` |
| NotBefore / NotOnOrAfter window with bounded clock skew (default 5 s) | node-saml, via `lib/auth/saml.ts:49` (`acceptedClockSkewMs`). Default in `lib/auth/config.ts:193` |
| Assertion age capped at 5 min after `IssueInstant` (node-saml and our own check) | `lib/auth/saml.ts:27` (`MAX_ASSERTION_AGE_MS`), `:53`, and `checkResponseBinding` `:342-347` |
| Response `Destination` and bearer `SubjectConfirmationData/@Recipient` must equal this env's ACS URL. Staging and prod share one SP entity ID, so audience alone cannot tell them apart. | `lib/auth/saml.ts:318-340` (`checkResponseBinding`), called at `:117` |
| Single use: each assertion is recorded in a shared MySQL table before a session is minted. A second presentation hits the primary key (`P2002`) and gets a 401, even on another task. A store failure fails closed with a 500. | `lib/auth/saml-assertion-store.ts:57-83`, `app/api/auth/saml/callback/route.ts:132-146`, model `SamlAssertionSeen` in `prisma/schema.prisma` |
| Post-login redirect confined to a safe same-origin path | `lib/auth/return-path.ts:138` (`safeReturnPath`), `app/api/auth/saml/callback/route.ts:149` |
| Authorization is re-read per request. A session carries only the CWID. | `lib/auth/effective-identity.ts` (see ADR-013) |

The residual risk is login CSRF. An attacker who holds a fresh, unconsumed assertion for their own account could make a victim's browser POST it to the ACS within the 5-minute window. The victim would then be signed in as the attacker. The victim could edit only what the attacker's own grants allow, and every write is audit-logged under the attacker's CWID. The attacker gains no access to the victim's account or data.

**D3. What enabling it would take.** Revisit this if the risk rating changes.

- **`ifPresent` adds almost nothing.** It checks only responses that carry `InResponseTo` and still accepts unsolicited ones without it (node-saml 5.1.0 `SAML.validateInResponseTo` / `mustValidateInResponseTo`). An attacker would use an unsolicited response. It still needs the shared cache below, so it has the full cost and close to no benefit.
- **`always` with a shared `cacheProvider` (for example a Prisma-backed `saml_request_id` table) is not enough on its own.** node-saml's cache is a global key-value store and is not tied to a browser. An attacker can start their own SP login, finish it at the IdP, and forward the resulting response, which carries a legitimately cached request ID, to the victim. That defeats login CSRF protection. The cost is a new table, a migration an operator has to apply, and a DB write plus a read and delete on every login. Login availability then also depends on that table.
- **Real binding needs a per-browser value.** The login route would set a short-lived, HttpOnly, signed cookie holding the AuthnRequest ID. The callback would require the response's `InResponseTo` to match it, using a per-request node-saml check, or our own check that reads `InResponseTo` from the response XML (`profile.getSamlResponseXml()`), because node-saml's `Profile` does not expose it. The IdP's ACS POST is a top-level cross-site navigation whenever the SP host is not same-site with the IdP. A `SameSite=Lax` cookie is not sent on that POST, so the cookie would need `SameSite=None; Secure`. The edge would also have to forward it on the callback path. Several login tabs open at once would overwrite each other's cookie and fail all but the last. It would also end IdP-initiated login, so first confirm with the WCM IdP team that no portal tile or unsolicited-SSO link launches SPS.

## Consequences

- IdP-initiated (unsolicited) responses keep working. The repo shows no dependency on them.
- The single-use store stays load-bearing and fails closed. Weakening it, or the ACS binding in `checkResponseBinding`, would remove the controls this ADR relies on.
- If SPS ever runs as a single task or adds ALB stickiness, that does not change D3. A shared cache still would not bind the request to the browser.

## Alternatives considered

| Option | Why not now |
|---|---|
| `always` with node-saml's default in-memory cache | Breaks logins when the request and response land on different tasks (no stickiness) |
| `ifPresent` with a shared cache | Unsolicited responses still pass, so close to no protection for the cost of a new table |
| `always` with a Prisma-backed cache | The cache is not tied to a browser, so login CSRF is still open. New migration and login-path dependency. |
| `always` with a signed request-ID cookie | Needs a `SameSite=None` cookie on the ACS path, breaks concurrent login tabs, ends IdP-initiated login. Too much for a Low residual risk. |
| ALB sticky sessions plus in-memory cache | Infra change to the target group, still not tied to a browser, and lost on task replacement mid-login |
