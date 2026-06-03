# ED admin-role org-unit managers — spec

Status: DRAFT (design pass; no code written). Branch `feat/ed-admin-org-unit-roles`.
Parent issue: **#540** (Unit curation — three-tier access). This feature supplies the
"upstream source for who administers a unit" that `docs/unit-curation-spec.md` § Interfaces
(line 340) explicitly deferred: *"There is no upstream source for 'who administers a unit.'
… no ETL backfill is possible."* This spec overturns that for the ED-sourced populations
only, leaving the manual grant path intact.
Related: **#160** (Request-a-change mailer, reused for Part 3), **#637** (effective-CWID
seam, threaded by every write), **#443** (VPC↔WCM LDAPS connectivity — a hard runtime
prerequisite, see § 9).

Authoritative substrate, do not re-design: `lib/edit/authz.ts` (predicate suite),
`prisma/schema.prisma` model `UnitAdmin` / enums `UnitRole` / `EntityType`,
`app/api/edit/grant/route.ts` (the grant write path), `lib/auth/superuser.ts` (live
fail-closed group read), `lib/sources/ldap.ts` (`openLdap`), `lib/edit/request-a-change.ts`
+ `app/api/edit/request-change/route.ts` (the mailer), `docs/ADR-005-manual-override-layer.md`
Amendment 1 § A1.2 (the three-tier model + threat model).

---

## 0. Phase-0 probe results & locked decisions (2026-06-03) — AUTHORITATIVE

The Phase-0 discovery probe (`etl/ed-admins/probe.ts`) has been RUN against the live WCM
Enterprise Directory. **This section is authoritative.** Where §1 (managedUnits out-of-scope
bullet), §2.3 (population→type table), §3.1 (LDAP fetcher row), §4.1 (tab gate), §6 (phase
ordering) or §8 (probe-pending) conflict with it, §0 wins.

**Probe findings (OQ-1 / OQ-2 / OQ-5 — resolved empirically).**
- The populations are **not cn-named groups**. They are LDAP **option-tagged subtypes of
  `weillCornellEduCWID`** carried on the org-unit group entries under
  `ou=orgunits,ou=Groups,dc=weill,dc=cornell,dc=edu` (objectClass `weillCornellEduOrgUnit`).
- Each entry's `cn` = the canonical **N-code** (`N1280`=Medicine, `N1005`=Meyer Cancer
  Center) — the SAME code `etl/ed/index.ts` already writes to `Department.code`/`Division.code`
  (**OQ-5 ✅**: join on the N-code; the legacy 10-digit lives in `weillCornellEduFundCenter`
  and is NOT the join key). The entry also carries `weillCornellEduType` (department|division),
  `weillCornellEduOrgUnitLevel` (1–6), and `displayName`.
- The admin's unit **is** the entry it sits on — no per-person attribute (**OQ-2 ✅**).
- Tags present across **2,439** org-unit entries: `;da` (2121 units / 58 cwids),
  `;dd` (2066 / 133), `;diva` (949 / 129), `;iamdela` (258 / 290), `;diva-iamdela` (12 / 7).
  **`;diva` and `;diva-iamdela` are DISTINCT populations** — do not conflate.
- **ldapts cannot filter on `attr;tag`** (raises `Invalid expression`). The ETL MUST fetch
  the org-unit entries and read the tagged keys; it must NOT presence-filter the subtype.

**Locked decisions.**
- **D1 — Import set (4 tags):** `;da`, `;diva`, `;iamdela`, `;diva-iamdela`. **EXCLUDE `;dd`.**
  (`;diva` = Division Administrator was added as the division analog of `;da`.) `source`
  values: `ED:DA`, `ED:DivA`, `ED:IAMDELA`, `ED:DivA-IAMDELA`.
- **D2 — Role:** all four populations → `UnitRole.curator` (no `owner`, no delegation). (OQ-3 ✅.)
- **D3 — `entityType` comes from the UNIT, not the tag.** The tag selects WHICH people; the
  grant's `entityType` (department|division|center) is the Scholars classification of that
  N-code. **The §2.3 "DivA-IAMDELA→division" tag→type table is VOID.** A person can hold
  several tags on one unit (e.g. `lch4005` is both `;iamdela` and `;diva-iamdela` on N1005) —
  the `source` grammar already namespaces this and the reconcile is per-`source`.
- **D4 — Unmapped units: skip + log.** Import a grant only when the N-code resolves to an
  existing Scholars `Department`(L1)/`Division`(L2)/`Center` row. The WCM tree is **6 levels**
  deep; ~1,635 of 2,131 admin-bearing units are divisions at level 3–6 with no Scholars row —
  those are `skipped_no_unit` (never written). Effective coverage ≈ 97 dept/L1 + 399
  division/L2 + centers. (Realizes §3.5; relates to OQ-4.)
- **D5 — Administrators tab audience:** superusers AND unit **Owners** (an Owner sees only
  grants within their owned subtree, scoped server-side). This makes the
  `EditSession.managedUnits`/`unitCodeScope` wiring (previously deferred to Phase E)
  **in-scope this milestone**. (OQ-9 ✅ — supersedes the "superuser-only at launch" language
  in §1 / §4.1 / §6.)
- **D6 — Issue:** **#728** backs this work (OQ-11 ✅).

---

## 1. Goal & scope

Three parts.

**Part 1 — ED admin-role ETL.** Import three WCM Enterprise Directory (LDAP) admin-role
populations — **DAs** (Department Administrators), **IAMDELA**, and **DivA-IAMDELA** — and
provision each member as a per-unit *manager* (a `UnitAdmin` grant) on one or more org units
(`Department` / `Division` / `Center`). Each grant is **locked to the member's assigned
unit(s)**: the member can manage only those unit(s), cannot widen scope, and cannot
self-escalate. Re-running the job is idempotent; a member dropped from an ED population has
their ED-sourced grant revoked, without disturbing manually-granted rows.

**Part 2 — "Administrators" tab.** A new superuser surface at `/edit/administrators`,
reachable from the existing `AdminSubnav` strip, that lists every `UnitAdmin` grant grouped
by person, shows each person's role and **scope** (the org units they manage and the
provenance of each grant), and lets an authorized actor **add a user**, **update a user's
role**, and **revoke**. All writes route through the *existing* `POST /api/edit/grant`
(no second write surface) so the `lib/edit/authz.ts` predicates remain the single gate.

**Part 3 — superuser-only org-unit creation + email-request fallback.** Only **superusers**
may CREATE a new org unit. A non-superuser who needs a new org unit requests it via an email
to `support@med.cornell.edu` using the **existing** Request-a-change mailer
(`lib/edit/request-a-change.ts` + `POST /api/edit/request-change`) — a new `RequestAttribute`
and `ChangeIssue` are added; **no new mailer is built**. The reuse is **config-only on the
server**: the request is *self-targeted* (`targetCwid` omitted ⇒ defaults to the requester),
which satisfies the route's existing `canAccessScholarEditPage`/`not_self` gate and rate limit
**without any route-logic change** — see § 4.6.1 for the exact body shape and gate reasoning.

### Out of scope

- **No new `UnitRole` tier.** "Manager" maps onto the existing `owner`/`curator` enum
  (§ 2.2 / OQ-3). No `manager` enum value, no enum migration.
- **No new authorization path.** The ED ETL writes the same `UnitAdmin` rows a human grant
  would; scope-locking and anti-self-escalation come entirely from the existing predicates.
  No SSO-group-derived unit role.
- **No center scope from ED.** Centers (`Center.code`) carry no LDAP `weillCornellEduOrgUnit`
  level1/level2 code, so the ED populations map only to `department`/`division`. Center
  manager grants remain manual via `/api/edit/grant` (OQ-7).
- **No department/division create surface beyond what `/api/edit/unit` already offers.**
  Departments are ED-canonical with no create path; coded divisions are already
  Superuser-only (`createCodedDivision`); informal centers are Owner-or-Superuser today and
  Part 3 narrows them to Superuser-only (§ 4.5). No new dept-create flow.
- **No `EditSession.managedUnits` extension in this milestone's required path.** Org-unit
  admins seeing the scoped Profiles roster (`loadEditRoster(unitCodeScope)`, the documented
  B3 hook) is a *follow-on*; Part 2 ships superuser-only first (OQ-9, § 6 Phase D).
- **No new ServiceNow integration.** Part 3's request is an email, consistent with #160's
  current state (no Scholars SN business service yet).
- **No backfill of historical/manual admins.** This job manages only its own ED-sourced rows.

---

## 2. Data model

### 2.1 Reuse `UnitAdmin` — add ONE provenance column

The per-unit manager grant already exists (`prisma/schema.prisma` model `UnitAdmin`,
`@@id([entityType, entityId, cwid])`, `role: UnitRole`, `grantedBy`, `createdAt`). It has
**no provenance column today** — an ETL-written row and a hand-granted row are
indistinguishable. That is the linchpin gap: without it the reconcile step (§ 3.4) cannot
tell its own rows apart from a Superuser's hand-entered grants, and the UI cannot protect
ED-locked rows from human edit.

Add exactly one additive column, mirroring the house `source` convention already on
`Department` / `Division` / `Center` / `CenterMembership` / `DivisionMembership`:

```prisma
model UnitAdmin {
  entityType EntityType @map("entity_type")
  entityId   String     @map("entity_id") @db.VarChar(64) // unit code
  cwid       String     @db.VarChar(32)                   // grantee
  role       UnitRole
  grantedBy  String     @map("granted_by") @db.VarChar(32) // actor CWID (or ED-ETL sentinel)
  source     String     @default("manual") @db.VarChar(32) // NEW: "manual" | "ED:DA" | "ED:IAMDELA" | "ED:DivA-IAMDELA"
  createdAt  DateTime   @default(now()) @map("created_at")

  @@id([entityType, entityId, cwid])
  @@index([cwid])
  @@index([source])                                        // NEW: reconcile + Administrators-tab provenance filter
  @@map("unit_admin")
}
```

Migration is **additive only** (column defaulted, new index) — every existing row reads as
`source='manual'`, so the existing grant route and predicates are unaffected. Follow the
`prisma/migrations/20260528150000_unit_curation_phase1/` template; the offline-generate
discipline (`prisma migrate diff --from-schema/--to-schema --script`) applies (local dev DB
is drifted; never `prisma migrate dev`).

**`source` value grammar.** `manual` for any human grant. `ED:<population>` for an ETL grant
— the colon namespaces the population so a single member appearing in two populations
(§ 7 row "two populations") is representable and the reconcile delete-set is per-population
scoped. The Administrators tab reads the prefix `ED:` to label a row as upstream-locked.

> Rejected alternative — a `grantedBy='ED-ETL'` sentinel with no `source` column. Rejected:
> `grantedBy` is a free CWID-shaped string with no schema guarantee, a real operator CWID
> could collide, and it cannot encode which of three populations sourced the row (needed for
> per-population reconcile). A typed `source` column is the enforceable mechanism.

### 2.2 How "locked" is enforced at the data layer

"Locked to specific unit(s), cannot self-escalate or manage others" is enforced by three
independent, already-shipped mechanisms plus one new gate:

1. **Scope = the row's `(entityType, entityId)`.** A `UnitAdmin` row authorizes *only* the
   unit code it names (`getEffectiveUnitRole`, `lib/edit/authz.ts`). A department grant
   cascades read-time to that department's divisions; a division grant does **not** cascade
   upward. The ETL writes the member's assigned unit code(s) and nothing else — scope cannot
   exceed what is written.

2. **Cannot self-escalate / cannot widen.** `canGrant` (`lib/edit/authz.ts`) already forbids:
   a `curator` granting anything (`authority_violation`); an `owner` granting outside their
   owned subtree (`scope_violation`). A grant's authority is `≤` the grantor's own role and
   its scope `⊆` the grantor's own subtree. **No new code is required for the escalation
   guarantee** — provisioning a member as `curator` (§ 2.3) means they can edit but never
   grant, satisfying "cannot manage others" by construction.

3. **Cannot mutate one's OWN ED-locked grant (new gate).** The existing self-revoke footgun
   guard in `app/api/edit/grant/route.ts` blocks an *owner* revoking *themselves*, but
   nothing today stops a holder editing/revoking their own ED-sourced row via the UI, nor a
   Superuser silently mutating an ED row that the next ETL run will simply re-assert. Add to
   the grant route: **an `action` against a row with `source` LIKE `ED:%` is refused** (reason
   `ed_locked`, a new `AuthzDenialReason`) — for **everyone, superusers included** (amended
   2026-06-03: a superuser override would only be re-synced on the next import, a silent-revert
   footgun; the role is changed at the source — the Web Directory). The tab is labelled "managed
   through the Web Directory … read-only here", so the gate makes the behaviour match the
   promise. See § 5 MUST-7.

   **Implementation detail (the gate has nothing to read until `source` is surfaced).** The
   route's existing idempotency probe selects only `{ role, grantedBy }`
   (`app/api/edit/grant/route.ts:130-135`). To enforce the gate this select MUST be **extended
   to include `source`**:

   ```ts
   const existing = await db.read.unitAdmin.findUnique({
     where: { entityType_entityId_cwid: { entityType, entityId, cwid } },
     select: { role: true, grantedBy: true, source: true }, // + source (NEW)
   });
   ```

   **Required code edits (this is NOT pure config):**
   - Add `ed_locked` to the `AuthzDenialReason` union in `lib/edit/authz.ts:24-41`
     (the union ends at `proxy_target_not_in_unit` today; append the new member with a doc
     comment). `editError(403, "ed_locked")` then type-checks.
   - **Ordering.** `canGrant` already runs at `route.ts:115` (before the idempotency probe at
     `:130`). The `ed_locked` gate depends on the existing row's `source`, which is only known
     **after** the probe — so place the gate **immediately after the probe (`:135`) and before
     the write transaction (`:141`)**. Sequence for a UI write: `verifyRequestOrigin` →
     self-revoke footgun → `findUnit` → `canGrant` → **probe (now selects `source`)** →
     **`ed_locked` gate** → write. (Putting it before `canGrant` is not possible — the source
     isn't loaded yet.)
   - The gate: `if (existing && existing.source.startsWith("ED:") && !session.isSuperuser) {
     logEditDenial({…, reason: "ed_locked" }); return editError(403, "ed_locked"); }`. For a
     superuser the write proceeds; the existing B03 audit row already records `before_values`
     including the ED `source`, so the superuser-override note is captured without a new audit
     shape. (Use the in-memory `startsWith("ED:")` on the loaded row rather than a DB
     `LIKE 'ED:%'` round-trip — the row is already in hand.)

### 2.3 Population → org-unit type + role mapping (RESOLVED by Phase-0 — see §0; old table VOID)

**Resolved (§0).** The populations are option-tagged `weillCornellEduCWID;<tag>` attributes on
the org-unit entries; the unit linkage is the entry's N-code. The `entityType` is **derived
from the Scholars classification of that N-code (D3)**, NOT from the tag. The role is
`curator` for all four (D2). The `source` namespaces the population for per-population reconcile.

| ED tag | Population | `UnitRole` | `source` | `entityType` |
|---|---|---|---|---|
| `weillCornellEduCWID;da` | Department Administrator | `curator` | `ED:DA` | from the unit (D3) — usually department |
| `weillCornellEduCWID;diva` | Division Administrator | `curator` | `ED:DivA` | from the unit (D3) — usually division |
| `weillCornellEduCWID;iamdela` | IAM Delegated Admin | `curator` | `ED:IAMDELA` | from the unit (D3) |
| `weillCornellEduCWID;diva-iamdela` | Division IAM Delegated Admin | `curator` | `ED:DivA-IAMDELA` | from the unit (D3) |
| `weillCornellEduCWID;dd` | (unconfirmed) | — | — | **EXCLUDED — not imported** |

Curator (not owner) for all: edits + proxy-edits the unit's faculty but **cannot grant/delegate**
→ satisfies "cannot self-escalate or manage others" by construction (`canGrant` blocks any
curator grant). `owner` would confer delegation power and is not minted for any ED population.

- **Default to `curator`.** The feature requirement "cannot self-escalate or manage others"
  is the security-conservative reading: `curator` can edit the unit and proxy-edit its
  faculty but cannot grant. `owner` would give every imported admin delegation power over
  their whole subtree (a large blast radius) and is the **opt-in, per-population** choice a
  stakeholder must approve (OQ-3). Do not default any population to `owner`.
- **Unit-code resolution.** The importer resolves each member to a `Department.code`
  (LDAP level1) or `Division.code` (LDAP level2) — the same stable codes
  `etl/ed/index.ts` derives from `weillCornellEduOrgUnit` and writes to
  `Department`/`Division`. The join is **code-only** (no display-name matching). If a
  resolved code has no matching unit row, the grant is **skipped and logged**, never written
  (a `UnitAdmin` row has no FK, so a dangling code would grant access to nothing — fail loud,
  see § 3.5 and § 7 "org-unit renamed/consolidated"). Apply the same dept-code
  canonicalization (`deptAlias`/consolidation) `etl/ed/index.ts` uses, or imported grants can
  land on a non-canonical code (OQ-5).

---

## 3. ETL job design

### 3.1 Location, script, image, cadence

| Aspect | Value | Source pattern |
|---|---|---|
| Script | `etl/ed-admins/index.ts` (LDAP reader + reconcile) | mirrors `etl/ed/student-programs.ts` (own `openLdap` client, own `EtlRun` row) |
| Probe | `etl/ed-admins/probe.ts` | mirrors `etl/ed/probe-group.ts` (run FIRST, § 8) |
| npm script | `"etl:ed:admins": "tsx etl/ed-admins/index.ts"` + `"etl:ed:admins:probe": "tsx etl/ed-admins/probe.ts"` | colon-nested under the **`ed`** family to match the verified sibling `etl:ed:student-programs` (`package.json:34`); do **not** use a top-level `etl:ed-admins` (drifts from the convention) |
| LDAP group fetcher | NEW function in `lib/sources/ldap.ts` — enumerate a group's `member` DNs (none exists; `superuser.ts` only does single-CWID existence) | `lib/sources/ldap.ts` SOR-fetcher shape + `parseManagerCwid` `^uid=([^,]+)` DN parse |
| Docker target | reuse the existing `etl` target (`Dockerfile` `FROM base AS etl`, `scholars-etl-*` ECR) — every `etl:*` script already runs there; no Dockerfile change | `Dockerfile` lines 47-58 |
| Step Function step | `StepSpec { id: "EdAdmins", npmScript: "etl:ed:admins", external: true }` in `cdk/lib/etl-stack.ts` `nightlySteps`, sequenced **immediately after `Ed`** (depends on `Department`/`Division` rows existing) and before `SearchIndexNightly` | `cdk/lib/etl-stack.ts` lines 585-605; `external: true` because it reads WCM LDAPS via the per-source secret |
| Local chain | add the same step to `etl/orchestrate.ts` in the post-ED block (`[ "ED-Admins", "etl/ed-admins/index.ts" ]`, mirroring the `ED-Student-Programs` entry at `etl/orchestrate.ts:68`) | `etl/orchestrate.ts` |

`external: true` matters: the step joins the six external sources whose per-source
`SCHOLARS_*` secret is fanned in (`cdk/lib/etl-stack.ts`). It reuses the ED LDAP bind
(`SCHOLARS_LDAP_*`, `DEFAULT_BIND_DN = cn=reciter,…`); no personal DN in code.

> **Mirror-claim scope (verified).** `etl/ed/student-programs.ts` is the precedent for the
> **script shape only** — its own `openLdap` client, its own `EtlRun` row, and its
> `etl:ed:*` npm naming. It is **NOT** a precedent for nightly Step Function wiring: it lives
> only in `etl/orchestrate.ts:68` and as an npm script and is **not present in
> `cdk/lib/etl-stack.ts nightlySteps`** (verified — no `StudentProgram`/`student-programs`
> reference there). So adding `EdAdmins` as a standalone nightly Step Function step is a **new
> pattern**, justified by `external: true` (it needs the per-source LDAPS secret fanned into
> the external lane). Wiring it nightly vs. running it only via the orchestrator/manual is
> itself a decision gated on #443 reachability (OQ-4) — if held, add it to `orchestrate.ts`
> only and defer the CDK `nightlySteps` entry.

### 3.2 EtlRun lifecycle

Wrap the run in an `EtlRun` row (`prisma/schema.prisma` model `EtlRun`):
`source = "ED-Admins"` (new free-text value, consistent with `"ED-Student-Programs"`),
`status` `running → success | failed`, `rowsProcessed` = grants upserted + revoked.
Guard `main()` with the `if (process.env.VITEST) return` pattern `etl/ed/index.ts` uses so
the module is import-safe in tests. LDAP fetches are best-effort and **fail closed** (§ 3.6).

### 3.3 Idempotent upsert (keyed on CWID, org-unit, role-source)

For every (member CWID, resolved unit code, population) tuple, upsert the `UnitAdmin` row on
the compound PK `(entityType, entityId, cwid)`:

- `create`: `{ entityType, entityId, cwid, role, grantedBy: "ED-ETL", source: "ED:<pop>" }`.
- `update`: set `role`, `source`, `grantedBy: "ED-ETL"` (re-assert; a manual `owner` grant on
  the same `(unit, cwid)` is the conflict case — see MUST-9 and OQ-6).

CWIDs are **lower-cased** before write (DN case-folding gotcha — ED member DNs return
mixed-case; `parseManagerCwid` lowercases). Re-running the job rewrites in place, never
duplicates (the PK guarantees it).

`grantedBy = "ED-ETL"` is a reserved synthetic actor for the breadcrumb; the *typed* `source`
column is the load-bearing provenance, not `grantedBy` (§ 2.1). Validate the sentinel does
not collide with `CWID_PATTERN` (`/^[a-z][a-z0-9]{2,8}$/`) — `ED-ETL` contains `-` and an
uppercase, so it is not a valid CWID and cannot shadow a real operator.

### 3.4 Revocation / reconciliation (the #393 reconciler pattern)

Reconciliation is **per-population, source-scoped** — the same discipline as the
`#393 suppression reconciler` (ADR-005 layer 3: the SOR is canonical, tombstone the rest, but
NEVER touch rows of another source) and the ED ETL's own `deleteMany(where: {source:'ED', …})`
orphan-sweep (`etl/ed/index.ts` lines 1498-1514, 227-228).

For each population P with set `seen_P` = `{(entityType, entityId, cwid)}` written this run:

```
deleteMany where source = "ED:P"
            AND NOT (the (entityType, entityId, cwid) tuple is in seen_P)
```

Mechanically: collect each population's seen-key set in memory, then `deleteMany` the
`source='ED:P'` rows whose key is not in `seen_P` (chunked `OR`/`notIn`, mirroring the
`classifyByExternalId` reconcile primitive in `lib/etl/reconcile.ts` and the ED appendix's
stale-`externalId` delete). This:

- removes a member who left ED population P (their `ED:P` row is swept);
- **never** deletes a `source='manual'` row (a Superuser's hand grant survives);
- **never** deletes another population's row (a person in DA *and* IAMDELA keeps both,
  § 7 "two populations").

**Empty-source guard (fail-closed reconcile).** If the LDAP fetch for a population returns
**zero** members (transient directory outage, ACL change, or the group went away), the
reconcile for that population is **skipped** and a WARN is logged — an empty fetch must NEVER
trigger a `deleteMany` that wipes the whole population's grants. This mirrors the
`reference_eutils_esearch_retstart_cap` lesson (validate the fetch is non-empty before
acting) and the ED ETL's empty-source protections. Per-population isolation: one population's
empty fetch never blocks another's reconcile.

### 3.5 Skip-and-log, never half-write

- Member DN that does not parse to a CWID → skip + WARN (count `skipped_unparsable`).
- Resolved unit code with no matching `Department`/`Division` row → skip + WARN
  (count `skipped_no_unit`). Do NOT write a dangling `UnitAdmin` row (no FK = silent
  grant-to-nothing).
- Center mapping requested but population is dept/div-only → not applicable (centers excluded).

### 3.6 LDAP reachability & dormancy

The SPS VPC currently cannot route to WCM LDAPS (#443) — `isSuperuser` already fails closed
to an env allowlist for this reason. The ETL inherits this: in a deployed env with no route,
`openLdap()` throws/binds-fail, the job records `EtlRun status='failed'` with
`errorMessage='ldap_unavailable'`, **writes nothing, deletes nothing**, and exits non-fatally
(the orchestrator continues). The job is therefore **safe to deploy dormant**: it does no
harm until connectivity lands. Until then it runs from an operator vantage that can reach the
directory (manual `npm run etl:ed:admins`), exactly as the superuser allowlist is the interim
for `isSuperuser`. This is a launch dependency, not a code blocker (§ 9, OQ-4).

### 3.7 Audit story for ETL grants

Per-row B03 audit (`appendAuditRow`, `action: "grant_change"`) requires a real `actorCwid`.
ETL grants use the `ED-ETL` synthetic actor. Decision (default, confirm OQ-8): **the ETL does
NOT write a per-row B03 audit**; provenance + count are captured by the `EtlRun` row
(`source='ED-Admins'`, `rowsProcessed`) and the `source='ED:%'` column on each grant. Rationale:
B03 is the *human* tamper-evident edit log; flooding it with thousands of machine grants on
every nightly run dilutes it, and the `scholars_audit` INSERT grant is least-privilege
(`sps_bootstrap`) — the ETL DB role may not even hold it (OQ-10). A *UI* grant/revoke from the
Administrators tab still audits (it goes through `/api/edit/grant` unchanged). If a stakeholder
wants ETL grants audited, the fallback is a single summary audit row per run, not per-grant.

---

## 4. "Administrators" tab (Part 2)

### 4.1 Route, gate, chrome

- Page: `app/edit/administrators/page.tsx` — Server Component, `export const dynamic =
  "force-dynamic"`, `metadata.robots = { index: false, follow: false }`. Mirror
  `app/edit/scholars/page.tsx` verbatim: resolve `getEffectiveEditSession()`; redirect to
  `/api/auth/saml/login?return=…` if no session; then `requireSuperuserGet({ session, path:
  "/edit/administrators", targetId: "administrators" })` — **superuser-only at launch**
  (OQ-9). The query is the scope boundary, never the UI.
- Tab: extend `components/edit/admin-subnav.tsx` — `AdminSubnavActive` gains
  `"administrators"`; add an `AdminTab href="/edit/administrators" id="administrators"
  label="Administrators"`. Gate visibility behind the feature flag (§ 6): pass `null` to hide
  the tab when off, exactly as `pendingSlugRequests === null` hides "URL requests".

### 4.2 List + scope view (the read)

A new loader (e.g. `lib/api/admins-roster.ts`) selects all `UnitAdmin` rows and **groups by
`cwid`**, then resolves each unit code to its display name (`findUnit` /
`lib/api/unit-edit-context.ts` shaping) and each grantee CWID to a name. Per the runnable
audit query B in `docs/unit-curation-spec.md`:

```sql
SELECT entity_type, entity_id, cwid, role, source, granted_by, created_at FROM unit_admin;
```

Display, one card per person (reuse the `unit-access-card.tsx` shaping, generalized
cross-unit):

| Column | Source |
|---|---|
| Person (name + cwid) | `GET /api/directory/people?cwids=…` — DAs/IAMDELA are admin staff with **no Scholar row**, so resolve against ED, not the Scholar corpus. Render `cwid` bare when name unresolved (the existing access-card fallback). **See #443 note below — this column ships name-less in deployed envs.** |
| Org units (scope) | each grant's `(entityType, entityId)` → unit display name + kind badge — **resolved from the local `Department`/`Division`/`Center` tables (`findUnit`), NOT LDAP, so this column is fully available regardless of #443.** |
| Role | `owner` / `curator` per unit |
| Provenance | `source`: "Manual" or "ED — DA / IAMDELA / DivA-IAMDELA" |

**#443 dependency on the person column (expected launch state, NOT a bug).**
`GET /api/directory/people` calls `openLdap()` against `ou=people` — the **same VPC↔WCM gap
(#443)** that blocks the ETL (§ 3.6, § 9). In every deployed env until routing lands, that
call fails, so **the Person *name* column is empty and every person renders as a bare CWID**.
This is the expected launch state of the Administrators tab in deployed environments, not a
"names are broken" defect. Only the person-name column degrades — the **Org units (scope),
Role, and Provenance columns come from the local DB and are fully populated**. From an
operator vantage that can reach the directory (the same interim used for the manual ETL run),
names resolve normally. Surface this with a one-line banner on the tab when name-resolution
returns nothing ("Person names are resolved from the Enterprise Directory and are unavailable
until directory routing (#443) lands; access scope below is accurate"). Confirm this name-less
launch state is acceptable (OQ-12).

Empty state: when no grants exist, render an explicit "No administrators yet" panel, not a
blank table. A person with grants on multiple units shows multiple scope rows under one card.

### 4.3 Add / update-role / revoke (the writes)

All three actions POST the **existing** `app/api/edit/grant/route.ts`
(`{ entityType, entityId, cwid, role, action: "grant" | "revoke" }`):

- **Add user**: resolve grantee by name via `GET /api/directory/people` typeahead
  (`components/edit/directory-people-typeahead.tsx`), pick unit + role, `action: "grant"`.
- **Update role**: re-`grant` the same `(unit, cwid)` with the new role (idempotent upsert).
- **Revoke**: `action: "revoke"` (hard-delete).

No new write endpoint. The route's `canGrant` gate, self-revoke footgun guard, B03 audit, and
`reflectUnitChange` all apply unchanged. The new **ED-locked gate** (§ 2.2 #3 / § 5 MUST-7) is
added *inside* this same route so the Administrators tab cannot bypass it.

### 4.4 Deselect / empty / redundant-filter UX

- The role control is a two-option radio (`owner` / `curator`) as in `unit-access-card.tsx`;
  there is no "none" option — removing a grant is **Revoke**, an explicit destructive action
  with confirm, not a deselect.
- An **ED-locked** row renders its Revoke / role controls **disabled** with an inline note
  ("Managed by the Enterprise Directory; changes are reverted on the next import — request a
  change to the source"), so the affordance matches the gate (a disabled control, not a
  click-then-403). Superusers see the controls enabled but with the same caveat note.
- A provenance filter ("All / Manual / ED") is a convenience; default **All**. When a filter
  yields zero rows, show "No administrators match this filter," not the global empty state.

### 4.5 Superuser-only create-org-unit (Part 3a)

`app/api/edit/unit/route.ts` already gates `createCodedDivision` to superuser-only. Part 3
**narrows** the one remaining non-superuser path. Note the create surface has **two distinct
code paths inside `createInformalCenter`** (`app/api/edit/unit/route.ts:151-203`), not one:

- `centerType === "institute"` is **already superuser-only** (`route.ts:172`, explicit
  `not_superuser` denial). **Leave this carve-out exactly as-is** — it is not part of the
  change.
- `centerType === "center"` (the default) authorizes on `canManageAccess(session, effective)`
  (`route.ts:192`) — i.e. **Owner-of-parent-dept OR Superuser**. This is the **only** branch
  to narrow.

The change: at `route.ts:192`, replace the `canManageAccess(session, effective)` authz with a
straight `session.isSuperuser` check, emitting `editError(403, "not_superuser")` (with the
matching `logEditDenial({ …, reason: "not_superuser" })`) for a non-superuser — mirroring the
institute branch immediately above it. After this, the `getEffectiveUnitRole` lookup at
`:187-191` is only needed if any non-superuser path remains; since both branches become
superuser-only, the `effective` lookup can be dropped from this function (verify it isn't used
elsewhere in the body before removing). This makes *all* org-unit creation superuser-only (the
feature's explicit requirement).

This is a deliberate behavior change (an Owner loses informal-**center** creation); flag it
for stakeholder confirmation (OQ-8a). It is gated behind the feature flag
`SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY` (default off) so it can ship dark. The create form
`app/edit/unit/new/page.tsx` must update its gate to match: where it currently shows the
center-create option to a parent-dept Owner, gate that option behind `session.isSuperuser`
(same flag), and for a non-superuser show the "Request a new org unit" affordance (§ 4.6)
instead of the form. Confirm the exact form gate against the page during Phase D (OQ-8a).

### 4.6 Request-a-new-org-unit via the existing mailer (Part 3b)

Reuse the #160 chain — **no new mailer**:

- Add to `lib/edit/request-a-change.ts`: a new `RequestAttribute` value `"org-unit"` with one
  `ChangeIssue` `{ id: "request-new-org-unit", label: "Request a new org unit (department,
  division, or center)", action: route({ office: "ITS Support", email: SUPPORT_EMAIL,
  sourceSystem: "Enterprise Directory / Scholars", note: "New org units are created by
  Scholars superusers. Describe the unit (name, type, parent department) and we'll route it."
  }) }`. `SUPPORT_EMAIL` is already `support@med.cornell.edu`.
- The send goes through the existing `POST /api/edit/request-change`: recipient resolved
  **server-side** from the trusted config (client never names an address), per-cwid rate
  limited (`lib/edit/rate-limit.ts`, `SELF_EDIT_REQUEST_CHANGE_RATE_LIMIT`), send-first then
  best-effort audit, `503` when dormant → client `mailto:` fallback
  (`components/edit/request-a-change-dialog.tsx`).
- Surface: a "Request a new org unit" affordance on `/edit/unit/new` for non-superusers (and
  optionally on the Administrators tab). Dormant unless `SELF_EDIT_REQUEST_CHANGE_SEND="on"`
  in the target env (currently OFF in prod — § 7 "mailer rate-limit", OQ-8); when off the
  dialog's `mailto:` fallback still works.

#### 4.6.1 Request-change body for a unit request, and the scholar-centric gate

The existing route (`app/api/edit/request-change/route.ts`) is **scholar-centric**: its body
is `{ attribute, issueId, itemId?, detail?, targetCwid?, noReceipt? }`, it authorizes on
`canAccessScholarEditPage(session, target)` (`route.ts:82`), and the B03 audit row keys on
`targetEntityType: "scholar", targetEntityId: target`. An org-unit-creation request has **no
scholar subject**. Reconciling this (verified against `route.ts:68-85` and
`canAccessScholarEditPage` = `session.cwid === targetCwid || session.isSuperuser`,
`lib/edit/authz.ts:142-147`):

- **`targetCwid` = the requester's own cwid (or omitted).** When omitted, the route defaults
  `target = session.cwid` (`route.ts:71`). Then `canAccessScholarEditPage(session, session.cwid)`
  is `session.cwid === session.cwid` → **true** for *any* authenticated user. So the gate is
  satisfied **without any route change**: a unit request is "about myself" in the trivial
  sense, the `not_self` branch (which only fires when a non-superuser names *another* cwid) is
  never reached, and the gate does **not** widen who can send (it stays as strict as the
  scholar path — see the abuse note below).
- **The requested unit is carried in `detail` (free-text) + `itemId` (a short label).**
  `itemId` = the proposed unit name + type (e.g. `"Division of Foo (division, parent: MED)"`);
  `detail` = the requester's justification / parent department / any codes. Both already flow
  into the **plaintext** mail body (`composeBody` `text:`, `route.ts:124-131`); `itemId`
  appears as the "item" line, `detail` as the note. Neither reaches the subject — the subject
  is server-composed from `attributeLabel` (`subjectFor`, `route.ts:123`), so newline
  injection into the subject is impossible (keep the new `org-unit` `attributeLabel` static).
- **The B03 audit quirk (accepted, not blocking).** The best-effort audit row will key on
  `targetEntityType: "scholar", targetEntityId: <requester cwid>` — semantically odd for a
  unitless request, but it is the requester's own cwid (no information leak), the audit is
  best-effort and never gates the send, and the `attribute: "org-unit"` value in
  `after_values` makes it filterable. **No audit-shape change is required.** If a
  unit-keyed audit is later wanted that is a route change (a target-optional branch), which is
  out of scope here — note it as OQ-13.

**Net:** Part 3b is config-only (`RequestAttribute` + `ChangeIssue` in
`lib/edit/request-a-change.ts`, recipient already `SUPPORT_EMAIL`) **plus** a thin client that
passes `attribute: "org-unit"`, `issueId: "request-new-org-unit"`, omits `targetCwid`, and
puts the unit description in `itemId`/`detail`. **No route-logic change is required** for the
gate, the recipient resolution, the rate limit, or the dormant `mailto:` fallback — all four
already behave correctly for a self-targeted request. (Confirm in OQ-13 whether the
scholar-keyed audit row is acceptable, or a target-optional route branch is wanted.)

---

## 5. Authorization & threat model

The user reviews specs as a security expert. Requirements are MUSTs.

### Trust boundary

- **ED data is upstream-authoritative for *membership in a population*, but the Scholars app
  decides *what that confers*.** The ETL translates group membership into the
  conservative-by-default `curator` grant; it MUST NOT mint `owner` for any population without
  an explicit per-population stakeholder decision (OQ-3). A compromised or misconfigured ED
  group can therefore at worst grant edit/proxy-edit on the named unit, never delegation,
  never site-wide superuser.
- **Authorization is data-derived and re-checked per request, never cached** (`isSuperuser`
  fail-closed; `getEffectiveUnitRole` per POST). The ETL grants rows; it MUST NOT introduce a
  parallel SSO-group-derived unit-role path.

### Privilege-escalation paths (and why each is closed)

1. **Can a DA grant themselves Owner?** No. A `curator` grant fails `canGrant` with
   `authority_violation` for *any* grant (curators delegate nothing). MUST: imported admins
   default to `curator`.
2. **Can a DA widen their org-unit scope (manage a sibling/parent unit)?** No. The
   `UnitAdmin` row names exactly one unit code; `getEffectiveUnitRole` returns `none` for any
   other unit; a dept grant cascades only *down* to its own divisions, never up or sideways.
3. **Can a DA manage a unit they weren't assigned?** No — same mechanism as #2; an action on
   an unassigned unit yields `not_curator`/`scope_violation`.
4. **Can a holder edit/revoke their OWN ED-locked grant via the UI to entrench or escalate?**
   MUST be closed by the new **ED-locked gate** (MUST-7): a non-superuser action against a
   `source LIKE 'ED:%'` row is `403 ed_locked`. Without this gate the existing self-revoke
   guard only covers an *owner* revoking *themselves*, leaving role-edit and curator
   self-mutation open.
5. **Can the ETL clobber a Superuser's hand grant or another population's grant?** No — the
   reconcile `deleteMany` is `source='ED:<P>'`-scoped (§ 3.4). MUST: never delete a
   `source='manual'` or other-population row.
6. **Can an empty/failed LDAP fetch wipe all grants?** No — MUST skip reconcile on an empty
   fetch (§ 3.4 empty-source guard), and a bind failure writes nothing (§ 3.6).

### Effective-CWID seam (#637)

- Every authz verdict MUST read the **effective** identity (`getEffectiveEditSession()` /
  `readEditRequest()` `ctx.session`); audit attribution MUST write the **real** cwid
  (`ctx.realCwid` + `impersonatedCwid`). The Administrators-tab writes inherit this for free
  by going through `/api/edit/grant`. MUST NOT authorize off the real cwid or attribute audit
  to the effective cwid.
- If a future phase adds `EditSession.managedUnits` (the B3 hook), it MUST be resolved for the
  **effective** cwid, or impersonation leaks/strips the wrong scope. Out of scope this
  milestone (§ 1, OQ-9).

### CSRF / origin on the writes

- The Administrators tab adds **no new write endpoint**; it reuses `/api/edit/grant`, which
  runs `readEditRequest()` → `verifyRequestOrigin` (same-origin + `application/json`; a
  cross-site HTML form cannot satisfy both) before any predicate. MUST keep all admin writes
  on this path. The request-change send reuses `/api/edit/request-change` (same preamble).

### Inherited trust boundary on the read APIs the tab calls (acknowledged, not widened)

- **`GET /api/directory/people`** (the name typeahead + roster hydration in § 4.2/§ 4.3) is
  gated only on `getEditSession()` (`app/api/directory/people/route.ts:36`) — i.e. **any
  authenticated SSO user, not superuser** — and exposes ED name/title/dept lookup of arbitrary
  CWIDs. This is a **pre-existing** exposure the Administrators tab *inherits*: the tab **page**
  is superuser-only (`requireSuperuserGet`, § 4.1), but the typeahead API it consumes is
  broadly authenticated. The tab MUST NOT be assumed to gate this API tighter than it already
  is. This is **not a new escalation** (the API predates this feature and is used by other edit
  surfaces) and tightening it is out of scope here; it is **noted** so the trust boundary is
  explicit and a future reviewer doesn't assume the tab's superuser gate extends to its data
  APIs. If directory lookup should be superuser-only, that is a separate change to
  `app/api/directory/people/route.ts` (OQ-14).
- **`GET /api/edit/request-change` reuse must not widen who can send.** The route exempts
  superusers from the rate limit and gates non-superusers on the scholar-self check. The new
  `org-unit` attribute is *self-targeted* (§ 4.6.1), so it stays on exactly the non-superuser
  path the scholar requests use: rate-limited per cwid, server-resolved recipient. MUST NOT add
  a target-optional bypass that would let the `not_self`/rate-limit gate be skipped — that would
  let any authenticated user spam `support@med`. The abuse surface of the new attribute is
  bounded by the *same* limiter as the existing scholar path.

### Enforceable MUSTs

- **MUST-1** Imported admins default to `UnitRole.curator`; `owner` requires explicit
  per-population stakeholder sign-off (OQ-3).
- **MUST-2** ETL writes only the member's resolved assigned unit code(s); a code with no unit
  row is skipped-and-logged, never written.
- **MUST-3** CWIDs lower-cased before any write/compare.
- **MUST-4** Reconcile `deleteMany` scoped to `source='ED:<population>'`; never touches
  `manual` or other-population rows.
- **MUST-5** An empty LDAP fetch for a population skips that population's reconcile (no wipe).
- **MUST-6** LDAP bind/search failure ⇒ `EtlRun status='failed'`, zero writes, zero deletes,
  non-fatal exit.
- **MUST-7** `/api/edit/grant` refuses any `grant`/`revoke` against a `source LIKE 'ED:%'` row
  (new reason `ed_locked`) — for **everyone, superusers included** (amended 2026-06-03; the
  earlier superuser override was a silent-revert footgun). ED-sourced grants are read-only in
  the tab; the role is changed at the source (the Web Directory).
- **MUST-8** All org-unit creation is superuser-only: `createCodedDivision` already is; the
  `centerType==='institute'` branch of `createInformalCenter` already is (`route.ts:172`,
  unchanged); the **only** branch narrowed is the default-`center` branch at `route.ts:192`
  (was `canManageAccess` = Owner-or-Superuser → now `session.isSuperuser`). Non-superusers
  route to the email request. The `app/edit/unit/new/page.tsx` form gate is updated to match.
- **MUST-9** A manual `owner` grant and an ED grant on the same `(unit, cwid)` conflict is
  resolved by **the ETL not downgrading a manual `owner` to `curator`** — if a row exists with
  `source='manual'` and `role='owner'`, the ETL leaves it (logs a reconcile note) rather than
  overwrite a deliberately stronger human grant (confirm OQ-6).

### Explicitly OUT of the threat model

- WCM directory integrity itself (we trust authenticated ED group membership; SAML/IdP
  compromise is out of scope, owned by #100).
- The interim superuser allowlist (`SCHOLARS_SUPERUSER_CWIDS`) trust — owned by #443.
- A superuser acting maliciously within their (by definition total) authority — superuser is
  the root of trust; mitigations are the B03 audit log and `EtlRun` trail, not prevention.
- Center scope (excluded from ED import; manual grants only).

---

## 6. Phased implementation plan (each phase independently shippable behind a flag)

Flag convention (repo): opt-in features use `=== "on"`; default-on use `!== "off"`. New flags
in the `SELF_EDIT_*` family, read lazily inside a helper (never at module load), Node-only
modules kept out of the Edge bundle.

| Phase | Deliverable | Flag | Independently shippable because |
|---|---|---|---|
| **0 — Probe** | `etl/ed-admins/probe.ts` + `npm run etl:ed:admins:probe`. Resolve OQ-1/2/3/5 against the real directory. No schema, no writes. | — | Read-only diagnostic; answers the load-bearing unknowns before any code commits to a mapping. |
| **A — Schema + ETL** | `UnitAdmin.source` migration; `etl/ed-admins/index.ts` + LDAP group-member fetcher in `lib/sources/ldap.ts`; `EtlRun source='ED-Admins'`; reconcile; CDK `EdAdmins` step + `orchestrate.ts`. **Prereq P-A1 (below) MUST pass first.** | ETL is opt-in: a `SELF_EDIT_ED_ADMINS_IMPORT="on"` env (default off) gates whether the job writes; off ⇒ probe/dry-run only. | The job can run (or stay dormant) without any UI; grants become visible on existing per-unit access cards immediately. Safe-dormant under #443 (§ 3.6). |
| **B — Administrators tab (read-only)** | `/edit/administrators` list + scope view; `AdminSubnav` tab. No write controls yet. | `SELF_EDIT_ADMINISTRATORS_TAB="on"` (null-hides the tab). | A pure superuser read surface over `unit_admin`; nothing it shows can be mutated from it yet. |
| **C — Administrators tab (writes) + ED-locked gate** | Add/update-role/revoke wired to `/api/edit/grant`; the `ed_locked` gate (MUST-7) in the grant route; disabled-control UX for ED rows. | same `SELF_EDIT_ADMINISTRATORS_TAB`. | Writes reuse the shipped, audited grant route; the ED-lock gate is additive and defaults safe. |
| **D — Create-org-unit lockdown + request mailer** | Narrow the `createInformalCenter` default-`center` branch (`route.ts:192`) to superuser (institute branch at `:172` already is — § 4.5); update the `app/edit/unit/new/page.tsx` form gate to match; add `org-unit` `RequestAttribute` + `ChangeIssue` + thin self-targeted client (§ 4.6.1). | create-lockdown behind `SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY` (default off so the Owner-create behavior change is opt-in); request send behind existing `SELF_EDIT_REQUEST_CHANGE_SEND`. | The mailer config + endpoint already exist (config-only, **no route-logic change** for the request — § 4.6.1); the lockdown touches exactly one authz branch in the route plus the matching form gate (it does **not** touch the institute carve-out). |
| **E — (follow-on, optional) managedUnits scope** | `EditSession.managedUnits` + `loadEditRoster(unitCodeScope)` wiring so org-unit admins see the scoped Profiles roster and (optionally) an owner-scoped Administrators view. | a later flag. | Touches authz core; explicitly deferred (§ 1 out-of-scope, OQ-9). |

### Phase A prerequisite — P-A1: ETL DB role must hold `unit_admin` INSERT/DELETE (hard gate)

> **✅ RESOLVED 2026-06-03 (code-derived — NO grant change needed).** The ETL writes via
> `db.write` (`lib/db.ts:48`: "Aurora writer endpoint. Mutations, ETL, seed, migrations") =
> the `app_rw` role, whose ADR-009 golden grant is **database-wide**
> `GRANT SELECT, INSERT, UPDATE, DELETE ON `scholars`.*` (`scripts/verify-db-grants.ts`).
> `unit_admin` lives in the `scholars` DB (`@@map("unit_admin")`) and the ED ETL already writes
> `scholars.*` tables (Department/Division), so INSERT/DELETE on `unit_admin` is already covered
> — no per-table grant edit. This is **unlike #493**, which was the SEPARATE `scholars_audit`
> DB needing its own grant. The importer MUST NOT write `scholars_audit` (the ETL role lacks
> that grant), which is exactly why §3.7 defaults to no per-grant ETL audit. The deploy-time
> `db:verify-grants` gate already asserts this golden set. Text below retained for the record.

This is a **prerequisite checklist item, not just an open question.** The ETL writes
`unit_admin` (INSERT via upsert, DELETE via the reconcile sweep). Per the #493 precedent — the
`/edit` audit INSERT failed with "Please try again" in prod because the in-tx INSERT grant was
missing, and ADR-009 hardened the grant discipline — **a missing `unit_admin` INSERT/DELETE
grant on whatever DB role the `scholars-etl-*` image binds as will fail the job at runtime,
after it is already deployed.** Verify in **both staging and prod** (grant parity is the
specific #493/#601 failure mode — prod was fixed before staging) **before Phase A runs the
importer for real:**

```sql
-- Run as the ETL DB role (or: SHOW GRANTS FOR '<etl_user>'@'<host>'\G) in EACH env.
SHOW GRANTS FOR CURRENT_USER();
-- Expect INSERT, DELETE (and SELECT) on `scholars`.`unit_admin`. If absent, an
-- ADR-009-style grant change (least-priv, e.g. via sps_bootstrap) is required first.

-- Direct probe of the privilege rows (information_schema), per-env:
SELECT privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'scholars' AND table_name = 'unit_admin'
ORDER BY privilege_type;          -- want at least INSERT, DELETE, SELECT
```

If per-grant B03 audit is later approved (OQ-8b), the ETL role would *also* need INSERT on the
audit table — but the default decision (§ 3.7) is **no per-grant audit**, so the audit grant is
not on Phase A's critical path. Treat the `unit_admin` grant parity (staging == prod) as an
explicit pre-run sign-off, not an assumption.

Each phase: run `vitest` (not just `tsc`/lint) before push; full `next build` if any
Edge-reachable module changes (LDAP/superuser imports must not leak into middleware).

---

## 7. Edge-case / test table

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | ETL re-run, no ED changes | Upserts rewrite the same `(unit, cwid)` rows in place; row count unchanged; no duplicates (PK). `rowsProcessed` reflects upserts, 0 net new. |
| 2 | Member removed from ED population DA | Their `source='ED:DA'` row swept by the per-population reconcile; their `manual` or `ED:IAMDELA` rows (if any) untouched. |
| 3 | Member in TWO populations (DA + IAMDELA) | Two rows can exist only if scoped to different units; same `(unit, cwid)` collapses to one row whose `source` = the last population written (document order) — both populations' reconcile sets include the key, so it survives until removed from **both**. Confirm desired collapse (OQ-6). |
| 4 | LDAP fetch returns 0 members for a population (outage) | Reconcile for that population SKIPPED + WARN; existing grants preserved (MUST-5). Other populations reconcile normally. |
| 5 | LDAP bind/search fails entirely | `EtlRun status='failed'`, `errorMessage='ldap_unavailable'`; zero writes, zero deletes (MUST-6). |
| 6 | Resolved unit code has no `Department`/`Division` row (renamed/consolidated/typo'd code) | Grant SKIPPED + WARN (`skipped_no_unit`); no dangling row written (§ 3.5). |
| 7 | Org unit later renamed (code stable) | No effect — `UnitAdmin.entityId` is the stable `code`, not the name; grant follows the code. |
| 8 | Org unit deleted (e.g. `Division` cascade) | The `UnitAdmin` row is orphaned (no FK by design); the next ETL run's `skipped_no_unit` does not re-touch it, but it grants access to a nonexistent unit. Audit-SQL Q3 (§ below) flags orphans for cleanup. |
| 9 | Non-superuser tries to revoke/edit an `ED:%` row in the tab | `403 ed_locked`; control is rendered disabled so the click is normally prevented (MUST-7). |
| 10 | Superuser tries to revoke/edit an `ED:%` row | **Also `403 ed_locked`; controls rendered disabled** — ED-sourced grants are read-only for everyone (amended 2026-06-03; the superuser override was removed as a silent-revert footgun). |
| 11 | Imported `curator` tries to grant anyone | `403 authority_violation` from `canGrant` — curators delegate nothing (MUST-1). |
| 12 | Imported admin tries to edit a unit they were not assigned | `403 not_curator` / `scope_violation`; `getEffectiveUnitRole` = `none` for that unit. |
| 13 | Non-superuser attempts org-unit create (Phase D on) | `403 not_superuser`; UI offers the "Request a new org unit" affordance instead (MUST-8). |
| 14 | Request-new-org-unit, mailer dormant (`SELF_EDIT_REQUEST_CHANGE_SEND` off) | `POST /api/edit/request-change` returns `503`; dialog falls back to a composed `mailto:support@med.cornell.edu`. |
| 15 | Request-new-org-unit, same cwid exceeds hourly rate limit | `editRateLimited` (429-class) per `lib/edit/rate-limit.ts`; the existing per-cwid limiter, no new logic. |
| 16 | Manual `owner` exists on a unit the ED job also covers | ETL does not downgrade `manual` `owner` → `curator` (MUST-9); logs a reconcile note. |
| 17 | Mixed-case member DN (`uid=ABC123,…`) | Lower-cased to `abc123` before write (MUST-3); dedupes against any existing lower-cased row. |
| 18 | `getEffectiveCwid` overlay active (#637 "View as") while loading the tab | The superuser gate uses the *effective* session; impersonating a non-superuser strips the tab (consistent with `getEffectiveEditSession`). |

### Runnable audit SQL (MySQL, against the live schema)

```sql
-- Q1: all ED-sourced grants by population (the Administrators-tab data, provenance-filtered)
SELECT source, role, entity_type, COUNT(*) AS grants, COUNT(DISTINCT cwid) AS people
FROM unit_admin
WHERE source LIKE 'ED:%'
GROUP BY source, role, entity_type
ORDER BY source, role;

-- Q2: any ED grant minted as owner (should be empty unless a population was approved for owner)
SELECT entity_type, entity_id, cwid, source
FROM unit_admin
WHERE source LIKE 'ED:%' AND role = 'owner';

-- Q3: orphaned grants — a UnitAdmin row whose unit code no longer exists (edge 8)
SELECT ua.entity_type, ua.entity_id, ua.cwid, ua.source
FROM unit_admin ua
LEFT JOIN department d ON ua.entity_type = 'department' AND ua.entity_id = d.code
LEFT JOIN division  v ON ua.entity_type = 'division'   AND ua.entity_id = v.code
LEFT JOIN center    c ON ua.entity_type = 'center'     AND ua.entity_id = c.code
WHERE COALESCE(d.code, v.code, c.code) IS NULL;

-- Q4: same (unit, cwid) carrying both a manual owner and an ED role (MUST-9 watch)
SELECT entity_type, entity_id, cwid, GROUP_CONCAT(CONCAT(source, '/', role)) AS grants
FROM unit_admin
GROUP BY entity_type, entity_id, cwid
HAVING COUNT(*) > 1;
```

---

## 8. Pre-implementation probe (run FIRST, Phase 0) — ✅ COMPLETE 2026-06-03

**Done — findings recorded in §0.** `etl/ed-admins/probe.ts` was run live against WCM ED and
resolved OQ-1/2/5: tags are option-tagged `weillCornellEduCWID;<tag>` on the
`ou=orgunits,ou=Groups` entries; cn = canonical N-code; `;diva` ≠ `;diva-iamdela`; ldapts can't
subtype-filter; the tree is 6 levels deep vs Scholars' 2-level (dept/division) + centers model.
The original plan is retained below for the record.

Before any importer code, run `etl/ed-admins/probe.ts` (clone of `etl/ed/probe-group.ts`)
against the three group cns from an operator vantage that can reach WCM LDAPS. Capture:

1. Exact group **cn / DN / objectClass** for DAs, IAMDELA, DivA-IAMDELA under
   `ou=Groups,dc=weill,dc=cornell,dc=edu`.
2. Whether membership is the **static `member`** attribute (like the superuser group) or a
   **dynamic `memberURL`** (`groupOfURLs`). The new fetcher enumerates `member`; a memberURL
   group needs `member` resolution or confirmation it carries static members — else the
   fetcher returns nothing.
3. **How each member is tied to a specific org unit**: encoded in the group cn (one group per
   unit, e.g. a per-department DA group), in a per-person attribute
   (`weillCornellEduOrgUnit`/`departmentNumber`), or out-of-band (a curated mapping). This is
   the single load-bearing unknown; the mapping in § 2.3 is provisional until it is answered.
4. Whether the codes the groups/persons carry match the **canonical** `Department.code` the ED
   ETL writes (or need the `deptAlias` consolidation, OQ-5).

LDAP minimal-attribute discipline (memory `feedback_ldap_minimal_attrs`): request only `cn` +
`member` for groups, and only `uid`/`weillCornellEduCWID` + the unit-carrier attribute for
persons. Never `weillCornellEduDOB` or the broad `ED_FACULTY_ATTRIBUTES` list.

---

## 9. Launch dependency

The deployed ETL cannot reach WCM LDAPS until #443 (VPC↔WCM TGW + firewall) lands — the same
gap that forces the `isSuperuser` interim allowlist. The job is designed to **ship dormant and
fail-closed** (§ 3.6): zero harm until routing exists, and runnable manually from an in-reach
vantage in the meantime. Confirm with the network team whether the `EdAdmins` nightly step
should be wired into the Step Function now (dormant-failing) or held until routing lands
(OQ-4).

**The Administrators tab shares the #443 dependency for person *names* only.** The UI phases
(B–D) ship regardless of LDAP reachability — but the tab's person-name column resolves via
`GET /api/directory/people`, which calls `openLdap()`, so in deployed envs the **person column
is bare CWID until #443 lands** (§ 4.2 "#443 dependency on the person column"). The
authorization, scope (org-unit) display, role, provenance, and all *writes* are local-DB and
fully functional without #443. So "the UI phases are independent of LDAP reachability" is true
for *function*, with the single caveat that *person names* are name-less until routing lands —
expected launch state, not a defect (OQ-12).

---

## 10. Open questions (for the user / stakeholders)

**Phase-0 RESOLVED (see §0):** OQ-1, OQ-2, OQ-5 (probe); OQ-3 → all four populations = `curator`;
OQ-9 → superusers **and** unit Owners (subtree-scoped); OQ-11 → #728 filed;
**OQ-10/P-A1** → no grant change needed (`unit_admin` ∈ `scholars.*`, already in the `app_rw`
golden grant — see §6). Import set = `;da` + `;diva` + `;iamdela` + `;diva-iamdela` (exclude
`;dd`); unmapped + deep (L3–6) units skip-and-log. **Still open:** OQ-4 (LDAP routing #443 /
nightly-step wiring), OQ-6 (manual-vs-ED conflict policy), OQ-7 (centers ⇒ confirm centers carry
no admin tag), OQ-8 (flags / ETL audit / mailer-on), OQ-12 (name-less tab under #443), OQ-13
(request audit key), OQ-14 (directory-API gate).

1. **(OQ-1) Group identity.** Exact LDAP cn/DN/objectClass for DAs, IAMDELA, DivA-IAMDELA
   under `ou=Groups`, and whether membership is static `member` or dynamic `memberURL`?
   (Resolved by the Phase-0 probe; needs operator directory access.)
2. **(OQ-2) Unit linkage.** How is each member tied to the specific org unit(s) they
   administer — group cn pattern, a per-person attribute, or a curated map? The whole feature
   stalls until this is known.
3. **(OQ-3) Role per population.** Confirm each of DA / IAMDELA / DivA-IAMDELA maps to
   `curator` (default, recommended) vs `owner`. Owner grants delegation power and a large
   blast radius; do any populations genuinely need it?
4. **(OQ-4) LDAP reachability / where it runs.** Is #443 routing expected before launch?
   Should the nightly `EdAdmins` step be wired now (dormant-failing) or held? Is there an
   approved operator vantage for the interim manual run?
5. **(OQ-5) Code canonicalization.** Do the ED groups/persons carry the **canonical**
   `Department.code`/`Division.code`, or legacy/10-digit codes needing the `deptAlias`
   consolidation `etl/ed/index.ts` applies?
6. **(OQ-6) Manual vs ED conflict policy.** When a person has both a manual grant and an ED
   grant on the same unit, and when a person is in two ED populations on the same unit — is the
   MUST-9 "never downgrade a manual owner; last-population-wins on `source`" behavior correct?
7. **(OQ-7) Centers.** Confirm DAs/IAMDELA never administer **centers** (centers carry no
   LDAP org-unit code), so centers stay manual-grant-only.
8. **(OQ-8) Behavior changes & flags.** (a) Confirm narrowing the informal-**center** create
   branch (`createInformalCenter` default-`center` path, `route.ts:192`) to superuser-only is
   intended — today an Owner of the parent dept can create one; the institute branch at
   `route.ts:172` is already superuser-only and unchanged (§ 4.5). Confirm the exact
   `app/edit/unit/new/page.tsx` form gate change at the same time. (b) Should ETL grants write
   a per-run summary B03 audit row, or is the `EtlRun` + `source` trail sufficient (no per-grant
   audit)? Default is **no per-grant audit** (§ 3.7). (c) Will `SELF_EDIT_REQUEST_CHANGE_SEND`
   be **on** in the target env, or is the `mailto:` fallback acceptable at launch?
9. **(OQ-9) Administrators-tab audience.** Superuser-only at launch (recommended), or also
   visible to unit Owners scoped to their subtree (requires the deferred `managedUnits` /
   `unitCodeScope` B3 wiring)?
10. **(OQ-10 — now a Phase A PREREQUISITE, P-A1, not an open question).** The ETL DB role MUST
    hold `INSERT`/`DELETE` on `unit_admin` in **both staging and prod** (grant parity is the
    #493/#601 failure mode). This is promoted to a hard pre-run checklist with a runnable
    `SHOW GRANTS` / `information_schema.table_privileges` probe (§ 6 "P-A1"). Verify before
    Phase A runs the importer; if absent, an ADR-009-style grant change lands first. (If
    per-grant audit is later approved (OQ-8b), `INSERT` on the audit table is additionally
    needed — not on the default critical path.)
11. **(OQ-11) Issue.** Confirm filing a NEW GitHub issue ("Import WCM ED admin-role
    populations as scoped unit managers + Administrators tab") referencing #540/#160/#637,
    rather than borrowing the branch number — no backing issue exists for
    `feat/ed-admin-org-unit-roles` yet.
12. **(OQ-12) Name-less Administrators tab at launch.** Confirm it is acceptable for the
    Administrators tab to ship with an **all-CWID (no person names) roster** in deployed
    environments until #443 LDAP routing lands (person-name resolution shares the ETL's
    VPC↔WCM gap). Org-unit (scope), role, provenance, and all writes are unaffected — only the
    person *name* column degrades (§ 4.2, § 9).
13. **(OQ-13) Unit-keyed request audit.** The org-unit request reuses the request-change route
    self-targeted, so its best-effort B03 audit row keys on the requester's own cwid as a
    `scholar` (semantically odd but no leak; § 4.6.1). Is that acceptable, or is a
    target-optional route branch wanted so the audit can key on the requested unit instead?
    (The latter is a route-logic change, currently out of scope.)
14. **(OQ-14) Directory-lookup API trust boundary.** `GET /api/directory/people` (consumed by
    the tab's typeahead/hydration) is gated on any authenticated SSO user, not superuser — a
    **pre-existing** broad exposure the tab inherits (§ 5 "Inherited trust boundary"). Should
    directory lookup be tightened to superuser-only, or is the existing authenticated gate
    accepted? (Out of scope to change here; flagged for the record.)
```
