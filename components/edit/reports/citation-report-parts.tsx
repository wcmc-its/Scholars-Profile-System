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
import { CopyPmid } from "@/components/edit/reports/policy-citations-client";
import { RailChecklist, type RailChecklistOption } from "@/components/edit/reports/rail-checklist";
import { RailSection, ReportRail } from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { PubJournal } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import { citationIdentifier } from "@/lib/citation";
import { BASIS_LABEL, type YearBasis } from "@/lib/edit/article-count-report";
import { fiscalLabel, POSITION_LABEL, yearSpan, type Position, type WhoParams } from "@/lib/edit/policy-citations-report";
import type { AdminReportProps } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

export const SELECT =
  "border-apollo-border-strong bg-apollo-surface h-[34px] min-w-0 rounded-md border px-2 text-sm";
export const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
export const RADIO_INPUT = "accent-apollo-maroon size-4";
export const CARD =
  "bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border p-4";
export const CARD_TITLE = "m-0 text-sm font-semibold";
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

const initials = (name: string) => {
  const words = name.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
};

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
  return (
    <ReportRail
      resetHref={resetHref}
      help="Filters apply automatically. Numbers next to units and person types count active people."
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
            testId={`${testId}-person-type`}
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
            testId={`${testId}-person`}
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

/** The Person facet's options: the first `top` people, and anyone ticked. */
export function personFacetOptions<R extends { cwid: string; name: string }>(
  people: readonly R[],
  ticked: readonly string[],
  top: readonly R[],
  count: (r: R) => number,
): RailChecklistOption[] {
  return [
    ...top.map((r) => ({ value: r.cwid, label: r.name, count: count(r) })),
    ...ticked
      .filter((c) => !top.some((r) => r.cwid === c))
      .map((c) => {
        const row = people.find((r) => r.cwid === c);
        return { value: c, label: row?.name ?? c, count: row ? count(row) : 0 };
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

/** A publication's WCM authors as pills, each with its hover card. */
export function AuthorPills({ authors }: { authors: readonly { cwid: string; name: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {authors.map((a) => (
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
  );
}

/** The By person tables' first cell: the name with its hover card, the CWID under it. */
export function PersonCell({ cwid, name }: { cwid: string; name: string }) {
  return (
    <td className={cn(TD, "min-w-[200px]")}>
      <ScholarHoverCard cwid={cwid}>
        <span className="leading-[1.35] font-semibold">{name}</span>
      </ScholarHoverCard>
      <div className="text-muted-foreground mt-0.5 font-mono text-xs">{cwid}</div>
    </td>
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
      <div className="flex gap-2">
        {step("Previous", Math.min(page - 1, last), page > 1)}
        {step("Next", page + 1, page < last)}
      </div>
    </div>
  );
}
