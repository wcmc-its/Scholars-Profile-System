# Org-unit administrators as scholar-profile editors (ADR-005 Amendment 4 — companion design doc)

**Status:** Accepted as **ADR-005 Amendment 4** (2026-06-08). This is the long-form companion to the
inline amendment in [`ADR-005-manual-override-layer.md`](./ADR-005-manual-override-layer.md)
(§ Amendment 4), which is **authoritative**; this file holds the design rationale (the way
`unit-curation-spec.md` backs Amendment 1).
**Relates to:** ADR-005 (manual-override layer) · `docs/scholar-proxy-spec.md` (#779, Amendment 3 —
the sibling *designee* axis) · #540/#728 (org-unit roles, Amendment 1).
**Implementation:** P1 predicate (#788) + P2 write-path wiring/banner/audit (#790) **merged**; P3
panel + P4 conflict-relaxation in **#791**; P5 (this promotion) ratifies it.

---

## 1. Problem

Two things surfaced testing the shipped #779 proxy editor:

1. The "Add a proxy editor" copy says the person *"must not already be a scholar, an org-unit
   administrator, or a Scholars administrator."* In reality the people a unit delegates this work
   to (a department administrator, a faculty member) **often hold one of these roles**.
2. We want the panel to also show people who can edit a scholar's profile **by virtue of their
   org-unit administrator status.**

**The gap (verified).** Today a UnitAdmin has **no** edit access to an individual scholar's
profile. `authorizeFieldEdit` for a scholar's `overview` is **self-only** (slug is superuser-only);
the `/edit/scholar/[cwid]` gate is self / superuser / #779-assigned-proxy. #540 org-unit admins
edit unit **entities** (department/division/center descriptions, leadership) — *not their members'
profiles*. So there is currently nothing role-derived to display, because that access does not
exist. Point (2) is therefore a **new authorization capability**, not a display change.

This proposal adds that capability and folds the answer to (1) into a single, coherent model of
*"who may edit Dr. X's profile."*

## 2. Proposed model

*"Who may edit scholar S's profile (overview + own-publication hide)?"*

| Editor | Mechanism | Consent | Manageable in panel |
|---|---|---|---|
| S themselves | self-edit (#356) | n/a | — |
| Scholars administrators | superuser | institutional | — |
| An explicitly designated person | **#779 assigned proxy** | S or a superuser grants | add / remove |
| **An administrator of S's org unit** | **role-derived (new)** | *institutional, automatic* | read-only (managed in #540 Administrators tab) |

The panel ("Proxy editors" → rename **"Profile editors"**) shows the last two: assigned proxies
(managed inline) **and** the role-derived unit administrators (read-only, labelled *"via
Department of Medicine administrator"*), so the scholar/superuser sees the full edit surface.

## 3. Authorization rule (new, role-derived path)

A request by real CWID `A` to edit scholar `S`'s `overview` (or hide `S`'s own publication) is
allowed via this path iff **all** hold:

1. `impersonatedCwid === null` (a #637 overlay never confers it — mirrors #779 IS-1);
2. `A` holds a `UnitAdmin` row over a unit `U` with `role ∈ {owner, curator}` — **both** (D2);
3. `S` is a **member of `U`** — `U` is `S`'s **department** (`Scholar.deptCode`, ED/LDAP-authoritative,
   not `field_override`-able, **not** appointment-derived) **or** a **division** `S` belongs to
   (`Scholar.divCode` **or** the `DivisionMembership` roster); **centers are excluded by default**,
   admitted **only behind `UNIT_ADMIN_CENTER_PROXY`** (#1104 — see § D1 revision below: a `center`
   `S` is a **current** member of, `CenterMembership` date-filtered via `isCenterMembershipActive`).
   Includes the #540 owner→division cascade (a department owner/curator reaches scholars in that
   department's divisions); centers have no parent, so no cascade applies to them;
4. the field is in the **positive allowlist** — `overview` for a field edit; `publication` +
   `contributorCwid === S` for a hide (identical to the #779 proxy scope — PE-03/IS-2).

Keyed on `realCwid` (never `session.cwid`/effective), re-evaluated live per request, fail-closed.
This is a **separate predicate** (`canEditScholarViaUnit`) from #779's `isGrantedProxy`; both feed
the same `overview`/suppress allow branches. `slug`, visibility, whole-scholar suppression, and all
unit-structural fields stay out of scope.

## 4. Relationship to #779 and the "no other role" rule

- **#779 stays** for explicit, cross-unit, or no-role delegates (e.g. Beth Chunn editing Sharma,
  where Beth administers no unit Sharma belongs to). The role-derived path covers the institutional
  "my department admin manages my faculty" case automatically.
- **Relax the assigned-proxy exclusion** (D4) so a person *with* a role can still be explicitly
  assigned (point 1): drop the `proxy_is_scholar` and `proxy_is_unit_admin` legs from
  `checkProxyConflictingRole`. **Keep `proxy_is_superuser`** — superusers already do anything (full
  edit access via the superuser path), so a proxy grant to them is meaningless; they are simply not
  assignable as a proxy.
- **Drift audit interaction (#786): RETIRE.** Once `unit_admin`/`scholar` are no longer conflicts,
  the drift query D's two SQL-expressible legs flag legitimate states, and the one remaining
  invariant (a proxy who became a *superuser*) is SQL-inexpressible **and** already enforced live
  per-edit — so a DB-leg drift audit has zero checkable conditions. PR #786 is closed unmerged
  (ADR-005 A4.5). The role-derived path itself has no grant row that can go stale (re-evaluated live
  per request), so there is no unit-admin drift analog to build.

## 5. Threat model

**In scope — mitigated:**

| Threat | Mitigation |
|---|---|
| A department owner/curator edits **any** member faculty's bio (the core new surface) | Scope-bounded to `overview` + own-pub hide (no slug/visibility/structure); every write is a non-repudiable B03 audit row (`actor_cwid` = the admin); membership relation is ED-sourced/authoritative; live per-edit re-check. |
| Stale role → editing after losing the unit role | Per-edit re-check on the live `unit_admin` row (no caching), mirroring #779's fail-closed re-check. |
| Cascade over-reach (dept owner editing unrelated divisions) | "Member-of" + cascade are explicit and bounded by the #540 owner→division relation; centers do **not** cascade. |
| Impersonation riding the path | `impersonatedCwid === null` gate (#637 orthogonality). |
| **Roster self-add escalation** — a division **curator** adds an arbitrary scholar to that division's `DivisionMembership` roster (curator-editable via `POST /api/edit/roster`, gated by the same `getEffectiveUnitRole`) to gain `overview`/own-pub-hide edit over them | **Accepted risk** — this **deliberately reverses Amendment 1 §A1.3 T3** ("roster membership never confers profile-edit rights"); D1 counts the roster on purpose, as intentional institutional access (D3). **Bounded** (overview + own-pub hide only — no slug/visibility/structure), **automatic/no-opt-out**, and **fully traceable**: every edit is a B03 row (`actor_cwid` = the curator) *and* the roster addition is itself B03-audited. Revisit if abuse appears in the trail. |

**Out of scope (explicitly):** editing scholars **not** in the admin's unit (the relation gate
denies); structural fields (`slug`); whole-scholar suppression/visibility; any write by a curator
of an `ED:`-locked unit beyond the allowlist.

**Consent posture (D3 — resolved): automatic, no opt-out.** The role-derived path is intentional
institutional access — unlike #779's opt-in grant, the scholar does not opt in and cannot opt out
in v1. The scholar/superuser still sees exactly who can edit (the panel lists the unit admins), and
every edit is audited. Revisit an opt-out only if faculty object.

## 6. Alternatives considered

- **A. Status quo (#779 only).** Rejected — doesn't match the institutional "dept admin manages
  faculty profiles" reality; every delegate must be hand-assigned per scholar.
- **B. Relax #779 only (allow assigning roled people), no role-derived path.** Lighter, and it
  answers point (1) — but a dept admin would still have to be assigned *per scholar*, and the panel
  still couldn't *show* role-derived editors (point 2). Partial.
- **C. Role-derived unit-admin editing + keep #779 (this proposal).** Covers both points.
- **D. #637 "View as" for unit admins.** Rejected — impersonation is a heavier, support-oriented
  model with an amber banner and full audit overlay; wrong tool for routine bio upkeep.

## 7. Resolved decisions (2026-06-08)

| | Decision | Resolution |
|---|---|---|
| **D1** | "Member-of" relation | **Department + division** (ED `orgUnit` L1 / `DivisionMembership`); **centers excluded** by default — **revised by #1104**: centers admitted behind `UNIT_ADMIN_CENTER_PROXY` (current `CenterMembership` only); owner→division cascade applies (centers do not cascade) |
| **D2** | Which unit roles | **Owner + curator** both |
| **D3** | Consent | **Automatic, no opt-out** in v1 (institutional access) |
| **D4** | Assigned-proxy rule | **Relax** scholar + unit-admin; **keep superuser excluded** (a grant to them is meaningless) |
| **D5** | Panel naming | **Rename "Proxy editors" → "Profile editors"**; role-derived rows labelled by unit |

### 7a. D1 revision — center owners/curators as proxy editors (#1104, 2026-06-XX)

D1 originally **excluded centers** from the "member-of" relation. #1104 **revises D1** to admit
centers, **behind a new default-off flag `UNIT_ADMIN_CENTER_PROXY`** (prod stays dark until ops flip
it). The extension is deliberately minimal and reuses the SHIPPED Amendment 4 path (mode
`unit-admin`):

- **Membership relation.** `S` is a member of a center `U` when `S` holds a **current**
  `CenterMembership` row for `U` — "current" per `isCenterMembershipActive` (`lib/api/centers.ts`),
  the SAME date predicate the public center roster uses. **Lapsed** (`endDate` past) and **pending**
  (`startDate` future) memberships confer **nothing**. Centers have no parent unit, so **no cascade**
  applies.
- **Roles (D2 unchanged).** Owner **or** curator of the center, resolved live via
  `getEffectiveUnitRole({kind:'center', code})` (the `UnitAdmin.entityType` enum already includes
  `center`).
- **Surface (unchanged).** Exactly the existing allowlist — `overview` (bio) edit + own-publication
  hide (`publication` + `contributorCwid === S`). **No** slug / visibility / highlights / COI /
  topics / unit structure.
- **Invariants preserved.** Keyed on `realCwid` with the `impersonatedCwid === null` gate (IS-1: a
  #637 "View as" overlay never confers the center path); `scholar.deletedAt` fail-closed; the #536
  hidden-identity (doctoral-student) 404 in `/edit/scholar/[cwid]` still fires for every non-superuser
  unit admin — a center owner can **not** reach a hidden student's edit surface.
- **Flag-off behavior.** With `UNIT_ADMIN_CENTER_PROXY` off, **no** `CenterMembership` read is issued
  and no `center` unit is ever resolved, so the dept/division behavior is byte-identical to today.

**Accepted risk (date-scoped).** A center **owner/curator** can add an arbitrary scholar to their
center's `CenterMembership` roster and thereby gain the bounded `overview`/own-pub-hide access — the
same roster-self-add escalation already accepted for divisions (§5), now extended to centers. It is
**narrowed by the date filter**: only a **current** membership confers access, so a lapsed or
not-yet-started add is inert. Bounded (overview + own-pub hide only), automatic/no-opt-out (D3), and
fully traceable (every edit is a B03 row with `actor_cwid` = the admin; the roster add is itself
audited). Revisit if abuse appears in the trail.

## 8. Implementation plan (phased — each phase a PR, on approval)

Member-of lookups are **DB-column/roster-sourced** (`Scholar.deptCode`/`Scholar.divCode` columns + the
`DivisionMembership` roster — never `Appointment`), so this whole feature **works even while ED is
unrouted** — unlike the directory typeahead. ED routing is *not* a blocker.

- **P1 — authz predicate (no wiring). [Done — #788]** `lib/edit/unit-scholar-authz.ts`:
  `resolveEditableUnitViaUnitAdmin(adminCwid, scholarCwid, db)` (boolean façade
  `canEditScholarViaUnit`) — member-of (department via `Scholar.deptCode` + division via
  `Scholar.divCode`/`DivisionMembership` roster, owner→division cascade) AND a live `unit_admin` row
  (owner|curator). Fail-closed, keyed on real CWID. Pure predicate + unit tests (mirrors
  `proxy-authz`).
- **P2 — write paths. [Done — #790]** Wire the predicate beside the #779 branch in
  `app/api/edit/field/route.ts` (`overview`) and `app/api/edit/suppress/route.ts` (publication hide,
  `contributorCwid === S`), and add the gate to `/edit/scholar/[cwid]` (new render mode + a "via
  {unit} administrator" banner). B03 audit carries the unit context in `afterValues`. Route-level
  tests.
- **P3 — panel. [In #791]** Rename `ProxyEditorCard` → "Profile editors"; add a **read-only**
  "Org-unit administrators" group from a derived feed (`listUnitAdminEditorsForScholar` — the inverse
  of the P1 resolver). Component tests. (Admin names resolve via the directory → degrade to CWID
  while ED is unrouted — same caveat as #779.)
- **P4 — relax #779 + retire dead code. [In #791]** Drop the scholar/unit-admin legs from
  `checkProxyConflictingRole` (keep superuser); update the add-proxy copy to *"must not already be a
  Scholars administrator."* **Retire the #786 drift audit** — close PR #786 unmerged (its DB legs
  are now non-conflicts; the surviving superuser leg is SQL-inexpressible / enforced live). Retire
  the dead `canProxyEdit` predicate (its "roster never confers edit" invariant is the opposite of
  D1). Update `proxy-authz` tests.
- **P5 — docs. [This file]** Promote to **ADR-005 Amendment 4** (inline § Amendment 4); reconcile
  `scholar-proxy-spec.md` cross-refs and the runbook.

**Open-PR impact:** **PR #786 (drift audit) is retired — close unmerged** (obsoleted by P4 D4).
**PR #783 (route tests)** conflicts with P2's test edits and needs a rebase onto post-P2 master (or
fold its proxy-branch tests in / close it).

---

**Status:** Accepted as ADR-005 Amendment 4 (2026-06-08). P1/P2 merged; P3/P4 in #791; this
promotion is P5.
