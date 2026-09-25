/**
 * CancerCenterCollabReportCard — the client half of report 1, "Optimize
 * membership" (`/edit/reports/optimize-membership`; reports redesign,
 * 2026-09-25, mockup `Optimize Membership Redesign.dc.html`, plan D1/D6).
 * The server half is `components/edit/reports/optimize-membership-body.tsx`,
 * which loads every `CenterCollabCandidate` row once and parses the URL.
 *
 * Three lists, all derived here from those rows (`bucketLists`,
 * `lib/edit/optimize-membership-report.ts`):
 *   Remove              — current member, zero co-authored papers with the
 *                         center. Fixed, not threshold-driven.
 *   Add: collaborators  — non-member clearing BOTH thresholds.
 *   Add: recruits       — non-member clearing cancer-relevance but NOT
 *                         collaboration (exclusive of the list above).
 *
 * The two thresholds (count or % of papers), the tab, the search box and the
 * institution select are mirrored into the URL (`c`, `cmode`, `x`, `xmode`,
 * `tab`, `q`, `inst`, via `history.replaceState`) so a shared link reopens the
 * same view, and the `.xlsx` link carries the same params to its route. The
 * filters narrow the tab counts and the download as well as the table.
 *
 * Downloads (plan D1, SCHOLAR_EXPORT_CAP):
 *   - "Download .xlsx": one sheet per list plus Criteria; a list over the cap
 *     is withheld with a note, never truncated. The old uncapped whole-report
 *     CSV is retired.
 *   - "Export selected": the ticked rows as an `.xlsx`, only at `cap` or
 *     fewer; above that the button is disabled with a tooltip (the route
 *     re-checks the count and that each CWID is this center's candidate).
 *   - Per person: the name links to that person's per-paper CSV (`?cwid=`).
 *
 * Advisory only: no writes. "Open in roster editor" is a plain link to
 * `/edit/center/[code]` this round (plan D6).
 *
 * Client module: type-only imports from server code; the value imports are
 * the pure `optimize-membership-report.ts` and `recommendations-core.ts`.
 */
"use client";

import * as React from "react";
import { Download, Info, Lock } from "lucide-react";

import { useShowMore } from "@/components/edit/reports/report-show-more";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { Input } from "@/components/ui/input";
import type { TopicDetail } from "@/lib/cancer-taxonomy";
import { pct } from "@/lib/center-collaboration/recommendations-core";
import {
  bucketLists,
  institutionOptions,
  OPTIMIZE_TABS,
  optimizeDownloadNote,
  optimizeQueryString,
  ruleText,
  sortRows,
  THRESHOLD_DEFAULTS,
  clampThreshold,
  fmtCount,
  type CollabRow,
  type OptimizeParams,
  type OptimizeSortKey,
  type OptimizeTab,
  type ThresholdMode,
} from "@/lib/edit/optimize-membership-report";
import { cn } from "@/lib/utils";

const TH =
  "text-muted-foreground px-3 py-2.5 text-left text-xs font-semibold tracking-[0.08em] whitespace-nowrap uppercase";
const TD = "px-3 py-3 align-top";
const CODE = "bg-apollo-surface-2 border-apollo-border rounded border px-1 font-mono text-[0.92em]";

function ThresholdControl({
  label,
  suffix,
  mode,
  value,
  defaults,
  onChange,
  testId,
}: {
  label: string;
  suffix: string;
  mode: ThresholdMode;
  value: number;
  /** Each unit's default, restored on a unit switch. */
  defaults: Record<ThresholdMode, number>;
  onChange: (mode: ThresholdMode, value: number) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="text-muted-foreground text-xs font-semibold tracking-[0.08em] uppercase">
        {label}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>At least</span>
        <input
          type="number"
          min={0}
          max={mode === "percent" ? 100 : undefined}
          step={mode === "count" ? 1 : 5}
          value={value}
          onChange={(e) => onChange(mode, clampThreshold(e.target.value, mode, 0))}
          aria-label={`${label} threshold`}
          className="border-apollo-border-strong bg-apollo-surface h-8 w-16 rounded-md border px-2 text-right text-sm tabular-nums"
        />
        <div
          className="border-apollo-border-strong bg-apollo-surface flex gap-0.5 rounded-[7px] border p-0.5"
          role="group"
          aria-label={`${label} unit`}
        >
          {(
            [
              ["count", "papers"],
              ["percent", "% of papers"],
            ] as const
          ).map(([m, text]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              // Switching unit resets to that unit's default, as the mockup does.
              onClick={() => mode !== m && onChange(m, defaults[m])}
              className={cn(
                "rounded-[5px] px-2.5 py-1 text-[13px] whitespace-nowrap",
                mode === m ? "bg-apollo-slate font-semibold text-white" : "text-muted-foreground",
              )}
            >
              {text}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground">{suffix}</span>
      </div>
    </div>
  );
}

/** How far (px) a finger may drift and still count as a tap. */
const TAP_SLOP = 10;
const touchOrigin = new WeakMap<Element, { x: number; y: number }>();

function tapStart(e: React.TouchEvent<HTMLElement>) {
  const t = e.touches[0];
  if (t) touchOrigin.set(e.currentTarget, { x: t.clientX, y: t.clientY });
}

/** The #2588 re-fire, skipped when the touch moved: a flick that starts on a
 *  name is a scroll, not a download. */
function tapEnd(e: React.TouchEvent<HTMLElement>) {
  const el = e.currentTarget;
  const from = touchOrigin.get(el);
  touchOrigin.delete(el);
  const t = e.changedTouches[0];
  if (from && t && Math.hypot(t.clientX - from.x, t.clientY - from.y) > TAP_SLOP) return;
  e.preventDefault();
  el.click();
}

/** A count, its percent of the row's papers, and a thin bar. */
function CountBar({ n, of, tone }: { n: number; of: number; tone: "slate" | "maroon" }) {
  const p = pct(n, of);
  return (
    <>
      <div className="flex items-baseline gap-1.5">
        <span className={cn("font-semibold", n === 0 && "text-muted-foreground")}>{n}</span>
        <span className="text-muted-foreground text-[13px]">({p}%)</span>
      </div>
      <div
        className="bg-apollo-surface-2 mt-1.5 h-1 max-w-[120px] overflow-hidden rounded-sm"
        aria-hidden
      >
        <div
          className={cn(
            "h-full rounded-sm",
            tone === "slate" ? "bg-apollo-slate" : "bg-apollo-maroon",
          )}
          style={{ width: `${Math.min(100, p)}%` }}
        />
      </div>
    </>
  );
}

export type CancerCenterCollabReportCardProps = {
  centerCode: string;
  /** Every candidate row for the center, unthresholded. */
  rows: CollabRow[];
  initial: OptimizeParams;
  basePath: string;
  /** Page params that aren't filters (`center=…`), kept on the URL as given. */
  keepQuery: string;
  /** SCHOLAR_EXPORT_CAP, from the server. */
  cap: number;
};

export function CancerCenterCollabReportCard({
  centerCode,
  rows,
  initial,
  basePath,
  keepQuery,
  cap,
}: CancerCenterCollabReportCardProps) {
  const [params, setParams] = React.useState<OptimizeParams>(initial);
  const set = (patch: Partial<OptimizeParams>) => setParams((p) => ({ ...p, ...patch }));
  const [sort, setSort] = React.useState<{ key: OptimizeSortKey; dir: 1 | -1 }>({
    key: "name",
    dir: 1,
  });
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());

  React.useEffect(() => {
    const qs = [keepQuery, optimizeQueryString(params)].filter(Boolean).join("&");
    window.history.replaceState(window.history.state, "", qs ? `${basePath}?${qs}` : basePath);
  }, [params, basePath, keepQuery]);

  const lists = React.useMemo(() => bucketLists(rows, params), [rows, params]);
  // Selection counts against the tab's whole list, not just the rows the
  // search box leaves showing, so typing a search never un-picks anyone.
  const unfiltered = React.useMemo(
    () => bucketLists(rows, { ...params, q: "", inst: "" }),
    [rows, params],
  );
  const instOpts = React.useMemo(() => institutionOptions(rows), [rows]);
  const list = lists[params.tab];
  const sorted = React.useMemo(() => sortRows(list, sort.key, sort.dir), [list, sort]);
  const resetKey = `${optimizeQueryString(params)}|${sort.key}|${sort.dir}`;
  const { visible, hasMore, showMore, rangeLabel } = useShowMore(sorted, 25, resetKey);

  const tabSelected = unfiltered[params.tab].filter((r) => selected.has(r.cwid)).map((r) => r.cwid);
  const allShownChecked = visible.length > 0 && visible.every((r) => selected.has(r.cwid));
  const toggle = (cwid: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(cwid)) next.delete(cwid);
      else next.add(cwid);
      return next;
    });
  const toggleAllShown = () =>
    setSelected((s) => {
      const next = new Set(s);
      for (const r of visible) {
        if (allShownChecked) next.delete(r.cwid);
        else next.add(r.cwid);
      }
      return next;
    });

  const enc = encodeURIComponent(centerCode);
  const downloadQs = optimizeQueryString(params, false);
  const downloadHref = `/api/edit/center/${enc}/collab-report/xlsx${downloadQs ? `?${downloadQs}` : ""}`;
  // The selection spans the tab's whole list (a search never un-picks
  // anyone), so the search and institution filter don't describe it: only
  // the thresholds ride along, for the workbook's Criteria sheet.
  const selectionQs = optimizeQueryString({ ...params, q: "", inst: "" }, false);
  const selectedHref = `/api/edit/center/${enc}/collab-report/selected?${[
    ...tabSelected.map((c) => `cwid=${encodeURIComponent(c)}`),
    selectionQs,
  ]
    .filter(Boolean)
    .join("&")}`;
  const rosterHref = `/edit/center/${enc}`;
  const note = optimizeDownloadNote(lists, cap);
  const overCap = tabSelected.length > cap;

  const sortHeader = (key: OptimizeSortKey, label: string, className?: string, title?: string) => (
    <th
      className={cn(TH, className)}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        title={title}
        onClick={() =>
          setSort((s) => ({
            key,
            dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" ? 1 : -1,
          }))
        }
        className="hover:text-foreground inline-flex items-center gap-1 uppercase"
        data-testid={`om-sort-${key}`}
      >
        {label}
        <span aria-hidden>{sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : ""}</span>
      </button>
    </th>
  );

  const showProgram = params.tab === "remove";

  return (
    <div className="flex flex-col gap-5" data-testid="optimize-membership">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div
          className="bg-apollo-lock-bg border-apollo-border-strong flex min-w-0 flex-[1_1_320px] items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px]"
          role="note"
        >
          <Lock className="size-3.5 shrink-0" aria-hidden />
          <span>
            <strong className="font-semibold">Advisory only.</strong> Nothing here changes the
            roster. Apply changes in the{" "}
            <a href={rosterHref} className="text-apollo-slate hover:underline">
              roster editor
            </a>
            .
          </span>
        </div>
        <div className="flex max-w-[340px] flex-col items-start gap-1.5">
          <Button asChild variant="apollo">
            <a href={downloadHref} data-testid="om-download">
              <Download className="size-4" aria-hidden />
              Download .xlsx
            </a>
          </Button>
          <p
            className={cn("text-xs", note.withheld ? "text-apollo-amber" : "text-muted-foreground")}
            data-testid="om-download-note"
          >
            {note.text}
          </p>
        </div>
      </div>

      <section className="bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border">
        <div className="border-apollo-border bg-apollo-surface-2 flex flex-wrap items-end gap-x-10 gap-y-5 rounded-t-[var(--apollo-radius-card)] border-b px-4 py-[18px] sm:px-5">
          <ThresholdControl
            label="Collaboration"
            suffix="co-authored with members"
            mode={params.cmode}
            value={params.c}
            defaults={THRESHOLD_DEFAULTS.c}
            onChange={(cmode, c) => set({ cmode, c })}
            testId="om-threshold-c"
          />
          <ThresholdControl
            label="Cancer-relevance"
            suffix="cancer-related"
            mode={params.xmode}
            value={params.x}
            defaults={THRESHOLD_DEFAULTS.x}
            onChange={(xmode, x) => set({ xmode, x })}
            testId="om-threshold-x"
          />
          <div className="flex flex-[1_1_240px] flex-col items-start gap-2 pb-0.5">
            <MeshLogicModal />
            <p className="text-muted-foreground text-xs">
              Thresholds set the two Add lists. Remove always lists members with no co-authored
              papers.
            </p>
          </div>
        </div>

        <div
          className="border-apollo-border flex gap-7 overflow-x-auto border-b px-4 sm:px-5"
          role="tablist"
          aria-label="Lists"
        >
          {OPTIMIZE_TABS.map((t) => {
            const on = params.tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => set({ tab: t.key as OptimizeTab })}
                data-testid={`om-tab-${t.key}`}
                className={cn(
                  "-mb-px border-b-2 pt-3.5 pb-3 text-base whitespace-nowrap tabular-nums",
                  on
                    ? "border-apollo-maroon text-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {t.label} ({fmtCount(lists[t.key].length)})
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-3.5 px-4 pt-4 sm:px-5">
          <p className="max-w-[820px] text-sm" data-testid="om-rule">
            {ruleText(params.tab, params)}
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            <Input
              type="search"
              value={params.q}
              onChange={(e) => set({ q: e.target.value })}
              placeholder="Search name, department or institution"
              aria-label="Search name, department or institution"
              className="bg-apollo-surface border-apollo-border-strong h-[34px] w-full text-sm sm:w-72"
            />
            <select
              value={params.inst}
              onChange={(e) => set({ inst: e.target.value })}
              aria-label="Institution"
              className={cn(
                "h-[34px] max-w-full min-w-0 rounded-md border px-2 text-sm",
                params.inst
                  ? "border-apollo-slate bg-apollo-slate-tint"
                  : "border-apollo-border-strong bg-apollo-surface",
              )}
            >
              <option value="">All institutions</option>
              {instOpts.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <div className="hidden flex-1 sm:block" />
            {tabSelected.length > 0 && (
              <div className="flex flex-wrap items-center gap-2" data-testid="om-selection">
                <span className="text-muted-foreground text-[13px] whitespace-nowrap tabular-nums">
                  {tabSelected.length} selected
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
                {overCap ? (
                  <HoverTooltip text={`Select ${cap} or fewer people to export.`} wide>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled
                      aria-describedby="om-export-cap-note"
                      data-testid="om-export-selected"
                    >
                      Export selected
                    </Button>
                    <span id="om-export-cap-note" className="sr-only">
                      Select {cap} or fewer people to export.
                    </span>
                  </HoverTooltip>
                ) : (
                  <Button asChild variant="outline" size="sm">
                    <a href={selectedHref} data-testid="om-export-selected">
                      Export selected
                    </a>
                  </Button>
                )}
                <Button asChild size="sm">
                  <a href={rosterHref} data-testid="om-roster-editor">
                    Open in roster editor
                  </a>
                </Button>
              </div>
            )}
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm sm:px-5" data-testid="om-no-data">
            No data yet: the weekly report (<code>etl:cancer-center-collab-report</code>)
            hasn&apos;t run for this center.
          </p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm sm:px-5" data-testid="om-empty">
            No one matches. Try lowering a threshold or clearing the search.
          </p>
        ) : (
          <>
            <div className="mt-3.5 overflow-x-auto">
              <table
                className="w-full min-w-[760px] border-collapse text-sm tabular-nums"
                data-testid="om-table"
              >
                <thead>
                  <tr className="bg-apollo-surface-2">
                    <th className="w-11 py-2.5 pl-4 text-left sm:pl-5">
                      <input
                        type="checkbox"
                        checked={allShownChecked}
                        onChange={toggleAllShown}
                        aria-label="Select all shown"
                        className="accent-apollo-slate size-[18px]"
                      />
                    </th>
                    {sortHeader("name", "Name", "min-w-[180px]")}
                    <th className={cn(TH, "w-[170px]")}>Institution</th>
                    {sortHeader("papers", "Papers", "w-20 text-right")}
                    {sortHeader(
                      "collab",
                      "With members",
                      "w-[130px]",
                      "Papers co-authored with current center members",
                    )}
                    {sortHeader("cancer", "Cancer-related", "w-[130px]")}
                    {showProgram && <th className={cn(TH, "w-[230px] pr-5")}>Program</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const on = selected.has(r.cwid);
                    const name = `${r.givenName} ${r.surname}`.trim();
                    return (
                      <tr
                        key={r.cwid}
                        onClick={(e) => {
                          // The hover card portals out of the row, but React
                          // still bubbles its clicks here: only a click inside
                          // the row's own DOM toggles it.
                          if (!e.currentTarget.contains(e.target as Node)) return;
                          if ((e.target as HTMLElement).closest("a,button,input,select,label"))
                            return;
                          toggle(r.cwid);
                        }}
                        className={cn(
                          "border-apollo-border hover:bg-apollo-page cursor-pointer border-b",
                          on && "bg-apollo-slate-tint",
                        )}
                        data-testid="om-row"
                      >
                        <td className="py-3 pl-4 align-top sm:pl-5">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(r.cwid)}
                            aria-label={`Select ${name}`}
                            className="accent-apollo-slate mt-0.5 size-[18px]"
                          />
                        </td>
                        <td className={TD}>
                          <ScholarHoverCard cwid={r.cwid}>
                            <a
                              href={`/api/edit/center/${enc}/collab-report/export?cwid=${encodeURIComponent(r.cwid)}`}
                              title={`Download ${name}'s papers (CSV)`}
                              aria-label={`${name}: download papers (CSV)`}
                              // The hover trigger preventDefaults touchstart, which on
                              // iOS cancels this tap's click: re-issue it (#2588), but
                              // only for a tap (a scroll that starts here also ends in
                              // touchend, and this click saves a file).
                              onTouchStart={tapStart}
                              onTouchEnd={tapEnd}
                              className="hover:text-apollo-maroon inline-flex items-center gap-1 font-semibold"
                            >
                              {name}
                              <Download className="text-muted-foreground size-3" aria-hidden />
                            </a>
                          </ScholarHoverCard>
                          {r.primaryDepartment && (
                            <div className="text-muted-foreground mt-0.5 text-[13px]">
                              {r.primaryDepartment}
                            </div>
                          )}
                        </td>
                        <td className={cn(TD, "text-[13px] leading-[1.4]")}>{r.institution}</td>
                        <td className={cn(TD, "text-right")}>{r.totalPapersPostCutoff}</td>
                        <td className={TD}>
                          <CountBar
                            n={r.collaborationsWithCenter}
                            of={r.totalPapersPostCutoff}
                            tone="slate"
                          />
                        </td>
                        <td className={TD}>
                          <CountBar
                            n={r.cancerRelatedPapers}
                            of={r.totalPapersPostCutoff}
                            tone="maroon"
                          />
                        </td>
                        {showProgram && (
                          <td className={cn(TD, "pr-5")}>
                            {r.currentProgramCode ? (
                              <div className="flex items-start gap-2">
                                <span className="bg-apollo-surface-2 border-apollo-border-strong rounded border px-1.5 py-px font-mono text-xs font-semibold">
                                  {r.currentProgramCode}
                                </span>
                                {r.programLabel && (
                                  <span className="text-[13px] leading-[1.35]">
                                    {r.programLabel}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
          <span className="text-muted-foreground text-[13px]" data-testid="om-range">
            {list.length > 0 ? `${rangeLabel} people` : ""}
          </span>
          {hasMore && (
            <Button type="button" variant="outline" size="sm" onClick={showMore}>
              Show 25 more
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

type TaxonomySummary = {
  topics: TopicDetail[];
  totalRelevant: number;
  ruleCount: number;
  meshRelease: string | null;
};

const RULESET_URL =
  "https://github.com/wcmc-its/Scholars-Profile-System/blob/master/docs/cancer-taxonomy-ruleset.csv";
const GENERATOR_DOC_URL =
  "https://github.com/wcmc-its/Scholars-Profile-System/blob/master/docs/cancer-taxonomy-generator.md";

/**
 * Topic slug -> a curated display label, for the modal only. Checked
 * intentionally: `docs/cancer-taxonomy-ruleset.csv`'s own `topic` column IS
 * the raw slug (`kidney-bladder-testicular`, `cc-biology`, ...) — there is
 * no display-name source anywhere in the ruleset or `CancerTaxonomyDescriptor`
 * to read this from, so unlike everything else in this modal, these labels
 * are NOT derived from a live query. A mechanical slug->label transform
 * (hyphens -> ", "/" and ", capitalize) was tried and rejected: it silently
 * mangles real oncology terms a naive split can't tell from a coordinate
 * list — "unknown-primary" -> "Unknown and primary", "multiple-myeloma" ->
 * "Multiple and myeloma", "mds-mpn" (a real overlap-syndrome abbreviation,
 * not two words) -> "Mds and mpn". Hand-curated instead, using standard
 * oncology-program naming. A future ruleset topic not yet listed here falls
 * back to a plain hyphen-to-space prettification — imperfect, but it never
 * asserts a false "X and Y" structure the way the rejected transform did.
 */
const TOPIC_LABELS: Record<string, string> = {
  unassigned: "Unassigned",
  "brain-cns": "Brain and CNS",
  breast: "Breast",
  colorectal: "Colorectal",
  "endocrine-other": "Endocrine (other)",
  "esophageal-gastric": "Esophageal and gastric",
  eye: "Eye (ocular)",
  "germ-cell-embryonal": "Germ cell and embryonal",
  "gi-other": "GI (other)",
  gynecologic: "Gynecologic",
  "head-neck": "Head and neck",
  "hematologic-other": "Hematologic (other)",
  "kidney-bladder-testicular": "Kidney, bladder and testicular",
  leukemia: "Leukemia",
  "liver-biliary": "Liver and biliary",
  "lung-thoracic": "Lung and thoracic",
  lymphoma: "Lymphoma",
  "mds-mpn": "MDS/MPN",
  "melanoma-skin": "Melanoma and skin",
  "multiple-myeloma": "Multiple myeloma",
  pancreatic: "Pancreatic",
  "peritoneal-abdominal": "Peritoneal and abdominal",
  prostate: "Prostate",
  "sarcoma-bone": "Sarcoma and bone",
  "thyroid-neuroendocrine": "Thyroid and neuroendocrine",
  "unknown-primary": "Unknown primary",
  "cc-biology": "Tumor biology",
  "cc-control-survivorship": "Cancer control and survivorship",
  "cc-experimental-models": "Experimental models",
  "cc-hereditary": "Hereditary cancer syndromes",
  "cc-precancerous": "Precancerous conditions",
  "cc-therapeutics": "Cancer therapeutics",
};

function topicLabel(topic: string): string {
  const known = TOPIC_LABELS[topic];
  if (known) return known;
  const spaced = topic.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

type BucketKind = "all" | "site" | "cc";

/** A disease-site bucket: not `cc-`, and not `unassigned` (a real bucket, but
 *  neither a site nor cross-cutting). */
const isSite = (topic: string) => !topic.startsWith("cc-") && topic !== "unassigned";
const isCc = (topic: string) => topic.startsWith("cc-");

/** The Topic buckets tab: search (label, slug or sample descriptor), the
 *  All / Disease site / Cross-cutting filter, descriptor chips with the
 *  search hit highlighted, and "+N more". Client-side over the one fetch. */
export function filterBuckets(
  topics: ReadonlyArray<TopicDetail>,
  query: string,
  kind: BucketKind,
): TopicDetail[] {
  const q = query.trim().toLowerCase();
  return topics.filter(
    (t) =>
      (kind === "all" || (kind === "site" ? isSite(t.topic) : isCc(t.topic))) &&
      (!q ||
        `${topicLabel(t.topic)} ${t.topic} ${t.exampleDescriptors.join(" ")}`
          .toLowerCase()
          .includes(q)),
  );
}

/**
 * "How cancer-relevance is determined": a Method tab (the two independent
 * questions, subtree matching, experimental models, why a defined method,
 * changing it) and a Topic buckets tab. Fetched lazily, once the dialog
 * opens, from `/api/edit/cancer-center-mesh-taxonomy`, which builds this from
 * the SAME `topicsByUi` lookup the weekly ETL and the per-person CSV match
 * against. An empty taxonomy (the generator hasn't run in this environment)
 * says so instead of printing zeros (#2796).
 */
function MeshLogicModal() {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<TaxonomySummary | null>(null);
  const [error, setError] = React.useState(false);
  const [tab, setTab] = React.useState<"method" | "buckets">("method");
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<BucketKind>("all");

  React.useEffect(() => {
    if (!open || data || error) return;
    (async () => {
      try {
        const res = await fetch("/api/edit/cancer-center-mesh-taxonomy");
        if (!res.ok) {
          setError(true);
          return;
        }
        setData(await res.json());
      } catch {
        setError(true);
      }
    })();
  }, [open, data, error]);

  const empty = data?.totalRelevant === 0;
  const live = empty ? null : data;
  const siteCount = live?.topics.filter((t) => isSite(t.topic)).length;
  const ccCount = live?.topics.filter((t) => isCc(t.topic)).length;
  const buckets = live ? filterBuckets(live.topics, query, kind) : [];
  const q = query.trim().toLowerCase();

  const modalTab = (k: "method" | "buckets", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === k}
      onClick={() => setTab(k)}
      className={cn(
        "-mb-px border-b-2 pt-2 pb-2.5 text-[15px] whitespace-nowrap",
        tab === k
          ? "border-apollo-maroon text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {label}
    </button>
  );
  const kindButton = (k: BucketKind, label: string) => (
    <button
      type="button"
      aria-pressed={kind === k}
      onClick={() => setKind(k)}
      className={cn(
        "rounded-md px-2.5 py-1 text-[13px] whitespace-nowrap",
        kind === k
          ? "bg-apollo-surface text-foreground font-semibold shadow-sm"
          : "text-muted-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setTab("method");
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="bg-apollo-surface">
          <Info className="size-3.5" aria-hidden />
          How cancer-relevance is determined
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-apollo-surface flex max-h-[86vh] w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[780px]">
        <div className="border-apollo-border border-b px-5 pt-6 sm:px-7">
          <DialogTitle className="text-xl font-semibold">
            How cancer-relevance is determined
          </DialogTitle>
          <DialogDescription className="mt-1">
            {empty
              ? "The cancer taxonomy hasn't been generated in this environment yet, so no publications are classified as cancer-relevant."
              : data
                ? `${data.totalRelevant} cancer-relevant descriptors from ${data.ruleCount} ruleset rows${
                    data.meshRelease ? ` · Resolved against ${data.meshRelease}` : ""
                  }`
                : " "}
          </DialogDescription>
          <div className="mt-4 flex gap-7" role="tablist" aria-label="Sections">
            {modalTab("method", "Method")}
            {modalTab("buckets", live ? `Topic buckets (${live.topics.length})` : "Topic buckets")}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7">
          {tab === "method" ? (
            <div className="flex flex-col gap-5 text-[15px] leading-relaxed">
              <p>
                A paper counts toward this report&apos;s cancer-relevance axis when at least one of
                its MeSH terms is in the cancer taxonomy. The taxonomy is generated, not
                hand-picked: a checked-in ruleset of MeSH subtree rules is expanded against the full
                National Library of Medicine descriptor release into a complete, provenanced list.
              </p>
              <div>
                <p className="mb-3">
                  It answers two independent questions, and they should not be collapsed into one.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="bg-apollo-surface-2 border-apollo-border rounded-[10px] border px-[18px] py-4">
                    <div className="text-muted-foreground text-xs font-semibold tracking-[0.08em] uppercase">
                      Question 1 · the count
                    </div>
                    <h3 className="mt-1 mb-2 text-base font-semibold">
                      Is it cancer-relevant at all?
                    </h3>
                    <p className="text-sm leading-normal">
                      All of MeSH&apos;s C04 (Neoplasms) subtree, minus{" "}
                      <code className={CODE}>Cysts</code> and{" "}
                      <code className={CODE}>Hamartoma</code>, which are non-neoplastic despite
                      living there, plus curated non-C04 headings covering therapeutics, cancer
                      control, tumor biology, and cancer-gene concepts. A few individual terms are
                      readmitted against an exclusion — Dermoid Cyst, Tuberous Sclerosis, Cowden
                      syndrome. This is the count the report keys on.
                    </p>
                  </div>
                  <div className="bg-apollo-surface-2 border-apollo-border rounded-[10px] border px-[18px] py-4">
                    <div className="text-muted-foreground text-xs font-semibold tracking-[0.08em] uppercase">
                      Question 2 · the facet
                    </div>
                    <h3 className="mt-1 mb-2 text-base font-semibold">
                      Which topic does it belong to?
                    </h3>
                    <p className="text-sm leading-normal">
                      A separate facet: {siteCount ?? "~25"} disease-site buckets plus{" "}
                      {ccCount ?? "six"} cross-cutting <code className={CODE}>cc-</code> buckets. A
                      descriptor can carry several topics, and can legitimately carry none — a
                      cancer-relevant paper with no site-specific angle,{" "}
                      <code className={CODE}>Carcinoma</code> itself for instance, is{" "}
                      <code className={CODE}>unassigned</code> rather than a data gap. Topic counts
                      do not sum to a total.
                    </p>
                    <button
                      type="button"
                      onClick={() => setTab("buckets")}
                      className="text-apollo-slate mt-2.5 text-sm font-medium hover:underline"
                    >
                      Browse the topic buckets →
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <h3 className="mb-1.5 text-base font-semibold">Matching runs down the tree</h3>
                <p>
                  MeSH encodes every biomedical concept as a dotted tree number —{" "}
                  <code className={CODE}>C04.588.180</code> for Breast Neoplasms — reading left to
                  right from broad to specific. A subtree rule admits its anchor and everything
                  beneath it, so a paper matches on any descendant term, not only on an exact hit
                  against the named heading.
                </p>
              </div>
              <div>
                <h3 className="mb-1.5 text-base font-semibold">
                  Experimental models are relevant, but not to a site
                </h3>
                <p>
                  <code className={CODE}>Liver Neoplasms, Experimental</code> sits under both{" "}
                  <code className={CODE}>Liver Neoplasms</code> and{" "}
                  <code className={CODE}>Neoplasms, Experimental</code>. The generator strips the
                  site topic from anything caught by the model-system sweep and routes it to{" "}
                  <code className={CODE}>cc-experimental-models</code> only. A mouse-model paper is
                  cancer research; it is not a liver cancer paper in the sense this report means.
                </p>
              </div>
              <div>
                <h3 className="mb-1.5 text-base font-semibold">Why a defined method at all</h3>
                <p>
                  NCI treats cancer-relatedness as a matter of flexible interpretation and lets each
                  center choose its own method, so long as that method is rigorous, described, and
                  defensible in peer review. A generated taxonomy with a checked-in ruleset and a
                  version pinned to both the ruleset and the MeSH release is what makes this one
                  answerable: any count here traces back to the rule that produced it.
                </p>
                <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  <a
                    href="https://grants.nih.gov/grants/guide/pa-files/PAR-25-444.html"
                    target="_blank"
                    rel="noreferrer"
                    className="text-apollo-slate hover:underline"
                  >
                    CCSG announcement, Cancer Focus ↗
                  </a>
                  <a
                    href="https://cancercenters.cancer.gov/sites/default/files/FAQsCCSG.pdf"
                    target="_blank"
                    rel="noreferrer"
                    className="text-apollo-slate hover:underline"
                  >
                    CCSG FAQ ↗
                  </a>
                  <a
                    href="https://cancercenters.cancer.gov/sites/default/files/CCSGDataGuide.pdf"
                    target="_blank"
                    rel="noreferrer"
                    className="text-apollo-slate hover:underline"
                  >
                    CCSG Data Guide ↗
                  </a>
                </div>
              </div>
              <div>
                <h3 className="mb-1.5 text-base font-semibold">Changing it is a pull request</h3>
                <p>
                  The ruleset is checked-in data applied WCM-wide, not a per-center setting.
                  Narrowing it to one center&apos;s scope means editing{" "}
                  <code className={CODE}>docs/cancer-taxonomy-ruleset.csv</code>, and the working
                  discipline there is to size a candidate rule against real WCM publication counts
                  before adopting or rejecting it.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3.5" data-testid="om-buckets">
              {error && <p className="text-destructive text-sm">Failed to load.</p>}
              {!error && !data && <p className="text-muted-foreground text-sm">Loading…</p>}
              {empty && (
                <p className="text-muted-foreground text-sm" data-testid="om-taxonomy-empty">
                  No topic buckets: the cancer taxonomy hasn&apos;t been generated in this
                  environment yet.
                </p>
              )}
              {live && (
                <>
                  <p className="text-muted-foreground text-sm">
                    Every topic bucket, with a live count and a sample of the descriptors that carry
                    it. The complete list of admitted descriptors and the note behind each rule live
                    in the ruleset.
                  </p>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search buckets or descriptors"
                      aria-label="Search buckets or descriptors"
                      className="bg-apollo-surface border-apollo-border-strong h-[34px] w-full text-sm sm:w-64"
                    />
                    <div
                      className="bg-apollo-surface-2 border-apollo-border-strong flex flex-wrap gap-0.5 rounded-lg border p-[3px]"
                      role="group"
                      aria-label="Bucket kind"
                    >
                      {kindButton("all", "All")}
                      {kindButton("site", `Disease site ${siteCount}`)}
                      {kindButton("cc", `Cross-cutting ${ccCount}`)}
                    </div>
                  </div>
                  <ul className="border-apollo-border border-t">
                    {buckets.map((b) => (
                      <li
                        key={b.topic}
                        className="border-apollo-border grid gap-x-6 gap-y-1.5 border-b py-3.5 sm:grid-cols-[minmax(160px,220px)_minmax(0,1fr)]"
                        data-testid="om-bucket"
                      >
                        <div>
                          <div className="text-[15px] font-semibold">{topicLabel(b.topic)}</div>
                          <div className="text-muted-foreground mt-0.5 font-mono text-xs">
                            {b.topic}
                          </div>
                          <div className="mt-1.5 text-[13px] tabular-nums">
                            <strong className="font-semibold">{b.descriptorCount}</strong>{" "}
                            <span className="text-muted-foreground">
                              descriptor{b.descriptorCount === 1 ? "" : "s"}
                            </span>
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap gap-1">
                            {b.exampleDescriptors.map((d) => {
                              const hit = q !== "" && d.toLowerCase().includes(q);
                              return (
                                <span
                                  key={d}
                                  data-hit={hit || undefined}
                                  className={cn(
                                    "border-apollo-border rounded border px-[7px] py-0.5 text-xs leading-[1.4]",
                                    hit ? "bg-apollo-amber-tint" : "bg-apollo-surface-2",
                                  )}
                                >
                                  {d}
                                </span>
                              );
                            })}
                            {b.descriptorCount > b.exampleDescriptors.length && (
                              <span className="text-muted-foreground px-1 py-0.5 text-xs">
                                +{b.descriptorCount - b.exampleDescriptors.length} more
                              </span>
                            )}
                          </div>
                          <a
                            href={RULESET_URL}
                            target="_blank"
                            rel="noreferrer"
                            className="text-apollo-slate mt-2 inline-block text-[13px] hover:underline"
                          >
                            Rules for this bucket ↗
                          </a>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {buckets.length === 0 && (
                    <p className="text-muted-foreground text-sm">No buckets match.</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="border-apollo-border bg-apollo-surface-2 flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-5 py-3.5 text-sm sm:px-7">
          <a
            href={GENERATOR_DOC_URL}
            target="_blank"
            rel="noreferrer"
            className="text-apollo-slate hover:underline"
          >
            How the taxonomy is generated ↗
          </a>
          <a
            href={RULESET_URL}
            target="_blank"
            rel="noreferrer"
            className="text-apollo-slate hover:underline"
          >
            {data ? `The full ruleset, all ${data.ruleCount} rows ↗` : "The full ruleset ↗"}
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
