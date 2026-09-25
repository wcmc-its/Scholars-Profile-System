# Report access grants and the Top clinical and high-impact journal publications report

**Status:** Live in both environments. Shipped in #2748 (grants for reports 8 and 9, report 9
itself), #2750 (report 9's per-person Summary, the shared download button) and #2754 (body-only
loading skeleton). No env flag: a report is reachable wherever the app image is deployed and the
viewer passes its gate.

This doc answers three questions: **who can open a report under `/edit/reports`**, **what report 8
(Article counts) filters, shows and exports**, and **what report 9 (Top clinical and high-impact
journal publications) counts and exports**. Report 7's own sources and rules are in
[`mentored-publications-report.md`](./mentored-publications-report.md).

## Who can open which report

Every report is one entry in `lib/edit/report-registry.ts`, rendered by the single dynamic page
`app/edit/reports/[report]/page.tsx`. The entry's `gate` decides access before any report data is read:

| Report | Gate | Who passes |
|---|---|---|
| 1–6 (unit reports) | `unit` | Owners and Curators of the unit the report is opened for, plus superusers and comms stewards |
| 7 Mentored publications | `person` on `mentored-publications` | A `report_access` row (scoped by program), plus superusers and comms stewards |
| 8 Article counts | `admin` | Any unit administrator (`canViewUsage`), comms stewards, **or** an `article-count` row |
| 9 Top clinical and high-impact journal publications | `person` on `high-impact-publications` | A `report_access` row, plus superusers and comms stewards |

A viewer who fails a `person` or `admin` gate gets a 404: the report reads as unbuilt to someone it
was never granted to. A unit-gate failure shows the visible 403 page.

### Per-person grants (`report_access`)

Reports 7, 8 and 9 can be granted to individual people who hold no unit role, typically staff in a
program office. A grant is a row `(report_key, scope_key, cwid)` plus `granted_by`, `granted_at` and
the grantee's directory name (`grantee_name`, stored because the app runtime cannot reach LDAP).

- **Grantable keys and scopes** live in `REPORT_ACCESS_SCOPE_OPTIONS` (`lib/edit/report-access.ts`).
  Report 7 has program scopes (`md`, `mdphd`, `ecr`, or `*`). Reports 8 and 9 take the whole-report
  wildcard `*` only.
- **Who can grant:** superusers and comms stewards (`canManageReportAccess`).
- **Where:** on the report page, the badge beside the title names the default audience ("All unit
  administrators" for report 8, "Superusers and comms stewards" for 7 and 9, "Unit owners and
  curators" for 1–6) plus "+ N others" for the grantees, and opens a read-only list of them. Add /
  Remove live in the page's "Edit details" sheet (its Access section; "Manage access" for a comms
  steward who is not a superuser). On the reports index, each row's people icon still opens the list
  with Add / Remove. Both list current grantees for every viewer and show Add / Remove only to
  someone who can grant. Writes go to `POST /api/edit/report-access` and apply at once.
- **Request record:** "Edit details" also holds who asked for the report, when, and a memo
  (`report_meta.requested_by` / `requested_on` / `request_memo`). Superusers only; never shown on
  the report.
- **Audit:** each grant or revoke writes a B03 audit row in the same transaction
  (`report_access_grant` / `report_access_revoke`, entity `report_access`).
- **Landing:** a grant-only holder who opens `/edit` (no Scholar row, no role, no proxy grant) is sent
  to `/edit/reports`, which lists exactly the reports they can run. Any grant also shows the console's
  Reports tab (`hasAnyReportAccess`).

Grantee CWIDs live in the table, never in this repo.

## Report 8 — Article counts

`/edit/reports/8` redirects to `/edit/reports/article-count`. Distinct articles per year for the
scholars matching the filters; an article counts once however many matching authors it has.

Code: `lib/edit/article-count-report.ts` (params, unit default, loaders, workbook),
`components/edit/reports/article-count-body.tsx` (page body), `lib/edit/cwid-list.ts` and
`app/api/edit/reports/article-count/cwid-list/route.ts` (the CWID list),
`app/api/edit/reports/article-count/route.ts` (`.xlsx`). The page and the download share
`parseArticleCountParams` + `resolveArticleCountParams`.

### What counts

- only ReCiter-confirmed authorships (`is_confirmed`) of active, non-deleted scholars;
- person type and units are the scholar's **current** values, so historical numbers drift slightly;
- a `div:` unit matches the directory division code **and** a manual division's hand-added members
  (`division_membership` when `division.source = 'manual'`), the same members a division's own page
  and report 3 use (`loadDivisionMemberCwids`). Before 2026-09-24 it matched the directory code only,
  so division counts on reports 8 and 9, the Profiles roster and ORCID coverage can be higher than
  before for manual divisions. The rule lives in `lib/edit/person-filter.ts` (`personFilterSql` and
  `personFilterWhere`), shared by every who-filter.

### URL parameters

Every parameter is optional; an unknown value falls back to its default, never a 400.

| Param | Meaning |
|---|---|
| `type` (repeated) | person type (raw role category) |
| `unit` (repeated, OR'd) | `dept:` / `div:` / `center:` / `inst:` + code |
| `list` | a stored CWID list's id (below); ANDs with the other people filters |
| `basis`, `from`, `to` | `cy` (calendar year of publication, default) or `fy` (July–June, by PubMed add date, named by the ending year); the year range, default the last five years |
| `basis=added`, `added_from`, `added_to` | the date the article was added to PubMed (ISO dates, inclusive), grouped by year added; replaces `basis` / `from` / `to`. The dates alone (no `basis`) select it too; an explicit `basis=cy` or `fy` wins over stale dates. `basis=added` with no dates means the last 30 days |
| `atype` (repeated) | article type |
| `jif` | minimum Journal Impact Factor, one decimal (articles in journals with no JIF on file are excluded when set) |
| `pos` | `any` / `first` / `last` / `either` author position |
| `f=1` | a submitted form (see the unit default) |
| `tab`, `year` | view only: the Articles tab and a year pick; never filters, never in the download |

### Unit default

A **bare** URL (none of the filter params above, `f` included) sets `unit` to the viewer's own units
from `loadManageableUnits` (their direct `unit_admin` grants): department → `dept:`, division → `div:`,
center → `center:`, institution → `inst:`. Cores are skipped (a core's publications come from core
usage, not people). Superusers, comms stewards and `report_access` grantees with no units get no
default (the whole institution). It is a default, not a restriction: the viewer can untick it or pick
any other unit. The rail form carries `f=1` and every link the page builds carries it too, so clearing
every filter never brings the default back; "Reset to defaults" goes to the bare URL.

### CWID list

The People group's "CWID list" section takes pasted CWIDs with any separator (`parseCwidText`,
`lib/cwid-list-text.ts`): lowercased, deduplicated, anything not CWID-shaped is named and skipped.
"CWID-shaped" is `CWID_PATTERN` (`lib/cwid.ts`: a letter then 2–31 letters or digits). It requires no
digit, because legacy all-letter CWIDs exist, so any word of three or more letters (a surname, a
"cwid" header) is kept as an entry. The rail therefore counts "entries", not CWIDs, and every entry
that matches no active scholar is listed as not found.
"Apply list" stores it through `POST /api/edit/reports/article-count/cwid-list` (gate:
`canViewArticleCountReport`; at most 5,000 CWIDs; not audited) in `report_cwid_list` (`id`, `cwids`
JSON, `created_by`, `created_at`). Rows are insert-only, so a shared link keeps meaning the same
people. The URL carries `list=<id>`. The rail shows how many entries matched an active scholar and
lists the ones that did not ("not found"); an unknown id matches no one. List contents live in the table, never in this
repo.

### Page

- **Rail:** Years (calendar / fiscal / date added; the From / To dates apply on Enter, "Apply dates"
  or leaving the field, never per keystroke, and the Last 30 / 60 / 90 days quick picks apply at once), Person
  type, Department / division, Centers, Institution, CWID list, Article type, Journal Impact Factor
  (Any / ≥ 3 / ≥ 5 / ≥ 10, or an exact minimum), Author position. Filters apply automatically; the
  numbers beside options count active people, not articles. Below `lg` the rail opens from a
  "Filters (n)" button.
- **Headline:** the distinct-article total, Download .xlsx and its note, removable chips for every
  filter (the year window is a fixed chip).
- **By year:** a bar per year; the in-progress calendar or fiscal year is badged YTD. Selecting a year
  opens the Articles tab for that year, with a removable "Year" chip. The download still covers the
  whole window, and its note says so while a year is picked.
- **Articles (N):** one citation per article (matching scholars in bold, with the scholar hover card;
  a matching scholar whose author position is unknown, rank 0, is listed on a "WCM authors:" line),
  sorted Newest first, by Journal Impact Factor or Journal A–Z, 25 at a time. Above 5,000 articles
  (`ARTICLE_LIST_CAP`, the download's limit too) the list is replaced by a prompt to narrow the
  filters, with two common combinations (first or last author with JIF ≥ 10; full-time faculty as last
  author).

### The `.xlsx` download

- **Counts:** one row per year and the total.
- **Criteria:** every filter ("All" / "None" when unset), including the CWID list (its id, size, and
  the CWIDs not found among active scholars) and the window (years and basis, or the date-added
  range).
- **Articles:** one row per article with its matching scholars, only up to 5,000 articles; above that
  the sheet says so.

## Report 9 — Top clinical and high-impact journal publications

`/edit/reports/9` redirects to `/edit/reports/high-impact-publications` (the slug is renameable from
the report's "Edit details", like every report). It was built for the yearly request for nominees for the
Top Ten Clinical Research Achievement Awards: original research in top journals by full-time WCM
faculty as first or last author.

Code: `lib/edit/high-impact-pubs-report.ts` (params, journal families, loaders, workbook),
`components/edit/reports/high-impact-publications-body.tsx` (page body),
`app/api/edit/reports/high-impact-publications/route.ts` (`.xlsx`).

### What counts

The scope is report 8's (`scopeSql` in `lib/edit/article-count-report.ts`), plus a journal clause, so
the two reports never disagree about who counts:

- only ReCiter-confirmed authorships (`is_confirmed`) of active, non-deleted scholars;
- person type and units are the scholar's **current** values, so historical numbers drift slightly;
- author position comes from `publication_author.is_first` / `is_last`.

### Journal families

Matched on `publication.journal_abbrev` (the NLM abbreviation), not the full title:

| Family | Matches |
|---|---|
| JAMA (all JAMA journals) | `JAMA`, or anything starting `JAMA ` |
| The Lancet | `Lancet` only; Lancet Oncology and the other Lancet journals are **not** included |
| NEJM (all NEJM journals) | `N Engl J Med`, or anything starting `NEJM ` |
| Journal of Clinical Oncology | `J Clin Oncol` |
| Science Translational Medicine | `Sci Transl Med` |
| Nature (all Nature journals) | `Nature`, or anything starting `Nat `, **except** `Nat Prod Rep`, `Nat Prod Res`, `Nat Prod Commun`, `Nat Sci Sleep` (other publishers' titles sharing the prefix) |
| Blood, Circulation, Science, Cell | exact abbreviation |

The Nature family includes Nature Communications and the Nature Reviews journals; the article-type
filter normally removes the reviews. If a non-Nature journal ever turns up under Nature, add its
abbreviation to `NOT_NATURE`.

### Defaults and filters

A bare URL (nothing but `view`) opens on the awards defaults: person type **full-time faculty**,
article type **Academic Article**, author position **first or last author**, the **current calendar
year**, every journal family. Any filter in the URL means the form was submitted, and the URL is taken
as-is. "Reset" returns to the defaults.

Rail facets: years (from / to), journal families (none checked = all), the Profiles roster's person
type and department / division / center / institution facets, article type, author position.

### Tabs

- **Summary:** one row per matching person (`summarizePeople`): name, CWID, person type, department,
  articles, first-author count, last-author count, summed NIH citations, and journals (most articles
  first). Sorted by article count. The page lists everyone.
- **Publications:** one row per article, highest impact factor first: title (linked to PubMed),
  journal, impact factor, the WCM first/last author(s), date added to Entrez, NIH citations.

**NIH citations** are `publication.cited_by_count` (the iCite count), not the Scopus `citation_count`.

### The `.xlsx` download

Three sheets, same query string as the page:

- **People:** the Summary as a sheet, **only when 50 or fewer people match.** A list of scholars is a
  scholar export, so it follows the standing `SCHOLAR_EXPORT_CAP` rule (`lib/api/export-scholars.ts`):
  above 50 the sheet is withheld and says how many matched and to narrow the filters. It is never
  truncated to fit. With the awards defaults this cap is usually exceeded; narrow by department to
  get the sheet. The page's Summary tab still lists everyone.
- **Publications:** every article with title, journal, impact factor, WCM first/last authors, Entrez
  date, NIH citation count, article type, year, DOI.
- **Criteria:** every filter, "All" when unset.

Above `HIGH_IMPACT_LIST_CAP` (5,000 articles) the page and workbook skip the article list and ask for
narrower filters.

### Known limitations

- **"Original research" is approximate.** It relies on the canonical publication type
  `Academic Article`, which occasionally includes review-style papers. Check the list before sending it.
- **Lancet means The Lancet.** The request named variations only for JAMA, NEJM and Nature.

## Shared report UI conventions

- **Download button:** every report with a download uses the shared `Button` in the `apollo` (maroon)
  variant with a `Download` icon, near the top of the report (reports 1, 2, 7, 8, 9). Reports 3–6 have
  no download.
- **Loading:** there is no route `loading.tsx`. The page renders the console shell, back link and
  report title at once, and streams the report body under `Suspense` with a body-shaped skeleton
  (`ReportBodySkeleton`). The boundary is keyed on the query string, so a filter change shows the
  skeleton again instead of leaving stale results up. `/edit/data-sharing` follows the same pattern.

## Adding a person-granted report

The checklist lives in the module comment of `lib/edit/report-registry.ts` ("Adding a report —
checklist"). For a report granted per person, in addition:

1. Add its key constant and scope options to `REPORT_ACCESS_SCOPE_OPTIONS` in
   `lib/edit/report-access.ts`. The grant route validates against that map; no migration is needed
   (`report_key` is a VARCHAR, and the audit entity and actions already exist).
2. Give the registry entry `gate: "person"` and `accessKey: <your key>`.
3. Add its number and defaults to `REPORT_KEYS` / `REPORT_META_DEFAULTS` (`lib/edit/report-meta.ts`),
   and to the index's institution row in `app/edit/reports/page.tsx` if it should list there.
4. Build its popover props with `loadReportAccessPopoverProps` (`lib/edit/report-access-popover-props.ts`).
5. Any scholar list in its export must honor `SCHOLAR_EXPORT_CAP`.
