# SPEC — Per-scholar section visibility

Faculty want to hide whole profile **sections/subsections** they consider incomplete or
unhelpful (origin: Schpero feedback 2026-07-07 — Mentoring incomplete, Methods & Tools
unhelpful). Today only two hide tiers exist: **record-level** (interspersed, `suppression`
table) and **whole-profile** (`visibility-card.tsx`). This adds the missing middle tier:
**whole-section on/off, per scholar.**

## Scope

Seven hideable units, each a boolean per-scholar override:

| Key | Section | Profile location |
|-----|---------|------------------|
| `hideMentoring` | Mentoring (mentees) | main — `mentoring-section.tsx` |
| `hideEducation` | Education | sidebar — `profile-view.tsx:370` |
| `hideFunding` | Funding / Grants | main — `profile-view.tsx:482` |
| `hideCenters` | Centers | sidebar — `profile-view.tsx:338` |
| `hidePostdocMentor` | Postdoctoral Mentor | sidebar — `profile-view.tsx:269` |
| `hideClinicalTrials` | Clinical trials (subsection) | main — `profile-view.tsx:512` |
| `hideMethods` | Methods & Tools (subsection) | pubs cluster — `methods-section.tsx` |

**Explicitly NOT hideable:** COI/Disclosures (compliance-mandated public — route must
reject `hideDisclosures`), whole Publications (record-level hide covers legit cases),
Overview/Highlights/Contact (already user-controlled by other means).

**Out of scope:** Appointments. "Show all historical, hidden by default, user override" is
per-record reveal, not a section toggle — it rides branch **#1323**
(`Appointment.showOnProfile`), tracked separately.

## Mechanism (reuse, no schema change)

- **Storage:** existing `field_override` table. Section keys are booleans: a row with
  value `"true"` = hidden; no row (or delete/revoke) = shown. Same revocable semantics the
  `overview` override already uses.
- **Allowlist:** add the 7 keys to `EDITABLE_FIELDS` (`lib/edit/validators.ts:41`, today
  `["overview","slug","selectedHighlightPmids"]`). Validator accepts only `"true"`/`"false"`
  for these keys; rejects any not on the list (so `hideDisclosures` → 400).
- **Write path:** existing `POST /api/edit/field` (`app/api/edit/field/route.ts`). Same
  authz (self / superuser / unit admin / proxy) and B03 audit row per toggle. No new endpoint.
- **Apply server-side:** hidden sections are filtered out in the profile API layer
  (`lib/api/profile.ts`) — the public payload omits hidden-section data entirely (matches how
  `suppression` filters records), so nothing leaks to the client. Render components just get
  empty/absent data and their existing `length > 0` guards no-op the section.

## UI — Visibility card (single home)

Extend `components/edit/visibility-card.tsx` with a **"Sections"** panel below the existing
whole-profile control:

- One switch per section (7), labelled plainly ("Mentoring", "Methods & Tools", …).
- Per section, a read-only count of records hidden *inside* it, linking to that card:
  *"Publications — visible · 3 records hidden →"*. Counts come from the suppression state
  already loaded in edit-context — no new query. This is the audit view; the actual
  record-level controls stay interspersed in each card (unchanged).
- Toggling hide → confirm dialog (optional-preset, matching the profile-hide pattern);
  toggling show → no dialog (never gate restoration).

## Semantics / carve-outs

- **`hideMethods` is display-only.** It hides the Methods & Tools *section*; it does NOT
  alter the Overview generator's methods facts (that stays driven by the global
  `family_suppression_overlay`). ⚠️ This **reverses** the standing carve-out in
  `docs/what-can-be-hidden.md` ("a per-scholar control to hide a method… deliberately don't")
  — that doc must be updated (see below). Decision approved 2026-07-07.
- **Section-hide is profile-display only** — no search/people-doc reflection (unlike
  whole-profile suppression, which deletes the people doc). A hidden section stays fully
  searchable.
- **Empty sections:** toggles render for all 7 regardless of data; a toggle on an empty
  section is inert (nothing to hide). No special-casing.
- **Idempotent:** setting hide=true when already hidden is a no-op.

## Docs update

`docs/what-can-be-hidden.md` currently asserts *"There is no 'hide this whole section'
toggle"* and lists per-scholar method hiding under "what we deliberately don't hide." Both
are now false — update the catalog with the new section-visibility tier and remove the
Methods carve-out.

## Files to touch

| File | Change |
|------|--------|
| `lib/edit/validators.ts` | add 7 keys to `EDITABLE_FIELDS`; boolean validation |
| `app/api/edit/field/route.ts` | (verify allowlist gate covers new keys; likely no change) |
| `lib/api/profile.ts` | read section-hide overrides; filter hidden sections from payload |
| `components/edit/visibility-card.tsx` | add Sections panel (7 switches + hidden-record counts) |
| `components/profile/profile-view.tsx` | ensure guarded sections no-op when data absent |
| `components/profile/methods-section.tsx` / pubs cluster | gate Methods & Tools |
| `docs/what-can-be-hidden.md` | document new tier; drop Methods carve-out |

## Test table (edge cases)

| Case | Expected |
|------|----------|
| `hideMentoring=true` set | Mentoring section absent from public profile + payload |
| toggle back to show | Section returns |
| section hidden + 3 records suppressed inside | Visibility card shows "3 records hidden"; section still absent |
| `hideMethods=true` | Methods & Tools section gone; Overview bio methods facts unchanged |
| write `hideDisclosures` | 400 rejected (not on allowlist) |
| hidden section still searchable | people-doc unaffected; scholar found in search |
| toggle on empty section (no mentees) | inert, no error |
| every toggle | one B03 audit row (actor, field, before/after) |

## Effort

Small–medium. No schema/ETL/migration. New code ≈ Visibility-card panel + a handful of
render/query conditionals + validator entries + doc update + tests. Frontend + API only.
