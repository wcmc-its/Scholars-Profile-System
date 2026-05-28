# Unit curation — v1 SPEC

**Status:** Draft
**Date:** 2026-05-17
**Revised:** 2026-05-27 — three-tier Superuser/Owner/Curator access model, Owner-created informal no-code subunits (optional CSID), and provisional-division placement. Ratified in [ADR-005 Amendment 1](./ADR-005-manual-override-layer.md#amendment-1-2026-05-27--org-unit-curation-entity-type-extension-and-three-tier-access-model).
**Authors:** Scholars Profile System development team
**Builds on:** [ADR-005](./ADR-005-manual-override-layer.md) — Manual-override layer (the `field_override` + `suppression` mechanism)
**Coordinates with:** [`self-edit-spec.md`](./self-edit-spec.md) — the scholar-facing feature on the same mechanism; this SPEC's delegated profile-editing reuses its write paths and jointly owns the scholar write path
**Implements:** the org-structure curation feature — supersedes the file/seed manual curation of [ADR-002](./ADR-002-division-chiefs.md) (Path C) and [ADR-003](./ADR-003-center-membership.md), resolves ADR-005's deferred *"Manually-created records"* non-goal, and absorbs (scoped) self-edit-spec's deferred *"broad admin field-editing"*
**Gated by:** B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) (SSO), B02 [#101](https://github.com/wcmc-its/Scholars-Profile-System/issues/101) (authorization predicate + telemetry), B03 [#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102) (append-only audit log — **must land in the generalized `target_entity_type` / `action` row shape**; see [Interfaces](#interfaces-and-dependencies))
**Requires:** [ADR-005 Amendment 1](./ADR-005-manual-override-layer.md#amendment-1-2026-05-27--org-unit-curation-entity-type-extension-and-three-tier-access-model) (Accepted 2026-05-28) — the `EntityType` extension, the `UnitAdmin` (with `role`) and `DivisionMembership` tables, and the **three-tier access model** that is its authoritative source. See also [Architecture decisions](#architecture-decisions-this-spec-makes).
**Implementation:** [#540](https://github.com/wcmc-its/Scholars-Profile-System/issues/540)

---

## Purpose

**Unit curation** lets human-entered data about an organizational unit — a department, division, center, or institute — survive the nightly ETL, and lets a unit's own **administrator** maintain that unit: its page, its roster, and (as a proxy) the profiles of its faculty.

It has three layers, all on ADR-005's manual-override mechanism:

1. **Unit-page curation** — a unit's description, leadership, and slug, as overrides over ETL data or as the data for a unit the ETL never produced. The *"overrides, or for the first times"* the request named — ADR-005's two cases.
2. **A per-unit administrator tier** — a `unit_admin` grant (`role` ∈ {owner, curator}) scopes a non-Superuser editor to a specific unit and its child divisions. This replaces the *"steward"* model of earlier drafts: the editor of a department's page is **not** its Chair — it is an administrator, and the request was explicit (*"Department chair or chief is never the steward — it's usually some admin doing this"*). The two roles (Owner adds access-management; Curator edits only) and their containment are in [Scope and actors](#scope-and-actors) / [ADR-005 Amendment 1](./ADR-005-manual-override-layer.md#a12-three-tier-access-model).
3. **Roster and delegated profile editing** — an Owner or Curator curates the roster of a manually-owned unit and maintains the profiles of its faculty as a proxy for those who will not self-edit.

It is the convergence point of three deferred pieces. [ADR-002](./ADR-002-division-chiefs.md) (division chiefs) and [ADR-003](./ADR-003-center-membership.md) (center membership) each shipped manual curation as **flat files** and closed with a *"Future work: admin UI"* note — this SPEC is that UI. ADR-005 § Non-goals deferred *"Manually-created records … needing an `origin` discriminator"* — this SPEC decides it. And `self-edit-spec.md` § Non-goals deferred *"broad admin field-editing"* — this SPEC absorbs it, **scoped**: an Owner or Curator proxy-edits only what a scholar could self-edit.

It does **not** redesign ADR-005's mechanism, and it does **not** cover the visual/interaction design of the curation pages — that is a `UI-SPEC.md` deliverable (`gsd-ui-phase`).

*Terminology* (revised 2026-05-27 — see [ADR-005 Amendment 1 § A1.2](./ADR-005-manual-override-layer.md#a12-three-tier-access-model) for the authoritative model; earlier drafts of this SPEC called the site-wide tier "curator" and the per-unit editor "unit admin"). **Superuser** — a session whose SSO claims include the `scholars-admins` group (ADR-005's site-wide tier; the root of trust). **Owner** — a person holding a `unit_admin` row with `role='owner'` for a unit: edits the unit + manages access (grants `owner`/`curator`) within the owned subtree + creates informal no-code subunits in their own department. **Curator** — a person holding `role='curator'`: edits the unit + proxy-edits its faculty, with **no** access management. Owner and Curator are both *per-unit, data-derived* and cascade to child divisions; `owner` subsumes `curator`. **Unit** — a `Department`, `Division`, or `Center` row; an *institute* is a `Center` with `centerType='institute'` (no separate model). **Proxy edit** — an Owner or Curator editing a faculty member's profile on their behalf. **ETL-managed** vs **manually-owned** — see [Architecture decisions](#architecture-decisions-this-spec-makes).

---

## Scope and actors

Three tiers ([ADR-005 Amendment 1 § A1.2](./ADR-005-manual-override-layer.md#a12-three-tier-access-model) is authoritative; the threat model and rejected alternatives live there). A **Curator** and an **Owner** are per-unit, data-derived `unit_admin` grants scoped to a unit and its child divisions; a **Superuser** is the site-wide `scholars-admins` tier and the root of trust. Two rules bound every grant: authority ≤ the grantor's own role, and scope ⊆ the grantor's own subtree.

| Capability | Curator (granted unit) | Owner (granted unit) | Superuser (any unit) |
|---|---|---|---|
| Edit the unit's `description` | ✅ | ✅ | ✅ |
| Set / clear the unit's leader (Chair / Chief / Director) + interim flag | ✅ | ✅ | ✅ |
| Curate the roster of a **manually-owned** unit — a center, or a manually-created division | ✅ | ✅ | ✅ |
| Proxy-edit a unit faculty member's `overview`; proxy-hide their misattributed publication | ✅ — **LDAP-primary faculty only** | ✅ — same | ✅ |
| **Grant / revoke** `owner` or `curator` within the owned subtree | ⛔ | ✅ | ✅ — any role, any unit |
| **Create an informal, no-code subunit** under own department + curate its roster | ⛔ | ✅ | ✅ |
| Set / clear the unit `slug`; set `centerType`; create a **coded** (adoptable) division or a department; **retire** a unit | ⛔ — structural | ⛔ — structural | ✅ |

Role is *data-derived* — a `unit_admin` row carrying a `role`, not an SSO group — so it needs no new B02 group plumbing, and is re-checked per POST. A department-level grant cascades to that department's divisions; a division-level grant does not cascade upward. A unit with no grant yet is Superuser-only until a Superuser — or an Owner of a parent department — grants one. Because Owners may grant `owner` (decision A, 2026-05-27), every Owner chain still terminates at a Superuser grant; the containment rules above (and Amendment 1 § A1.3) keep that from widening scope.

**v1 entity scope** is `Department`, `Division`, and `Center`. Unlike Grant / Education / Appointment — blocked behind the ETL stable-key refactor ([#352](https://github.com/wcmc-its/Scholars-Profile-System/issues/352)) — all three unit tables key on a stable `code` primary key that survives every ETL run. Units qualify for the manual layer with **no stable-key prerequisite**.

---

## Architecture decisions this SPEC makes

ADR-005 left the manually-created-records shape to "whoever scopes it." This SPEC decides it. The decisions are additive and should be **ratified back into ADR-005 as an amendment** (same mechanism, same tables) — as `self-edit-spec.md` resolved ADR-005's Open Question #1.

**1. `EntityType` gains `department`, `division`, `center`.** ADR-005 calls appending an enum value *"an online, backwards-compatible `ALTER`."* `suppression` uses all three (whole-unit retire); `field_override` uses `department` and `division`; `unit_admin` uses all three.

**2. The `origin` discriminator already exists — it is the `source` column.** ADR-005 deferred *"an `origin` discriminator so the ETL's `deleteMany` is scoped to `origin='etl'`."* `Department`, `Division`, `Center` **already carry a `source` column**, and the ED ETL's orphan cleanup is **already scoped to it**:

```ts
// etl/ed/index.ts:1312-1316 — verified 2026-05-17
const orphanDepts = await prisma.department.deleteMany({ where: { scholarCount: 0, source: "ED" } });
const orphanDivs  = await prisma.division.deleteMany({   where: { scholarCount: 0, source: "ED" } });
```

A unit written `source='manual'` is already invisible to the orphan sweep; the deferred discriminator is shipped, and this SPEC just *uses* it.

**3. The manual layer follows ETL ownership, not unit type.** The principle ADR-005 implies but never states: *manual data lives outside any table an ETL rewrites, and inside any table it does not.*

- **Departments and divisions are in LDAP's domain.** Even a manually-created division uses a real LDAP N-code and is *adopted* by the ED ETL once a scholar carries it. Department/division *field* curation writes **`field_override`** rows (`description`, `slug`, `leaderCwid`, `leaderInterim`), merged at read time; `etl/ed` consults them before writing those columns.
- **Centers and institutes are in no ETL's domain.** No ETL writes the `center` table. A `Center` row is *manually-owned*: center curation edits the row **in place**.

The **same principle governs rosters** (see [The unit roster](#2--the-unit-roster)): a *manually-owned* unit has a manually-curated roster; an *ETL-managed* unit's roster is LDAP's and is not manually editable. ETL ownership — not unit type, not whether something *feels* curatable — is the single line this SPEC draws everywhere.

**4. Three new tables, one new column.**

- **`UnitAdmin`** — the per-unit grant. `(entityType, entityId, cwid, role, grantedBy, createdAt)` where `role` is a `UnitRole` enum `{owner, curator}`, `@@unique([entityType, entityId, cwid])` (one role per person per unit), indexed on `cwid`. Inserted on grant, **hard-deleted** on revoke; B03 audits both (no soft-revoke column — an access grant is crisply present or absent). Schema in [ADR-005 Amendment 1 § A1.1](./ADR-005-manual-override-layer.md#a11-storage-extensions).
- **`DivisionMembership`** — the manual roster of a manually-created division. `(divisionCode, cwid, source, lastRefreshedAt)`, `@@id([divisionCode, cwid])`. Mirrors `CenterMembership` exactly; no FK to `Scholar` (ADR-003 — an added scholar may not have a row yet). Rows exist **only for `source='manual'` divisions** — the write path enforces it; LDAP-sourced division membership remains `Scholar.divCode` and is not represented here.
- **`leaderInterim Boolean @default(false)` on `Center` only** — the in-row interim/acting qualifier for centers. For departments/divisions `leaderInterim` is a columnless `field_override` field (a column exists only where something writes one; nothing ETL-writes interim).

Unit `suppression` is **whole-unit only** (`contributorCwid` always NULL — a retired department/division/center); there is no "hide one person from a unit" — an ETL-managed unit's roster is not manually editable at all, and a manually-owned unit's roster is a table whose rows are simply added or deleted. Proxy profile editing (layer 3) adds **no new table** — it reuses self-edit-spec's `field_override(scholar, …, 'overview')` and per-author `suppression`.

---

## The v1 curation surface

The central deliverable — four mechanisms.

### 1 — Unit-page fields

For `entityType ∈ {department, division}` the `field_override.fieldName` domain is **exactly four values** (allowlist-validated; any other → `400`). `entityId` is the unit `code`.

| `fieldName` | Overrides | Editable by | Validation |
|---|---|---|---|
| `description` | `Department/Division.description` — the unit's prose blurb. No ETL writes the column; the override is its effective source of truth (column kept as the read-merge fallback). | Curator/Owner of the unit, or Superuser. | **Plain text**, no HTML — the unit pages render `description` as an escaped JSX child (`department-page.tsx:117`, not `dangerouslySetInnerHTML`), so no sanitizer is needed. ≤ 4,000 chars. Empty string clears it. |
| `slug` | `Department/Division.slug` — the URL segment. ETL-written; `etl/ed` consults the override before minting. | **Superuser only** (structural). | `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, no `--`, ≤ 64 chars. A department slug is unique against all `Department.slug`; a **division** slug need only be unique **within its parent department** (`Division.@@unique([deptCode, slug])`). Reject reserved segments (`divisions`, `by-cwid`, `new`). Collision → `400`. |
| `leaderCwid` | `Department.chairCwid` / `Division.chiefCwid` — type-agnostic name; the merge helper maps it and derives the role label (Chair/Chief) from `entityType`. | Curator/Owner of the unit, or Superuser. | A real active `Scholar.cwid` or the empty string (the three states are below). Unknown CWID → `400`. |
| `leaderInterim` | The interim/acting qualifier — renders "Interim Chair" / "Acting Chief". No backing column for dept/div; a synthesized merged property, default `false`. | Curator/Owner of the unit, or Superuser. | `'true'` / `'false'`. Inert without a `leaderCwid`. |

For centers (manually-owned) the same fields are edited **in-row**: `description`, `slug` (**Superuser only** — the `Center.slug` column is updated directly, so the new `/centers/{slug}` URL is live at once), `directorCwid` + `leaderInterim`, `centerType` (**Superuser only**).

**Setting, clearing, and the three leadership states.** `POST /api/edit/field` takes `op: "set"` (default) or `"clear"`; `"clear"` **deletes** the `field_override` row, reverting the field to its ETL/seed value:

| User intent | Call | State |
|---|---|---|
| "Use the auto-detected leader" | `{ op:"clear", fieldName:"leaderCwid" }` | *no row* — defer to ADR-002 detection |
| "This unit is vacant" | `{ op:"set", fieldName:"leaderCwid", value:"" }` | `value=''` — explicit vacancy |
| "The leader is X" | `{ op:"set", fieldName:"leaderCwid", value:"<cwid>" }` | `value=<cwid>` — explicit override |

The three-state model is dept/div-specific (ADR-002 *auto-detects* chairs/chiefs); a center's `directorCwid` has no detection, so two states — set or vacant. `op` is optional and additive (absent → `"set"`), so it does not alter self-edit-spec's `/api/edit/field` contract — see [Interfaces](#interfaces-and-dependencies).

### 2 — The unit roster

Roster curation follows the **same ETL-ownership principle as field curation** (decision 3): a *manually-owned* unit has a manually-curated roster; an *ETL-managed* unit's roster is LDAP's and is not manually editable. The clarification that prompted this — *"add or subtract people from divisions should only be for manually-created divisions"* — is that principle applied to membership.

- **A department, or an LDAP-sourced division (`source='ED'`), has no manual roster.** Its faculty are exactly the scholars LDAP places in it via `Scholar.deptCode` / `divCode`. No Curator, Owner, or Superuser adds, removes, or hides a member; a wrong appointment routes to ED. (Departments are always ETL-managed — v1 does not create them — so they fall entirely on this side.)
- **A center or institute** has a `CenterMembership` roster — a Curator/Owner of the unit (or a Superuser) adds/removes members. A center is manually-owned (no ETL writes the `center` table), so its roster *is* the manual table. Supersedes `data/center-members/*.txt`.
- **A manually-created division (`source='manual'`)** has a `DivisionMembership` roster — a Curator/Owner of the unit (or a Superuser) adds/removes members. This is how a pre-registered division is populated *before* LDAP adoption — it has no LDAP faculty yet. After adoption the page unions the `DivisionMembership` roster with the LDAP faculty that have attached, deduplicated; the division stays `source='manual'`, so the manual roster remains editable.

`CenterMembership` and `DivisionMembership` share a shape — `(unitCode, cwid, source, lastRefreshedAt)`, no FK to `Scholar` (ADR-003 — an added scholar may not have a row yet); UI-added rows carry `source='manual-ui'`. They are the manual-roster tables for the two manually-owned unit families. A roster operation targeting a department or an LDAP-sourced division is rejected `400` — there is no manual roster to write.

### 3 — Delegated profile editing (proxy)

An Owner or Curator maintains the profiles of their unit's faculty — the reality the request named, and the realistic complement to self-edit (most faculty will not self-edit).

This introduces **no new mechanism.** Proxy editing reuses `self-edit-spec.md`'s exact write paths — `field_override(scholar, cwid, 'overview')` for the bio, and the per-author `suppression(publication, pmid, contributorCwid)` for hiding a misattributed publication — and self-edit-spec's `/edit/scholar/[cwid]` route. What this SPEC adds is **one new authorized actor**.

- **Field set = self-edit scope.** An Owner or Curator edits, for a faculty member, exactly what that member could edit for themselves: `overview`, and the hiding of their own misattributed publications. **Upstream-authoritative scalars** (`primaryTitle`, `primaryDepartment`, `email`, …) are **not** proxy-editable — self-edit-spec's reasoning (a `field_override` masks the system of record) is actor-independent; corrections route to ED/SOR.
- **Scope = LDAP-primary faculty only.** An Owner or Curator may proxy-edit scholar S iff S's *LDAP-primary* `deptCode`/`divCode` falls within their grant. **Roster membership does not count** — being listed in a center's or a manual division's roster (mechanism 2) never confers profile-edit rights, or an editor could add any scholar to a roster and capture them (Amendment 1 § A1.3 T3). Proxy editing is scoped to a scholar's *home* LDAP unit, full stop; a roster is a listing, not authority over its members.
- **Provenance.** A proxy edit writes the same `field_override` row a self-edit would, with `actorCwid` = the admin (not the scholar) — so `actorCwid <> entityId` is the durable marker of a proxy edit; B03 records the full actor/target.

**Coordination:** self-edit-spec owns the field set, validation, sanitization, and the `/edit/scholar/[cwid]` route; this SPEC owns the unit-admin actor and its scoping. self-edit-spec's authorization table must widen its `overview`-edit and per-author publication-hide rows to admit this actor — the two SPECs jointly own the scholar write path. See [Interfaces](#interfaces-and-dependencies).

### 4 — Unit lifecycle and grants

- **Create** a subunit — an **informal no-code subunit** by an Owner of the parent department (or a Superuser), or a **coded, adoptable division** by a Superuser. See [Manual unit creation](#manual-unit-creation).
- **Retire** a unit — a whole-unit `suppression` row (`contributorCwid` NULL). **Superuser only** (structural). The page `404`s (via `lib/url-resolver.ts`), the facet drops on the next nightly rebuild; soft and revocable; members and `scholarCount` untouched. A retired unit is not a retraction/FERPA case — the nightly rebuild plus `revalidatePath` suffices (no fast-path search write).
- **Grant / revoke** a `unit_admin` — an **Owner** assigns `owner` or `curator` to a person within their owned subtree, or a **Superuser** does so for any unit. Authority is bounded (≤ own role, ⊆ own subtree); see [Authorization](#authorization) and Amendment 1 § A1.2. Owner→owner is permitted, so there *is* controlled propagation, but every chain roots at a Superuser and cannot widen scope.

---

## Manual unit creation

Resolves ADR-005's deferred "Manually-created records" non-goal. v1 creates **subunits** of a department; a new *department* is out of scope (LDAP-canonical, routing-central). The organizational code — the LDAP **N-code**, the "CSID" — is **optional** on the create form (decision, 2026-05-27), and whether it is supplied determines the kind of subunit and who may create it.

**Informal, no-code subunit (Owner or Superuser).** With no code, the system mints a synthetic `code` and creates a `source='manual'` unit with a fully manual roster — the center/institute mechanism, parented to the creating Owner's department. No ETL ever touches it (no orphan sweep, no adoption), so it persists until explicitly retired; members are hand-picked through its `*Membership` roster (mechanism 2). This is the **Owner-creatable** path: an Owner stands up a working group, program, or not-yet-coded grouping within their own department and adds people directly. This **retires `prisma/seed-centers.ts`** — the 8 seeded centers become manually-owned rows.

**Coded, adoptable division (Superuser only).** With the **real LDAP N-code** supplied, the unit is a *pre-registered division*: a `Division` row, `source='manual'`, the N-code as its `code`. A division's LDAP-primary membership derives entirely from `Scholar.divCode`, so the code must be real — when the ED ETL later sees a scholar carrying it, the scholar auto-attaches and the row is *adopted* into ETL management (ADR-002's documented Colorectal Surgery / Biostatistics gap). Adoption is seamless because division *field* curation writes `field_override` from creation. Before adoption it is **not a dead skeleton** — it is populated through its `DivisionMembership` roster, and it **renders exactly like any other division** (see [Placement of manually-created divisions](#placement-of-manually-created-divisions)). Because a wrong code is permanently unadoptable and the division joins the routing-relevant canonical namespace, this path is **Superuser-only**; the [typo failure mode](#non-goals) and audit query C are its guard. (An Owner who needs a *real* coded division routes the N-code through a Superuser — the only friction the model imposes on Owners, and a deliberate one.)

A `source='manual'` unit is untouched by the ETL by construction: the dept/div `upsert` loop iterates only LDAP-emitted codes; the orphan sweep is `source='ED'`-scoped; centers are not in the nightly orchestrator at all.

---

## Placement of manually-created divisions

A coded, pre-registered division (the case the request named: *"capture divisions that don't exist in a source system"*) **renders identically to any LDAP-managed division — no badge, no "new" or "provisional" marker, no second-class styling** (decision, 2026-05-27). It is one because it is meant to become one; the SOR simply has not caught up. It appears in the three canonical places from the moment it is created:

1. **In its parent department page's divisions list** — listed as an ordinary division.
2. **At its own `/divisions/{slug}` page**, populated from its `DivisionMembership` roster.
3. **In browse and search facets** — and this works *before* LDAP adoption because `etl/search-index` keys the division facet off the `DivisionMembership` roster, **not** `Scholar.divCode` (see [Implementation](#implementation)). So a manually-added member carries the division facet on their search document, and the division is filterable in search from day one.

**A sparse roster is the steady state, not a defect.** This feature is primarily for *small* departments and *small* divisions, where a handful of faculty is normal — so a three-person manual division reads exactly like any other small division, and there is **no deliberate empty-state, no "recently added" treatment, and no `is this manual?` conditional anywhere in the public UI**. (This resolves [Open question #2](#open-questions).)

**Placement is stable across the adoption boundary.** When LDAP finally carries the N-code, the division page *unions* the manual `DivisionMembership` roster with the now-attached LDAP faculty, deduplicated (edge case 15); the manual roster stays editable because `source` is still `manual`. Nothing about the division's location, URL, or appearance changes — only the roster grows. There is no "promote to real division" step.

The only governance surface is **back-office and Superuser-only**: audit query C (the unadopted-manual-division watch) catches a fat-fingered N-code that never adopts. Because a wrong code degrades to a harmless standalone manual group (it never corrupts the canonical tree — adoption is a `Scholar.divCode` match, not a write into LDAP), this is the *entire* governance need for this case; it requires none of the expiry/visual-quarantine machinery a never-canonical "group" type would.

---

## Surfaces

Two route trees, extending `self-edit-spec.md`'s `/edit/*` and `/api/edit/*` families — both already `CachingDisabled` at CloudFront (`cloudfront-cache-spec.md` rows 1–2; no new CDN config). Visual design is a `UI-SPEC.md` deliverable.

### `/edit/*` — pages (SSO-gated, uncached, GET)

| Route | Actor | Contents |
|---|---|---|
| `/edit/department/[code]`, `/edit/division/[code]`, `/edit/center/[code]` | Curator or Owner of the unit; Superuser | Edit `description`, leadership. **A roster section appears only for a center or a manually-created division** (decision: manually-owned units only). **Owner-managed section:** the access list (grant/revoke `owner`/`curator` in-subtree). **Superuser-only sections:** `slug` / `centerType`, retire. |
| `/edit/unit/new` | Owner (informal no-code subunit in own department) or Superuser (also coded, adoptable divisions) | Create a subunit — CSID optional; see [Manual unit creation](#manual-unit-creation). |
| `/edit/scholar/[cwid]` | Superuser, or an Owner/Curator of the scholar's LDAP-primary unit | self-edit-spec's route, **reused** for proxy editing — not a new route here. self-edit-spec gates it; this SPEC widens the actor set. |

All `/edit/*` pages read the target with the suppression filter off (ADR-005 § "One read-path exception"). No valid session → SSO login (B01).

### `/api/edit/*` — write endpoints (SSO-gated, uncached, POST-only)

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/edit/field` *(shared, widened)* | `{ op?: "set"\|"clear", entityType, entityId, fieldName, value? }` | Upsert/delete one `field_override` row — dept/div unit fields, or scholar `overview` (proxy). |
| `POST /api/edit/unit` *(new)* | create: `{ op:"create", unitType, name, slug, deptCode?, code?, centerType? }`; center edit: `{ op:"update", entityType:"center", entityId, fieldName, value }` | Create a manual division/center; or update a `Center` row in place. |
| `POST /api/edit/roster` *(new)* | `{ unitType: "center"\|"division", unitCode, cwid, action: "add"\|"remove" }` | Center → `CenterMembership`; manually-created division → `DivisionMembership`. A department or an LDAP-sourced (`source='ED'`) division → `400`. Refreshes the affected count. |
| `POST /api/edit/suppress` *(shared, widened)* | `{ entityType, entityId, contributorCwid?, reason }` | Retire a unit (unit `entityType`, `contributorCwid` always null); or hide a publication (proxy — `entityType='publication'`, `contributorCwid` set, ADR-005's original per-author semantics). |
| `POST /api/edit/revoke` *(shared)* | `{ suppressionId }` | Soft-revoke one `suppression` row. |
| `POST /api/edit/grant` *(new)* | `{ entityType, entityId, cwid, role: "owner"\|"curator", action: "grant"\|"revoke" }` | Insert / hard-delete one `unit_admin` row (carrying `role`). **Owner of the target unit's subtree, or Superuser.** `cwid` is resolved from a directory name search (the operator never types it); the grantee need not be a Scholar. |

All return `200` / `400` / `401` (empty body) / `403` / `5xx`. Same `Content-Type: application/json` + same-origin defense as self-edit-spec.

---

## Authorization

The feature consumes B01's session and B02's predicate machinery, and implements the three-tier model of [ADR-005 Amendment 1 § A1.2](./ADR-005-manual-override-layer.md#a12-three-tier-access-model) (the authoritative predicate and threat model). **Session:** `{ cwid, isSuperuser }`, `isSuperuser` re-checked per POST (B02). A **Superuser** is `isSuperuser`. **Owner** and **Curator** are data-derived from `unit_admin` rows carrying a `role`:

> `ownerOf(U)` — a `unit_admin(role='owner')` row exists for `(U)`, **or**, if U is a division, for U's parent department `(department, U.deptCode)`. `curatorOf(U)` = `ownerOf(U)` **or** a `role='curator'` row under the same cascade.

A department-level grant **cascades to that department's divisions**; a division-level grant covers only that division (no upward cascade).

| Action | Allowed iff |
|---|---|
| `field` — `fieldName ∈ {description, leaderCwid, leaderInterim}`; `roster` add/remove | `curatorOf(target)` **or** Superuser. (A department or `source='ED'` division roster → `400`: no manual roster, not an authz failure.) |
| `grant` / revoke of `owner` or `curator` | `ownerOf(target unit)` **and** the grant's `role` ∈ {owner, curator} **and** the target unit is within the grantor's owned subtree — **or** Superuser (any role, any unit). |
| `unit` `op:"create"` — informal no-code subunit under department D | `ownerOf(D)` **or** Superuser. |
| `field` — `fieldName='slug'`; `unit` `centerType`; coded/adoptable division or department creation; `suppress`/`revoke` of a unit (retire) | **Superuser only** (structural). |
| `field` — `entityType='scholar'`, `fieldName='overview'` (proxy) | Superuser, **or** `curatorOf` the scholar's **LDAP-primary** `deptCode`/`divCode`. (Self-edit by the scholar is self-edit-spec's row.) |
| `suppress` — `entityType='publication'`, per-author (proxy hide) | Superuser, **or** `curatorOf` the contributor's LDAP-primary unit, **or** the contributor themselves (self-edit-spec). |

The predicate keys on `fieldName`, `entityType`, and `role` — never on `op` or the HTTP verb; clearing is gated identically to setting, and revoking identically to granting. The proxy-scope predicate reads the scholar's `deptCode`/`divCode` **columns** (the LDAP values — never `field_override`-able, never roster-derived), so a roster membership never widens edit authority (Amendment 1 § A1.3 T3). An unrecognized `fieldName`, an `entityType` of `grant`/`education`/`appointment`, an out-of-subtree grant target, or a unit `entityId` resolving to no row (and not a `create`) → `400`/`403`. Every `403` emits `event: "edit_authz_denied"` with `{ actor_cwid, target_entity_type, target_entity_id, role, path, reason }` (B02).

Three consequences are deliberate: an Owner or Superuser who **revokes** a grant cuts that access on the next POST (re-checked per request), and revoke **hard-deletes one row only** — grants the revoked person previously made stay valid, `grantedBy` being a historical breadcrumb, not a live dependency (Amendment 1 § A1.3 T5); peer-Owner revoke is symmetric, with the Superuser as the always-available backstop (T4/T7, no last-owner guard); and a unit's leader being *auto-detected* never confers edit rights — the editor is the grantee, fully decoupled from leadership.

---

## Write-path behavior

Every `/api/edit/*` action is **one MySQL transaction** (ADR-005 § Write-path failure model): validate → write the manual-layer row(s) / unit row → insert one B03 audit row → on any failure, roll back. Post-commit reflection is best-effort.

**The `etl/ed` precedence consult.** For a department/division, before `etl/ed` writes `slug` and the leader column it reads `field_override` for that `code`: a `slug` override wins and is never re-derived; a `leaderCwid`/`leaderInterim` override (including `leaderCwid=''`) wins over ADR-002 auto-detection. This **supersedes ADR-002 Path C** (`data/division-chiefs.txt`); Paths A/B (the chair regex, manager-graph) remain the fallback when no override row exists.

**Post-commit reflection.**

| Action | Page revalidation | Search |
|---|---|---|
| `description` / leadership / roster edit | `revalidatePath` the unit page (and, for a proxy `overview` edit, the scholar's `/scholars/{slug}`). | Nightly rebuild. |
| `slug` (dept/div) | None — the URL flips on the next `etl/ed` run; the trade-off self-edit-spec accepts for scholar slugs (its edge case 12). | Nightly. |
| `slug` (center) | `revalidatePath` old + new `/centers/{slug}` — the column is updated immediately. | Nightly. |
| Create / retire a unit; grant/revoke `unit_admin` | `revalidatePath` the unit page, `/browse`, and (division) the parent department. | Nightly drops/restores the facet. |

**The simplification vs. self-edit-spec.** ADR-005's three-layer search urgency (fast-path + reconciler) exists for retraction/FERPA suppression. Unit curation has no such case — units appear in the index only as *facet keys* on scholar documents — so it uses the **nightly rebuild as its only search path**: no fast-path write, no reconciler, no CloudFront invalidation. A proxy `overview` edit likewise rides the nightly cycle (a corrected bio tolerates the lag — ADR-005).

---

## Edge-case test table

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | Curator edits an ETL department's `description`; `etl/ed` runs | Override survives — `field_override` untouched by the ETL; the read-merge re-applies it. |
| 2 | A Superuser sets a division `slug` override; `etl/ed` re-derives the slug | Override wins — `etl/ed` consults `field_override(slug)`; URL changes only on that run. (`slug` is structural — Superuser only.) |
| 3 | A Superuser creates a coded division (real N-code, `source='manual'`); `etl/ed` runs, no scholar yet carrying the code | Row survives — the `upsert` loop never sees the code; the orphan sweep is `source='ED'`-scoped. (Coded division = Superuser only.) |
| 4 | A scholar later appears in LDAP carrying that N-code | `etl/ed` adopts the row: `scholarCount` rises, the scholar attaches; curated `slug`/leadership hold (already `field_override`); `name` yields to LDAP. |
| 5 | An Owner (or Superuser) creates a new center; `etl/ed` runs | Untouched — nothing in the nightly orchestrator writes the `center` table. (A no-code center/group is Owner-creatable in their own department.) |
| 6 | Curator sets a division Chief override; ADR-002 detection would pick someone else | Override wins; supersedes ADR-002 Path C. `op:"clear"` removes the row and re-enables detection — the third state. |
| 7 | A Superuser (or an Owner of X) grants `unit_admin(department, X, A, role=curator)`; A edits department X's `description` | Allowed — A holds a Curator grant on X. |
| 8 | A (admin of department X) edits a **division under X** | Allowed — a department-level grant cascades to its divisions. |
| 9 | A (admin of **division** D) edits D's parent department | `403` — division grants do not cascade upward. |
| 10 | A (admin of X) tries to edit department Y | `403` `edit_authz_denied` `{reason:"not_unit_admin"}`. No write, no audit row. |
| 11 | An Owner or Superuser revokes A's grant; A then POSTs an edit for X | `403` — the `unit_admin` row is re-checked per POST; access is gone. The revoke hard-deleted only A's row; grants A previously made are untouched (Amendment 1 § A1.3 T5). |
| 12 | A (admin of a center) adds a scholar to that center | `CenterMembership` row inserted; the scholar appears on the center page; `scholarCount` refreshed. |
| 13 | A (admin of a manually-created division) adds a scholar to it | `DivisionMembership` row inserted; the scholar appears on the division page even before LDAP adoption. |
| 14 | A roster `add` targets a department, or an LDAP-sourced (`source='ED'`) division | `400` — an ETL-managed unit has no manual roster; its faculty are LDAP's. |
| 15 | A manually-created division with a `DivisionMembership` roster is LDAP-adopted | The page unions the manual roster with the now-attached LDAP faculty, deduplicated; the manual roster stays editable (`source` is still `manual`). |
| 16 | B (admin of S's LDAP-primary department) proxy-edits S's `overview` | Allowed — `field_override(scholar, S, 'overview')`, `actorCwid = B`. |
| 17 | A adds S (LDAP-primary unit = Y) to A's center roster, then tries to proxy-edit S's profile | `403` — proxy scope is the LDAP-primary unit; roster membership never confers profile-edit rights. |
| 18 | An Owner or Curator tries to proxy-edit a faculty member's `primaryTitle` | `400` — upstream-authoritative; not in the proxy field set. Corrections route to ED. |
| 19 | A `roster` add for a CWID with no `Scholar` row yet (incoming hire) | Stored — neither membership table has a `Scholar` FK; it attaches when the row lands. |
| 20 | A Superuser retires department X (whole-unit suppression) | `suppression(department, X)`; the page `404`s; member scholars unaffected; the facet drops on the next rebuild. Revocable. (Retire = structural, Superuser only.) |
| 21 | A faculty member self-edits their `overview`, then an Owner/Curator of their unit also edits it | One `field_override(scholar, cwid, 'overview')` row, upserted in place; **two** B03 rows (`actorCwid` differs). Last write wins. |
| 22 | A Superuser sets a division `slug` equal to a sibling division's slug under the same department | `400` (`@@unique([deptCode, slug])`); the same slug under a *different* department is accepted. |
| 23 | A **Curator** tries to grant `unit_admin` | `403` — Curators cannot manage access. (An **Owner** granting `owner`/`curator` within their subtree is allowed; an Owner granting outside their subtree, or any structural power, → `403` — Amendment 1 § A1.2.) |
| 24 | A Superuser mistypes a coded division's N-code at creation; LDAP never adopts it | The division renders with only its manual roster; audit query C flags it (stale, never adopted). No in-place fix — recovery is delete-and-recreate; see [Non-goals](#non-goals). |
| 25 | The B03 audit insert fails inside a write transaction | The whole transaction rolls back — no manual-layer / membership / `unit_admin` row; `5xx`; nothing half-applied. |
| 26 | `prisma/seed-center-members.ts` is re-run after UI roster edits | Would clear+repopulate and delete UI-added rows — the loader must be retired or scoped to `source='file'` before launch; see [Interfaces](#interfaces-and-dependencies). |

---

## Audit queries

Runnable against the v1 schema. Operational; ADR-005 / self-edit-spec queries are not duplicated.

```sql
-- A) Pending dept/div slug overrides not yet consumed by etl/ed (URL not flipped).
SELECT fo.entity_type, fo.entity_id AS code, fo.value AS override_slug, fo.updated_at
FROM field_override fo
LEFT JOIN department d ON fo.entity_type = 'department' AND d.code = fo.entity_id
LEFT JOIN division   v ON fo.entity_type = 'division'   AND v.code = fo.entity_id
WHERE fo.field_name = 'slug' AND fo.value <> COALESCE(d.slug, v.slug);

-- B) The unit-admin access map — every grant, by unit.
SELECT ua.entity_type, ua.entity_id AS code, ua.cwid AS admin_cwid,
       ua.granted_by, ua.created_at
FROM unit_admin ua
ORDER BY ua.entity_type, ua.entity_id, ua.created_at;

-- C) Manually-created units — the unadopted-division watch (a manual division
--    long stale with only a manual roster may carry a mistyped N-code — edge case 24).
SELECT 'division' AS unit, code, name, scholar_count, created_at FROM division WHERE source = 'manual'
UNION ALL
SELECT 'center'   AS unit, code, name, scholar_count, created_at FROM center   WHERE source = 'manual'
ORDER BY scholar_count ASC, created_at;

-- D) Proxy-edited scholar profiles — overviews written by an Owner/Curator, not
--    the scholar (actor_cwid <> entity_id). The delegated-editing activity log.
SELECT fo.entity_id AS scholar_cwid, fo.actor_cwid AS admin_cwid,
       CHAR_LENGTH(fo.value) AS len, fo.updated_at
FROM field_override fo
WHERE fo.entity_type = 'scholar' AND fo.field_name = 'overview'
  AND fo.actor_cwid <> fo.entity_id
ORDER BY fo.updated_at DESC;

-- E) Manual rosters — members added through the UI to a manually-owned unit
--    (a center, or a manually-created division).
SELECT 'center' AS unit_kind, center_code AS code, cwid, source, last_refreshed_at
FROM center_membership
UNION ALL
SELECT 'division' AS unit_kind, division_code AS code, cwid, source, last_refreshed_at
FROM division_membership
ORDER BY unit_kind, code;

-- F) Currently-retired (suppressed) units.
SELECT s.entity_type, s.entity_id AS code, s.reason, s.created_by, s.created_at
FROM suppression s
WHERE s.entity_type IN ('department','division','center') AND s.revoked_at IS NULL
ORDER BY s.created_at DESC;
```

Departments and divisions curate via `field_override`, so queries A–D read it directly. **Centers curate in-row** and write no `field_override`; their per-edit curation history exists only in the B03 audit log — one more reason B03's row-shape generalization is a hard prerequisite.

---

## Interfaces and dependencies

- **B01 / B02 — SSO and the authorization predicate.** The validated session and per-POST `isSuperuser` re-check + `edit_authz_denied` telemetry that self-edit-spec consumes. The Owner/Curator predicate is a DB lookup (`unit_admin` row + `role` + the division→department cascade + the scope/authority containment of Amendment 1 § A1.2) — **no new B02 group**.
- **B03 #102 — the audit log, in its *generalized* shape.** Gated not on B03 *shipping* but on B03 shipping **with** the `target_entity_type` / `target_entity_id` / `action` generalization — the *same* generalization self-edit-spec requested (its Open Question #3); it is a request to #102, not yet an agreed property of it. This SPEC's actions add `unit_create`, `roster_change`, and `grant_change`, several of which carry **no prior state** (`before` is null) — the generalized row must accept that. Coordinate the two SPECs' need through that one open question.
- **`self-edit-spec.md` — jointly owned scholar write path.** Delegated profile editing (layer 3) reuses self-edit-spec's `field_override(scholar, …, 'overview')`, its per-author `suppression`, and its `/edit/scholar/[cwid]` route — **no new mechanism.** self-edit-spec's authorization table must **widen** two rows — `overview` edit, and per-author publication hide — to admit an *Owner or Curator of the target's LDAP-primary unit* as a third actor. self-edit-spec owns the field set, validation, and route; this SPEC owns the Owner/Curator actor and its scoping. The two SPECs must also share the `/api/edit/field` `op: "set"|"clear"` extension (additive, default `"set"`, backward-compatible).
- **ADR-005** — the `field_override` / `suppression` tables and read-merge helpers. This SPEC **amends** ADR-005: `EntityType` += `{department, division, center}`; the keying table gains three ETL-stable rows; ADR-005's *"Manually-created records"* non-goal is closed. The new `UnitAdmin` / `DivisionMembership` tables are a purely additive migration.
- **`etl/ed`** — gains the slug + leadership `field_override` precedence consult for departments/divisions. ADR-002 Path A/B detection is unchanged; **Path C (`data/division-chiefs.txt`) is retired**.
- **Retiring the file/seed curation — order is load-bearing.** `prisma/seed-centers.ts` is retired (the 8 center rows become manually-owned); `prisma/seed-center-members.ts`'s clear+repopulate would delete UI-added memberships (edge case 26) — it must be retired or scoped to `source='file'`; `data/division-chiefs.txt` / `data/center-members/*.txt` are superseded. A one-shot backfill imports their content into the manual layer. **The backfill script and the loader/seed deletions must ship in the same PR and run in the same deploy** — the backfill executes and is verified by an audit query *before* the loader code paths are removed.
- **Dev / CI environments.** With `seed-centers.ts` retired, a fresh clone or CI run has no centers; the backfill script doubles as the dev/CI fixture loader (or a minimal `prisma/fixtures/` seed is kept). Production gets the data from the backfill; staging from the B13 (#112) prod snapshot.
- **A directory people-search endpoint *(new)*.** The grant UI resolves a grantee by **name**, not a typed CWID, so an internal endpoint takes a name fragment and returns `[{ cwid, displayName, title, dept }]` from the **WCM enterprise directory (LDAP/ED), not the scholars corpus** (Owners/Curators are frequently administrative staff with no Scholar profile), requesting **minimal attributes only** (no DOB/other PII). This is the one genuinely new interface the access model adds — earlier flows all keyed on a known CWID. The grantee need not be a Scholar; the "must be an active scholar" phrasing of earlier drafts is corrected (the proxy-edit *target* must still be a faculty Scholar). See Amendment 1 § A1.5.
- **Operational — seeding `unit_admin`.** There is no upstream source for "who administers a unit." Initial **Owner** grants are Superuser-created through the grant UI; an Owner then grants within their subtree. An institution-supplied roster can seed them, but no ETL backfill is possible.
- **`#352`** — *not* a dependency: units are ETL-stable by `code`. Noted only to contrast with Grant/Education/Appointment.

---

## Non-goals

- **Manually editing the roster of an ETL-managed unit** — a department or an LDAP-sourced division. Their faculty are LDAP's (`Scholar.deptCode`/`divCode`); only manually-owned units (centers, manually-created divisions) have a curated roster. There is no "hide an LDAP-primary member from a unit roster" — a wrong appointment routes to ED.
- **Overriding a scholar's primary department/division.** `Scholar.deptCode`/`divCode` is LDAP-authoritative; a manual roster (mechanism 2) is a separate listing and never changes it.
- **Proxy-editing upstream-authoritative scalar fields** — `primaryTitle`, `primaryDepartment`, `email`, `orcid`, etc. Proxy editing is self-edit scope (`overview` + the scholar's own publication hiding); a `field_override` on an upstream scalar would mask the system of record. A flagged fast-follow if SOR-correction latency proves unacceptable.
- **Correcting a mistyped division N-code in place.** A division's `code` is its primary key and the FK target for `Scholar.divCode`; v1 cannot rename it. Recovery is delete-and-recreate the `Division` row, its `field_override` rows, and its `DivisionMembership` rows. The clean fix — a transactional Superuser "change unit code" action — is a flagged fast-follow. (`Center.code` is likewise immutable, but with no adoption story retire-and-recreate is clean.)
- **Unbounded privilege propagation.** Owners *may* grant `owner`/`curator` (controlled propagation), but only ≤ their own role and ⊆ their own subtree, never a structural power, and every chain roots at a Superuser (Amendment 1 § A1.2–A1.3). Curators grant nothing. Full unscoped delegation is rejected.
- **Co-leadership.** One leader per unit (the single `chairCwid`/`chiefCwid`/`directorCwid` column) plus interim/vacancy. Co-Directors need a leadership join table — deferred.
- **Creating a new department; re-parenting, merging, or splitting units.** Departments are LDAP-canonical; a division's `deptCode` is set at creation or by LDAP; merges/splits are an org-reconciliation exercise.
- **Rich-text descriptions; acronyms, websites, contact info, themes, logos.** v1 `description` is plain text; the rest is out of the lean field set or (logos) binary, which ADR-005 scopes out.
- **A suppression / override / grant admin console.** v1 acts per-unit from the `/edit/*` pages; a browse-all console is a follow-up.

---

## Open questions

1. **The synthetic-code convention for manual centers.** Recommend the ADR-003 slug-like form with a uniqueness check against existing center codes. Manual *divisions* must use the real LDAP N-code (structural).
2. **An unadopted manually-created division.** **Resolved (2026-05-27):** it renders **identically to any other division** — no deliberate empty-state, no "provisional"/"recently added" marker, no `is this manual?` conditional in the public UI. A sparse roster is the steady state, because the feature targets *small* departments and divisions. See [Placement of manually-created divisions](#placement-of-manually-created-divisions).
3. **Retiring the file/seed curation.** Recommend the same-PR backfill-then-delete sequence ([Interfaces](#interfaces-and-dependencies)). Confirm timing relative to B01–B03.
4. **ADR amendment vs. new ADR.** Recommend **amending ADR-005** — the enum extension, the `source` discriminator, and the new tables are the same mechanism — not a new ADR-006.
5. **B03 row shape.** Gated on #102 adopting the `target_entity_type` / `action` generalization — the identical dependency as self-edit-spec's Open Question #3. Resolve the two together.

---

## Implementation

| Path | Role |
|---|---|
| `prisma/schema.prisma` | Extend `EntityType` (+`department`, +`division`, +`center`); add the `UnitRole` enum `{owner, curator}` and models `UnitAdmin` (with `role`), `DivisionMembership`; add `leaderInterim Boolean @default(false)` to `Center`. (ADR-005 Amendment 1 § A1.1.) |
| `prisma/migrations/{ts}_unit_curation/` | Additive migration — the enum values, two tables, one column. |
| `lib/api/manual-layer.ts` | Extend the merge helpers / `Merged<T>` types for dept/div `field_override` and the three unit types in `suppression`; the role-aware `unit_admin` predicate — `ownerOf`/`curatorOf`/`canGrant` (with the division→department cascade and the scope-⊆-own / authority-≤-own checks of Amendment 1 § A1.2). |
| `lib/api/directory.ts` *(new)* + `app/api/edit/people-search/route.ts` *(new)* | The LDAP people-search the grant UI resolves names against — name fragment → `[{cwid, displayName, title, dept}]`, minimal attributes, enterprise directory (not the scholars corpus). |
| `lib/api/departments.ts`, `lib/api/divisions.ts` | Apply the `field_override` merge; honor unit suppression; a manually-created division unions its `DivisionMembership` roster with LDAP faculty. |
| `lib/api/centers.ts` | In-row reads; `CenterMembership` roster; honor unit suppression. |
| `lib/url-resolver.ts` | A suppressed unit resolves to `404`. |
| `etl/ed/index.ts`, `lib/slug.ts` | Consult `field_override` (`slug`, `leaderCwid`, `leaderInterim`) before the dept/div `upsert` and the chair/chief write. Orphan sweep already `source='ED'`-scoped. |
| `etl/search-index/index.ts` | Apply unit suppression, description overrides, and `CenterMembership` / `DivisionMembership` facet keys when building documents. |
| `app/edit/department/[code]/page.tsx`, `app/edit/division/[code]/page.tsx`, `app/edit/center/[code]/page.tsx`, `app/edit/unit/new/page.tsx` *(new)* | The curation pages; the roster section renders only for centers and manually-created divisions; the **access (grant) section is Owner-managed** (with a role selector); structural sections (slug, `centerType`, retire) render for **Superuser only**. `/edit/unit/new` offers the no-code subunit to Owners, the coded division to Superusers. |
| `app/edit/scholar/[cwid]/page.tsx` | self-edit-spec's page; widen its authz to admit a scoped Owner or Curator of the scholar's LDAP-primary unit. |
| `app/api/edit/field/route.ts`, `app/api/edit/suppress/route.ts`, `app/api/edit/revoke/route.ts` | Widen `entityType` / `fieldName` allowlists; add the `op` handler (shared with self-edit-spec). |
| `app/api/edit/unit/route.ts`, `app/api/edit/roster/route.ts`, `app/api/edit/grant/route.ts` *(new)* | Unit create / center update; roster add/remove (rejects ETL-managed units); `unit_admin` grant/revoke. |
| `lib/edit/authz.ts`, `lib/edit/validators.ts`, `lib/edit/revalidation.ts` | The role-aware Owner/Curator/Superuser predicate — `ownerOf`/`curatorOf`/`canGrant` (+ cascade, + scope/authority containment, + proxy scope); unit & creation validation; revalidation fan-out. (Extend self-edit-spec's modules.) |
| `components/division/division-page.tsx`, `components/center/center-page.tsx` | The roster section (manually-created divisions, centers); render the interim qualifier (dynamic `role` label). |
| `components/scholar/leader-card.tsx`, `components/department/department-page.tsx` | Render the interim qualifier. |
| `scripts/backfills/{date}-import-unit-curation.ts` *(launch)* | One-shot backfill of `data/division-chiefs.txt` / `data/center-members/*.txt`; ships in the same PR as the loader/seed deletions. |
| `prisma/seed-centers.ts`, `prisma/seed-center-members.ts` | Retired / scoped — see [Interfaces](#interfaces-and-dependencies). |

---

## References

- [ADR-005](./ADR-005-manual-override-layer.md) — Manual-override layer; the mechanism this SPEC builds on and amends.
- [`self-edit-spec.md`](./self-edit-spec.md) — the scholar-facing sibling SPEC; this SPEC reuses its scholar write path for proxy editing, shares the `/api/edit/field` `op` extension, and shares the B03 row-shape dependency (its Open Question #3).
- [ADR-002](./ADR-002-division-chiefs.md) — division chiefs; Path C (the override file) is superseded here. [ADR-003](./ADR-003-center-membership.md) — center membership; the `.txt` curation is superseded here.
- [ADR-001](./ADR-001-runtime-dal-vs-etl-transform.md) — runtime DAL is read-only over MySQL + OpenSearch; the ETL is the only writer.
- B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) / B02 [#101](https://github.com/wcmc-its/Scholars-Profile-System/issues/101) / B03 [#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102) — SSO, authorization predicate, audit log.
- `prisma/schema.prisma` — `Department`, `Division`, `Center`, `CenterMembership`. `etl/ed/index.ts` — the dept/div `upsert` and orphan sweep. `etl/search-index/index.ts` — unit facet keys.
