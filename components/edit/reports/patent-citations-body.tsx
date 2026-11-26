/**
 * Report 25 — "Patent citations" body (mockup: `PatentReport.dc.html`,
 * 2026-11-26). Built from report 24's parts (`citation-report-parts.tsx`,
 * `report-ui.tsx`): the filter rail, the chips, the results card with its
 * three tabs, each with its own search or sort form and pages of
 * `PATENT_PAGE_SIZE`. Above the card: three tiles, the top assignees and
 * inventions per year. The export button rides the report header (`aside`).
 *
 * Filters, search, sort, tab and page are the URL. The only client state is
 * which rows are open (`Disclosure`); what an open row shows is rendered
 * here, for the rows on the page only.
 *
 * Parser, access scope, loaders, chips and the workbook live in
 * `lib/edit/patent-citations-report.ts`; the download route
 * (`/api/edit/reports/patent-citations`) takes the same query string.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";

import { FiltersSheet } from "@/components/edit/filters-sheet";
import {
  AuthorPills,
  CARD,
  CARD_TITLE,
  CitationRail,
  ExternalLink,
  LINK,
  LIST_HEAD,
  Pager,
  PersonCell,
  personFacetOptions,
  plural,
  PubMeta,
  RADIO,
  RADIO_INPUT,
  ReportTab,
  SearchField,
  SortSelect,
  summarize,
  TD,
  TH,
  Toolbar,
  toSearchParams,
  YearRange,
} from "@/components/edit/reports/citation-report-parts";
import { Disclosure } from "@/components/edit/reports/policy-citations-client";
import { RailChecklist } from "@/components/edit/reports/rail-checklist";
import { FilterChips, RailSection, ReportCard, ReportLayout } from "@/components/edit/reports/report-ui";
import { PubTitle } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { db } from "@/lib/db";
import {
  INVENTION_SORT_LABEL,
  INVENTIONS_SHOWN,
  isPatentCitationDefault,
  isPatentCitationsReportEnabled,
  loadPatentCitations,
  loadPersonInventions,
  parsePatentCitationParams,
  PATENT_DATA_END,
  PATENT_INVENTIONS_CAP,
  PATENT_LAG_NOTICE,
  PATENT_LIST_CAP,
  PATENT_PAGE_SIZE,
  PATENT_SORT_LABEL,
  PATENT_SOURCES,
  patentCitationChips,
  patentCitationQueryString,
  patentHolder,
  patentYearLabel,
  relatedPatentsLabel,
  resolvePatentCitationParams,
  WHERE_CITED_LABEL,
  WHERE_LABEL,
  withInventionDetails,
  withPublicationDetails,
  type AssigneeCount,
  type CitingInvention,
  type InventionRow,
  type InventionSort,
  type PatentCitationParams,
  type PatentPersonRow,
  type PatentPubRow,
  type PatentSort,
  type WhereCited,
} from "@/lib/edit/patent-citations-report";
import { fiscalLabel, yearSpan } from "@/lib/edit/policy-citations-report";
import { unitLabels } from "@/lib/edit/person-filter";
import type { AdminReportProps, ReportRender } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

/** The Person facet offers this many people (by papers cited in a patent). */
const FACET_PEOPLE = 50;
const PUB_COLS = "grid grid-cols-[minmax(0,1fr)_100px_110px] gap-x-5 px-4";
const INVENTION_COLS = "grid grid-cols-[minmax(0,1fr)_200px_90px_100px] gap-x-4 px-4";
const EXPANDER = "col-span-full mt-2.5 min-h-9 justify-self-start";
const MUTED = "text-muted-foreground text-[13px]";
const BAR_PX = 110;

const dot = (parts: (string | false | null)[]) => parts.filter(Boolean).join(" · ");

function Tile({ label, value, note, testId }: { label: string; value: number; note: string; testId: string }) {
  return (
    <div className={cn(CARD, "px-4 py-3.5")} data-testid={testId}>
      <span className="text-muted-foreground block text-[13px]">{label}</span>
      <span className="block text-[28px] leading-[1.2] font-semibold tabular-nums">{value.toLocaleString()}</span>
      <span className="text-muted-foreground block text-[13px]">{note}</span>
    </div>
  );
}

function AssigneeCard({ assignees, href }: { assignees: AssigneeCount[]; href: (name: string) => string }) {
  return (
    <div className={cn(CARD, "flex flex-col gap-2.5")} data-testid="patent-citations-assignees">
      <h2 className={CARD_TITLE}>By assignee</h2>
      {assignees.length === 0 ? (
        <p className={MUTED}>No citing patent names an assignee.</p>
      ) : (
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr className="text-muted-foreground text-left text-xs">
              <th className="pb-1.5 font-normal">Assignee</th>
              <th className="w-20 pb-1.5 text-right font-normal">Inventions</th>
              <th className="w-[60px] pb-1.5 text-right font-normal">Papers</th>
            </tr>
          </thead>
          <tbody>
            {assignees.map((a) => (
              <tr key={a.name} className="align-top">
                <td className="py-[5px] pr-3">
                  <Link href={href(a.name)} className={LINK}>
                    {a.name}
                  </Link>
                </td>
                <td className="py-[5px] text-right">{a.inventions.toLocaleString()}</td>
                <td className="py-[5px] text-right">{a.papers.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-muted-foreground text-xs">
        Top ten. Assignee names are as USPTO records them, so one company can appear under several
        spellings.
      </p>
    </div>
  );
}

function YearChart({ years }: { years: { year: number; count: number }[] }) {
  const max = Math.max(1, ...years.map((b) => b.count));
  return (
    <div className={cn(CARD, "flex flex-col")} data-testid="patent-citations-years-chart">
      <h2 className={CARD_TITLE}>Citing inventions by year granted</h2>
      <div
        role="img"
        aria-label={`Citing inventions by year granted: ${years
          .map((b) => `${b.count.toLocaleString()} in ${b.year}`)
          .join(", ")}`}
        className="border-apollo-border-strong mt-3.5 flex h-[150px] items-end gap-0.5 border-b"
      >
        {years.map((b) => (
          <div
            key={b.year}
            title={`${b.year}: ${plural(b.count, "invention", "inventions")}`}
            className="flex flex-1 flex-col items-center gap-1"
          >
            <span className="text-muted-foreground text-xs tabular-nums">{b.count.toLocaleString()}</span>
            <div
              className="bg-apollo-slate w-[70%] max-w-11 rounded-t"
              style={{ height: `${Math.round((b.count / max) * BAR_PX)}px` }}
            />
          </div>
        ))}
      </div>
      <div className="text-muted-foreground mt-1 flex gap-0.5 text-xs" aria-hidden>
        {years.map((b) => (
          <span key={b.year} className="flex-1 text-center">
            {b.year}
          </span>
        ))}
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        The patent data ends at {PATENT_DATA_END.label}. An invention with no granted patent yet is counted in
        the year its application was published.
      </p>
    </div>
  );
}

/** One citing invention under a publication: the patent that stands for it. */
function InventionEntry({ d }: { d: CitingInvention }) {
  return (
    <div data-testid="patent-citations-invention">
      <ExternalLink href={d.url} className="font-medium">
        {d.title}
      </ExternalLink>
      <div className={MUTED}>
        {dot([
          patentHolder(d),
          patentYearLabel(d.year, d.application),
          d.number,
          relatedPatentsLabel(d.docs),
          WHERE_CITED_LABEL[d.where],
        ])}
      </div>
    </div>
  );
}

function PublicationList({ pubs }: { pubs: PatentPubRow[] }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[620px]" data-testid="patent-citations-publications">
        <div className={cn(LIST_HEAD, PUB_COLS)}>
          <span>Publication</span>
          <span className="text-right">Inventions</span>
          <span className="text-right">Latest patent</span>
        </div>
        {pubs.map((r) => (
          <div
            key={r.pmid}
            className={cn(PUB_COLS, "border-apollo-border items-start border-b py-3")}
            data-testid="patent-citations-pub-row"
          >
            <div className="min-w-0">
              <div className="font-medium">
                <PubTitle value={r.title} />
              </div>
              <div className="text-muted-foreground mt-0.5 leading-normal">
                <PubMeta pub={r} copy />
              </div>
              <AuthorPills authors={r.authors} />
            </div>
            <span className="text-right tabular-nums">{r.inventions.toLocaleString()}</span>
            <span className="text-right tabular-nums">{r.latest ?? "–"}</span>
            <Disclosure
              show={plural(r.inventions, "citing invention", "citing inventions")}
              hide="Hide citing inventions"
              className={EXPANDER}
            >
              <div
                className="bg-apollo-surface-2 border-apollo-border col-span-full mt-1 flex flex-col gap-2.5 rounded-lg border px-4 py-3 leading-normal"
                data-testid="patent-citations-inventions"
              >
                {r.shown.map((d) => (
                  <InventionEntry key={d.key} d={d} />
                ))}
                {r.inventions > r.shown.length && (
                  <p className={MUTED}>
                    The newest {r.shown.length.toLocaleString()} of {r.inventions.toLocaleString()} citing
                    inventions.
                  </p>
                )}
              </div>
            </Disclosure>
          </div>
        ))}
      </div>
    </div>
  );
}

function InventionList({ inventions }: { inventions: InventionRow[] }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]" data-testid="patent-citations-invention-list">
        <div className={cn(LIST_HEAD, INVENTION_COLS)}>
          <span>Invention</span>
          <span>Assignee</span>
          <span>Year</span>
          <span className="text-right">WCM papers</span>
        </div>
        {inventions.map((d) => (
          <div
            key={d.key}
            className={cn(INVENTION_COLS, "border-apollo-border items-start border-b py-3")}
            data-testid="patent-citations-invention-row"
          >
            <div className="min-w-0">
              <ExternalLink href={d.url} className="font-medium">
                {d.title}
              </ExternalLink>
              <div className={MUTED}>{dot([d.number, relatedPatentsLabel(d.docs)])}</div>
            </div>
            <span className="min-w-0">{patentHolder(d)}</span>
            <span className="tabular-nums">
              {d.year ?? "–"}
              {d.application && <span className="text-muted-foreground block text-xs">application</span>}
            </span>
            <span className="text-right tabular-nums">{d.papers.toLocaleString()}</span>
            <Disclosure
              show={`Show WCM papers cited (${d.papers.toLocaleString()})`}
              hide="Hide WCM papers cited"
              className={EXPANDER}
            >
              <ul className="col-span-full m-0 mt-1 flex list-none flex-col gap-2 p-0 text-[13px]">
                {d.shown.map((p) => (
                  <li key={p.pmid}>
                    <PubTitle value={p.title} />
                    <div className="text-muted-foreground">
                      <PubMeta pub={p} />
                    </div>
                  </li>
                ))}
                {d.papers > d.shown.length && (
                  <li className="text-muted-foreground">
                    The newest {d.shown.length} of {d.papers.toLocaleString()}.
                  </li>
                )}
              </ul>
            </Disclosure>
          </div>
        ))}
      </div>
    </div>
  );
}

function PeopleTable({
  people,
  inventions,
  papersHref,
}: {
  people: PatentPersonRow[];
  inventions: ReadonlyMap<string, number>;
  papersHref: (cwid: string) => string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-sm tabular-nums" data-testid="patent-citations-people">
        <thead>
          <tr className="bg-apollo-surface-2 text-left">
            <th className={TH}>Person</th>
            <th className={TH}>Org unit</th>
            <th className={TH}>Person type</th>
            <th className={TH}>Primary institution</th>
            <th className={cn(TH, "text-right whitespace-normal")}>Papers cited</th>
            <th className={cn(TH, "text-right whitespace-normal")}>Citing inventions</th>
          </tr>
        </thead>
        <tbody>
          {people.map((r) => (
            <tr key={r.cwid} className="border-apollo-border border-b" data-testid="patent-citations-person-row">
              <PersonCell cwid={r.cwid} name={r.name} />
              <td className={TD}>{r.orgUnit}</td>
              <td className={TD}>{r.personType}</td>
              <td className={TD}>{r.institution}</td>
              <td className={cn(TD, "text-right")}>
                <Link href={papersHref(r.cwid)} className={LINK}>
                  {r.papers.toLocaleString()}
                </Link>
              </td>
              <td className={cn(TD, "text-right")}>{(inventions.get(r.cwid) ?? 0).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function renderPatentCitationsReport({
  session,
  searchParams,
  basePath,
}: AdminReportProps): Promise<ReportRender> {
  // The page gate (`canViewPatentCitationsReport`) already refused; these are the backstop.
  if (!isPatentCitationsReportEnabled()) notFound();
  const params = await resolvePatentCitationParams(
    parsePatentCitationParams(toSearchParams(searchParams)),
    session,
  );
  if (params.scope !== null && params.scope.length === 0) notFound();
  const { view } = params;
  const offset = (params.page - 1) * PATENT_PAGE_SIZE;
  const [facets, data] = await Promise.all([loadDataQualityFacets(db.read), loadPatentCitations(params)]);
  const onPage = <T,>(rows: readonly T[]) => rows.slice(offset, offset + PATENT_PAGE_SIZE);
  // Details for this page's rows only; each loader tests the scope again.
  const people = view === "people" ? onPage(data.people) : [];
  const [pubs, inventions, personInventions] = await Promise.all([
    view === "publications" ? withPublicationDetails(params, onPage(data.pubs), { inventions: true }) : [],
    view === "inventions" ? withInventionDetails(params, onPage(data.inventions), { papers: true }) : [],
    loadPersonInventions(
      params,
      people.map((r) => r.cwid),
    ),
  ]);
  const labels = unitLabels(facets);
  const chips = patentCitationChips(params, labels, new Map(data.facetPeople.map((r) => [r.cwid, r.name])));
  const href = (q: string) => `${basePath}?${q}`;
  const qs = (over: Partial<PatentCitationParams> = {}) => href(patentCitationQueryString(params, over));
  const resetHref = isPatentCitationDefault(params) ? null : view === "publications" ? basePath : href(`view=${view}`);
  const patentYear = yearSpan(params.cfrom, params.cto);
  const assigneeOptions = [
    ...data.assigneeOptions.map((a) => ({ value: a.name, label: a.name, count: a.inventions })),
    ...params.assignees
      .filter((a) => !data.assigneeOptions.some((o) => o.name === a))
      .map((a) => ({ value: a, label: a, count: 0 })),
  ];
  const rail = (
    <CitationRail
      basePath={basePath}
      testId="patent-citations"
      params={params}
      facets={facets}
      labels={labels}
      resetHref={resetHref}
      hidden={
        <>
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="sort" value={params.sort} />
          <input type="hidden" name="isort" value={params.inventionSort} />
          {params.q && <input type="hidden" name="q" value={params.q} />}
        </>
      }
      citing={{
        title: "Citing patents",
        help: "Which patents are counted, in every number.",
        children: (
          <>
            <RailSection
              label="Year granted or published"
              summary={patentYear ?? "Any"}
              testId="patent-citations-patent-year"
            >
              <YearRange
                from={{ name: "cfrom", value: params.cfrom }}
                to={{ name: "cto", value: params.cto }}
                what="patent year"
              />
            </RailSection>
            <RailSection label="Assignee" summary={summarize(params.assignees)} testId="patent-citations-assignee">
              <RailChecklist
                name="assignee"
                roomy
                options={assigneeOptions}
                selected={params.assignees}
                searchPlaceholder="Search assignees…"
                collapseAfter={8}
                countLabel="Inventions"
              />
              <span className="text-muted-foreground text-xs">
                The {data.assigneeOptions.length.toLocaleString()} assignees with the most citing inventions, as
                USPTO spells them.
              </span>
            </RailSection>
            <RailSection label="Where cited" summary={WHERE_LABEL[params.where]} testId="patent-citations-where">
              <div className="flex flex-col gap-2">
                {(Object.keys(WHERE_LABEL) as WhereCited[]).map((w) => (
                  <label key={w} className={RADIO}>
                    <input
                      type="radio"
                      name="where"
                      value={w}
                      defaultChecked={params.where === w}
                      className={RADIO_INPUT}
                    />
                    {WHERE_LABEL[w]}
                  </label>
                ))}
              </div>
            </RailSection>
          </>
        ),
      }}
      personOptions={personFacetOptions(
        data.facetPeople,
        params.people,
        data.facetPeople.slice(0, FACET_PEOPLE),
        (r) => r.papers,
      )}
      personNote={`The ${FACET_PEOPLE} people with the most papers cited in a patent. Anyone else: open them from the By person tab.`}
    />
  );
  const tab = (v: PatentCitationParams["view"], label: string) => (
    <ReportTab href={qs({ view: v, q: "" })} current={view === v} testId={`patent-citations-view-${v}`}>
      {label}
    </ReportTab>
  );
  /** The tab's GET form: everything in the URL except what the form itself sets. */
  const toolbar = (own: Partial<PatentCitationParams>, children: ReactNode) => (
    <Toolbar basePath={basePath} query={patentCitationQueryString(params, own)} testId="patent-citations-toolbar">
      {children}
    </Toolbar>
  );
  const pager = (total: number) => (
    <Pager
      page={params.page}
      total={total}
      pageSize={PATENT_PAGE_SIZE}
      href={(page) => qs({ page })}
      testId="patent-citations-pager"
    />
  );
  const none = (what: string) => (
    <p className={cn(MUTED, "px-4 pt-3")}>
      {params.q ? `No ${what} match the search.` : `No ${what} match. Try widening the filters.`}
    </p>
  );
  const published = yearSpan(params.from, params.to, fiscalLabel(params));
  const share =
    data.scope.papers > 0 ? `${((data.pubTotal / data.scope.papers) * 100).toFixed(1)}% of` : "No";
  const cut = (sheet: string, total: number, cap: number) =>
    total > cap && `${sheet} lists the first ${cap.toLocaleString()} of ${total.toLocaleString()}`;
  const overCap = [
    cut("Publications", data.pubTotal, PATENT_LIST_CAP),
    cut("Inventions", data.inventionTotal, PATENT_INVENTIONS_CAP),
  ];

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm" data-testid="patent-citations-subtitle">
        <strong className="text-foreground font-semibold">{plural(data.pubTotal, "paper", "papers")}</strong> cited
        in a US patent ·{" "}
        {dot([
          published ? `published ${published}` : "any publication year",
          params.scope === null ? "all units" : params.scope.map((u) => labels.get(u) ?? u).join("; "),
          patentYear && `patents granted or published ${patentYear}`,
          params.assignees.length > 0 && `assignee ${summarize(params.assignees)}`,
          params.where !== "any" && WHERE_CITED_LABEL[params.where],
        ])}
      </p>
    ),
    aside: (
      <>
        <Button asChild variant="apollo" size="sm">
          <a
            href={`/api/edit/reports/patent-citations?${patentCitationQueryString(params, { q: "" })}`}
            data-testid="patent-citations-download"
          >
            <Download className="size-4" aria-hidden />
            Export spreadsheet
          </a>
        </Button>
        <span className="text-muted-foreground text-xs" data-testid="patent-citations-download-note">
          {dot(["Publications, Inventions, People and Criteria sheets", ...overCap])}
        </span>
      </>
    ),
    main: (
      <>
        <p
          role="note"
          className="mt-5 rounded-lg border border-[var(--apollo-amber-tint-border)] bg-[var(--apollo-amber-tint)] px-4 py-3 text-[13px] leading-normal text-[var(--apollo-ink-2)]"
          data-testid="patent-citations-lag-notice"
        >
          {PATENT_LAG_NOTICE}
        </p>
        <ReportLayout rail={rail}>
          <div className="flex min-w-0 flex-col gap-4 text-sm">
            <div className="lg:hidden">
              <FiltersSheet
                activeCount={chips.filter((c) => c.removeQuery !== null).length}
                testId="patent-citations-filters-sheet-trigger"
              >
                {rail}
              </FiltersSheet>
            </div>
            <section
              aria-label="Totals"
              className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3"
              data-testid="patent-citations-tiles"
            >
              <Tile
                label="Papers cited in a patent"
                value={data.pubTotal}
                note={`${share} ${data.scope.papers.toLocaleString()} papers in scope`}
                testId="patent-citations-tile-papers"
              />
              <Tile
                label="Citing inventions"
                value={data.inventionTotal}
                note="related patents counted once"
                testId="patent-citations-tile-inventions"
              />
              <Tile
                label="People with a cited paper"
                value={data.peopleTotal}
                note={`of ${data.scope.people.toLocaleString()} in scope`}
                testId="patent-citations-tile-people"
              />
            </section>
            <FilterChips
              chips={chips.map((c) => ({
                group: c.group,
                value: c.value,
                removeHref: c.removeQuery === null ? null : href(c.removeQuery),
              }))}
              testId="patent-citations-chips"
            />
            <section className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-3">
              <AssigneeCard assignees={data.assignees} href={(name) => qs({ assignees: [name] })} />
              <YearChart years={data.years} />
            </section>
            <ReportCard className="overflow-hidden p-0 sm:p-0">
              <nav className="border-apollo-border flex flex-wrap gap-x-5 gap-y-1 border-b px-4" aria-label="Report views">
                {tab("publications", `By publication (${data.pubTotal.toLocaleString()})`)}
                {tab("inventions", `By invention (${data.inventionTotal.toLocaleString()})`)}
                {tab("people", `By person (${data.peopleTotal.toLocaleString()})`)}
              </nav>
              {view === "publications" ? (
                <>
                  {toolbar(
                    { q: "", sort: "inventions" },
                    <>
                      <SearchField label="Search title, PMID or author" placeholder="e.g. 12345678" value={params.q} />
                      <SortSelect<PatentSort> name="sort" value={params.sort} options={PATENT_SORT_LABEL} />
                    </>,
                  )}
                  <PublicationList pubs={pubs} />
                  {data.pubs.length === 0 && none("publications")}
                  {pager(data.pubs.length)}
                </>
              ) : view === "inventions" ? (
                <>
                  {toolbar(
                    { q: "", inventionSort: "papers" },
                    <>
                      <SearchField
                        label="Search patent title, number or assignee"
                        placeholder="e.g. a company"
                        value={params.q}
                      />
                      <SortSelect<InventionSort>
                        name="isort"
                        value={params.inventionSort}
                        options={INVENTION_SORT_LABEL}
                      />
                    </>,
                  )}
                  <InventionList inventions={inventions} />
                  {data.inventions.length === 0 && none("inventions")}
                  {pager(data.inventions.length)}
                </>
              ) : (
                <>
                  {toolbar(
                    { q: "" },
                    <SearchField label="Search name or CWID" placeholder="e.g. a name" value={params.q} />,
                  )}
                  <PeopleTable
                    people={people}
                    inventions={personInventions}
                    papersHref={(cwid) => qs({ view: "publications", sort: "inventions", q: "", people: [cwid] })}
                  />
                  {data.people.length === 0 && none("people")}
                  {pager(data.people.length)}
                </>
              )}
            </ReportCard>
            <p className="text-muted-foreground max-w-[760px] text-xs" role="note" data-testid="patent-citations-sources">
              {PATENT_SOURCES} Showing at most {INVENTIONS_SHOWN} citing inventions per paper.
            </p>
          </div>
        </ReportLayout>
      </>
    ),
  };
}
