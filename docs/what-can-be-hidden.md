# What can be hidden

**Purpose.** The single catalog of everything that can be removed from a public
Scholars profile (and from search). Reach for this when someone asks *"Can a scholar
hide their grants?"*, *"Why did this publication disappear?"*, *"Can a department admin
take down a paper?"*, or *"Can a scholar hide a research method?"* — and when you need to
know **what mechanism** did it, **who is allowed** to do it, and whether it is **live or
dormant**.

This is the *operational* catalog. The *design* behind it — the manual-override layer, the
keying rules, the failure model — is [`ADR-005`](./ADR-005-manual-override-layer.md). Who
is authorized to perform each action is in [`access-control-rbac.md`](./access-control-rbac.md).
The audit trail every action writes is in [`b03-audit-log.md`](./b03-audit-log.md).

---

## TL;DR

- **There is no "hide this whole section" toggle.** A section disappears from a profile
  only when *every record in it* is hidden, or when the underlying data is empty. The one
  thing you can hide wholesale is the **entire profile** (and the **bio**, by clearing it).
- **Hiding is record-level.** You hide a publication, a grant, an education entry, an
  appointment, a mentee — one record at a time.
- **Three mechanisms** do all the hiding: **suppression** (revocable, per-record),
  **field override** (the bio, where an empty value = "show nothing"), and the two
  **Methods-lens overlays** (editorial, not per-scholar). Plus a fourth, distinct path:
  **soft-delete** (departure, not a hiding choice).
- **Methods & tools are new and hide differently** — see [§ Methods & tools](#methods--tools-new).
  A scholar *cannot* hide an individual method in `/edit`; method families are hidden
  **globally/editorially** through curated overlays, not per person.

---

## The two granularities

| | Can the **whole section** be hidden? | Can **individual records** be hidden? |
|---|---|---|
| **Overview / bio** | Yes — clear it (empty `field_override`) | n/a (single field) |
| **Publications** | Only by hiding every authorship | Yes — per author, or whole-pub takedown |
| **Funding / grants** | Only by hiding every investigator role | Yes — per grant row |
| **Education** | Only by hiding every entry | Yes |
| **Appointments** | Only by hiding every entry (except leadership) | Yes (leadership appointments are **not** hideable) |
| **Mentees** | Only by hiding every relationship | Yes — per relationship |
| **Methods & tools** | n/a (no per-scholar control) | **Editorial only** — a family is hidden for everyone, or public-gated |
| **Topics / concepts** | No direct control | No — *inherited* from publication visibility |
| **Co-authors** | No direct control | No — *derived* from non-hidden publications |
| **Disclosures (COI)** | No | No — read-only mirror of Weill Research Gateway |
| **Whole profile** | **Yes** — suppress it, or it soft-deletes on departure | — |

The recurring pattern: **sections empty out, they don't toggle.** Topics, co-authors, and
the methods lens are all *derived* — hide the publications behind them and they shrink or
vanish on their own.

---

## The four mechanisms

| Mechanism | Table / column | What it hides | Revocable? | Who triggers it |
|---|---|---|---|---|
| **Suppression** | `suppression` (row with `revoked_at IS NULL`) | One record, or one contributor on a record, or the whole scholar | Yes (set `revoked_at`) | Self / superuser / unit admin / proxy via `/edit` |
| **Field override (bio)** | `field_override`, `field_name='overview'`, empty `value` | The Overview/bio text | Yes (delete/replace the override) | Self / superuser via `/edit` |
| **Methods-lens overlays** | `family_suppression_overlay`, `family_sensitivity_overlay` | A method **family**, by `(supercategory, family_label)` | Yes (remove the overlay row) | Editorial — loaded by ETL, no `/edit` control |
| **Soft-delete** | `scholar.deleted_at` (not null) | The whole scholar (departure) | Within the 60-day window, before purge | ETL / departure process — *not a hiding choice* |

All of these are **query-time** — read on every request, never baked into the ETL output
(ADR-005 immediacy rule). Suppress something and it's gone on the next page load (plus a
search-index reflection — see [§ Search reflection](#search-reflection--audit)).

---

## Suppression — the main hiding tool

One table, `suppression`, hides almost everything. A target is hidden **iff** a matching
row exists with `revoked_at IS NULL`. The row is never deleted on un-hide; it is *revoked*
(re-suppressing later is legitimate), and there is **no foreign key**, so a row can outlive
a hard-deleted target. Key columns:

- `entity_type` — one of the `EntityType` enum values:
  `scholar` · `publication` · `grant` · `education` · `appointment` · `mentee` ·
  `department` · `division` · `center`
- `entity_id` — the **stable** identifier for that type (CWID, PMID, `external_id`, unit
  `code`, or the `"{mentorCwid}:{menteeCwid}"` composite). See ADR-005 § Keying.
- `contributor_cwid` — `NULL` = hide the **whole entity**; a CWID = hide **one
  contributor** on the record. *Only publications use the per-contributor form.*
- `reason` — required; defaulted for self-actions, mandatory text for superuser takedowns.
- `created_by` / `revoked_by` — the real human actor (never the impersonated identity).
- `search_reflected_at` — reconciler sentinel for scholar/publication only (#393).

### What each `entity_type` hides

- **`scholar`** — the **entire profile**. Removed from public view and de-indexed from
  search. Two independent rows can exist: a **self-suppression** (actor = the scholar) and
  an **admin-suppression** (actor = a superuser); the profile is hidden if *either* is
  active. Denormalized to `scholar.status = 'suppressed'`. Self-serve via the
  *Visibility* card in `/edit` (`components/edit/visibility-card.tsx`); routes
  `POST /api/edit/suppress` and `POST /api/edit/revoke`.
- **`publication`** — two distinct shapes:
  - **Per-author hide** (`contributor_cwid` = the scholar): *"This paper is mine, but hide
    my authorship."* The scholar drops off the author list; the paper stays on the site for
    its other WCM authors.
  - **Whole-publication takedown** (`contributor_cwid` = `NULL`): *"Remove this paper
    entirely"* — for retractions/compliance. Superuser-only; reason mandatory. UI:
    `components/edit/publication-takedown-card.tsx`.
- **`grant`** — hides one investigator's role on one award (`entity_id` = the grant's
  `external_id`; grant rows are already per-investigator). The funding *project* goes dark
  only when **all** its investigator roles are hidden (derived-dark, below).
- **`education`** — hides one education entry (`entity_id` = `external_id`).
- **`appointment`** — hides one appointment entry. **Guard:** leadership appointments
  (chair / chief / director) are **not** suppressible — the route returns
  `409 leadership_appointment_not_suppressible`.
- **`mentee`** — the **mentor** hides one mentor↔mentee relationship from their own
  profile (`entity_id` = `"{mentorCwid}:{menteeCwid}"`; the mentor owns it).
- **`department` / `division` / `center`** — superuser **retirement** of an org unit
  (unit-curation, ADR-005 Amendment 1 / #540), keyed on the unit `code`.

### Derived-dark

There is no separate "this publication is hidden" flag. A publication reads as **dark**
when a whole-pub takedown exists **or** every confirmed WCM author has a per-author hide —
i.e. no displayable author remains (`isPublicationDark`, `lib/api/manual-layer.ts`). The
same logic applies to grants (all investigator roles hidden → the funding project goes
dark). This is why hiding the last visible author silently removes the whole record.

---

## The bio (Overview)

The bio is not suppressed — it is **overridden**. A `field_override` row with
`field_name='overview'` takes precedence over the ETL-managed `scholar.overview`. An
**empty `value` is meaningful**: it means *"deliberately show no bio,"* not *"no override
set."* Authored/cleared via the Overview editor in `/edit`; sanitized on both write and
read. (`getEffectiveOverview`, `lib/api/manual-layer.ts`.)

---

## Methods & tools (new)

The **Methods lens** surfaces, on a profile, the method families a scholar's publications
draw on (e.g. *CRISPR gene editing*, *live animal models*), grouped under supercategories.
The taxonomy itself is a ReciterAI S3 artifact — see
[`scholar-tools-taxonomy.md`](./scholar-tools-taxonomy.md).

**Hiding here works differently from every other section.** A scholar **cannot** hide an
individual method or family from `/edit` — there is no `tool`/`family` entity type in
`suppression`. Method families are hidden **editorially and globally**, through two curated
overlays keyed on the stable `(supercategory, family_label)` pair (A2 re-mints `family_id`
on every rebuild, so the label pair is the identity). Both are loaded by ETL, gaps-only,
mirroring the `mesh_curated_alias` pattern:

| Overlay | Table | Effect | Audience | Gate |
|---|---|---|---|---|
| **Suppression** (#800) | `family_suppression_overlay` | Family removed everywhere — profile lens **and** the Overview generator's methods facts | **Everyone** (relevance, not access control) | Applied unconditionally; empty table = no-op. No flag. |
| **Sensitivity** (#801) | `family_sensitivity_overlay` | Family hidden from the **public** payload only; the scholar + superusers still see it, marked *"hidden from the public profile"* | Public viewers only | `METHODS_LENS_SENSITIVE_GATE` — **dormant**, off pending External Affairs policy sign-off |

- **Suppression overlay** = *"this family is too generic to be informative"* (e.g.
  "Observational study design"). Hide it for all viewers.
- **Sensitivity overlay** = *"scientifically legitimate but reputationally/safety
  sensitive on a public page"* (e.g. curated live-animal-model families). When the gate is
  **off**, these show unmarked; when **on**, the public sees only non-sensitive families
  while the scholar/superuser see all with a marker. The reveal-to-owner path is
  `GET /api/edit/methods-sensitive/[cwid]`; rendering is in
  `components/profile/methods-section.tsx`.

Indirectly, a scholar *can* shrink their methods lens by hiding the **publications** that
feed a family — the lens is derived from non-hidden pubs (`METHODS_LENS_FAMILY_FILTER`,
the `?family=` filter on the publications cluster). But they cannot pick a family and hide
it directly.

Flags: `METHODS_LENS_ENABLED` (the lens itself), `METHODS_LENS_PAGES` (cross-scholar
/methods pages), `METHODS_LENS_FAMILY_FILTER` (click-to-filter), `METHODS_LENS_SENSITIVE_GATE`
(the sensitivity overlay). See `lib/profile/methods-lens-flags.ts`.

---

## Who can hide what

Full matrix in [`access-control-rbac.md`](./access-control-rbac.md). Summary:

| Target | Self | Superuser | Unit admin | Proxy (#779) |
|---|---|---|---|---|
| Whole profile (`scholar`) | ✅ | ✅ | ✗ | ✗ |
| Publication — per-author hide | ✅ (own authorship) | ✅ | ✅ (author in their unit) | ✅ (granted scholar's authorship) |
| Publication — whole-pub takedown | ✗ | ✅ | ✗ | ✗ |
| Grant / education / appointment | ✅ (own) | ✅ | ✗ | ✗ |
| Appointment — **leadership** | ✗ (`409`) | ✗ (`409`) | ✗ | ✗ |
| Mentee relationship | ✅ (mentor only) | ✅ | ✗ | ✗ |
| Org unit (`department`/`division`/`center`) | ✗ | ✅ (retire) | ✗ | ✗ |
| Method family | ✗ | ✗ (editorial/ETL, not `/edit`) | ✗ | ✗ |
| Bio (Overview) | ✅ | ✅ | ✗ | ✗ |

---

## Related but not "hiding"

- **"Not mine" / Reject** (#746) — a *publication* flow that looks like a hide but means
  *"this isn't my paper."* It writes a suppression **and** queues a correction back to
  ReCiter's gold standard (`reciter_pending_refresh`), so the misattribution is fixed at
  source rather than just masked. It is **not locally revocable** the way a Hide is. Gated
  by `RECITER_REJECT_SEND` (dormant, off). Use **Hide** for *"mine but private,"* **Reject**
  only for *"not mine"* — rejecting your own papers feeds ReCiter false negatives.
- **Soft-delete** (`scholar.deleted_at`) — a departed scholar's profile is removed from
  public view and purged after a 60-day retention window. This is a *lifecycle* state, not
  a privacy choice, and is driven by the departure process, not `/edit`.
- **Retracted publications** — hidden automatically by the `NEVER_DISPLAY_TYPES` filter +
  the nightly PubMed-retraction stamp, not by suppression. See
  [`retracted-publications.md`](./retracted-publications.md).

---

## Search reflection & audit

- **Search.** Suppressing/revoking a `scholar` or `publication` reflects into OpenSearch
  synchronously (best-effort fast-path; the nightly rebuild and the #393 reconciler are the
  backstops via `search_reflected_at`). A suppressed scholar's people doc is deleted; a
  hidden publication is re-indexed (and affected co-authors' docs refreshed). Other entity
  types have no search fast-path.
- **Audit.** Every hide/un-hide writes a B03 `manual_edit_audit` row recording the real
  actor, target, reason, and action (`suppression_create` / `suppression_revoke`). See
  [`b03-audit-log.md`](./b03-audit-log.md).

---

## Design rationale — what we deliberately don't hide, and why

Hiding is in permanent tension with what this system is *for*: an accurate, comprehensive
institutional record. The scope is therefore governed by one principle:

> **Support hiding when the motive is accuracy, privacy, safety, or compliance. Refuse it
> when the motive would be vanity-curation or evading accountability/transparency.**

The four legitimate motives, and how each is served:

- **Accuracy** — *"not mine / this is wrong."* → publication **Reject** (#746, corrects
  ReCiter at source), or misattribution hides on grants/appointments/education.
- **Privacy** — *"I don't want this public."* → whole-profile suppression; the bio override.
- **Safety / reputational** — research that can draw harassment. → the Methods-lens
  **sensitivity overlay** (#801), owned by Compliance/Communications, not individuals.
- **Compliance / legal** — retractions, takedowns. → superuser whole-pub takedown; the
  automatic retraction filter.

What that principle rules **out** — these omissions are deliberate, not gaps:

- **A per-scholar control to hide an individual method/tool/family.** Method data is
  *derived* — the lever already exists (hide the underlying publications and the family
  shrinks on its own), so a direct control would be redundant and could contradict pubs
  that are still shown. More importantly, the Methods lens is only worth showing if it is an
  *honest* read of what a scholar actually does; per-scholar pruning would hollow it out
  on both profiles and the cross-scholar `/methods` pages. The legitimate cases are handled
  **editorially and globally** — `family_suppression_overlay` for "too generic to inform,"
  `family_sensitivity_overlay` for the safety case — and the whole feature has a global
  kill-switch (`METHODS_LENS_ENABLED`). That is the right granularity; an individual one is not.
- **Topics / concepts and co-authors.** Derived from publications; the correct lever is
  hiding the source pubs. Direct suppression would let a profile misrepresent its own corpus.
- **Profile header (name / title / department).** These are owned by upstream systems of
  record (Faculty Affairs, the Web Directory, ASMS). The path is *"request a change"* to the
  source — hiding your title in an institutional directory is incoherent, not private.
- **COI disclosures.** A read-only mirror of Weill Research Gateway, and disclosure is
  frequently *mandated*; a hide here would defeat the purpose.
- **Leadership appointments.** Accountability — you cannot hide that you chair a department.

Two open policy decisions sit inside the *supported* set:

- **Mentees** are hideable today by the **mentor** only. The relationship involves a
  third-party student — decide whether a mentee may request removal, and whether
  FERPA-adjacent concerns make this mentor-discretion or a routed request.
- **Grants** are hideable, but the effect is **cosmetic**: awards remain public record in
  RePORTER/NSF, so hiding only de-features them on the profile. Justified for
  misattribution; worth stating plainly so it isn't mistaken for making a grant private.

## What cannot be hidden

- **Profile header** — name, title, primary department (whole-profile suppression is the
  only lever; you can't hide just the header).
- **COI disclosures** — read-only mirror of Weill Research Gateway; no suppression path.
- **Topics / concepts** and **co-authors** — derived; they follow publication visibility,
  with no independent control.
- **Leadership appointments** — chair/chief/director roles are explicitly non-suppressible.
- **An individual method/tool/family by a scholar** — only the editorial overlays hide
  families, and only globally or public-gated.

---

*See also:* [`ADR-005`](./ADR-005-manual-override-layer.md) (design),
[`access-control-rbac.md`](./access-control-rbac.md) (authz),
[`b03-audit-log.md`](./b03-audit-log.md) (audit),
[`scholar-tools-taxonomy.md`](./scholar-tools-taxonomy.md) (methods taxonomy),
[`retracted-publications.md`](./retracted-publications.md) (auto-hidden retractions).
