# Unit curation — v1 SPEC

**Status:** Draft
**Date:** 2026-05-17
**Authors:** Scholars Profile System development team
**Builds on:** [ADR-005](./ADR-005-manual-override-layer.md) — Manual-override layer (the `field_override` + `suppression` mechanism)
**Coordinates with:** [`self-edit-spec.md`](./self-edit-spec.md) — the scholar-facing feature on the same mechanism; this SPEC's delegated profile-editing reuses its write paths and jointly owns the scholar write path
**Implements:** the org-structure curation feature — supersedes the file/seed manual curation of [ADR-002](./ADR-002-division-chiefs.md) (Path C) and [ADR-003](./ADR-003-center-membership.md), resolves ADR-005's deferred *"Manually-created records"* non-goal, and absorbs (scoped) self-edit-spec's deferred *"broad admin field-editing"*
**Gated by:** B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) (SSO), B02 [#101](https://github.com/wcmc-its/Scholars-Profile-System/issues/101) (authorization predicate + telemetry), B03 [#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102) (append-only audit log — **must land in the generalized `target_entity_type` / `action` row shape**; see [Interfaces](#interfaces-and-dependencies))
**Requires:** an ADR-005 amendment — see [Architecture decisions](#architecture-decisions-this-spec-makes)

---

## Purpose

**Unit curation** lets human-entered data about an organizational unit — a department, division, center, or institute — survive the nightly ETL, and lets a unit's own **administrator** maintain that unit: its page, its roster, and (as a proxy) the profiles of its faculty.

It has three layers, all on ADR-005's manual-override mechanism:

1. **Unit-page curation** — a unit's description, leadership, and slug, as overrides over ETL data or as the data for a unit the ETL never produced. The *"overrides, or for the first times"* the request named — ADR-005's two cases.
2. **A per-unit administrator tier** — a `unit_admin` grant scopes a non-curator editor to a specific unit. This replaces the *"steward"* model of earlier drafts: the editor of a department's page is **not** its Chair — it is an administrator, and the request was explicit (*"Department chair or chief is never the steward — it's usually some admin doing this"*).
3. **Roster and delegated profile editing** — a unit admin curates the roster of a manually-owned unit and maintains the profiles of its faculty as a proxy for those who will not self-edit.

It is the convergence point of three deferred pieces. [ADR-002](./ADR-002-division-chiefs.md) (division chiefs) and [ADR-003](./ADR-003-center-membership.md) (center membership) each shipped manual curation as **flat files** and closed with a *"Future work: admin UI"* note — this SPEC is that UI. ADR-005 § Non-goals deferred *"Manually-created records … needing an `origin` discriminator"* — this SPEC decides it. And `self-edit-spec.md` § Non-goals deferred *"broad admin field-editing"* — this SPEC absorbs it, **scoped**: a unit admin proxy-edits only what a scholar could self-edit.

It does **not** redesign ADR-005's mechanism, and it does **not** cover the visual/interaction design of the curation pages — that is a `UI-SPEC.md` deliverable (`gsd-ui-phase`).

*Terminology.* **Curator** — a session whose SSO claims include the `scholars-admins` group (ADR-005's "superuser"; self-edit-spec's superuser — the *same* tier, reused). **Unit admin** — a scholar holding a `unit_admin` grant for a specific unit; a non-curator editor scoped to that unit. **Unit** — a `Department`, `Division`, or `Center` row; an *institute* is a `Center` with `centerType='institute'` (no separate model). **Proxy edit** — a unit admin editing a faculty member's profile on their behalf. **ETL-managed** vs **manually-owned** — see [Architecture decisions](#architecture-decisions-this-spec-makes).

---

## Scope and actors

Two actors. A unit admin acts only within their granted unit; a curator acts anywhere and additionally holds the structural powers.

| Capability | Unit admin (granted unit) | Curator (any unit) |
|---|---|---|
| Edit the unit's `description` | ✅ | ✅ |
| Set / clear the unit's leader (Chair / Chief / Director) + interim flag | ✅ | ✅ |
| Curate the roster of a **manually-owned** unit — a center, or a manually-created division | ✅ | ✅ |
| Proxy-edit a unit faculty member's `overview`; proxy-hide their misattributed publication | ✅ — **LDAP-primary faculty only** | ✅ |
| Set / clear the unit `slug`; set `centerType` | ⛔ — routing-critical / structural | ✅ |
| **Create** a new division or center/institute; **retire** a unit | ⛔ | ✅ |
| **Grant / revoke** a `unit_admin` | ⛔ — no privilege propagation | ✅ |

Unit-admin status is *data-derived* — a `unit_admin` row, not an SSO group — so it needs no new B02 group plumbing. A unit with no admin granted yet is curator-only until a curator grants one.

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

- **`UnitAdmin`** — the per-unit grant. `(entityType, entityId, cwid, grantedBy, createdAt)`, `@@unique([entityType, entityId, cwid])`, indexed on `cwid`. Inserted on grant, **hard-deleted** on revoke; B03 audits both (no soft-revoke column — an access grant is crisply present or absent).
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
| `description` | `Department/Division.description` — the unit's prose blurb. No ETL writes the column; the override is its effective source of truth (column kept as the read-merge fallback). | Unit admin or curator. | **Plain text**, no HTML — the unit pages render `description` as an escaped JSX child (`department-page.tsx:117`, not `dangerouslySetInnerHTML`), so no sanitizer is needed. ≤ 4,000 chars. Empty string clears it. |
| `slug` | `Department/Division.slug` — the URL segment. ETL-written; `etl/ed` consults the override before minting. | **Curator only.** | `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, no `--`, ≤ 64 chars. A department slug is unique against all `Department.slug`; a **division** slug need only be unique **within its parent department** (`Division.@@unique([deptCode, slug])`). Reject reserved segments (`divisions`, `by-cwid`, `new`). Collision → `400`. |
| `leaderCwid` | `Department.chairCwid` / `Division.chiefCwid` — type-agnostic name; the merge helper maps it and derives the role label (Chair/Chief) from `entityType`. | Unit admin or curator. | A real active `Scholar.cwid` or the empty string (the three states are below). Unknown CWID → `400`. |
| `leaderInterim` | The interim/acting qualifier — renders "Interim Chair" / "Acting Chief". No backing column for dept/div; a synthesized merged property, default `false`. | Unit admin or curator. | `'true'` / `'false'`. Inert without a `leaderCwid`. |

For centers (manually-owned) the same fields are edited **in-row**: `description`, `slug` (curator only — the `Center.slug` column is updated directly, so the new `/centers/{slug}` URL is live at once), `directorCwid` + `leaderInterim`, `centerType` (curator only).

**Setting, clearing, and the three leadership states.** `POST /api/edit/field` takes `op: "set"` (default) or `"clear"`; `"clear"` **deletes** the `field_override` row, reverting the field to its ETL/seed value:

| User intent | Call | State |
|---|---|---|
| "Use the auto-detected leader" | `{ op:"clear", fieldName:"leaderCwid" }` | *no row* — defer to ADR-002 detection |
| "This unit is vacant" | `{ op:"set", fieldName:"leaderCwid", value:"" }` | `value=''` — explicit vacancy |
| "The leader is X" | `{ op:"set", fieldName:"leaderCwid", value:"<cwid>" }` | `value=<cwid>` — explicit override |

The three-state model is dept/div-specific (ADR-002 *auto-detects* chairs/chiefs); a center's `directorCwid` has no detection, so two states — set or vacant. `op` is optional and additive (absent → `"set"`), so it does not alter self-edit-spec's `/api/edit/field` contract — see [Interfaces](#interfaces-and-dependencies).

### 2 — The unit roster

Roster curation follows the **same ETL-ownership principle as field curation** (decision 3): a *manually-owned* unit has a manually-curated roster; an *ETL-managed* unit's roster is LDAP's and is not manually editable. The clarification that prompted this — *"add or subtract people from divisions should only be for manually-created divisions"* — is that principle applied to membership.

- **A department, or an LDAP-sourced division (`source='ED'`), has no manual roster.** Its faculty are exactly the scholars LDAP places in it via `Scholar.deptCode` / `divCode`. No curator or unit admin adds, removes, or hides a member; a wrong appointment routes to ED. (Departments are always ETL-managed — v1 does not create them — so they fall entirely on this side.)
- **A center or institute** has a `CenterMembership` roster — a unit admin or curator adds/removes members. A center is manually-owned (no ETL writes the `center` table), so its roster *is* the manual table. Supersedes `data/center-members/*.txt`.
- **A manually-created division (`source='manual'`)** has a `DivisionMembership` roster — a unit admin or curator adds/removes members. This is how a pre-registered division is populated *before* LDAP adoption — it has no LDAP faculty yet. After adoption the page unions the `DivisionMembership` roster with the LDAP faculty that have attached, deduplicated; the division stays `source='manual'`, so the manual roster remains editable.

`CenterMembership` and `DivisionMembership` share a shape — `(unitCode, cwid, source, lastRefreshedAt)`, no FK to `Scholar` (ADR-003 — an added scholar may not have a row yet); UI-added rows carry `source='manual-ui'`. They are the manual-roster tables for the two manually-owned unit families. A roster operation targeting a department or an LDAP-sourced division is rejected `400` — there is no manual roster to write.

### 3 — Delegated profile editing (proxy)

A unit admin maintains the profiles of their unit's faculty — the reality the request named, and the realistic complement to self-edit (most faculty will not self-edit).

This introduces **no new mechanism.** Proxy editing reuses `self-edit-spec.md`'s exact write paths — `field_override(scholar, cwid, 'overview')` for the bio, and the per-author `suppression(publication, pmid, contributorCwid)` for hiding a misattributed publication — and self-edit-spec's `/edit/scholar/[cwid]` route. What this SPEC adds is **one new authorized actor**.

- **Field set = self-edit scope.** A unit admin edits, for a faculty member, exactly what that member could edit for themselves: `overview`, and the hiding of their own misattributed publications. **Upstream-authoritative scalars** (`primaryTitle`, `primaryDepartment`, `email`, …) are **not** proxy-editable — self-edit-spec's reasoning (a `field_override` masks the system of record) is actor-independent; corrections route to ED/SOR.
- **Scope = LDAP-primary faculty only.** A unit admin may proxy-edit scholar S iff S's *LDAP-primary* `deptCode`/`divCode` falls within the admin's grant. **Roster membership does not count** — being listed in a center's or a manual division's roster (mechanism 2) never confers profile-edit rights, or an admin could add any scholar to a roster and capture them. Proxy editing is scoped to a scholar's *home* LDAP unit, full stop; a roster is a listing, not authority over its members.
- **Provenance.** A proxy edit writes the same `field_override` row a self-edit would, with `actorCwid` = the admin (not the scholar) — so `actorCwid <> entityId` is the durable marker of a proxy edit; B03 records the full actor/target.

**Coordination:** self-edit-spec owns the field set, validation, sanitization, and the `/edit/scholar/[cwid]` route; this SPEC owns the unit-admin actor and its scoping. self-edit-spec's authorization table must widen its `overview`-edit and per-author publication-hide rows to admit this actor — the two SPECs jointly own the scholar write path. See [Interfaces](#interfaces-and-dependencies).

### 4 — Unit lifecycle and grants (curator only)

- **Create** a division or center/institute — see [Manual unit creation](#manual-unit-creation).
- **Retire** a unit — a whole-unit `suppression` row (`contributorCwid` NULL). The page `404`s (via `lib/url-resolver.ts`), the facet drops on the next nightly rebuild; soft and revocable; members and `scholarCount` untouched. A retired unit is not a retraction/FERPA case — the nightly rebuild plus `revalidatePath` suffices (no fast-path search write).
- **Grant / revoke** a `unit_admin` — a curator assigns a CWID to a unit. There is no propagation: a unit admin cannot grant further admins.

---

## Manual unit creation

Resolves ADR-005's deferred non-goal. v1 creates **divisions and centers/institutes**; a new *department* is out of scope (LDAP-canonical, routing-central).

**A division** — a curator creates a `Division` row with `source='manual'` and **the real LDAP N-code** as its `code`. The N-code is required, not optional: a division's LDAP-primary membership is derived entirely from `Scholar.divCode`, so a made-up code is permanently unadoptable. The real N-code makes the division *pre-registered* — when the ED ETL later sees a scholar carrying it, the scholar auto-attaches and the row is *adopted* into ETL management (ADR-002's documented Colorectal Surgery / Biostatistics gap). Adoption is seamless because division *field* curation writes `field_override` from creation — `etl/ed` already honors it. Before adoption the division is **not a dead skeleton**: a unit admin populates it through its `DivisionMembership` roster (mechanism 2). The in-row `name` yields to LDAP's on adoption. The N-code, once chosen, cannot be corrected in place — see the [typo failure mode](#non-goals).

**A center / institute** — a curator creates a `Center` row (`source='manual'`, synthetic slug-like `code`, `centerType`). No ETL touches the `center` table, so it is never orphan-swept or adopted. This **retires `prisma/seed-centers.ts`** — the 8 seeded centers become curator-owned rows.

A `source='manual'` unit is untouched by the ETL by construction: the dept/div `upsert` loop iterates only LDAP-emitted codes; the orphan sweep is `source='ED'`-scoped; centers are not in the nightly orchestrator at all.

---

## Surfaces

Two route trees, extending `self-edit-spec.md`'s `/edit/*` and `/api/edit/*` families — both already `CachingDisabled` at CloudFront (`cloudfront-cache-spec.md` rows 1–2; no new CDN config). Visual design is a `UI-SPEC.md` deliverable.

### `/edit/*` — pages (SSO-gated, uncached, GET)

| Route | Actor | Contents |
|---|---|---|
| `/edit/department/[code]`, `/edit/division/[code]`, `/edit/center/[code]` | curator, or that unit's admin | Edit `description`, leadership. **A roster section appears only for a center or a manually-created division** (decision: manually-owned units only). Curator-only sections: `slug` / `centerType`, retire, and the unit-admin grant list. |
| `/edit/unit/new` | curator only | Create a new division (parent + real N-code) or center/institute. |
| `/edit/scholar/[cwid]` | curator, or a unit admin of the scholar's LDAP-primary unit | self-edit-spec's route, **reused** for proxy editing — not a new route here. self-edit-spec gates it; this SPEC widens the actor set. |

All `/edit/*` pages read the target with the suppression filter off (ADR-005 § "One read-path exception"). No valid session → SSO login (B01).

### `/api/edit/*` — write endpoints (SSO-gated, uncached, POST-only)

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/edit/field` *(shared, widened)* | `{ op?: "set"\|"clear", entityType, entityId, fieldName, value? }` | Upsert/delete one `field_override` row — dept/div unit fields, or scholar `overview` (proxy). |
| `POST /api/edit/unit` *(new)* | create: `{ op:"create", unitType, name, slug, deptCode?, code?, centerType? }`; center edit: `{ op:"update", entityType:"center", entityId, fieldName, value }` | Create a manual division/center; or update a `Center` row in place. |
| `POST /api/edit/roster` *(new)* | `{ unitType: "center"\|"division", unitCode, cwid, action: "add"\|"remove" }` | Center → `CenterMembership`; manually-created division → `DivisionMembership`. A department or an LDAP-sourced (`source='ED'`) division → `400`. Refreshes the affected count. |
| `POST /api/edit/suppress` *(shared, widened)* | `{ entityType, entityId, contributorCwid?, reason }` | Retire a unit (unit `entityType`, `contributorCwid` always null); or hide a publication (proxy — `entityType='publication'`, `contributorCwid` set, ADR-005's original per-author semantics). |
| `POST /api/edit/revoke` *(shared)* | `{ suppressionId }` | Soft-revoke one `suppression` row. |
| `POST /api/edit/grant` *(new)* | `{ entityType, entityId, cwid, action: "grant"\|"revoke" }` | Insert / hard-delete one `unit_admin` row. Curator only. |

All return `200` / `400` / `401` (empty body) / `403` / `5xx`. Same `Content-Type: application/json` + same-origin defense as self-edit-spec.

---

## Authorization

The feature consumes B01's session and B02's predicate machinery. **Session:** `{ cwid, isSuperuser }`, `isSuperuser` re-checked per POST (B02). A **curator** is `isSuperuser`. A **unit admin of unit U** is the predicate:

> a `unit_admin` row exists for `(U)` — **or**, if U is a division, for U's parent department `(department, U.deptCode)`.

A department-level grant **cascades to that department's divisions**; a division-level grant covers only that division (no upward cascade).

| Action | Allowed iff |
|---|---|
| `field` — `fieldName ∈ {description, leaderCwid, leaderInterim}` | curator **or** unit admin of the target unit |
| `roster` — add/remove (center or manually-created division) | curator **or** unit admin of the target unit. A department or `source='ED'` division → `400` (no manual roster — not an authorization failure). |
| `field` — `fieldName='slug'`; `unit` center `centerType`; `unit` `op:"create"`; `suppress`/`revoke` of a unit | curator only |
| `grant` | curator only |
| `field` — `entityType='scholar'`, `fieldName='overview'` (proxy) | curator, **or** unit admin of the scholar's **LDAP-primary** `deptCode`/`divCode`. (Self-edit by the scholar is self-edit-spec's row.) |
| `suppress` — `entityType='publication'`, per-author (proxy hide) | curator, **or** unit admin of the contributor's LDAP-primary unit, **or** the contributor themselves (self-edit-spec) |

The predicate keys on `fieldName` and `entityType`, not `op` — clearing is gated identically to setting. The proxy-scope predicate reads the scholar's `deptCode`/`divCode` **columns** (the LDAP values — never `field_override`-able), so it is unambiguous and a roster membership never widens it. An unrecognized `fieldName`, an `entityType` of `grant`/`education`/`appointment`, or a unit `entityId` resolving to no row (and not a `create`) → `400`. Every `403` emits `event: "edit_authz_denied"` with `{ actor_cwid, target_entity_type, target_entity_id, path, reason }` (B02).

Two consequences are deliberate: a curator who **revokes** a `unit_admin` grant cuts the admin's access on their next POST (re-checked per request); and a unit's leader being *auto-detected* never confers any edit rights — the editor is the `unit_admin` grantee, fully decoupled from leadership (which is why this SPEC has no "steward" circularity and no auto-detection-confidence open question).

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
| 2 | Curator sets a division `slug` override; `etl/ed` re-derives the slug | Override wins — `etl/ed` consults `field_override(slug)`; URL changes only on that run. |
| 3 | Curator creates a division (real N-code, `source='manual'`); `etl/ed` runs, no scholar yet carrying the code | Row survives — the `upsert` loop never sees the code; the orphan sweep is `source='ED'`-scoped. |
| 4 | A scholar later appears in LDAP carrying that N-code | `etl/ed` adopts the row: `scholarCount` rises, the scholar attaches; curated `slug`/leadership hold (already `field_override`); `name` yields to LDAP. |
| 5 | Curator creates a new center; `etl/ed` runs | Untouched — nothing in the nightly orchestrator writes the `center` table. |
| 6 | Curator sets a division Chief override; ADR-002 detection would pick someone else | Override wins; supersedes ADR-002 Path C. `op:"clear"` removes the row and re-enables detection — the third state. |
| 7 | Curator grants `unit_admin(department, X, A)`; A edits department X's `description` | Allowed — A is a unit admin of X. |
| 8 | A (admin of department X) edits a **division under X** | Allowed — a department-level grant cascades to its divisions. |
| 9 | A (admin of **division** D) edits D's parent department | `403` — division grants do not cascade upward. |
| 10 | A (admin of X) tries to edit department Y | `403` `edit_authz_denied` `{reason:"not_unit_admin"}`. No write, no audit row. |
| 11 | Curator revokes A's grant; A then POSTs an edit for X | `403` — the `unit_admin` row is re-checked per POST; access is gone. |
| 12 | A (admin of a center) adds a scholar to that center | `CenterMembership` row inserted; the scholar appears on the center page; `scholarCount` refreshed. |
| 13 | A (admin of a manually-created division) adds a scholar to it | `DivisionMembership` row inserted; the scholar appears on the division page even before LDAP adoption. |
| 14 | A roster `add` targets a department, or an LDAP-sourced (`source='ED'`) division | `400` — an ETL-managed unit has no manual roster; its faculty are LDAP's. |
| 15 | A manually-created division with a `DivisionMembership` roster is LDAP-adopted | The page unions the manual roster with the now-attached LDAP faculty, deduplicated; the manual roster stays editable (`source` is still `manual`). |
| 16 | B (admin of S's LDAP-primary department) proxy-edits S's `overview` | Allowed — `field_override(scholar, S, 'overview')`, `actorCwid = B`. |
| 17 | A adds S (LDAP-primary unit = Y) to A's center roster, then tries to proxy-edit S's profile | `403` — proxy scope is the LDAP-primary unit; roster membership never confers profile-edit rights. |
| 18 | A unit admin tries to proxy-edit a faculty member's `primaryTitle` | `400` — upstream-authoritative; not in the proxy field set. Corrections route to ED. |
| 19 | A `roster` add for a CWID with no `Scholar` row yet (incoming hire) | Stored — neither membership table has a `Scholar` FK; it attaches when the row lands. |
| 20 | Curator retires department X (whole-unit suppression) | `suppression(department, X)`; the page `404`s; member scholars unaffected; the facet drops on the next rebuild. Revocable. |
| 21 | A faculty member self-edits their `overview`, then their unit admin also edits it | One `field_override(scholar, cwid, 'overview')` row, upserted in place; **two** B03 rows (`actorCwid` differs). Last write wins. |
| 22 | Curator sets a division `slug` equal to a sibling division's slug under the same department | `400` (`@@unique([deptCode, slug])`); the same slug under a *different* department is accepted. |
| 23 | A unit admin tries to grant `unit_admin` to a colleague | `403` — granting is curator-only; no privilege propagation. |
| 24 | Curator mistypes a division's N-code at creation; LDAP never adopts it | The division renders with only its manual roster; audit query C flags it (stale, never adopted). No in-place fix — recovery is delete-and-recreate; see [Non-goals](#non-goals). |
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

-- D) Proxy-edited scholar profiles — overviews written by a unit admin, not the
--    scholar (actor_cwid <> entity_id). The delegated-editing activity log.
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

- **B01 / B02 — SSO and the authorization predicate.** The validated session and per-POST `isSuperuser` re-check + `edit_authz_denied` telemetry that self-edit-spec consumes. The unit-admin predicate is a DB lookup (`unit_admin` row + the division→department cascade) — **no new B02 group**.
- **B03 #102 — the audit log, in its *generalized* shape.** Gated not on B03 *shipping* but on B03 shipping **with** the `target_entity_type` / `target_entity_id` / `action` generalization — the *same* generalization self-edit-spec requested (its Open Question #3); it is a request to #102, not yet an agreed property of it. This SPEC's actions add `unit_create`, `roster_change`, and `grant_change`, several of which carry **no prior state** (`before` is null) — the generalized row must accept that. Coordinate the two SPECs' need through that one open question.
- **`self-edit-spec.md` — jointly owned scholar write path.** Delegated profile editing (layer 3) reuses self-edit-spec's `field_override(scholar, …, 'overview')`, its per-author `suppression`, and its `/edit/scholar/[cwid]` route — **no new mechanism.** self-edit-spec's authorization table must **widen** two rows — `overview` edit, and per-author publication hide — to admit a *unit admin of the target's LDAP-primary unit* as a third actor. self-edit-spec owns the field set, validation, and route; this SPEC owns the unit-admin actor and its scoping. The two SPECs must also share the `/api/edit/field` `op: "set"|"clear"` extension (additive, default `"set"`, backward-compatible).
- **ADR-005** — the `field_override` / `suppression` tables and read-merge helpers. This SPEC **amends** ADR-005: `EntityType` += `{department, division, center}`; the keying table gains three ETL-stable rows; ADR-005's *"Manually-created records"* non-goal is closed. The new `UnitAdmin` / `DivisionMembership` tables are a purely additive migration.
- **`etl/ed`** — gains the slug + leadership `field_override` precedence consult for departments/divisions. ADR-002 Path A/B detection is unchanged; **Path C (`data/division-chiefs.txt`) is retired**.
- **Retiring the file/seed curation — order is load-bearing.** `prisma/seed-centers.ts` is retired (the 8 center rows become curator-owned); `prisma/seed-center-members.ts`'s clear+repopulate would delete UI-added memberships (edge case 26) — it must be retired or scoped to `source='file'`; `data/division-chiefs.txt` / `data/center-members/*.txt` are superseded. A one-shot backfill imports their content into the manual layer. **The backfill script and the loader/seed deletions must ship in the same PR and run in the same deploy** — the backfill executes and is verified by an audit query *before* the loader code paths are removed.
- **Dev / CI environments.** With `seed-centers.ts` retired, a fresh clone or CI run has no centers; the backfill script doubles as the dev/CI fixture loader (or a minimal `prisma/fixtures/` seed is kept). Production gets the data from the backfill; staging from the B13 (#112) prod snapshot.
- **Operational — seeding `unit_admin`.** There is no upstream source for "who administers a unit." Initial grants are curator-created through the grant UI; an institution-supplied roster can seed them, but no ETL backfill is possible.
- **`#352`** — *not* a dependency: units are ETL-stable by `code`. Noted only to contrast with Grant/Education/Appointment.

---

## Non-goals

- **Manually editing the roster of an ETL-managed unit** — a department or an LDAP-sourced division. Their faculty are LDAP's (`Scholar.deptCode`/`divCode`); only manually-owned units (centers, manually-created divisions) have a curated roster. There is no "hide an LDAP-primary member from a unit roster" — a wrong appointment routes to ED.
- **Overriding a scholar's primary department/division.** `Scholar.deptCode`/`divCode` is LDAP-authoritative; a manual roster (mechanism 2) is a separate listing and never changes it.
- **Proxy-editing upstream-authoritative scalar fields** — `primaryTitle`, `primaryDepartment`, `email`, `orcid`, etc. Proxy editing is self-edit scope (`overview` + the scholar's own publication hiding); a `field_override` on an upstream scalar would mask the system of record. A flagged fast-follow if SOR-correction latency proves unacceptable.
- **Correcting a mistyped division N-code in place.** A division's `code` is its primary key and the FK target for `Scholar.divCode`; v1 cannot rename it. Recovery is delete-and-recreate the `Division` row, its `field_override` rows, and its `DivisionMembership` rows. The clean fix — a transactional curator "change unit code" action — is a flagged fast-follow. (`Center.code` is likewise immutable, but with no adoption story retire-and-recreate is clean.)
- **A unit admin granting `unit_admin`.** Granting is curator-only — no privilege propagation.
- **Co-leadership.** One leader per unit (the single `chairCwid`/`chiefCwid`/`directorCwid` column) plus interim/vacancy. Co-Directors need a leadership join table — deferred.
- **Creating a new department; re-parenting, merging, or splitting units.** Departments are LDAP-canonical; a division's `deptCode` is set at creation or by LDAP; merges/splits are an org-reconciliation exercise.
- **Rich-text descriptions; acronyms, websites, contact info, themes, logos.** v1 `description` is plain text; the rest is out of the lean field set or (logos) binary, which ADR-005 scopes out.
- **A suppression / override / grant admin console.** v1 acts per-unit from the `/edit/*` pages; a browse-all console is a follow-up.

---

## Open questions

1. **The synthetic-code convention for manual centers.** Recommend the ADR-003 slug-like form with a uniqueness check against existing center codes. Manual *divisions* must use the real LDAP N-code (structural).
2. **An unadopted manually-created division.** A pre-registered division renders with only its `DivisionMembership` roster until LDAP adoption. **Recommendation:** accept it; the `UI-SPEC.md` should give a unit with no LDAP faculty a deliberate state distinct from a broken one.
3. **Retiring the file/seed curation.** Recommend the same-PR backfill-then-delete sequence ([Interfaces](#interfaces-and-dependencies)). Confirm timing relative to B01–B03.
4. **ADR amendment vs. new ADR.** Recommend **amending ADR-005** — the enum extension, the `source` discriminator, and the new tables are the same mechanism — not a new ADR-006.
5. **B03 row shape.** Gated on #102 adopting the `target_entity_type` / `action` generalization — the identical dependency as self-edit-spec's Open Question #3. Resolve the two together.

---

## Implementation

| Path | Role |
|---|---|
| `prisma/schema.prisma` | Extend `EntityType` (+`department`, +`division`, +`center`); add models `UnitAdmin`, `DivisionMembership`; add `leaderInterim Boolean @default(false)` to `Center`. |
| `prisma/migrations/{ts}_unit_curation/` | Additive migration — the enum values, two tables, one column. |
| `lib/api/manual-layer.ts` | Extend the merge helpers / `Merged<T>` types for dept/div `field_override` and the three unit types in `suppression`; the `unit_admin` predicate (with the division→department cascade). |
| `lib/api/departments.ts`, `lib/api/divisions.ts` | Apply the `field_override` merge; honor unit suppression; a manually-created division unions its `DivisionMembership` roster with LDAP faculty. |
| `lib/api/centers.ts` | In-row reads; `CenterMembership` roster; honor unit suppression. |
| `lib/url-resolver.ts` | A suppressed unit resolves to `404`. |
| `etl/ed/index.ts`, `lib/slug.ts` | Consult `field_override` (`slug`, `leaderCwid`, `leaderInterim`) before the dept/div `upsert` and the chair/chief write. Orphan sweep already `source='ED'`-scoped. |
| `etl/search-index/index.ts` | Apply unit suppression, description overrides, and `CenterMembership` / `DivisionMembership` facet keys when building documents. |
| `app/edit/department/[code]/page.tsx`, `app/edit/division/[code]/page.tsx`, `app/edit/center/[code]/page.tsx`, `app/edit/unit/new/page.tsx` *(new)* | The curation pages; the roster section renders only for centers and manually-created divisions; the grant-list section is curator-only. |
| `app/edit/scholar/[cwid]/page.tsx` | self-edit-spec's page; widen its authz to admit a scoped unit admin. |
| `app/api/edit/field/route.ts`, `app/api/edit/suppress/route.ts`, `app/api/edit/revoke/route.ts` | Widen `entityType` / `fieldName` allowlists; add the `op` handler (shared with self-edit-spec). |
| `app/api/edit/unit/route.ts`, `app/api/edit/roster/route.ts`, `app/api/edit/grant/route.ts` *(new)* | Unit create / center update; roster add/remove (rejects ETL-managed units); `unit_admin` grant/revoke. |
| `lib/edit/authz.ts`, `lib/edit/validators.ts`, `lib/edit/revalidation.ts` | The curator/unit-admin predicate (+ cascade, + proxy scope); unit & creation validation; revalidation fan-out. (Extend self-edit-spec's modules.) |
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
