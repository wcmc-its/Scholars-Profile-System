# Report access grants and the Top clinical and high-impact journal publications report

**Status:** Live in both environments. Shipped in #2748 (grants for reports 8 and 9, report 9
itself), #2750 (report 9's per-person Summary, the shared download button) and #2754 (body-only
loading skeleton). No env flag: a report is reachable wherever the app image is deployed and the
viewer passes its gate.

This doc answers two questions: **who can open a report under `/edit/reports`**, and **what report 9
(Top clinical and high-impact journal publications) counts and exports**. Report 7's own sources
and rules are in [`mentored-publications-report.md`](./mentored-publications-report.md).

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
as-is. "Reset to defaults" (in the rail header, disabled while the defaults are on) returns to them.
Report 9 does not take report 8's default of the viewer's own units.

The rail (shared `ReportRail` / `RailSection`, `components/edit/reports/report-ui.tsx`) has one
collapsed section per filter, each showing its current value, in this order:

| Section | Params | Notes |
|---|---|---|
| Years | `basis`, `from`, `to` | Calendar year, or fiscal year (July–June, named by the ending year, by the date the article was added to PubMed; `basis=fy`, report 8's rule in `scopeSql`). No `basis` = calendar, which is what every earlier link meant. |
| Journals | `journal` (repeated family keys) | None checked = all ten families. |
| Person type | `type` | The Profiles roster's facet (`parsePersonFilter`). |
| Department / division | `unit=dept:` / `div:` | Searchable, first 8 then "Show all". |
| Centers | `unit=center:` | Searchable, first 6 then "Show all". |
| Institution | `unit=inst:` | |
| Article type | `atype` (repeated) | None checked = all. |
| Author position | `pos` | `any`, `first`, `last`, `either` (first or last). |

Numbers beside the who-filter options count active people (`loadDataQualityFacets`), not articles.
`jif` is ignored: a minimum impact factor belongs to report 8. The form submits on every change
(`AutoSubmitForm`); below `lg` the rail opens from a "Filters (n)" button (`FiltersSheet`).

Above the tabs: the number of matching scholars and distinct publications, the Download button with a
note naming the sheets it includes (and, in amber, any sheet withheld and why), and the active
filters as chips. Removing a chip drops only that value; years, and journals when all are on, have no
remove button.

### Tabs

The tab is the `view` param (`summary` = Scholars, `publications`), so old links keep their tab. The
find box, sorts, expanded row and "Show 25 more" paging are page state, not params.

- **Scholars (N):** one row per matching person (`summarizePeople`): name (hover card), CWID,
  department (plus person type when more than one is selected), articles, "x first y last", summed NIH
  citations, and journal chips (two, then "+N more"). Sorted by articles; the Scholar, Articles and
  Citations headers re-sort. "Find a scholar" filters by name or CWID. Selecting a row lists that
  scholar's publications, newest first, with their position on each. The table scrolls inside its
  card on a phone.
- **Publications (N):** one entry per article: title (linked to PubMed), the byline with the matching
  WCM authors in bold (long bylines keep the first three, every matching author and the last), journal
  and citation, then article type, the matching scholars with their positions, NIH citations, journal
  impact factor, date added to PubMed, DOI and PMID. Sort: newest first (default), most cited, journal
  A–Z, or highest impact factor (the order the page used before the redesign, and still the download's).

**NIH citations** are `publication.cited_by_count` (the iCite count), not the Scopus `citation_count`.

### The `.xlsx` download

Three sheets, same query string as the page:

- **People:** the Scholars tab as a sheet, **only when 50 or fewer people match.** A list of scholars
  is a scholar export, so it follows the standing `SCHOLAR_EXPORT_CAP` rule (`lib/api/export-scholars.ts`):
  above 50 the sheet is withheld and says how many matched and to narrow the filters. It is never
  truncated to fit. With the awards defaults this cap is usually exceeded; narrow by department to
  get the sheet. The page's Scholars tab still lists everyone, and the note under the Download button
  says when the sheet is left out.
- **Publications:** every article with title, journal, impact factor, WCM first/last authors, date
  added to PubMed, NIH citation count, article type, year, DOI; highest impact factor first.
- **Criteria:** every filter, "All" when unset, including the year basis.

Above `HIGH_IMPACT_LIST_CAP` (5,000 articles) the page and workbook skip the article list and ask for
narrower filters; the headline numbers still show.

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
