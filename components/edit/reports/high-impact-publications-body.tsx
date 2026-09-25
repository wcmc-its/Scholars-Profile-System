/**
 * Report 9 — "Top clinical and high-impact journal publications" body
 * (reports redesign, 2026-09-24; mockup `High-Impact Publications
 * Redesign.dc.html`). The shared pieces (`report-ui.tsx`): a filter rail of
 * collapsed sections (years with calendar / fiscal basis, journal families,
 * the Profiles roster's person type / department / center / institution
 * facets, article type, author position) in a plain GET `AutoSubmitForm`;
 * the headline numbers with the `.xlsx` button and its note; the active
 * filters as chips; then the Scholars / Publications tabs
 * (`high-impact-results.tsx`, the client half). Below `lg` the rail moves
 * into `FiltersSheet`.
 *
 * Loaders, journal families, defaults, chips and the download note live in
 * `lib/edit/high-impact-pubs-report.ts`; the download route
 * (`/api/edit/reports/high-impact-publications`) takes the same query string.
 */
import { Download } from "lucide-react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import {
  HighImpactResults,
  type HighImpactPub,
} from "@/components/edit/reports/high-impact-results";
import { RailChecklist, type RailChecklistOption } from "@/components/edit/reports/rail-checklist";
import {
  FilterChips,
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
  ReportStats,
} from "@/components/edit/reports/report-ui";
import { Button } from "@/components/ui/button";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import {
  ARTICLE_COUNT_CAVEAT,
  BASIS_LABEL,
  loadArticleCountChoices,
  POSITION_LABEL,
  unitLabels,
  type AuthorPosition,
  type YearBasis,
} from "@/lib/edit/article-count-report";
import {
  HIGH_IMPACT_LIST_CAP,
  highImpactChips,
  highImpactDownloadNote,
  highImpactQueryString,
  isHighImpactDefault,
  JOURNAL_FAMILIES,
  loadHighImpactList,
  loadHighImpactTotals,
  parseHighImpactParams,
  summarizePeople,
  yearLabel,
  yearRangeLabel,
  type HighImpactParams,
} from "@/lib/edit/high-impact-pubs-report";
import type { PersonReportProps, ReportRender } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

const SELECT =
  "border-apollo-border-strong bg-apollo-surface h-[34px] min-w-0 rounded-md border px-2 text-sm";
const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
const RADIO_INPUT = "accent-apollo-maroon size-4";

function toSearchParams(sp: PersonReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

/** A section's current value: "Any" (or `all`), up to two labels, else "N selected". */
function summarize(labels: string[], all = "Any"): string {
  if (labels.length === 0) return all;
  return labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`;
}

type RailProps = {
  basePath: string;
  params: HighImpactParams;
  facets: DataQualityFacets;
  atypes: string[];
  labels: ReadonlyMap<string, string>;
  resetHref: string | null;
};

function Rail({ basePath, params, facets, atypes, labels, resetHref }: RailProps) {
  const thisYear = new Date().getFullYear();
  // The fiscal basis runs a year ahead (FY2027 starts July 2026).
  const years = Array.from({ length: 30 }, (_, i) => thisYear + 1 - i);
  // A selected unit no rail option carries (renamed, retired, hand-typed)
  // still lists in its group, ticked, so the next submit keeps it and it can be
  // unticked. Centers and institutions by prefix; anything else under departments.
  const known = new Set(
    [
      ...facets.departments.flatMap((d) => [d, ...d.divisions]),
      ...facets.centers,
      ...facets.institutions,
    ].map((o) => o.value),
  );
  const groupOf = (u: string) =>
    u.startsWith("center:") ? "center" : u.startsWith("inst:") ? "inst" : "dept";
  // Deduped: a hand-typed `unit=X&unit=X` must render one checkbox, not two.
  const unknownUnits = (group: string): RailChecklistOption[] =>
    [...new Set(params.units)]
      .filter((u) => !known.has(u) && groupOf(u) === group)
      .map((u) => ({ value: u, label: labels.get(u) ?? u, count: 0 }));
  const unitOptions: RailChecklistOption[] = [
    ...facets.departments.map(({ value, label, count }) => ({ value, label, count })),
    ...facets.departments
      .flatMap((d) => d.divisions)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    ...unknownUnits("dept"),
  ];
  // A memberless center can only return zero — hidden unless already selected.
  const centerOptions = [
    ...facets.centers.filter((c) => c.count > 0 || params.units.includes(c.value)),
    ...unknownUnits("center"),
  ];
  const institutionOptions = [...facets.institutions, ...unknownUnits("inst")];
  const unitsOf = (prefixes: string[]) =>
    params.units
      .filter((u) => prefixes.some((p) => u.startsWith(p)))
      .map((u) => labels.get(u) ?? u);
  const allJournals = params.journals.length === JOURNAL_FAMILIES.length;
  const yearSelect = (k: "from" | "to") => (
    <select
      name={k}
      defaultValue={params[k]}
      aria-label={k === "from" ? "From year" : "To year"}
      className={SELECT}
    >
      {years.map((y) => (
        <option key={y} value={y}>
          {yearLabel(params, y)}
        </option>
      ))}
    </select>
  );
  // A selected person type no active scholar holds still lists, so it can be unticked.
  const typeOptions: RailChecklistOption[] = [
    ...facets.roleCategories,
    ...params.types
      .filter((t) => !facets.roleCategories.some((o) => o.value === t))
      .map((t) => ({ value: t, label: t, count: 0 })),
  ];
  return (
    <ReportRail
      resetHref={resetHref}
      help="Filters apply automatically. Numbers next to options count active people."
      testId="high-impact-rail"
    >
      <AutoSubmitForm action={basePath} className="group" data-testid="high-impact-filters">
        <input type="hidden" name="view" value={params.view} />
        <RailSection
          label="Years"
          summary={`${yearRangeLabel(params)} · ${params.basis === "fy" ? "Fiscal (July–June)" : "Calendar"}`}
          defaultOpen
          testId="high-impact-years"
        >
          <div className="flex flex-col gap-2">
            {(Object.keys(BASIS_LABEL) as YearBasis[]).map((b) => (
              <label key={b} className={RADIO}>
                <input
                  type="radio"
                  name="basis"
                  value={b}
                  defaultChecked={params.basis === b}
                  className={RADIO_INPUT}
                />
                {BASIS_LABEL[b]}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            {yearSelect("from")}
            <span className="text-muted-foreground text-[13px]">to</span>
            {yearSelect("to")}
          </div>
          {params.basis === "fy" && (
            <p className="text-muted-foreground text-xs">
              Fiscal years run July–June and are named by the year they end, by the date the article
              was added to PubMed.
            </p>
          )}
        </RailSection>
        <RailSection
          label="Journals"
          summary={
            allJournals
              ? `All ${JOURNAL_FAMILIES.length} top-tier journal families`
              : summarize(
                  JOURNAL_FAMILIES.filter((f) => params.journals.includes(f.key)).map(
                    (f) => f.label,
                  ),
                )
          }
          testId="high-impact-journals"
        >
          <RailChecklist
            name="journal"
            roomy
            options={JOURNAL_FAMILIES.map((f) => ({ value: f.key, label: f.label }))}
            selected={params.journals}
          />
          <span className="text-muted-foreground text-xs">None checked = all.</span>
        </RailSection>
        <RailSection
          label="Person type"
          summary={summarize(
            params.types.map((t) => facets.roleCategories.find((o) => o.value === t)?.label ?? t),
          )}
          testId="high-impact-person-type"
        >
          <RailChecklist
            name="type"
            roomy
            options={typeOptions}
            selected={params.types}
            countLabel="People"
          />
        </RailSection>
        <RailSection
          label="Department / division"
          summary={summarize(unitsOf(["dept:", "div:"]))}
          testId="high-impact-department"
        >
          <RailChecklist
            name="unit"
            roomy
            options={unitOptions}
            selected={params.units}
            searchPlaceholder="Search departments…"
            collapseAfter={8}
            countLabel="People"
          />
        </RailSection>
        <RailSection
          label="Centers"
          summary={summarize(unitsOf(["center:"]))}
          testId="high-impact-centers"
        >
          <RailChecklist
            name="unit"
            roomy
            options={centerOptions}
            selected={params.units}
            searchPlaceholder="Search centers…"
            collapseAfter={6}
            countLabel="People"
          />
        </RailSection>
        <RailSection
          label="Institution"
          summary={summarize(unitsOf(["inst:"]))}
          testId="high-impact-institution"
        >
          <RailChecklist
            name="unit"
            roomy
            options={institutionOptions}
            selected={params.units}
            countLabel="People"
          />
        </RailSection>
        <RailSection
          label="Article type"
          summary={summarize(params.atypes)}
          testId="high-impact-article-type"
        >
          <RailChecklist
            name="atype"
            roomy
            // A type in the URL that no publication carries still shows, so it can be unticked.
            options={[...new Set([...atypes, ...params.atypes])].map((a) => ({
              value: a,
              label: a,
            }))}
            selected={params.atypes}
            collapseAfter={8}
          />
        </RailSection>
        <RailSection
          label="Author position"
          summary={POSITION_LABEL[params.pos]}
          testId="high-impact-position"
        >
          <div className="flex flex-col gap-2">
            {(Object.keys(POSITION_LABEL) as AuthorPosition[]).map((p) => (
              <label key={p} className={RADIO}>
                <input
                  type="radio"
                  name="pos"
                  value={p}
                  defaultChecked={params.pos === p}
                  className={RADIO_INPUT}
                />
                {POSITION_LABEL[p]}
              </label>
            ))}
          </div>
        </RailSection>
        {/* No-JS fallback; the island hides it once hydrated. */}
        <div className="px-[18px] pb-4 group-data-[hydrated=true]:hidden">
          <button
            type="submit"
            className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm"
          >
            Apply
          </button>
        </div>
      </AutoSubmitForm>
    </ReportRail>
  );
}

/** "2026 counts publications through September 24, 2026. …" when the window
 *  includes the year in progress; null otherwise. */
function partialYearNote(p: HighImpactParams, now: Date): string | null {
  const today = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const current =
    p.basis === "fy" ? now.getFullYear() + (now.getMonth() >= 6 ? 1 : 0) : now.getFullYear();
  if (p.from > current || p.to < current) return null;
  const counted = p.basis === "fy" ? "publications added to PubMed" : "publications";
  return `${yearLabel(p, current)} counts ${counted} through ${today}. Citation counts for recent articles are low because they have had little time to be cited.`;
}

export async function renderHighImpactPublicationsReport({
  searchParams,
  basePath,
}: PersonReportProps): Promise<ReportRender> {
  const params = parseHighImpactParams(toSearchParams(searchParams));
  const [{ facets, atypes }, totals] = await Promise.all([
    loadArticleCountChoices(),
    loadHighImpactTotals(params),
  ]);
  // Both tabs read the list: the Scholars tab is its per-person roll-up.
  const list = totals.articles <= HIGH_IMPACT_LIST_CAP ? await loadHighImpactList(params) : null;
  const people = list ? summarizePeople(list) : null;
  const labels = unitLabels(facets);
  const chips = highImpactChips(params, labels);
  const note = highImpactDownloadNote(totals);
  const href = (q: string) => `${basePath}?${q}`;
  const resetHref = isHighImpactDefault(params)
    ? null
    : params.view === "publications"
      ? href("view=publications")
      : basePath;
  // The download-only `authors` strings stay on the server.
  const pubs: HighImpactPub[] | null = list
    ? list.map((r): HighImpactPub => {
        const { authors, ...rest } = r;
        void authors;
        return rest;
      })
    : null;
  const partial = partialYearNote(params, new Date());
  const rail = (
    <Rail
      basePath={basePath}
      params={params}
      facets={facets}
      atypes={atypes}
      labels={labels}
      resetHref={resetHref}
    />
  );

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        Scholars who published in top-tier journals, with their article counts, author positions,
        citations and journals. Opens on original research by full-time faculty as first or last
        author this year.
      </p>
    ),
    main: (
      <ReportLayout rail={rail}>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="lg:hidden">
            <FiltersSheet
              activeCount={chips.filter((c) => c.removeQuery !== null).length}
              testId="high-impact-filters-sheet-trigger"
            >
              {rail}
            </FiltersSheet>
          </div>
          <ReportCard>
            <ReportStats
              stats={[
                { value: totals.scholars.toLocaleString(), label: "scholars" },
                { value: totals.articles.toLocaleString(), label: "distinct publications" },
              ]}
              aside={
                <div className="flex flex-col items-start gap-2">
                  <Button asChild variant="apollo">
                    <a
                      href={`/api/edit/reports/high-impact-publications?${highImpactQueryString(params)}`}
                      data-testid="high-impact-download"
                    >
                      <Download className="size-4" aria-hidden />
                      Download .xlsx
                    </a>
                  </Button>
                  <p
                    className={cn(
                      "text-[13px]",
                      note.withheld ? "text-apollo-amber" : "text-muted-foreground",
                    )}
                    data-testid="high-impact-download-note"
                  >
                    {note.text}
                  </p>
                </div>
              }
            />
            <div className="mt-5">
              <FilterChips
                chips={chips.map((c) => ({
                  group: c.group,
                  value: c.value,
                  removeHref: c.removeQuery === null ? null : href(c.removeQuery),
                }))}
                testId="high-impact-chips"
              />
            </div>
            <HighImpactResults
              view={params.view}
              tabHrefs={{
                summary: href(highImpactQueryString(params, "summary")),
                publications: href(highImpactQueryString(params, "publications")),
              }}
              counts={totals}
              people={people}
              pubs={pubs}
              showPersonType={params.types.length !== 1}
              overCapMessage={`${totals.articles.toLocaleString()} articles is more than ${HIGH_IMPACT_LIST_CAP.toLocaleString()}. Narrow the filters to list them.`}
            />
            <div
              className="text-muted-foreground mt-6 flex max-w-[680px] flex-col gap-1.5 text-[13px]"
              role="note"
            >
              {partial && <p>{partial}</p>}
              <p>
                Only ReCiter-confirmed authorships of active scholars count. Citations are NIH iCite
                counts. {ARTICLE_COUNT_CAVEAT}
              </p>
            </div>
          </ReportCard>
        </div>
      </ReportLayout>
    ),
  };
}
