/**
 * Report 24 — "Guideline and policy citations" body (mockup: the report 24
 * redesign, 2026-11-25). The shared pieces (`report-ui.tsx`): a filter rail
 * in a plain GET `AutoSubmitForm`, the active filters as chips, the results
 * card. Above the card, a tile per level (each a link that toggles the level)
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

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import {
  CopyPmid,
  Disclosure,
  LevelChart,
  LevelIcon,
  PubRow,
  type CitedByChip,
} from "@/components/edit/reports/policy-citations-client";
import { RailChecklist, type RailChecklistOption } from "@/components/edit/reports/rail-checklist";
import { FilterChips, RailSection, ReportCard, ReportLayout, ReportRail } from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import { loadDataQualityFacets, type DataQualityFacets } from "@/lib/api/data-quality";
import { citationIdentifier } from "@/lib/citation";
import { db } from "@/lib/db";
import { BASIS_LABEL, type YearBasis } from "@/lib/edit/article-count-report";
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
  POSITION_LABEL,
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
  type Position,
  type PubRow as PubRowData,
} from "@/lib/edit/policy-citations-report";
import type { AdminReportProps, ReportRender } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

/** The Person facet offers this many people (by authority-cited papers). */
const FACET_PEOPLE = 50;

const SELECT =
  "border-apollo-border-strong bg-apollo-surface h-[34px] min-w-0 rounded-md border px-2 text-sm";
const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
const RADIO_INPUT = "accent-apollo-maroon size-4";
const CARD =
  "bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border p-4";
const CARD_TITLE = "m-0 text-sm font-semibold";
const EYEBROW = "text-muted-foreground text-xs tracking-[0.05em] uppercase";
const LIST_HEAD =
  "bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground border-y px-4 py-2 text-xs tracking-[0.05em] uppercase";
const TOOL_LABEL = "text-muted-foreground flex flex-col gap-0.5 text-xs";
const TOOL_INPUT =
  "border-apollo-border-strong bg-apollo-surface text-foreground min-h-9 rounded-lg border px-2.5 py-1.5 text-sm";
const TH =
  "text-muted-foreground px-3 py-2.5 text-xs font-semibold tracking-[0.08em] whitespace-nowrap uppercase";
const TD = "px-3 py-[11px] align-top";
const LINK = "text-apollo-slate hover:underline";
const DOC_COLS = "grid grid-cols-[minmax(0,1fr)_150px_110px_100px] gap-3 px-4";

function toSearchParams(sp: AdminReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

/** A section's current value: "Any", up to two labels, else "N selected". */
function summarize(labels: string[], all = "Any"): string {
  if (labels.length === 0) return all;
  return labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`;
}

type RailProps = {
  basePath: string;
  params: PolicyCitationParams;
  facets: DataQualityFacets;
  labels: ReadonlyMap<string, string>;
  people: PersonRow[];
  resetHref: string | null;
};

function Rail({ basePath, params, facets, labels, people, resetHref }: RailProps) {
  const thisYear = new Date().getFullYear();
  // The fiscal basis runs a year ahead (FY2027 starts July 2026).
  const years = Array.from({ length: 60 }, (_, i) => thisYear + 1 - i);
  // A viewer narrowed to their units is offered only those (a department's
  // divisions ride along): anything else could only return nothing.
  const scope = params.scope === null ? null : new Set(params.scope);
  const allowed = (v: string) => scope === null || scope.has(v);
  const departments = facets.departments.filter((d) => allowed(d.value));
  const divisions = facets.departments
    .flatMap((d) => d.divisions.filter((v) => allowed(d.value) || allowed(v.value)))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const centers = facets.centers.filter((c) => allowed(c.value));
  const institutions = facets.institutions.filter((i) => allowed(i.value));
  // A selected unit no option carries (renamed, retired, hand-typed, outside
  // the viewer's units) still lists in its group, ticked, so it can be unticked.
  const known = new Set([...departments, ...divisions, ...centers, ...institutions].map((o) => o.value));
  const groupOf = (u: string) =>
    u.startsWith("center:") ? "center" : u.startsWith("inst:") ? "inst" : "dept";
  const unknownUnits = (group: string): RailChecklistOption[] =>
    [...new Set(params.units)]
      .filter((u) => !known.has(u) && groupOf(u) === group)
      .map((u) => ({ value: u, label: labels.get(u) ?? u, count: 0 }));
  const unitOptions: RailChecklistOption[] = [
    ...departments.map(({ value, label, count }) => ({ value, label, count })),
    ...divisions,
    ...unknownUnits("dept"),
  ];
  // A memberless center can only return zero — hidden unless already selected.
  const centerOptions = [
    ...centers.filter((c) => c.count > 0 || params.units.includes(c.value)),
    ...unknownUnits("center"),
  ];
  const institutionOptions = [...institutions, ...unknownUnits("inst")];
  const unitsOf = (prefixes: string[]) =>
    params.units
      .filter((u) => prefixes.some((p) => u.startsWith(p)))
      .map((u) => labels.get(u) ?? u);
  // A selected person type no active scholar holds still lists, so it can be unticked.
  const typeOptions: RailChecklistOption[] = [
    ...facets.roleCategories,
    ...params.types
      .filter((t) => !facets.roleCategories.some((o) => o.value === t))
      .map((t) => ({ value: t, label: t, count: 0 })),
  ];
  // Top people by authority-cited papers; a ticked person always lists.
  const top = people.filter((r) => r.authority > 0).slice(0, FACET_PEOPLE);
  const personOptions: RailChecklistOption[] = [
    ...top.map((r) => ({ value: r.cwid, label: r.name, count: r.authority })),
    ...params.people
      .filter((c) => !top.some((r) => r.cwid === c))
      .map((c) => {
        const row = people.find((r) => r.cwid === c);
        return { value: c, label: row?.name ?? c, count: row?.authority ?? 0 };
      }),
  ];
  const yearSelect = (k: "from" | "to" | "cfrom" | "cto", label: (y: number) => string, aria: string) => (
    <select name={k} defaultValue={params[k] ?? ""} aria-label={aria} className={SELECT}>
      <option value="">Any</option>
      {years.map((y) => (
        <option key={y} value={y}>
          {label(y)}
        </option>
      ))}
    </select>
  );
  const published = yearSpan(params.from, params.to, fiscalLabel(params)) ?? "Any";
  const group = (title: string, help: string, children: ReactNode) => (
    <div className="border-apollo-rail-border border-t">
      <div className="px-[18px] pt-3.5 pb-2.5">
        <div className="text-muted-foreground text-xs font-semibold tracking-[0.05em] uppercase">{title}</div>
        <p className="text-muted-foreground mt-0.5 text-xs">{help}</p>
      </div>
      {children}
    </div>
  );
  return (
    <ReportRail
      resetHref={resetHref}
      help="Filters apply automatically. Numbers next to units and person types count active people."
      testId="policy-citations-rail"
    >
      {scope !== null && (
        <div className="border-apollo-rail-border border-t px-[18px] py-3" data-testid="policy-citations-scope">
          <span className="text-muted-foreground block text-xs font-semibold tracking-[0.08em] uppercase">
            Unit
          </span>
          <span className="mt-0.5 block text-sm">
            {params.scope!.map((u) => labels.get(u) ?? u).join("; ")}
          </span>
        </div>
      )}
      <AutoSubmitForm action={basePath} className="group" data-testid="policy-citations-filters">
        <input type="hidden" name="view" value={params.view} />
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="dsort" value={params.docSort} />
        {params.q && <input type="hidden" name="q" value={params.q} />}
        {group(
          "Citing documents",
          "Which citations are counted, in every number.",
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
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                {yearSelect("cfrom", String, "From citing document year")}
                <span className="text-muted-foreground text-[13px]">to</span>
                {yearSelect("cto", String, "To citing document year")}
              </div>
            </RailSection>
          </>,
        )}
        {group(
          "Papers",
          "Which authorships, and so which papers, are in scope.",
          <>
            <RailSection
              label="Publication year"
              summary={`${published} · ${params.basis === "fy" ? "Fiscal (July–June)" : "Calendar"}`}
              testId="policy-citations-years"
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
                {yearSelect("from", fiscalLabel(params), "From publication year")}
                <span className="text-muted-foreground text-[13px]">to</span>
                {yearSelect("to", fiscalLabel(params), "To publication year")}
              </div>
              {params.basis === "fy" && (
                <p className="text-muted-foreground text-xs">
                  Fiscal years run July–June and are named by the year they end, by the date the article
                  was added to PubMed.
                </p>
              )}
            </RailSection>
            {unitOptions.length > 0 && (
              <RailSection
                label="Org unit"
                summary={summarize(unitsOf(["dept:", "div:"]), "All org units")}
                testId="policy-citations-org-unit"
              >
                <RailChecklist
                  name="unit"
                  roomy
                  options={unitOptions}
                  selected={params.units}
                  searchPlaceholder="Search org units…"
                  collapseAfter={8}
                  countLabel="People"
                />
              </RailSection>
            )}
            <RailSection
              label="Person type"
              summary={summarize(
                params.types.map((t) => facets.roleCategories.find((o) => o.value === t)?.label ?? t),
              )}
              testId="policy-citations-person-type"
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
              label="Person"
              summary={summarize(personOptions.filter((o) => params.people.includes(o.value)).map((o) => o.label))}
              testId="policy-citations-person"
            >
              <RailChecklist
                name="person"
                roomy
                options={personOptions}
                selected={params.people}
                searchPlaceholder="Find a person"
                collapseAfter={5}
                countLabel="Papers"
              />
              <span className="text-muted-foreground text-xs">
                The {FACET_PEOPLE} people with the most papers cited by health authorities. Anyone else:
                open them from the By person tab.
              </span>
            </RailSection>
            <RailSection
              label="Author position"
              summary={summarize(params.positions.map((k) => POSITION_LABEL[k]))}
              testId="policy-citations-position"
            >
              <RailChecklist
                name="pos"
                roomy
                options={(Object.keys(POSITION_LABEL) as Position[]).map((k) => ({
                  value: k,
                  label: POSITION_LABEL[k],
                }))}
                selected={params.positions}
              />
            </RailSection>
            {(institutionOptions.length > 0 || centerOptions.length > 0) && (
              <RailSection
                label="Institution and centers"
                summary={summarize(unitsOf(["inst:", "center:"]))}
                testId="policy-citations-institution"
              >
                {institutionOptions.length > 0 && (
                  <RailChecklist
                    name="unit"
                    roomy
                    options={institutionOptions}
                    selected={params.units}
                    countLabel="People"
                  />
                )}
                {centerOptions.length > 0 && (
                  <RailChecklist
                    name="unit"
                    roomy
                    options={centerOptions}
                    selected={params.units}
                    searchPlaceholder="Search centers…"
                    collapseAfter={6}
                    countLabel="People"
                  />
                )}
              </RailSection>
            )}
          </>,
        )}
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

/** An off-site link; anything that is not https renders as plain text. */
function ExternalLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (!href.startsWith("https://")) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(LINK, className)}>
      {children}
    </a>
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

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

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
          const id = citationIdentifier(r.pmid);
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
                    {r.journal && (
                      <>
                        <PubJournal value={r.journal} /> ·{" "}
                      </>
                    )}
                    {r.year !== null && <>{r.year} · </>}
                    {id.href ? (
                      <a href={id.href} target="_blank" rel="noopener noreferrer" className={LINK}>
                        {id.label} {id.value}
                      </a>
                    ) : (
                      `${id.label} ${id.value}`
                    )}
                    <CopyPmid pmid={id.value} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.authors.map((a) => (
                      <ScholarHoverCard key={a.cwid} cwid={a.cwid}>
                        <span className="border-border bg-background inline-flex items-center gap-2 rounded-full border py-[3px] pr-3 pl-1 text-[13px] leading-[1.3] font-semibold">
                          <span
                            aria-hidden
                            className="bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground inline-flex size-6 items-center justify-center rounded-full border text-[10px]"
                          >
                            {initials(a.name)}
                          </span>
                          {a.name}
                        </span>
                      </ScholarHoverCard>
                    ))}
                  </div>
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

const initials = (name: string) => {
  const words = name.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
};

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
                  {d.papers.map((p) => {
                    const id = citationIdentifier(p.pmid);
                    return (
                      <li key={p.pmid}>
                        <PubTitle value={p.title} />
                        <div className="text-muted-foreground">
                          {p.journal && (
                            <>
                              <PubJournal value={p.journal} /> ·{" "}
                            </>
                          )}
                          {p.year !== null && <>{p.year} · </>}
                          {id.href ? (
                            <a href={id.href} target="_blank" rel="noopener noreferrer" className={LINK}>
                              {id.label} {id.value}
                            </a>
                          ) : (
                            `${id.label} ${id.value}`
                          )}
                        </div>
                      </li>
                    );
                  })}
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
              <td className={cn(TD, "min-w-[200px]")}>
                <ScholarHoverCard cwid={r.cwid}>
                  <span className="leading-[1.35] font-semibold">{r.name}</span>
                </ScholarHoverCard>
                <div className="text-muted-foreground mt-0.5 font-mono text-xs">{r.cwid}</div>
              </td>
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

/** "1–50 of 5,080", Previous, Next. */
function Pager({ page, total, href }: { page: number; total: number; href: (page: number) => string }) {
  const last = Math.max(1, Math.ceil(total / POLICY_PAGE_SIZE));
  const from = Math.min(total, (page - 1) * POLICY_PAGE_SIZE + 1);
  const to = Math.min(total, page * POLICY_PAGE_SIZE);
  const step = (label: string, target: number, enabled: boolean) =>
    enabled ? (
      <Button asChild variant="outline" size="sm">
        <Link href={href(target)}>{label}</Link>
      </Button>
    ) : (
      <Button variant="outline" size="sm" disabled>
        {label}
      </Button>
    );
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3" data-testid="policy-citations-pager">
      <span className="text-muted-foreground text-[13px] tabular-nums">
        {total === 0 ? "0" : `${from.toLocaleString()}–${to.toLocaleString()}`} of {total.toLocaleString()}
      </span>
      <div className="flex gap-2">
        {step("Previous", Math.min(page - 1, last), page > 1)}
        {step("Next", page + 1, page < last)}
      </div>
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
    <Link
      href={qs({ view: v, q: "" })}
      aria-current={view === v ? "page" : undefined}
      data-testid={`policy-citations-view-${v}`}
      className={cn(
        "-mb-px border-b-2 px-0.5 pt-3.5 pb-3 font-medium whitespace-nowrap",
        view === v
          ? "border-apollo-maroon text-foreground"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {label}
    </Link>
  );
  /** The tab's GET form: everything in the URL except what the form itself sets. */
  const toolbar = (own: Partial<PolicyCitationParams>, children: ReactNode) => (
    <AutoSubmitForm
      action={basePath}
      className="group flex flex-wrap items-end gap-2.5 px-4 py-3"
      data-testid="policy-citations-toolbar"
    >
      {[...new URLSearchParams(policyCitationQueryString(params, own))].map(([k, v], i) => (
        <input key={i} type="hidden" name={k} value={v} />
      ))}
      {children}
      <button
        type="submit"
        className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-2 py-1 text-[13px] group-data-[hydrated=true]:hidden"
      >
        Apply
      </button>
    </AutoSubmitForm>
  );
  const search = (label: string, placeholder: string) => (
    <label className={cn(TOOL_LABEL, "flex-[1_1_220px]")}>
      {label}
      <input type="search" name="q" defaultValue={params.q} placeholder={placeholder} className={TOOL_INPUT} />
    </label>
  );
  const sortSelect = <K extends string>(name: string, value: K, options: Record<K, string>) => (
    <label className={TOOL_LABEL}>
      Sort by
      <select name={name} defaultValue={value} className={TOOL_INPUT}>
        {(Object.keys(options) as K[]).map((k) => (
          <option key={k} value={k}>
            {options[k]}
          </option>
        ))}
      </select>
    </label>
  );
  const people = data.people.slice(offset, offset + POLICY_PAGE_SIZE);
  const overCap = data.pubTotal > POLICY_LIST_CAP;
  const published = yearSpan(params.from, params.to, fiscalLabel(params));
  const pageHref = (page: number) => qs({ page });
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
                    {search("Search title, PMID or author", "e.g. 12345678")}
                    {sortSelect<PolicySort>("sort", params.sort, SORT_LABEL)}
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
                <Pager page={params.page} total={data.pubMatched} href={pageHref} />
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
                    {sortSelect<DocSort>("dsort", params.docSort, DOC_SORT_LABEL)}
                  </>,
                )}
                <DocumentList docs={documents.docs} />
                {documents.docTotal === 0 && (
                  <p className="text-muted-foreground px-4 pt-3 text-[13px]">
                    No citing documents match. Tick health authority, clinical guideline or consensus
                    statement, or widen the years.
                  </p>
                )}
                <Pager page={params.page} total={documents.docTotal} href={pageHref} />
              </>
            ) : (
              <>
                {toolbar({ q: "" }, search("Search name or CWID", "e.g. a name"))}
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
                <Pager page={params.page} total={data.people.length} href={pageHref} />
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
