/**
 * `/edit/news-queue` — the newsroom mentions approval queue, 2026-09 redesign
 * (`News Approval.dc.html`).
 *
 * Why a SEPARATE component from `components/edit/news-queue.tsx`: that one is
 * shared with `/edit/media-highlights-queue` (press clips), which has its own
 * mockup and carries the clip-only machinery (placements, possible repeats,
 * regrouping). This page only ever loads newsroom rows (`outlet` null), so it
 * renders none of that, and redesigning it here leaves the clips page as is.
 * The decision semantics are the same routes and bodies, unchanged:
 *
 *   - POST /api/edit/news-mention/decision `{ id, decision }` with approve |
 *     approve_hidden | reject. Approving a contested candidate rejects its
 *     siblings server-side, atomically.
 *   - POST /api/edit/news-mention `{ id, action: hide | show }` — the Approved
 *     tab's showOnProfile toggle (the editorial half, orthogonal to status).
 *
 * What the redesign changes:
 *   - One card per STORY (article URL): an article naming several scholars is
 *     reviewed once, with an "Approve all" when more than one mention is waiting.
 *   - A filter rail (match basis, scholar type, published year) plus a search
 *     box and a sort segmented control over the already-loaded rows. Pending is
 *     unbounded at the loader, so filtering it is complete; the history tabs are
 *     capped (NEWS_HISTORY_LIMIT) and say so.
 *   - A contested name is ONE row with a radio pick; Approve / Hide stay disabled
 *     until a scholar is picked.
 *   - An amber banner counts the contested names, with a "Show only these".
 *   - "Wrong person? Enter CWID" on a pending row stages a replacement scholar
 *     (checked against the directory); Approve / Hide then send it as `cwid` and
 *     the route credits that scholar instead (see the decision route's WRONG
 *     PERSON note).
 *   - The status bar after a decision offers Undo (POST
 *     /api/edit/news-mention/undo with the returned decision ids).
 *
 * Scraped article prose is rendered as React text nodes, never as HTML.
 */
"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { FiltersSheet } from "@/components/edit/filters-sheet";
import {
  DecisionStatusBar,
  MATCH_BASIS,
  OverridePill,
  WrongPersonControl,
  highlightName,
  postDecision,
  postUndo,
  type DecisionStep,
  type ScholarOverride,
} from "@/components/edit/news-review-shared";
import { Button } from "@/components/ui/button";
import { NEWS_HISTORY_LIMIT, sortNewsQueueGroups } from "@/lib/edit/news-queue";
import type {
  NewsQueueCounts,
  NewsQueueGroup,
  NewsQueueRow,
  NewsQueueSort,
} from "@/lib/edit/news-queue";
import { cn } from "@/lib/utils";

type Tab = "pending" | "approved" | "rejected";
/** The loader's three orderings plus the redesign's story-size ordering. */
export type NewsApprovalSort = NewsQueueSort | "people";

const SORT_OPTIONS: ReadonlyArray<readonly [NewsApprovalSort, string]> = [
  // Certainty stays first and the default: it is the shipped pending order.
  ["certainty", "Certainty"],
  ["recent", "Newest"],
  ["prominence", "Prominence"],
  ["people", "Most scholars"],
];

/** The match-basis wording, shared with the Media highlights queue. TAG is the
 *  newsroom's own attribution (slate); prose is neutral; the two weak bases
 *  (caption-only, endowed-title-only) are amber — look twice. */
const BASIS = MATCH_BASIS;
const BASIS_ORDER = ["TAG", "BODY", "CAPTION", "TITLE"];
const UNKNOWN = "__unknown__";

const VIA_TONE: Record<"slate" | "neutral" | "amber", string> = {
  slate: "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border",
  neutral: "bg-apollo-surface-2 text-foreground border-apollo-border-strong",
  amber: "bg-apollo-amber-tint text-apollo-amber border-transparent",
};

/** Likelihood tier colours — the shipped queue's green/amber/red, kept. */
const LIKELIHOOD_BADGE_CLASS: Readonly<Record<string, string>> = {
  HIGH: "border-apollo-green-tint-border bg-apollo-green-tint text-apollo-green-foreground",
  MEDIUM: "border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber",
  LOW: "border-apollo-red-tint-border bg-apollo-red-tint text-destructive",
};

function formatDate(iso: string | null): string {
  if (!iso) return "Undated";
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function initials(name: string): string {
  const words = name.split(",")[0].trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return (
    (words[0][0] ?? "") + (words.length > 1 ? (words[words.length - 1][0] ?? "") : "")
  ).toUpperCase();
}

/** Facet keys for one group. A contested group spans people, so it carries no
 *  scholar type and always passes the type facet (the reviewer must still see
 *  the rivals to pick between them). */
function facetsOf(g: NewsQueueGroup): { match: string; type: string | null; year: string } {
  const r = g.rows[0];
  return {
    match: r.matchBasis && BASIS[r.matchBasis] ? r.matchBasis : UNKNOWN,
    type: g.contested ? null : (r.roleLabel ?? UNKNOWN),
    year: r.publishedAt ? r.publishedAt.slice(0, 4) : UNKNOWN,
  };
}

export type NewsFilters = { match: string[]; type: string[]; year: string[] };
const NO_FILTERS: NewsFilters = { match: [], type: [], year: [] };

function passesFilters(
  g: NewsQueueGroup,
  f: NewsFilters,
  q: string,
  onlyContested: boolean,
): boolean {
  const k = facetsOf(g);
  if (f.match.length && !f.match.includes(k.match)) return false;
  if (f.type.length && k.type !== null && !f.type.includes(k.type)) return false;
  if (f.year.length && !f.year.includes(k.year)) return false;
  if (onlyContested && !g.contested) return false;
  if (!q) return true;
  return g.rows.some((r) =>
    `${r.scholarName} ${r.detectedName ?? ""} ${r.articleTitle}`.toLowerCase().includes(q),
  );
}

export type NewsStory = {
  key: string;
  title: string;
  url: string;
  publishedAt: string | null;
  groups: NewsQueueGroup[];
};

/**
 * Bucket already-sorted groups into one story per article URL. A story takes the
 * position of its first (best-sorted) group; "people" then re-orders stories by
 * how many mentions they hold, biggest first (stable). Exported for the test.
 */
export function buildStories(groups: NewsQueueGroup[], sort: NewsApprovalSort): NewsStory[] {
  const sorted = sortNewsQueueGroups(groups, sort === "people" ? "certainty" : sort);
  const byUrl = new Map<string, NewsStory>();
  for (const g of sorted) {
    const r = g.rows[0];
    const story = byUrl.get(r.articleUrl);
    if (story) story.groups.push(g);
    else
      byUrl.set(r.articleUrl, {
        key: r.articleUrl,
        title: r.articleTitle,
        url: r.articleUrl,
        publishedAt: r.publishedAt,
        groups: [g],
      });
  }
  const stories = [...byUrl.values()];
  return sort === "people" ? stories.sort((a, b) => b.groups.length - a.groups.length) : stories;
}

const countRows = (gs: NewsQueueGroup[]) => gs.reduce((n, g) => n + g.rows.length, 0);

export function NewsApprovalQueue({
  pending,
  approved,
  rejected,
  counts,
}: {
  pending: NewsQueueGroup[];
  approved: NewsQueueGroup[];
  rejected: NewsQueueGroup[];
  /** TRUE totals from the DB. The history props are capped at NEWS_HISTORY_LIMIT. */
  counts: NewsQueueCounts;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>("pending");
  const [sort, setSort] = useState<NewsApprovalSort>("certainty");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<NewsFilters>(NO_FILTERS);
  const [onlyContested, setOnlyContested] = useState(false);
  /** Contested group key → the candidate row id picked. */
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** Pending group key → the "Wrong person?" replacement scholar staged for it. */
  const [overrides, setOverrides] = useState<Record<string, ScholarOverride>>({});
  const [error, setError] = useState<string | null>(null);
  /** The status bar: what just happened, and the decision ids Undo would send. */
  const [toast, setToast] = useState<{ text: string; decisionIds: string[] } | null>(null);
  const [undoing, setUndoing] = useState(false);

  const q = query.trim().toLowerCase();
  const tabGroups = tab === "pending" ? pending : tab === "approved" ? approved : rejected;

  /** Pending siblings per sourceRef — the route's real blast radius when a
   *  rejected row is approved (`where: { sourceRef, status: "pending" }`). */
  const pendingBySourceRef = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of pending)
      for (const r of g.rows) if (r.sourceRef) m.set(r.sourceRef, (m.get(r.sourceRef) ?? 0) + 1);
    return m;
  }, [pending]);

  const facetCounts = useMemo(() => {
    const c = {
      match: new Map<string, number>(),
      type: new Map<string, number>(),
      year: new Map<string, number>(),
    };
    for (const g of tabGroups) {
      const k = facetsOf(g);
      const n = g.rows.length;
      c.match.set(k.match, (c.match.get(k.match) ?? 0) + n);
      if (k.type !== null) c.type.set(k.type, (c.type.get(k.type) ?? 0) + n);
      c.year.set(k.year, (c.year.get(k.year) ?? 0) + n);
    }
    return c;
  }, [tabGroups]);

  const visible = useMemo(
    () => tabGroups.filter((g) => passesFilters(g, filters, q, tab === "pending" && onlyContested)),
    [tabGroups, filters, q, tab, onlyContested],
  );
  const stories = useMemo(() => buildStories(visible, sort), [visible, sort]);

  const contestedPending = pending.filter((g) => g.contested).length;
  const activeFilterCount = filters.match.length + filters.type.length + filters.year.length;
  const anyNarrowing = activeFilterCount > 0 || q.length > 0 || onlyContested;
  const rejectedLoaded = countRows(rejected);
  const truncated = tab !== "pending" && countRows(tabGroups) >= NEWS_HISTORY_LIMIT;

  function toggle(facet: keyof NewsFilters, value: string) {
    setFilters((f) => ({
      ...f,
      [facet]: f[facet].includes(value)
        ? f[facet].filter((v) => v !== value)
        : [...f[facet], value],
    }));
  }
  function clearAll() {
    setFilters(NO_FILTERS);
    setQuery("");
    setOnlyContested(false);
  }
  function switchTab(t: Tab) {
    setTab(t);
    setFilters(NO_FILTERS);
    setOnlyContested(false);
    setToast(null);
    setError(null);
  }

  /** Run decisions sequentially (each is its own transaction + audit row), then
   *  refresh once so the rows move to their new tab. Stops at the first failure;
   *  whatever did save can still be undone from the status bar. */
  async function run(key: string, steps: DecisionStep[], done: string) {
    setError(null);
    setToast(null);
    setBusyKey(key);
    const decisionIds: string[] = [];
    let saved = 0;
    for (const step of steps) {
      const result = await postDecision(step);
      if (!result.ok) {
        setError(result.message);
        break;
      }
      if (result.decisionId) decisionIds.push(result.decisionId);
      saved += 1;
    }
    if (saved === steps.length) setToast({ text: done, decisionIds });
    else if (saved > 0)
      setToast({ text: `Saved ${saved} of ${steps.length} decisions.`, decisionIds });
    if (saved > 0) {
      // A decided group leaves Pending, so its staged override goes with it.
      setOverrides((o) => {
        const next = { ...o };
        delete next[key];
        return next;
      });
      startTransition(() => router.refresh());
    }
    setBusyKey(null);
  }

  /** The status bar's Undo: take back every decision the last click made. */
  async function undo() {
    if (!toast || toast.decisionIds.length === 0) return;
    setError(null);
    setUndoing(true);
    const result = await postUndo(toast.decisionIds);
    setUndoing(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setToast({ text: "Undone. The decision was taken back.", decisionIds: [] });
    startTransition(() => router.refresh());
  }

  async function setVisibility(row: NewsQueueRow, action: "hide" | "show") {
    setError(null);
    setToast(null);
    setBusyKey(row.id);
    try {
      const res = await fetch("/api/edit/news-mention", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id, action }),
      });
      if (!res.ok) setError("We couldn't update this mention. Please try again.");
      else startTransition(() => router.refresh());
    } catch {
      setError("We couldn't update this mention. Please try again.");
    } finally {
      setBusyKey(null);
    }
  }

  /** The row a pending group's Approve / Hide acts on: the only row, or the
   *  contested pick (null until picked). */
  const chosenRow = (g: NewsQueueGroup): NewsQueueRow | null =>
    g.contested ? (g.rows.find((r) => r.id === picks[g.key]) ?? null) : g.rows[0];

  const rail = (
    <FilterRail
      facetCounts={facetCounts}
      filters={filters}
      onToggle={toggle}
      onClear={clearAll}
      clearable={anyNarrowing}
    />
  );

  return (
    <div className="flex flex-col gap-[22px]" data-slot="news-queue">
      <div
        className="border-apollo-border-strong flex flex-wrap items-end gap-x-7 border-b"
        role="tablist"
      >
        {(
          [
            ["pending", "Pending", countRows(pending).toLocaleString("en-US")],
            ["approved", "Approved", counts.approved.toLocaleString("en-US")],
            [
              "rejected",
              "Rejected",
              `${rejectedLoaded.toLocaleString("en-US")}${rejectedLoaded >= NEWS_HISTORY_LIMIT ? "+" : ""}`,
            ],
          ] as const
        ).map(([t, label, n]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => switchTab(t)}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-0.5 pt-2.5 pb-3 text-[15px] whitespace-nowrap",
              tab === t
                ? "border-apollo-maroon text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
            data-testid={`news-queue-tab-${t}`}
          >
            {label}
            <span
              className={cn(
                "text-foreground rounded-full px-[7px] py-px text-xs tabular-nums",
                tab === t ? "bg-apollo-rail" : "bg-apollo-surface-2",
              )}
            >
              {n}
            </span>
          </button>
        ))}
      </div>

      {tab === "pending" && contestedPending > 0 ? (
        <div
          className="bg-apollo-amber-tint border-apollo-amber-tint-border flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border px-3.5 py-2.5 text-sm"
          data-testid="news-queue-contested-banner"
        >
          <span className="text-apollo-amber font-semibold tabular-nums">{contestedPending}</span>
          <span className="min-w-0 flex-1">
            {contestedPending === 1 ? "mention matches" : "mentions match"} more than one scholar
            with the same name. Pick the right person before approving.
          </span>
          <button
            type="button"
            className="text-apollo-slate whitespace-nowrap hover:underline"
            aria-pressed={onlyContested}
            onClick={() => setOnlyContested((v) => !v)}
          >
            {onlyContested ? "Show everything" : "Show only these"}
          </button>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
        <div className="hidden lg:sticky lg:top-5 lg:block">{rail}</div>

        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <FiltersSheet activeCount={activeFilterCount} testId="news-queue-filters-sheet">
              {rail}
            </FiltersSheet>
            <span
              className="text-muted-foreground text-sm"
              role="status"
              aria-live="polite"
              data-testid="news-queue-filter-count"
            >
              <span className="text-foreground font-semibold tabular-nums">
                {countRows(visible).toLocaleString("en-US")}
              </span>{" "}
              mention{countRows(visible) === 1 ? "" : "s"} in{" "}
              <span className="text-foreground font-semibold tabular-nums">
                {stories.length.toLocaleString("en-US")}
              </span>{" "}
              stor{stories.length === 1 ? "y" : "ies"}
            </span>
            <div className="flex w-full flex-wrap items-center gap-2.5 sm:ml-auto sm:w-auto">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Scholar or story…"
                aria-label="Search scholar or story"
                className="border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-lg border px-2.5 text-[13.5px] outline-none sm:w-[200px]"
                data-testid="news-queue-name-filter"
              />
              <span className="text-muted-foreground text-[13px]">Sort</span>
              <div
                role="group"
                aria-label="Sort"
                className="bg-apollo-surface-2 border-apollo-border flex flex-wrap gap-0.5 rounded-lg border p-[3px]"
                data-testid="news-queue-sort"
              >
                {SORT_OPTIONS.map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={sort === k}
                    onClick={() => setSort(k)}
                    className={cn(
                      "rounded-md px-[11px] py-1 text-[13px] whitespace-nowrap",
                      sort === k
                        ? "bg-apollo-surface text-foreground shadow-[var(--apollo-shadow-card)]"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {tab === "approved" ? (
            <p className="text-muted-foreground text-sm" data-testid="news-queue-approved-counts">
              {counts.approved.toLocaleString("en-US")} approved ·{" "}
              {counts.approvedHidden.toLocaleString("en-US")} hidden
            </p>
          ) : null}
          {truncated ? (
            <p className="text-muted-foreground text-sm">
              Showing the {NEWS_HISTORY_LIMIT} most recent — older mentions are not listed here, but
              still show on their profiles.
            </p>
          ) : null}

          {error ? (
            <p
              className="border-apollo-red-tint-border bg-apollo-red-tint text-destructive rounded-md border px-3 py-2 text-sm"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {toast ? (
            <DecisionStatusBar
              text={toast.text}
              canUndo={toast.decisionIds.length > 0}
              undoing={undoing}
              onUndo={() => void undo()}
              onDismiss={() => setToast(null)}
              testId="news-queue-toast"
            />
          ) : null}

          {stories.length === 0 ? (
            <div className="bg-apollo-surface border-apollo-border-strong text-muted-foreground rounded-[var(--apollo-radius-card)] border p-10 text-center text-sm">
              {tab === "pending"
                ? anyNarrowing
                  ? "Nothing left to review with these filters."
                  : "Nothing left to review."
                : anyNarrowing
                  ? "No mentions match these filters."
                  : "Nothing here yet."}
            </div>
          ) : (
            stories.map((story) => (
              <StoryCard
                key={story.key}
                story={story}
                tab={tab}
                busyKey={busyKey}
                picks={picks}
                pendingBySourceRef={pendingBySourceRef}
                chosenRow={chosenRow}
                overrides={overrides}
                onPick={(groupKey, rowId) => setPicks((p) => ({ ...p, [groupKey]: rowId }))}
                onOverride={(groupKey, o) =>
                  setOverrides((prev) => {
                    const next = { ...prev };
                    if (o) next[groupKey] = o;
                    else delete next[groupKey];
                    return next;
                  })
                }
                onRun={run}
                onVisibility={setVisibility}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function FilterRail({
  facetCounts,
  filters,
  onToggle,
  onClear,
  clearable,
}: {
  facetCounts: { match: Map<string, number>; type: Map<string, number>; year: Map<string, number> };
  filters: NewsFilters;
  onToggle: (facet: keyof NewsFilters, value: string) => void;
  onClear: () => void;
  clearable: boolean;
}) {
  const matchItems = [...BASIS_ORDER, UNKNOWN]
    .filter((k) => facetCounts.match.has(k))
    .map((k) => ({
      value: k,
      label: k === UNKNOWN ? "Not recorded" : BASIS[k].label,
      count: facetCounts.match.get(k)!,
    }));
  const typeItems = [...facetCounts.type]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ value: k, label: k === UNKNOWN ? "No role" : k, count: n }));
  const yearItems = [...facetCounts.year]
    .sort((a, b) => (a[0] === UNKNOWN ? 1 : b[0] === UNKNOWN ? -1 : b[0].localeCompare(a[0])))
    .map(([k, n]) => ({ value: k, label: k === UNKNOWN ? "Undated" : k, count: n }));
  const groups: Array<{ facet: keyof NewsFilters; label: string; items: typeof matchItems }> = [
    { facet: "match", label: "Match", items: matchItems },
    { facet: "type", label: "Scholar type", items: typeItems },
    { facet: "year", label: "Published", items: yearItems },
  ];
  return (
    <aside
      className="bg-apollo-rail border-apollo-border-strong flex flex-col gap-[22px] rounded-[var(--apollo-radius-card)] border px-5 pt-[18px] pb-5"
      data-testid="news-queue-rail"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-muted-foreground text-xs font-medium tracking-[0.12em] uppercase">
          Filters
        </span>
        <button
          type="button"
          onClick={onClear}
          className={cn(
            "text-[13px]",
            clearable ? "text-apollo-slate hover:underline" : "text-muted-foreground",
          )}
        >
          Clear
        </button>
      </div>
      {groups.map((g) =>
        g.items.length === 0 ? null : (
          <fieldset key={g.facet} className="flex flex-col gap-0.5">
            <legend className="text-muted-foreground mb-1.5 text-xs font-medium tracking-[0.12em] uppercase">
              {g.label}
            </legend>
            {g.items.map((item) => (
              <label
                key={item.value}
                className="flex cursor-pointer items-center gap-2.5 py-1 text-sm"
              >
                <input
                  type="checkbox"
                  checked={filters[g.facet].includes(item.value)}
                  onChange={() => onToggle(g.facet, item.value)}
                  className="m-0 size-4 flex-none cursor-pointer accent-[var(--color-primary-cornell-red)]"
                />
                <span className="min-w-0 flex-1 leading-snug">{item.label}</span>
                <span className="text-muted-foreground text-[13px] tabular-nums">{item.count}</span>
              </label>
            ))}
          </fieldset>
        ),
      )}
    </aside>
  );
}

type RunFn = (key: string, steps: DecisionStep[], done: string) => void;

/** The step a pending group's Approve / Hide sends: the chosen row, or — with a
 *  "Wrong person?" override — any of the group's rows plus the replacement CWID
 *  (the route rejects the whole contested name and credits the override). Null
 *  while a contested name has neither a pick nor an override. */
function approveStep(
  g: NewsQueueGroup,
  chosen: NewsQueueRow | null,
  override: ScholarOverride | undefined,
  decision: "approve" | "approve_hidden",
): DecisionStep | null {
  if (override) return { id: (chosen ?? g.rows[0]).id, decision, cwid: override.cwid };
  return chosen ? { id: chosen.id, decision } : null;
}

function StoryCard({
  story,
  tab,
  busyKey,
  picks,
  pendingBySourceRef,
  chosenRow,
  overrides,
  onPick,
  onOverride,
  onRun,
  onVisibility,
}: {
  story: NewsStory;
  tab: Tab;
  busyKey: string | null;
  picks: Record<string, string>;
  pendingBySourceRef: Map<string, number>;
  chosenRow: (g: NewsQueueGroup) => NewsQueueRow | null;
  overrides: Record<string, ScholarOverride>;
  onPick: (groupKey: string, rowId: string) => void;
  onOverride: (groupKey: string, o: ScholarOverride | null) => void;
  onRun: RunFn;
  onVisibility: (row: NewsQueueRow, action: "hide" | "show") => void;
}) {
  const busy = busyKey !== null;
  // "Approve all": every waiting mention that can be approved right now — a
  // contested name only once a scholar has been picked (or overridden) for it.
  const ready =
    tab === "pending"
      ? story.groups
          .map((g) => approveStep(g, chosenRow(g), overrides[g.key], "approve"))
          .filter((st): st is DecisionStep => st !== null)
      : [];
  const multi = tab === "pending" && story.groups.length > 1;
  return (
    <article
      className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[var(--apollo-radius-card)] border"
      data-testid={`news-queue-story-${story.key}`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 pt-4 pb-3 sm:px-5">
        <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className="text-muted-foreground text-[12.5px]">
            <span className="text-foreground font-semibold">WCM Newsroom</span> ·{" "}
            {formatDate(story.publishedAt)}
          </span>
          <a
            href={story.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-apollo-slate text-[16.5px] leading-snug font-semibold [text-wrap:pretty]"
          >
            {story.title} <span className="text-muted-foreground text-xs font-normal">↗</span>
          </a>
        </div>
        {multi ? (
          <div className="flex flex-none items-center gap-2 pt-0.5">
            <span className="text-muted-foreground text-[12.5px] whitespace-nowrap">
              {story.groups.length} scholars named
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || ready.length === 0}
              onClick={() =>
                onRun(
                  story.key,
                  ready,
                  `Approved ${ready.length} mention${ready.length === 1 ? "" : "s"} in “${story.title}”.`,
                )
              }
              className="border-apollo-slate text-apollo-slate hover:bg-apollo-slate-tint hover:text-apollo-slate h-[30px] text-[13px]"
              data-testid={`news-queue-approve-all-${story.key}`}
            >
              Approve all
            </Button>
          </div>
        ) : null}
      </div>
      {tab === "pending"
        ? story.groups.map((g) => (
            <PendingMention
              key={g.key}
              group={g}
              story={story}
              busy={busy}
              pick={picks[g.key] ?? null}
              chosen={chosenRow(g)}
              override={overrides[g.key] ?? null}
              onPick={onPick}
              onOverride={onOverride}
              onRun={onRun}
            />
          ))
        : story.groups.flatMap((g) =>
            g.rows.map((row) => (
              <DecidedMention
                key={row.id}
                row={row}
                tab={tab}
                busy={busy}
                competing={row.sourceRef ? (pendingBySourceRef.get(row.sourceRef) ?? 0) : 0}
                onRun={onRun}
                onVisibility={onVisibility}
              />
            )),
          )}
    </article>
  );
}

/** The identity column shared by every mention row: avatar, name + CWID + the
 *  likelihood / via pills, the role line, and the name-in-context snippet. */
function Identity({
  row,
  displayName,
  override,
  roleLine,
  showPills,
  note,
  children,
}: {
  row: NewsQueueRow;
  displayName?: string;
  /** A staged "Wrong person?" replacement: shown instead of the row's scholar. */
  override?: { name: string; cwid: string; was: string | null } | null;
  roleLine: string;
  showPills: boolean;
  note?: string | null;
  children?: ReactNode;
}) {
  const basis = row.matchBasis ? BASIS[row.matchBasis] : undefined;
  const name = override?.name ?? displayName ?? row.scholarName;
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div
        aria-hidden
        className="bg-apollo-surface-2 text-apollo-bar ring-apollo-border-strong flex size-[34px] flex-none items-center justify-center rounded-full text-xs font-semibold ring-1"
      >
        {initials(name)}
      </div>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <div className="flex flex-wrap items-center gap-2">
          {override ? (
            <>
              <span className="text-[14.5px] font-semibold">{name}</span>
              <span className="text-muted-foreground font-mono text-[12.5px]">{override.cwid}</span>
              <OverridePill was={override.was} />
            </>
          ) : displayName === undefined && row.slug ? (
            <a
              href={`/${row.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-apollo-slate text-[14.5px] font-semibold"
            >
              {name}
            </a>
          ) : (
            <span className="text-[14.5px] font-semibold">{name}</span>
          )}
          {!override && displayName === undefined ? (
            <span className="text-muted-foreground font-mono text-[12.5px]">{row.cwid}</span>
          ) : null}
          {row.source === "VIVO" ? (
            <span
              className="text-muted-foreground border-apollo-border-strong rounded-full border px-2 py-px text-[11.5px] whitespace-nowrap"
              title="Linked by VIVO cwid — published automatically, never queued"
            >
              VIVO link
            </span>
          ) : null}
          {showPills && row.source !== "VIVO" && row.likelihood ? (
            <span
              className={cn(
                "rounded-full border px-2 py-px text-[11.5px] font-semibold",
                LIKELIHOOD_BADGE_CLASS[row.likelihood] ??
                  "text-muted-foreground border-transparent",
              )}
              data-testid={`news-queue-likelihood-${row.likelihood}`}
            >
              {row.likelihood}
            </span>
          ) : null}
          {showPills && row.source !== "VIVO" && basis ? (
            <span
              className={cn(
                "rounded-full border px-2 py-px text-[11.5px] whitespace-nowrap",
                VIA_TONE[basis.tone],
              )}
              title={basis.hint}
              data-testid={`news-queue-basis-${row.matchBasis}`}
            >
              {basis.label}
            </span>
          ) : null}
        </div>
        <span className="text-muted-foreground text-[12.5px]">
          {roleLine}
          {note ? ` · ${note}` : ""}
        </span>
        {row.contextSnippet ? (
          <p className="border-apollo-border-strong text-muted-foreground mt-1 border-l-2 pl-2.5 text-[13px] leading-normal">
            {highlightName(row.contextSnippet, row.contextSnippetMatches)}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

const roleLineOf = (r: NewsQueueRow) =>
  [r.title, r.department, r.roleLabel].filter(Boolean).join(" · ") || "—";

function PendingMention({
  group,
  story,
  busy,
  pick,
  chosen,
  override,
  onPick,
  onOverride,
  onRun,
}: {
  group: NewsQueueGroup;
  story: NewsStory;
  busy: boolean;
  pick: string | null;
  chosen: NewsQueueRow | null;
  override: ScholarOverride | null;
  onPick: (groupKey: string, rowId: string) => void;
  onOverride: (groupKey: string, o: ScholarOverride | null) => void;
  onRun: RunFn;
}) {
  const head = group.rows[0];
  const approve = approveStep(group, chosen, override ?? undefined, "approve");
  const hideStep = approveStep(group, chosen, override ?? undefined, "approve_hidden");
  const blocked = approve === null;
  const matched = chosen?.scholarName ?? group.detectedName ?? head.scholarName;
  const who = override ? (override.name ?? override.cwid) : matched;
  const wrongPerson = (
    <WrongPersonControl
      override={override}
      disabled={busy}
      onApply={(o) => onOverride(group.key, o)}
      onClear={() => onOverride(group.key, null)}
      testId={`news-queue-override-${group.key}`}
    />
  );
  const identity = override ? (
    // The reviewer named someone else: show them, and drop the candidate pick.
    <Identity
      row={chosen ?? head}
      override={{
        name: override.name ?? "Unverified CWID",
        cwid: override.cwid,
        was: chosen?.cwid ?? (group.contested ? null : head.cwid),
      }}
      roleLine={
        override.name
          ? "Manual override"
          : "Manual override · will be checked against the directory on save"
      }
      showPills
    >
      {wrongPerson}
    </Identity>
  ) : group.contested ? (
    <Identity
      row={chosen ?? head}
      displayName={
        chosen ? undefined : (group.detectedName ?? head.detectedName ?? "Unresolved name")
      }
      roleLine={
        chosen ? roleLineOf(chosen) : `Name matches ${group.rows.length} scholars · Pick one below`
      }
      showPills
    >
      {wrongPerson}
      <div
        className="bg-apollo-amber-tint border-apollo-amber-tint-border mt-1.5 flex flex-col gap-1.5 rounded-lg border px-2.5 py-2"
        role="radiogroup"
        aria-label={`Which scholar is “${group.detectedName ?? head.scholarName}”?`}
        data-testid={`news-queue-contested-${group.key}`}
      >
        <span className="text-apollo-amber text-[12.5px] font-semibold">
          This name matches {group.rows.length} scholars. Which one is it?
        </span>
        {group.rows.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-start gap-2 text-[13px]">
            <input
              type="radio"
              name={`news-pick-${group.key}`}
              checked={pick === r.id}
              disabled={busy}
              onChange={() => onPick(group.key, r.id)}
              className="mt-0.5 accent-[var(--color-primary-cornell-red)]"
              aria-label={r.scholarName}
            />
            <span>
              <span className="font-medium">{r.scholarName}</span>{" "}
              <span className="text-muted-foreground font-mono text-[11.5px]">{r.cwid}</span>
              <span className="text-muted-foreground block text-[12.5px]">{roleLineOf(r)}</span>
            </span>
          </label>
        ))}
      </div>
    </Identity>
  ) : (
    <Identity row={head} roleLine={roleLineOf(head)} showPills>
      {wrongPerson}
    </Identity>
  );
  const approvedText = override
    ? `Approved “${story.title}” for ${who}, not ${matched}.`
    : `Approved ${who} in “${story.title}”.`;
  return (
    <div
      className="border-apollo-border bg-apollo-surface flex flex-col gap-3 border-t px-4 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4 sm:px-5"
      data-testid={`news-queue-group-${group.key}`}
    >
      {identity}
      <div className="flex flex-wrap items-start gap-1.5">
        <Button
          size="sm"
          disabled={busy || blocked}
          title={blocked ? "Pick which scholar first" : undefined}
          onClick={() => approve && onRun(group.key, [approve], approvedText)}
          className={cn(
            "h-[30px] text-[13px] text-white",
            blocked ? "bg-apollo-border-strong" : "bg-apollo-slate hover:bg-apollo-slate/90",
          )}
          data-testid={`news-queue-approve-${group.key}`}
        >
          Approve
        </Button>
        {/* Approve + hide in ONE write: confirmed as this scholar (leaves the
            queue, rejects contested siblings) but lands in Approved as Hidden and
            never renders on the profile. Un-hide from the Approved tab. */}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || blocked}
          title="Approve, but keep it off the profile"
          aria-label={`Approve “${story.title}” for ${who} but hide it from their profile`}
          onClick={() => hideStep && onRun(group.key, [hideStep], `Approved and hidden: ${who}.`)}
          className="border-apollo-border-strong h-[30px] text-[13px] font-normal"
          data-testid={
            chosen
              ? `news-queue-approve-hidden-${chosen.id}`
              : `news-queue-approve-hidden-${group.key}`
          }
        >
          Hide
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            onRun(
              group.key,
              group.rows.map((r) => ({ id: r.id, decision: "reject" })),
              group.contested
                ? `Rejected every match for “${group.detectedName ?? head.scholarName}”.`
                : `Rejected ${matched} in “${story.title}”.`,
            )
          }
          className="text-destructive hover:bg-apollo-red-tint hover:text-destructive h-[30px] text-[13px] font-normal"
        >
          {group.contested ? "None of these" : "Reject"}
        </Button>
      </div>
    </div>
  );
}

function DecidedMention({
  row,
  tab,
  busy,
  competing,
  onRun,
  onVisibility,
}: {
  row: NewsQueueRow;
  tab: "approved" | "rejected";
  busy: boolean;
  /** Pending rows this approval would reject (the route's sweep). */
  competing: number;
  onRun: RunFn;
  onVisibility: (row: NewsQueueRow, action: "hide" | "show") => void;
}) {
  // Neutral attribution on Approved: `entered_by_cwid` is the last human to touch
  // the row, not necessarily who chose its visibility.
  const note =
    tab === "approved" && row.decidedByName ? `last updated by ${row.decidedByName}` : null;
  const blastNote = `Rejects ${competing} other candidate${competing === 1 ? "" : "s"} matched to this name.`;
  return (
    <div className="border-apollo-border bg-apollo-surface flex flex-col gap-3 border-t px-4 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4 sm:px-5">
      <Identity row={row} roleLine={roleLineOf(row)} showPills note={note} />
      {tab === "approved" ? (
        <div className="flex flex-wrap items-start gap-1.5">
          <span
            className={cn(
              "rounded-full px-2.5 py-[3px] text-[12.5px] whitespace-nowrap",
              row.showOnProfile
                ? "bg-apollo-slate-tint text-apollo-slate"
                : "bg-apollo-surface-2 text-foreground",
            )}
            data-testid={`news-queue-visibility-${row.id}`}
          >
            {row.showOnProfile ? "On profile" : "Approved, hidden"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`${row.showOnProfile ? "Hide" : "Show"} “${row.articleTitle}” on ${row.scholarName}'s profile`}
            onClick={() => onVisibility(row, row.showOnProfile ? "hide" : "show")}
            className="border-apollo-border-strong h-[30px] text-[13px] font-normal"
          >
            {row.showOnProfile ? "Hide" : "Show"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1 sm:items-end">
          {row.declinedByScholar ? (
            <p
              className="text-apollo-amber max-w-[15rem] text-[11.5px] font-medium sm:text-right"
              data-testid={`news-queue-declined-${row.id}`}
            >
              The scholar declined this mention themselves.
            </p>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-describedby={competing > 0 ? `news-blast-${row.id}` : undefined}
            onClick={() =>
              onRun(
                row.id,
                [{ id: row.id, decision: "approve" }],
                `Approved ${row.scholarName} in “${row.articleTitle}”.`,
              )
            }
            className="border-apollo-slate text-apollo-slate hover:bg-apollo-slate-tint hover:text-apollo-slate h-[30px] text-[13px]"
          >
            Approve
          </Button>
          {competing > 0 ? (
            <p
              id={`news-blast-${row.id}`}
              className="text-muted-foreground max-w-[15rem] text-[11.5px] sm:text-right"
              data-testid={`news-queue-blast-${row.id}`}
            >
              {blastNote}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
