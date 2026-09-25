# Mentored publications report — `/edit/reports/7`

**Status:** Merged to master from #2664 (2026-09-18) through the types filter (#2681) and the
"words" PR after it. There is no env flag: the report is live wherever the app image is deployed and
a `report_access` row exists. Design decisions from rounds 3–6 were previously recorded only in
private session handoffs; this is their durable home.

## What it is

The Areas of Concentration (AOC) office — the MD scholarly-concentration program — asks every year
for a spreadsheet: for each learner, every publication they co-authored with one of their mentors,
with Journal Impact Factor and NIH iCite citations, plus per-learner counts. They built it by hand.
`/edit/reports/7` (the permanent link; it redirects to the report's current slug URL,
`/edit/reports/mentored-publications` by default) is that spreadsheet on demand: a Learners table (one row per learner) and a Publications list
in-page, and the full three-sheet workbook (Summary / Raw Data / Query & Assumptions) behind
"Download .xlsx" (`/api/edit/reports/mentored-publications`, same query string, same filters).

Code: `app/edit/reports/[report]/page.tsx` (the shared report page) + `lib/edit/report-registry.ts` entry `"7"` +
`components/edit/reports/mentored-publications-body.tsx` (the report body), `lib/edit/mentored-publications-report.ts` (loader),
`lib/edit/mentorship-type.ts` (the type vocabulary, labels, hover text),
`lib/edit/mentored-publications-params.ts` (query contract), `lib/edit/mentored-publications-xlsx.ts`
(workbook), `lib/edit/mentored-publications-facets.ts` (the rail's post-load filters and their counts),
`components/edit/reports/mentored-publications-rail.tsx` (the filter rail),
`components/edit/mentored-publications-table.tsx` (the client island: tabs, find box, tables).

## The page (redesign, 2026-09-24)

Built on the shared report pieces (`components/edit/reports/report-ui.tsx`). The page header (eyebrow,
name, access badge, "Edit details", "About this report") is the shared frame's; the body's subtitle is
one sentence.

- **Filter rail**, one for both tabs, in this order: Mentorship type (the program pairings), Inferred
  mentorship (likely / possible), Graduation year (from / to plus "Include learners with no graduation
  year"), Counting window (0–3 years after graduation), Publications (with a mentor / all), In window
  (per publication: in, outside, unknown), Author position (first / last / middle), Publication year,
  Mentor (searchable), Learners shown ("Hide learners with no publications"). Every section is a
  collapsible `<details>`; a collapsed section's inputs still submit. Filters apply on change (the
  `AutoSubmitForm`). "Reset to defaults" returns to the bare URL. Below `lg` the rail opens from a
  "Filters (n)" button (`FiltersSheet`).
- **Card**: learners, publications in window, all years; Download .xlsx with a note naming the
  workbook's sheets; "N distinct publications" (a paper two learners share counts once there and once
  per learner in the headline numbers); the active filters as chips (× removes one; the four standing
  values carry no × until they differ from the default; a chip's × keeps the "Find a learner or
  mentor" text, "Reset to defaults" clears it); the "N faculty-asserted mentees have no CWID" banner,
  whose "View list" (a native `<details>`) names each dropped entry as "Mentee name — added by
  Mentor name" (`droppedNoCwidMentees`: names only, since those mentees have no CWID; on the page
  only, never in the workbook).
- **Learners (N)** tab: Learner (name, CWID, "Grad YYYY", "(entry est. YYYY)" for the fallback) ·
  Mentors (each mentor's name with the pair's type as a badge, "Department · Institution" under it) ·
  In window · [With a mentor, all-publications set only] · All years · JIF ≥ 10 · First author (With
  a mentor, JIF ≥ 10 and First author count in-window papers only). Below `md` the mentors and counts stack inside the Learner cell, so a
  phone never scrolls sideways (the table used to carry separate Grad year, Type, Department and
  Institution columns and scrolled the Learner column out of view). A row with publications opens to
  that learner's papers. "Find a learner or mentor" narrows the rows (name, CWID or mentor), never the
  counts or the download. Sort by the column headers (Learner or Grad year in the first); graduation
  year, newest first, by default. 25 rows, then "Show 25 more".
- **Publications (N)** tab: one entry per distinct paper: the Vancouver citation with its PMID link
  (Scopus-only rows print their Scopus id, no link), JIF, NIH iCite citations, date added to PubMed,
  each learner with their byline position and window badge, each mentor with the pair's type. Sort:
  recently added to PubMed (default), newest first, JIF, most cited, title. "Show 25 more".
- **Footnote**: the in-window rule and the MD entry-year fallback (moved out of the subtitle), the
  count of suggestion-evidence papers not yet in the local corpus when there are any, and "Historical
  numbers may change slightly…".

## Who can see it

Access is NOT unit-scoped like reports 1–6. It is a row in `report_access` —
`(reportKey = mentored-publications, scopeKey, cwid)` — written by `grantReportAccess` /
`revokeReportAccess` in `lib/edit/report-access.ts`, each inside one transaction with a B03 audit row.

- A superuser or `comms_steward` always passes with every scope (`"*"`), no table read.
- Anyone else sees the union of their rows' scope keys: `md` (AOC), `mdphd`, `ecr`, or `*`.
- No rows → the empty set → the page `notFound()`s and the route 403s. There is no env flag; an
  empty table is the dark state.

Grants are made from the page itself: the "Viewers" panel (`ReportAccessPanel`) renders only for a
superuser / comms steward and offers a CWID field plus a program select (All programs / AOC /
MD-PhD / ECR). Each add or remove is a `POST /api/edit/report-access` and the panel re-renders from
the row list the server returns. The audience today is a couple of named office staff; their CWIDs
live in the table, never in this repo.

## Sources

The "Type of mentorship" filter has eight keys (`MENTORSHIP_TYPE_KEYS`), each one source and one
confidence. Every hover (the rail's Mentorship type / Inferred mentorship options and each pair's type
badge) reads `MENTORSHIP_TYPE_DESCRIPTION`. The rail splits the one `mtype` param across two sections:
the program pairings, then the two co-authorship inferences.

| Label | Table | What it carries | What it lacks | Default | Since |
|---|---|---|---|---|---|
| MD (the AOC pairing sheet) | `aoc_mentee` (mirror of `reporting_students_mentors`, bucket `md`) | Pairs the AOC program records in its pairing sheet; graduation year; entry year for recent classes | Entry year for older classes (see the fallback below) | On, for an `md` or `*` holder | #2664 |
| MD-PhD (program office) | `aoc_mentee` (bucket `mdphd`) | Pairs from the MD-PhD program office's list, loaded with the AOC sheet | Any year — no entry, no graduation | On, for an `mdphd` or `*` holder | #2664 |
| ECR | `aoc_mentee` (bucket `ecr`) | Early Career Research pairs, classes 2018–2023; graduation year | Entry year (the fallback below applies) | On, for an `ecr` or `*` holder | #2664 |
| PhD / MD-PhD thesis advisor | `phd_mentor_relationship` (Jenzabar, MAJSP) | Thesis-advisor pairs; conferral year | Start year | On, for every holder | #2677 |
| Postdoc supervisor | `postdoc_mentor_relationship` (ED appointment record) | The postdoc's reporting manager; appointment start and end dates (no end = ongoing) | A PI guarantee: roughly one in seven managers on record is a lab administrator (#2633) | On, for every holder | #2677 |
| Likely mentee (from co-authorship) | `mentee_suggestion`, tier `presumptive` (#2634) | A trainee-type co-author (student, postdoc, fellow, volunteer…) who publishes repeatedly with the faculty member; pubs from the suggestion's own evidence list | Any year; confirmation | Off | #2677 |
| Possible mentee (from co-authorship) | `mentee_suggestion`, tier `ambiguous` | The same inference for research staff or MD alumni, who may be peers | Any year; confirmation | Off | #2677 |
| Faculty-asserted | `field_override` (`scholar`, `manualMentees`) — the mentor's own list on `/edit`, including accepted co-authorship suggestions | Mentee name, optional CWID, optional completion year, optional degree bucket | Entries with no CWID (counted in `droppedNoCwid`; named only in the page banner's "View list"); entry year | On, for a `*` holder | #2684 |

Publications for the pairing-sheet, Jenzabar and ED sources come from the mentoring co-pub bridge
(`mentee_copublication_pub`, one row per mentor × mentee × pub). Co-author pairs' pubs come from the
suggestion's `evidence` JSON (last 8 years, capped at 50 per pair), each resolved against the local
`publication` row; an evidence id with no local row is skipped and counted in `droppedUnresolved`,
which the page names in one sentence. A faculty-asserted pair is not in the bridge: it reads the
pair's suggestion evidence when a `mentee_suggestion` row exists (whatever its tier or dismissal),
else the intersection of both people's confirmed `publication_author` rows.

The bridge is refreshed by the mentoring bridge refresh script (export / import `<env>`), which lives
in the private pubs skill, not in this repo. The nightly does not refresh it.

Not yet a source: the Faculty Review Tool's self-reported mentees. The mentoring extract from that
system has not been provided (the #1855 handoff).

## Filter contract

All filters are plain GET params, parsed once by `parseMentoredPubsParams` so the page and the
download route can never disagree. Malformed input: the route 400s, the page falls back to defaults.

- `mtype=` (legacy `types=` still read when `mtype` is absent) — comma-separated and/or repeated `MENTORSHIP_TYPE_KEYS`. Resolved against the caller's
  scopes (`resolveMentorshipTypes`): a roster key whose scope the caller does not hold is dropped
  silently — never a 403, never a wider set; nothing left → the default. Absent → the default:
  every confirmed key for a `*` holder, else the roster key of each held scope (an `md` holder opens
  on AOC only). Co-author keys are never in a default.
- `years=` — graduation years, comma-separated and/or repeated; the token `unknown` = learners with
  no graduation year; `years=all` = every year. Choices are the distinct years across the SELECTED
  types (roster graduation year; Jenzabar conferral year; postdoc end year, ongoing = unknown;
  co-author pairs contribute only "unknown"). Absent, or every requested year outside the choices →
  the default: the two most recent known years plus "unknown" when any selected source has a
  year-less learner (else MD-PhD, which carries no years, would silently vanish).
- `tail=` — integer 0..3, default 1: years past graduation still counted "in window".
- `pubs=mentored|all` — the co-pubs with a mentor (default), or every publication of the learner
  from the `aoc_mentee_publication` bridge, each flagged for a mentor co-author.
- `grad_from=` / `grad_to=` / `grad_unknown=1` — what the rail's graduation-year range submits.
  Read only when `years` is absent and folded into the same list (every year from..to, plus
  `unknown` when `grad_unknown` is set; a blank end is "None"). Nothing the page writes uses them:
  every tab, chip and download link says `years=`, so an old `years=` link, a non-contiguous list
  included, keeps its exact meaning (the rail then notes that changing the range selects every year
  in between). A gap is judged against the years that exist: skipping only a year no class
  graduated in is a plain range.
- `grad_exact=` — the rail's hidden echo of a gappy selection (`2019,2027`). While `grad_from` /
  `grad_to` still equal its first and last year (the selects untouched), the parser keeps the list
  exactly (plus `unknown` when `grad_unknown` is set), so changing any other rail control does not
  widen an old link; once either select moves, the range wins. Server-side, so it holds without JS.
- `window=yes|no|unknown`, `position=first|last|middle`, `pubyear=YYYY`, `mentor=<cwid>` — lists
  (comma-separated and/or repeated); `withpubs=1`. The rail's post-load filters, added 2026-09-24
  (before that they were client-side facets inside the tables that never touched the counts or the
  download). `applyMentoredPubsFacets` applies them to the loaded report on the page AND in the
  download, and the workbook's Query & Assumptions sheet states each ("All" when unset). The unit is
  the (learner, publication) pair: `window` / `position` / `pubyear` keep a pair when the learner's own
  window flag / byline position / the paper's year is selected, and each learner's counts are
  recomputed over the pairs kept. `mentor` keeps the learners with a selected mentor and only their
  pairs with that mentor (in the all-publications set every paper stays; "with a mentor" then means a
  selected mentor). `withpubs` then drops learners left with no paper. A pair with no byline position
  or no year never matches a selected position or year. An unknowable window stays null. None set →
  the report is untouched. Not report 8's `pos` (single-valued, a different vocabulary).
- `view=summary|publications`, `q=` — page-only (`q` is the "Find a learner or mentor" text); the
  route accepts and ignores both so one link shape serves page and download.
- Legacy `program=<scope>` — the select the types filter replaced (#2681); reads as that scope's
  roster type. `program=all` or an unknown value reads as absent. An old link never 400s.

## Design decisions (rounds 3–6)

- **Window rule.** In window = entry year ≤ publication year ≤ graduation year + tail. A pub outside
  the window is still listed (the office wants the all-time list) but flagged, and the summary
  carries both counts.
- **Entry-year fallback.** When the pairing sheet has no entry year, an AOC row assumes
  graduation year − 4 (the 4-year MD track) and the row wears an "(entry est. YYYY)" chip. This
  applies to pairing-sheet rows only (AOC, and an ECR row with a graduation year but no entry
  year) — never to a Jenzabar conferral year or a postdoc end year, whose programs have no fixed
  length. A roster MD-PhD row with no years plus a Jenzabar conferral year still gets no guess:
  the fallback reads the roster's own graduation year.
- **Unknown years are null, never 0.** A learner with no graduation year reads "No grad year";
  every in-window count is `null` (a blank cell in the workbook, "—" on the page). A 0 would read as
  "published nothing".
- **Default years.** The two most recent known years, plus "unknown" when the selection has
  year-less learners.
- **Counting.** Per learner, distinct pub keys. A pub shared with two of a learner's mentors is one
  Raw Data row per mentor but counts once in that learner's summary.
- **Citations.** NIH iCite (`Publication.citedByCount`) only — never the Scopus count the bridge
  JSON carries. Null when the pub has no local row or no iCite row; a Scopus-only pub is null by
  nature.
- **JIF.** Joined by normalized journal abbreviation exactly as report 3 does; an unmatched journal
  is null, never 0.
- **Pub key.** The SPS `Publication.pmid` string — digits for a PubMed article, `SCOPUS:…` for a
  Scopus-only one (since #2679, round 5). The bridge tables and suggestion evidence both carry it.
- **"All learner publications" mode** reads `aoc_mentee_publication`, a roster-only product: a
  learner known only through Jenzabar, ED or an inference has no all-pubs list, so their mentored
  set stands in. An environment where the bridge has never been loaded shows a notice, not zeros.
- **Surest source wins.** A pair two sources claim takes the surest selected source (roster, then
  Jenzabar, then ED, then faculty-asserted, then co-author) and reads its pubs from that source — a
  bridge-backed pair never falls back to suggestion evidence.
- **The type filter reads only the selected sources.** This is why a learner is present only
  through selected pairs (an in-memory rail facet let a learner through on one roster pair and then
  listed every co-author pair beside it). Documented ceiling: with only co-author keys selected, a
  roster-confirmed pair reads as an inference, because the roster was never read. The upgrade path
  is a "confirmed elsewhere" annotation.
- **Scope-derived default.** An `md` holder opens on AOC only; a `*` holder on every confirmed type.
- **Mentor department and institution** (Summary table + workbook, one line per mentor). Department
  = `Scholar.primaryDepartment` (ED), else the first pair source that names one: the roster's
  `mentorDepartment` (null on ~9 in 10 rows), Jenzabar's (`phd_mentor_relationship.mentor_department`,
  the Grad School department, on nearly every thesis row), the ED postdoc pass's
  (`postdoc_mentor_relationship.mentor_department`, the manager's `ou=people` primary department).
  Institution = the first source that names one, same order (roster free text; Jenzabar
  "Sloan-Kettering" / "Weill Cornell" / "HSS"; the ED primary-organization code), else
  `Scholar.primaryOrgCode`, every value folded to WCM / MSKCC / HSS (`mentorInstitution` in the
  loader — codes named through `lib/institutions.ts` first; anything else passes through), else WCM
  when the mentor has a Scholar row, else "—". Mentor name falls through the same way (Scholar, then
  roster / Jenzabar / ED postdoc pass, then the bare CWID). The roster fields ride the bridge
  (`aoc_mentee.mentor_department` / `mentor_institution`, empty until the bridge is re-exported and
  re-imported); the ED postdoc pass fills its four mentor columns on the nightly ED run. A postdoc
  "mentor" with no Scholar row is usually the lab administrator HR lists as manager (#2633) — the
  name and department now make that visible rather than hiding it behind a bare CWID.
- **Words.** The `md` bucket is labelled "MD" (the degree) since 2026-09-20; "AOC" survives in the
  hovers and the report description as the source (the pairing sheet), never as a label.
  Per-pair labels read by category ("AOC", "PhD thesis advisor", "Postdoc supervisor",
  "Volunteer · likely mentee (from co-authorship)"); "presumptive", "ambiguous", "roster",
  "Jenzabar" and "ED" never appear in a label. The `mentorshipKey` (`program:source:tier`) keeps the
  schema words because it is a dedupe key, not a label.

## Open data asks

- MD-PhD program-office rows carry no entry or graduation year, so those learners always sit under
  "No grad year" (reachable only with "Include learners with no graduation year") with null
  in-window counts.
- Jenzabar carries a conferral year but no start year, so a thesis-advisor pair has no window
  unless another source supplies an entry year.
- Roughly 14% of ED postdoc managers on record are lab administrators rather than the PI (#2633).
- The Faculty Review Tool's mentoring extract (self-reported mentees) has not been provided
  (#1855 handoff); until it is, it is named in the Sources disclosure as not yet a source.
