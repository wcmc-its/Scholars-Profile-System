/**
 * Report 26 — "Translational portfolio" body. Mockup: the Design canvas
 * "Translational portfolio: sidebar layout" (Main artboard; sample data only).
 * Publications only: the canvas's grant and trial columns, bars and toggles
 * wait for those records to carry a stage (plan
 * 2026-11-27-translational-portfolio-redesign-plan.md, PRs 4–6).
 *
 * Layout: the filter rail (`ReportLayout`; one GET `AutoSubmitForm`: scholar
 * lookup, years, org unit, research areas, and "On this page"), then the
 * active-filter chips, the summary tiles, "Stage mix over time" (a stacked
 * bar per year of the STAGED shares, with Stage assigned beside it), the unit
 * table, the Scholars / Publications list (or one scholar), and "How to read
 * this".
 *
 * Shares are among publications with a stage (`stagedShares`), so falling
 * coverage does not read as a shift between stages; Stage assigned shows the
 * coverage itself. A picked stage filters the lists and fades the other stages
 * in the charts; it never changes a count.
 *
 * Stage colours: one hue, light (T0) to dark (T3–4), because the stages are
 * ordered — this report's own palette. The shared `StageBadge` stays neutral.
 *
 * Server-rendered: every selection is a link or a GET form, so it lives in the
 * URL and the back button works. Printing (the Download menu's PDF) hides the
 * rail and the controls; the scholar list is left out of a printout when it is
 * over the export cap, as the spreadsheet leaves it out.
 * Loaders and params: `lib/edit/translational-portfolio-report.ts`.
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import { ArticleCitationList } from "@/components/edit/reports/article-citation-list";
import { toCitationRow } from "@/components/edit/reports/article-count-body";
import { SELECT } from "@/components/edit/reports/citation-report-parts";
import { CopyPmid } from "@/components/edit/reports/policy-citations-client";
import { RailChecklist, type RailChecklistOption } from "@/components/edit/reports/rail-checklist";
import { FilterChips, RailSection, ReportCard, ReportLayout, ReportRail, type FilterChip } from "@/components/edit/reports/report-ui";
import { PortfolioDownloadMenu, ScrollToHash } from "@/components/edit/reports/translational-portfolio-client";
import { PubTitle } from "@/components/publication/pub-html";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Button } from "@/components/ui/button";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { loadArticleList, NO_STAGE_LABEL } from "@/lib/edit/article-count-report";
import { loadPortfolioReachTile } from "@/lib/edit/downstream-reach-entry";
import type { AdminReportProps, ReportRender } from "@/lib/edit/report-registry";
import {
  activityListScope,
  COUNTING_RULE,
  countsIn,
  countsTotal,
  defaultYears,
  exactStagedShares,
  GAP_SHARE,
  loadPortfolio,
  loadPortfolioChoices,
  MIN_AREA_SIZE,
  MIN_SCHOLAR_ACTIVITIES,
  parsePortfolioParams,
  PORTFOLIO_PAGE_SIZE,
  portfolioQueryString,
  SCHOLAR_RULE,
  stageAssignedShare,
  stagedShares,
  stagedTotal,
  stagesLabel,
  TABLE_PREVIEW_ROWS,
  UNIT_TABS,
  type PortfolioData,
  type PortfolioParams,
  type RecentWork,
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

const H2 = "text-xl font-semibold";
const EYEBROW = "text-muted-foreground text-xs font-medium tracking-[0.05em] uppercase";
const LINK = "text-apollo-slate hover:underline";
/** The coverage (Stage assigned) bar: greige, never a stage colour. */
const COVERAGE = "#8a8178";

/** The stage palette: one hue, light to dark, with the ink that reads on it. */
const STAGE_FILL: Record<TranslationalStage, { bg: string; ink: string }> = {
  T0: { bg: "#c9d6e3", ink: "#1a1a1a" },
  T1: { bg: "#8fa8c2", ink: "#1a1a1a" },
  T2: { bg: "#4f6e8f", ink: "#ffffff" },
  "T3-4": { bg: "#34506e", ink: "#ffffff" },
};

const code = (s: TranslationalStage) => s.replace("-", "–");
const pct = (n: number) => `${Math.round(n)}%`;

function toSearchParams(sp: AdminReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

/** A stage code with its definition on hover and keyboard focus. */
function StageTerm({ k, children }: { k: TranslationalStage | "none"; children: React.ReactNode }) {
  const text = k === "none" ? NO_STAGE_DEFINITION : `${TRANSLATIONAL_STAGE_LABELS[k]}: ${stageDefinition(k)}`;
  return (
    <HoverTooltip text={text} wide>
      <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-[3px]">
        {children}
      </span>
    </HoverTooltip>
  );
}

/** A GET form that submits one URL: a toggle (`aria-pressed`) is a real
 *  button, so a stage pick is a button, not a link. */
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

function Segmented({ label, items }: { label: string; items: { key: string; label: string; href: string; on: boolean }[] }) {
  return (
    <nav aria-label={label} className="bg-apollo-surface-2 border-apollo-border-strong flex flex-wrap gap-0.5 rounded-[10px] border p-[3px] print:hidden">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.on ? "page" : undefined}
          className={cn(
            "flex min-h-9 items-center rounded-[7px] px-3 text-[13px]",
            t.on ? "bg-apollo-surface text-foreground font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
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
    <div className="bg-apollo-surface border-apollo-border flex flex-col gap-1.5 rounded-xl border p-4">
      <span className="text-muted-foreground text-xs leading-[1.35] font-medium tracking-[0.05em] uppercase">{label}</span>
      <span className="text-[30px] leading-[1.15] font-semibold tracking-[-0.025em] tabular-nums">{value}</span>
      <span className="text-muted-foreground text-[13px]">{sub}</span>
    </div>
  );
}

/** A thin bar for a share (0–100), optionally with a tick at another share. */
function ThinBar({ share, color, tick, faded }: { share: number; color: string; tick?: number; faded?: boolean }) {
  return (
    <span className="bg-apollo-surface-2 relative mt-1 block h-1 rounded-sm" aria-hidden>
      <span className={cn("block h-1 rounded-sm", faded && "opacity-35")} style={{ width: `${Math.min(100, share)}%`, background: color }} />
      {tick !== undefined && (
        <span className="absolute -top-1 -ml-px h-3 w-0.5 rounded-[1px] bg-[#2a2421]" style={{ left: `${Math.min(100, tick)}%` }} />
      )}
    </span>
  );
}

/** The staged shares of one row as a stacked bar, labels on segments ≥ 7%. */
function MixBar({ counts, picked, height = 28, labels = true }: { counts: StageCounts; picked: readonly TranslationalStage[]; height?: number; labels?: boolean }) {
  const ex = exactStagedShares(counts);
  const shown = stagedShares(counts);
  return (
    <span className="flex gap-0.5 overflow-hidden rounded bg-white" style={{ height }} aria-hidden>
      {TRANSLATIONAL_STAGES.filter((k) => ex[k] > 0).map((k) => (
        <span
          key={k}
          className="relative flex items-center justify-center text-xs font-medium tabular-nums"
          style={{ width: `${ex[k]}%`, color: picked.length > 0 && !picked.includes(k) ? "#1a1a1a" : STAGE_FILL[k].ink }}
        >
          {/* The fill fades for an unpicked stage; the label does not. */}
          <span
            className={cn("absolute inset-0", picked.length > 0 && !picked.includes(k) && "opacity-35")}
            style={{ background: STAGE_FILL[k].bg }}
          />
          {labels && ex[k] >= 7 ? <span className="relative">{shown[k]}%</span> : null}
        </span>
      ))}
    </span>
  );
}

/** A paper's stage as a two-part tag in the stage's colour: code, then name. */
function StageTag({ stage }: { stage: TranslationalStage }) {
  const f = STAGE_FILL[stage];
  return (
    <span className="inline-flex items-stretch overflow-hidden rounded-full border text-xs leading-normal" style={{ borderColor: f.bg }}>
      <span className="px-2 py-px font-semibold" style={{ background: f.bg, color: f.ink }}>
        {code(stage)}
      </span>
      <span className="text-apollo-ink-2 bg-white px-2 py-px">{TRANSLATIONAL_STAGE_LABELS[stage]}</span>
    </span>
  );
}

/** One recent paper: the "Paper" label, its title, then stage, year and PMID. */
function WorkItem({ w }: { w: RecentWork }) {
  const pubmed = `https://pubmed.ncbi.nlm.nih.gov/${w.pmid}/`;
  return (
    <li className="grid grid-cols-[56px_minmax(0,1fr)] items-start gap-3">
      <span className="text-muted-foreground pt-px text-xs font-medium">Paper</span>
      <span className="flex min-w-0 flex-col gap-1.5">
        <a href={pubmed} target="_blank" rel="noopener noreferrer" className="text-foreground text-[13px] leading-[1.45] hover:underline">
          <PubTitle value={w.title.trim().replace(/\.+$/, "")} />
        </a>
        <span className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
          <StageTag stage={w.stage} />
          <span className="tabular-nums">{w.year}</span>
          <span aria-hidden className="text-[#b8afa6]">
            ·
          </span>
          <span className="inline-flex items-center gap-0.5 tabular-nums">
            PMID{" "}
            <a href={pubmed} target="_blank" rel="noopener noreferrer" className={cn(LINK, "ml-0.5")}>
              {w.pmid}
            </a>
            <span className="print:hidden">
              <CopyPmid pmid={w.pmid} />
            </span>
          </span>
        </span>
      </span>
    </li>
  );
}

/** "Papers by stage": four columns, a swatch and the count ("–" for none). */
function StageCountColumns({ counts }: { counts: StageCounts }) {
  return (
    <span className="grid grid-cols-4 gap-2" aria-hidden>
      {TRANSLATIONAL_STAGES.map((k) => {
        const n = counts[k];
        return (
          <span key={k} className="flex flex-col gap-px">
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <span className={cn("size-2 rounded-[2px]", n === 0 && "opacity-40")} style={{ background: STAGE_FILL[k].bg }} />
              {code(k)}
            </span>
            <span className={cn("text-[15px] leading-[1.3] tabular-nums", n > 0 ? "text-foreground font-semibold" : "text-[#6f6a5e]")}>
              {n > 0 ? n.toLocaleString() : "–"}
            </span>
          </span>
        );
      })}
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

  const href = (q: Partial<PortfolioParams>, hash = "") => `${basePath}?${portfolioQueryString({ ...p, page: 1, ...q })}${hash}`;
  const hasSel = p.stages.length > 0;
  const total = countsTotal(data.all);
  const first = data.byYear[0]?.counts;
  const last = data.byYear[data.byYear.length - 1]?.counts;
  const yearsLabel = p.from === p.to ? String(p.from) : `${p.from} to ${p.to}`;
  const shareIn = (c: StageCounts | undefined, ks: readonly TranslationalStage[]) =>
    c ? ks.reduce((n, k) => n + exactStagedShares(c)[k], 0) : 0;
  const thenNow = (a: number, b: number) => (p.from === p.to ? `${pct(b)} in ${p.to}` : `${pct(a)} in ${p.from} → ${pct(b)} in ${p.to}`);

  const unitName = p.units.map((u) => choices.labels.get(u) ?? u).join(", ");
  const areaLabel = new Map(choices.areas.map((a) => [a.id, a.label]));
  const defaults = defaultYears();

  // The active filters, each removable where it has a default to fall back to.
  const chips: FilterChip[] = [
    ...(p.cwid
      ? [{ group: "Scholar", value: data.person?.name ?? "Unknown scholar", mono: p.cwid, removeHref: href({ cwid: null }) }]
      : []),
    { group: "Unit", value: unitName || "All of Weill Cornell Medicine", removeHref: p.units.length > 0 ? href({ units: [] }) : null },
    {
      group: "Years",
      value: yearsLabel,
      removeHref: p.from !== defaults.from || p.to !== defaults.to ? href({ from: defaults.from, to: defaults.to }) : null,
    },
    ...(p.areas.length === 0
      ? [{ group: "Area", value: "All", removeHref: null }]
      : p.areas.map((a) => ({ group: "Area", value: areaLabel.get(a) ?? a, removeHref: href({ areas: p.areas.filter((x) => x !== a) }) }))),
    ...p.stages.map((s) => ({ group: "Stage", value: code(s), removeHref: href({ stages: p.stages.filter((x) => x !== s) }) })),
  ];
  const resetHref = basePath;

  // The rail.
  const unitOptions: RailChecklistOption[] = [
    { value: "", label: "All of Weill Cornell Medicine" },
    ...choices.facets.departments.map((d) => ({ value: d.value, label: d.label })),
    ...choices.facets.departments.flatMap((d) => d.divisions.map((v) => ({ value: v.value, label: v.label }))),
    ...choices.facets.centers.filter((c) => c.count > 0 || p.units.includes(c.value)).map((c) => ({ value: c.value, label: c.label })),
  ];
  // Research areas: the ones in scope first, by volume, then the rest by name.
  const inScope = new Set(data.areaOrder);
  const areaOptions: RailChecklistOption[] = [
    ...data.areaOrder.map((id) => ({ value: id, label: areaLabel.get(id) ?? id })),
    ...choices.areas.filter((a) => !inScope.has(a.id)).map((a) => ({ value: a.id, label: a.label })),
  ];
  const years = Array.from({ length: 40 }, (_, i) => new Date().getUTCFullYear() - i);
  const gapCount = data.areaCoverage.sized - data.areaCoverage.spanning;
  const rail = (
    <ReportRail
      resetHref={chips.some((c) => c.removeHref !== null) ? resetHref : null}
      resetLabel="Clear all"
      help="Filters apply automatically."
      className="print:hidden"
      testId="portfolio-rail"
    >
      <AutoSubmitForm action={basePath} className="group" data-testid="portfolio-filters">
        {p.stages.map((s) => (
          <input key={s} type="hidden" name="stage" value={s} />
        ))}
        {p.by !== "dept" && <input type="hidden" name="by" value={p.by} />}
        {p.view !== "scholars" && <input type="hidden" name="view" value={p.view} />}
        {p.cwid && <input type="hidden" name="cwid" value={p.cwid} />}
        {p.allRows && <input type="hidden" name="rows" value="all" />}
        {/* A link with several units keeps them all through a rail change; the
            radio list shows the first (see the note under it). */}
        {p.units.slice(1).map((u) => (
          <input key={u} type="hidden" name="unit" value={u} />
        ))}
        <RailSection label="Scholar" summary={data.person?.name ?? "Anyone"} defaultOpen testId="portfolio-rail-scholar">
          <input
            type="search"
            name="q"
            defaultValue={p.q}
            placeholder="Search by name or CWID…"
            aria-label="Look up a scholar by name or CWID"
            autoComplete="off"
            className="border-apollo-border-strong bg-apollo-surface h-10 w-full rounded-lg border px-3 text-[15px]"
          />
        </RailSection>
        <RailSection label="Publication year" summary={`${yearsLabel} · Calendar`} defaultOpen testId="portfolio-rail-years">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <select name="from" defaultValue={p.from} aria-label="From year" className={SELECT}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground text-[13px]">to</span>
            <select name="to" defaultValue={p.to} aria-label="To year" className={SELECT}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </RailSection>
        <RailSection label="Org unit" summary={unitName || "All of Weill Cornell Medicine"} defaultOpen testId="portfolio-rail-unit">
          <RailChecklist
            name="unit"
            single
            roomy
            options={unitOptions}
            selected={[p.units[0] ?? ""]}
            searchPlaceholder="Search org units…"
            collapseAfter={6}
          />
          {p.units.length > 1 && (
            <p className="text-muted-foreground text-xs" data-testid="portfolio-rail-units-note">
              This link selects {p.units.length} units: {unitName}.{" "}
              <Link href={href({ units: [p.units[0]] })} className={LINK}>
                Use one
              </Link>
            </p>
          )}
        </RailSection>
        <RailSection
          label="Research area"
          summary={p.areas.length === 0 ? "All research areas" : p.areas.length <= 2 ? p.areas.map((a) => areaLabel.get(a) ?? a).join(", ") : `${p.areas.length} selected`}
          defaultOpen
          testId="portfolio-rail-area"
        >
          <RailChecklist name="area" roomy options={areaOptions} selected={p.areas} searchPlaceholder="Search research areas…" collapseAfter={5} />
          <p className="text-muted-foreground text-xs">None checked = all. A publication in any checked area counts.</p>
          {p.by === "area" && (
            <label className="border-apollo-rail-border flex cursor-pointer items-center justify-between gap-3 border-t pt-2.5 text-sm">
              Only areas with a gap
              <input type="checkbox" name="gaps" value="1" defaultChecked={p.gaps} className="accent-apollo-maroon size-4" data-testid="portfolio-rail-gaps" />
            </label>
          )}
        </RailSection>
        {/* No-JS fallback (and Enter in the lookup box); hidden once hydrated. */}
        <div className="px-[18px] pb-4 group-data-[hydrated=true]:hidden">
          <button type="submit" className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm">
            Apply
          </button>
        </div>
      </AutoSubmitForm>
      <nav aria-label="On this page" className="border-apollo-rail-border flex flex-col gap-0.5 border-t px-3 pt-[18px] pb-6">
        <span className={cn(EYEBROW, "mx-2 mb-2 tracking-[0.08em]")}>On this page</span>
        {[
          ["#portfolio-summary", "Summary"],
          ["#stages", "Over time"],
          ["#units", p.units.length > 0 ? "Inside this unit" : "By unit or research area"],
          ["#items", "Scholars and publications"],
          ["#howto", "How to read this"],
        ].map(([to, label]) => (
          <a key={to} href={to} className="hover:bg-apollo-rail-hover text-apollo-ink-2 block rounded-md px-3 py-2 text-sm">
            {label}
          </a>
        ))}
      </nav>
    </ReportRail>
  );

  // Stage mix over time: a row per year, then all of WCM for comparison on a
  // unit view. The baseline keeps the scholar filter, so with a scholar picked
  // it is that scholar outside the unit, not all of WCM: show all years instead.
  const wcmBaseline = p.units.length > 0 && !p.cwid;
  const mixRows: { label: string; counts: StageCounts; base?: boolean }[] = [
    ...data.byYear.map((r) => ({ label: String(r.year), counts: r.counts })),
    wcmBaseline ? { label: "All of WCM", counts: data.baseline, base: true } : { label: "All years", counts: data.all, base: true },
  ];
  const mixAria = (c: StageCounts) => {
    if (stagedTotal(c) === 0) return "No publications with a stage";
    const s = stagedShares(c);
    return `${TRANSLATIONAL_STAGES.map((k) => `${code(k)} ${s[k]}%`).join(", ")}; stage assigned ${pct(stageAssignedShare(c))}`;
  };

  // The unit table.
  const tab = UNIT_TABS[p.by];
  const overall = exactStagedShares(data.all);
  const scopeName = unitName || "Weill Cornell Medicine";
  const tableRows = p.allRows ? data.table : data.table.slice(0, TABLE_PREVIEW_ROWS);
  const rowNoun = tab.label.toLowerCase();
  const sortNote = hasSel ? `sorted by share in ${stagesLabel(p.stages)}` : p.by === "area" ? "sorted by thinnest stage" : "sorted by volume";
  const cellLink = (k: TranslationalStage, rowHref: string) => {
    const q = new URLSearchParams(rowHref);
    q.delete("stage");
    q.append("stage", k);
    q.delete("view");
    q.delete("page");
    return `${basePath}?${q}#items`;
  };

  // The list.
  const listTotal = p.view === "scholars" ? data.scholars.total : data.activities.total;
  const pages = Math.max(1, Math.ceil(listTotal / PORTFOLIO_PAGE_SIZE));
  const fromN = listTotal === 0 ? 0 : (p.page - 1) * PORTFOLIO_PAGE_SIZE + 1;
  const toN = Math.min(listTotal, p.page * PORTFOLIO_PAGE_SIZE);
  const noun = p.view === "scholars" ? "scholars" : "publications";
  const rangeLabel =
    listTotal === 0 ? `No ${noun} match` : `${fromN.toLocaleString()} to ${toN.toLocaleString()} of ${listTotal.toLocaleString()}`;
  const searchHref = (() => {
    const q = new URLSearchParams({ type: "publications", yearMin: String(p.from), yearMax: String(p.to) });
    for (const s of p.stages) q.append("translationalStage", s);
    return `/search?${q}`;
  })();
  // Policy: a scholar list over the export cap is never printed (the spreadsheet omits it too).
  const printScholars = data.scholars.total <= SCHOLAR_EXPORT_CAP;

  return {
    subtitle: (
      <p className="text-muted-foreground max-w-[720px] text-sm">
        Where WCM publications sit between basic research and population health, and who does the work.
      </p>
    ),
    aside: (
      <div className="print:hidden">
        <PortfolioDownloadMenu xlsxHref={`/api/edit/reports/translational-portfolio?${portfolioQueryString({ ...p, page: 1 })}`} />
      </div>
    ),
    main: (
      <div className="[print-color-adjust:exact]" data-testid="portfolio-report">
        <ScrollToHash />
        <ReportLayout rail={rail}>
          <div className="flex min-w-0 flex-col gap-6">
            <div className="lg:hidden print:hidden">
              <FiltersSheet activeCount={chips.filter((c) => c.removeHref !== null).length} testId="portfolio-filters-sheet">
                {rail}
              </FiltersSheet>
            </div>

            <div id="portfolio-summary" className="bg-apollo-surface border-apollo-border flex scroll-mt-24 flex-wrap items-center gap-2 rounded-[10px] border px-3 py-2.5" data-testid="portfolio-scope">
              <span className="text-muted-foreground mr-1 text-[13px]">Showing</span>
              <FilterChips chips={chips} testId="portfolio-chips" />
            </div>

            {p.q && !p.cwid && (
              <div className="bg-apollo-surface border-apollo-border max-w-[480px] rounded-xl border p-1 print:hidden" data-testid="portfolio-lookup">
                {data.lookup.length === 0 ? (
                  <p className="text-muted-foreground px-3 py-2 text-sm">No active scholar matches &ldquo;{p.q}&rdquo;.</p>
                ) : (
                  <ul className="m-0 list-none p-0">
                    {data.lookup.map((s) => (
                      <li key={s.cwid}>
                        <Link href={href({ cwid: s.cwid, q: "" }, "#items")} className="hover:bg-apollo-surface-2 flex min-h-12 items-center gap-2.5 rounded-lg px-2 py-1">
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

            {/* Summary tiles: every number opens the list it counts. */}
            <section aria-label="Summary" className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3" data-testid="portfolio-tiles">
              <Tile
                label={hasSel ? `Publications in ${stagesLabel(p.stages)}, ${yearsLabel}` : `Publications, ${yearsLabel}`}
                value={
                  <Link href={href({ view: "activities" }, "#items")} className="hover:underline">
                    {(hasSel ? countsIn(data.all, p.stages) : total).toLocaleString()}
                  </Link>
                }
                sub={`${pct(stageAssignedShare(data.all))} have a stage`}
              />
              {data.areaCoverage.sized > 0 && (
              <Tile
                label="Areas spanning T0 to T3–4"
                value={
                  <Link href={href({ by: "area", gaps: false, allRows: true }, "#units")} className="hover:underline">
                    {data.areaCoverage.spanning} of {data.areaCoverage.sized}
                  </Link>
                }
                sub={
                  gapCount > 0 ? (
                    <Link href={href({ by: "area", gaps: true, allRows: true }, "#units")} className={LINK}>
                      See the {gapCount} with a gap
                    </Link>
                  ) : (
                    `Research areas with ${MIN_AREA_SIZE} or more publications with a stage`
                  )
                }
              />
              )}
              {reach && reach.total > 0 && (
                <Tile
                  label="T0 and T1 later cited by clinical studies"
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
                  sub="Clinical studies by a publication's own authors are not counted."
                />
              )}
            </section>

            {/* Stage mix over time. */}
            <section id="stages" aria-labelledby="stages-h" className="bg-apollo-surface border-apollo-border flex scroll-mt-24 flex-col gap-[18px] rounded-xl border px-6 py-5 print:break-inside-avoid">
              <div className="flex flex-col gap-1">
                <h2 id="stages-h" className={H2}>
                  Stage mix over time
                </h2>
                <span className="text-muted-foreground text-[13px]">
                  Among publications with a stage, so each year adds up to 100%. How many have a stage is on the right.
                </span>
              </div>
              <div role="group" aria-label="Focus on a stage" className="-mt-1.5 flex flex-wrap gap-x-1 gap-y-0.5" data-testid="portfolio-stage-focus">
                {TRANSLATIONAL_STAGES.map((k) => {
                  const on = p.stages.includes(k);
                  const next = on ? p.stages.filter((s) => s !== k) : TRANSLATIONAL_STAGES.filter((s) => s === k || p.stages.includes(s));
                  return (
                    <QueryButton
                      key={k}
                      action={`${basePath}#stages`}
                      qs={portfolioQueryString({ ...p, stages: next, page: 1 })}
                      pressed={on}
                      label={`${code(k)} ${TRANSLATIONAL_STAGE_LABELS[k]}. ${on ? "Stop focusing on this stage." : "Focus on this stage."}`}
                      className={cn(
                        "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 text-[13px]",
                        on ? "bg-apollo-slate-tint ring-apollo-slate ring-1" : "hover:bg-apollo-surface-2",
                        hasSel && !on && "opacity-60",
                      )}
                    >
                      <span className="size-3 rounded-[3px]" style={{ background: STAGE_FILL[k].bg }} aria-hidden />
                      <span className="font-medium">{code(k)}</span>
                      <span className="text-muted-foreground">{TRANSLATIONAL_STAGE_LABELS[k]}</span>
                    </QueryButton>
                  );
                })}
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
                <div className="bg-apollo-surface-2 flex flex-col gap-0.5 rounded-lg px-3.5 py-3">
                  <span className={EYEBROW}>{hasSel ? stagesLabel(p.stages) : "T2 and T3–4"}, of staged publications</span>
                  <span className="text-[22px] font-semibold tracking-[-0.025em] tabular-nums">
                    {thenNow(shareIn(first, hasSel ? p.stages : ["T2", "T3-4"]), shareIn(last, hasSel ? p.stages : ["T2", "T3-4"]))}
                  </span>
                  <span className="text-muted-foreground text-[13px]">Shares leave out publications with no stage.</span>
                </div>
                <div className="bg-apollo-surface-2 flex flex-col gap-0.5 rounded-lg px-3.5 py-3">
                  <span className={EYEBROW}>Publications with a stage</span>
                  <span className="text-[22px] font-semibold tracking-[-0.025em] tabular-nums">
                    {thenNow(first ? stageAssignedShare(first) : 0, last ? stageAssignedShare(last) : 0)}
                  </span>
                  <span className="text-muted-foreground text-[13px]">Read year-on-year changes in the mix against this.</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <div role="table" aria-label="Stage mix by year" className="flex min-w-[400px] flex-col gap-1.5 sm:min-w-[560px]" data-testid="portfolio-stage-rows">
                  <div role="row" className={cn(EYEBROW, "grid grid-cols-[48px_minmax(0,1fr)_112px] sm:grid-cols-[96px_minmax(0,1fr)_180px] gap-4")}>
                    <span role="columnheader">Year</span>
                    <span role="columnheader">Share of staged publications</span>
                    <span role="columnheader">Stage assigned</span>
                  </div>
                  {mixRows.map((r) => {
                    const cov = stageAssignedShare(r.counts);
                    return (
                      <div key={r.label} role="row" className={cn("grid grid-cols-[48px_minmax(0,1fr)_112px] sm:grid-cols-[96px_minmax(0,1fr)_180px] items-center gap-4", r.base && "mt-2.5")}>
                        <span role="rowheader" className={cn("text-[13px] tabular-nums", r.base && "font-medium")}>
                          {r.label}
                        </span>
                        <span role="cell" aria-label={mixAria(r.counts)}>
                          {stagedTotal(r.counts) > 0 ? (
                            <MixBar counts={r.counts} picked={p.stages} />
                          ) : (
                            <span className="text-muted-foreground text-[13px]">No publications with a stage</span>
                          )}
                        </span>
                        <span role="cell" className="flex items-center gap-2.5">
                          <span className="bg-apollo-surface-2 h-1.5 grow rounded-[3px]" aria-hidden>
                            <span className="block h-1.5 rounded-[3px]" style={{ width: `${cov}%`, background: COVERAGE }} />
                          </span>
                          <span className="w-10 text-right text-[13px] tabular-nums">{countsTotal(r.counts) > 0 ? pct(cov) : "–"}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <p className="text-muted-foreground text-xs">
                Select a stage in the key to focus on it: the chart and table fade the other stages, and the lists below
                filter to it.{" "}
                {wcmBaseline
                  ? "The bottom row is all of Weill Cornell Medicine for the same years, for comparison."
                  : "The bottom row is every year together."}
              </p>
            </section>

            {/* The unit / research area table. */}
            <ReportCard className="flex scroll-mt-24 flex-col gap-3 px-6 py-5 sm:px-6 sm:py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h2 className={cn(H2, "scroll-mt-24")} id="units">
                    {p.units.length > 0 ? `Inside ${unitName}` : "By unit or research area"}
                  </h2>
                  <span className="text-muted-foreground text-[13px]">
                    Publications, {yearsLabel}, {sortNote}. Shares are of publications with a stage, as in Stage mix above.
                    {p.by === "div" && " A division's row counts its members, including hand-added ones."}
                    {p.by === "center" && " Center activities also count toward their members' departments, so rows here overlap."}
                  </span>
                </div>
                <Segmented
                  label="Break down by"
                  items={(Object.keys(UNIT_TABS) as UnitTab[]).map((k) => ({ key: k, label: UNIT_TABS[k].label, href: href({ by: k, gaps: false, allRows: false }, "#units"), on: p.by === k }))}
                />
              </div>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden className="bg-apollo-surface-2 relative inline-block h-1 w-7 rounded-sm">
                    <span className="absolute -top-1 left-3 h-3 w-0.5 rounded-[1px] bg-[#2a2421]" />
                  </span>
                  {scopeName} overall
                </span>
                {p.by === "area" && (
                  <span className="inline-flex items-center gap-1.5">
                    <GapTag />
                    under {GAP_SHARE}% of an area&rsquo;s staged publications, for areas with {MIN_AREA_SIZE} or more
                  </span>
                )}
              </div>
              <div className="border-apollo-border overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[820px] border-collapse text-[13px]" data-testid="portfolio-table">
                  <caption className="sr-only">
                    Share of publications with a stage, by translational stage, by {tab.head.toLowerCase()}. {COUNTING_RULE}
                  </caption>
                  <thead>
                    <tr className="bg-apollo-surface-2 text-muted-foreground text-left text-xs">
                      <th scope="col" className="px-3 py-2.5 font-medium tracking-[0.05em] uppercase">
                        {tab.head}
                      </th>
                      <th scope="col" className="px-2.5 py-2.5 text-right font-medium tracking-[0.03em] whitespace-nowrap uppercase">
                        Publications
                      </th>
                      <th scope="col" className="px-2.5 py-2.5 font-medium tracking-[0.05em] uppercase">
                        <StageTerm k="none">Stage assigned</StageTerm>
                      </th>
                      {TRANSLATIONAL_STAGES.map((k) => (
                        <th key={k} scope="col" className={cn("px-2.5 py-2.5", p.stages.includes(k) ? "text-foreground font-semibold" : "font-medium")}>
                          <StageTerm k={k}>{code(k)}</StageTerm>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => {
                      const shares = stagedShares(r.counts);
                      const ex = exactStagedShares(r.counts);
                      const staged = stagedTotal(r.counts) > 0;
                      const cov = stageAssignedShare(r.counts);
                      return (
                        <tr key={r.key} className="border-apollo-border border-t">
                          <th scope="row" className="px-3 py-2.5 text-left font-normal">
                            <Link href={`${basePath}?${r.href}`} className={cn(LINK, "block")}>
                              {r.label}
                            </Link>
                            {r.note &&
                              (r.noteHref ? (
                                <Link href={`${basePath}?${r.noteHref}#items`} aria-label={`View ${r.note} in ${r.label}`} className={cn(LINK, "text-xs")}>
                                  {r.note}
                                </Link>
                              ) : (
                                <span className="text-muted-foreground text-xs">{r.note}</span>
                              ))}
                          </th>
                          <td className="px-3 py-2.5 text-right tabular-nums">{countsTotal(r.counts).toLocaleString()}</td>
                          <td className="min-w-[92px] px-2.5 py-2.5">
                            <span className="block tabular-nums">{pct(cov)}</span>
                            <ThinBar share={cov} color={COVERAGE} />
                          </td>
                          {TRANSLATIONAL_STAGES.map((k) => {
                            const gap = r.gaps.includes(k);
                            const fig = staged ? `${shares[k]}%` : "–";
                            return (
                              <td key={k} className={cn("min-w-[92px] px-2.5 py-2.5", gap && "bg-apollo-page")}>
                                <span className="flex items-center gap-1.5 tabular-nums">
                                  {staged ? (
                                    <Link
                                      href={cellLink(k, r.href)}
                                      aria-label={`${fig} in ${code(k)}${gap ? ", a gap" : ""}, ${r.label}. Show scholars.`}
                                      className={cn("hover:underline", p.stages.includes(k) && "font-semibold")}
                                    >
                                      {fig}
                                    </Link>
                                  ) : (
                                    <span className="text-muted-foreground">{fig}</span>
                                  )}
                                  {gap && <GapTag />}
                                </span>
                                <ThinBar share={ex[k]} color="#34506e" tick={overall[k]} faded={hasSel && !p.stages.includes(k)} />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {data.table.length === 0 ? (
                <p className="text-muted-foreground text-sm">No {rowNoun} have publications in this scope.</p>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground text-[13px]">
                    Showing {tableRows.length.toLocaleString()} of {data.table.length.toLocaleString()} {rowNoun}
                    {p.gaps && p.by === "area" ? " with a gap" : ""}
                  </span>
                  {data.table.length > TABLE_PREVIEW_ROWS && (
                    <Button asChild variant="outline" size="sm" className="print:hidden">
                      <Link href={href({ allRows: !p.allRows }, "#units")} data-testid="portfolio-table-all">
                        {p.allRows ? "Show fewer" : `View all ${data.table.length.toLocaleString()} ${rowNoun}`}
                      </Link>
                    </Button>
                  )}
                </div>
              )}
            </ReportCard>

            {/* The list. */}
            <ReportCard className="flex scroll-mt-24 flex-col gap-1 px-6 py-5 sm:px-6 sm:py-5">
              <div id="items" className="mb-2 flex scroll-mt-24 flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h2 className={H2}>
                    {data.person
                      ? `${data.person.name}: translational profile`
                      : p.view === "scholars"
                        ? `Scholars${unitName ? ` in ${unitName}` : ""}${hasSel ? ` with ${stagesLabel(p.stages)} work` : ""}`
                        : `Publications${hasSel ? ` in ${stagesLabel(p.stages)}` : ""}${unitName ? `, ${unitName}` : ""}`}
                  </h2>
                  <span className="text-muted-foreground text-[13px]">
                    {data.person
                      ? SCHOLAR_RULE
                      : p.view === "scholars"
                        ? `First or senior author, at least ${MIN_SCHOLAR_ACTIVITIES} staged publications, ordered by count. ${rangeLabel}.`
                        : `Newest first. ${rangeLabel}.`}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  {!data.person && (
                    <Segmented
                      label="List"
                      items={[
                        { key: "scholars", label: "Scholars", href: href({ view: "scholars" }, "#items"), on: p.view === "scholars" },
                        { key: "activities", label: "Publications", href: href({ view: "activities" }, "#items"), on: p.view === "activities" },
                      ]}
                    />
                  )}
                  <a href={searchHref} className={cn(LINK, "text-[13px] print:hidden")}>
                    Open in Scholars search
                  </a>
                </div>
              </div>

              {!data.person && (
                <div className="bg-apollo-surface-2 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3.5 py-3 print:hidden" data-testid="portfolio-list-stages">
                  <span id="list-stage-label" className="text-[13px] font-medium">
                    Stage
                  </span>
                  <div role="group" aria-labelledby="list-stage-label" className="flex flex-wrap gap-1.5">
                    {TRANSLATIONAL_STAGES.map((k) => {
                      const on = p.stages.includes(k);
                      const next = on ? p.stages.filter((s) => s !== k) : TRANSLATIONAL_STAGES.filter((s) => s === k || p.stages.includes(s));
                      return (
                        <QueryButton
                          key={k}
                          action={`${basePath}#items`}
                          qs={portfolioQueryString({ ...p, stages: next, page: 1 })}
                          pressed={on}
                          label={`${code(k)} ${TRANSLATIONAL_STAGE_LABELS[k]}`}
                          className={cn(
                            "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px]",
                            on ? "bg-apollo-slate-tint border-apollo-slate" : "bg-apollo-surface border-apollo-border-strong hover:bg-apollo-page",
                          )}
                        >
                          <span aria-hidden className="size-2 rounded-[2px]" style={{ background: STAGE_FILL[k].bg }} />
                          {code(k)}
                        </QueryButton>
                      );
                    })}
                  </div>
                  <span className="text-muted-foreground text-xs">Filters the lists; the charts above highlight it. None selected means every stage.</span>
                </div>
              )}

              {data.person ? (
                <PersonView data={data} params={p} clearHref={href({ cwid: null }, "#items")} />
              ) : p.view === "activities" ? (
                <ArticleCitationList
                  rows={articles.map((a) => ({ ...toCitationRow(a), stage: a.stage, stageConfidence: a.stageConfidence }))}
                  rangeLabel={rangeLabel}
                />
              ) : (
                <div data-testid="portfolio-scholars">
                  {!printScholars && (
                    <p className="text-muted-foreground hidden py-2 text-sm print:block">
                      The scholar list is left out of printouts over {SCHOLAR_EXPORT_CAP} scholars. Narrow the filters to include it.
                    </p>
                  )}
                  {data.scholars.rows.length === 0 ? (
                    <p className="text-muted-foreground border-apollo-border border-t py-4">
                      No scholars have {MIN_SCHOLAR_ACTIVITIES} or more first- or senior-author publications for this combination.
                    </p>
                  ) : (
                    <ul className={cn("m-0 list-none p-0", !printScholars && "print:hidden")}>
                      {data.scholars.rows.map((s) => (
                        <ScholarRow key={s.cwid} s={s} hasSel={hasSel} stages={p.stages} portfolioHref={href({ cwid: s.cwid }, "#items")} />
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {!data.person && pages > 1 && (
                <p className="text-muted-foreground hidden pt-2 text-xs print:block">
                  This printout holds page {p.page.toLocaleString()} of {pages.toLocaleString()} of the list.
                </p>
              )}
              {!data.person && pages > 1 && (
                <nav aria-label="Pages" className="border-apollo-border flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3.5 print:hidden">
                  <span className="text-muted-foreground grow text-[13px]">
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

            <section
              id="howto"
              aria-labelledby="howto-h"
              className="bg-apollo-slate-tint border-apollo-slate-tint-border flex scroll-mt-24 flex-col gap-2 rounded-xl border px-6 py-[18px]"
            >
              <h2 id="howto-h" className="text-base font-semibold">
                How to read this
              </h2>
              <p className="text-sm leading-[1.625]">
                ReCiterAI assigns a translational stage to each publication from its abstract or summary. Nobody reviews
                the stages by hand. A stage is shown only when the model was not unsure, so low-confidence records and
                those outside the spectrum have no stage. Shares are among publications with a stage; Stage assigned
                shows how many have one. The scholar list describes where someone&rsquo;s work sits, not its quality, and
                a later stage is not a better one.
              </p>
              <p className="text-muted-foreground text-xs">{COUNTING_RULE}</p>
              <a href={methodologyHref("translationalStage")} className={cn(LINK, "self-start text-[13px] font-medium print:hidden")}>
                How stages are defined
              </a>
            </section>
          </div>
        </ReportLayout>
      </div>
    ),
  };
}

/** The dashed "Gap" marker in a stage cell and the table's key. */
function GapTag() {
  return (
    <span className="text-muted-foreground rounded border border-dashed border-[#8a8178] px-[5px] text-[11px] leading-4 font-medium tracking-[0.05em] uppercase">
      Gap
    </span>
  );
}

function ScholarRow({
  s,
  hasSel,
  stages,
  portfolioHref,
}: {
  s: PortfolioData["scholars"]["rows"][number];
  hasSel: boolean;
  stages: readonly TranslationalStage[];
  portfolioHref: string;
}) {
  const ex = exactStagedShares(s.counts);
  return (
    <li className="border-apollo-border flex flex-wrap gap-x-10 gap-y-4 border-t py-[18px] print:break-inside-avoid" data-testid="portfolio-scholar">
      <div className="flex min-w-0 flex-[1_1_300px] gap-3">
        <HeadshotAvatar cwid={s.cwid} preferredName={s.name} size="md" />
        <div className="flex min-w-0 grow flex-col gap-0.5">
          <Link href={portfolioHref} className={cn(LINK, "text-sm font-medium")}>
            {s.name}
          </Link>
          <span className="text-muted-foreground text-xs">{[s.title, s.department].filter(Boolean).join(" · ")}</span>
          <div className="mt-2.5 flex max-w-[280px] flex-col gap-1.5">
            <span className="text-[13px]">
              <span className="font-semibold tabular-nums">{s.n.toLocaleString()}</span>{" "}
              {hasSel ? `${stagesLabel(stages)} papers` : "staged papers"}
            </span>
            <span
              role="img"
              aria-label={TRANSLATIONAL_STAGES.map((k) => `${code(k)} ${s.counts[k]}`).join(", ")}
              className="bg-apollo-surface-2 flex h-2 gap-0.5 overflow-hidden rounded"
            >
              {TRANSLATIONAL_STAGES.filter((k) => s.counts[k] > 0).map((k) => (
                <span
                  key={k}
                  className={cn(hasSel && !stages.includes(k) && "opacity-35")}
                  style={{ width: `${ex[k]}%`, background: STAGE_FILL[k].bg }}
                />
              ))}
            </span>
            <span className={cn(EYEBROW, "mt-1.5 text-[11px]")}>Papers by stage</span>
            <StageCountColumns counts={s.counts} />
            <Link
              href={portfolioHref}
              aria-label={`Translational portfolio for ${s.name}`}
              className="border-apollo-border-strong text-apollo-slate mt-1.5 inline-flex items-center gap-1.5 self-start rounded-lg border bg-white px-3 py-1.5 text-[13px] font-medium hover:underline print:hidden"
            >
              Translational portfolio
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
            {s.slug && (
              <a href={profilePath(s.slug)} className={cn(LINK, "self-start text-xs print:hidden")}>
                Open profile
              </a>
            )}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-[2_1_420px] flex-col gap-3.5">
        <span className={EYEBROW}>Recent activity</span>
        {s.works.length === 0 ? (
          <span className="text-muted-foreground text-[13px]">No staged papers in this selection.</span>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
            {s.works.map((w) => (
              <WorkItem key={w.pmid} w={w} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** One scholar: counts by stage and recent staged publications. Counts only,
 *  no percentages. The full per-scholar page is the plan's PR 2. */
function PersonView({ data, params, clearHref }: { data: PortfolioData; params: PortfolioParams; clearHref: string }) {
  const s = data.person!;
  const max = Math.max(1, ...TRANSLATIONAL_STAGES.map((k) => data.all[k]), data.all.none);
  return (
    <div className="border-apollo-border flex flex-col gap-3.5 border-t pt-4" data-testid="portfolio-person">
      <Link href={clearHref} className={cn(LINK, "min-h-8 self-start font-medium print:hidden")}>
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
            <a href={profilePath(s.slug)} className={cn(LINK, "self-start text-[13px] font-medium")}>
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
            {[...TRANSLATIONAL_STAGES, "none" as const].map((k) => (
              <tr key={k} className="border-apollo-border border-t">
                <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                  {k === "none" ? (
                    <span className="text-muted-foreground">{NO_STAGE_LABEL}</span>
                  ) : (
                    <>
                      <span className="font-semibold">{code(k)}</span> <span className="text-muted-foreground">{TRANSLATIONAL_STAGE_LABELS[k]}</span>
                    </>
                  )}
                </th>
                <td className="w-1/2 py-2.5">
                  <span className="tabular-nums">{data.all[k].toLocaleString()}</span>
                  <ThinBar share={(data.all[k] / max) * 100} color={k === "none" ? COVERAGE : STAGE_FILL[k].bg} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-3">
          <span className={EYEBROW}>Recent publications</span>
          {s.works.length === 0 ? (
            <span className="text-muted-foreground text-[13px]">No staged first- or senior-author publications in this window.</span>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
              {s.works.map((w) => (
                <WorkItem key={w.pmid} w={w} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
