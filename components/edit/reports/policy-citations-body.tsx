/**
 * Report 24 — "Guideline and policy citations" body (mockup: the report 24
 * redesign, 2026-11-25). The shared pieces (`report-ui.tsx`, and
 * `citation-report-parts.tsx` with report 25): a filter rail in a plain GET
 * `AutoSubmitForm`, the active filters as chips, the results card. The rail's
 * Type and Issuing body checklists carry the paper counts. In the card, the
 * By publication / By citing document / By person tabs, each with its own
 * search or sort form and pages of `POLICY_PAGE_SIZE`. The export button
 * rides the report header (`aside`), the link to report 25 the back-link row
 * (`related`).
 *
 * Filters, search, sort, tab and page are the URL. The only client state is
 * which rows are open, to what, and "copied" (`policy-citations-client.tsx`);
 * what an open row shows is rendered here, for the rows on the page only.
 *
 * Parser, access scope, loaders, chips and the workbook live in
 * `lib/edit/policy-citations-report.ts`; the download route
 * (`/api/edit/reports/policy-citations`) takes the same query string.
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
  LIST_HEAD,
  Pager,
  PersonCell,
  personCardFooter,
  personFacetOptions,
  plural,
  PubMeta,
  RelatedReport,
  ReportTab,
  SearchField,
  SortSelect,
  TD,
  TH,
  Toolbar,
  toSearchParams,
  YearRange,
  type PersonFooter,
} from "@/components/edit/reports/citation-report-parts";
import {
  Disclosure,
  LevelIcon,
  PubRow,
  type CitedByChip,
  type DocSection,
} from "@/components/edit/reports/policy-citations-client";
import { RailChecklist } from "@/components/edit/reports/rail-checklist";
import { FilterChips, RailSection, ReportCard, ReportLayout } from "@/components/edit/reports/report-ui";
import { PubTitle } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import { loadDataQualityFacets, type DataQualityFacets } from "@/lib/api/data-quality";
import { db } from "@/lib/db";
import { bibliometricsHref, loadBibliometricsAccess } from "@/lib/edit/bibliometrics-access";
import {
  isPatentCitationsReportEnabled,
  parsePatentCitationParams,
  patentCitationQueryString,
} from "@/lib/edit/patent-citations-report";
import { unitLabels } from "@/lib/edit/person-filter";
import {
  BODIES,
  BODY_NAME,
  DOC_PAPERS_SHOWN,
  DOC_SORT_LABEL,
  fiscalLabel,
  groupEditions,
  howCited,
  isPolicyCitationDefault,
  LEVEL_LABEL,
  LEVEL_ONE,
  LEVELS,
  loadCitingDocuments,
  loadPersonNames,
  loadPolicyCitations,
  loadPolicyDocuments,
  parsePolicyCitationParams,
  POLICY_LIST_CAP,
  POLICY_PAGE_SIZE,
  policyCitationChips,
  policyCitationQueryString,
  resolvePolicyCitationParams,
  REVIEWS_SHOWN,
  SORT_LABEL,
  yearRange,
  yearSpan,
  type BodyPapers,
  type CitingDoc,
  type DocRow,
  type DocSort,
  type Level,
  type LevelCounts,
  type PersonRow,
  type PolicyCitationParams,
  type PolicySort,
  type PubRow as PubRowData,
} from "@/lib/edit/policy-citations-report";
import { reportMetaFor } from "@/lib/edit/report-meta";
import type { AdminReportProps, ReportRender } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

/** The Person facet offers this many people (by authority-cited papers). */
const FACET_PEOPLE = 50;

const EYEBROW = "text-muted-foreground text-xs tracking-[0.05em] uppercase";
const DOC_COLS = "grid grid-cols-[minmax(0,1fr)_150px_110px_100px] gap-3 px-4";

type RailProps = {
  basePath: string;
  params: PolicyCitationParams;
  facets: DataQualityFacets;
  labels: ReadonlyMap<string, string>;
  people: PersonRow[];
  /** A name for every ticked person (`loadPersonNames`). */
  names: ReadonlyMap<string, string>;
  /** Papers cited at each level, whatever `level` lists. */
  levelPapers: LevelCounts;
  /** Papers per issuing body, whichever bodies are ticked. */
  bodyPapers: BodyPapers[];
  resetHref: string | null;
};

const RAIL_LEGEND = "mb-1.5 p-0 text-[13px] font-medium";
const RAIL_LEGEND_NOTE = <span className="text-muted-foreground font-normal"> · papers cited</span>;

function Rail({ basePath, params, facets, labels, people, names, levelPapers, bodyPapers, resetHref }: RailProps) {
  const papersOf = new Map(bodyPapers.map((b) => [b.body, b.papers]));
  // Every body, most papers first; one with none still lists, so it can be unticked.
  const bodies = BODIES.map((b) => ({ value: b, label: b, title: BODY_NAME[b], count: papersOf.get(b) ?? 0 })).sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
  // Top people by authority-cited papers; a ticked person always lists.
  const top = people.filter((r) => r.authority > 0).slice(0, FACET_PEOPLE);
  return (
    <CitationRail
      basePath={basePath}
      testId="policy-citations"
      params={params}
      facets={facets}
      labels={labels}
      resetHref={resetHref}
      hidden={
        <>
          <input type="hidden" name="view" value={params.view} />
          <input type="hidden" name="sort" value={params.sort} />
          <input type="hidden" name="dsort" value={params.docSort} />
          {params.q && <input type="hidden" name="q" value={params.q} />}
        </>
      }
      citing={{
        title: "Citing documents",
        help: "Which citations are counted, in every number.",
        children: (
          <>
            <fieldset className="m-0 border-0 px-[18px] pt-0 pb-3" data-testid="policy-citations-level">
              <legend className={RAIL_LEGEND}>Type{RAIL_LEGEND_NOTE}</legend>
              <RailChecklist
                name="level"
                roomy
                options={LEVELS.map((l) => ({ value: l, label: LEVEL_ONE[l], count: levelPapers[l] }))}
                selected={params.levels}
              />
              <p className="text-muted-foreground mt-1 text-xs">
                Lists the papers, documents and people cited by these types of document. None checked = all.
              </p>
              <label className="border-apollo-rail-border mt-3 flex cursor-pointer items-center gap-2 border-t pt-2.5 text-sm">
                <input
                  type="checkbox"
                  name="excl"
                  value="1"
                  defaultChecked={params.hideExcluded}
                  className="accent-apollo-maroon size-4"
                  data-testid="policy-citations-hide-excluded"
                />
                Hide excluded-study citations
              </label>
            </fieldset>
            <fieldset className="m-0 border-0 px-[18px] pt-0 pb-3" data-testid="policy-citations-body">
              <legend className={RAIL_LEGEND}>Issuing body{RAIL_LEGEND_NOTE}</legend>
              <RailChecklist name="body" roomy options={bodies} selected={params.bodies} />
            </fieldset>
            <RailSection
              label="Year published"
              summary={yearSpan(params.cfrom, params.cto) ?? "Any"}
              testId="policy-citations-citing-year"
            >
              <YearRange
                from={{ name: "cfrom", value: params.cfrom }}
                to={{ name: "cto", value: params.cto }}
                what="citing document year"
              />
            </RailSection>
          </>
        ),
      }}
      personOptions={personFacetOptions(people, params.people, top, (r) => r.authority, names)}
      personNote={`The ${FACET_PEOPLE} people with the most papers cited by health authorities. Anyone else: open them from the By person tab.`}
    />
  );
}

/** "Ghany MG, Morgan TR, Marks KM, et al." from the stored author list. */
function firstAuthors(authors: string): string {
  const names = authors.split(", ");
  return names.length > 3 ? `${names.slice(0, 3).join(", ")}, et al.` : `${authors.replace(/\.$/, "")}.`;
}

function Locations({ doc }: { doc: CitingDoc }) {
  return doc.locations.map((l, i) => (
    <span key={l.url}>
      {i > 0 && "; "}
      <ExternalLink href={l.url}>{l.label}</ExternalLink>
    </span>
  ));
}

/** One citing document under a publication. An authority document carries
 *  its editions (newest first): the body, the span of years, how it cites the
 *  paper, and each edition on request. A PubMed document is a full reference:
 *  authors, journal, year;volume(issue):pages, PMID, DOI. */
function CitingDocEntry({ editions }: { editions: CitingDoc[] }) {
  const doc = editions[0];
  const years = editions.flatMap((d) => (d.year === null ? [] : [d.year]));
  const span = years.length > 0 ? yearRange(Math.min(...years), Math.max(...years)) : "";
  const how = howCited(editions);
  return (
    <div className="border-apollo-border flex max-w-[820px] flex-col gap-1 border-t py-3 first:border-t-0">
      <div className={EYEBROW}>
        <LevelIcon level={doc.level} />
        {LEVEL_ONE[doc.level]}
        {doc.level === "authority" && doc.issuingBody && ` · ${doc.issuingBody}`}
      </div>
      <ExternalLink href={doc.url} className="text-[15px] leading-[1.4] font-medium">
        {doc.title}
      </ExternalLink>
      {doc.bookshelfId ? (
        <>
          <div className="text-muted-foreground text-[13px]">
            {[
              (doc.issuingBody && BODY_NAME[doc.issuingBody]) || doc.publisher,
              editions.length > 1 ? `${editions.length} editions${span && `, ${span}`}` : span,
              "NCBI Bookshelf",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {how && (
            <div className="mt-2 text-sm">
              <span className="font-semibold">How it cites this paper:</span> {how}
            </div>
          )}
          {editions.length > 1 ? (
            <div>
              <Disclosure
                show={`Show the ${editions.length} editions and where each cites the paper`}
                hide="Hide editions"
                className="py-1"
              >
                <table className="mt-1 w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="text-muted-foreground text-left text-xs">
                      <th className="pb-1.5 font-normal">Edition</th>
                      <th className="pb-1.5 font-normal">Where it cites the paper</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editions.map((d) => (
                      <tr key={d.id} className="align-top">
                        <td className="w-1/2 py-[3px] pr-6">
                          <ExternalLink href={d.url}>
                            {d.year ?? "Undated"} · {d.bookshelfId}
                          </ExternalLink>
                          {d.title !== doc.title && <div className="text-muted-foreground text-xs">{d.title}</div>}
                        </td>
                        <td className="py-[3px]">
                          <Locations doc={d} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Disclosure>
            </div>
          ) : (
            doc.locations.length > 0 && (
              <div className="text-muted-foreground text-[13px]">
                Where: <Locations doc={doc} />
              </div>
            )
          )}
        </>
      ) : (
        <div className="text-muted-foreground text-[13px]">
          {doc.authors && <>{firstAuthors(doc.authors)} </>}
          {doc.journal && (
            <>
              <em>{doc.journal}</em>.{" "}
            </>
          )}
          {doc.cite && <>{doc.cite}.</>}
          {doc.pmid && (
            <>
              {" · "}
              <a
                href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(doc.pmid)}/`}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(LINK, "whitespace-nowrap")}
              >
                PMID {doc.pmid}
              </a>
            </>
          )}
          {doc.doi && (
            <>
              {" · "}
              <a
                href={`https://doi.org/${encodeURI(doc.doi)}`}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(LINK, "break-all")}
              >
                DOI {doc.doi}
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PublicationList({
  pubs,
  docs,
  listed,
  footer,
}: {
  pubs: PubRowData[];
  /** The citing documents of the rows on this page, per PMID. */
  docs: ReadonlyMap<string, CitingDoc[]>;
  listed: readonly Level[];
  footer: PersonFooter;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]" data-testid="policy-citations-publications">
        <div className={cn(LIST_HEAD, "grid grid-cols-[minmax(0,1fr)_220px] gap-6")}>
          <span>Publication</span>
          <span>Cited by</span>
        </div>
        {pubs.map((r) => {
          const groups = groupEditions(docs.get(r.pmid) ?? []);
          const authority = groups.filter((g) => g[0].level === "authority");
          /** What an authority document's chip is keyed on. */
          const bodyOf = (g: CitingDoc[]) => g[0].issuingBody ?? "Health authority";
          const byBody = new Map<string, number>();
          for (const g of authority) byBody.set(bodyOf(g), (byBody.get(bodyOf(g)) ?? 0) + 1);
          const shown = (l: Level) => listed.includes(l) && r[l] > 0;
          const chips: CitedByChip[] = [
            ...(listed.includes("authority")
              ? [...byBody].map(([body, n]) => ({
                  level: "authority" as const,
                  label: `${body} · ${n}`,
                  title: BODY_NAME[body],
                  body,
                }))
              : []),
            ...(shown("guideline")
              ? [{ level: "guideline" as const, label: plural(r.guideline, "guideline", "guidelines") }]
              : []),
            ...(shown("consensus")
              ? [
                  {
                    level: "consensus" as const,
                    label: plural(r.consensus, "consensus statement", "consensus statements"),
                  },
                ]
              : []),
            ...(shown("review")
              ? [{ level: "review" as const, label: plural(r.review, "systematic review", "systematic reviews") }]
              : []),
          ];
          const count =
            (listed.includes("authority") ? authority.length : 0) +
            (["guideline", "consensus", "review"] as const).reduce((n, l) => n + (shown(l) ? r[l] : 0), 0);
          // By type, editions grouped. A type outside the filter is a closed group
          // that says so (the client row draws its heading).
          const sections = LEVELS.flatMap((level): DocSection[] => {
            const items = groups.filter((g) => g[0].level === level);
            // Reviews are loaded `REVIEWS_SHOWN` at most; the row's count is the full number.
            const total = level === "review" ? r.review : items.length;
            if (total === 0) return [];
            return [
              {
                level,
                heading: `${LEVEL_LABEL[level]} · ${total.toLocaleString()}`,
                listed: listed.includes(level),
                entries: items.map((g) => ({
                  key: g[0].id,
                  body: level === "authority" ? bodyOf(g) : null,
                  node: <CitingDocEntry editions={g} />,
                })),
                note: level === "review" && r.review > items.length && (
                  <p className="text-muted-foreground border-apollo-border border-t py-3 text-[13px]">
                    The newest {items.length.toLocaleString()} of {r.review.toLocaleString()} systematic reviews.
                  </p>
                ),
              },
            ];
          });
          return (
            <PubRow
              key={r.pmid}
              chips={chips}
              count={count}
              sections={sections}
              head={
                <>
                  <div className="font-medium">
                    <PubTitle value={r.title} />
                  </div>
                  <div className="text-muted-foreground mt-0.5 leading-normal">
                    <PubMeta pub={r} copy />
                  </div>
                  <AuthorPills authors={r.authors} footer={footer} />
                </>
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function DocumentList({ docs }: { docs: DocRow[] }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]" data-testid="policy-citations-documents">
        <div className={cn(LIST_HEAD, DOC_COLS)}>
          <span>Citing document</span>
          <span>Body or journal</span>
          <span>Year</span>
          <span className="text-right">WCM papers</span>
        </div>
        {docs.map((d) => (
          <div
            key={d.key}
            className={cn(DOC_COLS, "border-apollo-border items-start border-b py-3")}
            data-testid="policy-citations-doc-row"
          >
            <div className="min-w-0">
              <ExternalLink href={d.url} className="font-medium">
                {d.title}
              </ExternalLink>
              <div className="text-muted-foreground text-[13px]">
                {[
                  LEVEL_ONE[d.level],
                  d.docs.length > 1 && `${d.docs.length} editions`,
                  d.bookshelf && "NCBI Bookshelf",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              <Disclosure
                show={`Show WCM papers cited (${d.pmids.length.toLocaleString()})`}
                hide="Hide WCM papers cited"
                className="bg-apollo-surface border-apollo-border-strong mt-1.5 rounded-full border px-2.5 py-1"
              >
                <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0 text-[13px]">
                  {d.papers.map((p) => (
                    <li key={p.pmid}>
                      <PubTitle value={p.title} />
                      <div className="text-muted-foreground">
                        <PubMeta pub={p} />
                      </div>
                    </li>
                  ))}
                  {d.pmids.length > d.papers.length && (
                    <li className="text-muted-foreground">
                      The first {DOC_PAPERS_SHOWN} of {d.pmids.length.toLocaleString()}.
                    </li>
                  )}
                </ul>
              </Disclosure>
            </div>
            <span className="min-w-0">
              {d.body ?? d.journal}
              {d.body && BODY_NAME[d.body] && (
                <span className="text-muted-foreground block text-xs leading-[1.4]">{BODY_NAME[d.body]}</span>
              )}
            </span>
            <span className="tabular-nums">{yearRange(d.yearMin, d.yearMax)}</span>
            <span className="text-right tabular-nums">{d.pmids.length.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PeopleTable({
  people,
  countHref,
  footer,
  bibliometrics,
}: {
  people: PersonRow[];
  countHref: (cwid: string, level: Level) => string;
  footer: PersonFooter;
  /** A person's Bibliometrics link, null when the viewer may not open it. */
  bibliometrics: (cwid: string) => string | null;
}) {
  const headers: Record<Level, string> = {
    authority: "Cited by health authorities",
    guideline: "Cited in guidelines",
    consensus: "Cited in consensus statements",
    review: "Cited in reviews",
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-sm tabular-nums" data-testid="policy-citations-people">
        <thead>
          <tr className="bg-apollo-surface-2 text-left">
            <th className={TH}>Person</th>
            <th className={TH}>Org unit</th>
            <th className={TH}>Person type</th>
            <th className={TH}>Primary institution</th>
            {LEVELS.map((l) => (
              <th key={l} className={cn(TH, "text-right whitespace-normal")}>
                {headers[l]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((r) => (
            <tr key={r.cwid} className="border-apollo-border border-b" data-testid="policy-citations-person-row">
              <PersonCell cwid={r.cwid} name={r.name} footer={footer} bibliometrics={bibliometrics(r.cwid)} />
              <td className={TD}>{r.orgUnit}</td>
              <td className={TD}>{r.personType}</td>
              <td className={TD}>{r.institution}</td>
              {LEVELS.map((l) => (
                <td key={l} className={cn(TD, "text-right")}>
                  {r[l] > 0 ? (
                    <Link href={countHref(r.cwid, l)} className={LINK}>
                      {r[l].toLocaleString()}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground/70">
                      <span aria-hidden>–</span>
                      <span className="sr-only">0</span>
                    </span>
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

/** "a health authority, clinical guideline or consensus statement". */
function levelPhrase(levels: readonly Level[]): string {
  const names = levels.map((l) => LEVEL_ONE[l].toLowerCase());
  return `a ${names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]}`;
}

export async function renderPolicyCitationsReport({
  session,
  searchParams,
  basePath,
}: AdminReportProps): Promise<ReportRender> {
  const params = await resolvePolicyCitationParams(
    parsePolicyCitationParams(toSearchParams(searchParams)),
    session,
  );
  // The page gate already refused a viewer with no unit; this is the backstop.
  if (params.scope !== null && params.scope.length === 0) notFound();
  const { view } = params;
  const offset = (params.page - 1) * POLICY_PAGE_SIZE;
  const [facets, data, documents, patents] = await Promise.all([
    loadDataQualityFacets(db.read),
    loadPolicyCitations(params, view === "publications" ? POLICY_PAGE_SIZE : 0, offset),
    loadPolicyDocuments(params),
    // Report 25, for the link beside "All reports": only while its flag is on.
    isPatentCitationsReportEnabled() ? reportMetaFor("25") : null,
  ]);
  const people = data.people.slice(offset, offset + POLICY_PAGE_SIZE);
  const [docs, names, mayOpenBibliometrics] = await Promise.all([
    // Citing documents for this page's rows only; `loadCitingDocuments` tests the scope again.
    loadCitingDocuments(
      params,
      data.pubs.map((r) => r.pmid),
    ),
    loadPersonNames(params, data.facetPeople),
    // One decision for everyone named on this page, not one per pill or row.
    loadBibliometricsAccess(
      view === "publications"
        ? [...new Set(data.pubs.flatMap((r) => r.authors.map((a) => a.cwid)))]
        : view === "people"
          ? people.map((r) => r.cwid)
          : [],
    ),
  ]);
  const listed: readonly Level[] = params.levels.length > 0 ? params.levels : LEVELS;
  const labels = unitLabels(facets);
  const chips = policyCitationChips(params, labels, names);
  const href = (q: string) => `${basePath}?${q}`;
  const qs = (over: Partial<PolicyCitationParams> = {}) => href(policyCitationQueryString(params, over));
  const bibliometrics = (cwid: string) => (mayOpenBibliometrics.has(cwid) ? bibliometricsHref(cwid) : null);
  // The card's button adds the person to whoever is already ticked (papers by
  // any of them) and lands on By publication; a search typed on another tab is dropped.
  const personFooter: PersonFooter = (cwid) =>
    personCardFooter(
      qs({
        view: "publications",
        q: view === "publications" ? params.q : "",
        people: [...new Set([...params.people, cwid])],
      }),
      bibliometrics(cwid),
    );
  const resetHref = isPolicyCitationDefault(params) ? null : view === "publications" ? basePath : href(`view=${view}`);
  const rail = (
    <Rail
      basePath={basePath}
      params={params}
      facets={facets}
      labels={labels}
      people={data.facetPeople}
      names={names}
      levelPapers={data.levelPapers}
      bodyPapers={documents.bodyPapers}
      resetHref={resetHref}
    />
  );
  const tab = (v: PolicyCitationParams["view"], label: string) => (
    <ReportTab href={qs({ view: v, q: "" })} current={view === v} testId={`policy-citations-view-${v}`}>
      {label}
    </ReportTab>
  );
  /** The tab's GET form: everything in the URL except what the form itself sets. */
  const toolbar = (own: Partial<PolicyCitationParams>, children: ReactNode) => (
    <Toolbar basePath={basePath} query={policyCitationQueryString(params, own)} testId="policy-citations-toolbar">
      {children}
    </Toolbar>
  );
  const pager = (total: number) => (
    <Pager
      page={params.page}
      total={total}
      pageSize={POLICY_PAGE_SIZE}
      href={(page) => qs({ page })}
      testId="policy-citations-pager"
    />
  );
  const overCap = data.pubTotal > POLICY_LIST_CAP;
  const published = yearSpan(params.from, params.to, fiscalLabel(params));

  return {
    // The who-filters both reports share ride along; report 25 keeps its own defaults for the rest.
    related: patents && (
      <RelatedReport
        name={patents.name}
        href={`/edit/reports/${patents.slug}?${patentCitationQueryString(
          parsePatentCitationParams(new URLSearchParams()),
          { types: params.types, units: params.units, people: params.people, positions: params.positions },
        )}`}
        testId="policy-citations-related"
      />
    ),
    subtitle: (
      <p className="text-muted-foreground text-sm" data-testid="policy-citations-subtitle">
        <strong className="text-foreground font-semibold">
          {plural(data.pubTotal, "paper", "papers")}
        </strong>{" "}
        cited by {levelPhrase(listed)} · {published ? `published ${published}` : "published in any year"} ·{" "}
        {params.scope === null ? "all units" : params.scope.map((u) => labels.get(u) ?? u).join("; ")}
        {!listed.includes("review") && (
          <span className="text-muted-foreground/80">
            {" "}
            · {data.withReviews.toLocaleString()} when systematic reviews are included
          </span>
        )}
      </p>
    ),
    aside: (
      <>
        <Button asChild variant="apollo" size="sm">
          <a
            href={`/api/edit/reports/policy-citations?${policyCitationQueryString(params, { q: "" })}`}
            data-testid="policy-citations-download"
          >
            <Download className="size-4" aria-hidden />
            Export spreadsheet
          </a>
        </Button>
        <span className="text-muted-foreground text-xs" data-testid="policy-citations-download-note">
          Publications, People, Citations and Criteria sheets
          {overCap &&
            ` · Publications lists the first ${POLICY_LIST_CAP.toLocaleString()} of ${data.pubTotal.toLocaleString()}`}
        </span>
      </>
    ),
    main: (
      <ReportLayout rail={rail}>
        <div className="flex min-w-0 flex-col gap-4 text-sm">
          <div className="lg:hidden">
            <FiltersSheet
              activeCount={chips.filter((c) => c.removeQuery !== null).length}
              testId="policy-citations-filters-sheet-trigger"
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
            testId="policy-citations-chips"
          />
          <ReportCard className="overflow-hidden p-0 sm:p-0">
            <nav
              className="border-apollo-border flex flex-wrap gap-x-5 gap-y-1 border-b px-4"
              aria-label="Report views"
            >
              {tab("publications", `By publication (${data.pubTotal.toLocaleString()})`)}
              {tab("documents", `By citing document (${documents.docTotal.toLocaleString()})`)}
              {tab("people", `By person (${data.people.length.toLocaleString()})`)}
            </nav>
            {view === "publications" ? (
              <>
                {toolbar(
                  { q: "", sort: "ranked" },
                  <>
                    <SearchField label="Search title, PMID or author" placeholder="e.g. 12345678" value={params.q} />
                    <SortSelect<PolicySort> name="sort" value={params.sort} options={SORT_LABEL} />
                  </>,
                )}
                <PublicationList pubs={data.pubs} docs={docs} listed={listed} footer={personFooter} />
                {data.pubMatched === 0 && (
                  <p className="text-muted-foreground px-4 pt-3 text-[13px]">
                    {params.q
                      ? "No publications match the search."
                      : "No publications match. Try another type or widen the years."}
                  </p>
                )}
                {pager(data.pubMatched)}
              </>
            ) : view === "documents" ? (
              <>
                {toolbar(
                  { docSort: "recent" },
                  <>
                    <span className="text-muted-foreground flex-[1_1_220px] text-[13px]">
                      One row per guideline or policy document. Editions of the same document are grouped.
                      Systematic reviews are not listed here.
                    </span>
                    <SortSelect<DocSort> name="dsort" value={params.docSort} options={DOC_SORT_LABEL} />
                  </>,
                )}
                <DocumentList docs={documents.docs} />
                {documents.docTotal === 0 && (
                  <p className="text-muted-foreground px-4 pt-3 text-[13px]">
                    No citing documents match. Tick health authority, clinical guideline or consensus
                    statement, or widen the years.
                  </p>
                )}
                {pager(documents.docTotal)}
              </>
            ) : (
              <>
                {toolbar(
                  { q: "" },
                  <SearchField label="Search name or CWID" placeholder="e.g. a name" value={params.q} />,
                )}
                <PeopleTable
                  people={people}
                  countHref={(cwid, level) =>
                    qs({ view: "publications", sort: "ranked", q: "", people: [cwid], levels: [level] })
                  }
                  footer={personFooter}
                  bibliometrics={bibliometrics}
                />
                {data.people.length === 0 && (
                  <p className="text-muted-foreground px-4 pt-3 text-[13px]">
                    {params.q
                      ? "No people match the search."
                      : "No people match. Try another type or widen the years."}
                  </p>
                )}
                {pager(data.people.length)}
              </>
            )}
          </ReportCard>
          <p className="text-muted-foreground max-w-[760px] text-[13px]" role="note">
            Only ReCiter-confirmed authorships of active scholars count. A citing document counts once
            per paper, however many journals printed it. Type chooses which publications, citing
            documents and people are listed; the counts beside each type and issuing body cover every
            type. By person counts are papers,
            and each links to the By publication view filtered to that person; the spreadsheet lists
            everyone. Showing at most {REVIEWS_SHOWN} systematic reviews per paper. Sources: PubMed, NIH
            iCite and NCBI Bookshelf.
          </p>
        </div>
      </ReportLayout>
    ),
  };
}
