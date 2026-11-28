/**
 * What the two citation reports' bodies share (24, "Guideline and policy
 * citations"; 25, "Patent citations"): the filter rail with its "Papers"
 * group, a publication's reference line and author pills, the tab link, a
 * tab's search and sort form, and the pager. Server-safe: no hooks, no
 * `@/lib/db`. Each takes the report's `testId` prefix, so a report's test ids
 * stay its own.
 */
import type { ReactNode } from "react";
import Link from "next/link";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
export { AuthorPills } from "@/components/edit/reports/author-pills";
import { CopyPmid } from "@/components/edit/reports/policy-citations-client";
import { RailChecklist, type RailChecklistOption } from "@/components/edit/reports/rail-checklist";
import { RailSection, ReportRail } from "@/components/edit/reports/report-ui";
import { ScholarHoverCard, type ScholarCardFooter } from "@/components/edit/scholar-hover-card";
import { PubJournal } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import { citationIdentifier } from "@/lib/citation";
import { BASIS_LABEL, type YearBasis } from "@/lib/edit/article-count-report";
import {
  fiscalLabel,
  POSITION_LABEL,
  UNKNOWN_PERSON,
  yearSpan,
  type Position,
  type WhoParams,
} from "@/lib/edit/policy-citations-report";
import type { AdminReportProps } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

export const SELECT =
  "border-apollo-border-strong bg-apollo-surface h-[34px] min-w-0 rounded-md border px-2 text-sm";
export const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
export const RADIO_INPUT = "accent-apollo-maroon size-4";
export const LIST_HEAD =
  "bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground border-y px-4 py-2 text-xs tracking-[0.05em] uppercase";
const TOOL_LABEL = "text-muted-foreground flex flex-col gap-0.5 text-xs";
const TOOL_INPUT =
  "border-apollo-border-strong bg-apollo-surface text-foreground min-h-9 rounded-lg border px-2.5 py-1.5 text-sm";
export const TH =
  "text-muted-foreground px-3 py-2.5 text-xs font-semibold tracking-[0.08em] whitespace-nowrap uppercase";
export const TD = "px-3 py-[11px] align-top";
export const LINK = "text-apollo-slate hover:underline";

export function toSearchParams(sp: AdminReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

/** A section's current value: "Any", up to two labels, else "N selected". */
export function summarize(labels: string[], all = "Any"): string {
  if (labels.length === 0) return all;
  return labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`;
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A year `<select>`, "Any" first, from next year (the fiscal basis runs a
 *  year ahead: FY2027 starts July 2026) back sixty. */
export function YearSelect({
  name,
  value,
  label = String,
  aria,
}: {
  name: string;
  value: number | null;
  label?: (y: number) => string;
  aria: string;
}) {
  const next = new Date().getFullYear() + 1;
  return (
    <select name={name} defaultValue={value ?? ""} aria-label={aria} className={SELECT}>
      <option value="">Any</option>
      {Array.from({ length: 60 }, (_, i) => next - i).map((y) => (
        <option key={y} value={y}>
          {label(y)}
        </option>
      ))}
    </select>
  );
}

/** "From … to …": two `YearSelect`s on one line. */
export function YearRange({
  from,
  to,
  label,
  what,
}: {
  from: { name: string; value: number | null };
  to: { name: string; value: number | null };
  label?: (y: number) => string;
  /** "publication year": the selects' accessible names. */
  what: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
      <YearSelect {...from} label={label} aria={`From ${what}`} />
      <span className="text-muted-foreground text-[13px]">to</span>
      <YearSelect {...to} label={label} aria={`To ${what}`} />
    </div>
  );
}

function RailGroup({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <div className="border-apollo-rail-border border-t">
      <div className="px-[18px] pt-3.5 pb-2.5">
        <div className="text-muted-foreground text-xs font-semibold tracking-[0.05em] uppercase">{title}</div>
        <p className="text-muted-foreground mt-0.5 text-xs">{help}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * The filter rail: the viewer's units (when narrowed), then one GET
 * `AutoSubmitForm` holding the report's own group (`citing`) and the "Papers"
 * group both reports share: publication year, org unit, person type, person,
 * author position, institution and centers.
 */
export function CitationRail({
  basePath,
  testId,
  params,
  facets,
  labels,
  resetHref,
  hidden,
  citing,
  personOptions,
  personNote,
  counts = true,
  personSearch = true,
}: {
  basePath: string;
  /** The report's test-id prefix ("policy-citations"). */
  testId: string;
  params: WhoParams;
  facets: DataQualityFacets;
  labels: ReadonlyMap<string, string>;
  resetHref: string | null;
  /** The view state the form carries along, as hidden inputs. */
  hidden: ReactNode;
  /** The report's own group, above "Papers". */
  citing: { title: string; help: string; children: ReactNode };
  /** The Person facet's options; a ticked person must be among them. */
  personOptions: RailChecklistOption[];
  personNote: string;
  /** false: no numbers beside the options (report 27 shows a number only
   *  where it links to the list it counts). */
  counts?: boolean;
  /** false: the Person facet lists only the people already ticked, so it has
   *  no search box (there is nobody else to find), and with nobody ticked it
   *  is the note alone. */
  personSearch?: boolean;
}) {
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
  const published = yearSpan(params.from, params.to, fiscalLabel(params)) ?? "Any";
  /** The options as the checklists get them: with their counts, or without. */
  const shown = (options: readonly RailChecklistOption[]): RailChecklistOption[] =>
    counts ? [...options] : options.map(({ value, label, title }) => ({ value, label, title }));
  const peopleLabel = counts ? "People" : undefined;
  return (
    <ReportRail
      resetHref={resetHref}
      help={
        counts
          ? "Filters apply automatically. Numbers next to units and person types count active people."
          : "Filters apply automatically."
      }
      testId={`${testId}-rail`}
    >
      {scope !== null && (
        <div className="border-apollo-rail-border border-t px-[18px] py-3" data-testid={`${testId}-scope`}>
          <span className="text-muted-foreground block text-xs font-semibold tracking-[0.08em] uppercase">
            Unit
          </span>
          <span className="mt-0.5 block text-sm">
            {params.scope!.map((u) => labels.get(u) ?? u).join("; ")}
          </span>
        </div>
      )}
      <AutoSubmitForm action={basePath} className="group" data-testid={`${testId}-filters`}>
        {hidden}
        <RailGroup title={citing.title} help={citing.help}>
          {citing.children}
        </RailGroup>
        <RailGroup title="Papers" help="Which authorships, and so which papers, are in scope.">
          <RailSection
            label="Publication year"
            summary={`${published} · ${params.basis === "fy" ? "Fiscal (July–June)" : "Calendar"}`}
            testId={`${testId}-years`}
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
            <YearRange
              from={{ name: "from", value: params.from }}
              to={{ name: "to", value: params.to }}
              label={fiscalLabel(params)}
              what="publication year"
            />
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
              testId={`${testId}-org-unit`}
            >
              <RailChecklist
                name="unit"
                roomy
                options={shown(unitOptions)}
                selected={params.units}
                searchPlaceholder="Search org units…"
                collapseAfter={8}
                countLabel={peopleLabel}
              />
            </RailSection>
          )}
          <RailSection
            label="Person type"
            summary={summarize(
              params.types.map((t) => facets.roleCategories.find((o) => o.value === t)?.label ?? t),
            )}
            testId={`${testId}-person-type`}
          >
            <RailChecklist
              name="type"
              roomy
              options={shown(typeOptions)}
              selected={params.types}
              countLabel={peopleLabel}
            />
          </RailSection>
          <RailSection
            label="Person"
            summary={summarize(personOptions.filter((o) => params.people.includes(o.value)).map((o) => o.label))}
            testId={`${testId}-person`}
          >
            {(personSearch || personOptions.length > 0) && (
              <RailChecklist
                name="person"
                roomy
                options={shown(personOptions)}
                selected={params.people}
                searchPlaceholder={personSearch ? "Find a person" : undefined}
                collapseAfter={5}
                countLabel={counts ? "Papers" : undefined}
              />
            )}
            <span className="text-muted-foreground text-xs">{personNote}</span>
          </RailSection>
          <RailSection
            label="Author position"
            summary={summarize(params.positions.map((k) => POSITION_LABEL[k]))}
            testId={`${testId}-position`}
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
              testId={`${testId}-institution`}
            >
              {institutionOptions.length > 0 && (
                <RailChecklist
                  name="unit"
                  roomy
                  options={shown(institutionOptions)}
                  selected={params.units}
                  countLabel={peopleLabel}
                />
              )}
              {centerOptions.length > 0 && (
                <RailChecklist
                  name="unit"
                  roomy
                  options={shown(centerOptions)}
                  selected={params.units}
                  searchPlaceholder="Search centers…"
                  collapseAfter={6}
                  countLabel={peopleLabel}
                />
              )}
            </RailSection>
          )}
        </RailGroup>
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

/** The Person facet's options: the first `top` people, and anyone ticked.
 *  `names` (`loadPersonNames`) names a ticked person with nothing to count. */
export function personFacetOptions<R extends { cwid: string; name: string }>(
  people: readonly R[],
  ticked: readonly string[],
  top: readonly R[],
  count: (r: R) => number,
  names: ReadonlyMap<string, string> = new Map(),
): RailChecklistOption[] {
  return [
    ...top.map((r) => ({ value: r.cwid, label: r.name, count: count(r) })),
    ...ticked
      .filter((c) => !top.some((r) => r.cwid === c))
      .map((c) => {
        const row = people.find((r) => r.cwid === c);
        return { value: c, label: row?.name ?? names.get(c) ?? UNKNOWN_PERSON, count: row ? count(row) : 0 };
      }),
  ];
}

/** An off-site link; anything that is not https renders as plain text. */
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (!href.startsWith("https://")) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(LINK, className)}>
      {children}
    </a>
  );
}

/** "Journal · 2021 · PMID 123", the identifier linked; `copy` adds the copy button. */
export function PubMeta({
  pub,
  copy = false,
}: {
  pub: { pmid: string; journal: string | null; year: number | null };
  copy?: boolean;
}) {
  const id = citationIdentifier(pub.pmid);
  return (
    <>
      {pub.journal && (
        <>
          <PubJournal value={pub.journal} /> ·{" "}
        </>
      )}
      {pub.year !== null && <>{pub.year} · </>}
      {id.href ? (
        <a href={id.href} target="_blank" rel="noopener noreferrer" className={LINK}>
          {id.label} {id.value}
        </a>
      ) : (
        `${id.label} ${id.value}`
      )}
      {copy && <CopyPmid pmid={id.value} />}
    </>
  );
}

/** A person's hover-card footer on reports 24 and 25, given per CWID. */
export type PersonFooter = (cwid: string) => ScholarCardFooter;

const CARD_LINK = "text-apollo-maroon hover:underline";
const BIBLIOMETRICS_LINK = "Full bibliometrics report";

/**
 * The footer: a button that narrows the report to this person's papers
 * (`onlyHref`: the By publication tab with the person added to the `person`
 * filter), and the link to their Bibliometrics report when the viewer may
 * open it (`bibliometrics`: `bibliometricsHref`, or null to leave it out).
 * The name itself still only opens the card.
 */
export function personCardFooter(onlyHref: string, bibliometrics: string | null): ScholarCardFooter {
  return {
    action: (
      <Button asChild variant="apollo" size="sm" className="w-full">
        <Link href={onlyHref}>Show only this person&rsquo;s papers</Link>
      </Button>
    ),
    link: bibliometrics && (
      <Link href={bibliometrics} prefetch={false} className={CARD_LINK}>
        {BIBLIOMETRICS_LINK}
      </Link>
    ),
  };
}

/** The By person tables' first cell: the name with its hover card, the CWID
 *  under it, then the link to the person's Bibliometrics report when the
 *  viewer may open it (`bibliometrics`). */
export function PersonCell({
  cwid,
  name,
  footer,
  bibliometrics = null,
}: {
  cwid: string;
  name: string;
  footer?: PersonFooter;
  bibliometrics?: string | null;
}) {
  return (
    <td className={cn(TD, "min-w-[200px]")}>
      <ScholarHoverCard cwid={cwid} footer={footer?.(cwid)}>
        <span className="leading-[1.35] font-semibold">{name}</span>
      </ScholarHoverCard>
      <div className="text-muted-foreground mt-0.5 font-mono text-xs">{cwid}</div>
      {bibliometrics && (
        <Link href={bibliometrics} prefetch={false} className={cn(LINK, "mt-0.5 block text-xs")}>
          {BIBLIOMETRICS_LINK}
        </Link>
      )}
    </td>
  );
}

/** "· Related: Patent citations", beside the page's "All reports" link
 *  (`ReportRender.related`): the sister report, under the same who-filters. */
export function RelatedReport({ name, href, testId }: { name: string; href: string; testId: string }) {
  return (
    <span className="text-muted-foreground" data-testid={testId}>
      <span aria-hidden>· </span>Related:{" "}
      <Link href={href} className={LINK}>
        {name}
      </Link>
    </span>
  );
}

/** One tab of the results card: a link, since the tab is in the URL. */
export function ReportTab({
  href,
  current,
  testId,
  children,
}: {
  href: string;
  current: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      data-testid={testId}
      className={cn(
        "-mb-px border-b-2 px-0.5 pt-3.5 pb-3 font-medium whitespace-nowrap",
        current
          ? "border-apollo-maroon text-foreground"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {children}
    </Link>
  );
}

/** A tab's GET form. `query` is everything in the URL except what the form
 *  itself sets, carried as hidden inputs. */
export function Toolbar({
  basePath,
  query,
  testId,
  children,
}: {
  basePath: string;
  query: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <AutoSubmitForm action={basePath} className="group flex flex-wrap items-end gap-2.5 px-4 py-3" data-testid={testId}>
      {[...new URLSearchParams(query)].map(([k, v], i) => (
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
}

export function SearchField({ label, placeholder, value }: { label: string; placeholder: string; value: string }) {
  return (
    <label className={cn(TOOL_LABEL, "flex-[1_1_220px]")}>
      {label}
      <input type="search" name="q" defaultValue={value} placeholder={placeholder} className={TOOL_INPUT} />
    </label>
  );
}

export function SortSelect<K extends string>({
  name,
  value,
  options,
}: {
  name: string;
  value: K;
  options: Record<K, string>;
}) {
  return (
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
}

/** "1–50 of 5,080", Previous, Next. */
export function Pager({
  page,
  total,
  pageSize,
  href,
  testId,
}: {
  page: number;
  total: number;
  pageSize: number;
  href: (page: number) => string;
  testId: string;
}) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  const from = Math.min(total, (page - 1) * pageSize + 1);
  const to = Math.min(total, page * pageSize);
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
    <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3" data-testid={testId}>
      <span className="text-muted-foreground text-[13px] tabular-nums">
        {total === 0 ? "0" : `${from.toLocaleString()}–${to.toLocaleString()}`} of {total.toLocaleString()}
      </span>
      {/* Nothing to step to when everything fits on one page. */}
      {(last > 1 || page > 1) && (
        <div className="flex gap-2">
          {step("Previous", Math.min(page - 1, last), page > 1)}
          {step("Next", page + 1, page < last)}
        </div>
      )}
    </div>
  );
}
