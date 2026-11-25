/**
 * Report 24 — "Guideline and policy citations" body (mockup: the policy
 * citation canvas, boards "Report: guideline and policy citations" and
 * "Report: by person view"). Report 9's shape on the shared pieces
 * (`report-ui.tsx`): a filter rail in a plain GET `AutoSubmitForm`, the tiles
 * with the spreadsheet button, the active filters as chips, three summary
 * cards, then the By person / By publication tabs. All server-rendered: the
 * tabs, the sort and a row's expansion (`pub=<pmid>`) are links and a GET
 * form, so the page needs no client half of its own.
 *
 * Parser, access scope, loaders, chips and the workbook live in
 * `lib/edit/policy-citations-report.ts`; the download route
 * (`/api/edit/reports/policy-citations`) takes the same query string.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import { RailChecklist, type RailChecklistOption } from "@/components/edit/reports/rail-checklist";
import {
  FilterChips,
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
  ReportStats,
} from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import { loadDataQualityFacets, type DataQualityFacets } from "@/lib/api/data-quality";
import { citationIdentifier } from "@/lib/citation";
import { db } from "@/lib/db";
import { BASIS_LABEL, formatLongDate, type YearBasis } from "@/lib/edit/article-count-report";
import { unitLabels } from "@/lib/edit/person-filter";
import {
  BODIES,
  bodyLabel,
  fiscalLabel,
  isPolicyCitationDefault,
  LEVEL_LABEL,
  LEVELS,
  loadCitingDocuments,
  loadPolicyCitations,
  loadPolicySummary,
  parsePolicyCitationParams,
  POLICY_LIST_CAP,
  policyCitationChips,
  policyCitationQueryString,
  POSITION_LABEL,
  resolvePolicyCitationParams,
  SORT_LABEL,
  yearSpan,
  type CitingDoc,
  type Level,
  type PersonRow,
  type PolicyCitationParams,
  type PolicySort,
  type PolicySummary,
  type Position,
  type PubRow,
} from "@/lib/edit/policy-citations-report";
import type { AdminReportProps, ReportRender } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

// ponytail: each table shows its first 100 rows, no paging; the spreadsheet
// carries the rest. Add paging if anyone asks to read further on the page.
const PAGE_ROWS = 100;
/** The Person facet offers this many people (by authority-cited papers). */
const FACET_PEOPLE = 50;
/** The guideline chart's span, ending this year. */
const CHART_YEARS = 11;

const SELECT =
  "border-apollo-border-strong bg-apollo-surface h-[34px] min-w-0 rounded-md border px-2 text-sm";
const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
const RADIO_INPUT = "accent-apollo-maroon size-4";
const CARD = "border-apollo-border flex min-w-0 flex-col gap-2.5 rounded-[var(--apollo-radius-card)] border p-[18px]";
const CARD_TITLE = "text-sm font-semibold";
const TH =
  "text-muted-foreground px-3 py-2.5 text-xs font-semibold tracking-[0.08em] whitespace-nowrap uppercase";
const TD = "px-3 py-[11px] align-top";
const LINK = "text-apollo-slate hover:underline";

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
        <RailSection
          label="Publication year"
          summary={`${published} · ${params.basis === "fy" ? "Fiscal (July–June)" : "Calendar"}`}
          defaultOpen
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
        {institutionOptions.length > 0 && (
          <RailSection
            label="Primary institution"
            summary={summarize(unitsOf(["inst:"]))}
            testId="policy-citations-institution"
          >
            <RailChecklist
              name="unit"
              roomy
              options={institutionOptions}
              selected={params.units}
              countLabel="People"
            />
          </RailSection>
        )}
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
        {centerOptions.length > 0 && (
          <RailSection
            label="Centers"
            summary={summarize(unitsOf(["center:"]))}
            testId="policy-citations-centers"
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
        <RailSection
          label="Level"
          summary={summarize(params.levels.map((l) => LEVEL_LABEL[l]), "All levels")}
          testId="policy-citations-level"
        >
          <RailChecklist
            name="level"
            roomy
            options={LEVELS.map((l) => ({ value: l, label: LEVEL_LABEL[l] }))}
            selected={params.levels}
          />
          <span className="text-muted-foreground text-xs">
            Lists the publications and people cited at these levels. None checked = all.
          </span>
        </RailSection>
        <RailSection
          label="Issuing body"
          summary={summarize(params.bodies)}
          testId="policy-citations-body"
        >
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
  now,
}: {
  summary: PolicySummary;
  bodyHref: (body: string) => string;
  now: Date;
}) {
  const thisYear = now.getFullYear();
  const byYear = new Map(summary.guidelineYears.map((r) => [r.year, r.count]));
  const chart = Array.from({ length: CHART_YEARS }, (_, i) => {
    const year = thisYear - CHART_YEARS + 1 + i;
    return { year, count: byYear.get(year) ?? 0 };
  });
  const max = Math.max(1, ...chart.map((c) => c.count));
  const { newly } = summary;
  const day = (d: Date) => formatLongDate(d.toISOString().slice(0, 10));
  // Honest about the window: the first import's backfill never counts as new.
  const since =
    newly.sinceFirstImport && newly.firstImport
      ? `the first import on ${day(newly.firstImport)}`
      : day(newly.since);
  return (
    <>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <div className={CARD} data-testid="policy-citations-bodies">
          <div className={CARD_TITLE}>By issuing body</div>
          {summary.bodies.length === 0 ? (
            <p className="text-muted-foreground text-[13px]">No health authority documents match.</p>
          ) : (
            <table className="w-full border-collapse text-[13px] tabular-nums">
              <thead>
                <tr className="text-muted-foreground text-left">
                  <th className="pb-1.5 font-normal">Body</th>
                  <th className="w-[90px] pb-1.5 text-right font-normal">Documents</th>
                  <th className="w-[70px] pb-1.5 text-right font-normal">Papers</th>
                </tr>
              </thead>
              <tbody>
                {summary.bodies.map((b) => (
                  <tr key={b.body}>
                    <td className="py-1">
                      <Link href={bodyHref(b.body)} className={LINK}>
                        {bodyLabel(b.body)}
                      </Link>
                    </td>
                    <td className="py-1 text-right">{b.documents.toLocaleString()}</td>
                    <td className="py-1 text-right">{b.papers.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className={CARD} data-testid="policy-citations-guideline-years">
          <div className={CARD_TITLE}>Citing clinical guidelines by year published</div>
          <div
            role="img"
            aria-label={`Bar chart of citing guidelines per year: ${chart.map((c) => `${c.count} in ${c.year}`).join(", ")}`}
            className="flex h-[132px] items-end gap-2"
          >
            {chart.map((c) => (
              <div
                key={c.year}
                className="text-muted-foreground flex flex-1 flex-col items-center gap-[3px] text-[11px]"
              >
                <span>{c.count.toLocaleString()}</span>
                <div
                  className={cn(
                    "w-full rounded-t-[3px]",
                    c.year === thisYear ? "bg-apollo-slate/50" : "bg-apollo-slate",
                  )}
                  style={{ height: `${Math.round((c.count / max) * 100)}px` }}
                />
              </div>
            ))}
          </div>
          <div className="text-muted-foreground flex gap-2 text-[11px]" aria-hidden>
            {chart.map((c) => (
              <span key={c.year} className="flex-1 text-center">
                {c.year}
              </span>
            ))}
          </div>
          <div className="text-muted-foreground text-xs">{thisYear} is the year to date.</div>
        </div>
      </div>
      <div className={cn(CARD, "mt-3")} data-testid="policy-citations-newly">
        <div className={CARD_TITLE}>Newly cited</div>
        {newly.firstImport === null ? (
          <p className="text-muted-foreground text-[13px]">No citing documents have been recorded yet.</p>
        ) : newly.documents === 0 ? (
          <p className="text-muted-foreground text-[13px]">None since {since}.</p>
        ) : (
          <>
            <p className="text-muted-foreground text-[13px]">
              {newly.documents.toLocaleString()} citing {newly.documents === 1 ? "document" : "documents"}{" "}
              first recorded since {since}.
            </p>
            <div className="flex flex-col gap-2 text-[13px] leading-[1.45]">
              {newly.items.map((d) => {
                const pub = citationIdentifier(d.pmid);
                return (
                  <div key={`${d.url}:${d.pmid}`}>
                    {d.year !== null && <span className="text-muted-foreground">{d.year} · </span>}
                    <ExternalLink href={d.url}>{d.title}</ExternalLink>
                    <span className="text-muted-foreground">
                      {d.journal ? ` · ${d.journal}` : ""} · cites{" "}
                      {pub.href ? (
                        <a href={pub.href} target="_blank" rel="noopener noreferrer" className={LINK}>
                          <PubTitle value={d.pubTitle} />
                        </a>
                      ) : (
                        <PubTitle value={d.pubTitle} />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** An off-site link; anything that is not https renders as plain text. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!href.startsWith("https://")) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
      {children}
    </a>
  );
}

/** One citing document as a full reference. PubMed: authors, journal,
 *  year;volume(issue):pages, PMID, DOI. Bookshelf: the publication statement,
 *  the NBK id, and the chapters and sections that cite the paper. */
function CitingDocItem({ doc }: { doc: CitingDoc }) {
  return (
    <li className="border-apollo-border flex flex-col gap-0.5 border-b py-2.5 last:border-b-0">
      <div>
        <span className="bg-apollo-surface-2 border-apollo-border-strong text-foreground/80 mr-2 rounded border px-1.5 py-px text-xs whitespace-nowrap">
          {doc.level === "authority" && doc.issuingBody ? doc.issuingBody : LEVEL_LABEL[doc.level]}
        </span>
        <ExternalLink href={doc.url}>{doc.title}</ExternalLink>
      </div>
      <div className="text-muted-foreground text-[13px]">
        {doc.authors && <>{doc.authors}. </>}
        {doc.journal && (
          <>
            <em className="text-foreground/80">{doc.journal}</em>.{" "}
          </>
        )}
        {doc.publisher ? <>{doc.publisher} </> : doc.cite && <>{doc.cite}. </>}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {doc.pmid && (
          <a
            href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(doc.pmid)}/`}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(LINK, "whitespace-nowrap")}
          >
            PMID {doc.pmid}
          </a>
        )}
        {doc.bookshelfId && <ExternalLink href={doc.url}>NCBI Bookshelf {doc.bookshelfId}</ExternalLink>}
        {doc.doi && (
          <a
            href={`https://doi.org/${encodeURI(doc.doi)}`}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(LINK, "break-all")}
          >
            DOI {doc.doi}
          </a>
        )}
      </div>
      {doc.locations.length > 0 && (
        <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span>Cited in:</span>
          {doc.locations.map((l) => (
            <ExternalLink key={l.url} href={l.url}>
              {l.label}
            </ExternalLink>
          ))}
        </div>
      )}
    </li>
  );
}

function PublicationsTable({
  pubs,
  open,
  docs,
  rowHref,
}: {
  pubs: PubRow[];
  /** The expanded row's PMID, and its documents. */
  open: string | null;
  docs: CitingDoc[];
  rowHref: (pmid: string | null) => string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm tabular-nums" data-testid="policy-citations-publications">
        <thead>
          <tr className="bg-apollo-surface-2 text-left">
            <th className={TH}>Publication</th>
            <th className={TH}>Year</th>
            <th className={cn(TH, "w-[250px]")}>Health authorities</th>
            <th className={cn(TH, "text-right")}>Guidelines</th>
            <th className={cn(TH, "text-right")}>Consensus</th>
            <th className={cn(TH, "text-right")}>Reviews</th>
          </tr>
        </thead>
        <tbody>
          {pubs.map((r) => {
            const isOpen = open === r.pmid;
            const id = citationIdentifier(r.pmid);
            return [
              <tr
                key={r.pmid}
                id={`pub-${r.pmid}`}
                className={cn("border-apollo-border border-b", isOpen && "bg-apollo-page")}
                data-testid="policy-citations-pub-row"
              >
                <td className={cn(TD, "min-w-[280px]")}>
                  <Link
                    href={`${rowHref(isOpen ? null : r.pmid)}#pub-${r.pmid}`}
                    aria-expanded={isOpen}
                    title={isOpen ? "Hide the citing documents" : "Show the citing documents"}
                    className="hover:text-apollo-maroon leading-[1.4] font-semibold"
                  >
                    <PubTitle value={r.title} />
                  </Link>
                  <div className="text-muted-foreground text-[13px]">
                    {r.journal && <PubJournal value={r.journal} />}
                    {r.journal && " · "}
                    {id.href ? (
                      <a href={id.href} target="_blank" rel="noopener noreferrer" className={LINK}>
                        {id.label} {id.value}
                      </a>
                    ) : (
                      `${id.label} ${id.value}`
                    )}
                  </div>
                  <div className="text-[13px]">
                    {r.authors.map((a, i) => (
                      <span key={a.cwid}>
                        {i > 0 && ", "}
                        <ScholarHoverCard cwid={a.cwid}>
                          <span className="text-apollo-slate hover:underline">{a.name}</span>
                        </ScholarHoverCard>
                      </span>
                    ))}
                  </div>
                </td>
                <td className={TD}>{r.year ?? ""}</td>
                <td className={TD}>
                  <div className="flex flex-wrap gap-[5px]">
                    {r.bodies.map((b) => (
                      <span
                        key={b.body}
                        className="bg-apollo-slate rounded-full px-[9px] py-px text-xs font-medium whitespace-nowrap text-white"
                      >
                        {b.count > 1 ? `${b.body} · ${b.count}` : b.body}
                      </span>
                    ))}
                  </div>
                </td>
                <td className={cn(TD, "text-right")}>{r.guideline.toLocaleString()}</td>
                <td className={cn(TD, "text-right")}>{r.consensus.toLocaleString()}</td>
                <td className={cn(TD, "text-right")}>{r.review.toLocaleString()}</td>
              </tr>,
              isOpen && (
                <tr key={`${r.pmid}-docs`} className="bg-apollo-page border-apollo-border border-b">
                  <td colSpan={6} className="pt-0 pr-6 pb-1 pl-10">
                    <ol className="m-0 list-none p-0 text-sm" data-testid="policy-citations-docs">
                      {docs.map((d) => (
                        <CitingDocItem key={d.id} doc={d} />
                      ))}
                    </ol>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
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
                    <span className="text-muted-foreground">0</span>
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
  const now = new Date();
  const [facets, data, summary] = await Promise.all([
    loadDataQualityFacets(db.read),
    loadPolicyCitations(params, PAGE_ROWS),
    loadPolicySummary(params, now),
  ]);
  // Only a listed row expands, so `pub` can never reach outside the viewer's units.
  const open = params.pub !== null && data.pubs.some((r) => r.pmid === params.pub) ? params.pub : null;
  const docs = open ? await loadCitingDocuments(params, open) : [];
  const labels = unitLabels(facets);
  const chips = policyCitationChips(params, labels, new Map(data.facetPeople.map((r) => [r.cwid, r.name])));
  const href = (q: string) => `${basePath}?${q}`;
  const qs = (over: Partial<PolicyCitationParams> = {}) => href(policyCitationQueryString(params, over));
  const resetHref = isPolicyCitationDefault(params)
    ? null
    : params.view === "people"
      ? href("view=people")
      : basePath;
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
      href={qs({ view: v })}
      aria-current={params.view === v ? "page" : undefined}
      data-testid={`policy-citations-view-${v}`}
      className={cn(
        "-mb-px border-b-2 py-2.5 text-base whitespace-nowrap",
        params.view === v
          ? "border-apollo-maroon text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {label}
    </Link>
  );
  const people = data.people.slice(0, PAGE_ROWS);
  const overCap = data.pubTotal > POLICY_LIST_CAP;

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        {params.scope === null ? "All units" : params.scope.map((u) => labels.get(u) ?? u).join("; ")} ·{" "}
        {data.cited.toLocaleString()} cited {data.cited === 1 ? "publication" : "publications"}
      </p>
    ),
    main: (
      <ReportLayout rail={rail}>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="lg:hidden">
            <FiltersSheet
              activeCount={chips.filter((c) => c.removeQuery !== null).length}
              testId="policy-citations-filters-sheet-trigger"
            >
              {rail}
            </FiltersSheet>
          </div>
          <ReportCard>
            <ReportStats
              stats={[
                {
                  value: data.tiles.authority.toLocaleString(),
                  label: "papers cited by a health authority or national academy",
                },
                {
                  value: data.tiles.guideline.toLocaleString(),
                  label: "papers cited in a clinical practice guideline",
                },
                { value: data.tiles.either.toLocaleString(), label: "papers with either" },
                { value: data.tiles.review.toLocaleString(), label: "papers cited in a systematic review" },
              ]}
              aside={
                <div className="flex flex-col items-start gap-2">
                  <Button asChild variant="apollo">
                    <a
                      href={`/api/edit/reports/policy-citations?${policyCitationQueryString(params)}`}
                      data-testid="policy-citations-download"
                    >
                      <Download className="size-4" aria-hidden />
                      Export spreadsheet
                    </a>
                  </Button>
                  <p
                    className={cn("text-[13px]", overCap ? "text-apollo-amber" : "text-muted-foreground")}
                    data-testid="policy-citations-download-note"
                  >
                    {overCap
                      ? `Includes the Publications, People and Criteria sheets. The Publications sheet lists the first ${POLICY_LIST_CAP.toLocaleString()} of ${data.pubTotal.toLocaleString()} in the chosen order; narrow the filters to list the rest.`
                      : "Includes the Publications, People and Criteria sheets."}
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
                testId="policy-citations-chips"
              />
            </div>
            <SummaryCards summary={summary} bodyHref={(b) => qs({ bodies: [b] })} now={now} />
            <div className="border-apollo-border mt-6 border-b">
              <nav className="flex flex-wrap gap-x-7" aria-label="Report view">
                {tab("people", `By person (${data.people.length.toLocaleString()})`)}
                {tab("publications", `By publication (${data.pubTotal.toLocaleString()})`)}
              </nav>
            </div>
            {params.view === "publications" ? (
              <>
                <AutoSubmitForm
                  action={basePath}
                  className="group my-3.5 flex flex-wrap items-center gap-2 text-[13px]"
                  data-testid="policy-citations-sort"
                >
                  {[...new URLSearchParams(policyCitationQueryString(params))]
                    .filter(([k]) => k !== "sort")
                    .map(([k, v], i) => (
                      <input key={i} type="hidden" name={k} value={v} />
                    ))}
                  <label htmlFor="policy-citations-sort-select" className="text-muted-foreground">
                    Sort by
                  </label>
                  <select
                    id="policy-citations-sort-select"
                    name="sort"
                    defaultValue={params.sort}
                    className="border-apollo-border-strong bg-apollo-surface text-foreground h-8 rounded-md border px-2 text-[13px]"
                  >
                    {(Object.keys(SORT_LABEL) as PolicySort[]).map((k) => (
                      <option key={k} value={k}>
                        {SORT_LABEL[k]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-2 py-1 group-data-[hydrated=true]:hidden"
                  >
                    Apply
                  </button>
                  {params.sort === "ranked" && (
                    <span className="text-muted-foreground">
                      Health authorities, then clinical guidelines, then consensus statements, then
                      systematic reviews.
                    </span>
                  )}
                </AutoSubmitForm>
                <PublicationsTable
                  pubs={data.pubs}
                  open={open}
                  docs={docs}
                  rowHref={(pmid) => qs({ pub: pmid })}
                />
                <p className="text-muted-foreground mt-3.5 text-xs">
                  {data.pubTotal === 0
                    ? "No publications match. Try another level or widen the years."
                    : `Showing ${data.pubs.length.toLocaleString()} of ${data.pubTotal.toLocaleString()}. Select a title to see the citing documents.`}{" "}
                  Sources: PubMed, NIH iCite and NCBI Bookshelf.
                </p>
              </>
            ) : (
              <>
                <PeopleTable
                  people={people}
                  countHref={(cwid, level) =>
                    qs({ view: "publications", sort: "ranked", people: [cwid], levels: [level] })
                  }
                />
                <p className="text-muted-foreground mt-3.5 max-w-[680px] text-xs">
                  {data.people.length === 0
                    ? "No people match. Try another level or widen the years."
                    : `Showing ${people.length.toLocaleString()} of ${data.people.length.toLocaleString()}; the spreadsheet lists everyone.`}{" "}
                  One row per person. Counts are papers, and each links to the By publication view
                  filtered to that person. Sorted by papers cited by health authorities.
                </p>
              </>
            )}
            <p className="text-muted-foreground mt-6 max-w-[680px] text-[13px]" role="note">
              Only ReCiter-confirmed authorships of active scholars count. A citing document counts
              once per paper, however many journals printed it. Level chooses which publications and
              people are listed; the numbers cover every level.
            </p>
          </ReportCard>
        </div>
      </ReportLayout>
    ),
  };
}
