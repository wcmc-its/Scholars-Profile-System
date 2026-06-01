# SPEC — "View as" impersonation (#637)

**Status:** ACCEPTED — implemented in #637 (PR #643). Source-of-record for the shipped feature; flag-gated off (`IMPERSONATION_ENABLED`) pending a deliberate enable.
**Issue:** #637 · **Adapts:** `~/Downloads/scholars-impersonation-spec.md` (generic) · **Refs:** ADR-005, #356, #540, #101, #102/B03.
**Decided:** prod support tool, full guards day one · amber banner · **edit-enabled, attributed to the real actor** · initiator = existing `superuser-role` · 30-min expiry · role taxonomy = `owner`/`curator` × `department`/`division`/`center` (+`scholar`) · audit recipe **v2** (`impersonated_cwid`).

---

## 1. Goal & non-goals

**Goal.** Let a superuser render the whole app *as* another user **and act on their behalf** — visual QA, support reproduction, and edits the target could make themselves (e.g. their `overview`, which no superuser path can touch directly). The *same* identity-resolution seam feeds the test suite so role × route tests prove what a real session renders.

**Non-goals (explicit — keep the privilege surface minimal):**
- **NG1 — Unit-owner-initiated impersonation.** v1 initiators are superusers only; "owner impersonates a scholar in their subtree" is a named follow-up.
- **NG2 — Synthetic role identities** beyond a single "public view." Generic roles with no real CWID carry no unit data; deferred.
- **NG3 — Cross-service impersonation** (ReCiter, ETL). The overlay is scoped to this app's session cookie.
- **NG4 — Acting *above* the target.** You get exactly the target's permissions, never more (R2 blocks impersonating up). You cannot use impersonation to gain a power you lack as yourself, except the *intended* one: editing the target's own self-only fields, on their behalf, audited to you.

---

## 2. The seam

The session cookie is iron-session-sealed `{cwid, iat, exp}` (`lib/auth/session.ts`). The overlay rides **inside the AEAD seal** — unforgeable without the key — so no second cookie:

```ts
export interface SessionData {
  cwid: string;            // real SAML subject — NEVER mutated
  iat: number;
  exp: number;
  impersonating?: { targetCwid: string; startedAt: number };  // present only while viewing-as
}
```

```ts
// lib/auth/effective-identity.ts (new) — the ONE place "acting as" is decided
const TTL = Number(process.env.IMPERSONATION_TTL_SECONDS ?? 1800);     // 30 min
export function impersonationActive(s: SessionData, now: number): boolean {
  return !!s.impersonating && s.impersonating.startedAt + TTL > now;    // read-time expiry
}
export function getEffectiveCwid(s: SessionData, now = nowSeconds()): string {
  return impersonationActive(s, now) ? s.impersonating!.targetCwid : s.cwid;
}
export async function getEffectiveEditSession(): Promise<EditSession | null> { … }  // {cwid, isSuperuser} from EFFECTIVE cwid
```

Auto-expiry is **read-time** (the security boundary): an overlay older than TTL is ignored wherever `getEffectiveCwid` is read; middleware re-seals to physically drop it (cosmetic). Hard cap remains the 8 h cookie `exp`.

**Only three call sites read the real `s.cwid` directly:** the **audit attribution** (`actor_cwid`), the **banner**, the **escalation guard**. Everything else — render, data-scoping queries, **and edit authorization** — reads the effective identity.

---

## 3. Read vs. write: who you act as, who you're logged as

This is the crux of edit-enabled impersonation.

| Concern | Identity used | Why |
|---|---|---|
| Page render / data scoping | **effective** (target) | you see what they see |
| Edit **authorization** (`authorize*`, `canEditUnit`, …) | **effective** (target) | you can do exactly what they can — incl. their self-only `overview` |
| Edit **attribution** (`manual_edit_audit.actor_cwid`) | **real** (you) | the human is always accountable; never forge that the target acted |
| New audit column `impersonated_cwid` | **effective** (target) | records "on behalf of whom" |

So `readEditRequest` returns `{ realCwid, effective: EditSession, impersonatedCwid: string | null }`. Authz reads `effective`; the audit append writes `actor_cwid = realCwid`, `impersonated_cwid = impersonatedCwid`. `actor_cwid` is **never** the target.

(Optional `IMPERSONATION_READONLY=true` restores view-only for sites that want it; **default is edit-enabled**.)

---

## 4. Components → files

| Component | File (new unless noted) | Job |
|---|---|---|
| seam + guard | `lib/auth/effective-identity.ts` | `getEffectiveCwid`, `impersonationActive`, `getEffectiveEditSession`, `assertImpersonable` (R2). `canImpersonate = isSuperuser` |
| re-seal helpers | `lib/auth/session.ts` (edit) | `withImpersonation(s, targetCwid)` / `withoutImpersonation(s)` — preserve `iat`/`exp`, toggle overlay |
| request ctx | `lib/edit/request.ts` (edit) | `readEditRequest` → `{ realCwid, effective, impersonatedCwid }` |
| API | `app/api/impersonation/route.ts` | `POST` start / `DELETE` stop |
| candidates | `app/api/impersonation/candidates/route.ts` | server-filtered assumable targets (R2 pre-filter) |
| middleware gate | `middleware.ts` (edit) | route-level enforce on `/api/impersonation` |
| banner | `components/site/impersonation-banner.tsx` | amber, client-probed via `/api/auth/session` |
| probe payload | `app/api/auth/session/route.ts` (edit) | add `impersonating` block |
| switcher | `components/site/impersonation-switcher.tsx` | popover off `account-menu.tsx`, gated render |
| display + grant rule | `lib/edit/impersonation-display.ts` | role × unit-kind classifier; `pickDisplayGrant` shared by the probe + candidates |
| probe hook | `components/site/use-impersonation-probe.ts` | client `/api/auth/session` probe powering the banner + switcher (T6) |
| audit | `lib/edit/audit.ts` (edit) | `impersonation_start`/`_end` actions; `impersonatedCwid` on every `AuditRow`; `computeRowHash` recipe **v2** |
| edge behavior | `cdk/lib/edge-stack.ts` (edit) | `/api/impersonation*` CachingDisabled + AllViewer (cookies + query + POST/DELETE) |
| test helper | `tests/util/session-as.ts` | builds the overlay; feeds the same seam |

Distinct from `SuperuserBanner` ("editing X") — this is "viewing/acting as X," persistent.

---

## 5. Flag & gating

- `IMPERSONATION_ENABLED` (default **off**) — gates the whole feature; off ⇒ `/api/impersonation*` 404, switcher hidden, overlay ignored. Step 1 lands dark.
- `IMPERSONATION_TTL_SECONDS` (default 1800).
- `IMPERSONATION_READONLY` (default false) — optional view-only mode.

No new LDAP group — **R1 reuses `isSuperuser`** (`ITS:Library:Scholars/superuser-role`).

---

## 6. Security

Enforced in `middleware.ts` on `/api/impersonation` (route-level):

**R1 — Initiator gate.** `canImpersonate(realCwid) = isSuperuser(realCwid)` — the existing live, fail-closed LDAPS check (`lib/auth/superuser.ts`), against `session.cwid`, **never** the effective cwid.

**R2 — Escalation guard, down-only.** `assertImpersonable` blocks impersonating any CWID that is itself a superuser (`<`, stricter than the spec's `≤` — no lateral admin→admin).

**R3 — Edit attribution (the edit-enabled safety property).** Per §3: authz uses effective, but `manual_edit_audit.actor_cwid` is always the real human + `impersonated_cwid` = target. An impersonated edit is non-repudiable and clearly attributed; `actor_cwid` is never forged to the target. Both columns are inside `row_hash` (recipe v2), so the attribution is tamper-evident.

**R4 — CSRF.** Existing `verifyRequestOrigin()` on `POST`/`DELETE` — same-origin + `Content-Type: application/json`. Applies to impersonated edits too.

**R5 — Audit enter AND exit.** Standalone-tx row in `scholars_audit.manual_edit_audit` + a CloudWatch event, on both `impersonation_start` and `impersonation_end`: `actor_cwid`=real, `target_entity_type='scholar'`, `target_entity_id`=targetCwid, `impersonated_cwid`=targetCwid, `after_values={startedAt}`. CloudWatch: `console.warn(JSON.stringify({event:'impersonation_started'|'impersonation_ended', actor_cwid, target_cwid, startedAt}))` → metric filter in `observability-stack.ts`.

**R6 — Auto-expiry + logout.** Read-time TTL (§2); cleared on logout (`clearedSessionCookie()` drops the cookie carrying the overlay).

**R7 — Banner non-suppressible** (§8).

### Threat model

| # | Threat (OWASP) | Mitigation |
|---|---|---|
| T1 | Privilege escalation via the minting seam (A01) | R1 on real cwid in middleware; R2 down-only; effective cwid never gates the initiator |
| T2 | Impersonated edit looks like the **target** authored it (forgery/repudiation, A09) | R3 — `actor_cwid` always real + `impersonated_cwid`, both hashed (v2); banner states "logged to you" |
| T3 | CSRF on start/stop/edit (A01) | R4 |
| T4 | "Who acted as whom" gap (A09) | R5 enter+exit, both identities, tamper-evident; per-edit `impersonated_cwid` |
| T5 | Overlay forgery/tamper | overlay inside AEAD seal — same key protection as `cwid` |
| T6 | Forgetting you're impersonating (confused deputy) | non-dismissible amber banner, client-probed (survives cached pages), auto-expiry |

**Out of scope:** NG1–NG4; brute-forcing the seal key (#100/#466).

### Rejected alternatives
- **Block all writes (view-only)** — defeats the support purpose (can't fix a scholar's self-only `overview` on their behalf). The real risk is misattribution, solved by R3. ✗ (kept as optional `IMPERSONATION_READONLY`).
- **Re-mint the cookie as the target** — loses the real principal needed for exit/audit/guard. ✗
- **Store role in the session, overlay an `Identity`** — SPS roles are derived; duplicate state, drift. ✗
- **Server-only banner in root layout** — vanishes on CloudFront-cached pages (cookie stripped). ✗
- **A dedicated `impersonate-role` group** — considered; you chose to reuse `superuser-role`. ✗

---

## 7. API contract

`POST /api/impersonation` `{ targetCwid }` → gate flag, R1, R2, R4. Effect: `withImpersonation`, audit `impersonation_start`, 204. Errors: 404 (flag off), 401 (no session), 403 (R1/R2/R4, stable reason), 404 (target not a real scholar).
`DELETE /api/impersonation` → `withoutImpersonation`, audit `impersonation_end`, 204 (idempotent).
`GET /api/impersonation/candidates?kind=&q=` → `[{cwid, preferredName, slug, role, unitKind, unit}]`; superusers pre-filtered out (R2). Gate flag, R1. `kind` ∈ `department|division|center|scholar|all`. Served at the edge by the `/api/impersonation*` CloudFront behavior (CachingDisabled + AllViewer — forwards cookies + the query string + POST/DELETE; #490/#624 + POST-403 guards).
`/api/auth/session` payload gains `impersonating: { targetCwid, targetName, role, unitKind, unit, startedAt } | null` and `canImpersonate: boolean`.

---

## 8. UX

**Role taxonomy.** Subjects are classified by the real RBAC model (ADR-005 Amendment 1 / #540): a **role** `owner`/`curator` (`UnitRole`) over a **unit kind** `department`/`division`/`center` (`EntityType`), or plain `scholar`. The codebase labels the roles "Owner"/"Curator" (not "admin" — that is the superuser tier). A shared `pickDisplayGrant` (`lib/edit/impersonation-display.ts`; owner > curator, ties broken by unit-kind rank center > division > department) classifies a CWID identically for the probe and the candidates list, reading the administered unit's name from the grant's `entityId`.

**Banner** — amber (`#7a4f01`→`#92611a`, `#f0b429` underline, `#fff8eb` text, AA). Full-width, sticky, pushes content down. `Viewing as <strong>Name</strong> · {Owner|Curator} · {unit} ({Dept|Div|Center})` (or `· Scholar`), a quiet `You are <real>` line, and — because editing is live — **"Changes are made as them and logged to you."** Auto-expiry countdown. Always-present "Return to my view" (`DELETE`). No dismiss. `role="status"` `aria-live="polite"`, exit keyboard-focusable. **Client-probed** (T6) — never server-only.

**Switcher** — popover off `account-menu.tsx` (a `w-full` panel in a `w-[22rem]` popover), renders only when the probe reports `canImpersonate`. Search by name/CWID; **unit-kind** filter chips (All · Department · Division · Center · Scholar); each row shows `Name` over `{Owner|Curator} · {unit} ({Dept|Div|Center})` (or `Scholar`) with a "View as" action, from `/candidates`. Choosing a user ⇒ **confirm dialog always** (states writes are logged to you). (The generic "public view" target is deferred — NG2.)

---

## 9. Test plan

`tests/util/session-as.ts` (+ `tests/unit/impersonation-display.test.ts` for the role taxonomy):
```ts
const sessionAs = (targetCwid, over = {}) =>
  ({ cwid: SUPERUSER_FIXTURE, iat: NOW, exp: NOW+3600,
     impersonating: { targetCwid, startedAt: NOW }, ...over });
```
**Matrix** — every role fixture × every protected route: `authorizeForRoute(sessionAs(fixture.cwid), route) === route.expected[fixture.role]`.

| # | Edge case | Expected |
|---|---|---|
| E1 | overlay older than TTL | `getEffectiveCwid` → real; render = self |
| E2 | edit while impersonating | write succeeds; audit `actor_cwid`=real, `impersonated_cwid`=target |
| E3 | **superuser impersonates scholar, edits scholar's `overview`** | allowed (impossible for superuser directly); audited to real actor |
| E4 | target is a superuser | `POST /api/impersonation` 403 (R2) |
| E5 | flag off | `/api/impersonation` 404; hand-crafted overlay cookie ignored |
| E6 | logout while impersonating | overlay gone |
| E7 | start, then start a different target | overlay replaced; two `impersonation_start` rows, real cwid |
| E8 | DELETE with no overlay | 204, no `impersonation_end` row |
| E9 | tampered overlay (bad seal) | session → null |
| E10 | recompute `row_hash` of a pre-migration row | verifies under recipe **v1**; new rows under **v2** |

**Audit SQL (`scholars_audit`):**
```sql
-- all impersonated edits in the last 7d: who, on whose behalf, what
SELECT actor_cwid, impersonated_cwid, target_entity_type, target_entity_id, action, ts
FROM manual_edit_audit
WHERE impersonated_cwid IS NOT NULL AND ts > NOW() - INTERVAL 7 DAY
ORDER BY ts DESC;

-- integrity canary (should be empty): an impersonated edit whose actor == the person edited
SELECT * FROM manual_edit_audit
WHERE impersonated_cwid IS NOT NULL AND actor_cwid = impersonated_cwid;

-- sessions entered but never exited (24h)
SELECT a.actor_cwid, a.target_entity_id, a.ts FROM manual_edit_audit a
WHERE a.action='impersonation_start' AND a.ts > NOW() - INTERVAL 1 DAY
  AND NOT EXISTS (SELECT 1 FROM manual_edit_audit b WHERE b.action='impersonation_end'
    AND b.actor_cwid=a.actor_cwid AND b.target_entity_id=a.target_entity_id AND b.ts > a.ts)
ORDER BY a.ts DESC;
```
Plus 1–2 full-SAML smoke tests on **staging only** (attr → CWID → role).

---

## 10. Audit migration (B03-touching — accepted)

Three changes to `scholars_audit.manual_edit_audit`, same deploy path as #493's grant work:
1. `ALTER … MODIFY action ENUM(…, 'impersonation_start','impersonation_end')`.
2. `ALTER … ADD COLUMN impersonated_cwid VARCHAR(32) NULL` (after `actor_cwid`).
3. **`computeRowHash` recipe v1 → v2:** append `impersonatedCwid` to the positional array. Rows written before the migration verify under v1 (keyed by `ts <` migration); rows after, under v2. `docs/b03-audit-log.md` gets a v2 note.

Confirm INSERT grant covers the altered table (cf. #493 `sps_bootstrap`).

**This recipe bump is the only thing that touches the security-reviewed B03 hash** — accepted (the column + v2). The migration SQL ships as a review artifact (`scripts/sql/impersonation-audit-migration.sql`, NOT auto-run); apply it on the same deploy path as #493's grant before the flag is enabled in an env, and confirm the app role's INSERT grant still covers the altered table.

---

## 11. Build order

1. **Seam + tests (no attack surface).** `effective-identity.ts`, re-seal helpers, `sessionAs`, the matrix + edge table (E1, E5, E9). Flag off. ← *worktree opens here on sign-off.*
2. **Gated API + write-attribution + migration.** route, guard, `readEditRequest` real/effective split, audit column + recipe v2, ENUM `ALTER`, CSRF, CloudWatch filter. **Security sign-off checkpoint.**
3. **UI.** amber client-probed banner + switcher + candidates + confirm + `/api/auth/session` payload.

Worktree per the usual flow; `npx prisma generate` in the fresh tree; `vitest --maxWorkers=4` before any push.

---

## 12. Decisions

**Resolved (all):** reuse `superuser-role` (R1=`isSuperuser`) · 30-min auto-expiry · audit ENUM `ALTER` + `impersonated_cwid` column + recipe v2 · **edit-enabled, attributed to real actor (R3)** · block lateral admin (`<`) · confirm always for a specific user · unit-kind role taxonomy (§8) · `/api/impersonation*` edge behavior · flag-gated (default off).
