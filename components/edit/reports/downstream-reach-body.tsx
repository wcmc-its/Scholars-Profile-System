/**
 * Report 27 — "Downstream reach" body. Report 24's page with nothing new
 * drawn: its shell (`ReportLayout`, `CitationRail`, `FilterChips`,
 * `ReportCard`), tabs (`ReportTab`), tables (`TH` / `TD`), pager and export
 * button, the shared headline numbers (`ReportStats`), the neutral stage
 * tag (report 26's coloured `StageTag`) and the public publication modal.
 *
 * THE RULE (plan, "The rule this plan is built on"): no number without a link
 * to the paged list of exactly the records it counts.
 *   - Tiles and tab counts link to the Publications view under the query
 *     string they were counted with.
 *   - A Publications cell opens the publication modal at the section listing
 *     that type when the modal lists exactly those documents
 *     (`modalListsExactly`); otherwise it links to the Citing documents view
 *     filtered to the paper and type.
 *   - A Citing documents row's count links to the Publications view filtered
 *     to that document; a People count to the Publications view filtered to
 *     that person (first or senior author) and type.
 *   - The rail shows no counts beside its options, and a tab that was not
 *     loaded carries no count. The People tab counts everyone listed, whatever
 *     the search, because its link drops the search.
 *   - A selection too wide to list its citing documents (`docsWithheld`) shows
 *     a message in place of the list, and no count of citing documents: not on
 *     the tab, and no pager. The one number in the message, the cited papers,
 *     links to the Publications view that lists them.
 *   - Every count's link is named for what it opens (`aria-label`), not by
 *     its digits alone.
 *   - The Connections view (`downstream-reach-connections.tsx`) needs one
 *     scholar; its tab carries no count, and is loaded only when open.
 *
 * Filters, search, sort, tab and page are the URL. Parser, access scope,
 * loaders, chips and the workbook live in `lib/edit/downstream-reach-report.ts`;
 * the download route (`/api/edit/reports/downstream-reach`) takes the same
 * query string.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";

import { FiltersSheet } from "@/components/edit/filters-sheet";
import {
  AuthorPills,
  CitationRail,
  ExternalLink,
  LINK,
  Pager,
  PersonCell,
  personCardFooter,
  PubMeta,
  ReportTab,
  SearchField,
  SELECT,
  SortSelect,
  summarize,
  TD,
  TH,
  Toolbar,
  toSearchParams,
  type PersonFooter,
} from "@/components/edit/reports/citation-report-parts";
import { ModalCount, PaperTitle } from "@/components/edit/reports/downstream-reach-client";
import {
  ConnectionsPanel,
  connectionsPageCwids,
  loadConnectionsPage,
} from "@/components/edit/reports/downstream-reach-connections";
import { RailChecklist } from "@/components/edit/reports/rail-checklist";
import { FilterChips, RailSection, ReportCard, ReportLayout, ReportStats } from "@/components/edit/reports/report-ui";
import { PubTitle } from "@/components/publication/pub-html";
import { PublicationModalProvider } from "@/components/publication/publication-modal";
import { StageTag } from "@/components/edit/reports/translational-portfolio-body";
import { Button } from "@/components/ui/button";
import { loadDataQualityFacets, type DataQualityFacets } from "@/lib/api/data-quality";
import { db } from "@/lib/db";
import { NO_STAGE_LABEL } from "@/lib/edit/article-count-report";
import { bibliometricsHref, loadBibliometricsAccess } from "@/lib/edit/bibliometrics-access";
import {
  docsTooWide,
  isDownstreamReachReportEnabled,
  isReachDefault,
  loadModalCounts,
  loadModalHidden,
  loadReach,
  loadReachAreas,
  MIN_REACH_PAPERS,
  MODAL_SECTION,
  modalGroupsOn,
  modalListsExactly,
  parseReachParams,
  REACH_COUNTING_RULE,
  REACH_DOC_SORT_LABEL,
  REACH_DOCS_NARROW_HINT,
  REACH_DOCS_PAPER_CEILING,
  REACH_LIST_CAP,
  REACH_PAGE_SIZE,
  REACH_REVIEW_RULE,
  REACH_SORT_LABEL,
  REACH_SOURCES,
  REACH_TYPE_CITED,
  REACH_TYPE_LABEL,
  REACH_TYPES,
  reachChips,
  reachTotal,
  reachLinks,
  reachQueryString,
  resolveReachParams,
  STAGE_ANY,
  STAGE_KEYS,
  stageKeyLabel,
  tickedTypes,
  withReachDocDetails,
  withReachPublicationDetails,
  type ModalCounts,
  type ReachDocRow,
  type ReachDocSort,
  type ReachParams,
  type ReachPersonRow,
  type ReachPubRow,
  type ReachSort,
  type ReachType,
} from "@/lib/edit/downstream-reach-report";
import { unitLabels } from "@/lib/edit/person-filter";
import { fiscalLabel, loadPersonNames, UNKNOWN_PERSON, yearSpan } from "@/lib/edit/policy-citations-report";
import type { AdminReportProps, ReportRender } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

const RAIL_LEGEND = "mb-1.5 p-0 text-[13px] font-medium";
const TEST = "downstream-reach";

/** One paper, one citing document, and so on: the noun a count's link names. */
const TYPE_NOUN: Record<ReachType, [string, string]> = {
  clinical: ["clinical study", "clinical studies"],
  trial: ["registered trial", "registered trials"],
  policy: ["guideline or policy document", "guideline and policy documents"],
  review: ["systematic review", "systematic reviews"],
  patent: ["invention", "inventions"],
};
const noun = (n: number, [one, many]: [string, string]) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const PAPERS: [string, string] = ["paper", "papers"];
const PUBLICATIONS: [string, string] = ["publication", "publications"];

/** A zero: a dash, with the number for a screen reader (report 24's cell). */
function Dash() {
  return (
    <span className="text-muted-foreground/70">
      <span aria-hidden>–</span>
      <span className="sr-only">0</span>
    </span>
  );
}

type RailProps = {
  basePath: string;
  params: ReachParams;
  facets: DataQualityFacets;
  labels: ReadonlyMap<string, string>;
  areas: { id: string; label: string }[];
  /** A name for every ticked person (`loadPersonNames`). */
  names: ReadonlyMap<string, string>;
  resetHref: string | null;
};

function Rail({ basePath, params, facets, labels, areas, names, resetHref }: RailProps) {
  return (
    <CitationRail
      basePath={basePath}
      testId={TEST}
      params={params}
      facets={facets}
      labels={labels}
      resetHref={resetHref}
      counts={false}
      hidden={
        <>
          <input type="hidden" name="view" value={params.view} />
          <input type="hidden" name="sort" value={params.sort} />
          {params.asc && <input type="hidden" name="order" value="asc" />}
          <input type="hidden" name="dsort" value={params.docSort} />
          {params.q && <input type="hidden" name="q" value={params.q} />}
          {params.pmid && <input type="hidden" name="pmid" value={params.pmid} />}
          {params.docs.map((d) => (
            <input key={d} type="hidden" name="doc" value={d} />
          ))}
          {params.showAll && <input type="hidden" name="show" value="all" />}
          {params.view === "connections" && params.with && (
            <>
              <input type="hidden" name="with" value={params.with} />
              <input type="hidden" name="dir" value={params.dir} />
            </>
          )}
          {/* The form was submitted: no stage ticked then means every stage. */}
          <input type="hidden" name="stage" value={STAGE_ANY} />
          {/* Sent always; the ticked box below adds "out", which wins. */}
          <input type="hidden" name="own" value="in" />
        </>
      }
      citing={{
        title: "Downstream citations",
        help: "Which citing documents are counted, and which papers they are counted for.",
        children: (
          <>
            <fieldset className="m-0 border-0 px-[18px] pt-0 pb-3" data-testid={`${TEST}-ctype`}>
              <legend className={RAIL_LEGEND}>Citing type</legend>
              <RailChecklist
                name="ctype"
                roomy
                options={REACH_TYPES.map((t) => ({ value: t, label: REACH_TYPE_LABEL[t] }))}
                selected={params.ctypes}
              />
              <p className="text-muted-foreground mt-1 text-xs">None checked = all.</p>
              <label className="border-apollo-rail-border mt-3 flex cursor-pointer items-center gap-2 border-t pt-2.5 text-sm">
                <input
                  type="checkbox"
                  name="own"
                  value="out"
                  defaultChecked={!params.includeOwn}
                  className="accent-apollo-maroon size-4"
                  data-testid={`${TEST}-own`}
                />
                Leave out the authors&rsquo; own work
              </label>
            </fieldset>
            <fieldset className="m-0 border-0 px-[18px] pt-0 pb-3" data-testid={`${TEST}-stage`}>
              <legend className={RAIL_LEGEND}>Stage of the cited paper</legend>
              <RailChecklist
                name="stage"
                roomy
                options={STAGE_KEYS.map((k) => ({ value: k, label: stageKeyLabel(k) }))}
                selected={params.stages}
              />
              <p className="text-muted-foreground mt-1 text-xs">None checked = every stage.</p>
            </fieldset>
            <RailSection
              label="Research area"
              summary={summarize(params.area ? [areas.find((a) => a.id === params.area)?.label ?? params.area] : [])}
              testId={`${TEST}-area`}
            >
              <select name="area" defaultValue={params.area ?? ""} aria-label="Research area" className={SELECT}>
                <option value="">Any</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </RailSection>
          </>
        ),
      }}
      personOptions={params.people.map((c) => ({ value: c, label: names.get(c) ?? UNKNOWN_PERSON }))}
      personNote="Pick a person from the People tab, or from an author's card on a paper."
      personSearch={false}
    />
  );
}

/** A count column's header (spec B3): a link that sorts by it, highest first,
 *  and lowest first on the next click; `aria-sort` says which. Plain text when
 *  the list does not sort (every publication in scope, newest first). */
function SortTH({
  label,
  sort,
  current,
  sortHref,
  className,
}: {
  label: string;
  sort: "cited" | ReachType;
  current: { sort: ReachSort; asc: boolean } | null;
  sortHref: (sort: ReachSort, asc: boolean) => string;
  className?: string;
}) {
  const on = current?.sort === sort;
  const asc = on && current!.asc;
  return (
    <th
      className={cn(TH, "text-right whitespace-normal", className)}
      aria-sort={current === null ? undefined : on ? (asc ? "ascending" : "descending") : "none"}
    >
      {current === null ? (
        label
      ) : (
        <Link href={sortHref(sort, on && !asc)} className="hover:underline" data-testid={`${TEST}-sort-${sort}`}>
          {label}
          <span aria-hidden className={cn("ml-1", on ? "" : "invisible")}>
            {asc ? "▲" : "▼"}
          </span>
        </Link>
      )}
    </th>
  );
}

function PublicationTable({
  pubs,
  types,
  modal,
  hidden,
  on,
  docsHref,
  footer,
  sorted,
  sortHref,
  match,
}: {
  pubs: ReachPubRow[];
  types: readonly ReachType[];
  /** What the publication modal would list, per PMID (`loadModalCounts`). */
  modal: ReadonlyMap<string, ModalCounts>;
  /** Papers the modal will not open (`loadModalHidden`). */
  hidden: ReadonlySet<string>;
  on: Record<ReachType, boolean>;
  /** The Citing documents view filtered to one paper and type (null: every ticked type). */
  docsHref: (pmid: string, type: ReachType | null) => string;
  footer: PersonFooter;
  /** The current order; null when the list does not sort. */
  sorted: { sort: ReachSort; asc: boolean } | null;
  sortHref: (sort: ReachSort, asc: boolean) => string;
  /** Authors who put the paper in scope (the person-type filter), if one is set. */
  match?: (a: ReachPubRow["authors"][number]) => boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-sm tabular-nums" data-testid={`${TEST}-publications`}>
        <thead>
          <tr className="bg-apollo-surface-2 text-left">
            <th className={TH}>Publication</th>
            <SortTH label="Total" sort="cited" current={sorted} sortHref={sortHref} className="font-semibold" />
            {types.map((t) => (
              <SortTH key={t} label={REACH_TYPE_LABEL[t]} sort={t} current={sorted} sortHref={sortHref} />
            ))}
          </tr>
        </thead>
        <tbody>
          {pubs.map((r) => (
            <tr key={r.pmid} className="border-apollo-border border-b" data-testid={`${TEST}-pub-row`}>
              <td className={cn(TD, "min-w-[320px]")}>
                {hidden.has(r.pmid) ? (
                  <span className="font-medium">
                    <PubTitle value={r.title} />
                  </span>
                ) : (
                  <PaperTitle pmid={r.pmid} title={r.title} />
                )}
                <div className="text-muted-foreground mt-0.5 leading-normal">
                  <PubMeta
                    pub={r}
                    copy
                    extra={
                      r.stage === "none" ? (
                        <span className="text-xs">{NO_STAGE_LABEL}</span>
                      ) : (
                        <span data-testid="pub-row-stage">
                          <StageTag stage={r.stage} />
                        </span>
                      )
                    }
                  />
                </div>
                <AuthorPills authors={r.authors} footer={footer} max={3} match={match} />
              </td>
              <td className={cn(TD, "text-right text-[15px] font-semibold")} data-testid={`${TEST}-cell-total`}>
                {reachTotal(r, types) > 0 ? (
                  <Link
                    href={docsHref(r.pmid, null)}
                    aria-label={`${reachTotal(r, types).toLocaleString()} citing documents of this paper`}
                    className={LINK}
                  >
                    {reachTotal(r, types).toLocaleString()}
                  </Link>
                ) : (
                  <Dash />
                )}
              </td>
              {types.map((t) => {
                const n = r[t];
                const label = `${noun(n, TYPE_NOUN[t])} citing this paper`;
                return (
                  <td key={t} className={cn(TD, "text-right")} data-testid={`${TEST}-cell-${t}`}>
                    {n <= 0 ? (
                      <Dash />
                    ) : modalListsExactly(t, n, hidden.has(r.pmid) ? undefined : modal.get(r.pmid), on) ? (
                      <ModalCount pmid={r.pmid} section={MODAL_SECTION[t]} label={label} className={LINK}>
                        {n.toLocaleString()}
                      </ModalCount>
                    ) : (
                      <Link href={docsHref(r.pmid, t)} aria-label={label} className={LINK}>
                        {n.toLocaleString()}
                      </Link>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocumentTable({
  docs,
  papersHref,
}: {
  docs: ReachDocRow[];
  /** The Publications view filtered to one citing document; null when the URL
   *  can carry no more of them (the count is then not shown). */
  papersHref: (docId: number) => string | null;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm tabular-nums" data-testid={`${TEST}-documents`}>
        <thead>
          <tr className="bg-apollo-surface-2 text-left">
            <th className={TH}>Citing document</th>
            <th className={TH}>Type</th>
            <th className={TH}>Year</th>
            <th className={cn(TH, "text-right whitespace-normal")}>WCM papers cited</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const href = papersHref(d.docId);
            return (
              <tr key={`${d.level}:${d.docId}`} className="border-apollo-border border-b" data-testid={`${TEST}-doc-row`}>
                <td className={cn(TD, "min-w-[320px]")}>
                  <ExternalLink href={d.url} className="font-medium">
                    <PubTitle value={d.title} />
                  </ExternalLink>
                  {d.source && <div className="text-muted-foreground text-[13px]">{d.source}</div>}
                </td>
                <td className={TD}>{d.kind}</td>
                <td className={TD}>{d.year}</td>
                <td className={cn(TD, "text-right")}>
                  {href ? (
                    <Link
                      href={href}
                      aria-label={`${noun(d.papers, PAPERS)} cited by this document`}
                      className={LINK}
                    >
                      {d.papers.toLocaleString()}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground text-xs">Remove a &ldquo;Cited by&rdquo; filter to open</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PeopleTable({
  people,
  types,
  countHref,
  footer,
  bibliometrics,
}: {
  people: ReachPersonRow[];
  types: readonly ReachType[];
  /** The Publications view filtered to the person, and to one type when given. */
  countHref: (cwid: string, type: ReachType | null) => string;
  footer: PersonFooter;
  bibliometrics: (cwid: string) => string | null;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-sm tabular-nums" data-testid={`${TEST}-people`}>
        <thead>
          <tr className="bg-apollo-surface-2 text-left">
            <th className={TH}>Person</th>
            <th className={TH}>Org unit</th>
            <th className={TH}>Person type</th>
            <th className={cn(TH, "text-right whitespace-normal")}>Papers cited downstream</th>
            {types.map((t) => (
              <th key={t} className={cn(TH, "text-right whitespace-normal")}>
                Papers {REACH_TYPE_CITED[t]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((r) => (
            <tr key={r.cwid} className="border-apollo-border border-b" data-testid={`${TEST}-person-row`}>
              <PersonCell cwid={r.cwid} name={r.name} footer={footer} bibliometrics={bibliometrics(r.cwid)} />
              <td className={TD}>{r.orgUnit}</td>
              <td className={TD}>{r.personType}</td>
              <td className={cn(TD, "text-right")}>
                <Link
                  href={countHref(r.cwid, null)}
                  aria-label={`${noun(r.papers, PAPERS)} by ${r.name} cited downstream`}
                  className={LINK}
                >
                  {r.papers.toLocaleString()}
                </Link>
              </td>
              {types.map((t) => (
                <td key={t} className={cn(TD, "text-right")}>
                  {r[t] > 0 ? (
                    <Link
                      href={countHref(r.cwid, t)}
                      aria-label={`${noun(r[t], PAPERS)} by ${r.name} ${REACH_TYPE_CITED[t]}`}
                      className={LINK}
                    >
                      {r[t].toLocaleString()}
                    </Link>
                  ) : (
                    <Dash />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "clinical studies, registered trials or patents". */
function typePhrase(types: readonly ReachType[]): string {
  const names = types.map((t) => REACH_TYPE_LABEL[t].toLowerCase());
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0];
}

export async function renderDownstreamReachReport({
  session,
  searchParams,
  basePath,
}: AdminReportProps): Promise<ReportRender> {
  // The page gate (`canViewDownstreamReachReport`) already refused; these are
  // the backstop, and with the flag off nothing below runs.
  if (!isDownstreamReachReportEnabled()) notFound();
  const params = await resolveReachParams(parseReachParams(toSearchParams(searchParams)), session);
  if (params.scope !== null && params.scope.length === 0) notFound();
  const { view } = params;
  const types = tickedTypes(params);
  const offset = (params.page - 1) * REACH_PAGE_SIZE;
  const [facets, areas, data, connections] = await Promise.all([
    loadDataQualityFacets(db.read),
    loadReachAreas(),
    loadReach(params, { views: [view], limit: REACH_PAGE_SIZE, offset }),
    // Only when its tab is open: no Connections query runs for another view.
    view === "connections" ? loadConnectionsPage(params, offset, REACH_PAGE_SIZE) : null,
  ]);
  const people = (data.people ?? []).slice(offset, offset + REACH_PAGE_SIZE);
  const pagePmids = data.pubs.map((r) => r.pmid);
  const [pubs, modal, hidden, docs, names] = await Promise.all([
    withReachPublicationDetails(params, data.pubs),
    // What the modal would list for this page's rows: decides each cell's link.
    loadModalCounts(params, pagePmids),
    // Papers the public modal will not open at all.
    loadModalHidden(pagePmids),
    withReachDocDetails(data.docs),
    loadPersonNames(params, data.people ?? []),
  ]);
  // One decision for everyone named on this page, not one per pill or row.
  const mayOpenBibliometrics = await loadBibliometricsAccess(
    view === "publications"
      ? [...new Set(pubs.flatMap((r) => r.authors.map((a) => a.cwid)))]
      : view === "people"
        ? people.map((r) => r.cwid)
        : view === "connections"
          ? connectionsPageCwids(connections)
          : [],
  );
  const labels = unitLabels(facets);
  const areaLabel = new Map(areas.map((a) => [a.id, a.label]));
  const chips = reachChips(params, labels, names, areaLabel);
  const href = (q: string) => `${basePath}?${q}`;
  /** The list behind each number (`reachLinks`). */
  const links = reachLinks(params);
  const bibliometrics = (cwid: string) => (mayOpenBibliometrics.has(cwid) ? bibliometricsHref(cwid) : null);
  const personFooter: PersonFooter = (cwid) =>
    personCardFooter(
      href(reachQueryString(params, { view: "publications", q: "", showAll: false, people: [...new Set([...params.people, cwid])] })),
      bibliometrics(cwid),
    );
  const resetHref = isReachDefault(params) ? null : view === "publications" ? basePath : href(`view=${view}`);
  const rail = (
    <Rail
      basePath={basePath}
      params={params}
      facets={facets}
      labels={labels}
      areas={areas}
      names={names}
      resetHref={resetHref}
    />
  );
  const tab = (v: ReachParams["view"], label: string, count: number | null) => (
    <ReportTab href={href(links.view(v))} current={view === v && !params.showAll} testId={`${TEST}-view-${v}`}>
      {count === null ? label : `${label} (${count.toLocaleString()})`}
    </ReportTab>
  );
  /** The tab's GET form: everything in the URL except what the form itself sets. */
  const toolbar = (own: Partial<ReachParams>, children: ReactNode) => (
    <Toolbar basePath={basePath} query={reachQueryString(params, own)} testId={`${TEST}-toolbar`}>
      {children}
    </Toolbar>
  );
  const pager = (total: number) => (
    <Pager
      page={params.page}
      total={total}
      pageSize={REACH_PAGE_SIZE}
      href={(page) => href(reachQueryString(params, { page }))}
      testId={`${TEST}-pager`}
    />
  );
  const published = yearSpan(params.from, params.to, fiscalLabel(params));
  const stagesText =
    params.stages.length > 0 ? `at ${params.stages.map(stageKeyLabel).join(", ")}` : "at every stage";
  // The Sort by options for the ticked types only, in step with the headers.
  const sortOptions = Object.fromEntries(
    (Object.keys(REACH_SORT_LABEL) as ReachSort[])
      .filter((k) => !(REACH_TYPES as readonly string[]).includes(k) || types.includes(k as ReachType))
      .map((k) => [k, REACH_SORT_LABEL[k]]),
  ) as Record<ReachSort, string>;
  const allTypes = params.ctypes.length === 0 || params.ctypes.length === REACH_TYPES.length;

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm" data-testid={`${TEST}-subtitle`}>
        Publications {stagesText} · {published ? `published ${published}` : "published in any year"} ·{" "}
        {params.scope === null ? "all units" : params.scope.map((u) => labels.get(u) ?? u).join("; ")} · cited by{" "}
        {typePhrase(types)}
        {params.includeOwn ? " · the authors' own work counted" : " · the authors' own work left out"}
      </p>
    ),
    aside: (
      <>
        <Button asChild variant="apollo" size="sm">
          <a
            href={`/api/edit/reports/downstream-reach?${reachQueryString(params, { q: "", showAll: false })}`}
            data-testid={`${TEST}-download`}
          >
            <Download className="size-4" aria-hidden />
            Export spreadsheet
          </a>
        </Button>
        <span className="text-muted-foreground text-xs" data-testid={`${TEST}-download-note`}>
          {connections?.status === "lists" || connections?.status === "pairs"
            ? "Publications, Citing documents, People, Connections and Criteria sheets"
            : "Publications, Citing documents, People and Criteria sheets"}
          {data.pubTotal > REACH_LIST_CAP && " · Publications lists the first rows only; the Criteria sheet says how many"}
          {docsTooWide(data.pubTotal) &&
            " · Citing documents is not listed for a selection this wide; the Criteria sheet says so"}
        </span>
      </>
    ),
    main: (
      <ReportLayout rail={rail}>
        <div className="flex min-w-0 flex-col gap-4 text-sm">
          <div className="lg:hidden">
            <FiltersSheet
              activeCount={chips.filter((c) => c.removeQuery !== null).length}
              testId={`${TEST}-filters-sheet-trigger`}
            >
              {rail}
            </FiltersSheet>
          </div>
          <FilterChips
            chips={chips.map((c) => ({
              group: c.group,
              value: c.value,
              mono: c.mono,
              removeHref: c.removeQuery === null ? null : href(c.removeQuery),
            }))}
            testId={`${TEST}-chips`}
          />
          {/* Every tile is a link to the list of exactly what it counts. */}
          <ReportStats
            testId={`${TEST}-tiles`}
            stats={[
              {
                label: allTypes
                  ? "publications in scope were cited downstream"
                  : `publications in scope were cited by ${typePhrase(types)}`,
                value: (
                  <>
                    <Link
                      href={href(links.cited())}
                      aria-label={`${noun(data.pubTotal, PUBLICATIONS)} ${allTypes ? "cited downstream" : `cited by ${typePhrase(types)}`}`}
                      className={LINK}
                      data-testid={`${TEST}-tile-cited`}
                    >
                      {data.pubTotal.toLocaleString()}
                    </Link>
                    <span className="text-muted-foreground px-2 text-xl font-normal tracking-normal">of</span>
                    <Link
                      href={href(links.scope())}
                      aria-label={`${noun(data.scopeTotal, PUBLICATIONS)} in scope, cited or not`}
                      className={LINK}
                      data-testid={`${TEST}-tile-scope`}
                    >
                      {data.scopeTotal.toLocaleString()}
                    </Link>
                  </>
                ),
              },
              ...REACH_TYPES.map((t) => ({
                label: REACH_TYPE_CITED[t],
                value: (
                  <Link
                    href={href(links.type(t))}
                    aria-label={`${noun(data.typePapers[t], PUBLICATIONS)} ${REACH_TYPE_CITED[t]}`}
                    className={LINK}
                    data-testid={`${TEST}-tile-${t}`}
                  >
                    {data.typePapers[t].toLocaleString()}
                  </Link>
                ),
              })),
            ]}
          />
          <ReportCard className="overflow-hidden p-0 sm:p-0">
            <nav className="border-apollo-border flex flex-wrap gap-x-5 gap-y-1 border-b px-4" aria-label="Report views">
              {tab("publications", "Publications", data.pubTotal)}
              {tab("documents", "Citing documents", data.docTotal)}
              {tab("people", "People", data.peopleTotal)}
              {tab("connections", "Connections", null)}
            </nav>
            {view === "publications" ? (
              <PublicationModalProvider>
                {params.showAll ? (
                  <p className="text-muted-foreground px-4 py-3 text-[13px]" data-testid={`${TEST}-show-all`}>
                    Every publication in scope, cited or not, newest first.{" "}
                    <Link href={href(links.cited())} className={LINK}>
                      List only those cited downstream
                    </Link>
                  </p>
                ) : (
                  // A new Sort by pick starts highest first, so the toolbar drops `order`.
                  toolbar(
                    { q: "", sort: "cited", asc: false },
                    <>
                      <SearchField label="Search title, PMID or author" placeholder="e.g. 12345678" value={params.q} />
                      <SortSelect<ReachSort> name="sort" value={params.sort} options={sortOptions} />
                    </>,
                  )
                )}
                <PublicationTable
                  pubs={pubs}
                  types={types}
                  modal={modal}
                  hidden={hidden}
                  on={modalGroupsOn()}
                  docsHref={(pmid, type) => href(links.paperDocs(pmid, type))}
                  footer={personFooter}
                  sorted={params.showAll ? null : { sort: params.sort, asc: params.asc }}
                  sortHref={(sort, asc) => href(reachQueryString(params, { sort, asc }))}
                  match={params.types.length > 0 ? (a) => params.types.includes(a.roleCategory ?? "") : undefined}
                />
                {data.pubMatched === 0 && (
                  <p className="text-muted-foreground px-4 pt-3 text-[13px]">
                    {params.q
                      ? "No publications match the search."
                      : "No publications match. Try another stage or citing type, or widen the years."}
                  </p>
                )}
                {pager(data.pubMatched)}
              </PublicationModalProvider>
            ) : view === "documents" && data.docsWithheld != null ? (
              <p className="text-muted-foreground px-4 py-3 text-[13px]" data-testid={`${TEST}-docs-too-wide`}>
                This selection is too wide to list citing documents. It covers{" "}
                <Link
                  href={href(links.cited())}
                  aria-label={`${noun(data.docsWithheld, PUBLICATIONS)} cited downstream in this selection`}
                  className={LINK}
                >
                  {data.docsWithheld.toLocaleString()}
                </Link>{" "}
                cited papers, and citing documents are listed for at most{" "}
                {REACH_DOCS_PAPER_CEILING.toLocaleString()}. {REACH_DOCS_NARROW_HINT}
              </p>
            ) : view === "documents" ? (
              <>
                {toolbar(
                  { docSort: "papers" },
                  <>
                    <span className="text-muted-foreground flex-[1_1_220px] text-[13px]">
                      One row per clinical study, registered trial, guideline or policy document, systematic
                      review, or invention
                      (related patents are one row).
                    </span>
                    <SortSelect<ReachDocSort> name="dsort" value={params.docSort} options={REACH_DOC_SORT_LABEL} />
                  </>,
                )}
                <DocumentTable
                  docs={docs}
                  papersHref={(docId) => {
                    const q = links.docPapers(docId);
                    return q === null ? null : href(q);
                  }}
                />
                {data.docTotal === 0 && (
                  <p className="text-muted-foreground px-4 pt-3 text-[13px]">
                    No citing documents match. Try another stage or citing type, or widen the years.
                  </p>
                )}
                {pager(data.docTotal ?? 0)}
              </>
            ) : view === "connections" && connections ? (
              <ConnectionsPanel
                page={connections}
                params={params}
                pageSize={REACH_PAGE_SIZE}
                href={href}
                footer={personFooter}
                bibliometrics={bibliometrics}
                peopleHref={href(links.view("people"))}
              />
            ) : (
              <>
                {toolbar(
                  { q: "" },
                  <SearchField label="Search name or CWID" placeholder="e.g. a name" value={params.q} />,
                )}
                <PeopleTable
                  people={people}
                  types={types}
                  countHref={(cwid, type) => href(links.person(cwid, type))}
                  footer={personFooter}
                  bibliometrics={bibliometrics}
                />
                {(data.people ?? []).length === 0 && (
                  <p className="text-muted-foreground px-4 pt-3 text-[13px]">
                    {params.q
                      ? "No people match the search."
                      : `No scholar has ${MIN_REACH_PAPERS} or more first- or senior-author papers cited downstream for this combination.`}
                  </p>
                )}
                {pager((data.people ?? []).length)}
              </>
            )}
          </ReportCard>
          <p className="text-muted-foreground max-w-[760px] text-[13px]" role="note">
            {REACH_COUNTING_RULE} {REACH_REVIEW_RULE} Every number opens the list of what it counts: a count on a paper opens its
            citing documents, a count on a citing document or a person opens the papers. People are listed
            only as first or senior author, with at least {MIN_REACH_PAPERS} such papers, by count. Stages are
            assigned by a model and not reviewed; a later stage is not a better one. {REACH_SOURCES}
          </p>
        </div>
      </ReportLayout>
    ),
  };
}
