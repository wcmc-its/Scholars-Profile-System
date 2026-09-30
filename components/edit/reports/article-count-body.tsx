/**
 * Report 8 — "Article counts" body (reports redesign, 2026-09-24; mockup
 * `Pub Reports/Article Counts Redesign.dc.html`). A filter rail of collapsible
 * sections (`ReportRail` / `RailSection`, `report-ui.tsx`) inside ONE GET
 * `AutoSubmitForm`: Years (calendar / fiscal / date added to PubMed), Person
 * type, Department / division, Centers, Institution, CWID list, Article
 * type, Journal Impact Factor, Author position. Beside it the results card:
 * the distinct-article total with the `.xlsx` link and its note, the active
 * filters as removable chips, and two tabs — "By year" (a bar per year, the
 * in-progress year badged YTD; a year opens the Articles tab narrowed to it)
 * and "Articles (N)" (citation rows, sort, "Show 25 more"; above
 * `ARTICLE_LIST_CAP` a panel asks to narrow the filters and offers two common
 * combinations). Below `lg` the rail moves into the shared phone
 * `FiltersSheet`; the sheet copy's form carries its own id.
 *
 * Params, the unit default and the loaders live in
 * `lib/edit/article-count-report.ts` (the page and the download share
 * `parseArticleCountParams` + `resolveArticleCountParams`). `tab` and `year`
 * are view params: never filters, never in the download link. Every link the
 * body builds carries `f=1` (the submitted marker), so removing the last
 * filter never brings the unit default back; "Reset to defaults" is the bare
 * URL.
 */
import Link from "next/link";
import { Download, X } from "lucide-react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import { AddedDateField } from "@/components/edit/reports/added-date-field";
import { ArticleCitationList, type CitationRow } from "@/components/edit/reports/article-citation-list";
import { CwidListField, type AppliedCwidList } from "@/components/edit/reports/cwid-list-field";
import { JifField } from "@/components/edit/reports/jif-field";
import { ReportFacetList, type ReportFacetOption } from "@/components/edit/reports/report-facet-list";
import {
  FilterChips,
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
  ReportStats,
  type FilterChip,
} from "@/components/edit/reports/report-ui";
import { Button } from "@/components/ui/button";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import {
  ADDED_BASIS,
  ADDED_LABEL,
  ADDED_QUICK_PICKS,
  ARTICLE_COUNT_CAVEAT,
  ARTICLE_COUNT_PARSE,
  ARTICLE_COUNT_SUBMITTED,
  ARTICLE_LIST_CAP,
  articleCountActiveFilters,
  articleCountQueryString,
  articleCountWindowLabel,
  BASIS_LABEL,
  formatLongDate,
  isBareArticleCountQuery,
  JIF_MAX,
  loadArticleCountChoices,
  loadArticleCounts,
  loadArticleList,
  parseArticleCountParams,
  POSITION_LABEL,
  resolveArticleCountParams,
  shiftIsoDate,
  unitLabels,
  type ArticleCountParams,
  type ArticleCountRow,
  type ArticleRow,
} from "@/lib/edit/article-count-report";
import type { AdminReportProps, ReportRender } from "@/lib/edit/report-registry";
import { cn } from "@/lib/utils";

const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
const RADIO_BOX = "size-4 accent-[var(--color-primary-cornell-red)]";
const FIELD = "border-apollo-border-strong bg-apollo-surface h-[34px] w-full min-w-0 rounded-md border px-2 text-sm";

/** The raw person type the "Full-time faculty, last author" combination picks. */
const FULL_TIME_FACULTY = "full_time_faculty";

function toSearchParams(sp: AdminReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

type View = { tab: "year" | "articles"; year: number | null };

function parseView(sp: URLSearchParams): View {
  const year = Number.parseInt(sp.get("year") ?? "", 10);
  return { tab: sp.get("tab") === "articles" ? "articles" : "year", year: Number.isFinite(year) ? year : null };
}

/** Today (UTC) and the in-progress period on the report's basis. */
function currentPeriod(p: ArticleCountParams, today: string): number | null {
  if (p.added) return null;
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return p.basis === "fy" ? (m >= 7 ? y + 1 : y) : y;
}

const yearLabel = (p: ArticleCountParams, y: number) => (p.basis === "fy" && !p.added ? `FY${y}` : String(y));

/** "Any" / "A, B" / "3 selected" — a rail section's summary line. */
function summarize(labels: string[], none = "Any"): string {
  if (labels.length === 0) return none;
  return labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`;
}

/** Options plus any selected value the options don't carry (a default unit
 *  with no active people, a stale link), so a selection is always shown and
 *  can always be unticked. */
function withSelected(
  options: ReportFacetOption[],
  selected: string[],
  label: (v: string) => string,
): ReportFacetOption[] {
  const known = new Set(options.map((o) => o.value));
  const extra = selected.filter((v) => !known.has(v)).map((v) => ({ value: v, label: label(v), count: 0 }));
  return [...extra, ...options];
}

/** Which rail section a `unit` value belongs to. */
function unitSection(v: string): "dept" | "center" | "inst" {
  if (v.startsWith("center:")) return "center";
  if (v.startsWith("inst:")) return "inst";
  return "dept";
}

const UNIT_GROUP: Record<string, string> = {
  dept: "Department",
  div: "Division",
  center: "Center",
  inst: "Institution",
};

type Choices = { facets: DataQualityFacets; atypes: string[] };

type RailProps = {
  basePath: string;
  params: ArticleCountParams;
  choices: Choices;
  labels: ReadonlyMap<string, string>;
  applied: AppliedCwidList | null;
  resetHref: string | null;
  href: (p: ArticleCountParams) => string;
  today: string;
  /** Appended to the form id: the phone sheet's copy passes "-sheet". */
  idSuffix?: string;
};

function Rail({ basePath, params, choices, labels, applied, resetHref, href, today, idSuffix = "" }: RailProps) {
  const { facets } = choices;
  const labelOf = (v: string) => labels.get(v) ?? v;
  const roleLabel = new Map(facets.roleCategories.map((o) => [o.value, o.label]));
  const years = Array.from({ length: 30 }, (_, i) => new Date().getFullYear() + 1 - i);

  const units = { dept: [] as string[], center: [] as string[], inst: [] as string[] };
  for (const u of params.units) units[unitSection(u)].push(u);

  // Same flat list as Profiles: departments largest-first, THEN divisions
  // largest-first (a division's label already names its parent).
  const deptOptions: ReportFacetOption[] = [
    ...facets.departments.map(({ value, label, count }) => ({ value, label, count })),
    ...facets.departments
      .flatMap((d) => d.divisions)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  ];
  // A memberless center can only return zero — hidden unless selected.
  const centerOptions = facets.centers.filter((c) => c.count > 0 || units.center.includes(c.value));

  const mode = params.added ? ADDED_BASIS : params.basis;
  const yearsSummary = params.added
    ? `${articleCountWindowLabel(params)} · Date added`
    : `${articleCountWindowLabel(params)} · ${params.basis === "fy" ? "Fiscal (July–June)" : "Calendar"}`;
  const listSummary = !applied
    ? "None"
    : !applied.found
      ? "List not found"
      : `${applied.count.toLocaleString()} ${applied.count === 1 ? "entry" : "entries"}`;

  return (
    <ReportRail
      resetHref={resetHref}
      help="Filters apply automatically. Numbers next to options count active people, not articles."
      testId="article-count-rail-panel"
    >
      <AutoSubmitForm
        id={`article-count-filters${idSuffix}`}
        action={basePath}
        className="group flex flex-col"
        data-testid="article-count-filters"
      >
        <input type="hidden" name={ARTICLE_COUNT_SUBMITTED} value="1" />
        <RailSection label="Years" summary={yearsSummary} defaultOpen testId="rail-years">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="sr-only">Count by</legend>
            {(
              [
                ["cy", BASIS_LABEL.cy],
                ["fy", BASIS_LABEL.fy],
                [ADDED_BASIS, ADDED_LABEL],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className={RADIO}>
                <input type="radio" name="basis" value={v} defaultChecked={mode === v} className={RADIO_BOX} />
                {label}
              </label>
            ))}
          </fieldset>
          {params.added ? (
            <>
              {/* Keyed on the window: a quick pick (a client navigation) resets it. */}
              <AddedDateField
                key={`${params.added.from}|${params.added.to}`}
                from={params.added.from}
                to={params.added.to}
                max={today}
              />
              <div className="flex flex-wrap gap-1.5" data-testid="added-quick-picks">
                {ADDED_QUICK_PICKS.map((days) => {
                  const from = shiftIsoDate(today, -days);
                  const on = params.added?.from === from && params.added?.to === today;
                  return (
                    <Link
                      key={days}
                      href={href({ ...params, added: { from, to: today } })}
                      aria-current={on ? "true" : undefined}
                      className={cn(
                        "border-apollo-border-strong rounded-full border px-2.5 py-0.5 text-[13px]",
                        on ? "bg-apollo-surface font-semibold" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Last {days} days
                    </Link>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
              <select name="from" defaultValue={params.from} aria-label="From year" className={FIELD}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {yearLabel(params, y)}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground text-[13px]">to</span>
              <select name="to" defaultValue={params.to} aria-label="To year" className={FIELD}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {yearLabel(params, y)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </RailSection>
        <RailSection
          label="Person type"
          summary={summarize(params.types.map((t) => roleLabel.get(t) ?? t))}
          defaultOpen={params.types.length > 0}
          testId="rail-person-type"
        >
          <ReportFacetList
            name="type"
            options={withSelected(facets.roleCategories, params.types, (t) => roleLabel.get(t) ?? t)}
            selected={params.types}
            collapseAfter={10}
            searchPlaceholder="Search person types…"
            countsLabel="People"
          />
        </RailSection>
        <RailSection
          label="Department / division"
          summary={summarize(units.dept.map(labelOf))}
          defaultOpen={units.dept.length > 0}
          testId="rail-department"
        >
          <ReportFacetList
            name="unit"
            options={withSelected(deptOptions, units.dept, labelOf)}
            selected={units.dept}
            collapseAfter={8}
            searchPlaceholder="Search departments…"
            countsLabel="People"
          />
        </RailSection>
        <RailSection
          label="Centers"
          summary={summarize(units.center.map(labelOf))}
          defaultOpen={units.center.length > 0}
          testId="rail-centers"
        >
          <ReportFacetList
            name="unit"
            options={withSelected(centerOptions, units.center, labelOf)}
            selected={units.center}
            collapseAfter={6}
            searchPlaceholder="Search centers…"
            countsLabel="People"
          />
        </RailSection>
        <RailSection
          label="Institution"
          summary={summarize(units.inst.map(labelOf))}
          defaultOpen={units.inst.length > 0}
          testId="rail-institution"
        >
          <ReportFacetList
            name="unit"
            options={withSelected(facets.institutions, units.inst, labelOf)}
            selected={units.inst}
            collapseAfter={6}
            searchPlaceholder="Search institutions…"
            countsLabel="People"
          />
        </RailSection>
        <RailSection label="CWID list" summary={listSummary} defaultOpen={applied !== null} testId="rail-cwid-list">
          <CwidListField applied={applied} />
        </RailSection>
        <RailSection
          label="Article type"
          summary={summarize(params.atypes)}
          defaultOpen={params.atypes.length > 0}
          testId="rail-article-type"
        >
          <ReportFacetList
            name="atype"
            options={withSelected(
              choices.atypes.map((a) => ({ value: a, label: a })),
              params.atypes,
              (a) => a,
            )}
            selected={params.atypes}
          />
        </RailSection>
        <RailSection
          label="Journal Impact Factor"
          summary={params.jif > 0 ? `Journals with JIF ≥ ${params.jif}` : "Any journal"}
          defaultOpen={params.jif > 0}
          testId="rail-jif"
        >
          <JifField defaultValue={params.jif} max={JIF_MAX} />
        </RailSection>
        <RailSection
          label="Author position"
          summary={POSITION_LABEL[params.pos]}
          defaultOpen={params.pos !== "any"}
          testId="rail-position"
        >
          <fieldset className="flex flex-col gap-1.5">
            <legend className="sr-only">Author position</legend>
            {(Object.keys(POSITION_LABEL) as (keyof typeof POSITION_LABEL)[]).map((pos) => (
              <label key={pos} className={RADIO}>
                <input type="radio" name="pos" value={pos} defaultChecked={params.pos === pos} className={RADIO_BOX} />
                {POSITION_LABEL[pos]}
              </label>
            ))}
          </fieldset>
        </RailSection>
        {/* No-JS fallback; the island hides it once hydrated. */}
        <div className="border-apollo-rail-border border-t px-[18px] py-3 group-data-[hydrated=true]:hidden">
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

/** Author tokens as the citation row shows them: all of a short list; for a
 *  long one the first six, every matching scholar, and the last author, with
 *  "…" where authors are left out. A matching scholar (by author rank) carries
 *  its CWID. */
export function citationAuthors(a: Pick<ArticleRow, "authors" | "matches">): CitationRow["authors"] {
  const byRank = new Map(a.matches.filter((m) => m.rank > 0).map((m) => [m.rank - 1, m.cwid]));
  const n = a.authors.length;
  const keep = new Set<number>();
  if (n <= 12) for (let i = 0; i < n; i++) keep.add(i);
  else {
    for (let i = 0; i < 6; i++) keep.add(i);
    keep.add(n - 1);
    for (const i of byRank.keys()) if (i < n) keep.add(i);
  }
  const out: CitationRow["authors"] = [];
  let last = -1;
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (i > last + 1) out.push({ text: "…" });
    const cwid = byRank.get(i);
    out.push(cwid ? { text: a.authors[i], cwid } : { text: a.authors[i] });
    last = i;
  }
  return out;
}

/** Matching scholars the byline does not carry: a match with no known author
 *  rank (the rank-0 "unknown" sentinel, #2227), a rank past the author list,
 *  or a second match on an already-placed rank. The citation lists them on a
 *  "WCM authors:" line so every matching scholar shows. One per CWID. */
export function unplacedScholars(
  a: Pick<ArticleRow, "authors" | "matches">,
  placed: CitationRow["authors"] = citationAuthors(a),
): CitationRow["otherScholars"] {
  const seen = new Set(placed.flatMap((t) => (t.cwid ? [t.cwid] : [])));
  const out: CitationRow["otherScholars"] = [];
  for (const m of a.matches) {
    if (seen.has(m.cwid)) continue;
    seen.add(m.cwid);
    out.push({ cwid: m.cwid, name: m.name.trim() || m.cwid });
  }
  return out;
}

function toCitationRow(a: ArticleRow): CitationRow {
  const authors = citationAuthors(a);
  return {
    key: a.pmid,
    title: (a.title ?? "").trim().replace(/\.+$/, ""),
    href: a.id.href,
    authors,
    otherScholars: unplacedScholars(a, authors),
    journal: a.journal,
    source: a.source,
    type: a.articleType,
    jif: a.jif,
    id: a.id,
    doi: a.doi,
    year: a.year,
    dateAdded: a.dateAdded,
  };
}

function ByYear({
  params,
  rows,
  today,
  yearHref,
}: {
  params: ArticleCountParams;
  rows: ArticleCountRow[];
  today: string;
  yearHref: (y: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const current = currentPeriod(params, today);
  const hasYtd = current !== null && rows.some((r) => r.year === current);
  const header = params.added ? "Year added" : params.basis === "fy" ? "Fiscal year" : "Year";
  return (
    <div className="mt-4" data-testid="article-count-by-year">
      <div className="bg-apollo-surface-2 text-muted-foreground grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto] gap-3 px-3 py-2.5 text-xs font-semibold tracking-[0.08em] uppercase">
        <span>{header}</span>
        <span aria-hidden />
        <span className="text-right">Articles</span>
      </div>
      <ul className="m-0 list-none p-0" data-testid="article-count-table">
        {rows.map((r) => {
          const ytd = r.year === current;
          return (
            <li key={r.year} className="border-apollo-border border-b">
              <Link
                href={yearHref(r.year)}
                title={`View articles from ${yearLabel(params, r.year)}`}
                className="hover:bg-apollo-page grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 text-[15px] tabular-nums"
              >
                <span className="flex items-center gap-2 whitespace-nowrap">
                  {yearLabel(params, r.year)}
                  {ytd && (
                    <span className="text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border rounded border px-1.5 py-px text-[11px] font-semibold tracking-[0.04em]">
                      YTD
                    </span>
                  )}
                </span>
                <span className="bg-apollo-surface-2 block h-2.5 overflow-hidden rounded-sm" aria-hidden>
                  <span
                    className={cn("block h-full rounded-sm", ytd ? "bg-apollo-slate/55" : "bg-apollo-slate")}
                    style={{ width: `${(r.count / max) * 100}%` }}
                  />
                </span>
                <span className="text-right whitespace-nowrap">
                  {r.count.toLocaleString()}
                  <span className="text-muted-foreground ml-1.5" aria-hidden>
                    ›
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {hasYtd && (
        <p className="text-muted-foreground mt-3 text-[13px]" data-testid="article-count-ytd-note">
          {params.basis === "fy"
            ? `FY${current} counts articles added to PubMed through ${formatLongDate(today)}.`
            : `${current} counts articles published through ${formatLongDate(today)}.`}{" "}
          Records for the year are still being added.
        </p>
      )}
      <p className="text-muted-foreground mt-2 text-[13px]">Select a year to see its articles.</p>
    </div>
  );
}

export async function renderArticleCountReport({
  searchParams,
  basePath,
  session,
}: AdminReportProps): Promise<ReportRender> {
  const sp = toSearchParams(searchParams);
  const { params, defaulted } = await resolveArticleCountParams(
    parseArticleCountParams(sp, ARTICLE_COUNT_PARSE),
    sp,
    session,
  );
  const view = parseView(sp);
  const today = new Date().toISOString().slice(0, 10);
  const [choices, { rows, total }] = await Promise.all([loadArticleCountChoices(), loadArticleCounts(params)]);
  const labels = unitLabels(choices.facets);

  const yearPick = view.year !== null && rows.some((r) => r.year === view.year) ? view.year : null;
  const listTotal = yearPick === null ? total : (rows.find((r) => r.year === yearPick)?.count ?? 0);
  const listOver = listTotal > ARTICLE_LIST_CAP;
  const articles =
    view.tab === "articles" && !listOver && listTotal > 0 ? await loadArticleList(params, { year: yearPick }) : [];

  const qs = articleCountQueryString(params);
  const viewSuffix = (v: View) =>
    (v.tab === "articles" ? "&tab=articles" : "") + (v.tab === "articles" && v.year !== null ? `&year=${v.year}` : "");
  const href = (p: ArticleCountParams, v: View = { tab: view.tab, year: yearPick }) =>
    `${basePath}?${articleCountQueryString(p)}&${ARTICLE_COUNT_SUBMITTED}=1${viewSuffix(v)}`;
  const resetHref = isBareArticleCountQuery(sp) ? null : basePath;

  const applied: AppliedCwidList | null = params.list
    ? {
        id: params.list,
        found: params.listData?.found ?? false,
        count: params.listData?.cwids.length ?? 0,
        unmatched: params.listData?.unmatched ?? [],
      }
    : null;

  // Chips: the window (fixed), then every removable filter.
  const roleLabel = new Map(choices.facets.roleCategories.map((o) => [o.value, o.label]));
  const chips: FilterChip[] = [];
  for (const t of params.types)
    chips.push({ group: "Person type", value: roleLabel.get(t) ?? t, removeHref: href({ ...params, types: params.types.filter((x) => x !== t) }) });
  for (const u of params.units) {
    const kind = u.slice(0, u.indexOf(":"));
    chips.push({
      group: UNIT_GROUP[kind] ?? "Unit",
      value: labels.get(u) ?? u,
      removeHref: href({ ...params, units: params.units.filter((x) => x !== u) }),
    });
  }
  if (applied)
    chips.push({
      group: "CWID list",
      value: applied.found ? `${applied.count.toLocaleString()} ${applied.count === 1 ? "entry" : "entries"}` : "not found",
      removeHref: href({ ...params, list: null, listData: null }),
    });
  for (const a of params.atypes)
    chips.push({ group: "Article type", value: a, removeHref: href({ ...params, atypes: params.atypes.filter((x) => x !== a) }) });
  if (params.jif > 0) chips.push({ group: "Impact Factor", value: `≥ ${params.jif}`, removeHref: href({ ...params, jif: 0 }) });
  if (params.pos !== "any")
    chips.push({ group: "Author", value: POSITION_LABEL[params.pos], removeHref: href({ ...params, pos: "any" }) });
  const windowChip: FilterChip = params.added
    ? { group: "Added to PubMed", value: articleCountWindowLabel(params), removeHref: null }
    : { group: params.basis === "fy" ? "Fiscal years" : "Years", value: articleCountWindowLabel(params), removeHref: null };
  const allChips: FilterChip[] = [
    windowChip,
    ...chips,
    ...(chips.length === 0 ? [{ group: "Scholars", value: "All people and article types", removeHref: null }] : []),
  ];

  const statLabel = params.added
    ? `distinct articles added to PubMed ${articleCountWindowLabel(params)}`
    : `distinct articles, ${articleCountWindowLabel(params)} (${params.basis === "fy" ? "fiscal" : "calendar"} years)`;
  const downloadOver = total > ARTICLE_LIST_CAP;

  const railProps: RailProps = {
    basePath,
    params,
    choices,
    labels,
    applied,
    resetHref,
    href: (p) => href(p),
    today,
  };

  const tabClass = (on: boolean) =>
    cn(
      "-mb-px border-b-2 py-2.5 text-base whitespace-nowrap",
      on ? "border-apollo-maroon text-foreground font-semibold" : "text-muted-foreground hover:text-foreground border-transparent",
    );

  const yearChip =
    yearPick !== null ? (
      <span
        className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-[13px] whitespace-nowrap"
        data-testid="article-year-chip"
      >
        Year: {yearLabel(params, yearPick)}
        <Link
          href={href(params, { tab: "articles", year: null })}
          aria-label="Show all years"
          className="hover:bg-apollo-slate-tint-border inline-grid size-[18px] place-items-center rounded-full"
        >
          <X size={12} aria-hidden />
        </Link>
      </span>
    ) : null;

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        Distinct articles per year for the scholars matching the filters. Each article counts once,
        however many matching authors it has.
      </p>
    ),
    main: (
      <ReportLayout rail={<Rail {...railProps} />}>
        <div className="min-w-0" data-testid="article-count-results">
          <div className="mb-4 lg:hidden">
            <FiltersSheet activeCount={articleCountActiveFilters(params)} testId="article-count-filters-sheet-trigger">
              <Rail {...railProps} idSuffix="-sheet" />
            </FiltersSheet>
          </div>
          <ReportCard>
            <ReportStats
              stats={[{ value: total.toLocaleString(), label: statLabel }]}
              aside={
                <div className="flex flex-col items-start gap-2">
                  <Button asChild variant="apollo">
                    <a
                      href={`/api/edit/reports/article-count?${qs}&${ARTICLE_COUNT_SUBMITTED}=1`}
                      data-testid="article-count-download"
                    >
                      <Download className="size-4" aria-hidden />
                      Download .xlsx
                    </a>
                  </Button>
                  <p
                    className={cn("text-[13px]", downloadOver ? "text-apollo-amber" : "text-muted-foreground")}
                    data-testid="article-count-download-note"
                  >
                    {downloadOver
                      ? `Includes the Criteria sheet. The article list is left out above ${ARTICLE_LIST_CAP.toLocaleString()} articles; narrow the filters to include it.`
                      : "Includes the Criteria sheet and the article list with matching scholars."}
                    {yearPick !== null &&
                      ` The download covers every year in the window, not just ${yearLabel(params, yearPick)}.`}
                  </p>
                </div>
              }
            />
            <div className="mt-5">
              <FilterChips chips={allChips} testId="article-count-chips" />
              {defaulted && (
                <p className="text-muted-foreground mt-2 text-[13px]" data-testid="article-count-default-note">
                  Showing the units you manage. Remove them to see all of Weill Cornell Medicine.
                </p>
              )}
            </div>
            <nav className="border-apollo-border mt-6 flex gap-7 border-b" aria-label="Report views">
              <Link
                href={href(params, { tab: "year", year: null })}
                aria-current={view.tab === "year" ? "page" : undefined}
                className={tabClass(view.tab === "year")}
              >
                By year
              </Link>
              <Link
                href={href(params, { tab: "articles", year: yearPick })}
                aria-current={view.tab === "articles" ? "page" : undefined}
                className={tabClass(view.tab === "articles")}
                data-testid="article-count-articles-tab"
              >
                Articles ({listTotal.toLocaleString()})
              </Link>
            </nav>
            {view.tab === "year" ? (
              <ByYear
                params={params}
                rows={rows}
                today={today}
                yearHref={(y) => href(params, { tab: "articles", year: y })}
              />
            ) : listOver ? (
              <div data-testid="article-count-too-many">
                <div className="flex flex-wrap items-center gap-2.5 py-3.5">
                  <span className="text-muted-foreground text-sm">Too many articles to list</span>
                  {yearChip}
                </div>
                <div className="bg-apollo-surface-2 border-apollo-border flex flex-col items-start gap-2.5 rounded-[10px] border p-5 sm:p-7">
                  <p className="text-base font-semibold">
                    {listTotal.toLocaleString()} articles match
                    {yearPick !== null ? ` in ${yearLabel(params, yearPick)}` : ""}
                  </p>
                  <p className="text-muted-foreground max-w-[560px] text-sm">
                    The citation list shows up to {ARTICLE_LIST_CAP.toLocaleString()} articles, the same limit as the
                    download. Narrow the filters in the Filters panel, or try a common combination:
                  </p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={href({ ...params, pos: "either", jif: 10 })}>First or last author, JIF ≥ 10</Link>
                    </Button>
                    <Button asChild variant="outline" size="sm">
                      <Link href={href({ ...params, types: [FULL_TIME_FACULTY], pos: "last" })}>
                        Full-time faculty, last author
                      </Link>
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <ArticleCitationList
                rows={articles.map(toCitationRow)}
                yearChip={yearChip}
                showDateAdded={params.added !== null}
              />
            )}
            <p className="text-muted-foreground mt-5 max-w-[640px] text-[13px]" role="note">
              {ARTICLE_COUNT_CAVEAT}
              {params.basis === "fy" &&
                !params.added &&
                " Fiscal years run July 1 – June 30, named by the ending year, and are assigned by the date the article was added to PubMed."}
              {params.added && " Articles are counted by the date they were added to PubMed and grouped by the year added."}
              {params.jif > 0 && " Articles in journals with no impact factor on file are excluded."}
            </p>
          </ReportCard>
        </div>
      </ReportLayout>
    ),
  };
}
