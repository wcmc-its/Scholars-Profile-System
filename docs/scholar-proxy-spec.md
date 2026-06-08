# Scholar-assigned proxy editor — v1 SPEC

**Status:** Draft
**Date:** 2026-06-08
**Tracking issue:** [#779](https://github.com/wcmc-its/Scholars-Profile-System/issues/779)
**Authors:** Scholars Profile System development team
**Builds on:** [ADR-005](./ADR-005-manual-override-layer.md) — Manual-override layer (the `field_override` + `suppression` mechanism)
**Coordinates with:** [`self-edit-spec.md`](./self-edit-spec.md) — the scholar-facing feature on the same mechanism; this SPEC reuses its scholar write path verbatim and adds one new authorized actor. And [`unit-curation-spec.md`](./unit-curation-spec.md) (#540) — whose unit-role *"proxy editing"* (layer 3) this SPEC is **distinct from** (see [Relationship to #540](#relationship-to-540-unit-role-proxy-editing)).
**Coordinates with:** [`impersonation-spec.md`](./impersonation-spec.md) (#637) — the "View as" effective-identity overlay, which proxy editing must be kept **orthogonal** to (see [Identity and session](#identity-and-session)).
**Gated by:** B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) (SSO), B02 [#101](https://github.com/wcmc-its/Scholars-Profile-System/issues/101) (authorization predicate + telemetry), B03 [#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102) (append-only audit log)
**Requires:** an additive `EntityType`/audit-ENUM extension and one new table (`ScholarProxy`), parallel to the [ADR-005 Amendment 1](./ADR-005-manual-override-layer.md#amendment-1-2026-05-27--org-unit-curation-entity-type-extension-and-three-tier-access-model) `UnitAdmin` precedent. Ratified into ADR-005 as **Amendment 3** (Amendment 2 is the slug-override reconcile decision; this is the next free number) — same mechanism, one new access-grant table.

---

## Purpose

**Scholar-assigned proxy editor** lets a scholar designate a specific individual — by name, resolved against the WCM enterprise directory — to edit *their* public profile on their behalf, scoped to **exactly what the scholar could self-edit**. The designee is a **per-scholar grant**, chosen explicitly by the scholar (or by a superuser acting on the scholar's behalf), and stored as an explicit `ScholarProxy` row keyed to `(scholarCwid, proxyCwid)`.

The canonical real-world case: **Beth Chunn** (cwid `bec4010`), pure administrative staff with **no Scholar profile**, is the proxy editor for **Rahul Sharma** (cwid `ras2022`, faculty). Beth signs in through WCM SSO, reaches `/edit/scholar/ras2022`, and edits Rahul's overview and hides his misattributed publications — and nothing else, on no other profile.

This SPEC introduces **no new write mechanism.** A proxy edit writes the same `field_override(scholar, scholarCwid, 'overview')` row a self-edit writes, and the same per-author `suppression(publication, pmid, contributorCwid)` row a self-hide writes, through the same `/edit/scholar/[cwid]` route and the same `/api/edit/field` and `/api/edit/suppress` endpoints. What this SPEC adds is **one new authorized actor**, sourced from an explicit per-scholar grant, plus the grant/revoke surface and a notification on assignment.

It does **not** redesign ADR-005's mechanism, and it does **not** cover the visual/interaction design of the proxy panels — that is a `UI-SPEC.md` deliverable (`gsd-ui-phase`).

*Terminology.* **Scholar** — the faculty member whose profile is the subject of a grant; `ScholarProxy.scholarCwid`. **Proxy** (or **proxy editor**) — the explicitly-named designee; `ScholarProxy.proxyCwid`. A proxy is **never** required to have a `Scholar` row, and by [D3](#d3--no-other-role--a-proxy-holds-no-other-role-in-the-system) must hold **no** other role. **Grantor** — the real human who created the grant (the scholar self-assigning, or a superuser acting on the scholar's behalf); `ScholarProxy.grantedBy`. **Superuser** — a session whose SSO claims include the `scholars-admins` group (`lib/auth/superuser.ts`); the site-wide tier and root of trust.

---

## What a proxy CAN and CANNOT do

Proxy edit scope is **identically** self-edit scope (D4). The proxy sees the same surface the scholar would see at `/edit`, and the authorization layer — not the UI — enforces the boundary.

| Capability | Self-editing scholar | Proxy (granted) | Superuser |
|---|---|---|---|
| Edit `overview` (profile bio) | ✅ own record only | ✅ **only the granted scholar's record** | ⛔ deferred — broad admin field-editing (`self-edit-spec.md`) |
| Hide one of the scholar's own publications (per-author suppression) | ✅ writes a per-author `suppression` | ✅ **only for the granted scholar as contributor** | ✅ any |
| Set / clear the `slug` override | ⛔ | ⛔ — **superuser-only, structural** (D4) | ✅ any (#29) |
| Edit `primaryTitle`, `primaryDepartment`, `email`, `orcid`, `postnominal`, … | ⛔ — upstream-authoritative, routes to SOR/ED | ⛔ — **same** (D4; actor-independent reasoning) | ⛔ — same |
| Whole-profile suppression (hide / un-hide the scholar) | ✅ self only | ⛔ — **not in proxy scope** (D4); a proxy is an editor, not a visibility controller | ✅ any |
| Whole-publication takedown (retraction / compliance) | ⛔ | ⛔ | ✅ |
| Assign / revoke a proxy for the scholar | ✅ self (D1) | ⛔ — **a proxy can never manage the proxy list** (CD-2) | ✅ (D1) |
| Edit any other scholar's profile | ⛔ | ⛔ — `403` on any non-granted scholar (PE-06) | ✅ |

**The proxy field set is *exactly* `{ overview }` for field edits, and *exactly* per-author publication hide where `contributorCwid === the granted scholarCwid`.** Everything else is a `403` (or `400` for an out-of-allowlist field/entity). This is a **positive allowlist**, not a denylist — a future new self-editable field does not become proxy-reachable unless this SPEC widens the allowlist (PE-03).

---

## Relationship to #540 (unit-role proxy editing)

The [unit-curation SPEC](./unit-curation-spec.md) (#540) layer 3 *also* calls its feature "proxy editing": an **Owner** or **Curator** of a unit may proxy-edit any faculty member whose **LDAP-primary** `deptCode`/`divCode` falls within that unit. That authority is **role-derived and unit-scoped** — it follows from holding a `UnitAdmin` row, and it reaches an open-ended set of scholars (every faculty member in the unit subtree).

This SPEC is a **different authorization model**. It is **designee-derived and scholar-scoped**: authority comes from an explicit `ScholarProxy` grant row keyed to one `(scholarCwid, proxyCwid)` pair, chosen by the scholar, reaching **exactly that one scholar**.

| | #540 unit-role proxy | This SPEC: scholar-assigned proxy |
|---|---|---|
| Source of authority | `UnitAdmin(role ∈ {owner, curator})` row | `ScholarProxy(scholarCwid, proxyCwid)` row |
| Who initiates | An Owner grants the unit role; the role then implies proxy reach | The **scholar** names the proxy (or a superuser on their behalf) |
| Scope | All faculty in the unit subtree (LDAP-primary) | One named scholar |
| Actor's other roles | The actor **is** a unit admin (a role) | The actor holds **no** other role (D3) |
| Audit `action` | `grant_change` (the role grant) | `proxy_grant` / `proxy_revoke` (the designee grant) |

The two models are deliberately **mutually exclusive at the person level**: D3 forbids granting a scholar-proxy to anyone who holds a `UnitAdmin` row, so a single CWID can never hold both axes of authority simultaneously and create an ambiguous, additive reach. Both models **reuse the same write path** (`field_override(scholar,…,'overview')` + per-author `suppression` + the `/edit/scholar/[cwid]` route + the `actorCwid <> entityId` audit marker) — this SPEC adds **no new write mechanism**, only a new authorized actor and a distinct grant table.

The existing `canProxyEdit` predicate (`lib/edit/authz.ts:385`) is the **#540 unit-role** predicate — defined but, as of this writing, **not yet wired into any write route** (verified: zero call sites in `app/api/edit/*`). This SPEC does **not** overload it. It adds a **separate** predicate, `isGrantedProxy`, so the two authorization axes stay distinct in code and in the audit log.

---

## Architecture decisions this SPEC makes

The five product decisions below are **fixed** (ratified before this SPEC). Each is recorded as an architecture decision with its rationale and the named alternatives rejected.

### D1 — Provisioning: scholar self-assigns; superuser may assign on the scholar's behalf

A scholar assigns and revokes their own proxy from their own `/edit` console; **and** a superuser can assign and revoke on a scholar's behalf from the admin surface (`/edit/scholar/[cwid]` in `mode="superuser"`).

- **Rationale.** Self-assignment is the primary path (the scholar owns the delegation decision). Superuser-assist covers onboarding, support tickets, and scholars who will not operate the console themselves — exactly the population this feature serves.
- **Authorization.** The grant endpoint admits **only** `realCwid === scholarCwid` (the scholar themselves) **or** `await isSuperuser(realCwid)` (a real superuser). A proxy may **never** grant or revoke a proxy — including on the scholar they serve (CD-2). The authz is keyed on `realCwid`, never the effective (impersonated) cwid (CD-1, IS-10).
- **Rejected alternative — anyone-in-the-unit may assign.** That is #540's model and conflates the two axes; the scholar must own *their* designee.

### D2 — Activation: both parties notified; effective immediately; either may revoke

On a successful grant, **both** the named proxy and the scholar are notified (email). Access is effective **immediately** — there is **no acceptance step**. Either the scholar **or** a superuser may revoke at any time.

- **Rationale.** An acceptance gate adds friction to a low-frequency administrative delegation and a window during which the scholar believes coverage exists but it does not. Immediate effect with dual notification gives transparency without a handshake.
- **Mechanism.** Reuse the existing SESv2 mailer (`lib/edit/mailer.ts`) and the plain-text, header-injection-guarded composition pattern of the "Request a change" feature (`lib/edit/request-change.ts`). The mailer is **dormant by configuration** (`SELF_EDIT_REQUEST_CHANGE_SEND` / a new `SCHOLAR_PROXY_NOTIFY_SEND` flag + a verified `SCHOLARS_MAIL_FROM`); until ops verify the SES identity and flip the flag, **no emails are sent and the grant still succeeds** (notification is best-effort, see [Notification](#notification-d2)).
- **Ordering.** The grant row + audit row **commit first**; the notification is sent **after commit** (CD-7). A rolled-back grant must never emit a "you were assigned" email.
- **Rejected alternative — silent grant (no notification).** A scholar must be able to detect an unexpected superuser-assigned proxy; silence defeats D1's superuser-assist transparency.
- **Rejected alternative — acceptance step.** Adds friction and a coverage gap; the threat model treats a wrongful grant as detectable-and-revocable, not preventable-by-handshake.

### D3 — "No other role": a proxy holds no other role in the system

A CWID may be granted as a proxy **only if it currently holds NONE of**:

1. a **non-deleted** `Scholar` row (`scholar.cwid = proxyCwid AND deletedAt IS NULL`),
2. a **`UnitAdmin`** row (owner or curator) (`unit_admin.cwid = proxyCwid`), or
3. **superuser** group membership (live LDAPS `isSuperuser(proxyCwid)`).

Enforced at **grant time** (blocking) **and** re-checked **fail-closed at every proxy edit**, so a later-acquired conflicting role disables the proxy path on the next request.

- **Rationale.** A scholar-proxy is a *limited, named delegate*. If the same CWID is a Unit Owner, they already hold broader authority over many scholars — the explicit grant is shadowed and authorization becomes ambiguous. If they are a superuser, the grant is meaningless (they can edit anyway) and laundering a superuser as a benign "designated editor" muddies the audit. If they are a scholar, a grant for their own profile is a no-op and a grant for another scholar creates a confusing two-path edit surface.
- **Enforcement seam.** MySQL has no exclusion constraint, so D3 is **application-enforced** at two points and **audited** at a third (the drift query). Both the grant-time and edit-time checks run **all three legs**, including the live `isSuperuser` leg — the superuser leg is **not** deferred (PE-02, PE-05, CD-3, IS-7). The edit-time check evaluates the **proxy's own `realCwid`**, because the request preamble computes `isSuperuser` only for the *effective* cwid (PE-02).
- **Rejected alternative — grant-time check only.** A proxy hired as faculty / promoted to curator / added to the superuser group after the grant would keep editing under a now-illegitimate, role-shadowed path until the grant is manually revoked. The per-edit re-check closes that window to one request.
- **Rejected alternative — auto-revoke on conflict.** Invasive (requires a hook on every role-acquisition path). The fail-closed per-edit re-check disables the path immediately; the stale row is caught by the scheduled drift audit ([query D](#audit-queries)) and cleaned up manually.

### D4 — Edit scope = self-edit scope

A proxy edits **exactly** what the scholar could self-edit: `overview`, and hiding the scholar's own misattributed publications. Upstream-authoritative scalars (`primaryTitle`, `primaryDepartment`, `email`, `orcid`, `postnominal`, …) are **not** proxy-editable; `slug` stays **superuser-only**. The mechanism is reused **verbatim** from `self-edit-spec.md` / #540 — no new write mechanism, only a new authorized actor.

- **Rationale.** Self-edit-spec's reasoning that a `field_override` on an upstream scalar permanently masks the system of record is **actor-independent** — it holds whoever is editing. The proxy is acting *for* the scholar, so they get *the scholar's* surface, no more.
- **Enforcement.** The proxy branch is entered **only** for `entityType='scholar', fieldName='overview'` on `/api/edit/field`, and **only** for `entityType='publication'` with `contributorCwid === scholarCwid` on `/api/edit/suppress` (PE-03). A proxy attempt on `slug`, any other scalar, a whole-profile suppression, a whole-publication takedown, or a publication where `contributorCwid !== scholarCwid` → `403`/`400`.
- **Rejected alternative — let the scholar delegate a wider scope.** D4 is a **hard architectural constraint**, not a per-grant policy. A proxy can *never* edit via superuser-only paths even if the scholar wished it; there is no grant field that widens scope. (Open question 1 below confirms this is fixed.)

### D5 — Cardinality: many-to-many

Composite PK `(scholarCwid, proxyCwid)`. One proxy may serve **many** scholars (the department-admin pattern); a scholar may name **more than one** proxy. The UI **may** soft-limit, but the **model enforces no limit**.

- **Rationale.** A single administrative assistant covering a whole division of faculty is the headline use case (one proxy → many scholars). A scholar wanting both an assistant and a co-PI's coordinator is plausible (one scholar → many proxies). The composite PK enforces *one row per pair* (no duplicate grants) while permitting both fan-outs naturally — mirroring `UnitAdmin`'s composite-PK shape.
- **Server-side cap.** A UI soft-limit (e.g. 10 proxies per scholar) **must be backed by a server-side count check** in the grant endpoint, not enforced in the client alone (PE-08) — otherwise a compromised scholar account can mint an unbounded number of durable secondary write paths.
- **Rejected alternative — one proxy per scholar (unique on `scholarCwid`).** Excludes the legitimate co-coordinator case and the natural department-admin fan-out.

---

## Data model

### New table: `ScholarProxy`

A new model in `prisma/schema.prisma`, inserted after `UnitAdmin` (~line 896) for logical grouping with the other access-grant table.

```prisma
/// Scholar-assigned proxy editor grant (scholar-proxy-spec.md D1–D5). One row
/// per (scholarCwid, proxyCwid); composite PK enforces one grant per pair (D5).
/// A scholar names a specific individual to edit their profile on their behalf;
/// the grant reaches EXACTLY that one scholar.
///
/// Inserted on grant (self-assign or superuser-assign), HARD-DELETED on revoke;
/// B03 audits both (`proxy_grant` / `proxy_revoke`). No soft-revoke column — a
/// grant is crisply present or absent, matching the UnitAdmin precedent
/// (ADR-005 Amendment 1 § A1.1). The append-only audit log is the sole revoke
/// history.
///
/// `grantedBy` is the REAL grantor CWID (the scholar self-assigning, or a
/// superuser acting on their behalf) — written from `realCwid`, never the
/// effective/impersonated cwid (CD-1/IS-10). It is a historical breadcrumb,
/// not a live FK: the grant stands even if the grantor is later deprovisioned.
///
/// No FK to Scholar on EITHER column. `proxyCwid` is by D3 NOT a Scholar (Beth
/// Chunn is pure staff) — Prisma/MySQL cannot express "must NOT exist in
/// scholar"; D3 is application-enforced. `scholarCwid` carries no FK so a grant
/// can outlive a soft-deleted scholar inertly (the grant is unexercisable while
/// the scholar is deleted — see Authorization).
///
/// Edit scope = self-edit scope (D4): overview + hiding the scholar's own
/// misattributed publications. Reuses field_override(scholar,…,'overview') and
/// per-author Suppression(publication, pmid, scholarCwid), unchanged mechanism.
model ScholarProxy {
  scholarCwid String   @map("scholar_cwid") @db.VarChar(32) // the granted scholar
  proxyCwid   String   @map("proxy_cwid") @db.VarChar(32)   // the designee (NOT a Scholar/UnitAdmin/Superuser — D3)
  grantedBy   String   @map("granted_by") @db.VarChar(32)   // REAL grantor cwid (scholar self, or superuser)
  createdAt   DateTime @default(now()) @map("created_at")

  @@id([scholarCwid, proxyCwid])
  @@index([proxyCwid]) // reverse lookup: "which scholars does this proxy serve?" (landing redirect, drift audit)
  @@map("scholar_proxy")
}
```

**Design rationale.**

- **Composite PK `(scholarCwid, proxyCwid)`** (D5) — enforces one grant per pair; mirrors `UnitAdmin`'s `@@id([entityType, entityId, cwid])` shape.
- **`@@index([proxyCwid])`** — the only secondary index. It backs the reverse lookup ("what does this proxy serve?") used by the [non-scholar landing redirect](#identity-and-session), the [drift audit](#audit-queries), and the proxy's own "scholars I serve" view if added. The forward lookup (the per-edit authorization) is a `findUnique` on the composite PK — already covered by the PK index.
- **Collation.** `@db.VarChar(32)` with the table's default collation — confirm it matches `scholar.cwid` (`utf8mb4_unicode_ci`) so a stored mixed-case row cannot create a phantom distinct PK under case-insensitive comparison (PE-04). The grant endpoint normalizes CWIDs to canonical lowercase before any write, so this is belt-and-suspenders.
- **No `revokedAt`/`revokedBy` columns.** Revoke **hard-deletes** the row (decided below). The B03 audit log carries the revoke event.

### Soft-revoke vs hard-delete: HARD-DELETE

**Decision: hard-delete only, no soft-revoke column.** The four investigation areas disagreed (two proposed `revokedAt`); this SPEC **pins hard-delete**, matching `UnitAdmin` (`app/api/edit/grant/route.ts:161` `tx.unitAdmin.delete`).

- **Rationale.** A proxy grant is a *permission fact*, not a suppressible content entity with a reason and a revocation narrative. Row absence = no proxy access — the simplest possible per-edit authorization (`findUnique` returns null ⇒ deny). The B03 `proxy_revoke` audit row records who revoked and when.
- **Consequence (must be honored in code).** The edit-time authorization checks **row existence only** (`findUnique` non-null). There is **no `revokedAt IS NULL` predicate** — because there is no `revokedAt` column. Any defensive `revokedAt` filter copied from a sibling design is a bug (CD-8, IS-6, PE-07a). Revoke takes effect on the **very next request** (the grant lookup is a per-request DB read, never cached — IS-6).
- **Rejected alternative — soft-revoke.** Adds two columns and a filter every read path must remember; conflicts with the `UnitAdmin` precedent; and a route that checks existence while revoke sets a timestamp leaves revoked proxies live (the exact CD-8 hazard).

### Enum additions

**`AuditAction`** (`lib/edit/audit.ts:27`) gains two values:

```typescript
  /** a scholar (or superuser on their behalf) assigned a proxy editor (scholar-proxy-spec) */
  | "proxy_grant"
  /** a scholar (or superuser) revoked a proxy editor (scholar-proxy-spec) */
  | "proxy_revoke";
```

**The DB `action` ENUM** (`scripts/sql/audit-log.sql`, the `CREATE TABLE` at line 99 **and** the `MODIFY COLUMN` template at line 165) gains `'proxy_grant'` and `'proxy_revoke'` via an online `MODIFY COLUMN`. **This ENUM extension is a hard prerequisite of the grant endpoint** — if it is not applied before deploy, every `appendAuditRow` for a proxy grant/revoke throws inside the transaction and rolls back the whole write (CD-8). Update the action-history comment block (lines 147–160) to record the addition.

**`EntityType`** (`prisma/schema.prisma:1089`) — **no change.** A proxy grant's audit row uses `targetEntityType: "scholar"` with `targetEntityId = scholarCwid` (the grant's subject is the scholar, see [Audit](#audit)); `ScholarProxy` itself is an access-control artifact, not an override/suppression target, so it needs no `EntityType` member and no `AuditEntityType` member.

### Migration recipe (offline, additive)

Per the repo policy ([`PRODUCTION_ADDENDUM.md` § schema migrations — additive only](./PRODUCTION_ADDENDUM.md); migrations are generated **offline**, never via `prisma migrate dev`, which offers a destructive reset on this drifted dev DB):

```bash
# 1. Add the ScholarProxy model to prisma/schema.prisma (block above).
# 2. Generate the migration offline by diffing the live schema against the edited one:
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \   # (point --from at a checkout of the pre-change schema)
  --to-schema-datamodel    prisma/schema.prisma \
  --script > prisma/migrations/20260608000000_add_scholar_proxy/migration.sql
```

The generated SQL is a single additive `CREATE TABLE`:

```sql
CREATE TABLE `scholar_proxy` (
  `scholar_cwid` VARCHAR(32) NOT NULL,
  `proxy_cwid`   VARCHAR(32) NOT NULL,
  `granted_by`   VARCHAR(32) NOT NULL,
  `created_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`scholar_cwid`, `proxy_cwid`),
  INDEX `scholar_proxy_proxy_cwid_idx` (`proxy_cwid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Verify additive:** no `ALTER`/`DROP`/`MODIFY` on any existing table (the audit `action` ENUM `MODIFY COLUMN` ships in `scripts/sql/audit-log.sql`, the dedicated audit-DB script — not in this Prisma migration, since `manual_edit_audit` is deliberately not a Prisma model). Confirm the table created with a column probe:

```sql
SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scholar_proxy'
ORDER BY ORDINAL_POSITION;
-- expect 4 columns; PRI on (scholar_cwid, proxy_cwid); MUL on proxy_cwid
```

---

## Authorization

The feature consumes B01's session and B02's predicate machinery. **Session shape:** `{ cwid, isSuperuser }`, with `isSuperuser` re-evaluated on every `/edit/*` GET and `/api/edit*` POST, never cached (`lib/auth/superuser.ts`). The proxy grant lookup is a **per-request DB read**, also never cached (IS-6).

### The load-bearing rule: key everything on `realCwid`

> **Every proxy authorization decision — page gate, both write routes, and the grant/revoke endpoint — keys on `realCwid` (`lib/edit/request.ts:49`), NEVER on `session.cwid`/`effective.cwid` (`request.ts:176`).**

`readEditRequest` sets `session = effective`, which is the **impersonation target** while a #637 "View as" overlay is live. A proxy authorization keyed on `session.cwid` would let a superuser impersonate a proxy (or impersonate the scholar) and inherit the proxy path — the #637 R2 "down-only" analog (PE-01, CD-1, IS-1, IS-10). Mirroring how #637 keeps initiator-gating (`canImpersonate`) and the escalation guard (`assertImpersonable`) on the **real** cwid (`effective-identity.ts:86,95`), all proxy logic reads `realCwid`. A proxy is **never** an impersonator: assert the proxy path is taken only when `impersonatedCwid === null` (IS-1), and the grant endpoint blocks (or correctly attributes to the real superuser) when `impersonatedCwid !== null` (IS-10).

### New predicates (`lib/edit/proxy-authz.ts`, a new module)

Kept in a dedicated module so `authz.ts` stays the self-edit/#540 predicate set and the two proxy axes never blur. The predicates that touch the DB are **async** by necessity (the pure-predicate contract of `authz.ts` is preserved by keeping these out of it).

```typescript
/**
 * Is `realCwid` an active proxy for the EXACT scholar `scholarCwid`?
 * COMPOSITE-PK lookup — never a findFirst on proxyCwid alone (PE-06). The 'any
 * grant' findFirst is permitted ONLY for the read-only landing redirect, never
 * for a write authorization. Hard-delete ⇒ existence is the whole answer (no
 * revokedAt filter — CD-8).
 */
export async function isGrantedProxy(
  realCwid: string,
  scholarCwid: string,
  db: ProxyLookup,
): Promise<boolean> {
  const row = await db.scholarProxy.findUnique({
    where: { scholarCwid_proxyCwid: { scholarCwid, proxyCwid: realCwid } },
    select: { scholarCwid: true },
  });
  return row !== null;
}

/**
 * D3 "no other role" — fail-closed. Returns ok:false on ANY conflict. Runs all
 * THREE legs INCLUDING the live isSuperuser leg (NOT deferred — PE-02/CD-3).
 * Called BLOCKING at grant time AND fail-closed at every proxy edit, on the
 * candidate's OWN cwid. A directory outage fails closed: isSuperuser → false
 * AND editing is broadly disabled during ED outages, so the residual is moot.
 */
export async function checkProxyConflictingRole(
  cwid: string,
  db: ProxyLookup,
): Promise<{ ok: true } | { ok: false; reason: ConflictReason }> {
  const [scholar, unitAdmin, su] = await Promise.all([
    db.scholar.findUnique({ where: { cwid }, select: { deletedAt: true } }),
    db.unitAdmin.findFirst({ where: { cwid }, select: { cwid: true } }),
    isSuperuser(cwid), // lib/auth/superuser.ts — live LDAPS, fail-closed
  ]);
  if (scholar && scholar.deletedAt === null) return { ok: false, reason: "proxy_is_scholar" };
  if (unitAdmin) return { ok: false, reason: "proxy_is_unit_admin" };
  if (su) return { ok: false, reason: "proxy_is_superuser" };
  return { ok: true };
}
```

A new `AuthzDenialReason` value, `"proxy_conflict"` (edit-time D3 failure), is added to `lib/edit/authz.ts:24`. The three grant-time conflict reasons (`proxy_is_scholar` / `proxy_is_unit_admin` / `proxy_is_superuser`) are kept **server-side in the structured log only**; the HTTP body collapses them to a single opaque `proxy_ineligible` so the grant endpoint is not a role-oracle (CD-6).

### Where the checks slot in

**Page gate** — `app/edit/scholar/[cwid]/page.tsx`. Add the proxy tier **between** the self/superuser check (line 54) and the `loadEditContext`-null / `isPubliclyDisplayed` guards (lines 70–82), so a proxy is subject to the **same** soft-deleted-scholar 404 and #536 hidden-class 404 as the scholar themselves — **a proxy is NOT a superuser for those guards** (IS-9):

```typescript
const isSelf = session.cwid === targetCwid;
// realCwid is session.cwid here (page GET resolves the raw identity, not an
// edit-request effective overlay); a proxy is never impersonating on a page GET.
const isProxy = !isSelf && (await isGrantedProxy(session.cwid, targetCwid, db.read));
if (!isSelf && !isProxy) {
  const denial = requireSuperuserGet({ session, path: `/edit/scholar/${targetCwid}`, targetId: targetCwid });
  if (denial !== null) return <ForbiddenEditPage targetCwid={targetCwid} />;
}
// loadEditContext-null (soft-deleted) and isPubliclyDisplayed (#536) guards run
// next, UNCHANGED — they apply to a proxy exactly as to the scholar.
const mode = isSelf ? "self" : isProxy ? "proxy" : "superuser";
```

**Field write** — `app/api/edit/field/route.ts`, in `handleScholarFieldEdit`. After `authorizeFieldEdit` denies a non-self `overview` edit, attempt the proxy path — **but only for `fieldName === "overview"`** (PE-03). The proxy path is a composite-PK `isGrantedProxy(realCwid, entityId, …)` (PE-06) followed by a fail-closed `checkProxyConflictingRole(realCwid, …)` (PE-02):

```typescript
// fieldName is already constrained to 'overview' here; 'slug' routed to superuser.
let authz = authorizeFieldEdit(session, { entityId, fieldName });
if (!authz.ok && fieldName === "overview" && impersonatedCwid === null) {
  if (await isGrantedProxy(realCwid, entityId, db.read)) {           // PE-06 composite bind
    const conflict = await checkProxyConflictingRole(realCwid, db.read); // PE-02 fail-closed
    if (conflict.ok) authz = { ok: true };
    else { logEditDenial({ actorCwid: realCwid, targetCwid: entityId, path: PATH, reason: "proxy_conflict" }); return editError(403, "proxy_conflict"); }
  }
}
if (!authz.ok) { /* existing 403 */ }
```

**Suppress write** — `app/api/edit/suppress/route.ts`. Add the **scoped** proxy path **only** for `entityType === "publication"` AND `contributorCwid === entityId-target's scholarCwid` — i.e. the proxy may hide **only the granted scholar's own** authorship, never another author's, and never a whole-entity grant/education/appointment/scholar suppression (PE-03, IS-2). The check is `isGrantedProxy(realCwid, contributorCwid, …)` (the contributor IS the granted scholar) + `checkProxyConflictingRole` + the existing `publicationAuthorshipExists(pmid, contributorCwid)` `400` validation.

**Grant/revoke** — `app/api/edit/proxy/route.ts` (new, [below](#api-and-ui)).

### Decision / precedence table — who may edit a scholar's `overview`

Exactly one path applies (mutual exclusion); evaluated top to bottom.

| # | Condition (on the edit target scholar S) | Verdict |
|---|---|---|
| 1 | `realCwid === S` (self) | **ALLOW** (self-edit; `authorizeFieldEdit`) |
| 2 | `await isSuperuser(realCwid)` | **ALLOW** — but for `overview` a superuser does **not** inherit self-edit; this row is for the **`slug`** path and the page gate, not `overview`. For `overview`, a superuser editing another scholar goes through impersonation (#637), not this feature. |
| 3 | `isGrantedProxy(realCwid, S)` **and** `checkProxyConflictingRole(realCwid).ok` **and** `impersonatedCwid === null` | **ALLOW** via the proxy path |
| 4 | A `ScholarProxy` row exists but `checkProxyConflictingRole` fails | **DENY** `403 proxy_conflict` (D3 fail-closed) |
| 5 | none of the above | **DENY** `403 not_self` |

For the **grant/revoke** endpoint, the precedence is simpler:

| Action | Allowed iff |
|---|---|
| `POST /api/edit/proxy` `action="grant"` | (`realCwid === scholarCwid` **or** `await isSuperuser(realCwid)`) **and** `impersonatedCwid === null` **and** `checkProxyConflictingRole(proxyCwid).ok` **and** the per-scholar proxy count is below the server cap |
| `POST /api/edit/proxy` `action="revoke"` | `realCwid === scholarCwid` **or** `await isSuperuser(realCwid)` (and `impersonatedCwid === null`) |
| Any other actor (including a proxy of S) | `403 not_self` — **a proxy can never manage the proxy list** (CD-2) |

---

## Identity and session

**A non-scholar proxy authenticates exactly like a scholar and is confined to their granted scholar(s).** The system currently assumes every logged-in CWID has a `Scholar` row at the `/edit` landing and at `loadEditContext`; the only place that assumption must be relaxed is the **landing**, never the **target** (the target scholar always has a `Scholar` row).

- **SAML callback** (`app/api/auth/saml/callback/route.ts`) mints the session cookie with **no** `Scholar` lookup — a non-scholar CWID (`bec4010`) authenticates and receives a valid cookie. **No change.**
- **Middleware** (`middleware.ts`) is Scholar-agnostic — it gates `/edit/*` and `/api/edit/*` on cookie presence only. A non-scholar passes through. **No change.**
- **Session shape** (`lib/auth/session.ts`) stays `{ cwid, iat, exp, impersonating? }` — identity-only. Proxy-ship is **not** a session overlay; it is a per-request DB lookup. **No change.**
- **The `/edit` landing** (`app/edit/page.tsx`) today `loadEditContext(session.cwid)` → `notFound()` for a non-scholar. **Change:** when `loadEditContext` returns null **and** `session.isSuperuser === false`, look up the proxy's grants (`db.scholarProxy.findMany({ where: { proxyCwid: session.cwid }, select: { scholarCwid: true } })` — the **read-only** `findFirst`/`findMany` shortcut is acceptable here, **never** for a write authz, PE-06). If exactly one grant, redirect to `/edit/scholar/[scholarCwid]`; if more than one, render a minimal proxy landing listing the granted scholars (each a link to `/edit/scholar/[cwid]`); if none, keep the existing 404.

**Explicit separation from #637 impersonation** (IS-1, IS-4, IS-5):

| | Impersonation (#637) | Proxy editing (this SPEC) |
|---|---|---|
| Identity relationship | A superuser temporarily *views as* a target | A staff member edits *on behalf of* a scholar under an explicit grant |
| Who initiates | Superuser only (`canImpersonate` on real cwid) | Scholar, or superuser on the scholar's behalf (D1) |
| Session | `impersonating` overlay inside the sealed cookie | **None** — proxy is its own real identity |
| Effective cwid during edit | the **target**'s cwid | the **proxy**'s own cwid (`session.cwid === proxyCwid`) |
| Authz keys on | effective cwid (the target's permissions) | **`realCwid`** (the proxy's grant) — never effective |
| Audit | `actor_cwid = real superuser`, `impersonated_cwid = target` | `actor_cwid = proxy`, **`impersonated_cwid = NULL`** |
| Scope | anywhere the target can act | exactly self-edit scope of the one granted scholar (D4) |

A proxy can **never** be impersonating: the proxy path asserts `impersonatedCwid === null` before allowing (IS-1). A superuser **cannot** impersonate Beth (she has no `Scholar` row; `app/api/impersonation/candidates` filters to `Scholar` rows and the start route requires a non-deleted `Scholar`) — so the "impersonate a proxy to inherit their reach" vector is closed at the source. The proxy feature **must not** import or extend any impersonation route (IS-5); proxy authorization is wholly separate code.

---

## API and UI

### New endpoint: `POST /api/edit/proxy`

Mirrors `app/api/edit/grant/route.ts` (the closest pattern). Routes through `readEditRequest` to inherit the same-origin + `application/json` CSRF guard (`verifyRequestOrigin`) — **do not hand-roll session/body parsing** (CD-4).

**Body:** `{ scholarCwid: string, proxyCwid: string, action: "grant" | "revoke" }`

**Flow:**

1. `readEditRequest` — CSRF/origin guard, session, `realCwid`, `impersonatedCwid`, `requestId` (CD-4).
2. **Normalize + validate** both CWIDs to canonical lowercase against `CWID_PATTERN` (`lib/edit/validators.ts:433` — `/^[a-z][a-z0-9]{2,8}$/`) at the **top**, before any role check; store only the normalized form (PE-04). Validate `action`.
3. **Block while impersonating** — if `impersonatedCwid !== null`, `403` (a superuser-on-behalf grant must be recorded as a superuser action with `grantedBy = realCwid`, not laundered as a scholar self-assignment under an overlay — IS-10/CD-1). (Alternatively, allow but force `grantedBy = realCwid` and superuser-source the notification; **blocking is the simpler, recommended default.**)
4. **Authz** — `realCwid === scholarCwid` **or** `await isSuperuser(realCwid)`. A proxy of S may **not** call this for S or anyone (CD-2). Else `403 not_self`.
5. **Scholar must exist and be non-deleted** — `db.read.scholar.findUnique({ where: { cwid: scholarCwid }, select: { deletedAt: true } })`; null or `deletedAt != null` → `400 scholar_not_found` (a proxy can only serve a live scholar).
6. **D3 (grant only, BLOCKING)** — `checkProxyConflictingRole(proxyCwid, db.read)` (all three legs, incl. live `isSuperuser`, fail-closed — CD-3). On conflict, log the specific reason server-side and return `403 proxy_ineligible` (opaque — CD-6).
7. **Cardinality cap (grant only)** — count active grants for `scholarCwid`; if at the server cap (D5), `400 proxy_limit_reached`.
8. **Self-grant guard** — reject `scholarCwid === proxyCwid` with `400 cannot_proxy_self` (a scholar self-editing directly is the path; a self-proxy is a confusing no-op).
9. **Idempotency probe** — read the existing row; a `revoke` of a non-existent row is a `200` `changed:false` no-op.
10. **Write — one `$transaction`:** `upsert` (grant; `grantedBy = realCwid`) or `delete` (revoke), **plus** `appendAuditRow({ action: action === "grant" ? "proxy_grant" : "proxy_revoke", actorCwid: realCwid, impersonatedCwid: null, targetEntityType: "scholar", targetEntityId: scholarCwid, before/after = { proxy_cwid, granted_by } })` (CD-8 — same transaction). `grantedBy = realCwid`, never `session.cwid` (CD-1/IS-10).
11. **After commit** — send the D2 notifications (best-effort; see below). **No page revalidation** — the proxy list renders only on the uncached `/edit/*` surface (the superuser/scholar sees it on their next reload); nothing public changes on a grant.

**Responses:** `200` (`changed`), `400` (`invalid_*`, `scholar_not_found`, `proxy_limit_reached`, `cannot_proxy_self`), `403` (`not_self`, `proxy_ineligible`, `cross_origin`, impersonation block), `415`, `5xx` (`write_failed`).

### Endpoints widened (no new mechanism)

- `POST /api/edit/field` — scholar `overview` proxy branch (above).
- `POST /api/edit/suppress` — scoped per-author proxy branch (above).
- `app/api/edit/field/route.ts` / `suppress/route.ts` `FieldOverride.actorCwid` / `Suppression.createdBy` stay `session.cwid` (the effective identity = the proxy's own cwid, since a proxy is never impersonating) — the **non-repudiable** record is the B03 `actor_cwid = realCwid` (IS-8/CD-5). The `actorCwid <> entityId` marker on the override/suppression distinguishes a proxy/admin edit from a self edit, but is **not** authoritative attribution — join `manual_edit_audit` for that (IS-8).

### UI

Visual/interaction design is a `UI-SPEC.md` deliverable. Surfaces:

- **Scholar console** — a "My proxy editors" panel on `/edit` (and `/edit/scholar/[self]`), self-mode. Lists current proxies (names hydrated client-side via `GET /api/directory/people?cwids=…`), a `DirectoryPeopleTypeahead` (`components/edit/directory-people-typeahead.tsx`) to search by name → resolved CWID, an "Add" → `POST /api/edit/proxy {action:"grant"}`, and per-row "Remove" with a confirm dialog → `{action:"revoke"}`. Mirror `components/edit/unit-access-card.tsx`.
- **Superuser admin** — the same grant/revoke panel on `/edit/scholar/[cwid]` in `mode="superuser"` (D1 superuser-assist). The conflict check result (D3) surfaces as a real-time validation hint when feasible; the endpoint is the authoritative block.
- **Proxy edit surface** — `/edit/scholar/[cwid]` rendered with `mode="proxy"` shows the self-edit UI (overview + publication hiding) plus a distinct banner: "Editing [Scholar Name]'s profile as their designated proxy editor." A new `components/site/proxy-banner.tsx`, **visually distinct** from the impersonation banner (which says "viewing/acting as") to avoid confusion (its own styling class).
- **Directory people-search** — `GET /api/directory/people` **already exists** (`app/api/directory/people/route.ts`, SSO-gated, ED/LDAP-sourced, works for staff with no `Scholar` row, minimal attributes). **Reuse verbatim** for grantee resolution; this is a **required dependency** (document it).

### Notification (D2)

On a successful grant, after commit, send **two** plain-text emails via `sendMail` (`lib/edit/mailer.ts`), header-sanitized (`sanitizeHeader`), best-effort (failure logged, never surfaced; the grant already succeeded):

- **To the proxy** — "You have been designated as a proxy editor for [Scholar Name] (cwid). You may edit their profile overview and hide their misattributed publications; you cannot edit name/title/contact (upstream) or the profile URL (superuser-only). Edit at https://scholars.weill.cornell.edu/edit/scholar/<scholarCwid>. Access can be revoked at any time by the scholar or an administrator."
- **To the scholar** — **branch the copy on the real grantor** (CD-7): if `realCwid === scholarCwid`, "You have designated [Proxy Name] as a proxy editor…"; if a superuser granted on their behalf, "**A system administrator ([name]) assigned** [Proxy Name] as a proxy editor for your profile…". Source the grantor from `realCwid`, never the effective cwid.

The proxy's email is resolved from ED. **Recommended:** extend `/api/directory/people` (and the underlying `lib/sources/ldap` hydration) to include the email attribute so notification needs no separate LDAP call; if ED lacks an email for a CWID, the proxy notification silently no-ops (accepted fallback). **Revoke sends no email** (D2 is "on assignment"; silence on revoke avoids alarm — open question 2). The mailer stays **dormant** until ops verify the SES identity and flip the send flag (the grant succeeds regardless).

---

## Audit

A proxy **grant/revoke** writes a `proxy_grant` / `proxy_revoke` audit row: `actorCwid = realCwid` (the real grantor), `impersonatedCwid = NULL` (a grant is never an impersonated action — it is blocked while impersonating), `targetEntityType = "scholar"`, `targetEntityId = scholarCwid` (the grant's subject is the scholar), `before/after = { proxy_cwid, granted_by }`.

A proxy **edit** reuses the existing actions: `field_override` (overview) and `suppression_create` (publication hide). For these, `actorCwid = realCwid` (the proxy), `impersonatedCwid = NULL`. The durable, query-able marker that an edit was a proxy/admin edit is **`actor_cwid <> target_entity_id`** — but it does **not** by itself distinguish a scholar-assigned proxy from a #540 unit curator from a superuser; correct attribution **joins the live `scholar_proxy` / `unit_admin` tables** at query time (IS-8/CD-5).

`impersonated_cwid` is part of the `row_hash` recipe v2 (`lib/edit/audit.ts:146`): an attribution coding error (writing `session.cwid` where `realCwid` is required) produces a *self-consistent but misattributed* hash-valid row, so the **tests are the guard** — assert the audit row's `actor_cwid`/`impersonated_cwid` for the clean-proxy and superuser-impersonating-proxy cases (CD-5).

### Revalidation

- **Proxy `overview` edit** → `reflectOverviewEdit(slug)` (`lib/edit/revalidation.ts`), identical to a self-edit; the proxy's identity is transparent to the helper (it sees the scholar's slug). Nightly rebuild handles search.
- **Proxy publication hide** → `resolveAffectedProfiles("publication", pmid, scholarCwid)` → `reflectVisibilityChange` + `reflectSearchSuppression`, identical to a self-hide.
- **Proxy grant/revoke** → **no page revalidation** (the proxy list is on the uncached `/edit/*` surface only; nothing public changes).

### Audit queries

Runnable against the v1 schema; operational. ADR-005 / self-edit-spec / #540 queries are not duplicated.

```sql
-- A) All proxy-attributed edits (overview + publication hide): actor != target.
--    NOTE: also matches #540 unit-curator and superuser edits — join the live
--    scholar_proxy table (query C) to isolate scholar-assigned proxy edits.
SELECT aa.ts, aa.action, aa.target_entity_id AS scholar_cwid,
       aa.actor_cwid AS editor_cwid, aa.request_id
FROM scholars_audit.manual_edit_audit aa
WHERE aa.target_entity_type = 'scholar'
  AND aa.actor_cwid <> aa.target_entity_id
  AND aa.impersonated_cwid IS NULL          -- exclude impersonated edits (#637)
  AND aa.action IN ('field_override', 'suppression_create')
ORDER BY aa.ts DESC;

-- B) Proxy grant / revoke audit trail (the explicit designation events).
--    Any row whose impersonated_cwid IS NOT NULL is a coding bug (a grant must
--    never be impersonated — flag for review).
SELECT aa.ts, aa.action, aa.target_entity_id AS scholar_cwid,
       aa.actor_cwid AS grantor_cwid, aa.impersonated_cwid,
       JSON_UNQUOTE(JSON_EXTRACT(aa.after_values,  '$.proxy_cwid')) AS proxy_granted,
       JSON_UNQUOTE(JSON_EXTRACT(aa.before_values, '$.proxy_cwid')) AS proxy_revoked
FROM scholars_audit.manual_edit_audit aa
WHERE aa.target_entity_type = 'scholar'
  AND aa.action IN ('proxy_grant', 'proxy_revoke')
ORDER BY aa.ts DESC;

-- C) Currently-active grants (current state of access).
SELECT sp.scholar_cwid, sp.proxy_cwid, sp.granted_by, sp.created_at
FROM scholar_proxy sp
ORDER BY sp.scholar_cwid, sp.created_at;

-- D) D3 DRIFT WATCH (run on a schedule). A proxy that has since acquired a
--    conflicting role (Scholar / UnitAdmin). The superuser leg is checked live
--    per-edit (fail-closed) and cannot be expressed in SQL; this catches the DB
--    legs. A hit means the per-edit re-check is already DENYING the proxy path,
--    but the stale grant row should be revoked manually.
SELECT sp.scholar_cwid, sp.proxy_cwid, sp.created_at AS granted_at,
       CASE WHEN s.cwid IS NOT NULL THEN 'scholar'
            WHEN ua.cwid IS NOT NULL THEN 'unit_admin' END AS conflicting_role
FROM scholar_proxy sp
LEFT JOIN scholar    s  ON s.cwid  = sp.proxy_cwid AND s.deleted_at IS NULL
LEFT JOIN unit_admin ua ON ua.cwid = sp.proxy_cwid
WHERE s.cwid IS NOT NULL OR ua.cwid IS NOT NULL
ORDER BY sp.created_at DESC;

-- E) Fan-out audit (D5): proxies serving many scholars; scholars with many proxies.
SELECT proxy_cwid, COUNT(*) AS scholars_served FROM scholar_proxy
GROUP BY proxy_cwid HAVING COUNT(*) > 1 ORDER BY scholars_served DESC;
```

---

## Threat model

The reviewer is a security expert; this section folds in the priv-esc (PE), confused-deputy/audit (CD), and identity-session (IS) findings. Severities and IDs are carried from the investigation lenses.

### Threats and mitigations

| ID | Sev | Threat | Mitigation (load-bearing) |
|---|---|---|---|
| PE-01 / CD-1 / IS-1 / IS-10 | HIGH | **Impersonation overlay grants the proxy path.** A superuser impersonates a proxy (or the scholar) via #637; `session.cwid` becomes the effective/target cwid, so a proxy lookup keyed on `session.cwid` matches and the edit/grant succeeds with the superuser's reach — and a grant `grantedBy = session.cwid` is laundered as scholar-self. | **Key ALL proxy authz on `realCwid`** (`request.ts:49`), never `session.cwid` (`:176`). Assert the proxy edit path runs only when `impersonatedCwid === null`. The grant endpoint **blocks** while impersonating (or attributes to the real superuser). `grantedBy = realCwid`. |
| PE-02 / CD-3 / IS-7 | HIGH | **TOCTOU role-stacking.** A clean proxy is granted, then later made a Scholar/UnitAdmin/superuser; without a per-edit re-check they keep editing. The superuser leg is especially exposed — the preamble computes `isSuperuser` only for the *effective* cwid, so a proxy's own superuser status is otherwise never checked. | Run `checkProxyConflictingRole(realCwid)` — **all three legs incl. live `isSuperuser`** — at grant time (blocking) **and** every proxy edit (fail-closed). Window = one request. Centralize so no route ships the proxy path without the re-check. |
| PE-03 / IS-2 | HIGH | **Scope creep on suppress.** A blanket "isGrantedProxy ⇒ allow" lets a proxy hide *another* author's authorship, or suppress the scholar's grant/education/appointment/whole profile — exceeding D4. | **Positive allowlist:** proxy path entered only for `entityType='publication'` AND `contributorCwid === granted scholarCwid` (and `overview` for field). Reject everything else. |
| PE-06 / IS-3 | HIGH | **Cross-scholar edit.** A proxy of A POSTs an edit for B. The page gate does not protect the API (field/suppress never call `canAccessScholarEditPage` — only request-change does), so a scripted POST bypasses it. | **Composite-PK bind** in the handler: `findUnique({ scholarCwid: body.entityId/contributorCwid, proxyCwid: realCwid })`. Never `findFirst({ proxyCwid })` in a write path. Route test: proxy of A → `403` on B. |
| CD-4 | HIGH | **CSRF-forged grant.** The new endpoint, if it hand-rolls parsing, loses the same-origin guard; grants are effective immediately (D2), so one forged grant = instant edit access. | Route `POST /api/edit/proxy` through `readEditRequest` (inherits `verifyRequestOrigin`). Test: `Sec-Fetch-Site: cross-site` → `403` before any DB read. |
| PE-04 | MED | **Case/whitespace CWID bypass of D3.** A grant stored as `BEC4010` escapes the lowercase-keyed no-other-role check, yet matches later under case-insensitive collation. | Normalize + validate both CWIDs to canonical lowercase (`CWID_PATTERN`) at the top of the grant endpoint; store only normalized; confirm `scholar_proxy` collation matches `scholar`. |
| PE-05 / CD-3 | MED | **Grant a superuser/scholar as proxy (D3 leg deferred).** If the superuser leg is deferred to edit time, a scholar names a current superuser/scholar as proxy — a no-op for the superuser but an audit-confusing, orphan-able artifact. | Run **all three** D3 legs at grant time, blocking; distinct server-side reasons; opaque HTTP code (CD-6). |
| PE-07b / IS-9 | MED | **Edit a soft-deleted or hidden-class scholar.** field/suppress never check `deletedAt`; a proxy of a soft-deleted (60-day window) or #536 hidden-class scholar could write an override. | Page gate slots the proxy tier **before** the `loadEditContext`-null and `isPubliclyDisplayed` guards (proxy is NOT superuser for them). Reject proxy edits against a `deletedAt != NULL` scholar in the API too (ideally harden for all actors). |
| PE-08 / CD-2 | MED | **Compromised-scholar blast radius / proxy self-escalation.** A compromised scholar mints many durable proxy write paths; a proxy tries to manage the proxy list. | Server-backed per-scholar count cap (D5); a proxy can **never** grant/revoke (CD-2 — explicit `not_self`); consider a fixed-window rate limit on `/api/edit/proxy` (deferred, [non-goals](#non-goals)). |
| CD-6 | MED | **Role oracle.** Distinct D3 failure codes (`proxy_is_superuser`, …) let an insider probe arbitrary CWIDs' roles via the grant endpoint. | Collapse to a single opaque `proxy_ineligible` in the HTTP body; keep the specific reason in the server log only. |
| CD-5 / IS-8 | MED | **Attribution confusion.** `actor_cwid <> entity_id` does not distinguish scholar-proxy from unit-curator from a non-impersonating actor; a coding swap of real/effective is hash-valid but wrong. | Authoritative attribution joins `scholar_proxy`/`unit_admin` at query time; tests assert `actor_cwid`/`impersonated_cwid` for clean-proxy and impersonated-proxy cases. |
| CD-7 | MED | **Misleading notification.** A superuser-on-behalf grant tells the scholar "you designated…"; a rolled-back grant emits a "you were assigned" email. | Branch scholar copy on `realCwid` being a superuser; commit-first, notify-after. |
| CD-8 / IS-6 / PE-07a | MED | **Revoke-semantics drift.** Mixing hard-delete with a `revokedAt` filter leaves revoked proxies live; a non-atomic revoke loses the audit row. | Pin **hard-delete**; edit-time lookup checks existence only (no `revokedAt` filter); revoke = delete + `proxy_revoke` audit in **one** `$transaction`; ENUM extended before deploy. |

### Out of scope

- **SAML / SSO authentication integrity** (forged assertions, IdP compromise). The feature trusts `validateSamlResponse` for `realCwid`; assertion-level attacks are the SAML SP trust boundary (`docs/saml-sp.md`, `SAML_IDP_CERT` rotation), unchanged here.
- **Session cookie AEAD seal forgery / `session-cookie-key` compromise.** An attacker who can mint a sealed cookie already impersonates any CWID directly; owned by `lib/auth/session.ts` + Secrets Manager, not the proxy layer.
- **Direct DB tampering / SQL injection into `scholar_proxy`.** Prisma parameterizes all queries; `isSuperuser` escapes LDAP filter values (`superuser.ts:45`). Injection is an input-validation lens.
- **`manual_edit_audit` row tampering post-write.** Mitigated architecturally — the table is not a Prisma model and the app role is `INSERT`-only (`audit.ts:9-13`); `row_hash` is the tamper-evidence residual, unchanged.
- **Directory enumeration via `/api/directory/people`** for any authenticated user — a pre-existing #540 acceptance; this SPEC narrows only the **new** role-oracle the grant errors would add (CD-6).
- **Scholar account compromise itself** (credential theft) — an auth boundary; PE-08 covers only the proxy-specific blast-radius amplification.
- **Notification/email-header injection** — guarded by `sanitizeHeader` (`mailer.ts`); phishing-via-notification is an email-security lens.
- **Upstream ED/LDAP data integrity** (a person mis-tagged so `isSuperuser`/`UnitAdmin` reads wrong) — the D3 gate is only as correct as ED; an upstream-source lens.
- **Rate-limit / availability DoS on the grant endpoint** — flagged in PE-08/CD-6 for blast-radius, but pure quota DoS is deferred ([non-goals](#non-goals)).

### Must fix before build

1. **Key all proxy authz on `realCwid`**, never `session.cwid`/effective; assert the proxy edit path runs only when `impersonatedCwid === null`; the grant endpoint blocks while impersonating; `grantedBy = realCwid` (PE-01, CD-1, IS-1, IS-10).
2. **Run the full three-leg D3 check — incl. live `isSuperuser(cwid)` — at grant time (blocking) AND every proxy edit (fail-closed)**, on the proxy's own cwid; do not defer the superuser leg (PE-02, PE-05, CD-3, IS-7).
3. **Positive allowlist for the proxy write branch:** `overview`-only for field; `publication` + `contributorCwid === scholarCwid` for suppress. No blanket allow (PE-03, IS-2).
4. **Composite-PK bind** on the exact edit target for every proxy write authz; never `findFirst({ proxyCwid })` in a write path (PE-06, IS-3).
5. **Route `POST /api/edit/proxy` through `readEditRequest`** for the same-origin/Content-Type CSRF guard; add a cross-origin `403` test (CD-4).
6. **Normalize + validate both CWIDs to canonical lowercase** at the top of the grant endpoint; store only normalized; confirm collation parity (PE-04).
7. **A proxy can never grant/revoke** — grant authz is real-scholar-self OR real-superuser only (CD-2); add the proxy-grants-for-Y → `403` test.
8. **Pin hard-delete**; edit-time lookup is existence-only (no `revokedAt`); revoke = delete + `proxy_revoke` audit in one `$transaction`; add `proxy_grant`/`proxy_revoke` to **both** `lib/edit/audit.ts` AND `scripts/sql/audit-log.sql` ENUM before deploy (CD-8, PE-07a, IS-6).
9. **Reject proxy edits against a soft-deleted (`deletedAt != NULL`) scholar**, and slot the page-gate proxy tier before the `loadEditContext`-null / #536 guards (proxy is NOT superuser for them) (PE-07b, IS-9).
10. **Collapse grant-time D3 HTTP failure to one opaque `proxy_ineligible`**; keep specifics in the server log (CD-6).
11. **Commit-first, notify-after; branch scholar-notification copy on the real grantor** (CD-7).
12. **Regression tests** for: cross-scholar isolation (proxy of A → 403 on B), impersonation↔proxy mutual exclusion, revoke-takes-effect-next-request, hidden-class (#536) proxy 404, and the audit `actor_cwid`/`impersonated_cwid` shapes (PE-06, IS-1, IS-6, IS-9, CD-5).

---

## Edge-case test table

| # | Actor / scenario | Action | Expected result |
|---|---|---|---|
| 1 | Proxy `bec4010` granted for `ras2022` | `POST /api/edit/field {scholar, ras2022, overview}` | **ALLOW** — `field_override(scholar, ras2022, 'overview')`, `actorCwid=bec4010`; audit `actor_cwid=bec4010`, `impersonated_cwid=NULL`. |
| 2 | Proxy `bec4010` (granted for `ras2022`) | `POST /api/edit/field {scholar, **xyz9999**, overview}` (NON-granted scholar) | **403 `not_self`** — composite-PK bind finds no grant for `(xyz9999, bec4010)`; no write, no audit (PE-06). |
| 3 | Scholar `ras2022` grants a CWID that **is a Scholar** | `POST /api/edit/proxy {ras2022, <scholar cwid>, grant}` | **403 `proxy_ineligible`** (server log: `proxy_is_scholar`) — D3 leg 1 blocks (PE-05/CD-6). |
| 4 | Scholar grants a CWID that **holds a `UnitAdmin` row** | grant | **403 `proxy_ineligible`** (log: `proxy_is_unit_admin`) — D3 leg 2. |
| 5 | Scholar grants a CWID that **is a superuser** | grant | **403 `proxy_ineligible`** (log: `proxy_is_superuser`) — D3 leg 3 runs **at grant time**, not deferred (CD-3). |
| 6 | Clean proxy `bec4010` granted, then **added to the superuser group** in ED, then edits | `POST /api/edit/field {scholar, ras2022, overview}` | **403 `proxy_conflict`** — per-edit `checkProxyConflictingRole(bec4010)` live `isSuperuser` leg returns true (PE-02). Grant row remains; drift query D flags it. |
| 7 | Clean proxy granted, then **made a Scholar** (ED), then edits | field overview | **403 `proxy_conflict`** — D3 leg 1 at edit time. |
| 8 | Grant **revoked**; same proxy session re-POSTs | field overview | **403 `not_self`** — hard-deleted row; per-request lookup returns null on the **next** request (IS-6); no `revokedAt` filter (CD-8). |
| 9 | Proxy `bec4010` (granted for `ras2022`) | `POST /api/edit/field {scholar, ras2022, **slug**}` | **403 `not_superuser`** — `slug` routes to the superuser leg; the proxy branch is `overview`-only (PE-03/D4). |
| 10 | Proxy | `POST /api/edit/field {scholar, ras2022, **primaryTitle**}` | **400 `invalid_field`** — not in the editable-field allowlist (D4). |
| 11 | Proxy of `ras2022` | `POST /api/edit/suppress {publication, pmid, contributorCwid=ras2022}` (the scholar's own authorship) | **ALLOW** — scoped per-author hide; `actorCwid=bec4010`; reuses existing suppression write. |
| 12 | Proxy of `ras2022` | `POST /api/edit/suppress {publication, pmid, contributorCwid=**other author**}` | **403** — `contributorCwid !== granted scholarCwid`; the proxy may hide only the granted scholar's authorship (PE-03/IS-2). |
| 13 | Proxy of `ras2022` | `POST /api/edit/suppress {**scholar**, ras2022}` (whole-profile suppress) | **403** — whole-profile suppression is not in proxy scope (D4); the proxy branch is publication-only on suppress. |
| 14 | **Cross-origin** forged grant (no `Sec-Fetch-Site: same-origin`) | `POST /api/edit/proxy` | **403 `cross_origin`** — `verifyRequestOrigin` via `readEditRequest`, before any DB read (CD-4). |
| 15 | Proxy `bec4010` | `POST /api/edit/proxy {…, grant}` (a proxy tries to grant) | **403 `not_self`** — only real-scholar-self or real-superuser may grant; a proxy can never manage the list (CD-2). |
| 16 | Proxy `bec4010` | `POST /api/edit/grant` / `POST /api/edit/unit` / `POST /api/impersonation` (other admin endpoints) | **403** — `bec4010` holds no `UnitAdmin` role and is not a superuser; proxy-ship confers nothing on those surfaces (IS-3/IS-5). |
| 17 | **Superuser impersonating `bec4010`** (a proxy) via #637, then edits `ras2022` | field overview | **403** — proxy edit path asserts `impersonatedCwid === null` (IS-1); the impersonation overlay cannot ride the proxy grant. |
| 18 | **Superuser impersonating `ras2022`** (the scholar) | `POST /api/edit/proxy {ras2022, P, grant}` | **403 (impersonation block)** — a superuser-on-behalf grant must be a recorded superuser action with `grantedBy=realCwid`, not laundered as scholar-self under an overlay (IS-10/CD-1). |
| 19 | Superuser (not impersonating) | `POST /api/edit/proxy {ras2022, bec4010, grant}` | **ALLOW** — D1 superuser-assist; `grantedBy=realCwid` (the superuser); audit `actor_cwid=superuser`, `impersonated_cwid=NULL`; scholar notification says "A system administrator assigned…" (CD-7). |
| 20 | Grant for a **soft-deleted** scholar (`deletedAt != NULL`) | grant | **400 `scholar_not_found`** — a proxy can serve only a live scholar. |
| 21 | Proxy of a soft-deleted scholar (deleted **after** a valid grant) | field overview | **404 / reject** — `loadEditContext` null at page; API rejects `deletedAt != NULL` target (PE-07b). |
| 22 | Proxy of a **#536 hidden-class** scholar (doctoral student) | GET `/edit/scholar/[cwid]` | **404** — proxy is NOT a superuser for the `isPubliclyDisplayed` guard; same posture as the scholar themselves (IS-9). |
| 23 | Scholar grants the **same proxy twice** | grant, grant | Idempotent — `upsert` updates `grantedBy`; one row; one `proxy_grant` audit per call. |
| 24 | Scholar **revokes a non-existent** grant | revoke | **200 `changed:false`** — idempotent no-op; no audit row. |
| 25 | CWID supplied as `BEC4010` / `bec4010 ` (case/whitespace) | grant | Normalized to `bec4010` before D3; stored normalized; cannot phantom past the gate (PE-04). |
| 26 | Scholar names **two** proxies; both edit | field overview (each) | **ALLOW** both — many-to-many (D5); two grant rows; per-edit audit distinguishes by `actor_cwid`. |
| 27 | One proxy serves **many** scholars (department-admin) | field overview on each granted scholar | **ALLOW** each — `@@index([proxyCwid])` backs the landing redirect; the per-edit authz is the composite-PK bind (D5). |
| 28 | Scholar **at the server proxy cap** adds another | grant | **400 `proxy_limit_reached`** — server-backed cap (D5/PE-08). |
| 29 | `scholarCwid === proxyCwid` (self-proxy) | grant | **400 `cannot_proxy_self`** — self-editing directly is the path; a self-proxy is a confusing no-op. |
| 30 | B03 audit INSERT fails inside the grant transaction (e.g. ENUM not extended) | grant | **5xx `write_failed`** — whole transaction rolls back; no `scholar_proxy` row, no notification (commit-first ordering) (CD-8). |

---

## Phased implementation plan

| Phase | Scope | Key files |
|---|---|---|
| **1 — Data** | `ScholarProxy` model; offline additive migration; extend `AuditAction` (TS) and the `action` ENUM (SQL) with `proxy_grant`/`proxy_revoke`; confirm collation parity. | `prisma/schema.prisma`, `prisma/migrations/{ts}_add_scholar_proxy/migration.sql`, `lib/edit/audit.ts`, `scripts/sql/audit-log.sql` |
| **2 — Authz** | New `lib/edit/proxy-authz.ts`: `isGrantedProxy` (composite-PK), `checkProxyConflictingRole` (3-leg fail-closed). Add `"proxy_conflict"` denial reason. Unit tests for D3 legs, impersonation exclusion, cross-scholar isolation. | `lib/edit/proxy-authz.ts`, `lib/edit/authz.ts` |
| **3 — Identity** | `/edit` landing: non-scholar redirect to single granted scholar, or a minimal multi-proxy landing, or 404. Confirm impersonation candidates exclude non-scholars (no change expected). | `app/edit/page.tsx` |
| **4 — Edit write paths** | Page-gate proxy tier (between self/superuser and the null/#536 guards). Field-route `overview`-only proxy branch (composite bind + fail-closed re-check + `realCwid` + `impersonatedCwid===null`). Suppress-route scoped `publication`+`contributorCwid===scholarCwid` branch. `mode="proxy"` + banner. | `app/edit/scholar/[cwid]/page.tsx`, `app/api/edit/field/route.ts`, `app/api/edit/suppress/route.ts`, `components/edit/edit-page.tsx`, `components/site/proxy-banner.tsx` |
| **5 — API + UI (grant/revoke)** | `POST /api/edit/proxy` (mirror `grant/route.ts`; `readEditRequest`; normalize CWIDs; impersonation block; real-self/real-superuser authz; D3 blocking + opaque code; cardinality cap; hard-delete + audit in one tx). Scholar "My proxy editors" panel + superuser admin panel; reuse `DirectoryPeopleTypeahead`. Route tests (CSRF, cross-scholar, proxy-cannot-grant). | `app/api/edit/proxy/route.ts`, `components/edit/proxy-editor-card.tsx`, `components/edit/proxy-editor-admin-card.tsx`, `tests/unit/proxy-grant-route.test.ts` |
| **6 — Notification** | `lib/edit/proxy-notification.ts` (compose proxy + scholar bodies, grantor-branched copy). Optionally extend `/api/directory/people` + `lib/sources/ldap` to include email. Commit-first/notify-after wiring; dormant behind a send flag. | `lib/edit/proxy-notification.ts`, `app/api/edit/proxy/route.ts`, `app/api/directory/people/route.ts` |
| **7 — Audit + ops** | Audit queries A–E in a runbook; schedule the D3 drift watch (query D); update `docs/access-control-rbac.md` with the "Proxy Editor" row; ratify ADR-005 Amendment 3. | `docs/scholar-proxy-spec.md`, `docs/access-control-rbac.md`, `docs/ADR-005-manual-override-layer.md` |

---

## Non-goals

- **A new write mechanism.** Proxy editing reuses `field_override(scholar,…,'overview')` + per-author `suppression` + the `/edit/scholar/[cwid]` route verbatim; this SPEC adds only an actor and a grant table.
- **Widening the proxy field set beyond self-edit scope.** No `slug`, no upstream scalars, no whole-profile/whole-publication suppression — D4 is a hard architectural constraint, not a per-grant policy.
- **An acceptance step / pending-invite state.** D2 is effective-immediately; the grant table has no `accepted` flag.
- **Soft-revoke / revoke-reason metadata.** Hard-delete only; B03 is the revoke history.
- **Auto-revoke on role conflict.** The per-edit fail-closed re-check disables the path; the stale row is cleaned manually via the drift audit.
- **A FK from `scholar_proxy` to `scholar` (cascade).** No FK on either column (D3 forbids `proxyCwid` being a scholar; `scholarCwid` carries none to let a grant outlive a soft-delete inertly). Cleanup is the audit query, not a cascade.
- **Rate limiting on the grant endpoint.** The server-backed cardinality cap bounds the per-scholar count; a fixed-window per-actor rate limit (mirroring `request_change_rate_limit`) is a flagged fast-follow if abuse appears.
- **A proxy-management admin console (browse-all grants).** v1 manages per-scholar from `/edit`/`/edit/scholar/[cwid]`; a global console is a follow-up.
- **Proxy editing of upstream scalars even if SOR latency is painful.** A flagged fast-follow for the *self-edit* feature (`self-edit-spec.md`), not for proxies — a proxy never exceeds the scholar's scope.
- **Surfacing the proxy relationship on the public profile.** Proxy status is an internal edit-surface detail; nothing public changes on a grant.

---

## References

- [ADR-005](./ADR-005-manual-override-layer.md) — the `field_override` / `suppression` mechanism this SPEC reuses; this SPEC is ratified as **Amendment 3** (one new access-grant table, parallel to Amendment 1's `UnitAdmin`; Amendment 2 is the slug-override reconcile decision).
- [`self-edit-spec.md`](./self-edit-spec.md) — the scholar-facing sibling; the proxy reuses its scholar write path, field set, validation, sanitization, and `/edit/scholar/[cwid]` route. Its authorization table widens its `overview`-edit and per-author publication-hide rows to admit the granted-proxy actor.
- [`unit-curation-spec.md`](./unit-curation-spec.md) (#540) — the **distinct** unit-role proxy model; this SPEC keeps the two axes separate ([Relationship to #540](#relationship-to-540-unit-role-proxy-editing)).
- [`impersonation-spec.md`](./impersonation-spec.md) (#637) — the effective-identity overlay this SPEC stays orthogonal to ([Identity and session](#identity-and-session)).
- `lib/edit/authz.ts` (the pure-predicate set; `canProxyEdit` is the **#540** predicate), `lib/edit/request.ts` (`readEditRequest`, the real-vs-effective split), `lib/edit/audit.ts` (`appendAuditRow`, `row_hash` v2), `lib/auth/superuser.ts` (`isSuperuser`, fail-closed LDAPS), `lib/auth/effective-identity.ts` (`getEffectiveEditSession`, impersonation seam), `app/api/edit/grant/route.ts` (the grant/revoke pattern to mirror), `app/api/directory/people/route.ts` (the existing people-search dependency), `lib/edit/mailer.ts` (the dormant SESv2 notification path).
- B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) / B02 [#101](https://github.com/wcmc-its/Scholars-Profile-System/issues/101) / B03 [#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102) — SSO, authorization predicate, audit log.
