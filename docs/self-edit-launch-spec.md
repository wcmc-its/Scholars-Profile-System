# Self-edit — pre-launch SPEC (entity-suppression UI + launch readiness)

**Status:** Draft
**Date:** 2026-05-25
**Authors:** Scholars Profile System development team
**Builds on:** [self-edit-spec.md](./self-edit-spec.md) (the v1 feature SPEC — routes, authorization, write-path) and [self-edit-ui-spec.md](./self-edit-ui-spec.md) (the v1 UI-SPEC — the `/edit/*` shell, dialogs, copy). This SPEC adds the surfaces those two deferred and **re-skins the `/edit` shell** to the Apollo design language.
**Co-revises:** (1) [self-edit-spec.md](./self-edit-spec.md) § Scope and actors, § Surfaces, § Authorization — `#352` has landed, so `grant` / `education` / `appointment` suppression is **no longer "out of scope, blocked on #352"** and **no longer a `400`** (see [§ Co-revisions to the v1 SPECs](#co-revisions-to-the-v1-specs)). (2) [self-edit-ui-spec.md](./self-edit-ui-spec.md) § Scope and ratified decisions — its ratified **single-column stacked-cards** layout is **superseded** by the **Apollo Management Console** master-detail design ([§ Layout](#layout--the-apollo-style-master-detail-shell)).
**Foundation:** [ADR-005](./ADR-005-manual-override-layer.md) — the `field_override` + `suppression` mechanism and the read-merge; [b03-audit-log.md](./b03-audit-log.md) — the append-only audit the write-path already emits for every entity type.
**Closes:** [#160](https://github.com/wcmc-its/Scholars-Profile-System/issues/160) — the "frontend admin component to manage these suppressions" the issue defers to a follow-up; this SPEC is that follow-up's design. References the [PR-A / PR-B handoff comment](https://github.com/wcmc-its/Scholars-Profile-System/issues/160#issuecomment-4536980454): *"The admin/self UI is deferred to a follow-up … Everything above is exercised via the API today."*
**Design system:** Tailwind v4 tokens in `app/globals.css`; primitives in `components/ui/`; the dialog / row-state patterns in `components/edit/`. The **`/edit` shell adopts the [Apollo Management Console](#layout--the-apollo-style-master-detail-shell) design language** — a *real* WCM clinical profile editor we **mirror but cannot access or extend** (black top bar, maroon accents, a left ATTRIBUTES rail + right detail panel).

---

## Purpose

The self-edit v1 build ([#356](https://github.com/wcmc-its/Scholars-Profile-System/issues/356), closed) shipped four surfaces on `/edit/*`: the **Overview** editor, **Profile visibility** (whole-scholar suppress / revoke), **My publications** (per-author hide / show), and the superuser **Slug override** + **publication takedown**. Its SPEC deliberately scoped *out* education, appointment, and grant suppression because the stable ETL keys those need ([#352](https://github.com/wcmc-its/Scholars-Profile-System/issues/352)) had not landed.

Since then, **#352 landed**, and **#160 PR-A ([#480](https://github.com/wcmc-its/Scholars-Profile-System/pull/480)) and PR-B ([#482](https://github.com/wcmc-its/Scholars-Profile-System/pull/482)) wired the full backend** for `education`, `appointment`, and `grant` suppression — the write endpoint, the owner-resolution + chair guard, the read-path filtering, the search-index drop, and the audit row. What they deliberately did **not** ship is any **UI**. A scholar today can hide their *profile* and their *publications* from `/edit`, but **cannot hide a stale appointment, an incorrect degree, or a grant they should not be listed on** — even though the API accepts all three. That is the launch gap this SPEC closes.

This document specifies:

1. **The Apollo-style master-detail layout** the `/edit` surface adopts ([§ Layout](#layout--the-apollo-style-master-detail-shell)), superseding the v1 stacked-cards design.
2. **The three new editable attributes** — Appointments, Education, Funding — and the shared per-entry hide/show row model they use, reusing the existing *My publications* interaction logic.
3. **The read-only (SOR) attributes** — name / title / email / photo — surfaced with Apollo's *"This section is not editable → Request a Change"* affordance, which finally gives the spec's upstream-sourced fields a home.
4. **Role parity** — what the superuser surface (`/edit/scholar/[cwid]`) renders, and the one existing asymmetry (no superuser publications management) this SPEC defers.
5. **The `lib/api/edit-context.ts` extension** — the data contract the new panels consume.
6. **A launch-readiness audit** — the dependencies and #356 carryovers that gate the self-edit view going live, with ownership.

It does **not** redefine the routes, the write-path, the authorization predicate, or the `suppression` schema — those are `self-edit-spec.md`'s and ADR-005's, cited here, not relitigated. It does **not** add a backend: the entity-suppression mechanism is built and tested (see [§ What is already built](#what-is-already-built-no-backend-work)). The layout change is a **container** change — the data contract, write calls, and authorization are layout-independent.

*Terminology* carries over: **self-editing scholar**, **superuser**, **whole-entity suppression** (a `suppression` row with `contributorCwid = NULL`, keyed on the target's stable `externalId`). **Attribute** = one entry in the left rail (Overview, Funding, Appointments, …); its **detail panel** is the right-hand content. ("Panel" and "card" are used interchangeably below — the inner structure of a panel is the v1 card's heading + description + list.)

---

## What is already built (no backend work)

Scoping the work precisely matters because the perceived size of "#160's UI" overstates it, and the layout pivot does not touch any of it. Everything below is **merged and test-covered** on `master`:

| Layer | State | Evidence |
|---|---|---|
| `POST /api/edit/suppress` accepts `education` / `appointment` / `grant` | ✅ built | `app/api/edit/suppress/route.ts` lines 42–48; `contributorCwid` rejected (400) for whole-entity types (lines 63–65). |
| Owner resolution by stable `externalId` | ✅ built | `findSuppressibleEntityOwner()` in `lib/edit/validators.ts`; 400 `entity_not_found` gate. |
| Chair-appointment guard | ✅ built | `isChairAppointment()` → 409 `leadership_appointment_not_suppressible`, **before** authz (route lines 79–85). |
| Authorization (owner or superuser) | ✅ built | `authorizeSuppress()` in `lib/edit/authz.ts` lines 85–95. |
| Read-path filtering (profile sidebars + funding section) | ✅ built | `lib/api/profile.ts` — single payload chokepoint (PR-A/PR-B handoff). |
| Funding-search index drops suppressed grant rows | ✅ built | `etl/search-index` `indexFunding` + `loadAllGrantSuppressions`. |
| B03 audit row for every entity type | ✅ built | `appendAuditRow()` in the suppress transaction; the audit ENUM was already general. |
| Revalidation on suppress / revoke | ✅ built | `resolveAffectedProfiles()` + `reflectVisibilityChange()` + `reflectSearchSuppression()`. |
| Generic revoke (keyed by `suppressionId`) | ✅ built | `POST /api/edit/revoke` already handles the new types. |

**The entire deliverable is therefore client + one server read:** extend `lib/api/edit-context.ts`, build the Apollo shell (rail + detail router) and three attribute panels, plus tests and copy. No new endpoint, no schema change, no migration.

---

## Co-revisions to the v1 SPECs

`self-edit-spec.md` predates PR-A/PR-B and still asserts these as true. They are now **false** and must be corrected in the same change that lands this SPEC:

| Location | Stale text | Correction |
|---|---|---|
| § Scope and actors (≈ line 41) | *"Grant, Education, and Appointment suppression is blocked on the ETL stable-key refactor (#352) and is out of scope here."* | #352 landed; the three types are supported via whole-entity `suppression` rows keyed on `externalId` (PR-A/PR-B). Point to this SPEC for the UI. |
| § Surfaces (≈ line 110) | suppress body `{ entityType: "scholar" \| "publication", … }` | `entityType: "scholar" \| "publication" \| "education" \| "appointment" \| "grant"`. |
| § Authorization (≈ line 136) | *"an entityType of grant / education / appointment → 400 (blocked on #352)"* | These now resolve the owning scholar and authorize **owner-or-superuser**; the only refusals are `entity_not_found` (400) and the chair guard (409). |

And in `self-edit-ui-spec.md`:

| Location | Stale text | Correction |
|---|---|---|
| § Scope and ratified decisions | *"`/edit` is a **settings-style, single-column** page of stacked section cards — not a mirror of the public-profile shell."* | Superseded: `/edit` adopts the **Apollo Management Console** master-detail layout (left ATTRIBUTES rail + right detail panel). The Tiptap editor, the dialog/alert primitives, the row-state model, and all copy carry over unchanged. |

No co-revision to ADR-005 is needed — its keying section already names `externalId` as the stable key and its entity scope was written to generalize.

---

## Scope and ratified decisions

| Route | Actor | v1 today | This SPEC adds |
|---|---|---|---|
| `/edit` | self | Overview, Profile visibility, My publications | The **Apollo shell** + new **Appointments / Education / Funding** attributes (per-entry hide/show) + **read-only SOR** attributes ("Request a Change"). |
| `/edit/scholars` | superuser · **org unit admin** | — | **New — the Profiles roster.** A searchable scholar index; a superuser sees all, an org unit admin sees only their unit(s); per-row **Edit** → `/edit/scholar/[cwid]`. ([§ Admin roster](#the-admin-roster--the-org-unit-admin-role)) |
| `/edit/scholar/[cwid]` | superuser · **org unit admin** (in-scope) | Overview (read-only), Profile visibility, Slug override | The **same shell + attributes**, acting on the target, **reason required**. An org unit admin is **scope-gated** (target must be in a unit they manage) and gets **no Slug** (curatorial → superuser). (Superuser *My publications* deferred — [OQ 1](#open-questions).) |
| `/edit/publication/[pmid]` | superuser | Whole-publication takedown | *Unchanged* (its own page; not folded into the rail). |

**Ratified — encoded below, not reopened:**

1. **Layout: the Apollo Management Console master-detail design.** `/edit` adopts Apollo's design language — black top bar, maroon accents, a left **ATTRIBUTES rail**, a right **detail panel** — superseding v1's single-column stacked cards. We **mirror** Apollo (it's a real WCM tool we cannot access or extend); we do **not** integrate. Each former "card" becomes one attribute's detail panel. See [§ Layout](#layout--the-apollo-style-master-detail-shell).
2. **The new panels reuse the *My publications* interaction pattern verbatim** — `useOptimistic` + `useTransition`, optimistic flip with revert-on-error, inline per-row `destructive` Alert, `router.refresh()` on commit, filter + scroll for long lists. They do **not** share its `state` union; publications keeps a distinct one ([§ Publications is deliberately not refactored](#publications-is-deliberately-not-refactored)).
3. **Each panel lists exactly what the public profile renders** — active appointments only, all education, all grants — so "what I can hide here" equals "what the public sees" ([§ Why mirror the profile's visible set](#why-mirror-the-profiles-visible-set)).
4. **A chair appointment is not hideable** — it renders a `locked` row with visible explanatory text and **no control**, never a disabled button. The backend already refuses it (409).
5. **The unit of grant suppression is one investigator-row, keyed on `externalId`** — not a funding project. The panel's copy says so.
6. **"Request a Change" routes corrections to the source, by issue type.** Read-only directory fields (name/title/email/photo, listed locked in the rail) *and* the data-correction intent on editable attributes route upstream to the owning system (ED, OSRA, ReCiter, ASMS, …), never overriding it here. **Hide ≠ Request a Change** — Hide suppresses *display*; Request a Change fixes *wrong/missing data* ([§ Request a Change routing](#item-level-feedback--request-a-change-the-three-shape-model)).
7. **A Profiles roster is the admin entry point.** A new `/edit/scholars` route — the searchable scholar index admins use to *find* a profile before editing it (no such screen exists today; the superuser deep-links by CWID). For a **superuser** it rides the existing gate (no new authorization); see [§ Admin roster](#the-admin-roster--the-org-unit-admin-role).
8. **A third actor: the Org unit admin (unit-scoped).** Beyond self + superuser, an *org unit admin* manages profiles within their **org unit(s)** — a department, division, or center. Same per-scholar edit surface as a superuser, **scoped** to in-scope scholars and **minus** the curatorial Slug. This is a **new authorization tier** (its own scope model + per-request scope check), deliberately a **separate workstream** from the entity-suppression UI — see [§ The Org unit admin](#the-admin-roster--the-org-unit-admin-role) and [B3](#launch-dependencies-owned-elsewhere).

**Out of scope** — cited, not redesigned:

- The `suppression` schema, the read-merge, derived visibility — ADR-005.
- The write endpoint, the owner/chair/authz logic, the edge-case *write-path* table — `self-edit-spec.md` + the shipped code.
- The grant **funding-search synchronous fast-path** and the **dept / division / center grant-list fan-out** — deferred to [#481](https://github.com/wcmc-its/Scholars-Profile-System/issues/481); the Funding panel's copy sets expectations for the resulting nightly-rebuild latency.

---

## Layout — the Apollo-style master-detail shell

`/edit` adopts the **Apollo Management Console** design language — the WCM clinical profile editor. We **mirror** it; we do not integrate (it's a real tool we cannot access or extend). It supersedes v1's single-column stacked cards. Rendered reference mockups (scholar, superuser, read-only) were produced at design time (`sps-edit-apollo.html`). Three regions:

**1. Top bar (black).** WCM seal + "Scholars Profile Console", a center tab, and right-aligned help / notifications / account menu (the account menu reuses the v1 header affordance). Maroon (`~#7d1c1c` — **match the real Apollo token at build**) marks the active tab. *Only the **editor** adopts the Apollo chrome; the public Scholars site keeps its Cornell-red (`#B31B1B`) header — the two are deliberately distinct surfaces.*

**2. Left ATTRIBUTES rail.** A vertical list of the profile's attributes; selecting one loads its detail panel. The active item is a maroon fill with a chevron; read-only attributes carry a lock glyph and are muted. The rail is a `<nav>` landmark and its items are **links** (`/edit?attr=…`, `/edit/scholar/[cwid]?attr=…`), so each attribute is deep-linkable and its panel is **server-rendered per selection** — no client-only routing, consistent with the existing server-rendered `/edit/*` pages.

The attribute set and who sees what:

| Attribute | Self (`/edit`) | Superuser (`/edit/scholar/[cwid]`) | Kind |
|---|---|---|---|
| Name & Title · Email · Photo | listed, **locked** | listed, **locked** | read-only (SOR → "Request a Change") |
| Overview | ✅ edit bio (Tiptap) | read-only (*"Only the profile owner can edit the bio."*) | self edits |
| Visibility | ✅ suppress whole profile | ✅ (reason required) | suppression |
| Publications | ✅ per-author hide/show | — (deferred, [OQ 1](#open-questions)) | suppression |
| Funding | ✅ hide/show | ✅ (reason required) | **new** |
| Appointments | ✅ hide/show + chair lock | ✅ (reason required) | **new** |
| Education | ✅ hide/show | ✅ (reason required) | **new** |
| Profile URL | — | ✅ slug override | superuser |

**Default attribute:** Overview (self) — the most-edited surface. The superuser surface defaults to Visibility (the most common admin action).

**3. Detail panel (right).** A right-aligned "Preview Profile" link above the panel (the attribute name is *not* repeated as a heading — it already appears in the top bar and as the panel's own title; the page `h1` is the console name). Then the panel: for an **editable** attribute, the entity list with per-row hide/show (the [row model](#the-shared-per-entry-row-model)) plus a per-row "Request a change" menu; for a **read-only** attribute, the [Request-a-Change picker](#item-level-feedback--request-a-change-the-three-shape-model). On the superuser surface an **admin banner** sits above the panel and every Hide opens the reason-required dialog.

```
┌─ ▉ Scholars Profile Console        [My Profile]          ?  ⛉   (JS) Jane ▾ ┐   ← black bar, maroon active tab
├──────────────────────────────────────────────────────────────────────────┤
│  My Profile  (maroon underline)                                            │   ← sub-nav
├─────────────────┬──────────────────────────────────────────────────────────┤
│   ATTRIBUTES     │  Appointments for Jane A. Smith        🔗 Preview Profile │
│   Name        🔒 │  Hide an appointment to remove it from your profile.     │
│   Title       🔒 │  ┌────────────────────────────────────────────────────┐  │
│   Overview       │  │ APPOINTMENTS                            (gray label) │  │
│   Visibility     │  │ Professor of Medicine  [Primary]            [⊘ Hide] │  │  ← maroon title
│   Publications   │  │ Weill Cornell Medicine · 2015–present                │  │
│   Funding        │  │ ───────────────────────────────────────────────────  │  │
│ ▌ Appointments › │  │ Chair, Department of Medicine                        │  │  ← active (maroon)
│   Education      │  │ Weill Cornell Medicine · 2020–present                │  │
│                  │  │ This appointment confers a chair role and can't be   │  │  ← italic, no control
│                  │  │ hidden.                                              │  │
│                  │  │ Attending Physician   ⟨Hidden⟩              [◉ Show] │  │  ← dimmed
│                  │  └────────────────────────────────────────────────────┘  │
└─────────────────┴──────────────────────────────────────────────────────────┘
```

Superuser variant: top bar shows the Apollo *Profiles / Delegates* tabs and a *WCM Profile / NYP Profile* sub-nav style; an admin banner (*"You are editing {Name}'s profile as an administrator. A reason is required for every change."*) sits above the panel; hidden rows carry the **Hidden by the scholar** / **Hidden by an administrator** attribution.

### Item-level feedback — "Request a Change" (the three-shape model)

The Apollo layout surfaces a question every scholar asks on this screen: *"this is wrong — how do I fix it?"* The profile is assembled from several systems of record, so a correction must reach the **right** one. "Request a Change" is therefore a **per-item triage** (Level 3, per `.planning/self-edit-item-feedback-taxonomy.md`): a **per-row** affordance whose issue types each resolve to one of three shapes. It is routing-only today, with the report shape (`{ itemType, itemId, issueType, freeText?, submittedBy, ts }`) chosen so a tracked queue can graduate from it later without a UI rebuild.

**The decision rule.** For any item, ask *is the data correct?*

- **Data correct, just not wanted publicly** → **Hide** (in-app, display-only on Scholars; instant, reversible; never touches the source).
- **Data wrong / missing / "not mine"** → resolve via one of the three shapes below. **Hide is the wrong tool here** — it only masks display on Scholars while the error persists in leadership reports, the Faculty Review Tool, and the SOR. *"Not mine / shouldn't be listed" always corrects-at-source, never Hide.*

**The three shapes:**

| Shape | Meaning | Mechanism |
|---|---|---|
| **Self-service** | The scholar fixes it themselves in the owning tool. The dominant case. | A link + one-line instruction (Web Directory, Publication Manager / ReCiter). |
| **Route** | Email the owning office. | A prefilled `mailto:` (the item's label in the body). No deep-linking is available, so this is never an in-tool deep link. |
| **Explain** | Not an error, or not fixable here. | An in-place explanation (e.g. the NCE grace window; non-PubMed publications) — prevents junk tickets. |

**The routing.** Confirmed with the operator (`.planning/self-edit-item-feedback-taxonomy.md`):

| Attribute | Issue → resolution |
|---|---|
| **Name & Title** | name / email / email-visibility / ORCID → **self-service** (Web Directory; ORCID in ReCiter). title / department / division → **route** `support@med.cornell.edu` (derived from the primary appointment; explain that). degrees → **route** `facultyaffairs@med.cornell.edu` (ASMS). |
| **Photo** | wrong / outdated / missing / "don't show" → **self-service** (Web Directory “Publish to”). |
| **Appointments** | title / dates / missing / not-mine / chair-ended → **route** `support@med.cornell.edu` (ASMS / ED source data). |
| **Education** | wrong / missing / not-mine → **route** `facultyaffairs@med.cornell.edu` (ASMS). duplicate → **route** `support@med.cornell.edu` (import error). |
| **Funding** | wrong / missing / **not-mine (wrongly listed)** → **route** `osra-operations@med.cornell.edu` cc `scholars@weill.cornell.edu`. "Active but expired" → **explain** (NCE grace). |
| **Publications** | **not mine / missing** → **self-service** (reject / claim in Publication Manager — *never Hide*; the attribution otherwise persists in reports + the FRT). non-PubMed missing → **explain** (PubMed-only). metadata wrong / duplicate → **route** `support@med.cornell.edu`. |

**Where it appears.** A **read-only** attribute (Name & Title, Photo) shows *only* the picker — there is no in-app Hide (email/photo visibility is a Web Directory “Publish to” setting, not a Scholars suppression). An **editable** attribute (Appointments / Education / Funding / Publications) shows **both**: the per-row Hide/Show control *and* a per-row "Request a change" menu.

**Constraints + deferrals (operator).** No deep-linking to any system (every route is a static self-service URL + instructions, or a prefilled `mailto:`). No ServiceNow business service for Scholars yet — routing is by email, not tickets; the **tracked-queue graduation** (an in-app request/approval queue, [OQ 6](#open-questions)) waits on that service, at which point the three mailboxes map to assignment groups. The **email subject/body format** is deferred (a generic subject ships). No new write path or authorization surface either way.

---

## The shared per-entry row model

The **three new attributes** share one four-state model per entry. The publications attribute does **not** adopt it (see [§ Publications is deliberately not refactored](#publications-is-deliberately-not-refactored)), so this model is net-new client code. Computing it is the job of the [edit-context loader](#the-edit-context-extension); rendering it is the job of the panel.

| `state` | Meaning | Self surface control | Superuser surface control |
|---|---|---|---|
| `shown` | no active `suppression` row | **Hide** | **Hide** (reason **required**) |
| `hidden_by_self` | active row, `createdBy == ownerCwid` | **Show** (revoke own) | **Show** (revoke any) — labelled *"Hidden by the scholar"* |
| `hidden_by_admin` | active row, `createdBy != ownerCwid` (a superuser hid it) | **none** + *"Hidden by an administrator."* | **Show** (revoke any) |
| `locked` | appointment only: `isChairAppointment` is true | **none** + *"This is a department chair appointment and can't be hidden here."* | **none** + same text |

**Control-rendering rule** (one predicate, both surfaces): render the revoke/**Show** control iff `state === 'hidden_by_self'` **or** (`mode === 'superuser'` **and** `state === 'hidden_by_admin'`). Render **Hide** iff `state === 'shown'`. Render nothing actionable for `locked`. This is the same `(ownRow, adminRow)` logic the Visibility surface already applies, lifted to per-row granularity.

**Governance note — a superuser revoking a self-applied hide.** On the superuser surface, `hidden_by_self` rows *do* show a **Show** control, because `authorizeRevoke` permits a superuser to lift any suppression. Un-hiding a row the **scholar** hid overrides the scholar's own privacy choice, so the superuser surface must **attribute** the hide (*"Hidden by the scholar"*, not the bare *"Hidden"*) and gate the revoke behind a confirm — a superuser should never silently reverse a faculty member's deliberate hide. Called out in [§ Threat model](#authorization-and-threat-model) and [OQ 3](#open-questions).

### Publications is deliberately not refactored

The four-state model above is **not** retrofitted onto the existing *My publications* panel, because its state union is genuinely different — forcing them together is exactly where "light client change" would quietly become "a day":

| | New panels (`EditEntityState`) | Publications (today, unchanged) |
|---|---|---|
| States | `shown` / `hidden_by_self` / `hidden_by_admin` / `locked` | `shown` / `hidden_by_self` / `removed_by_admin` |
| Admin-state meaning | a superuser's whole-entity suppression — **revocable** from the superuser surface | a whole-**publication** takedown (`contributorCwid = NULL`) or derived-dark — **not** revocable from this list (the takedown lives on `/edit/publication/[pmid]`); the row renders "no effect here" |
| Extra per-row data | `locked` (chair) — nothing else | `isSoleDisplayedAuthor`, which gates the sole-author confirm — no analog in the new panels |

`hidden_by_admin` and `removed_by_admin` *look* alike but are different mechanisms with **opposite** revoke semantics. So: **the three new panels define `EditEntityState`; publications keeps its own union.** Any unification is an optional fast-follow ([OQ 1](#open-questions)) explicitly **off the launch critical path**. The shared `entity-hide-row` component (if built) serves the three new panels only.

---

## The three new attribute panels

Each is the detail-pane content for one attribute — a `'use client'` island under `components/edit/`, props `{ cwid, mode, <entities> }`, reusing the `publications-card.tsx` interaction logic. Common to all three:

- A panel heading (`<h2>`) and a one-line description.
- A header row: a live count — *"N appointments · M hidden"* (`aria-live="polite"`), **pluralized** (*"1 appointment"*, never *"1 appointments"*) — and, where the list can be long, a **filter `Input`** (`type="search"`).
- The entity list; rows carry the title/metadata and a trailing control per the [row model](#the-shared-per-entry-row-model). A hidden row is muted and carries a text `Badge` — never color alone.
- Optimistic hide/show; on a write error the row reverts and an inline `Alert variant="destructive"` renders within the row.
- An **Empty** state.

The lists are **flat ordered lists** — not year-grouped (unlike *My publications*), so no sticky group headers. Appointments and Education are short; Funding is filterable.

### Panel — Appointments

Heading **"Appointments"**. Description *"Hide an appointment to remove it from your public profile. Your department chair role can't be hidden here."*

- **List source:** the scholar's **active** appointments (the set the profile sidebar renders — `endDate IS NULL OR endDate >= today`), ordered **primary appointment(s) first, then by `startDate` descending** (primary pinned to the top regardless of date; date is the tiebreaker among non-primary). No filter; a scroll region only if the list exceeds ~8 rows.
- **Row:** `title` (maroon, semibold) · a **Primary** `Badge` when `isPrimary` · `organization` (muted) · the date range (`startDate`–`endDate`, or *"present"* when `endDate` is null).
- **`locked` row (chair appointment):** renders normally but with **no Hide control** and the inline line *"This is a department chair appointment and can't be hidden here."* The department leadership card is column-driven (`Department.chairCwid`), so it's never affected by suppression regardless — the lock keeps the profile sidebar from contradicting the leader card. The scholar's **other** appointments stay hideable.
- **Hide:** `entityType: "appointment"`, `entityId: <externalId>`. No confirm for a self-hide (sidebar-only, reversible, no search surface). Superuser hide → reason-required dialog.
- **Empty (zero rows on file):** *"You have no appointments on file."* — fires only at zero rows; a scholar who has **hidden** all their appointments still sees a populated panel with **Show** controls, so the copy is deliberately *"on file,"* never *"shown on your profile."*

### Panel — Education

Heading **"Education"**. Description *"Hide an education or training entry to remove it from your public profile."*

- **List source:** all of the scholar's education entries, most-recent year first; null-year entries sort last. No filter; education lists are short.
- **Row:** `degree` (maroon, semibold), optionally *", {field}"* · `institution` (muted) · `year` (or *"Year unknown"*).
- **Hide:** `entityType: "education"`, `entityId: <externalId>`. No self-confirm; superuser reason-required. Education has **no search surface** (PR-A) — hiding fully removes it on the next profile render, no nightly-rebuild lag.
- **Empty (zero rows on file):** *"You have no education or training entries on file."*

### Panel — Funding

Heading **"Funding"**. Description *"Hide a grant to remove yourself from it on this site. Each entry is your role on one award; hiding it doesn't affect the award's other investigators."*

- **List source:** all of the scholar's grant rows, most-recent `endDate` first, active before expired. **A filter `Input`** (*"Filter by title…"*) and a bounded scroll region — a productive PI can have dozens of awards.
- **Row:** `title` (maroon, semibold; clamp long titles to two lines) · a muted line: `funderLabel` (`primeSponsor`, falling back to the legacy `funder`), the `role` (e.g. *"PI"*, *"Co-I"*), the year range, and an **Active** / **Past** marker matching the profile.
- **Hide:** `entityType: "grant"`, `entityId: <externalId>`. **No `contributorCwid`** — a grant row already *is* the per-investigator unit (the backend rejects a contributor here, 400).
- **Latency the copy must set (in both directions):** a grant hide drops from the scholar's **own profile funding section immediately** (query-time filter) and from **funding search** on the **next nightly `search:index` rebuild** — the fast-path is deferred to #481. Hide success: *"Removed from your profile. It may take up to a day to clear from funding search."* The lag is **symmetric** — restore success: *"Restored to your profile. It may take up to a day to reappear in funding search."*
- **Sole-investigator case:** if this scholar is the only investigator on the award in our data, hiding their row takes the **whole award dark** on aggregate surfaces (dept/center funding lists — themselves deferred to #481). Whether that warrants a confirm is [OQ 2](#open-questions); the v1 recommendation is **no confirm**.
- **Empty (zero rows on file):** *"We don't have funding records for you."*

### Why mirror the profile's visible set

Each panel lists exactly the rows the **public profile** renders — not every row in the table. The profile shows **active appointments only**; a past appointment is already invisible to the public, so offering to "hide" it would be a no-op against the read-path's active filter and would only confuse. The same logic makes the edit list a faithful mirror. Education and grants render in full on the profile, so they list in full here. (Alternative — list *all* rows including past appointments — rejected; flagged as [OQ 4](#open-questions).)

---

## Role parity and the attribute rail

The same Apollo shell serves both actors; only **which attributes appear in the rail** and **whether the panel is editable** differ. `app/edit/page.tsx` (self, bound to `session.cwid`) and `app/edit/scholar/[cwid]/page.tsx` (superuser) both render the shell; the selected attribute comes from the `?attr=` query (defaulting per [§ Layout](#layout--the-apollo-style-master-detail-shell)). The full attribute matrix is in that section's table.

**The superuser surface gets the same entity attributes because the #160 use case is explicitly an admin one** — *"an appointment or education entry is stale or incorrect and we need to hide it ahead of the next ETL run."* Without these on `/edit/scholar/[cwid]`, a superuser's only route is a hand-crafted API call. The panels are the same components rendered in superuser mode with `reason` required (reusing the Visibility surface's required-text dialog).

**A related asymmetry, deliberately deferred ([OQ 1](#open-questions)):** v1 omitted a *My publications* attribute from the superuser rail, so a superuser can hide a target's *grants, education, and appointments* but not an individual *publication* (only a whole-publication takedown via `/edit/publication/[pmid]`). `authorizeSuppress` already permits a per-author hide for anyone, so the capability exists. But this is a **different gap from the one this SPEC closes**, and it carries *unworked* semantics: a superuser hiding a target's **sole displayed author** would derive the publication **dark site-wide**, needing its own confirm-with-reason design — an interaction none of the three entity panels have. Folding it in would import exactly the under-specified edge this SPEC otherwise avoids. **Out of scope here**, tracked separately.

---

## The admin roster & the Org unit admin role

Two additions distinct from the entity-suppression UI: a **roster** (a way to *find* a scholar) and a **third actor** (the org unit admin). The roster is low-lift and useful even for the existing superuser; the org unit admin is a new **authorization tier**.

### The Profiles roster (`/edit/scholars`)

The current design has **no way to find a scholar** — the superuser deep-links `/edit/scholar/[cwid]` by CWID. The roster is the missing entry point: an Apollo-style **Profiles** list (the chrome's "Profiles" tab).

- **Columns:** name (+ CWID), title, org unit (department / division), profile status (**Visible** / **Hidden**), and a per-row **Edit** → `/edit/scholar/[cwid]`.
- **Controls:** a name/CWID search; a status filter; and (superuser only) a unit filter.
- **Scope:** a **superuser sees all** scholars; an **org unit admin sees only scholars in their managed unit(s)** — enforced in the *query*, not just hidden in the UI.
- **Route:** a dedicated `/edit/scholars` — **not** `/edit`, which stays the *self* surface (an admin who is also a scholar still edits their own profile at `/edit`; an admin with no profile of their own reaches the roster at `/edit/scholars`). Superuser-or-org-unit-admin gated, server-rendered, uncached, `noindex` — same posture as the other `/edit/*` pages.

For the **superuser** this is purely additive — it rides the existing superuser gate, **no new authorization** — so it can ship as soon as B1 (data) clears.

### The Org unit admin — a new authorization tier

An **org unit admin** manages profiles within one or more **org units**. "Org unit" generalizes the system's existing structure — a **department** (`Scholar.deptCode`), a **division** (`divCode`), or a **center** (center membership) — so the same role covers a department administrator, a division coordinator, or a center manager.

**Scope rule (server-enforced).** A scholar is *in scope* for an org unit admin iff **any** of the scholar's org units (dept / division / center) is one the admin manages. The check runs on the **roster query** (the admin sees only in-scope scholars), **every per-scholar GET** (`/edit/scholar/[cwid]` deep-linked with an out-of-scope CWID → **403**, mirroring the superuser GET re-check), and **every write** (`/api/edit/*` re-derives scope; the UI is never the boundary).

**What an org unit admin may do** — the superuser's per-scholar powers, **scoped and minus the curatorial ones**:

| Power | Superuser | Org unit admin |
|---|---|---|
| Suppress / restore profile, publications, funding, appointments, education (reason required) | ✅ any scholar | ✅ **in-scope** scholars |
| Edit `overview` (bio) | ⛔ owner-only | ⛔ owner-only |
| Set / clear `slug` (Profile URL) | ✅ | ⛔ curatorial — superuser-only |
| Whole-publication takedown (`/edit/publication/[pmid]`) | ✅ | ⛔ site-wide, not unit-scoped — superuser-only |

So the org unit admin's `/edit/scholar/[cwid]` rail is the superuser rail **without Profile URL**, for in-scope targets only. Reason is required (acting on another's profile); B03 records the actor identically.

**What this tier requires (the new authz surface), tracked as [B3](#launch-dependencies-owned-elsewhere):**
- A **scope source** — *which units does this CWID manage?* — mirroring the superuser ED group (`ITS:Library:Scholars/superuser-role`): e.g. per-unit groups (`…/unit-admin/<unitId>`) or an attribute/mapping, **re-checked per request, never cached** (exactly as `isSuperuser` is).
- A **session extension** — `EditSession` gains `managedUnits: string[]` (empty for plain superuser/self).
- **Predicate changes** — `authorizeSuppress` / `authorizeRevoke` / `canAccessScholarEditPage` gain an *in-scope* branch (allow iff `isSuperuser` **or** target's units ∩ `managedUnits ≠ ∅`); slug + takedown stay superuser-only.

This **touches the authorization core, not just the client** — so it is a separate workstream. The entity panels and the roster ship without it (superuser-only); the org unit admin tier lands when B3 defines and wires the scope model.

> **Not Apollo's *Delegates*.** Apollo's "Delegates" tab is *owner-granted, per-profile* delegation (a scholar lets an assistant edit *their own* profile). The org unit admin is *institutionally-assigned and unit-scoped* — a different authorization model. This SPEC specs the org unit admin (what was asked for); per-profile delegation is a separate future option ([OQ 9](#open-questions)).

---

## The edit-context extension

`lib/api/edit-context.ts` is the single server read that backs the page. It returns `EditContext = { scholar, publications }` today; this SPEC adds three arrays. The loader already runs suppression-OFF and returns `null` for a missing/soft-deleted scholar — both behaviors inherited unchanged. (This is layout-independent — identical whether the surface is stacked cards or the Apollo rail.)

```ts
/** The three new panels' row state. Publications keeps its own distinct union
 *  (`removed_by_admin`, `isSoleDisplayedAuthor`, no `locked`) — see
 *  § Publications is deliberately not refactored. */
export type EditEntityState = "shown" | "hidden_by_self" | "hidden_by_admin" | "locked";

export type EditContextAppointment = {
  externalId: string;          // the suppress `entityId`
  title: string;
  organization: string;
  startDate: string | null;    // ISO date for display
  endDate: string | null;      // null = current
  isPrimary: boolean;
  state: EditEntityState;       // "locked" iff isChairAppointment
  suppressionId: string | null; // set iff state is hidden_by_self | hidden_by_admin
};

export type EditContextEducation = {
  externalId: string;
  degree: string;
  institution: string;
  field: string | null;
  year: number | null;
  state: Exclude<EditEntityState, "locked">;
  suppressionId: string | null;
};

export type EditContextGrant = {
  externalId: string;
  title: string;
  role: string;
  funderLabel: string;         // primeSponsor ?? funder (the funding-section label)
  startYear: number;
  endYear: number;
  isActive: boolean;
  state: Exclude<EditEntityState, "locked">;
  suppressionId: string | null;
};

export type EditContext = {
  scholar: EditContextScholar;
  publications: ReadonlyArray<EditContextPublication>;
  appointments: ReadonlyArray<EditContextAppointment>;
  educations: ReadonlyArray<EditContextEducation>;
  grants: ReadonlyArray<EditContextGrant>;
};
```

**Loader additions (the queries):**

1. **Entities.** Load the scholar's appointments (active filter — `endDate IS NULL OR endDate >= today`, mirroring the profile), all educations, all grants, each selecting `externalId` plus its display fields.
2. **One suppression query.** `suppression.findMany({ where: { entityType: { in: ["appointment","education","grant"] }, entityId: { in: [...allExternalIds] }, contributorCwid: null, revokedAt: null }, select: { id, entityType, entityId, createdBy } })`. Bucket by `(entityType, entityId)`: no row → `shown`; `createdBy === cwid` → `hidden_by_self` (carry `id` as `suppressionId`); `createdBy !== cwid` → `hidden_by_admin`.
3. **Chair lock (appointments only).** Set `state = "locked"` for an appointment conferring a *current* chair role. The predicate is **title-specific** — `isChairTitleFor(title, chairedDeptName)` — so it must stay keyed on the **individual appointment's title**, not "is this person a chair anywhere": a chair of department X who *also* holds a non-chair appointment elsewhere must have **only the chair appointment** locked. Safe batching: one `Department.findMany({ where: { chairCwid: cwid }, select: { name: true } })` for the page (0–1 rows), then `isChairTitleFor(appt.title, dept.name)` **per appointment** — **not** a bare `chairCwid = cwid` existence check, which would over-lock every appointment the chair holds.

**No speculative fields.** Every field above is rendered by a panel or is the `externalId`/`suppressionId` a write needs; `isSoleInvestigator` is intentionally **absent** unless [OQ 2](#open-questions) resolves to "confirm." The read-only SOR attributes need **no** edit-context change — they read the scholar's existing directory fields already on the page payload, plus the static "Request a Change" link target.

---

## Authorization and threat model

The predicate is `self-edit-spec.md`'s and is **already enforced server-side**; the panels never gate themselves on anything but display. The Apollo layout changes no authorization (the `?attr=` selection is a view concern; every write still hits the same predicate). What the new surface changes:

**In scope (newly reachable from the UI):**

- **A scholar hides their own appointment / education / grant.** Authorized by `ownerCwid == session.cwid`. Same trust level as hiding a publication. Reversible. Reason defaulted.
- **A superuser hides any scholar's appointment / education / grant.** Authorized by `isSuperuser`, re-checked on every GET page load and every POST (never cached). Reason **required**. The GET-time re-check matters because `/edit/scholar/[cwid]` reads suppression-OFF and now exposes one more class of (otherwise-suppressed) entity data; the shipped re-check already covers it.
- **A superuser revokes a scholar's self-applied hide.** Permitted by `authorizeRevoke`. The only *override of a scholar's own choice* the surface enables; mitigated by attributing the hide and confirming the revoke (OQ 3). Out-of-scope to *prevent* — an admin reversing a mistaken/coerced hide is legitimate; the control is auditability.
- **An org unit admin acts on an in-scope scholar.** Allowed iff the target's org units (dept / division / center) intersect the admin's `managedUnits` — re-derived **server-side** on the roster query, the per-scholar GET (out-of-scope CWID → 403, mirroring the superuser GET re-check), and every POST. The UI is never the boundary. Same powers as a superuser **scoped** to their unit(s), **minus** Slug and whole-publication takedown (both superuser-only). See [§ The Org unit admin](#the-admin-roster--the-org-unit-admin-role).

**Explicitly out of scope (and why it's safe):**

- **Stored XSS.** Unlike `overview`, these entities carry **no user-authored HTML** — the panel writes only a `suppression` row keyed on a server-resolved `externalId`; displayed strings are ETL-sourced and rendered as text. The read-only SOR panel renders directory text and a static link — no new sanitize surface.
- **Forging another scholar's `externalId`.** The write resolves the owner from the `externalId` server-side and authorizes against it; a scholar POSTing someone else's id fails authz (403) or the existence gate (400). The client only submits ids from the scholar's own context, but the server doesn't trust that.
- **Hiding a chair role to disappear from leadership.** Refused at the route (409, before authz), so it holds for the chair *and* a superuser. The leadership card is column-driven and unaffected. The UI `locked` state is a courtesy, not the boundary.
- **CSRF.** Covered by the shipped `verifyRequestOrigin` (same-origin + `application/json`) on every `/api/edit/*` POST; the new panels add no new endpoint. The "Request a Change" link is a `GET`/`mailto:` to an external channel — no SPS write.

---

## Suppression and confirmation dialogs

The existing rule stands: **an action confirms iff it removes something from public view by default; every revoke/restore does not.** Additions to the v1 dialog table:

| Trigger | Title | Body | `reason` | Confirm |
|---|---|---|---|---|
| Self — hide appointment / education / grant | *(no dialog)* | — | defaulted server-side | optimistic, the **Show** button is the undo |
| Superuser — hide an appointment / education / grant | "Hide this {entry}?" | "This removes it from **{Name}**'s public profile." (grant adds: " It may take up to a day to clear from funding search.") | **required** free-text `Textarea` | `variant="destructive"` "Hide" |
| Superuser — restore a scholar's **self-applied** hide | "Show this {entry} again?" | "**{Name}** hid this themselves. Showing it again will override their choice." | none | `variant="default"` "Show it" |
| Self / superuser — restore an admin-applied or own hide | *(no dialog)* | — | — | the **Show** button |

The grant's success copy carries the funding-search-latency line; education and appointment hides have no search surface and need no such caveat.

---

## States and edge cases (what the user sees)

Extends `self-edit-ui-spec.md` § States; write-path edge cases are `self-edit-spec.md`'s.

| # | Scenario | What the user sees |
|---|---|---|
| E1 | Scholar hides an appointment | Row mutes, **Hidden** badge, **Show** appears; the profile sidebar drops it on next render. |
| E2 | Scholar hides their **chair** appointment | No Hide control — the row shows *"This is a department chair appointment and can't be hidden here."* A crafted API call gets 409. |
| E3 | Scholar hides a grant | Row mutes; success: *"Removed from your profile. It may take up to a day to clear from funding search."* |
| E4 | Scholar hides a degree they don't recognize | Row mutes, **Show** appears; the Education sidebar drops it immediately (no search surface). |
| E5 | Superuser opens `/edit/scholar/[cwid]` | Same rail + panels, acting on the target; admin banner; every Hide opens a required-reason dialog. |
| E6 | Superuser hides an entry with no reason | Confirm disabled until the `Textarea` is non-empty (server 400 `reason_required` backstop). |
| E7 | Entry hidden by an administrator; scholar views own `/edit` | Row shows **Hidden by an administrator** with no Show control. |
| E8 | Superuser views an entry the **scholar** hid | Row shows **Hidden by the scholar** + a **Show**; clicking opens the "override their choice" confirm (OQ 3). |
| E9 | Funding with dozens of awards | Filter input + bounded scroll, identical to My publications. |
| E10 | A panel's list is empty | The panel's empty-state line; the attribute still appears in the rail (so the scholar knows the section exists). |
| E11 | Write fails (5xx / network) | Optimistic flip reverts; inline `destructive` Alert within the row; the control re-enables. |
| E12 | Scholar selects a **read-only** attribute (Name & Title) | Values shown read-only under *"This section is not editable,"* with **Request a Change** opening the *What needs to change?* picker that routes by issue type (e.g. degrees → Faculty Affairs, email → Enterprise Directory). |
| E13 | Scholar deep-links `/edit?attr=funding` | The shell loads with Funding pre-selected in the rail (server-rendered from `?attr=`). An unknown `attr` falls back to the default. |
| E14 | Scholar's grant has a **wrong title** | The Funding panel offers both **Hide** and **Request a Change**. The picker's *"grant details wrong"* → email OSRA; the copy steers them there — *hiding* would remove a real award from the profile, not fix it. (The Hide/Request-a-Change distinction, made concrete.) |

---

## Accessibility

Inherits `self-edit-ui-spec.md` § Accessibility. The points that bind the new surface:

- **The ATTRIBUTES rail is a `<nav>` landmark** of links; the active attribute carries `aria-current="page"`; it is Tab/arrow operable with a visible focus ring. A locked (read-only) attribute is a normal link to its read-only panel — **not** a disabled control.
- **The chair `locked` state carries its explanation in visible text, never a disabled button** — a disabled `<button>` is not focusable, so a keyboard / screen-reader user could not reach a tooltip. Same as the publications "Removed by an administrator" row.
- **No color-only signalling** — a hidden row carries a text `Badge` (**Hidden** / **Hidden by an administrator** / **Hidden by the scholar**), not just dimming; the **Active** / **Past** marker is text. The maroon active-rail state also carries the chevron + `aria-current`, not color alone.
- **Contrast** — the maroon (`~#7d1c1c`) on white and white-on-maroon (active rail, buttons) must meet WCAG AA; verify against the real Apollo token at build.
- **Counts and filter results are `aria-live="polite"`**; each filter `Input` has an `aria-label`. Foreign-script content uses script-neutral prose styling.

---

## Copy (additions)

| Where | String |
|---|---|
| Appointments panel | "Appointments" / "Hide an appointment to remove it from your public profile. Your department chair role can't be hidden here." |
| Appointment — chair lock | "This is a department chair appointment and can't be hidden here." |
| Appointments empty | "You have no appointments on file." |
| Education panel | "Education" / "Hide an education or training entry to remove it from your public profile." |
| Education empty | "You have no education or training entries on file." |
| Funding panel | "Funding" / "Hide a grant to remove yourself from it on this site. Each entry is your role on one award; hiding it doesn't affect the award's other investigators." |
| Funding — hide success | "Removed from your profile. It may take up to a day to clear from funding search." |
| Funding — restore success | "Restored to your profile. It may take up to a day to reappear in funding search." |
| Funding empty | "We don't have funding records for you." |
| Hidden by admin (any panel) | "Hidden by an administrator." |
| Hidden by scholar (superuser view) | "Hidden by the scholar." |
| Superuser revoke-self-hide confirm | "{Name} hid this themselves. Showing it again will override their choice." |
| Per-row hide/show errors | "We couldn't hide this entry. Please try again." / "We couldn't restore this entry. Please try again." |
| Read-only (SOR) header | "This section is not editable." |
| Request a Change — action | "Request a Change" |
| Request a Change — picker | "What needs to change?" |
| Read-only explanation | "Name, title, department, email, and photo come from the WCM directory. To correct one, use Request a Change — it routes to the team that owns it rather than overriding it here." |
| Funding — Request a Change | "A grant's title, sponsor, dates, or role is wrong, or a grant is missing → email OSRA. (To remove yourself from a grant you're correctly listed on, use Hide instead.)" |
| Publications — Request a Change | "A publication is missing → request it from the publications team (it's added in ReCiter). (A publication that isn't yours → use Hide.)" |
| Education / Appointments — Request a Change | "This entry is wrong or missing → {Registrar (education) / department admin (appointments)}. (To hide a stale entry, use Hide.)" |
| Detail-panel header | "{Attribute} for {Name}" · "Preview Profile" |
| Superuser admin banner | "You are editing {Name}'s profile as an administrator. A reason is required for every change." |

---

## Audit queries

Runnable SQL for verifying the surface, **written for Aurora MySQL** — the cluster's engine (`datasource db { provider = "mysql" }`). The **`grant` table is a MySQL reserved word**, so it is backtick-quoted (`` `grant` ``; a Postgres client would need `"grant"` instead). These are *raw-client* queries — the Prisma path sidesteps the quoting via the mapped model name, so the dialect only bites a wrong-client paste. The `entity_type` values are the lowercase enum strings the suppress route writes; B03 audit rows live in the audit schema on the same cluster.

```sql
-- 1. Every active whole-entity suppression, with who applied it (self vs admin).
SELECT s.entity_type, s.entity_id, s.created_by,
       CASE WHEN s.created_by = own.cwid THEN 'self' ELSE 'admin' END AS applied_by,
       s.reason, s.created_at
FROM suppression s
LEFT JOIN appointment a ON s.entity_type = 'appointment' AND a.external_id = s.entity_id
LEFT JOIN education   e ON s.entity_type = 'education'   AND e.external_id = s.entity_id
LEFT JOIN `grant`     g ON s.entity_type = 'grant'       AND g.external_id = s.entity_id
JOIN scholar own ON own.cwid = COALESCE(a.cwid, e.cwid, g.cwid)
WHERE s.entity_type IN ('appointment','education','grant')
  AND s.contributor_cwid IS NULL
  AND s.revoked_at IS NULL
ORDER BY s.created_at DESC;

-- 2. CANDIDATE SET (not an invariant): active suppressions on an appointment
--    held by someone who chairs *something*. A non-empty result is NOT proof of
--    a bug — this join can't distinguish a chair appointment from the chair's
--    *other* appointments, because the title-matches-chair-phrase test is
--    application-side (isChairTitleFor). A real 409-guard violation is a row
--    here whose `title` matches `d.name`'s chair phrase; confirm each by hand.
SELECT s.entity_id, a.cwid, a.title, d.name AS chairs_department
FROM suppression s
JOIN appointment a ON a.external_id = s.entity_id
JOIN department d  ON d.chair_cwid = a.cwid
WHERE s.entity_type = 'appointment'
  AND s.revoked_at IS NULL;

-- 3. Orphaned suppressions: an active row whose target externalId no longer
--    exists (ETL deleted the entity). Harmless (filters nothing) but worth a sweep.
SELECT s.entity_type, s.entity_id, s.created_at
FROM suppression s
WHERE s.entity_type IN ('appointment','education','grant')
  AND s.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM appointment a WHERE s.entity_type='appointment' AND a.external_id=s.entity_id
    UNION ALL SELECT 1 FROM education e WHERE s.entity_type='education' AND e.external_id=s.entity_id
    UNION ALL SELECT 1 FROM `grant` g   WHERE s.entity_type='grant'     AND g.external_id=s.entity_id
  );

-- 4. Audit completeness: every suppress write should have a matching B03 row.
--    (cross-schema join; confirm the audit row count tracks suppression inserts.)
```

---

## Launch dependencies (owned elsewhere)

"Before launch" is more than this panel work. These gate the self-edit view going live and are **surfaced here, owned elsewhere** — fix in their issues. Two are hard blockers:

| # | Item | Owner | Blocks | Status |
|---|---|---|---|---|
| **B1** | **`/edit` 404s in prod — Scholar data not populated.** The whole feature is unreachable until prod has profile data. | [#474](https://github.com/wcmc-its/Scholars-Profile-System/issues/474) | the entire `/edit` surface (self **and** superuser) in prod | **hard blocker** |
| **B2** | **B02 superuser tier dormant in prod** — `SUPERUSER_GROUP_CN` + LDAP/ED config not wired, so `isSuperuser` is always false in prod. | [#473](https://github.com/wcmc-its/Scholars-Profile-System/issues/473) | the **superuser** rail/panels + roster — the self surface is unaffected | **hard blocker for the superuser role** |
| **B3** | **Org unit admin tier is unspecified + unbuilt** — the scope source (which units a CWID manages), `session.managedUnits`, and the in-scope branch in the authz predicate. A **new authorization tier**, larger than the entity UI; touches the authz core. | this SPEC / B-series | the **org unit admin** role only (scoped roster + scoped edit) — superuser + self unaffected | **new — needs design + build** |
| D1 | **Grant funding-search fast-path + dept/division/center fan-out** — a hidden grant clears funding search only on the nightly rebuild; aggregate dark-project surfaces don't yet exist. The Funding panel's copy absorbs the latency. | [#481](https://github.com/wcmc-its/Scholars-Profile-System/issues/481) | grant-hide search latency; the sole-investigator confirm (OQ 2) | deferred, copy-mitigated |
| D2 | **Suppression search-index reconciler** (failure-model layer 3) — durability if a fast-path delete fails. | [#393](https://github.com/wcmc-its/Scholars-Profile-System/issues/393) | durability of any suppression in search | open follow-on |
| D3 | **CloudFront edge invalidation for suppression** — `revalidatePath` alone leaves the edge serving a hidden entity for ≤ 24h. | [#353](https://github.com/wcmc-its/Scholars-Profile-System/issues/353) | edge freshness of any suppression | open follow-on |
| D4 | **Slug freezing at launch** + the broader slug policy. | [#29](https://github.com/wcmc-its/Scholars-Profile-System/issues/29) | the superuser Profile-URL attribute's launch posture | open |
| D5 | **Apollo design tokens** — confirm the real maroon, the top-bar tab set, and the sub-nav labels (the mockup's values are estimates). | this SPEC / design | pixel fidelity to Apollo; not function | open |
| D6 | **"Request a Change" routing destinations — SUPPLIED.** Self-service tools (Web Directory; Publication Manager / ReCiter for publications + ORCID) + three office mailboxes (`support@med.cornell.edu` catch-all, `facultyaffairs@med.cornell.edu` for degrees/education, `osra-operations@med.cornell.edu` cc `scholars@weill.cornell.edu` for funding), encoded in `lib/edit/request-a-change.ts`. (There is no "WOOFA"; ASMS-sourced data is owned by Faculty Affairs.) The email **subject/body format** remains deferred. | operator | the Request-a-Change links resolving to the right office | **resolved** (subject format deferred) |
| C1 | **#356 carryovers** — real HTTP-403 status on the 403 page; dynamic-import `OverviewEditor`; the staging SAML walkthrough; `scripts/sql/audit-log.sql` ALTER for existing deploys. | #356 follow-ups | polish / parity | open |

**Phasing — three tiers, by construction.** This SPEC's client work (shell + panels + edit-context + roster UI) has **no dependency on D1–D4 or C1**. Production gating splits along the role boundary:

- **Self** (`/edit`) needs only **B1** (#474): profile data in prod. Goes live first, with B2/B3 dormant.
- **Superuser** (`/edit/scholar/[cwid]` + the `/edit/scholars` roster) additionally needs **B2** (#473). The roster and superuser panels add **no new authorization** — they ride the existing superuser gate — so they follow immediately once B2 is wired.
- **Org unit admin** (scoped roster + scoped edit) needs **B3** — a new authorization tier (scope source + `managedUnits` + the in-scope predicate branch). This is a **separate, later workstream**; it touches the authz core, not just the client.

So: **self at B1 → superuser + roster at B2 → org unit admin at B3.** The first two are the entity-suppression launch; the org unit admin is a deliberate follow-on.

---

## Open questions

1. **Superuser *My publications* attribute — split to its own follow-up.** Per-author publication management on `/edit/scholar/[cwid]` closes a *different* asymmetry, with unworked semantics (sole-displayed-author → site-wide dark, needing its own confirm-with-reason). **Recommendation: track separately, not in this SPEC.** It's also where "does publications adopt the shared `EditEntityState`" lives — likely still *no* (`removed_by_admin` ≠ `hidden_by_admin`).
2. **Grant sole-investigator confirm.** Should hiding the sole investigator's row (award goes dark on aggregate surfaces) open a confirm? **Recommendation: no confirm in v1** — at launch the only live effect is the scholar's own funding section (reversible); the dark-project aggregate surfaces are #481 and don't exist yet.
3. **Superuser revoking a scholar's self-applied hide.** Confirmed via the "override their choice" dialog. Sub-question: disallow it in the UI instead? **Recommendation: allow with confirm + attribution** — reversing a mistaken/coerced hide is legitimate, and B03 audits it.
4. **List the profile's visible set vs. all rows.** Panels mirror the profile (active appointments only). **Recommendation: keep mirroring.**
5. **Attribute rail vs. one-page scroll.** The Apollo master-detail shows one attribute at a time behind the rail, unlike the v1 all-on-one-page stack. **Recommendation: adopt the rail** — it matches Apollo, scales, and is deep-linkable; the only cost is a click to reach an attribute, mitigated by a sensible default. (The reversed v1 ratified decision.)
6. **"Request a Change" depth. — DECIDED (Level 3).** A **per-row, per-item** triage with three resolution shapes (self-service / route / explain), routing-only now ([§ Item-level feedback](#item-level-feedback--request-a-change-the-three-shape-model)). Destinations are confirmed (self-service tools + three office mailboxes); the report shape is chosen so a **tracked queue** can graduate later. That graduation is deferred pending a Scholars **ServiceNow business service** (none exists yet); until then, routing is by email, not tickets. The email subject/body format is also deferred.
7. **Apollo chrome specifics.** Does the Scholars editor show a *WCM Profile / NYP Profile* sub-nav (Apollo does; Scholars is WCM-only), and what are the real top-bar tabs/labels? **Recommendation: confirm with the Apollo team / screenshots (D5)**; the mockup's chrome is illustrative.
8. **Org-unit scope granularity.** Is an org unit admin scoped at department, division, or center level — and how are multi-unit scholars handled? **Recommendation:** scope at the *scholar* level (in-scope iff *any* of the scholar's units ∈ `managedUnits`), with one `managedUnits` set spanning all three unit kinds keyed by unit id. Confirm the unit-id scheme (`deptCode` / `divCode` / centerId) and whether a department admin is implicitly scoped to its divisions. (B3.)
9. **Per-profile delegates (Apollo "Delegates").** Should a scholar grant a named assistant edit access to their *own* profile (owner-granted, per-profile), alongside the institutional org unit admin? **Recommendation: future option, not v1** — a different authz model (a `(ownerCwid, delegateCwid)` delegation table), tracked separately.

---

## Implementation

`self-edit-spec.md` § Implementation and `self-edit-ui-spec.md` § Implementation list the routes, write-path, and existing components. This SPEC's additions:

| Path | Change |
|---|---|
| `lib/api/edit-context.ts` | *Extend* — add the `appointments` / `educations` / `grants` arrays, the entity + suppression queries, the chair-lock computation, and the shared `EditEntityState`. (Layout-independent.) |
| `components/edit/edit-shell.tsx` | *New* — the Apollo master-detail shell: black top bar (chrome), the ATTRIBUTES rail, the detail-panel slot. Replaces the v1 single-column card stack in `edit-page.tsx`. |
| `components/edit/attribute-rail.tsx` | *New* — the `<nav>` rail of attribute links (active state, locked/read-only items, `aria-current`). |
| `components/edit/readonly-attribute-panel.tsx` | *New* — the SOR read-only panel ("This section is not editable" + "Request a Change" link). No write path. |
| `components/edit/appointments-card.tsx` · `education-card.tsx` · `funding-card.tsx` | *New* — the three editable panels (chair lock; filter+scroll+latency on Funding). |
| `components/edit/entity-hide-row.tsx` | *New (optional)* — a shared row for the three new panels, parameterized by `EditEntityState`. Not shared with publications. |
| `components/edit/edit-page.tsx` | *Modify* — becomes the per-`?attr=` detail router inside `edit-shell`; selects the panel for the active attribute, self vs superuser. |
| `components/edit/publications-card.tsx` | **Unchanged for this SPEC** — rendered as the "Publications" attribute panel as-is. Shared-vocabulary adoption is an optional fast-follow ([OQ 1](#open-questions)). |
| `components/edit/confirm-dialog.tsx`, `overview-editor.tsx`, `visibility-card.tsx`, `slug-card.tsx` | *Reuse* — rendered as their respective attribute panels; the dialogs (reason-required, override-self-hide) are unchanged. |
| `app/globals.css` | *Add* — the Apollo chrome tokens (maroon, top-bar/rail styles). Confirm the real values (D5). |
| `app/edit/scholars/page.tsx` | *New* — the **Profiles roster** (superuser + org unit admin); server-rendered, **scope-filtered query**, search/filter, Edit links. Superuser-gated needs no new authz; the org-unit-admin scoping is B3. |
| `components/edit/profiles-roster.tsx` | *New* — the roster table (Apollo style: name / title / unit / status + Edit). |
| `lib/auth/superuser.ts` *(or sibling)* | *Extend (B3)* — resolve `managedUnits` for the session, re-checked per request like `isSuperuser`. |
| `lib/edit/authz.ts` | *Extend (B3)* — the in-scope branch in `authorizeSuppress` / `authorizeRevoke` / `canAccessScholarEditPage`; Slug + takedown stay superuser-only. |
| `app/edit/scholar/[cwid]/page.tsx` | *Modify (B3)* — GET-time scope check for an org unit admin (out-of-scope CWID → 403). |
| `lib/edit/validators.ts` | *Reuse* — `isChairAppointment` for the lock; ideally a batched form for the page. |
| `__tests__` / vitest | *New* — panel render + optimistic-flip + revert-on-error tests; an edit-context test asserting state computation (self/admin/locked) + the active-appointment filter; a rail test (active/`aria-current`, `?attr=` selection, locked items). Run the full suite before push. |

**No new dependencies, no new endpoint, no migration.** The bigger delta vs. the stacked-cards plan is the **shell** (top bar + rail + `?attr=` routing); the panels and edit-context are as previously scoped.

---

## References

- [self-edit-spec.md](./self-edit-spec.md) — the v1 feature SPEC; co-revised here (§ Scope, § Surfaces, § Authorization) for the now-landed entity types.
- [self-edit-ui-spec.md](./self-edit-ui-spec.md) — the v1 UI-SPEC; co-revised here (the stacked-cards layout → Apollo master-detail). The Tiptap editor, dialog rules, row model, accessibility, and copy conventions carry over.
- **Apollo Management Console** — the WCM clinical profile editor whose design language `/edit` adopts. *Real but not accessible/extensible to this project; reference only.* Design tokens/chrome to be confirmed at build (D5). Build-time mockup: `sps-edit-apollo.html`.
- [ADR-005](./ADR-005-manual-override-layer.md) — the `field_override` / `suppression` mechanism, the read-merge, `externalId` keying.
- [b03-audit-log.md](./b03-audit-log.md) — the audit row the suppress transaction already emits for every entity type.
- Shipped code: `app/api/edit/suppress/route.ts`, `lib/edit/validators.ts`, `lib/edit/authz.ts`, `lib/api/edit-context.ts`, `components/edit/publications-card.tsx`, `components/edit/edit-page.tsx`.
- Issues: [#160](https://github.com/wcmc-its/Scholars-Profile-System/issues/160) (umbrella; this closes its UI follow-up), [#480](https://github.com/wcmc-its/Scholars-Profile-System/pull/480) / [#482](https://github.com/wcmc-its/Scholars-Profile-System/pull/482) (backend PRs), [#481](https://github.com/wcmc-its/Scholars-Profile-System/issues/481) (grant read-path follow-ons), [#473](https://github.com/wcmc-its/Scholars-Profile-System/issues/473) / [#474](https://github.com/wcmc-its/Scholars-Profile-System/issues/474) (prod blockers), [#393](https://github.com/wcmc-its/Scholars-Profile-System/issues/393) / [#353](https://github.com/wcmc-its/Scholars-Profile-System/issues/353) (durability follow-ons), [#356](https://github.com/wcmc-its/Scholars-Profile-System/issues/356) / [#355](https://github.com/wcmc-its/Scholars-Profile-System/issues/355) (v1 build + UI-SPEC).
