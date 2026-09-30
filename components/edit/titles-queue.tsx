/**
 * The Titles queue body (`/edit/titles-queue`, formerly report 10 "Display
 * titles"). Top to bottom (design canvas "Display Titles", 2026-09-25):
 *
 *   - "How titles are chosen": a one-line summary with a Show ladder toggle
 *     (`RubricDisclosure`, `#rubric`, which the `/edit` title picker
 *     deep-links to and which opens itself on that hash). The ladder is
 *     rendered FROM `TITLE_RANK` / `TITLE_RANK_LABEL` so it cannot drift.
 *   - Tabs: Needs review (default) / Pinned / Leadership, no issues / All,
 *     each with its count over every listed scholar (`titleTabOf`), and a
 *     one-line note under them.
 *   - One toolbar: search, winning rule, rank band and pinned selects in a
 *     plain GET `AutoSubmitForm`; reason chips with counts (links that toggle
 *     `?reason=`); "N of M scholars"; the `.xlsx` download of exactly what is
 *     listed (the tab included).
 *   - One row per scholar: name, displayed title with its rank and winning
 *     rule, runner-up with its rank and source, why listed (reason pills +
 *     notes), and Change, which opens the pin panel under the row
 *     (`TitleRowDisclosure`).
 *
 * Who is listed, and why, is `lib/edit/title-dashboard.ts`; the download route
 * (`/edit/titles-queue/export`) takes the same query string through the same
 * `parseTitleDashboardParams`. The pin panel posts the same `/api/edit/field`
 * write as `TitleField` — this page adds no write path. The page's gate
 * (`canReviewTitles`) is the pin gate, so every viewer gets the pin control;
 * `canSet` is still derived from the session so the control can never show
 * to someone the write would refuse.
 */
import Link from "next/link";
import { Download } from "lucide-react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import {
  RubricDisclosure,
  TitleRowDisclosure,
} from "@/components/edit/titles-queue-client";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Button } from "@/components/ui/button";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  filterTitleDashboard,
  formatTitleRank,
  loadTitleDashboard,
  parseTitleDashboardParams,
  TITLE_BAND_LABEL,
  TITLE_BANDS,
  TITLE_REASON_LABEL,
  TITLE_REASONS,
  TITLE_RULES,
  TITLE_TAB_LABEL,
  TITLE_TAB_NOTE,
  TITLE_TABS,
  titleDashboardQueryString,
  titleRowNotes,
  titleRuleLabel,
  titleTabOf,
  winningRank,
  winningRule,
  type TitleDashboardParams,
  type TitleDashboardRow,
  type TitleReason,
  type TitleTab,
} from "@/lib/edit/title-dashboard";
import { canReviewTitles } from "@/lib/edit/titles-queue";
import { TITLE_RANK, TITLE_RANK_LABEL } from "@/lib/scholar-title";
import { cn } from "@/lib/utils";

/** The ladder, highest first; "Anything else" (unranked) sorts last on its own. */
export const RUBRIC_ROWS = (Object.keys(TITLE_RANK) as Array<keyof typeof TITLE_RANK>)
  .map((k) => ({ key: k, rank: TITLE_RANK[k], label: TITLE_RANK_LABEL[k] }))
  .sort((a, b) => a.rank - b.rank);

/** The tie-breaks and exceptions the ladder alone does not say (2026-09-24/25). */
export const RUBRIC_RULES = [
  "Pins always win.",
  "Ties go to the working title, then the ED primary title.",
  "Emeritus titles hold no office.",
  "Every tracked center counts as institutional.",
  "Center associate directors and co-directors never title their holder.",
  "A director title naming its own department, or the department its holder chairs, ranks as Chair.",
  "A working title claims Chair only when a chair role backs it.",
  "Only academic departments have chairs: Graduate School and MD-PhD Program do not.",
] as const;

/** Reason pill colours, one job each: neutral = informational, slate = a
 *  pin, amber = worth reviewing, red tint = the title and roles disagree. */
const REASON_PILL: Record<TitleReason, string> = {
  leadership: "bg-apollo-surface-2 text-muted-foreground",
  pinned: "bg-apollo-slate-tint text-apollo-slate",
  contested: "bg-apollo-amber-tint text-apollo-amber",
  leadershipLost: "bg-apollo-amber-tint text-apollo-amber",
  unverifiedWorkingTitle: "bg-apollo-amber-tint text-apollo-amber",
  mismatch: "bg-apollo-red-tint text-destructive",
  conflictingRoles: "bg-apollo-red-tint text-destructive",
};

/** The results grid at md+: scholar, displayed, runner-up, why listed, (Change). */
const GRID_SET =
  "md:grid-cols-[minmax(130px,.8fr)_minmax(0,1.5fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_80px]";
const GRID_VIEW =
  "md:grid-cols-[minmax(130px,.8fr)_minmax(0,1.5fr)_minmax(0,1.3fr)_minmax(0,1.6fr)]";

const CONTROL =
  "border-apollo-border-strong bg-apollo-surface h-9 min-w-0 rounded-lg border px-2.5 text-[13.5px]";
const RANK_TAG = "border-apollo-border rounded-[5px] border px-1.5 font-mono tabular-nums";

/** The page's `searchParams`, awaited — Next's shape (a repeated key is an array). */
export type TitlesQueueSearchParams = Record<string, string | string[] | undefined>;

function toSearchParams(sp: TitlesQueueSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

function Rubric() {
  return (
    <RubricDisclosure summary="Every title a scholar holds is ranked on a 12-step ladder. The highest-ranked one is displayed; pins always win.">
      <div className="grid gap-7 md:grid-cols-2">
        <ol
          className="flex flex-col pt-3"
          aria-label="Title ladder"
          data-testid="title-rubric-ladder"
        >
          {RUBRIC_ROWS.map((r) => (
            <li
              key={r.key}
              className="border-apollo-border grid grid-cols-[40px_minmax(0,1fr)] gap-2.5 border-b py-1.5 text-[13.5px]"
            >
              <span className="text-muted-foreground font-mono text-[12.5px] tabular-nums">
                {formatTitleRank(r.rank)}
              </span>
              <span>{r.label}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-col gap-2.5 pt-3">
          <h3 className="text-muted-foreground text-xs font-normal tracking-[0.06em] uppercase">
            Rules
          </h3>
          <ol
            className="flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px] leading-[1.45]"
            data-testid="title-rubric-rules"
          >
            {RUBRIC_RULES.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
          <p className="text-muted-foreground text-[12.5px]">
            Source: Institutional Communications, 2026-09-24/25.
          </p>
        </div>
      </div>
    </RubricDisclosure>
  );
}

/** A queue URL for `p` (the tab links, reason chips). The review tab is the
 *  page's default, so it stays off the URL. */
function hrefFor(basePath: string, p: TitleDashboardParams): string {
  const q = titleDashboardQueryString({ ...p, tab: p.tab === "review" ? null : p.tab });
  return q ? `${basePath}?${q}` : basePath;
}

function Tabs({
  basePath,
  params,
  counts,
}: {
  basePath: string;
  params: TitleDashboardParams;
  counts: Record<TitleTab, number>;
}) {
  return (
    <nav
      aria-label="Display title groups"
      className="border-apollo-border-strong flex flex-wrap items-end gap-x-7 border-b"
    >
      {TITLE_TABS.map((t) => {
        const on = params.tab === t;
        return (
          <Link
            key={t}
            // A tab switch keeps the search and selects, drops the reason chip
            // (its counts are per tab).
            href={hrefFor(basePath, { ...params, tab: t, reason: null })}
            aria-current={on ? "page" : undefined}
            data-testid={`display-titles-tab-${t}`}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-0.5 pt-2.5 pb-3 text-[15px] whitespace-nowrap",
              on
                ? "border-apollo-maroon text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {TITLE_TAB_LABEL[t]}
            <span
              className={cn(
                "rounded-full px-[7px] py-px text-xs tabular-nums",
                on && t === "review"
                  ? "bg-apollo-maroon text-apollo-maroon-foreground font-semibold"
                  : "bg-apollo-surface-2 text-muted-foreground",
                on && t !== "review" && "font-semibold",
              )}
            >
              {counts[t].toLocaleString()}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/** A single-choice select; the first option ("" = any) clears it. */
function FilterSelect({
  name,
  label,
  value,
  anyLabel,
  options,
}: {
  name: string;
  label: string;
  value: string | null;
  anyLabel: string;
  options: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <select
      name={name}
      aria-label={label}
      defaultValue={value ?? ""}
      className={cn(CONTROL, value && "border-apollo-slate bg-apollo-slate-tint")}
      data-testid={`display-titles-${name}`}
    >
      <option value="">{anyLabel}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

const pinnedValue = (p: TitleDashboardParams) =>
  p.pinned === null ? null : p.pinned ? "yes" : "no";

function Toolbar({
  basePath,
  params,
  base,
  shown,
  inTab,
  downloadHref,
}: {
  basePath: string;
  params: TitleDashboardParams;
  /** This tab's rows after every filter but the reason — the chip counts. */
  base: readonly TitleDashboardRow[];
  shown: number;
  inTab: number;
  downloadHref: string;
}) {
  const chips = TITLE_REASONS.map((r) => ({
    r,
    n: base.filter((x) => x.reasons.includes(r)).length,
  })).filter(
    // An active chip stays even at zero, so it can always be turned off.
    (c) => c.n > 0 || c.r === params.reason,
  );
  return (
    <div className="flex flex-wrap items-center gap-2.5" data-testid="display-titles-toolbar">
      <AutoSubmitForm
        action={basePath}
        className="group contents"
        data-testid="display-titles-filters"
      >
        {params.tab && params.tab !== "review" && (
          <input type="hidden" name="tab" value={params.tab} />
        )}
        {params.reason && <input type="hidden" name="reason" value={params.reason} />}
        <input
          type="search"
          name="q"
          defaultValue={params.q}
          placeholder="Search name, CWID or title"
          aria-label="Search name, CWID or title"
          className={cn(CONTROL, "w-[280px] max-w-full px-3 text-sm")}
          data-testid="display-titles-q"
        />
        <FilterSelect
          name="rule"
          label="Winning rule"
          value={params.rule}
          anyLabel="Any winning rule"
          options={TITLE_RULES.map((r) => [r, titleRuleLabel(r)] as const)}
        />
        <FilterSelect
          name="band"
          label="Rank band"
          value={params.band}
          anyLabel="Any rank band"
          options={TITLE_BANDS.map((b) => [b, TITLE_BAND_LABEL[b]] as const)}
        />
        <FilterSelect
          name="pinned"
          label="Pinned"
          value={pinnedValue(params)}
          anyLabel="Pinned or not"
          options={[
            ["yes", "Pinned only"],
            ["no", "Not pinned"],
          ]}
        />
        {/* No-JS fallback; the island hides it once hydrated. */}
        <button
          type="submit"
          className={cn(
            CONTROL,
            "hover:bg-apollo-surface-2 px-3 group-data-[hydrated=true]:hidden",
          )}
        >
          Apply
        </button>
      </AutoSubmitForm>
      {chips.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label="Filter by reason"
          data-testid="display-titles-reasons"
        >
          {chips.map(({ r, n }) => {
            const on = params.reason === r;
            return (
              <li key={r}>
                <Link
                  href={hrefFor(basePath, { ...params, reason: on ? null : r })}
                  aria-pressed={on}
                  data-testid={`display-titles-reason-${r}`}
                  className={cn(
                    "inline-flex h-[30px] items-center rounded-full border px-[11px] text-[12.5px] whitespace-nowrap tabular-nums",
                    on
                      ? "border-apollo-slate bg-apollo-slate text-white"
                      : "border-apollo-border-strong bg-apollo-surface text-foreground hover:bg-apollo-surface-2",
                  )}
                >
                  {TITLE_REASON_LABEL[r]} · {n.toLocaleString()}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <span
          className="text-muted-foreground text-[13px] tabular-nums"
          data-testid="display-titles-count"
        >
          {shown.toLocaleString()} of {inTab.toLocaleString()} scholars
        </span>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="border-apollo-border-strong bg-apollo-surface"
        >
          <a href={downloadHref} data-testid="display-titles-download">
            <Download className="size-3.5" aria-hidden />
            Download .xlsx
          </a>
        </Button>
      </div>
    </div>
  );
}

function TitleRowCells({ r }: { r: TitleDashboardRow }) {
  const rule = winningRule(r);
  const notes = titleRowNotes(r);
  return (
    <>
      <div className="min-w-0">
        <ScholarHoverCard cwid={r.cwid}>
          <span className="text-sm font-semibold hover:underline">{r.name}</span>
        </ScholarHoverCard>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm leading-[1.4] text-pretty">{r.displayed ?? "—"}</span>
        <span className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
          <span className={cn(RANK_TAG, "bg-apollo-page text-foreground")}>
            rank {formatTitleRank(winningRank(r))}
          </span>
          {rule ? titleRuleLabel(rule) : "—"}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-muted-foreground text-xs md:hidden">Runner-up</span>
        {r.runnerUp ? (
          <>
            <span className="text-[13.5px] leading-[1.4] text-pretty">{r.runnerUp.value}</span>
            <span className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
              <span className={RANK_TAG}>rank {formatTitleRank(r.runnerUp.rank)}</span>
              {r.runnerUp.label}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground text-[13.5px]">No other title</span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <ul className="flex flex-wrap gap-1.5" aria-label="Why listed">
          {r.reasons.map((x) => (
            <li
              key={x}
              className={cn("rounded-full px-2 py-px text-xs whitespace-nowrap", REASON_PILL[x])}
            >
              {TITLE_REASON_LABEL[x]}
            </li>
          ))}
        </ul>
        {notes.length > 0 && (
          <p className="text-muted-foreground text-[12.5px] leading-[1.45] text-pretty">
            {notes.join(" · ")}
          </p>
        )}
      </div>
    </>
  );
}

/** The queue's loaded state: every listed row plus the per-tab counts. The
 *  page loads it once, reads `counts.review` for the nav pill and hands it to
 *  {@link TitlesQueue}. */
export type TitlesQueueData = {
  all: TitleDashboardRow[];
  counts: Record<TitleTab, number>;
};

export async function loadTitlesQueue(): Promise<TitlesQueueData> {
  const all = await loadTitleDashboard(db.read);
  const counts: Record<TitleTab, number> = { review: 0, pinned: 0, fyi: 0, all: all.length };
  for (const r of all) counts[titleTabOf(r)] += 1;
  return { all, counts };
}

export function TitlesQueue({
  data,
  session,
  searchParams,
  basePath,
}: {
  data: TitlesQueueData;
  session: Pick<EditSession, "isSuperuser" | "isCommsSteward">;
  searchParams: TitlesQueueSearchParams;
  /** `/edit/titles-queue` — for the page's own links (tabs, chips, the form). */
  basePath: string;
}) {
  const { all, counts } = data;
  const parsed = parseTitleDashboardParams(toSearchParams(searchParams));
  // The page opens on "Needs review"; the export keeps unset = every tab.
  const params: TitleDashboardParams = { ...parsed, tab: parsed.tab ?? "review" };
  const inTab = params.tab === "all" ? all.length : counts[params.tab!];
  const base = filterTitleDashboard(all, { ...params, reason: null });
  const rows = params.reason ? base.filter((r) => r.reasons.includes(params.reason!)) : base;
  const canSet = canReviewTitles(session);
  const grid = canSet ? GRID_SET : GRID_VIEW;
  const downloadHref = `${basePath}/export?${titleDashboardQueryString(params)}`;

  return (
    <div className="flex flex-col gap-5">
      <Rubric />
      <div className="flex flex-col gap-2.5">
        <Tabs basePath={basePath} params={params} counts={counts} />
        <p className="text-muted-foreground text-[13.5px]" data-testid="display-titles-tab-note">
          {TITLE_TAB_NOTE[params.tab!]}
        </p>
      </div>
      <Toolbar
        basePath={basePath}
        params={params}
        base={base}
        shown={rows.length}
        inTab={inTab}
        downloadHref={downloadHref}
      />
      <div
        className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[var(--apollo-radius-card)] border"
        data-testid="display-titles-table"
      >
        <div
          className={cn(
            "bg-apollo-page border-apollo-border-strong text-muted-foreground hidden gap-x-8 border-b px-[18px] py-2.5 text-xs tracking-[0.05em] uppercase md:grid",
            grid,
          )}
          aria-hidden
        >
          <span>Scholar</span>
          <span>Displayed title</span>
          <span>Runner-up</span>
          <span>Why listed</span>
          {canSet && <span />}
        </div>
        {rows.length === 0 ? (
          <p className="text-muted-foreground p-10 text-center text-sm">
            No scholars match these filters.
          </p>
        ) : (
          rows.map((r) => (
            <TitleRowDisclosure
              key={r.cwid}
              cwid={r.cwid}
              name={r.name}
              options={r.options}
              displayed={r.displayed}
              pinned={r.pin !== null}
              canSet={canSet}
              gridClass={grid}
            >
              <TitleRowCells r={r} />
            </TitleRowDisclosure>
          ))
        )}
      </div>
    </div>
  );
}
