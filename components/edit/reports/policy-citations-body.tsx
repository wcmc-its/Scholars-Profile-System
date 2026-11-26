/**
 * Report 24 — "Guideline and policy citations" body (mockup: the report 24
 * redesign, 2026-11-25). The shared pieces (`report-ui.tsx`, and
 * `citation-report-parts.tsx` with report 25): a filter rail in a plain GET
 * `AutoSubmitForm`, the active filters as chips, the results card. Above the card, a tile per level (each a link that toggles the level)
 * and two summary cards; in it, the By publication / By citing document / By
 * person tabs, each with its own search or sort form and pages of
 * `POLICY_PAGE_SIZE`. The export button rides the report header (`aside`).
 *
 * Filters, search, sort, tab and page are the URL. The only client state is
 * which rows are open, the chart's level and "copied"
 * (`policy-citations-client.tsx`); what an open row shows is rendered here,
 * for the rows on the page only.
 *
 * Parser, access scope, loaders, chips and the workbook live in
 * `lib/edit/policy-citations-report.ts`; the download route
 * (`/api/edit/reports/policy-citations`) takes the same query string.
 */
import { Fragment, type ReactNode } from "react";
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
import {
  Disclosure,
  LevelChart,
  LevelIcon,
  PubRow,
  type CitedByChip,
} from "@/components/edit/reports/policy-citations-client";
import { RailChecklist } from "@/components/edit/reports/rail-checklist";
import { FilterChips, RailSection, ReportCard, ReportLayout } from "@/components/edit/reports/report-ui";
import { PubTitle } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import { loadDataQualityFacets, type DataQualityFacets } from "@/lib/api/data-quality";
import { db } from "@/lib/db";
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
  type CitingDoc,
  type DocRow,
  type DocSort,
  type Level,
  type PersonRow,
  type PolicyCitationParams,
  type PolicySort,
  type PolicySummary,
  type PubRow as PubRowData,
} from "@/lib/edit/policy-citations-report";
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
  resetHref: string | null;
};

function Rail({ basePath, params, facets, labels, people, resetHref }: RailProps) {
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
              <legend className="mb-1.5 p-0 text-[13px] font-medium">Level</legend>
              <RailChecklist
                name="level"
                roomy
                options={LEVELS.map((l) => ({ value: l, label: LEVEL_ONE[l] }))}
                selected={params.levels}
              />
              <p className="text-muted-foreground mt-1 text-xs">
                Lists the papers, documents and people cited at these levels. None checked = all.
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
            <RailSection label="Issuing body" summary={summarize(params.bodies)} testId="policy-citations-body">
              <RailChecklist
                name="body"
                roomy
                options={BODIES.map((b) => ({ value: b, label: b }))}
                selected={params.bodies}
              />
            </RailSection>
            <RailSection
              label="Citing document year"
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
      personOptions={personFacetOptions(people, params.people, top, (r) => r.authority)}
      personNote={`The ${FACET_PEOPLE} people with the most papers cited by health authorities. Anyone else: open them from the By person tab.`}
    />
  );
}

function SummaryCards({
  summary,
  bodyHref,
  thisYear,
}: {
  summary: PolicySummary;
  bodyHref: (body: string) => string;
  thisYear: number;
}) {
  return (
    <section className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-3">
      <div className={CARD} data-testid="policy-citations-bodies">
        <h2 className={cn(CARD_TITLE, "mb-2.5")}>By issuing body</h2>
        {summary.bodies.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">No health authority documents match.</p>
        ) : (
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th className="pb-1.5 font-normal">Body</th>
                <th className="w-20 pb-1.5 text-right font-normal">Documents</th>
                <th className="w-[60px] pb-1.5 text-right font-normal">Papers</th>
              </tr>
            </thead>
            <tbody>
              {summary.bodies.map((b) => (
                <tr key={b.body} className="align-top">
                  <td className="py-[5px] pr-3">
                    <Link href={bodyHref(b.body)} className={LINK}>
                      {b.body}
                    </Link>
                    {BODY_NAME[b.body] && (
                      <div className="text-muted-foreground text-xs leading-[1.4]">{BODY_NAME[b.body]}</div>
                    )}
                  </td>
                  <td className="py-[5px] text-right">{b.documents.toLocaleString()}</td>
                  <td className="py-[5px] text-right">{b.papers.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className={CARD} data-testid="policy-citations-years-chart">
        <LevelChart series={summary.years} thisYear={thisYear} />
      </div>
    </section>
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

/** A publication's citing documents by level, editions grouped. `groups` is
 *  shared with the row's chips and count. A level outside the filter is a
 *  closed group that says so. */
function PubDocs({
  row,
  groups,
  listed,
}: {
  row: PubRowData;
  groups: CitingDoc[][];
  listed: readonly Level[];
}) {
  return LEVELS.map((level) => {
    const items = groups.filter((g) => g[0].level === level);
    // Reviews are loaded `REVIEWS_SHOWN` at most; the row's count is the full number.
    const total = level === "review" ? row.review : items.length;
    if (total === 0) return null;
    const entries = (
      <>
        {items.map((g) => (
          <CitingDocEntry key={g[0].id} editions={g} />
        ))}
        {level === "review" && row.review > items.length && (
          <p className="text-muted-foreground border-apollo-border border-t py-3 text-[13px]">
            The newest {items.length.toLocaleString()} of {row.review.toLocaleString()} systematic reviews.
          </p>
        )}
      </>
    );
    if (listed.includes(level)) return <Fragment key={level}>{entries}</Fragment>;
    return (
      <div key={level} className="border-apollo-border-strong mt-2 border-t pt-4 pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-foreground text-xs font-semibold tracking-[0.05em] uppercase">
            <LevelIcon level={level} />
            {LEVEL_LABEL[level]} · {total.toLocaleString()}
          </span>
          <span className="text-muted-foreground text-[13px]">Not in the current level filter</span>
          <Disclosure show="Show" className="py-1">
            <div className="basis-full">{entries}</div>
          </Disclosure>
        </div>
      </div>
    );
  });
}

function PublicationList({
  pubs,
  docs,
  listed,
}: {
  pubs: PubRowData[];
  /** The citing documents of the rows on this page, per PMID. */
  docs: ReadonlyMap<string, CitingDoc[]>;
  listed: readonly Level[];
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
          const byBody = new Map<string, number>();
          for (const g of authority) {
            const body = g[0].issuingBody ?? "Health authority";
            byBody.set(body, (byBody.get(body) ?? 0) + 1);
          }
          const shown = (l: Level) => listed.includes(l) && r[l] > 0;
          const chips: CitedByChip[] = [
            ...(listed.includes("authority")
              ? [...byBody].map(([body, n]) => ({
                  level: "authority" as const,
                  label: `${body} · ${n}`,
                  title: BODY_NAME[body],
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
          return (
            <PubRow
              key={r.pmid}
              chips={chips}
              count={count}
              head={
                <>
                  <div className="font-medium">
                    <PubTitle value={r.title} />
                  </div>
                  <div className="text-muted-foreground mt-0.5 leading-normal">
                    <PubMeta pub={r} copy />
                  </div>
                  <AuthorPills authors={r.authors} />
                </>
              }
            >
              <PubDocs row={r} groups={groups} listed={listed} />
            </PubRow>
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
}: {
  people: PersonRow[];
  countHref: (cwid: string, level: Level) => string;
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
              <PersonCell cwid={r.cwid} name={r.name} />
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
  const [facets, data, documents] = await Promise.all([
    loadDataQualityFacets(db.read),
    loadPolicyCitations(params, view === "publications" ? POLICY_PAGE_SIZE : 0, offset),
    loadPolicyDocuments(params),
  ]);
  // Citing documents for this page's rows only; `loadCitingDocuments` tests the scope again.
  const docs = await loadCitingDocuments(
    params,
    data.pubs.map((r) => r.pmid),
  );
  const listed: readonly Level[] = params.levels.length > 0 ? params.levels : LEVELS;
  const labels = unitLabels(facets);
  const chips = policyCitationChips(params, labels, new Map(data.facetPeople.map((r) => [r.cwid, r.name])));
  const href = (q: string) => `${basePath}?${q}`;
  const qs = (over: Partial<PolicyCitationParams> = {}) => href(policyCitationQueryString(params, over));
  const resetHref = isPolicyCitationDefault(params) ? null : view === "publications" ? basePath : href(`view=${view}`);
  const rail = (
    <Rail
      basePath={basePath}
      params={params}
      facets={facets}
      labels={labels}
      people={data.facetPeople}
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
  const people = data.people.slice(offset, offset + POLICY_PAGE_SIZE);
  const overCap = data.pubTotal > POLICY_LIST_CAP;
  const published = yearSpan(params.from, params.to, fiscalLabel(params));
  // Unticking the only level leaves none ticked, which lists every level.
  const toggled = (l: Level) =>
    listed.includes(l) ? listed.filter((x) => x !== l) : LEVELS.filter((x) => x === l || listed.includes(x));

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm" data-testid="policy-citations-subtitle">
        <strong className="text-foreground font-semibold">
          {plural(data.pubTotal, "paper", "papers")}
        </strong>{" "}
        cited by {levelPhrase(listed)} · {published ? `published ${published}` : "published in any year"} ·{" "}
        {params.scope === null ? "all units" : params.scope.map((u) => labels.get(u) ?? u).join("; ")}
        {listed.length < LEVELS.length && (
          <span className="text-muted-foreground/80">
            {" "}
            · {data.cited.toLocaleString()} at any level
            {!listed.includes("review") && ", including systematic reviews"}
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
          <section
            aria-label="Papers cited, by level"
            className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3"
            data-testid="policy-citations-tiles"
          >
            {LEVELS.map((l) => {
              const on = listed.includes(l);
              return (
                <Link
                  key={l}
                  href={qs({ levels: toggled(l) })}
                  title={`${on ? "Remove" : "Add"} ${LEVEL_LABEL[l].toLowerCase()} ${on ? "from" : "to"} the level filter`}
                  data-testid={`policy-citations-tile-${l}`}
                  className={cn(
                    "text-foreground hover:border-apollo-slate rounded-[var(--apollo-radius-card)] border px-4 py-3.5",
                    on
                      ? "bg-apollo-surface border-apollo-border"
                      : "bg-apollo-surface-2 border-apollo-border-strong border-dashed",
                  )}
                >
                  <span className="text-muted-foreground block text-xs">
                    <LevelIcon level={l} />
                    {LEVEL_ONE[l]}
                    {!on && " · not in filter"}
                  </span>
                  <span
                    className={cn(
                      "block text-[28px] leading-[1.2] font-semibold tabular-nums",
                      !on && "text-muted-foreground",
                    )}
                  >
                    {data.tiles[l].toLocaleString()}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    papers{!on && " · click to include"}
                  </span>
                </Link>
              );
            })}
          </section>
          <FilterChips
            chips={chips.map((c) => ({
              group: c.group,
              value: c.value,
              removeHref: c.removeQuery === null ? null : href(c.removeQuery),
            }))}
            testId="policy-citations-chips"
          />
          <SummaryCards
            summary={documents.summary}
            bodyHref={(b) => qs({ bodies: [b] })}
            thisYear={new Date().getFullYear()}
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
                <PublicationList pubs={data.pubs} docs={docs} listed={listed} />
                {data.pubMatched === 0 && (
                  <p className="text-muted-foreground px-4 pt-3 text-[13px]">
                    {params.q
                      ? "No publications match the search."
                      : "No publications match. Try another level or widen the years."}
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
                />
                {data.people.length === 0 && (
                  <p className="text-muted-foreground px-4 pt-3 text-[13px]">
                    {params.q
                      ? "No people match the search."
                      : "No people match. Try another level or widen the years."}
                  </p>
                )}
                {pager(data.people.length)}
              </>
            )}
          </ReportCard>
          <p className="text-muted-foreground max-w-[760px] text-[13px]" role="note">
            Only ReCiter-confirmed authorships of active scholars count. A citing document counts once
            per paper, however many journals printed it. Level chooses which publications, citing
            documents and people are listed; the tiles cover every level. By person counts are papers,
            and each links to the By publication view filtered to that person; the spreadsheet lists
            everyone. Showing at most {REVIEWS_SHOWN} systematic reviews per paper. Sources: PubMed, NIH
            iCite and NCBI Bookshelf.
          </p>
        </div>
      </ReportLayout>
    ),
  };
}
