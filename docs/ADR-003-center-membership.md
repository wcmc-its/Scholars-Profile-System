# docs/ADR-003 — Populating `CenterMembership`

**Status:** Historical record — methodology shipped under [issue #12](https://github.com/wcmc-its/Scholars-Profile-System/issues/12) (closed 2026-05-08). Retained as documentation of the manual-curation pattern for future re-runs and for parity with [ADR-002](./ADR-002-division-chiefs.md).
**Date:** 2026-05-07
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —
**Related:** [ADR-002 division chiefs](./ADR-002-division-chiefs.md)

---

## Context

`CenterMembership` exists in the schema (`prisma/schema.prisma:329-340`) and
is loaded from per-center text files in `data/center-members/<slug>.txt` via
`prisma/seed-center-members.ts`. The loader was already in place when this
ADR was written — what was missing was content.

Before this work, only `meyer-cancer-center.txt` carried members (331 active
scholars matched). The other seven centers had empty membership and a
zero `scholar_count`.

The exercise was to mirror the divisions methodology (ADR-002): probe for an
automated detection mechanism, fall back to a manual file with sources
documented, and accept the long tail.

## Decision

Centers fall into two natural buckets, only one of which can be auto-detected:

| Bucket | Examples | Member detection |
|---|---|---|
| LDAP org-units (academic departments by another name) | Institute for Computational Biomedicine, Brain & Mind Research Institute | Already populated as departments via `weillCornellEduOrgUnit;level1`. **Out of scope here** — these are technically academic departments, not centers. The `Center` rows for these may want to be removed or repurposed. |
| Cross-disciplinary affinity groups | Meyer Cancer Center, Englander IPM, CVRI, Health Equity, Aging, Iris Cantor, Inflammation Research | No LDAP signal. Manual `.txt` file is the only viable source. |

For the manual bucket we use **public WCM web pages** as the starter source.
Each file's header records the URL and date it was scraped, so future
maintainers know what to re-fetch when membership shifts.

### Director detection (deferred)

Title-based director detection — analogous to the chair-detection regex in
ADR-002 — is feasible. A grep of `appointment.title LIKE '%Director%'`
surfaces clear endowed-director phrasings ("Sandra and Edward Meyer Director,
Sandra and Edward Meyer Cancer Center") and direct phrasings ("Director of
the Feil Family Brain and Mind Research Institute"). Skipped for now per
scoping ("less important than members"). Expected to be a small follow-up
when prioritized.

## What got populated

| Center (DB code) | Members loaded | Source |
|---|---:|---|
| `meyer_cancer_center` | 331 | Pre-existing manual list |
| `englander_ipm` | 59 | https://eipm.weill.cornell.edu/about-us/our-team (scraped 2026-05-07) |
| `health_equity` | 58 | User-supplied roster (2026-05-07) |
| `cardiovascular_ri` | 9 | https://cvri.weill.cornell.edu/faculty (scraped 2026-05-07) |
| `aging_research` | 4 | https://news.weill.cornell.edu/units/center-aging-research-and-clinical-care (scraped 2026-05-07; sparse) |
| `iris_cantor_womens_health` | 2 | https://medicine.weill.cornell.edu/divisions-programs/womens-health (scraped 2026-05-07; sparse) |
| `inflammation_research` | 0 | **Unresolved — see ambiguities** |
| `computational_biomed` | 0 | LDAP org-unit (department); not a true center |

### Loss to scholar-table filter

Where a roster includes affiliate-only or expired-status people, the loader
silently drops them. Examples observed in this exercise:

- **Health Equity (56 of 114 dropped)** — about half the roster the user
  supplied is former WCM faculty (e.g. Ruth Gotian, Leandro Cerchietti) or
  Cornell Ithaca affiliates with no active WCM appointment.
- **Englander IPM (5 dropped)** — John P. Leonard, Peter Martin, Jyotishman
  Pathak, Cathleen London, Elizabeth Jacobson all have an `affiliate:active`
  or fully expired LDAP status, and Haiyuan Yu is Cornell Ithaca-only.

The loader is idempotent: dropped names stay in the file (commented or
listed) so they reappear automatically if their scholar status flips back
to active. This matches the pattern set by `meyer-cancer-center.txt`,
which has 10 unmatched lines for the same reason.

## Open ambiguities (left as-is for now)

1. **`Center for Inflammation Research`** — the DB row name doesn't match any
   single public WCM unit. Three candidates surfaced in research:
   - **Jill Roberts Institute for Research in Inflammatory Bowel Disease**
     (David Artis, basic research, 10 faculty publicly listed) —
     https://robertsinstitute.weill.cornell.edu/faculty
   - **Jill Roberts Center for Inflammatory Bowel Disease** (Randy Longman,
     clinical) — https://jillrobertsibdcenter.weillcornell.org/
   - **Friedman Center for Nutrition and Inflammation** —
     https://news.weill.cornell.edu/units/friedman-center-for-nutrition-and-inflammation

   The `Center` row was seeded as "Center for Inflammation Research" — closest
   in spirit to the Jill Roberts Institute but the names don't actually match.
   Either rename the DB row to match a real institute or merge/split as the
   org chart actually represents it.

2. **`Center for Aging Research`** vs **Center on Aging and Behavioral Research** —
   two distinct units published, both relevant to "aging." The 4-name file
   pulled from the broader newsroom unit; expanding to the Czaja-led behavioral
   research center would add Cary Reid, Karl Pillemer, Catherine Riffin and
   the wider Geriatrics & Palliative Medicine roster. Decide which umbrella
   the row represents before expanding.

3. **`Iris Cantor Women's Health Center`** — the public faculty page lists
   only 4 names; the SSL cert was expired at scrape time, so the page may
   carry more behind that. Center is known to be larger than 2 active
   scholars in practice.

4. **`Institute for Computational Biomedicine` and `Brain & Mind Research
   Institute`** — these were seeded as `Center` rows but are academic
   departments in the WCM org chart (level1 LDAP units). Decide whether to
   keep them as separate `Center` rows for affordance reasons, repurpose the
   row for a narrower interpretation (e.g. computational-biomed-affiliated
   non-CB-dept faculty), or remove the rows.

These are deliberately deferred — the immediate task was a starter list,
not a full organizational reconciliation.

## Operations

### Adding or correcting a center's member list

Edit `data/center-members/<center.slug>.txt`. Format is one CWID per line,
optional `cwid` header, `#` for comments. The loader is idempotent — running
it again replaces the center's full membership from the file (so removing a
line removes the membership on next run).

```bash
npx tsx prisma/seed-center-members.ts
```

The loader prints `<slug>: M matched, U unmatched, D duplicates skipped` per
file. Unmatched CWIDs are typically affiliate-only or expired scholars that
fall outside the active-academic filter; leaving them in the file is safe
(no errors) and lets them auto-attach when their status changes.

### Adding a new center

1. Add the center row in `prisma/seed-centers.ts` (code, name, slug,
   sortOrder, optionally directorCwid + description).
2. Run `npx tsx prisma/seed-centers.ts` to upsert.
3. Drop a `data/center-members/<slug>.txt` with one CWID per line.
4. Run the membership loader.

### Document where the list came from

Each `<slug>.txt` should carry a header comment with:
- Source URL (or "user-supplied" when given directly)
- Date scraped / received
- Any unmatched names from the source with their LDAP CWIDs, so a future
  refresh can compare delta.

## Future work

- **Director detection.** Title-based regex pass to populate
  `Center.directorCwid`, mirroring the chair-detection helper in
  `etl/ed/chief-detection.ts`. Expected to catch ~5-7 of the 8 centers
  cleanly (Cancer Center / Brain & Mind / Drukier / IPM directors all have
  detectable titles).
- **Resolve the four ambiguities listed above.** Each requires a small
  product/data decision, not engineering work.
- **Iris Cantor and Aging Research roster expansion** — once you have
  authoritative lists, drop them into the respective `.txt` files.
- **Affiliate-active membership policy.** A non-trivial slice of every
  manual roster is `affiliate:active` people who don't appear in the
  scholar table. Decide whether to broaden the LDAP filter or accept
  the drop rate. Today's behavior matches Meyer Cancer Center's existing
  pattern (10 of 342 dropped), so this isn't a regression.

## Implementation references

| Path | Role |
|---|---|
| `prisma/schema.prisma:299-340` | `Center` and `CenterMembership` models. |
| `prisma/seed-centers.ts` | Upserts the 8 center rows. |
| `prisma/seed-center-members.ts` | Reads `data/center-members/*.txt`, upserts memberships, refreshes `scholar_count`. Idempotent (clear+repopulate per file). |
| `data/center-members/*.txt` | Per-center CWID list. Filename = `Center.slug` + `.txt`. |
| `scripts/match-center-names.ts` | One-off helper used by this ADR's authors to match scraped names to CWIDs. Re-runnable for new centers. |
