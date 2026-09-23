/**
 * Report 7 — "Mentored publications". For every learner in a
 * (learner, mentor) pair — the AOC pairing sheet (which also carries the
 * MD-PhD program office's list), Jenzabar thesis advisors, ED postdoc
 * appointments, co-author inferences — every publication co-authored with
 * one of their mentors, with Journal Impact Factor and NIH iCite citations,
 * plus per-learner counts (`lib/edit/mentored-publications-report.ts`). The
 * Areas of Concentration (AOC) office's annual spreadsheet, on demand: the
 * summary table in-page and the full three-sheet workbook behind
 * "Download .xlsx" (`/api/edit/reports/mentored-publications`, same query
 * string). Every label speaks the office's language (`AOC`, never the
 * `md` bucket key; "likely", never "presumptive") — `lib/edit/mentorship-type.ts`
 * — and each type carries a hover (`HoverTooltip`, a client module, so it
 * is safe in this server module). What each source carries and lacks, and the
 * one not yet loaded (the Faculty Review Tool's self-reported mentees), is
 * the report's editable description — `report_meta` row '7', rendered by
 * `ReportHeader` as the closed "About this report" disclosure (it replaced
 * the hardcoded "Sources" disclosure the page used to draw).
 * `docs/mentored-publications-report.md` is the long form.
 *
 * Two in-page views (`view=summary|publications`, underline tabs the client
 * island owns — both views ride on the same loaded report, so a tab click
 * switches instantly and only rewrites the URL): Learners — the per-learner summary — and Publications — one row per
 * distinct paper, most recently added to PubMed first, as a Vancouver
 * citation with its PMID link, JIF, iCite count, the learner(s) and
 * mentor(s) on it. Both tables are ONE client island
 * (`components/edit/mentored-publications-table.tsx`): an in-memory facet
 * rail (year, author position, window, mentor) and sortable headers over
 * the rows this body loads in one shot; the download is server-filtered
 * only (types / years / set / tail), never by the rail.
 * "Type of mentorship" (`mtype=`, a checkbox group in the filter form) is
 * SERVER-side on purpose: the loader reads only the sources the selected
 * types need, so an AOC-office holder sees AOC-defined pairs and nothing
 * inferred (`lib/edit/mentorship-type.ts`; the choices offered and the
 * default are resolved against the caller's scopes — a roster type is
 * offered only when its scope is held, co-author inferences are never on by
 * default; "Faculty-asserted" — the mentor's own `manualMentees` — is a
 * confirmed source, on for a `"*"` holder, and its CWID-less entries get
 * their own count sentence). Two publication sets (`pubs=mentored|all`, a select in the
 * filter form):
 * the co-pubs with a mentor (default), or every publication of the
 * learner from the `aoc_mentee_publication` bridge, each flagged for a mentor
 * co-author. Both params ride every tab link and the download link; `view`
 * is page-only.
 *
 * NOT unit-scoped like reports 1–6: access is a `report_access` row
 * (`lib/edit/report-access.ts`) — the dynamic page's PERSON gate (registry
 * `accessKey: MENTORED_PUBS_REPORT`): no session → SSO login; an empty scope
 * set → `notFound()`. This body receives the non-empty `scopes`. Filters are
 * plain GET params (`parseMentoredPubsParams`) — a server re-render per
 * change, no client state, like `/edit/data-sharing`'s filter bar; the form
 * is the `AutoSubmitForm` island so a change submits without an Apply click
 * (the button stays as the no-JS fallback). Its `action` and every tab href
 * are built on `basePath` — the canonical `/edit/reports/<slug>` the page
 * hands in — never a literal path, since the slug is renameable. The "Who
 * can run this report" popover (`ReportAccessPopover`, `mode="person"`) is
 * the PAGE's: it composes the header, so it reads the grant rows itself
 * (`listReportAccess`) and this body never sees them.
 *
 * The body of what was `app/edit/reports/7/page.tsx`, moved verbatim into the
 * registry shape (`lib/edit/report-registry.ts`) apart from `basePath`: the
 * session / gate / shell / header frame is the dynamic page's; this owns
 * only the report. The mode-aware subtitle `<p>` is returned as `subtitle`
 * (the header's children).
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { MentoredPublicationsTable } from "@/components/edit/mentored-publications-table";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import {
  mentoredPubsQueryString,
  parseMentoredPubsParams,
  type MentoredPubsParams,
} from "@/lib/edit/mentored-publications-params";
import {
  DEFAULT_TAIL,
  defaultMentoredPubsYears,
  HIGH_IMPACT_THRESHOLD,
  loadMentoredGradYears,
  loadMentoredPublicationsReport,
  MAX_TAIL,
} from "@/lib/edit/mentored-publications-report";
import {
  allowedMentorshipTypes,
  MENTORSHIP_TYPE_DESCRIPTION,
  MENTORSHIP_TYPE_LABEL,
  resolveMentorshipTypes,
  type MentorshipTypeKey,
} from "@/lib/edit/mentorship-type";
import type { PersonReportProps, ReportRender } from "@/lib/edit/report-registry";

// Underline tabs, as `components/edit/matcha-tab.tsx` draws them. `basePath`
// is the page's canonical `/edit/reports/<slug>`.
function pageHref(basePath: string, params: MentoredPubsParams): string {
  return `${basePath}?${mentoredPubsQueryString(params)}`;
}

/** `RosterFacet`'s heading / option / checkbox vocabulary, so the server
 *  form reads as one rail with the client facets beneath it. */
const RAIL_HEADING = "mb-2 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const RAIL_OPTION = "flex items-start gap-2 py-[3px] text-[13px] leading-[1.4]";
const RAIL_BOX = "mt-[3px] accent-[var(--color-primary-cornell-red)]";

function FilterForm({
  basePath,
  params,
  yearChoices,
  typeChoices,
}: {
  basePath: string;
  params: MentoredPubsParams;
  yearChoices: ReadonlyArray<number | null>;
  typeChoices: ReadonlyArray<MentorshipTypeKey>;
}) {
  const selected = new Set(params.years ?? []);
  const allYears = params.years !== null && params.years.length === 0;
  const selectedTypes = new Set(params.types ?? []);
  return (
    // Lives at the top of the table island's facet rail (its `children`), so
    // it is laid out as a rail section: one column, `RosterFacet`'s heading
    // style (`components/center/center-roster-facets.tsx`), no box of its own.
    <AutoSubmitForm
      id="mentored-pubs-filters"
      action={basePath}
      className="group flex flex-col text-sm"
      data-testid="mentored-pubs-filters"
    >
      {/* The current view rides along as a hidden input the island owns
          (`form="mentored-pubs-filters"`), so a filter change keeps it. */}
      <fieldset className="mb-5">
        <legend className={RAIL_HEADING}>Type of mentorship</legend>
        <div className="flex flex-col gap-1">
          {typeChoices.map((k) => (
            <label key={k} className={RAIL_OPTION}>
              <input type="checkbox" name="mtype" value={k} defaultChecked={selectedTypes.has(k)} className={RAIL_BOX} />
              {/* The hover wraps the TEXT only — never the input, whose click
                  must stay a plain toggle. */}
              <HoverTooltip text={MENTORSHIP_TYPE_DESCRIPTION[k]} wide>
                <span>{MENTORSHIP_TYPE_LABEL[k]}</span>
              </HoverTooltip>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="mb-5">
        <legend className={RAIL_HEADING}>Graduation year</legend>
        <div className="flex flex-col gap-1">
          {yearChoices.map((y) => (
            <label key={y ?? "unknown"} className={RAIL_OPTION}>
              <input
                type="checkbox"
                name="years"
                value={y ?? "unknown"}
                defaultChecked={selected.has(y)}
                className={RAIL_BOX}
              />
              {y ?? "Unknown grad year"}
            </label>
          ))}
          <label className={RAIL_OPTION}>
            <input type="checkbox" name="years" value="all" defaultChecked={allYears} className={RAIL_BOX} />
            All years
          </label>
        </div>
      </fieldset>
      <label className="mb-5 flex flex-col">
        <span className={RAIL_HEADING}>Publications</span>
        <select
          name="pubs"
          defaultValue={params.pubs}
          className="w-full rounded border border-[#c8c6be] bg-white px-2 py-1"
          data-testid="mentored-pubs-set"
        >
          <option value="mentored">Co-authored with a mentor</option>
          <option value="all">All learner publications</option>
        </select>
      </label>
      <label className="mb-5 flex flex-col">
        <span className={RAIL_HEADING}>Years after graduation still counted</span>
        <select
          name="tail"
          defaultValue={String(params.tail)}
          className="w-full rounded border border-[#c8c6be] bg-white px-2 py-1"
        >
          {Array.from({ length: MAX_TAIL + 1 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </label>
      {/* No-JS fallback; the island hides it once hydrated. */}
      <button
        type="submit"
        className="border-foreground/40 hover:bg-apollo-surface-2 mb-5 self-start rounded border px-3 py-1.5 group-data-[hydrated=true]:hidden"
      >
        Apply
      </button>
    </AutoSubmitForm>
  );
}

/** Report 7's body: the filter rail + the Summary / Publications island (or
 *  the no-bridge notice), over the scopes the person gate resolved. */
export async function renderMentoredPublicationsReport({
  scopes,
  searchParams,
  basePath,
}: PersonReportProps): Promise<ReportRender> {
  // Malformed params fall back to the defaults (a page, unlike the download
  // route, has nothing useful to say with a 400).
  const parsed = parseMentoredPubsParams(searchParams);
  const requested: MentoredPubsParams = parsed.ok
    ? parsed.value
    : { years: null, types: null, tail: DEFAULT_TAIL, pubs: "mentored", view: "summary" };
  // Types outside the caller's scopes are silently dropped — never a wider set.
  const types = resolveMentorshipTypes(requested.types, scopes);
  const loaderScopes = [...scopes];

  const yearChoices = await loadMentoredGradYears(loaderScopes, types);
  // Years the chosen types have no class in are dropped (a type checkbox
  // auto-submits with the previous selection's years); nothing left → this
  // selection's default.
  const choiceSet = new Set(yearChoices);
  const kept = (requested.years ?? []).filter((y) => choiceSet.has(y));
  const years =
    requested.years === null || (requested.years.length > 0 && kept.length === 0)
      ? defaultMentoredPubsYears(yearChoices)
      : kept;
  const params: MentoredPubsParams = {
    years,
    types,
    tail: requested.tail,
    pubs: requested.pubs,
    view: requested.view,
  };

  const report = await loadMentoredPublicationsReport({
    scopes: loaderScopes,
    types,
    gradYears: years.length > 0 ? years : null,
    tail: params.tail,
    pubs: params.pubs,
  });

  const typeChoices = allowedMentorshipTypes(scopes);

  const allMode = params.pubs === "all";
  const allPubsMissing = allMode && report.allPubsLoaded === false;
  // The download never carries `view` (the workbook has no Publications view).
  const qs = mentoredPubsQueryString({ ...params, view: "summary" });
  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        {allMode
          ? "Every publication of each learner, with the ones co-authored with one of their mentors flagged, "
          : "Every publication a learner co-authored with one of their mentors, "}
        with Journal Impact Factor and NIH iCite citations &mdash; the sources are under &ldquo;About
        this report&rdquo;. &ldquo;In window&rdquo; means entry year &le; publication year &le;
        graduation year + {params.tail}; an MD learner with no entry year on the pairing sheet is
        assumed to have entered four years before graduating.
        {report.droppedUnresolved > 0 &&
          ` ${report.droppedUnresolved.toLocaleString()} co-publications not yet in the local corpus are not shown.`}
        {report.droppedNoCwid > 0 &&
          ` ${report.droppedNoCwid.toLocaleString()} faculty-asserted mentees have no CWID and are not shown.`}
      </p>
    ),
    main: (
      <>
        {/* The filter form is the table island's `children` — the top of its
            rail. Only the no-bridge notice below renders it standalone (the
            island is skipped, and "Publications" must stay switchable). */}
        {allPubsMissing && (
          <div className="border-apollo-rail-border bg-apollo-rail mt-4 rounded-xl border p-3 md:w-64">
            <FilterForm basePath={basePath} params={params} yearChoices={yearChoices} typeChoices={typeChoices} />
          </div>
        )}
        {allPubsMissing && (
          <p
            className="border-apollo-border bg-apollo-surface-2 mt-4 rounded-md border px-3 py-2 text-sm"
            role="status"
            data-testid="mentored-pubs-all-missing"
          >
            All-publication data has not been loaded yet. The learner publication bridge (
            <code>etl:mentoring:import-learner-pubs</code>) has not run in this environment, so every
            count below would be zero. Switch &ldquo;Publications&rdquo; back to &ldquo;Co-authored
            with a mentor&rdquo; or run the import.
          </p>
        )}
        {allPubsMissing ? null : (
          <MentoredPublicationsTable
            view={params.view}
            viewHrefs={{
              summary: pageHref(basePath, { ...params, view: "summary" }),
              publications: pageHref(basePath, { ...params, view: "publications" }),
            }}
            downloadHref={`/api/edit/reports/mentored-publications?${qs}`}
            summary={report.summary}
            publications={report.publications}
            pubsMode={params.pubs}
            highImpactThreshold={HIGH_IMPACT_THRESHOLD}
          >
            <FilterForm basePath={basePath} params={params} yearChoices={yearChoices} typeChoices={typeChoices} />
          </MentoredPublicationsTable>
        )}
      </>
    ),
  };
}
