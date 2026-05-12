# Jenzabar `WCN_vw_GS_Faculty_LR` — discovery probe

Discovery writeup for the Graduate School faculty appointments import (issue #193). Captures what the view exposes, settles the three open scoping decisions, and unblocks the ETL+rendering issue.

**Source:** Jenzabar view `WCN_vw_GS_Faculty_LR`
**Probe script:** `etl/jenzabar/probe-gs-faculty.ts`
**Run:** `npm run etl:jenzabar:probe-gs-faculty`
**Probe date:** 2026-05-12
**Sibling probe (PhD mentors):** `etl/jenzabar/probe.ts` → `WCN_IDM_GS_ADVISOR_ADVISEE_View`

> Jenzabar's upstream naming is inconsistent (`WCN_IDM_*` vs `WCN_vw_*`). Flagged so future maintainers don't think they've misread the view name.

---

## 1. Connection + view location

- Server: `JZWCN-SQL-PRD`
- Login: `IDM_JZBR`
- Default DB: `TmsEPly`
- View resolved at: `[TmsEPly].[dbo].[WCN_vw_GS_Faculty_LR]`

## 2. Column list (32 columns)

```
JID                              int       NO
FIRST_NAME                       varchar   YES
MIDDLE NAME                      varchar   YES
LAST NAME                        varchar   YES
Degree_Code                      nvarchar  YES   [SELECT DENIED — column-level permission]
CWID                             char      YES
EMAIL ADDRESS                    varchar   YES
INSTRUCTOR TYPE                  char      YES   (rank: Professor / Assistant Professor / …)
NAME STATUS                      char      YES   (A/I/null)
FACULTY MASTER ACTIVE            char      NO    (Y/N)
WCGS FACULTY STATUS              char      YES   (Y/N/null)
INSTITUTION                      char      YES   (home institution name)
Secondary_Institution            char      YES
Secondary_Instrctr_Type          char      YES
Tertiary_Institution             nvarchar  YES
Tertiary_Instrctr_Type           nvarchar  YES
Is_Grad_Faculty_Member           char      YES   (mirrors WCGS FACULTY STATUS exactly)
WCGS DIVISION                    char      YES   ("Located at …" strings)
DEPARTMENT                       char      YES   (home WCM department, NOT a GS program)
PRIMARY PHD AFFILIATION          char      YES   (GS PhD program 1)
PRIMARY PhD APPOINTMENT DATE     nvarchar  YES   (string-typed date "M/D/YYYY")
SECONDARY PHD AFFILIATION        char      YES   (GS PhD program 2)
SECONDARY PhD APPOINTMENT DATE   nvarchar  YES
TERTIARY PHD AFFILIATION         char      YES   (GS PhD program 3)
TERTIARY_APPOINTMENT_DATE        nvarchar  YES
MS AFFILIATION 1                 char      YES   (GS MS program 1)
MS APPOINTMENT DATE 1            datetime  YES   (proper datetime — distinct from PhD dates)
MS AFFILIATION 2                 char      YES
MS APPOINTMENT DATE 2            datetime  YES
TERMINATION_DATE                 nvarchar  YES   (rarely populated)
FACULTY_VIVO_PROFILE             varchar   YES
LAB_LINK                         varchar   YES
```

> **Permission caveat:** the `IDM_JZBR` principal has SELECT denied on column `Degree_Code`. Any `SELECT *` or `COUNT(*)` query that doesn't list columns explicitly fails. The probe and import must enumerate allowed columns. If new denied columns appear, extend `DENIED_COLUMNS` in `probe-gs-faculty.ts`.

## 3. Row counts

- **Total rows:** 775
- **`FACULTY MASTER ACTIVE = 'Y'`:** 622 (these are "currently on master roster"; differs from WCGS status)
- **`WCGS FACULTY STATUS = 'Y'`:** 561 (active current Grad School faculty)
- `WCGS FACULTY STATUS = 'Y'` ≡ `Is_Grad_Faculty_Member = 'Y'` — same column, two names
- `TERMINATION_DATE` populated on only 20 rows — not the active-flag.

**ETL active filter:** use `[WCGS FACULTY STATUS] = 'Y'` (561 rows). Master-active without WCGS status means the faculty exists in Jenzabar's master roster but is not currently appointed to the Grad School.

## 4. Identifier shape

- **CWID exposed directly.** 737 of 775 rows (95.1%) have a CWID. The 38 rows without CWID are non-WCM faculty (typically MSK or Rockefeller appointees without WCM credentials).
- **No bridge needed.** CWID is the natural join key to `Scholar.cwid`.
- Per-row uniqueness: 737 distinct CWIDs out of 737 with-CWID rows → **strict 1:1**.
- JID (Jenzabar internal ID) is also present and unique (775 distinct of 775).

## 5. Title / rank field

- Column: `INSTRUCTOR TYPE`
- Distribution (top 20): Professor (328), Assistant Professor (157), Associate Professor (140), null (66), Instructor (24), Adjunct Professor (22), Adjunct Associate Professor (14), Professor/Chair (9), Adjunct Assistant (8), Course Director (2), Associate Dean (2), Retired (2), Dean (1).
- **Recommendation:** use `INSTRUCTOR TYPE` directly as `Appointment.title`. Null → null (no fabricated rank).

## 6. Date fields

- **Active-flag filter (SQL-level):** `[WCGS FACULTY STATUS] = 'Y' AND CWID IS NOT NULL AND CWID <> ''`.
- **Appointment start date:** mixed type — PhD slots store `nvarchar` strings like `"7/19/2013"`; MS slots store proper `datetime`. The import must normalize: parse the nvarchar string with a permissive parser and fall back to null when invalid. For a single-row-per-faculty design (Decision 3 below), the MIN of all non-null appointment dates becomes the row's `startDate`.
- **End date:** the schema has no per-appointment end-date columns. `TERMINATION_DATE` exists but is populated on only 20/775 rows and applies to the faculty roster as a whole, not to a specific appointment. End-dates are not represented in the source. Per the ED-appointment precedent (`etl/ed/index.ts:710-713`), the import should write `endDate: null` and rely on the hard delete-and-replace pattern: when a faculty leaves WCGS, their next-run rows simply disappear.

## 7. Multiplicity (DECIDES THE UPSERT KEY)

**Rows per CWID is strictly 1:1.** The schema is **wide**: each faculty appears as exactly one row, with up to 3 PhD program slots + 2 MS program slots stored as parallel columns.

```
rows-per-CWID   count
1               737   ← every CWID
```

PhD program density (active and inactive combined):

```
phd-slots-filled  count
0                 248
1                 417
2                 104
3                   6
```

Among the 527 rows with ≥1 PhD affiliation, 110 (20.9%) hold 2 or 3 PhD programs.

MS program density:

```
ms-slots-filled  count
0                564
1                200
2                 11
```

**Upsert key:** `(cwid, source)` — one row in `Appointment` per faculty per source. The ETL never produces duplicate rows for the same CWID under `JENZABAR-GSFACULTY`; the wide-to-long transform happens in TypeScript (collapse the 3 PhD + 2 MS slots into a single rendered row, see Decision 3).

## 8. Program field shape

- The `PRIMARY/SECONDARY/TERTIARY PHD AFFILIATION` and `MS AFFILIATION 1/2` columns hold **Grad School program names**, not WCM department names. These are distinct entities.
- Top program values (from `PRIMARY PHD AFFILIATION`): Cell & Developmental Biology (130), Physiology, Biophysics & Systems Biology (96), Neuroscience (74), Immunology & Microbial Pathogenesis (67), Pharmacology (52), Molecular Biology (41), Biochemistry & Structural Biology (33), Population Health Sciences (20), Tri-I Program in Computational Biology & Medicine (8), Tri-I Program in Chemical Biology (2).
- Top MS program values: Clinical Epidemiology & Health Services Research, Clinical & Translational Investigation, Healthcare Policy & Research.
- The `DEPARTMENT` column is **separate** — it holds the faculty's home WCM department (Medicine, Pediatrics, etc.), unrelated to their GS program.

**Decision:** Programs do **not** map to existing `Department` rows in `prisma/schema.prisma`. They render as plain strings in `Appointment.organization`; no FK.

## 9. INSTITUTION breakdown

```
Weill Cornell Medicine             451
Memorial Sloan Kettering           200
(null)                              43
Rockefeller University              25
Hospital for Special Surgery        20
Houston Methodist                   16
Cornell University-Ithaca            5
Weill Cornell Medicine-Qatar         4
Glaxo Smith Kline                    3
Columbia University                  3
University of Pennsylvania           2
New York University                  2
Cold Spring Harbor Laboratory        1
```

The Grad School draws faculty across institutions. The ETL filters to scholars known to the system (`Scholar` table), so non-WCM-home faculty (MSK, Rockefeller, HSS, etc.) are naturally skipped — they have no `Scholar` row. No explicit institution filter needed in SQL.

## 10. Search-index facet check (`appointments.organization`)

- Longest observed program string: **"Tri-I Program in Computational Biology & Medicine"** (51 chars).
- After concatenation (Decision 3, option b), worst case is ~150 chars: `"Weill Cornell Graduate School — Cell & Developmental Biology, Physiology, Biophysics & Systems Biology, Neuroscience"`.
- Punctuation observed in samples: `&`, `,`. No control chars, no embedded HTML, no leading/trailing whitespace.
- **Action:** no facet-schema changes needed; the search-index ETL ingests `appointments.organization` as-is.

---

## Pinned decisions

### Decision 1 — Source-value naming convention: **adopt as proposed**

New sources follow `JENZABAR-<dataset>`:

- This issue: `JENZABAR-GSFACULTY`
- Issue #182 (PhD mentor): `JENZABAR-PHDMENTOR` (existing `JENZABAR-MAJSP` stays for backward compat; no migration)

### Decision 2 — ETL filename convention: **adopt as proposed**

`etl/jenzabar/` scripts follow `<verb>-<dataset>.ts`:

- This issue: `probe-gs-faculty.ts` (landed) → `import-gs-faculty.ts`
- Issue #182: rename `probe.ts` → `probe-phd-mentor.ts`, `index.ts` → `import-phd-mentor.ts` in a follow-up.

### Decision 3 — Multi-program rendering: **option (b), single row with concatenated programs**

Rationale: 21% of PhD-affiliated faculty hold ≥2 PhD programs, which exceeds the 20% threshold the issue itself called out as the gate for committing to a layout choice. Worst case is 5 programs (3 PhD + 2 MS) per faculty; rendering as 5 rows under the Grad School tier would dominate the appointments sidebar.

**Single-row design:**

- One `Appointment` row per WCGS faculty under source `JENZABAR-GSFACULTY`.
- `title`: `INSTRUCTOR TYPE` (e.g., "Professor"). Null when source is null.
- `organization`: the program(s) concatenated.
  - 0 programs: `"Weill Cornell Graduate School"` alone (covers 248 0-PhD-slot rows that may still be `WCGS FACULTY STATUS = 'Y'`; renders the affiliation without inventing program detail).
  - 1 program: `"Weill Cornell Graduate School — Immunology & Microbial Pathogenesis"`.
  - 2+ programs (PhD + MS pooled, deduped, in slot order): `"Weill Cornell Graduate School — Immunology & Microbial Pathogenesis, Pharmacology"`.
- `startDate`: MIN of all non-null appointment dates across the 5 slots (string-parsed). Null when all slots have null dates.
- `endDate`: always null (no per-appointment end-date in source; rely on hard delete-and-replace).
- `isPrimary`: always false (per issue #193 spec — Grad School is never the institutionally-primary appointment).

The em-dash separator (`—`) and comma list keep the string parseable for facet-clustering if needed later.

---

## Open follow-ups (note for issue #193)

1. **Date parsing**: build a tiny tolerant parser for the `nvarchar` PhD-appointment date strings. Sample values observed include `"7/19/2013"`, `"10/1/2013"`, `"12/1/2014"` (US M/D/YYYY) — likely format-stable but assume null on parse failure.
2. **`Tertiary_Institution` / `Secondary_Institution`**: these duplicate per-appointment institution context. Out of scope for the appointments-list view; the appointments-sidebar uses the single `INSTITUTION` only.
3. **`FACULTY_VIVO_PROFILE` / `LAB_LINK`**: not consumed by this ETL. The Scholars system already sources VIVO and lab links from ED/ASMS.
4. **Renaming PhD-mentor ETL filenames** to match the convention (Decision 2) is a follow-up commit — do not bundle into #193.

---

## Sample rows (active, full row dump)

```
JID                                1001386
FIRST_NAME                         Yuan-Shan
LAST NAME                          Zhu
CWID                               yuz2002
INSTRUCTOR TYPE                    Professor
FACULTY MASTER ACTIVE              Y
WCGS FACULTY STATUS                Y
INSTITUTION                        Weill Cornell Medicine
WCGS DIVISION                      Located at Weill Cornell
DEPARTMENT                         Pharmacology (← home WCM dept, NOT a GS program)
PRIMARY PHD AFFILIATION            Pharmacology
PRIMARY PhD APPOINTMENT DATE       7/19/2013
SECONDARY PHD AFFILIATION          (null)
TERTIARY PHD AFFILIATION           (null)
MS AFFILIATION 1                   (null)
TERMINATION_DATE                   (null)

JID                                1001391
FIRST_NAME                         Jenny
LAST NAME                          Xiang
CWID                               jzx2002
INSTRUCTOR TYPE                    Professor
FACULTY MASTER ACTIVE              Y
WCGS FACULTY STATUS                Y
INSTITUTION                        Weill Cornell Medicine
WCGS DIVISION                      Located at Weill Cornell
DEPARTMENT                         Microbiology and Immunology
PRIMARY PHD AFFILIATION            (null)  (← 0-PhD-slot, MS-only faculty)
MS AFFILIATION 1                   Clinical & Translational Investigation
```
