/**
 * Report 7 — "Mentored publications". For every learner in a
 * (learner, mentor) pair — the AOC pairing sheet (which also carries the
 * MD-PhD program office's list), Jenzabar thesis advisors, ED postdoc
 * appointments, co-author inferences, faculty-asserted mentees — every
 * publication co-authored with one of their mentors, with Journal Impact
 * Factor and NIH iCite citations, plus per-learner counts
 * (`lib/edit/mentored-publications-report.ts`). The Areas of Concentration
 * (AOC) office's annual spreadsheet, on demand: the tables in-page and the
 * three-sheet workbook behind "Download .xlsx"
 * (`/api/edit/reports/mentored-publications`, same query string).
 * `docs/mentored-publications-report.md` is the long form.
 *
 * Layout (reports redesign, 2026-09-24; build spec "Report 7", mockup
 * `Pub Reports/Mentored Publications Redesign.dc.html`), on the shared pieces
 * in `report-ui.tsx`: the filter rail (`MentoredPublicationsRail`, nine
 * sections in the spec's order, plus the Publications tab's Year facet kept)
 * beside a white card holding the headline numbers + Download and its note,
 * the "N distinct publications" line, the active-filter chips (× removes
 * one), the CWID-less faculty-asserted banner (its "View list" names each
 * dropped mentee and the mentor who added them — page-only, not in the
 * workbook), then the client island
 * (`components/edit/mentored-publications-table.tsx`: Learners (N) /
 * Publications (N) tabs, the find box, the tables, "Show 25 more") and the
 * footnote carrying the in-window rule. Below `lg` the rail moves into the
 * shared phone `FiltersSheet`.
 *
 * Every filter is a plain GET param (`parseMentoredPubsParams` — one parser
 * for this page and the download route). The loader reads the server filters
 * (`mtype`, `years`, `tail`, `pubs`); `applyMentoredPubsFacets` then narrows
 * its result by the rail's post-load facets (`window`, `position`, `pubyear`,
 * `mentor`, `withpubs`) — the route does the same, so the workbook holds what
 * the page shows. `view` and `q` are page-only. The form is the
 * `AutoSubmitForm` island (a change submits without an Apply click); its
 * `action`, every tab href and chip href are built on `basePath` — the
 * canonical `/edit/reports/<slug>` the page hands in — never a literal path,
 * since the slug is renameable.
 *
 * "Type of mentorship" (`mtype`) is SERVER-side on purpose: the loader reads
 * only the sources the selected types need, so an AOC-office holder sees
 * AOC-defined pairs and nothing inferred (`lib/edit/mentorship-type.ts`; the
 * choices and the default are resolved against the caller's scopes — a
 * roster type is offered only when its scope is held, co-author inferences
 * are never on by default). The rail splits the one param across two
 * sections: the program pairings, then the two co-authorship inferences.
 *
 * NOT unit-scoped like reports 1–6: access is a `report_access` row
 * (`lib/edit/report-access.ts`) — the dynamic page's PERSON gate (registry
 * `accessKey: MENTORED_PUBS_REPORT`): no session → SSO login; an empty scope
 * set → `notFound()`. This body receives the non-empty `scopes`; the page
 * owns the header (eyebrow, name, access badge, "Edit details", "About this
 * report"). The body returns a one-sentence `subtitle` (the in-window rule
 * lives in the Counting window section and the footnote, not the subtitle).
 */
import { Download } from "lucide-react";

import { FiltersSheet } from "@/components/edit/filters-sheet";
import { MentoredPublicationsTable } from "@/components/edit/mentored-publications-table";
import {
  INFERRED_TYPE_KEYS,
  MentoredPublicationsRail,
  PUBS_SET_LABEL,
} from "@/components/edit/reports/mentored-publications-rail";
import { FilterChips, ReportCard, ReportLayout, ReportStats, type FilterChip } from "@/components/edit/reports/report-ui";
import { Button } from "@/components/ui/button";
import {
  applyMentoredPubsFacets,
  mentoredPubsFacetOptions,
  POSITION_FACET_LABEL,
  WINDOW_FACET_LABEL,
} from "@/lib/edit/mentored-publications-facets";
import {
  gradYearsLabel,
  hasMentoredPubsFacets,
  MENTORED_PUBS_DEFAULT_PARAMS,
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
} from "@/lib/edit/mentored-publications-report";
import {
  allowedMentorshipTypes,
  defaultMentorshipTypes,
  MENTORSHIP_TYPE_LABEL,
  resolveMentorshipTypes,
  type MentorshipTypeKey,
} from "@/lib/edit/mentorship-type";
import type { PersonReportProps, ReportRender } from "@/lib/edit/report-registry";

const FORM_ID = "mentored-pubs-filters";
const SHEET_SUFFIX = "-sheet";

/** The page URL for `params`. The tab hrefs pass `keepQ: false` — the
 *  island appends the live find text to those itself; a chip's × keeps the
 *  `q` the page was opened with, so removing a filter doesn't clear the box. */
function pageHref(basePath: string, params: MentoredPubsParams, keepQ: boolean): string {
  const qs = mentoredPubsQueryString(keepQ ? params : { ...params, q: "" });
  return qs ? `${basePath}?${qs}` : basePath;
}

const sameSet = <T,>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** "Program pairings (6)" / "MD" / "4 types". */
function typesChip(types: ReadonlyArray<MentorshipTypeKey>, choices: ReadonlyArray<MentorshipTypeKey>): string {
  const program = choices.filter((k) => !INFERRED_TYPE_KEYS.includes(k));
  const inferred = types.filter((k) => INFERRED_TYPE_KEYS.includes(k));
  if (types.length === 1) return MENTORSHIP_TYPE_LABEL[types[0]];
  if (inferred.length === 0 && program.length > 1 && sameSet(types, program)) {
    return `Program pairings (${program.length})`;
  }
  return `${types.length} types`;
}

const joinOrCount = (labels: string[], noun: string) =>
  labels.length <= 2 ? labels.join(", ") : `${labels.length} ${noun}`;

/** Report 7's body: rail + card, over the scopes the person gate resolved. */
export async function renderMentoredPublicationsReport({
  scopes,
  searchParams,
  basePath,
}: PersonReportProps): Promise<ReportRender> {
  // Malformed params fall back to the defaults (a page, unlike the download
  // route, has nothing useful to say with a 400).
  const parsed = parseMentoredPubsParams(searchParams);
  const requested: MentoredPubsParams = parsed.ok ? parsed.value : MENTORED_PUBS_DEFAULT_PARAMS;
  // Types outside the caller's scopes are silently dropped — never a wider set.
  const types = resolveMentorshipTypes(requested.types, scopes);
  const loaderScopes = [...scopes];

  const yearChoices = await loadMentoredGradYears(loaderScopes, types);
  // Years the chosen types have no class in are dropped (a type checkbox
  // auto-submits with the previous selection's years); nothing left → this
  // selection's default.
  const choiceSet = new Set(yearChoices);
  const kept = (requested.years ?? []).filter((y) => choiceSet.has(y));
  const defaultYears = defaultMentoredPubsYears(yearChoices);
  const years =
    requested.years === null || (requested.years.length > 0 && kept.length === 0) ? defaultYears : kept;
  const params: MentoredPubsParams = { ...requested, years, types };

  const loaded = await loadMentoredPublicationsReport({
    scopes: loaderScopes,
    types,
    gradYears: years.length > 0 ? years : null,
    tail: params.tail,
    pubs: params.pubs,
  });
  const report = applyMentoredPubsFacets(loaded, params, HIGH_IMPACT_THRESHOLD);
  const options = mentoredPubsFacetOptions(loaded, params);
  const typeChoices = allowedMentorshipTypes(scopes);
  const defaultTypes = defaultMentorshipTypes(scopes);

  const allMode = params.pubs === "all";
  const allPubsMissing = allMode && loaded.allPubsLoaded === false;

  // What differs from a bare URL — the reset link, the chips' ×, the phone
  // trigger's count.
  const nonDefault = {
    years: !sameSet(years, defaultYears),
    types: !sameSet(types, defaultTypes),
    tail: params.tail !== DEFAULT_TAIL,
    pubs: params.pubs !== "mentored",
  };
  // Chip × hrefs keep `q`; the tab hrefs (`viewHref`) don't — the island adds it.
  const href = (patch: Partial<MentoredPubsParams>) => pageHref(basePath, { ...params, ...patch }, true);
  const viewHref = (view: MentoredPubsParams["view"]) => pageHref(basePath, { ...params, view }, false);
  const resetHref =
    Object.values(nonDefault).some(Boolean) || hasMentoredPubsFacets(params)
      ? params.view === "publications"
        ? `${basePath}?view=publications`
        : basePath
      : null;
  const activeCount =
    Object.values(nonDefault).filter(Boolean).length +
    [params.window, params.position, params.pubYears, params.mentors].filter((l) => l.length > 0).length +
    (params.withPubs ? 1 : 0);

  const mentorName = new Map(options.mentors.map((m) => [m.value, m.label]));
  const chips: FilterChip[] = [
    {
      group: "Graduation",
      value: gradYearsLabel(years, yearChoices),
      removeHref: nonDefault.years ? href({ years: null }) : null,
    },
    { group: "Mentorship", value: typesChip(types, typeChoices), removeHref: nonDefault.types ? href({ types: null }) : null },
    {
      group: "Window",
      value: `Entry → grad + ${params.tail}`,
      removeHref: nonDefault.tail ? href({ tail: DEFAULT_TAIL }) : null,
    },
    {
      group: "Publications",
      value: PUBS_SET_LABEL[params.pubs],
      removeHref: nonDefault.pubs ? href({ pubs: "mentored" }) : null,
    },
  ];
  if (params.window.length > 0) {
    chips.push({
      group: "In window",
      value: params.window.map((w) => WINDOW_FACET_LABEL[w]).join(", "),
      removeHref: href({ window: [] }),
    });
  }
  if (params.position.length > 0) {
    chips.push({
      group: "Author position",
      value: params.position.map((p) => POSITION_FACET_LABEL[p]).join(", "),
      removeHref: href({ position: [] }),
    });
  }
  if (params.pubYears.length > 0) {
    chips.push({
      group: "Publication year",
      value: joinOrCount(params.pubYears.map(String), "years"),
      removeHref: href({ pubYears: [] }),
    });
  }
  if (params.mentors.length > 0) {
    chips.push({
      group: "Mentor",
      value: joinOrCount(
        params.mentors.map((c) => mentorName.get(c) ?? c),
        "mentors",
      ),
      removeHref: href({ mentors: [] }),
    });
  }
  if (params.withPubs) {
    chips.push({ group: "Learners", value: "With publications only", removeHref: href({ withPubs: false }) });
  }

  const rail = (idSuffix = "") => (
    <MentoredPublicationsRail
      basePath={basePath}
      params={params}
      typeChoices={typeChoices}
      yearChoices={yearChoices}
      options={options}
      resetHref={resetHref}
      idSuffix={idSuffix}
    />
  );

  // The download never carries `view` or `q` (page-only).
  const downloadHref = `/api/edit/reports/mentored-publications?${mentoredPubsQueryString({
    ...params,
    view: "summary",
    q: "",
  })}`;
  const inWindow = report.summary.reduce((n, r) => n + (r.pubsInWindow ?? 0), 0);
  const allYears = report.summary.reduce((n, r) => n + r.pubsAllTime, 0);
  const distinct = report.publications.length;

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        {allMode
          ? "Every publication of each learner, the ones co-authored with a mentor flagged, with Journal Impact Factor and NIH iCite citations."
          : "Publications each learner co-authored with one of their mentors, with Journal Impact Factor and NIH iCite citations."}
      </p>
    ),
    main: (
      <ReportLayout rail={rail()}>
        <ReportCard>
          <div className="mb-4 lg:hidden">
            <FiltersSheet activeCount={activeCount} testId="mentored-pubs-filters-sheet-trigger">
              {rail(SHEET_SUFFIX)}
            </FiltersSheet>
          </div>
          {allPubsMissing ? (
            <p
              className="border-apollo-border bg-apollo-surface-2 rounded-md border px-3 py-2 text-sm"
              role="status"
              data-testid="mentored-pubs-all-missing"
            >
              All-publication data has not been loaded yet. The learner publication bridge (
              <code>etl:mentoring:import-learner-pubs</code>) has not run in this environment, so every count
              would be zero. Switch &ldquo;Publications&rdquo; back to &ldquo;Co-authored with a mentor&rdquo; or run
              the import.
            </p>
          ) : (
            <>
              <ReportStats
                stats={[
                  { value: report.summary.length.toLocaleString(), label: report.summary.length === 1 ? "learner" : "learners" },
                  { value: inWindow.toLocaleString(), label: "publications in window" },
                  { value: allYears.toLocaleString(), label: "all years" },
                ]}
                aside={
                  <div className="flex flex-col items-start gap-2">
                    <Button asChild variant="apollo">
                      <a href={downloadHref} data-testid="mentored-pubs-download">
                        <Download className="size-4" aria-hidden />
                        Download .xlsx
                      </a>
                    </Button>
                    <p className="text-muted-foreground text-[13px] text-pretty" data-testid="mentored-pubs-download-note">
                      Includes the Summary (one row per learner), Raw Data (one row per{" "}
                      {allMode ? "learner and publication" : "learner, mentor and publication"}) and Query &amp;
                      Assumptions sheets, with these filters applied.
                    </p>
                  </div>
                }
                testId="mentored-pubs-stats"
              />
              <p className="text-muted-foreground mt-3 text-[13px]" data-testid="mentored-pubs-distinct">
                {distinct.toLocaleString()} distinct {distinct === 1 ? "publication" : "publications"}. A publication
                shared by two learners counts once here and once per learner above.
              </p>
              <div className="mt-4">
                <FilterChips chips={chips} testId="mentored-pubs-chips" />
              </div>
              {loaded.droppedNoCwid > 0 && (
                <div
                  className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber mt-4 rounded-lg border px-3.5 py-2.5 text-[13px] text-pretty"
                  role="note"
                  data-testid="mentored-pubs-no-cwid"
                >
                  {loaded.droppedNoCwid.toLocaleString()} faculty-asserted{" "}
                  {loaded.droppedNoCwid === 1 ? "mentee has" : "mentees have"} no CWID, so they can&rsquo;t be matched
                  to publications and aren&rsquo;t shown.
                  {loaded.droppedNoCwidMentees.length > 0 && (
                    <details className="mt-1.5" data-testid="mentored-pubs-no-cwid-list">
                      <summary className="cursor-pointer font-medium underline-offset-2 hover:underline">View list</summary>
                      <ul className="mt-1.5 flex flex-col gap-0.5">
                        {loaded.droppedNoCwidMentees.map((m, i) => (
                          <li key={i}>
                            {m.menteeName} &mdash; added by {m.mentorName}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
              <MentoredPublicationsTable
                view={params.view}
                viewHrefs={{
                  summary: viewHref("summary"),
                  publications: viewHref("publications"),
                }}
                summary={report.summary}
                publications={report.publications}
                pubsMode={params.pubs}
                highImpactThreshold={HIGH_IMPACT_THRESHOLD}
                tail={params.tail}
                initialQuery={params.q}
                formIds={[FORM_ID, `${FORM_ID}${SHEET_SUFFIX}`]}
              />
            </>
          )}
          <p className="text-muted-foreground mt-6 max-w-[680px] text-[13px] text-pretty" data-testid="mentored-pubs-footnote">
            &ldquo;In window&rdquo; means entry year &le; publication year &le; graduation year + {params.tail}; an MD
            learner with no entry year on the pairing sheet is assumed to have entered four years before graduating.
            {loaded.droppedUnresolved > 0 &&
              ` ${loaded.droppedUnresolved.toLocaleString()} co-publications not yet in the local corpus are not shown.`}{" "}
            Historical numbers may change slightly as publication records and mentor pairings are updated.
          </p>
        </ReportCard>
      </ReportLayout>
    ),
  };
}
