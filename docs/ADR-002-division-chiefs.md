# docs/ADR-002 — Populating `Division.chiefCwid`

**Status:** Accepted
**Date:** 2026-05-07
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —
**Tracks:** [issue #16](https://github.com/wcmc-its/Scholars-Profile-System/issues/16)

---

## Context

`Division.chiefCwid` exists in the schema (`prisma/schema.prisma:284`) and the UI
already renders chief leadership when populated:

- Division page hero (`components/division/division-page.tsx:127`) shows
  `<LeaderCard role="Chief">` for `division.chiefCwid` when set.
- Department faculty list (`lib/api/departments.ts:257-285`) places the chief
  first when filtering by division.

Until this ADR, **nothing wrote the column** — every division had
`chiefCwid = NULL` in production and the chief affordance was dead code.

Two constraints from the data ruled out the cheap path:

1. **"Chief" is not used as an appointment title at WCM.** We cannot mirror
   the chair-detection pattern (which works because chairs literally hold a
   "Chair of X" appointment title).
2. **Faculty division and employee division don't always match by label,
   but the N-code (level1/level2 org-unit code) does.** When cross-referencing
   a scholar's division across `ou=faculty,ou=sors` and `ou=employees,ou=sors`,
   join on the N-code, not the display name.

## Decision

Combine three mechanisms, ordered by precedence:

1. **Path A — extended chair detection.** A prerequisite, not a chief
   detector itself: Path B can only work when each parent department's
   chair is identified. The pre-existing regex matched only titles that
   *started with* `Chair of {dept}`. We extended it to catch endowed
   ("Sanford I. Weill Chair of Medicine") and acting ("Acting Chair of Cell
   and Developmental Biology") forms, while excluding vice / associate /
   deputy / assistant chairs.

2. **Path B — manager-graph detection (auto).** For each division, the
   chief is the faculty member whose employee-SOR `manager` attribute equals
   the parent department's chair CWID. Disambiguate ties by reportee count
   → primary-in-division count → earliest start date. Gated by a
   confidence threshold (see below).

3. **Path C — manual override file (always-on).** `data/division-chiefs.txt`
   carries hand-curated overrides. Always wins over Path B. A `-` in the
   CWID column clears the slot (vacancies, interim).

### Confidence verdict scale (Path B)

The same scoring runs in `etl/ed/chief-detection.ts` and is consumed by both
the production ETL and the read-only probe. Verdicts:

| Verdict | Meaning | ETL behavior |
|---|---|---|
| `HIGH` | Single candidate with primary appointment in division **and** ≥1 reportee, OR multi-candidate with dominant top + primary-in-div | Auto-write top pick |
| `MEDIUM` | Single candidate with one of {primary-in-div, reportee} present, OR multi-candidate with dominance OR top reporting ≥2 | Auto-write top pick |
| `LOW` | Candidates exist but no signal differentiates them | Clear to `null` |
| `NONE` | Members exist but none report to the parent chair | Clear to `null` |
| `GAP` | No parent chair detected, or no division members in SOR | Clear to `null` |

The override file (Path C) runs **after** Path B and overwrites the result
unconditionally — so a manual entry always wins over an auto-decision, and
LOW/NONE/GAP rows stay `null` only until a human curates them.

### Why a confidence threshold

Without a gate, Path B would auto-write its single best guess for every
division regardless of signal strength. In practice the LOW bucket — multiple
candidates with zero reportees and similar tenure — is essentially a coin
flip. Writing the coin-flip pick produces a worse user experience than
leaving the slot empty and surfacing it on a "needs override" list. The
threshold draws the line at MEDIUM: anything weaker than that is the
override file's responsibility.

### Why three mechanisms instead of one

Probe results (8 known chiefs, run 2026-05-07) showed Path B is partially
useful: ~51% of WCM divisions get a HIGH or MEDIUM verdict after the chair
detection fix. Pediatrics and Medicine work well; Surgery is a structural
failure (chiefs report through an administrative chief, not the dept chair);
Population Health Sciences is mixed. The override file is the escape hatch
for the long tail Path B can't decide.

## Consequences

### Positive

- Chief affordance in the UI now has data.
- Auto-detection refreshes on every nightly ED ETL — chiefs who change
  reporting structure are picked up automatically.
- Manual overrides always win, so an authoritative known chief never gets
  silently rewritten.
- The shared verdict logic guarantees the probe report and ETL writes
  cannot drift.

### Negative / accepted

- Path B is wrong for Surgery (and similar depts where chiefs don't report
  to the chair). Mitigated by Path C overrides.
- Some chiefs' SOR appointment rows don't carry a level2 org-unit, so their
  divisions don't exist in the DB at all and overrides cannot attach. As
  of this ADR, this affects Colorectal Surgery (Fichera), Child Neurology
  (Pascual), Biostatistics (Zhong), and Charlson's Medicine division.
  A follow-up will add a fallback to people-branch `level2` in
  `lib/sources/ldap.ts` so those rows get created.
- Predecessor chiefs may surface as Path B candidates if their employee
  SOR row hasn't been refreshed. Override file pins the current chief
  in those cases.

## Operations

### Adding or correcting an override

Edit `data/division-chiefs.txt`:

```
{division_code}<TAB>{cwid_or_dash}<TAB>{optional_notes}
```

- Lines starting with `#` and blank lines are ignored.
- Use `-` in the CWID column to explicitly null out a chief (vacancy /
  interim).
- Validation runs at ETL time: rows pointing at a missing division code
  or unknown CWID are skipped with a warning, not failure.

The next `npm run etl:ed` picks it up automatically.

### Inspecting current state

Read-only diagnostics. Both safe to run any time:

```bash
# Per-division candidate report with verdict and write/skip indicator.
# Optional arg restricts to one parent dept code.
npm run etl:ed:probe-divisions
npm run etl:ed:probe-divisions N1280

# Per-CWID probe — for vetting suspected chiefs against the manager graph.
npm run etl:ed:probe-chiefs jww2001 jut9005 mms9024
```

The division probe outputs `[WRITE]` next to picks the ETL will commit and
`[skip (verdict gate)]` next to LOW picks. The chiefs probe ends with a
YES/NO/INCONCLUSIVE summary and a recommendation.

### Disabling Path B

If a future probe shows manager-graph has gone systemically noisy, set:

```
SCHOLARS_DISABLE_CHIEF_DETECTION=true
```

in the ETL environment. Path C still runs, so the override file remains
authoritative. ETL log lines confirm the skip.

## Implementation

| File | Role |
|---|---|
| `lib/sources/ldap.ts` | `fetchActiveEmployeeRecords()`, `parseManagerCwid()`, `collapseEmployeeRecordsByCwid()` — pull and normalize the employee SOR. |
| `etl/ed/chief-detection.ts` | `detectDivisionChief()` and `isChairTitleFor()` — shared verdict + chair regex used by ETL and probe. |
| `etl/ed/index.ts` | Path A regex fix (chair detection block), Path B detection loop with verdict gate, Path C override loader. |
| `etl/ed/probe-divisions.ts` | Read-only per-division report (uses shared helper). |
| `etl/ed/probe-chiefs.ts` | Read-only per-CWID viability probe. |
| `data/division-chiefs.txt` | Override file (TSV). |

## Future work

- Populate divisions for chiefs whose SOR appointment rows are level1-only,
  via people-branch `weillCornellEduOrgUnit;level2` fallback in
  `lib/sources/ldap.ts`.
- Optional: surface a "chief candidacy" review report in the admin UI for
  divisions currently in LOW/NONE so curators can confirm and add overrides
  without reading ETL logs.
- Optional: cross-link `Division.chiefCwid` back to the scholar's profile
  ("Chief of X division" badge). Tracked separately if/when wanted.
