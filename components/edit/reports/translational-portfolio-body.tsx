/**
 * Report 26 — "Translational portfolio" body. Mockup: the Design canvas
 * "Scholars: Translational Portfolio View" (sample data only). Step 1:
 * publications only, so the record-type control and the comparison card
 * (by record type; funding to publications) are not drawn.
 *
 * Top to bottom: the filter row (one GET `AutoSubmitForm`: scholar lookup,
 * unit, years, research area), the active-filter strip, four summary tiles,
 * "Share by stage" (one toggle row per stage, a bar per year on one shared
 * scale), the unit / research area table, the Activities / Scholars list (or
 * one scholar's view), and "How to read this".
 *
 * Server-rendered: every selection is a link or a GET form, so it lives in
 * the URL and the back button works. Stage bars share one neutral colour and
 * No stage a muted one (`StageBadge`'s rule: no stage reads as better).
 * Loaders and params: `lib/edit/translational-portfolio-report.ts`.
 */
import Link from "next/link";
import { Download } from "lucide-react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { ArticleCitationList } from "@/components/edit/reports/article-citation-list";
import { toCitationRow } from "@/components/edit/reports/article-count-body";
import { ReportCard } from "@/components/edit/reports/report-ui";
import { PubTitle } from "@/components/publication/pub-html";
import { StageBadge } from "@/components/publication/stage-badge";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Button } from "@/components/ui/button";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { loadArticleList, NO_STAGE_LABEL } from "@/lib/edit/article-count-report";
import { loadPortfolioReachTile } from "@/lib/edit/downstream-reach-entry";
import type { AdminReportProps, ReportRender } from "@/lib/edit/report-registry";
import {
  activityListScope,
  COUNTING_RULE,
  countsIn,
  countsTotal,
  exactShares,
  loadPortfolio,
  loadPortfolioChoices,
  MIN_SCHOLAR_ACTIVITIES,
  parsePortfolioParams,
  PORTFOLIO_PAGE_SIZE,
  portfolioQueryString,
  roundedShares,
  SCHOLAR_RULE,
  STAGE_BUCKETS,
  stagedTotal,
  stagesLabel,
  UNIT_TABS,
  type PortfolioData,
  type PortfolioParams,
  type RecentWork,
  type StageBucket,
  type StageCounts,
  type UnitTab,
} from "@/lib/edit/translational-portfolio-report";
import { methodologyHref } from "@/lib/methodology-anchors";
import { profilePath } from "@/lib/profile-url";
import {
  NO_STAGE_DEFINITION,
  stageDefinition,
  TRANSLATIONAL_STAGE_LABELS,
  TRANSLATIONAL_STAGES,
  type TranslationalStage,
} from "@/lib/translational-stage";
import { cn } from "@/lib/utils";

const FIELD =
  "border-apollo-border-strong bg-apollo-surface h-11 min-w-0 rounded-md border px-3 text-sm text-foreground";
const LABEL = "text-muted-foreground flex flex-col gap-1 text-xs";
const BAR = "bg-apollo-slate";
const BAR_NONE = "bg-apollo-border-strong";
const H2 = "text-xl font-semibold";

const code = (s: TranslationalStage) => s.replace("-", "–");
const pct = (n: number) => `${Math.round(n)}%`;
const bucketName = (k: StageBucket) => (k === "none" ? NO_STAGE_LABEL : code(k));
const bucketDef = (k: StageBucket) =>
  k === "none" ? NO_STAGE_DEFINITION : `${TRANSLATIONAL_STAGE_LABELS[k]}: ${stageDefinition(k)}`;

function toSearchParams(sp: AdminReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

/** A stage code or name with its definition on hover and keyboard focus. */
function StageTerm({ k, children }: { k: StageBucket; children: React.ReactNode }) {
  return (
    <HoverTooltip text={bucketDef(k)} wide>
      <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-[3px]">
        {children}
      </span>
    </HoverTooltip>
  );
}

/** A thin share bar under a cell's figure. */
function ShareBar({ share, none, dim }: { share: number; none?: boolean; dim?: boolean }) {
  return (
    <span className="bg-apollo-surface-2 block h-1.5 rounded-full" aria-hidden>
      <span
        className={cn("block h-1.5 rounded-full", none ? BAR_NONE : BAR, dim && "opacity-40")}
        style={{ width: `${Math.min(100, share)}%` }}
      />
    </span>
  );
}

/** A GET form that submits one URL: the toggle buttons (`aria-pressed`) are
 *  real buttons, so a stage row is a button, not a link. */
function QueryButton({
  action,
  qs,
  pressed,
  label,
  className,
  children,
}: {
  action: string;
  qs: string;
  pressed: boolean;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <form action={action} method="get">
      {[...new URLSearchParams(qs)].map(([k, v], i) => (
        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" aria-pressed={pressed} aria-label={label} className={className}>
        {children}
      </button>
    </form>
  );
}

function Segmented({
  label,
  items,
}: {
  label: string;
  items: { key: string; label: string; href: string; on: boolean }[];
}) {
  return (
    <nav aria-label={label} className="bg-apollo-surface-2 border-apollo-border-strong flex flex-wrap gap-0.5 rounded-[10px] border p-[3px]">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.on ? "page" : undefined}
          className={cn(
            "flex min-h-10 items-center rounded-lg px-3.5 text-sm font-medium",
            t.on ? "bg-apollo-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub: React.ReactNode }) {
  return (
    <div className="bg-apollo-surface border-apollo-border flex flex-col gap-1 rounded-xl border px-5 py-4">
      <span className="text-muted-foreground text-xs tracking-[0.05em] uppercase">{label}</span>
      <span className="text-3xl leading-tight font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground text-xs">{sub}</span>
    </div>
  );
}

function WorkLine({ w }: { w: RecentWork }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <PubTitle value={w.title.trim().replace(/\.+$/, "")} />
      <span className="text-muted-foreground text-xs">{w.year}</span>
      <StageBadge stage={w.stage} />
    </span>
  );
}

export async function renderTranslationalPortfolioReport({
  session,
  searchParams,
  basePath,
}: AdminReportProps): Promise<ReportRender> {
  const p = parsePortfolioParams(toSearchParams(searchParams));
  const choices = await loadPortfolioChoices();
  const [data, reach] = await Promise.all([
    loadPortfolio(p, choices),
    // A door into report 27, counted by that report: null unless it is on, the
    // viewer can open it, and it would list exactly this page's scope. Its
    // failure leaves the page as it was.
    loadPortfolioReachTile(p, session).catch((err: unknown) => {
      console.error("[translational-portfolio] downstream reach tile failed", err);
      return null;
    }),
  ]);
  const articles =
    p.view === "activities" && !p.cwid && data.activities.pmids.length > 0
      ? await (async () => {
          const { params, extra } = activityListScope(p, data.activities.pmids);
          const rows = await loadArticleList(params, { extra });
          const order = new Map(data.activities.pmids.map((id, i) => [id, i]));
          return rows.sort((a, b) => (order.get(a.pmid) ?? 0) - (order.get(b.pmid) ?? 0));
        })()
      : [];

  const href = (q: Partial<PortfolioParams>, hash = "") =>
    `${basePath}?${portfolioQueryString({ ...p, page: 1, ...q })}${hash}`;
  const hasSel = p.stages.length > 0;
  const total = countsTotal(data.all);
  const first = data.byYear[0]?.counts;
  const last = data.byYear[data.byYear.length - 1]?.counts;
  const later = (c: StageCounts | undefined) => (c ? countsIn(exactShares(c), ["T2", "T3-4"]) : 0);
  const pickShare = (c: StageCounts | undefined) => (c ? countsIn(exactShares(c), p.stages) : 0);

  // The selection as the strip names it.
  const unitName = p.units.map((u) => choices.labels.get(u) ?? u).join(", ");
  const areaName = p.area ? (choices.areas.find((a) => a.id === p.area)?.label ?? p.area) : null;
  const scope = [data.person?.name ?? (p.cwid ? p.cwid : null), unitName || null, areaName, hasSel ? stagesLabel(p.stages) : null].filter(
    (x): x is string => !!x,
  );
  const clearHref = `${basePath}?${portfolioQueryString({ ...p, units: [], area: null, stages: [], cwid: null, q: "", page: 1 })}`;

  // Share by stage: one scale for every row (the tallest year share anywhere).
  const yearShares = data.byYear.map((r) => exactShares(r.counts));
  const peak = Math.max(1, ...yearShares.flatMap((s) => STAGE_BUCKETS.map((k) => s[k])));
  const lastShares = roundedShares(last ?? data.all);
  const yearsLabel = p.from === p.to ? String(p.from) : `${p.from} to ${p.to}`;

  // The table and its baseline.
  const tab = UNIT_TABS[p.by];
  const tableNote = [
    `Publications, ${yearsLabel}, ${hasSel ? `sorted by share in ${stagesLabel(p.stages)}.` : p.by === "area" ? "sorted by thinnest stage." : "sorted by volume."}`,
    "Each row adds up to 100%.",
    p.by === "div" && "A division's row counts its members, including hand-added ones.",
    p.by === "center" && "Center activities also count toward their members' departments, so rows here overlap.",
    p.by === "area" && "A stage under 3% of an area with 50 or more publications is called out as a gap.",
  ]
    .filter(Boolean)
    .join(" ");

  const years = Array.from({ length: 40 }, (_, i) => new Date().getUTCFullYear() - i);
  const deptOptions = choices.facets.departments;
  const centers = choices.facets.centers.filter((c) => c.count > 0 || p.units.includes(c.value));
  const unitValue = p.units[0] ?? "";

  const listTotal = p.view === "scholars" ? data.scholars.total : data.activities.total;
  const pages = Math.max(1, Math.ceil(listTotal / PORTFOLIO_PAGE_SIZE));
  const fromN = listTotal === 0 ? 0 : (p.page - 1) * PORTFOLIO_PAGE_SIZE + 1;
  const toN = Math.min(listTotal, p.page * PORTFOLIO_PAGE_SIZE);
  const noun = p.view === "scholars" ? "scholars" : "publications";
  const rangeLabel = listTotal === 0 ? `No ${noun} match` : `Showing ${fromN.toLocaleString()} to ${toN.toLocaleString()} of ${listTotal.toLocaleString()} ${noun}`;
  const searchHref = (() => {
    const q = new URLSearchParams({ type: "publications", yearMin: String(p.from), yearMax: String(p.to) });
    for (const s of p.stages) q.append("translationalStage", s);
    return `/search?${q}`;
  })();

  const cellLink = (k: StageBucket, rowHref: string) => {
    if (k === "none") return `${basePath}?${rowHref}#items`;
    const q = new URLSearchParams(rowHref);
    q.delete("stage");
    q.append("stage", k);
    q.set("view", "scholars");
    q.delete("page");
    return `${basePath}?${q}#items`;
  };

  return {
    subtitle: (
      <p className="text-muted-foreground max-w-[720px] text-sm">
        Where WCM publications sit between basic research and population health, and who does the work.
      </p>
    ),
    aside: (
      <Button asChild variant="outline" size="sm">
        <a href={`/api/edit/reports/translational-portfolio?${portfolioQueryString({ ...p, page: 1 })}`} data-testid="portfolio-download">
          <Download className="size-4" aria-hidden />
          Download .xlsx
        </a>
      </Button>
    ),
    main: (
      <div className="mt-7 flex flex-col gap-6" data-testid="portfolio-report">
        {/* Filter row. */}
        <AutoSubmitForm action={basePath} className="group flex flex-wrap items-end gap-x-4 gap-y-3" data-testid="portfolio-filters">
          {p.stages.map((s) => (
            <input key={s} type="hidden" name="stage" value={s} />
          ))}
          {p.by !== "dept" && <input type="hidden" name="by" value={p.by} />}
          {p.view !== "activities" && <input type="hidden" name="view" value={p.view} />}
          {p.cwid && <input type="hidden" name="cwid" value={p.cwid} />}
          <label className={cn(LABEL, "max-w-[380px] flex-[1_1_300px]")}>
            <span className="text-foreground font-medium">Look up a scholar</span>
            <input
              type="search"
              name="q"
              defaultValue={p.q}
              placeholder="Search by name or CWID"
              autoComplete="off"
              className={cn(FIELD, "w-full")}
            />
          </label>
          <label className={LABEL}>
            Unit
            <select name="unit" defaultValue={unitValue} className={cn(FIELD, "min-w-[220px]")}>
              <option value="">All of Weill Cornell Medicine</option>
              <optgroup label="Departments">
                {deptOptions.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Divisions">
                {deptOptions.flatMap((d) =>
                  d.divisions.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  )),
                )}
              </optgroup>
              <optgroup label="Centers and institutes">
                {centers.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <div className={LABEL}>
            <span id="portfolio-years">Years</span>
            <div className="flex items-center gap-2" role="group" aria-labelledby="portfolio-years">
              <select name="from" defaultValue={p.from} aria-label="From year" className={FIELD}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <span>to</span>
              <select name="to" defaultValue={p.to} aria-label="To year" className={FIELD}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className={LABEL}>
            Research area
            <select name="area" defaultValue={p.area ?? ""} className={cn(FIELD, "min-w-[190px]")}>
              <option value="">All research areas</option>
              {choices.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          {/* No-JS fallback (and Enter in the lookup box); hidden once hydrated. */}
          <button
            type="submit"
            className="border-foreground/40 hover:bg-apollo-surface-2 h-11 rounded-md border px-4 text-sm group-data-[hydrated=true]:hidden"
          >
            Apply
          </button>
        </AutoSubmitForm>

        {p.q && !p.cwid && (
          <div className="bg-apollo-surface border-apollo-border -mt-3 max-w-[480px] rounded-xl border p-1" data-testid="portfolio-lookup">
            {data.lookup.length === 0 ? (
              <p className="text-muted-foreground px-3 py-2 text-sm">No active scholar matches &ldquo;{p.q}&rdquo;.</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {data.lookup.map((s) => (
                  <li key={s.cwid}>
                    <Link
                      href={href({ cwid: s.cwid, q: "", view: "scholars" }, "#items")}
                      className="hover:bg-apollo-surface-2 flex min-h-12 items-center gap-2.5 rounded-lg px-2 py-1"
                    >
                      <HeadshotAvatar cwid={s.cwid} preferredName={s.name} size="sm" />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium">{s.name}</span>
                        <span className="text-muted-foreground text-xs">
                          {[s.title, s.department].filter(Boolean).join(" · ")} · <span className="font-mono">{s.cwid}</span>
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Active-filter strip. */}
        {scope.length > 0 && (
          <div
            className="bg-apollo-slate-tint border-apollo-slate-tint-border flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border py-2 pr-2 pl-4"
            data-testid="portfolio-scope"
          >
            <span>Filtered to</span>
            <span className="grow font-semibold">{scope.join(" · ")}</span>
            <a href="#items" className="text-apollo-slate font-medium hover:underline">
              View the list below
            </a>
            <Button asChild variant="outline" size="sm">
              <Link href={clearHref}>Clear filter</Link>
            </Button>
          </div>
        )}

        {/* Summary tiles. */}
        <section aria-label="Summary" className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-4" data-testid="portfolio-tiles">
          {hasSel ? (
            <>
              <Tile label={`Publications in ${stagesLabel(p.stages)}`} value={countsIn(data.all, p.stages).toLocaleString()} sub={`Of ${total.toLocaleString()} publications`} />
              <Tile
                label="Share of publications"
                value={pct(pickShare(data.all))}
                sub={`${pct(pickShare(first))} in ${p.from}, ${pct(pickShare(last))} in ${p.to}`}
              />
            </>
          ) : (
            <>
              <Tile label="Publications with a stage" value={stagedTotal(data.all).toLocaleString()} sub={`Of ${total.toLocaleString()} publications`} />
              <Tile label="T2 and T3–4" value={pct(later(last))} sub={`Share in ${p.to}; ${pct(later(first))} in ${p.from}`} />
            </>
          )}
          <Tile
            label="Areas spanning T0 to T3–4"
            value={`${data.areaCoverage.spanning} of ${data.areaCoverage.sized}`}
            sub={
              data.areaCoverage.sized > data.areaCoverage.spanning ? (
                <Link href={href({ by: "area" }, "#units")} className="text-apollo-slate hover:underline">
                  See the {data.areaCoverage.sized - data.areaCoverage.spanning} with a gap
                </Link>
              ) : (
                "Research areas with 50 or more publications"
              )
            }
          />
          <Tile label={NO_STAGE_LABEL} value={pct(exactShares(data.all).none)} sub="Low confidence, or outside the spectrum" />
          {reach && (
            <Tile
              label="T0 and T1 publications later cited by clinical studies"
              value={
                <>
                  <Link
                    href={reach.citedHref}
                    aria-label={`${reach.cited.toLocaleString()} T0 and T1 publications cited by clinical studies, in the Downstream reach report`}
                    className="text-apollo-slate hover:underline"
                    data-testid="portfolio-reach-cited"
                  >
                    {reach.cited.toLocaleString()}
                  </Link>{" "}
                  of{" "}
                  <Link
                    href={reach.totalHref}
                    aria-label={`${reach.total.toLocaleString()} T0 and T1 publications in scope, in the Downstream reach report`}
                    className="text-apollo-slate hover:underline"
                    data-testid="portfolio-reach-total"
                  >
                    {reach.total.toLocaleString()}
                  </Link>
                </>
              }
              sub="Of the T0 and T1 publications in these filters. Clinical studies by a publication's own authors are not counted."
            />
          )}
        </section>

        {/* Share by stage over time. */}
        <ReportCard className="flex flex-col gap-3.5 p-5 sm:p-5">
          <h2 className={H2}>Share by stage, {yearsLabel}</h2>
          <div className="flex flex-col gap-1.5" data-testid="portfolio-stage-rows">
            {STAGE_BUCKETS.map((k) => {
              const on = k !== "none" && p.stages.includes(k);
              const bars = (
                <span className="border-apollo-border-strong flex h-11 items-end gap-[5px] border-b" aria-hidden>
                  {yearShares.map((s, i) => (
                    <span
                      key={data.byYear[i].year}
                      className={cn("flex-1 rounded-t-[2px]", k === "none" ? BAR_NONE : BAR)}
                      style={{ height: `${(s[k] / peak) * 100}%` }}
                    />
                  ))}
                </span>
              );
              const grid = "grid w-full grid-cols-[minmax(110px,200px)_minmax(80px,1fr)_64px] items-center gap-3.5 rounded-[10px] border px-2.5 py-2 text-left";
              const firstShare = pct(yearShares[0]?.[k] ?? 0);
              if (k === "none") {
                return (
                  <div key={k} className={cn(grid, "border-transparent")}>
                    <span className="text-muted-foreground">
                      <StageTerm k="none">{NO_STAGE_LABEL}</StageTerm>
                    </span>
                    {bars}
                    <span className="text-muted-foreground text-right">{lastShares.none}%</span>
                  </div>
                );
              }
              const next = on ? p.stages.filter((s) => s !== k) : TRANSLATIONAL_STAGES.filter((s) => s === k || p.stages.includes(s));
              return (
                <QueryButton
                  key={k}
                  action={basePath}
                  qs={portfolioQueryString({ ...p, stages: next, page: 1 })}
                  pressed={on}
                  label={`${code(k)} ${TRANSLATIONAL_STAGE_LABELS[k]}: ${firstShare} in ${p.from}, ${lastShares[k]}% in ${p.to}. ${on ? "Remove from filter." : "Filter to this stage."}`}
                  className={cn(
                    grid,
                    "cursor-pointer",
                    on ? "bg-apollo-slate-tint border-apollo-slate" : "bg-apollo-surface border-apollo-border hover:bg-apollo-page",
                  )}
                >
                  <HoverTooltip text={bucketDef(k)} wide>
                    <span>
                      <span className="font-semibold">{code(k)}</span>{" "}
                      <span className="text-muted-foreground underline decoration-dotted underline-offset-[3px]">
                        {TRANSLATIONAL_STAGE_LABELS[k]}
                      </span>
                    </span>
                  </HoverTooltip>
                  {bars}
                  <span className="text-right font-semibold">{lastShares[k]}%</span>
                </QueryButton>
              );
            })}
          </div>
          <p className="text-muted-foreground text-xs">
            One row per stage, {p.from} on the left and {p.to} on the right, all on the same scale. The figure is the{" "}
            {p.to} share of publications. Select a row to filter the page; select more than one to combine them.
          </p>
        </ReportCard>

        {/* By unit or research area. */}
        <ReportCard className="flex flex-col gap-3.5 p-5 sm:p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h2 className={cn(H2, "grow scroll-mt-24")} id="units">
              By unit or research area
            </h2>
            <Segmented
              label="Unit type"
              items={(Object.keys(UNIT_TABS) as UnitTab[]).map((k) => ({
                key: k,
                label: UNIT_TABS[k].label,
                href: href({ by: k }, "#units"),
                on: p.by === k,
              }))}
            />
            <p className="text-muted-foreground basis-full text-xs">{tableNote}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] border-collapse text-sm" data-testid="portfolio-table">
              <caption className="sr-only">
                Share of publications by translational stage, by {tab.head.toLowerCase()}. {COUNTING_RULE}
              </caption>
              <thead>
                <tr className="bg-apollo-surface-2 text-muted-foreground text-left text-xs tracking-[0.05em] uppercase">
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    {tab.head}
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">
                    Publications
                  </th>
                  {STAGE_BUCKETS.map((k) => (
                    <th
                      key={k}
                      scope="col"
                      className={cn("px-3 py-2.5", k !== "none" && p.stages.includes(k) ? "text-foreground font-semibold" : "font-medium")}
                    >
                      <StageTerm k={k}>{bucketName(k)}</StageTerm>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { key: "__all", label: "All of Weill Cornell Medicine", note: "Baseline for comparison", counts: data.baseline, href: null as string | null },
                  ...data.table,
                ].map((r) => {
                  const shares = roundedShares(r.counts);
                  const baseline = r.href === null;
                  return (
                    <tr key={r.key} className={cn("border-apollo-border border-t", baseline && "bg-apollo-page")} data-testid={baseline ? "portfolio-baseline" : undefined}>
                      <th scope="row" className="px-3 py-3 text-left font-normal">
                        <span className="flex flex-col gap-0.5">
                          {baseline ? (
                            <span className="font-semibold">{r.label}</span>
                          ) : (
                            <Link href={`${basePath}?${r.href}#items`} className="text-apollo-slate font-medium hover:underline">
                              {r.label}
                            </Link>
                          )}
                          {r.note && <span className="text-muted-foreground text-xs">{r.note}</span>}
                        </span>
                      </th>
                      <td className="px-3 py-3 text-right tabular-nums">{countsTotal(r.counts).toLocaleString()}</td>
                      {STAGE_BUCKETS.map((k) => {
                        const picked = k !== "none" && p.stages.includes(k);
                        const fig = `${shares[k]}%`;
                        return (
                          <td key={k} className="px-3 py-3">
                            <span className="flex flex-col gap-1">
                              {baseline ? (
                                <span className={cn(picked && "font-semibold")}>{fig}</span>
                              ) : (
                                <Link
                                  href={cellLink(k, r.href!)}
                                  aria-label={`${fig} ${k === "none" ? "with no stage" : `in ${code(k)}`}, ${r.label}. ${k === "none" ? "Filter to this unit." : "Show scholars."}`}
                                  className={cn("self-start tabular-nums hover:underline", picked && "font-semibold")}
                                >
                                  {fig}
                                </Link>
                              )}
                              <ShareBar share={shares[k]} none={k === "none"} dim={hasSel && !picked && k !== "none"} />
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.table.length === 0 && <p className="text-muted-foreground text-sm">No {tab.label.toLowerCase()} have publications in this scope.</p>}
        </ReportCard>

        {/* The list. */}
        <ReportCard className="flex scroll-mt-24 flex-col gap-3.5 p-5 sm:p-5">
          <div id="items" className="flex scroll-mt-24 flex-wrap items-end gap-x-4 gap-y-2">
            <div className="flex flex-[1_1_280px] flex-col gap-0.5">
              <h2 className={H2}>
                {data.person
                  ? `${data.person.name}: translational profile`
                  : p.view === "scholars"
                    ? `Scholars${unitName ? ` in ${unitName}` : ""}${hasSel ? ` with ${stagesLabel(p.stages)} work` : ""}`
                    : `Publications${hasSel ? ` in ${stagesLabel(p.stages)}` : ""}${unitName ? `, ${unitName}` : ""}`}
              </h2>
              <span className="text-muted-foreground text-xs">
                {p.view === "scholars" || data.person ? SCHOLAR_RULE : "Follows the filters and stage selection above."}
              </span>
            </div>
            {!data.person && (
              <Segmented
                label="List by"
                items={[
                  { key: "activities", label: "Publications", href: href({ view: "activities" }, "#items"), on: p.view === "activities" },
                  { key: "scholars", label: "Scholars", href: href({ view: "scholars" }, "#items"), on: p.view === "scholars" },
                ]}
              />
            )}
            <a href={searchHref} className="text-apollo-slate flex min-h-11 items-center font-medium hover:underline">
              Open in Scholars search
            </a>
          </div>

          {data.person ? (
            <PersonView data={data} params={p} clearHref={href({ cwid: null, view: "scholars" }, "#items")} />
          ) : p.view === "activities" ? (
            <ArticleCitationList
              rows={articles.map((a) => ({ ...toCitationRow(a), stage: a.stage, stageConfidence: a.stageConfidence }))}
              rangeLabel={rangeLabel}
            />
          ) : (
            <div data-testid="portfolio-scholars">
              <p className="text-muted-foreground py-2 text-sm">{rangeLabel}</p>
              {data.scholars.rows.length === 0 ? (
                <p className="text-muted-foreground border-apollo-border border-t py-4">
                  No scholars have {MIN_SCHOLAR_ACTIVITIES} or more first- or senior-author publications for this combination.
                </p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {data.scholars.rows.map((s) => (
                    <li key={s.cwid} className="border-apollo-border flex flex-wrap items-start gap-x-6 gap-y-2 border-t py-4">
                      <div className="flex min-w-0 flex-[1_1_300px] gap-3">
                        <HeadshotAvatar cwid={s.cwid} preferredName={s.name} size="md" />
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <Link href={href({ cwid: s.cwid }, "#items")} className="text-apollo-slate text-base font-semibold hover:underline">
                            {s.name}
                          </Link>
                          <span className="text-apollo-ink-2 text-[13px]">{[s.title, s.department].filter(Boolean).join(" · ")}</span>
                          <span className="mt-1 font-medium">
                            {s.n.toLocaleString()} {hasSel ? `${stagesLabel(p.stages)} publications` : "publications with a stage"},{" "}
                            {yearsLabel}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {TRANSLATIONAL_STAGES.map((k) => `${code(k)} ${s.counts[k]}`).join(" · ")}
                          </span>
                          {s.slug && (
                            <a href={profilePath(s.slug)} className="text-apollo-slate mt-1 self-start text-[13px] font-medium hover:underline">
                              Open profile
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="flex min-w-0 flex-[2_1_420px] flex-col gap-1.5 text-sm">
                        {s.works.map((w) => (
                          <WorkLine key={w.pmid} w={w} />
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!data.person && pages > 1 && (
            <nav aria-label="Pages" className="border-apollo-border flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3">
              <span className="text-muted-foreground grow text-xs">
                Page {p.page.toLocaleString()} of {pages.toLocaleString()}
              </span>
              {p.page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={href({ page: p.page - 1 }, "#items")}>Previous</Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  Previous
                </Button>
              )}
              {p.page < pages ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={href({ page: p.page + 1 }, "#items")}>Next</Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  Next
                </Button>
              )}
            </nav>
          )}
        </ReportCard>

        <aside className="bg-apollo-slate-tint border-apollo-slate-tint-border flex flex-col gap-1 rounded-xl border px-[18px] py-3.5" role="note">
          <span className="font-medium">How to read this</span>
          <span>
            ReCiterAI assigns a translational stage to each publication from its abstract or summary. Nobody reviews
            the stages by hand. A stage is shown only when the model was not unsure, so low-confidence records and
            those outside the spectrum are counted under No stage. The scholar list describes where someone&rsquo;s
            work sits, not its quality, and a later stage is not a better one.
          </span>
          <span className="text-muted-foreground text-xs">{COUNTING_RULE}</span>
          <a href={methodologyHref("translationalStage")} className="text-apollo-slate self-start font-medium hover:underline">
            How stages are defined
          </a>
        </aside>
      </div>
    ),
  };
}

/** One scholar: counts by stage (rows) and record type (Publications only in
 *  Step 1), and recent staged publications. Counts only, no percentages. */
function PersonView({ data, params, clearHref }: { data: PortfolioData; params: PortfolioParams; clearHref: string }) {
  const s = data.person!;
  const max = Math.max(1, ...STAGE_BUCKETS.map((k) => data.all[k]));
  return (
    <div className="border-apollo-border flex flex-col gap-3.5 border-t pt-4" data-testid="portfolio-person">
      <Link href={clearHref} className="text-apollo-slate min-h-8 self-start font-medium hover:underline">
        Back to scholars
      </Link>
      <div className="flex items-center gap-3">
        <HeadshotAvatar cwid={s.cwid} preferredName={s.name} size="lg" />
        <span className="flex flex-col gap-0.5">
          <span className="text-base font-semibold">{s.name}</span>
          <span className="text-apollo-ink-2 text-[13px]">
            {[s.title, s.department].filter(Boolean).join(" · ")} · <span className="font-mono">{s.cwid}</span>
          </span>
          {s.slug && (
            <a href={profilePath(s.slug)} className="text-apollo-slate self-start text-[13px] font-medium hover:underline">
              Open profile
            </a>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <table className="min-w-0 flex-[1_1_380px] border-collapse text-sm">
          <caption className="sr-only">
            {s.name}&rsquo;s first- or senior-author publications by stage, {params.from} to {params.to}
          </caption>
          <thead>
            <tr className="text-muted-foreground text-left text-xs">
              <th scope="col" className="py-1.5 font-normal">
                Stage
              </th>
              <th scope="col" className="py-1.5 font-normal">
                Publications
              </th>
            </tr>
          </thead>
          <tbody>
            {STAGE_BUCKETS.map((k) => (
              <tr key={k} className="border-apollo-border border-t">
                <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                  {k === "none" ? (
                    <span className="text-muted-foreground">{NO_STAGE_LABEL}</span>
                  ) : (
                    <>
                      <span className="font-semibold">{code(k)}</span>{" "}
                      <span className="text-muted-foreground">{TRANSLATIONAL_STAGE_LABELS[k]}</span>
                    </>
                  )}
                </th>
                <td className="w-1/2 py-2.5">
                  <span className="flex flex-col gap-1">
                    <span className="tabular-nums">{data.all[k].toLocaleString()}</span>
                    <ShareBar share={(data.all[k] / max) * 100} none={k === "none"} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-2 text-sm">
          <span className="text-muted-foreground text-xs tracking-[0.05em] uppercase">Recent publications</span>
          {s.works.length === 0 ? (
            <span className="text-muted-foreground">No staged first- or senior-author publications in this window.</span>
          ) : (
            s.works.map((w) => <WorkLine key={w.pmid} w={w} />)
          )}
        </div>
      </div>
    </div>
  );
}
