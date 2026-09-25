/**
 * The Media highlights review queue (client) — `/edit/media-highlights-queue`,
 * redesigned to `Media Highlights.dc.html` (2026-09-25). Same loader
 * (`loadNewsQueue(…, "clips")`), same decision / visibility / grouping routes
 * as the newsroom queue (`components/edit/news-queue.tsx`); only the reviewer
 * surface differs:
 *
 *   - Tabs carry their counts (Pending · Approved · Rejected).
 *   - A filter rail: match certainty, scholar type, possible duplicates — plus
 *     the keyboard legend. Phones get the rail in the shared `FiltersSheet`.
 *   - Toolbar: Select all, the shown count, a name search, the sort segments.
 *   - One card per clip: outlet · date, headline, the name-in-context snippet
 *     with the name marked; the matched scholar on the right; Approve /
 *     Approve but hide / Reject in the card footer.
 *   - A focused card (click, or J / K) takes A / H / R from the keyboard.
 *   - Ticked cards go through the dark bulk bar at the bottom. A selection is
 *     capped at NEWS_UNDO_MAX_DECISIONS (Select all picks the first that many),
 *     so a bulk action's Undo is always one all-or-nothing call.
 *   - A dark status bar confirms each decision and offers Undo (POST
 *     /api/edit/news-mention/undo with the decision ids the route returned),
 *     also for the part of a "None of these" that saved when the rest failed.
 *   - "Wrong person? Reassign" on a pending card searches the directory for the
 *     right scholar; Approve / Approve but hide / A / H and the bulk bar then
 *     credit that scholar instead (the decision route's `cwid`). A staged pick
 *     is dropped when a refresh turns its group contested.
 *
 * Everything filterable is ALREADY in the props: Pending is loaded unbounded
 * (only the history tabs are capped at NEWS_HISTORY_LIMIT), so filtering and
 * sorting client-side can never show a partial view of Pending. Every decision
 * POSTs and then `router.refresh()`es (the page is force-dynamic).
 *
 * Contested groups (one detected name, several scholars) keep their shipped
 * semantics: no plain Approve, a per-candidate "This is the one", and "None of
 * these". They are never bulk-selectable and ignore A / H / R — picking the
 * right person is exactly the judgement a shortcut must not make.
 */
"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import {
  DecisionStatusBar,
  MATCH_BASIS,
  highlightName,
  lookupScholar,
  postDecision,
  postUndo,
  type DecisionStep,
  type ReviewDecision,
  type ScholarOverride,
} from "@/components/edit/news-review-shared";
import { mapChunked } from "@/components/edit/selection-bar";
import { NEWS_UNDO_MAX_DECISIONS } from "@/lib/edit/news-undo-limit";
import { Button } from "@/components/ui/button";
import { NEWS_HISTORY_LIMIT, sortNewsQueueGroups } from "@/lib/edit/news-queue";
import type {
  NewsQueueCounts,
  NewsQueueGroup,
  NewsQueueRow,
  NewsQueueSort,
} from "@/lib/edit/news-queue";
import { CAREER_STAGE_ORDER } from "@/lib/role-display";
import { cn, initials } from "@/lib/utils";

type Tab = "pending" | "approved" | "rejected";
type Decision = ReviewDecision;
type RegroupOp = "ungroup" | "make_lead" | "group";

const TIERS = ["HIGH", "MEDIUM", "LOW"] as const;
const TIER_LABEL: Record<string, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };

/** The certainty pill's tones, per the mockup: slate for High, amber for
 *  everything else (look twice). */
const TIER_PILL: Readonly<Record<string, string>> = {
  HIGH: "border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate",
  MEDIUM: "border-transparent bg-apollo-amber-tint text-apollo-amber",
  LOW: "border-transparent bg-apollo-amber-tint text-apollo-amber",
};

const SORTS: ReadonlyArray<{ value: NewsQueueSort; label: string }> = [
  { value: "certainty", label: "Certainty" },
  { value: "recent", label: "Newest" },
  { value: "prominence", label: "Prominence" },
];

const KEYS: ReadonlyArray<[string, string]> = [
  ["J / K", "Next / previous"],
  ["A", "Approve"],
  ["H", "Approve but hide"],
  ["R", "Reject"],
];

const VERB: Record<Decision, string> = {
  approve: "Approved",
  approve_hidden: "Approved and hidden",
  reject: "Rejected",
};

/** `lead.status` → the article in "a pending clip" / "an approved clip". */
const CLIP_STATUS: Record<string, string> = {
  pending: "a pending clip",
  published: "an approved clip",
  rejected: "a rejected clip",
};

const UNKNOWN_TYPE = "Other";

function formatDate(iso: string | null): string {
  if (!iso) return "Undated";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const typeOf = (r: NewsQueueRow) => r.roleLabel ?? UNKNOWN_TYPE;
const isDuplicate = (r: NewsQueueRow) => r.possibleRepeatOf !== null || r.leadOf !== null;
const rowCount = (gs: ReadonlyArray<NewsQueueGroup>) => gs.reduce((n, g) => n + g.rows.length, 0);

function toggleIn(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

type Filters = { cert: ReadonlySet<string>; type: ReadonlySet<string>; dup: boolean };
const NO_FILTERS: Filters = { cert: new Set(), type: new Set(), dup: false };

function rowPasses(r: NewsQueueRow, f: Filters): boolean {
  return (
    (f.cert.size === 0 || f.cert.has(r.likelihood ?? "")) &&
    (f.type.size === 0 || f.type.has(typeOf(r))) &&
    (!f.dup || isDuplicate(r))
  );
}

/** Keep a group when ANY candidate passes: on a contested group the reviewer
 *  must still see the rivals of the one they searched for. */
function groupPasses(g: NewsQueueGroup, f: Filters, query: string): boolean {
  const q = query.trim().toLowerCase();
  return g.rows.some(
    (r) =>
      rowPasses(r, f) &&
      (!q ||
        r.scholarName.toLowerCase().includes(q) ||
        (r.detectedName ?? "").toLowerCase().includes(q)),
  );
}

const checkboxClass = "accent-apollo-maroon size-4 shrink-0 cursor-pointer";
const slateButton =
  "border-apollo-slate bg-apollo-slate text-white hover:border-apollo-bar hover:bg-apollo-bar border";

export function MediaHighlightsQueue({
  pending,
  approved,
  rejected,
  counts,
}: {
  pending: NewsQueueGroup[];
  approved: NewsQueueGroup[];
  rejected: NewsQueueGroup[];
  /** TRUE totals from the DB — the history props are capped. */
  counts: NewsQueueCounts;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>("pending");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<NewsQueueSort>("certainty");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(pending[0]?.key ?? null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** The status bar: what just happened, and the decision ids Undo would send. */
  const [toast, setToast] = useState<{ text: string; decisionIds: string[] } | null>(null);
  const [undoing, setUndoing] = useState(false);
  /** Pending group key -> the "Wrong person? Reassign" scholar staged for it. */
  const [overrides, setOverrides] = useState<Record<string, ScholarOverride>>({});
  // A refresh can turn a staged group contested (the nightly match added a second
  // candidate) or decide it elsewhere. Reassign is offered on uncontested cards
  // only, so a staged pick on such a group is dropped rather than left to ride
  // along on its next Approve. Adjusted during render, on the new `pending` prop.
  const [overridesFor, setOverridesFor] = useState(pending);
  if (overridesFor !== pending) {
    setOverridesFor(pending);
    const open = new Set(pending.filter((g) => !g.contested).map((g) => g.key));
    if (Object.keys(overrides).some((k) => !open.has(k))) {
      setOverrides((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => open.has(k))));
    }
  }
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const base = tab === "pending" ? pending : tab === "approved" ? approved : rejected;
  const baseRows = useMemo(() => base.flatMap((g) => g.rows), [base]);

  const visible = useMemo(() => {
    const kept = base.filter((g) => groupPasses(g, filters, query));
    // Sort is Pending-only: the history tabs keep the loader's recency order.
    return tab === "pending" ? sortNewsQueueGroups(kept, sort) : kept;
  }, [base, filters, query, sort, tab]);
  const visibleKeys = visible.map((g) => g.key);
  const focused = focusKey && visibleKeys.includes(focusKey) ? focusKey : null;

  /** Pending rows per scholar — "3 clips pending" on the card. */
  const pendingByCwid = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of pending) for (const r of g.rows) m.set(r.cwid, (m.get(r.cwid) ?? 0) + 1);
    return m;
  }, [pending]);

  /** Pending rows per sourceRef — the set approving a rejected row would sweep. */
  const pendingBySourceRef = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of pending)
      for (const r of g.rows) if (r.sourceRef) m.set(r.sourceRef, (m.get(r.sourceRef) ?? 0) + 1);
    return m;
  }, [pending]);

  const typeOptions = useMemo(() => {
    const labels = [...new Set(baseRows.map(typeOf))];
    const rank = (l: string) => {
      const i = CAREER_STAGE_ORDER.indexOf(l);
      return i < 0 ? CAREER_STAGE_ORDER.length : i;
    };
    return labels.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [baseRows]);

  const activeFilterCount = filters.cert.size + filters.type.size + (filters.dup ? 1 : 0);
  const filtered = activeFilterCount > 0 || query.trim() !== "";

  // Selection: Pending only, uncontested groups only, and only what is on screen.
  const selectable = tab === "pending" ? visible.filter((g) => !g.contested) : [];
  const selectedVisible = selectable.filter((g) => selected.has(g.key));
  // One bulk action is at most what one Undo call takes back (the route's cap),
  // so its Undo stays a single all-or-nothing request. Select all picks the
  // first NEWS_UNDO_MAX_DECISIONS cards on screen.
  const selectAllTargets = selectable.slice(0, NEWS_UNDO_MAX_DECISIONS);
  const allSelected =
    selectAllTargets.length > 0 && selectAllTargets.every((g) => selected.has(g.key));
  const atCap = selectedVisible.length >= NEWS_UNDO_MAX_DECISIONS;

  function switchTab(t: Tab) {
    setTab(t);
    setSelected(new Set());
    setFocusKey(null);
    setError(null);
  }

  /** The card focus lands on once `keys` leave the list. */
  function nextFocusAfter(keys: ReadonlyArray<string>): string | null {
    const last = visibleKeys.indexOf(keys[keys.length - 1] ?? "");
    const rest = visibleKeys.filter((k) => !keys.includes(k));
    return rest[Math.max(0, last - keys.length + 1)] ?? rest[rest.length - 1] ?? null;
  }

  /** POST one decision: `failure` is the reviewer-facing message, or null. */
  async function post(
    step: DecisionStep,
  ): Promise<{ failure: string | null; decisionId: string | null }> {
    const result = await postDecision(step, "clip");
    return result.ok
      ? { failure: null, decisionId: result.decisionId }
      : { failure: result.message, decisionId: null };
  }

  /** The step for one row: an approval carries the group's staged reassign. */
  function stepFor(row: NewsQueueRow, decision: Decision, groupKey?: string): DecisionStep {
    const o = groupKey ? overrides[groupKey] : undefined;
    return o && decision !== "reject"
      ? { id: row.id, decision, cwid: o.cwid }
      : { id: row.id, decision };
  }

  function dropOverrides(keys: ReadonlyArray<string>) {
    setOverrides((prev) => {
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }

  /** The status bar's Undo: take back every decision the last action made. */
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

  function markBusy(ids: ReadonlyArray<string>, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  /** One row's decision; `groupKey` moves focus on to the next card. */
  async function decideOne(row: NewsQueueRow, decision: Decision, groupKey?: string) {
    setError(null);
    const step = stepFor(row, decision, groupKey);
    const o = step.cwid && groupKey ? overrides[groupKey] : undefined;
    markBusy([row.id], true);
    const { failure, decisionId } = await post(step);
    markBusy([row.id], false);
    if (failure) {
      setError(failure);
      return;
    }
    setToast({
      text: o
        ? `${VERB[decision]}: “${row.articleTitle}” for ${o.name ?? o.cwid}, reassigned from ${row.scholarName}.`
        : `${VERB[decision]}: “${row.articleTitle}” for ${row.scholarName}.`,
      decisionIds: decisionId ? [decisionId] : [],
    });
    if (groupKey) {
      dropOverrides([groupKey]);
      setFocusKey(nextFocusAfter([groupKey]));
    }
    startTransition(() => router.refresh());
  }

  /** "None of these": reject every candidate in a contested group. */
  async function rejectGroup(g: NewsQueueGroup) {
    setError(null);
    const ids = g.rows.map((r) => r.id);
    markBusy(ids, true);
    const results = await mapChunked(ids, (id) => post({ id, decision: "reject" }));
    markBusy(ids, false);
    const decisionIds = results.flatMap((r) => (r.decisionId ? [r.decisionId] : []));
    const failed = results.map((r) => r.failure).filter(Boolean);
    if (failed.length > 0) {
      setError(failed[0]);
      // Some rejections did save: they can still be taken back.
      const saved = results.length - failed.length;
      if (saved > 0) {
        setToast({
          text: `Rejected ${saved} of ${ids.length} candidates for “${g.rows[0]!.articleTitle}”.`,
          decisionIds,
        });
      }
    } else {
      setToast({ text: `Rejected every candidate for “${g.rows[0]!.articleTitle}”.`, decisionIds });
      setFocusKey(nextFocusAfter([g.key]));
    }
    startTransition(() => router.refresh());
  }

  async function decideBulk(decision: Decision) {
    const groups = selectedVisible;
    if (groups.length === 0) return;
    setError(null);
    if (groups.length > NEWS_UNDO_MAX_DECISIONS) {
      // The selection UI stops here; this guards a selection built before it.
      setError(
        `Select at most ${NEWS_UNDO_MAX_DECISIONS} clips at a time, so the action can be undone in one step.`,
      );
      return;
    }
    const ids = groups.map((g) => g.rows[0]!.id);
    markBusy(ids, true);
    const results = await mapChunked(groups, (g) => post(stepFor(g.rows[0]!, decision, g.key)));
    markBusy(ids, false);
    const failures = results.map((r) => r.failure);
    const decisionIds = results.flatMap((r) => (r.decisionId ? [r.decisionId] : []));
    const failedKeys = groups.filter((_, i) => failures[i]).map((g) => g.key);
    const okCount = groups.length - failedKeys.length;
    setSelected(new Set(failedKeys));
    if (failedKeys.length > 0) {
      setError(
        `${failedKeys.length} of ${groups.length} clips could not be recorded and are still selected. ` +
          failures.find(Boolean),
      );
    }
    if (okCount > 0) {
      setToast({
        text: `${VERB[decision]} ${okCount} clip${okCount === 1 ? "" : "s"}.`,
        decisionIds,
      });
      dropOverrides(groups.map((g) => g.key).filter((k) => !failedKeys.includes(k)));
      setFocusKey(nextFocusAfter(groups.map((g) => g.key).filter((k) => !failedKeys.includes(k))));
    }
    startTransition(() => router.refresh());
  }

  async function setVisibility(row: NewsQueueRow, action: "hide" | "show") {
    setError(null);
    markBusy([row.id], true);
    try {
      const res = await fetch("/api/edit/news-mention", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id, action }),
      });
      if (!res.ok) {
        setError("We couldn't update this clip. Please try again.");
        return;
      }
      // The Hide / Show toggle is its own undo: no decision ids.
      setToast({
        text: `${action === "hide" ? "Hidden" : "Shown"}: “${row.articleTitle}” for ${row.scholarName}.`,
        decisionIds: [],
      });
      startTransition(() => router.refresh());
    } catch {
      setError("We couldn't update this clip. Please try again.");
    } finally {
      markBusy([row.id], false);
    }
  }

  async function regroup(op: RegroupOp, id: string, leadId?: string) {
    setError(null);
    markBusy([id], true);
    try {
      const res = await fetch("/api/edit/news-mention/group", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, id, leadId }),
      });
      if (!res.ok) {
        setError("We couldn't regroup that clip. Please try again.");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("We couldn't regroup that clip. Please try again.");
    } finally {
      markBusy([id], false);
    }
  }

  // Keyboard: J / K move focus, A / H / R decide the focused (uncontested,
  // pending) card. A ref keeps the listener registered once while always
  // reading this render's state.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    // Typing into a field never triggers a shortcut; a ticked checkbox or a
    // clicked button keeps focus, and must not swallow J / K afterwards.
    const typing =
      t &&
      ((t instanceof HTMLInputElement && t.type !== "checkbox" && t.type !== "radio") ||
        /^(TEXTAREA|SELECT)$/.test(t.tagName) ||
        t.isContentEditable);
    if (typing) return;
    if (t?.closest?.("[role=dialog]")) return;
    const k = e.key.toLowerCase();
    const i = focused ? visibleKeys.indexOf(focused) : -1;
    if (k === "j" || k === "k") {
      const next = k === "j" ? Math.min(i + 1, visibleKeys.length - 1) : Math.max(i - 1, 0);
      const key = visibleKeys[next];
      if (!key) return;
      e.preventDefault();
      setFocusKey(key);
      cardRefs.current.get(key)?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (tab !== "pending" || i < 0) return;
    const decision: Decision | null =
      k === "a" ? "approve" : k === "h" ? "approve_hidden" : k === "r" ? "reject" : null;
    const g = visible[i];
    if (!decision || !g || g.contested || busy.has(g.rows[0]!.id)) return;
    e.preventDefault();
    void decideOne(g.rows[0]!, decision, g.key);
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const tabCounts: Record<Tab, string> = {
    pending: rowCount(pending).toLocaleString(),
    approved: counts.approved.toLocaleString(),
    // No DB total for Rejected; the loaded list is capped, so say so.
    rejected:
      rowCount(rejected) >= NEWS_HISTORY_LIMIT
        ? `${NEWS_HISTORY_LIMIT}+`
        : rowCount(rejected).toLocaleString(),
  };

  const shown = rowCount(visible);
  const total = baseRows.length;
  const countLabel =
    `${shown.toLocaleString()} ${tab === "pending" ? "awaiting review" : `clip${shown === 1 ? "" : "s"}`}` +
    (shown !== total ? ` of ${total.toLocaleString()}` : "");

  const rail = (
    <FilterRail
      filters={filters}
      setFilters={setFilters}
      clear={() => {
        setFilters(NO_FILTERS);
        setQuery("");
      }}
      clearable={filtered}
      baseRows={baseRows}
      typeOptions={typeOptions}
    />
  );

  return (
    <div className="flex flex-col gap-[22px]" data-slot="media-highlights-queue">
      <div
        className="border-apollo-border-strong flex items-end gap-7 overflow-x-auto border-b"
        role="tablist"
      >
        {(["pending", "approved", "rejected"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => switchTab(t)}
            className={cn(
              "flex items-center gap-2 border-b-2 px-0.5 pt-2.5 pb-3 text-[15px] whitespace-nowrap capitalize",
              tab === t
                ? "border-apollo-maroon text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
            data-testid={`mh-queue-tab-${t}`}
          >
            {t}
            <span
              className={cn(
                "text-foreground rounded-full px-[7px] py-px text-xs font-normal tabular-nums",
                tab === t ? "bg-apollo-rail" : "bg-apollo-surface-2",
              )}
            >
              {tabCounts[t]}
            </span>
          </button>
        ))}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
        <div className="hidden lg:sticky lg:top-5 lg:block">{rail}</div>

        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3" data-testid="mh-queue-toolbar">
            {tab === "pending" && (
              <label className="flex cursor-pointer items-center gap-2 text-[13.5px] whitespace-nowrap">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={allSelected}
                  disabled={selectable.length === 0}
                  onChange={() =>
                    setSelected(
                      allSelected ? new Set() : new Set(selectAllTargets.map((g) => g.key)),
                    )
                  }
                  data-testid="mh-queue-select-all"
                />
                {selectable.length > NEWS_UNDO_MAX_DECISIONS
                  ? `Select first ${NEWS_UNDO_MAX_DECISIONS}`
                  : "Select all"}
              </label>
            )}
            <span
              className="text-muted-foreground text-sm"
              role="status"
              aria-live="polite"
              data-testid="mh-queue-count"
            >
              {countLabel}
            </span>
            <div className="flex w-full flex-wrap items-center gap-2.5 sm:ml-auto sm:w-auto">
              <FiltersSheet activeCount={activeFilterCount} testId="mh-queue-filters-sheet">
                {rail}
              </FiltersSheet>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Scholar or detected name…"
                aria-label="Filter by scholar or detected name"
                className="border-apollo-border-strong bg-apollo-surface h-[34px] min-w-0 flex-1 rounded-lg border px-2.5 text-[13.5px] sm:w-[200px] sm:flex-none"
                data-testid="mh-queue-search"
              />
              {tab === "pending" && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-[13px]" id="mh-queue-sort-label">
                    Sort
                  </span>
                  <div
                    role="radiogroup"
                    aria-labelledby="mh-queue-sort-label"
                    className="border-apollo-border bg-apollo-surface-2 flex rounded-lg border p-[3px]"
                  >
                    {SORTS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={sort === o.value}
                        onClick={() => setSort(o.value)}
                        className={cn(
                          "rounded-md px-[11px] py-1 text-[13px] whitespace-nowrap",
                          sort === o.value
                            ? "text-foreground bg-white shadow-[0_1px_2px_rgba(34,30,28,.12)]"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        data-testid={`mh-queue-sort-${o.value}`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          {toast && (
            <DecisionStatusBar
              text={toast.text}
              canUndo={toast.decisionIds.length > 0}
              undoing={undoing}
              onUndo={() => void undo()}
              onDismiss={() => setToast(null)}
              testId="mh-queue-toast"
            />
          )}

          {tab === "approved" && (
            <p className="text-muted-foreground text-sm" data-testid="mh-queue-approved-counts">
              {counts.approved.toLocaleString()} approved · {counts.approvedHidden.toLocaleString()}{" "}
              hidden
            </p>
          )}
          {tab !== "pending" && rowCount(base) >= NEWS_HISTORY_LIMIT && (
            <p className="text-muted-foreground text-sm">
              Showing the {NEWS_HISTORY_LIMIT} most recent — older clips are not listed here, but
              still show on their profiles.
            </p>
          )}

          {visible.length === 0 ? (
            <div
              className="border-apollo-border-strong bg-apollo-surface text-muted-foreground rounded-[13px] border p-10 text-center text-sm"
              data-testid="mh-queue-empty"
            >
              {filtered
                ? "No clips match these filters."
                : tab === "pending"
                  ? "Queue clear. Nothing awaiting review."
                  : "No clips here yet."}
            </div>
          ) : (
            visible.map((g) => (
              <ClipCard
                key={g.key}
                group={g}
                tab={tab}
                focused={focused === g.key}
                onFocus={() => setFocusKey(g.key)}
                cardRef={(el) => {
                  if (el) cardRefs.current.set(g.key, el);
                  else cardRefs.current.delete(g.key);
                }}
                selected={selected.has(g.key)}
                onSelect={() =>
                  setSelected((prev) =>
                    prev.has(g.key) || prev.size < NEWS_UNDO_MAX_DECISIONS
                      ? toggleIn(prev, g.key)
                      : prev,
                  )
                }
                busy={busy}
                pendingByCwid={pendingByCwid}
                pendingBySourceRef={pendingBySourceRef}
                decide={(row, d) => decideOne(row, d, g.key)}
                override={overrides[g.key] ?? null}
                setOverride={(o) =>
                  setOverrides((prev) => {
                    const next = { ...prev };
                    if (o) next[g.key] = o;
                    else delete next[g.key];
                    return next;
                  })
                }
                rejectGroup={() => rejectGroup(g)}
                setVisibility={setVisibility}
                regroup={regroup}
              />
            ))
          )}

          {tab === "pending" && selectedVisible.length > 0 && (
            <div
              role="region"
              aria-label="Selected clips"
              className="bg-apollo-bar sticky bottom-5 z-20 flex max-w-full flex-wrap items-center gap-3 self-center rounded-xl py-2.5 pr-3 pl-[18px] text-sm text-white shadow-[0_8px_30px_rgba(34,30,28,.25)]"
              data-testid="mh-queue-bulk-bar"
            >
              <span aria-live="polite">
                {selectedVisible.length} selected
                {atCap ? ` · ${NEWS_UNDO_MAX_DECISIONS} max at a time` : ""}
              </span>
              <BulkButton primary disabled={busy.size > 0} onClick={() => decideBulk("approve")}>
                Approve
              </BulkButton>
              <BulkButton disabled={busy.size > 0} onClick={() => decideBulk("approve_hidden")}>
                Approve but hide
              </BulkButton>
              <BulkButton disabled={busy.size > 0} onClick={() => decideBulk("reject")}>
                Reject
              </BulkButton>
              <button
                type="button"
                disabled={busy.size > 0}
                onClick={() => setSelected(new Set())}
                className="text-[13px] text-[#cfc8c2] hover:text-white"
              >
                Clear
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function BulkButton({
  primary = false,
  disabled,
  onClick,
  children,
}: {
  primary?: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-[7px] px-3 py-1.5 text-[13px] disabled:opacity-50",
        primary
          ? "text-apollo-bar bg-white font-medium"
          : "border border-white/30 bg-transparent text-white",
      )}
    >
      {children}
    </button>
  );
}

function FilterRail({
  filters,
  setFilters,
  clear,
  clearable,
  baseRows,
  typeOptions,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  clear: () => void;
  clearable: boolean;
  baseRows: ReadonlyArray<NewsQueueRow>;
  typeOptions: ReadonlyArray<string>;
}) {
  const count = (pred: (r: NewsQueueRow) => boolean) => baseRows.filter(pred).length;
  const groups: ReadonlyArray<{
    label: string;
    items: ReadonlyArray<{
      id: string;
      label: string;
      count: number;
      on: boolean;
      toggle: () => void;
    }>;
  }> = [
    {
      label: "Match certainty",
      items: TIERS.map((t) => ({
        id: `cert-${t}`,
        label: TIER_LABEL[t]!,
        count: count((r) => r.likelihood === t),
        on: filters.cert.has(t),
        toggle: () => setFilters({ ...filters, cert: toggleIn(filters.cert, t) }),
      })),
    },
    {
      label: "Scholar type",
      items: typeOptions.map((t) => ({
        id: `type-${t}`,
        label: t,
        count: count((r) => typeOf(r) === t),
        on: filters.type.has(t),
        toggle: () => setFilters({ ...filters, type: toggleIn(filters.type, t) }),
      })),
    },
    {
      label: "Duplicates",
      items: [
        {
          id: "dup",
          label: "Possible duplicate",
          count: count(isDuplicate),
          on: filters.dup,
          toggle: () => setFilters({ ...filters, dup: !filters.dup }),
        },
      ],
    },
  ];
  return (
    <aside
      className="bg-apollo-rail border-apollo-border-strong flex flex-col gap-[22px] rounded-[13px] border px-5 pt-[18px] pb-5"
      data-testid="mh-queue-rail"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-muted-foreground text-xs font-medium tracking-[0.12em] uppercase">
          Filters
        </span>
        <button
          type="button"
          onClick={clear}
          disabled={!clearable}
          className={cn(
            "text-[13px]",
            clearable ? "text-apollo-slate hover:underline" : "text-muted-foreground",
          )}
        >
          Clear
        </button>
      </div>
      {groups.map((fg) => (
        <fieldset key={fg.label} className="m-0 flex flex-col gap-0.5 border-0 p-0">
          <legend className="text-muted-foreground mb-1.5 p-0 text-xs font-medium tracking-[0.12em] uppercase">
            {fg.label}
          </legend>
          {fg.items.length === 0 && <span className="text-muted-foreground text-[13px]">None</span>}
          {fg.items.map((f) => (
            <label key={f.id} className="flex cursor-pointer items-center gap-2.5 py-1 text-sm">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={f.on}
                onChange={f.toggle}
                data-testid={`mh-queue-filter-${f.id}`}
              />
              <span className="min-w-0 flex-1 leading-[1.35]">{f.label}</span>
              <span className="text-muted-foreground text-[13px] tabular-nums">
                {f.count.toLocaleString()}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="border-apollo-border-strong text-muted-foreground hidden flex-col gap-1.5 border-t pt-4 text-[12.5px] lg:flex">
        <span className="text-xs font-medium tracking-[0.12em] uppercase">Keyboard</span>
        {KEYS.map(([k, l]) => (
          <span key={k} className="flex items-center gap-2">
            <kbd className="border-apollo-border-strong text-foreground min-w-[14px] rounded border bg-white px-1.5 text-center font-mono text-[11.5px]">
              {k}
            </kbd>
            {l}
          </span>
        ))}
      </div>
    </aside>
  );
}

function ClipCard({
  group: g,
  tab,
  focused,
  onFocus,
  cardRef,
  selected,
  onSelect,
  busy,
  pendingByCwid,
  pendingBySourceRef,
  decide,
  override,
  setOverride,
  rejectGroup,
  setVisibility,
  regroup,
}: {
  group: NewsQueueGroup;
  tab: Tab;
  focused: boolean;
  onFocus: () => void;
  cardRef: (el: HTMLElement | null) => void;
  selected: boolean;
  onSelect: () => void;
  busy: ReadonlySet<string>;
  pendingByCwid: ReadonlyMap<string, number>;
  pendingBySourceRef: ReadonlyMap<string, number>;
  decide: (row: NewsQueueRow, d: Decision) => void;
  /** The staged "Wrong person? Reassign" scholar (pending, uncontested only). */
  override: ScholarOverride | null;
  setOverride: (o: ScholarOverride | null) => void;
  rejectGroup: () => void;
  setVisibility: (row: NewsQueueRow, action: "hide" | "show") => void;
  regroup: (op: RegroupOp, id: string, leadId?: string) => void;
}) {
  const lead = g.rows[0]!;
  const single = g.rows.length === 1;
  const pendingUncontested = tab === "pending" && !g.contested;
  const snippetRow = g.rows.find((r) => r.contextSnippet);

  /** The per-row actions on the history tabs and a contested pending group. */
  function rowActions(row: NewsQueueRow): ReactNode {
    const isBusy = busy.has(row.id);
    if (tab === "pending" && g.contested) {
      return (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className={slateButton}
            disabled={isBusy}
            onClick={() => decide(row, "approve")}
          >
            This is the one
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            aria-label={`Approve “${row.articleTitle}” for ${row.scholarName} but hide it from their profile`}
            data-testid={`mh-queue-approve-hidden-${row.id}`}
            onClick={() => decide(row, "approve_hidden")}
          >
            Approve but hide
          </Button>
        </div>
      );
    }
    if (tab === "approved") {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "border-border rounded-full border px-2 py-px text-[11.5px] font-semibold",
              row.showOnProfile ? "text-muted-foreground" : "text-foreground bg-muted",
            )}
            data-testid={`mh-queue-visibility-${row.id}`}
          >
            {row.showOnProfile ? "On profile" : "Hidden"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            aria-label={`${row.showOnProfile ? "Hide" : "Show"} “${row.articleTitle}” on ${row.scholarName}'s profile`}
            onClick={() => setVisibility(row, row.showOnProfile ? "hide" : "show")}
          >
            {row.showOnProfile ? "Hide" : "Show"}
          </Button>
        </div>
      );
    }
    if (tab === "rejected") {
      const competing = row.sourceRef ? (pendingBySourceRef.get(row.sourceRef) ?? 0) : 0;
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            aria-describedby={competing > 0 ? `mh-blast-${row.id}` : undefined}
            onClick={() => decide(row, "approve")}
          >
            Approve
          </Button>
          {competing > 0 && (
            <span
              id={`mh-blast-${row.id}`}
              className="text-muted-foreground text-xs"
              data-testid={`mh-queue-blast-${row.id}`}
            >
              {`Rejects ${competing} other candidate${competing === 1 ? "" : "s"} matched to this name.`}
            </span>
          )}
        </div>
      );
    }
    return null;
  }

  return (
    <article
      ref={cardRef}
      onClick={onFocus}
      data-focused={focused ? "true" : undefined}
      className={cn(
        "bg-apollo-surface grid grid-cols-[20px_minmax(0,1fr)] gap-4 rounded-[13px] border p-[18px] md:grid-cols-[20px_minmax(0,1.4fr)_minmax(190px,1fr)]",
        focused
          ? "border-apollo-slate ring-apollo-slate-tint ring-[3px]"
          : "border-apollo-border-strong",
      )}
      data-testid={`mh-queue-card-${g.key}`}
    >
      <div className="pt-[3px]">
        {pendingUncontested && (
          <input
            type="checkbox"
            className={checkboxClass}
            checked={selected}
            onChange={onSelect}
            aria-label={`Select “${lead.articleTitle}”`}
            data-testid={`mh-queue-select-${g.key}`}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-muted-foreground text-[12.5px]">
          {lead.outlet ? (
            <span className="text-foreground font-semibold">{lead.outlet}</span>
          ) : null}
          {lead.outlet ? " · " : ""}
          {formatDate(lead.publishedAt)}
          {/* The detected name only where it adds something: a contested group,
              or a name the scholar's own does not start with. */}
          {g.detectedName &&
          (g.contested || !lead.scholarName.toLowerCase().startsWith(g.detectedName.toLowerCase()))
            ? ` · detected “${g.detectedName}”`
            : ""}
        </span>
        <a
          href={lead.articleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-apollo-slate text-[16.5px] leading-[1.35] font-semibold text-pretty"
        >
          {lead.articleTitle}{" "}
          <span aria-hidden className="text-muted-foreground text-xs font-normal">
            ↗
          </span>
        </a>
        {snippetRow?.contextSnippet ? (
          <p className="border-apollo-border-strong m-0 border-l-2 pl-3 text-[13.5px] leading-[1.55] text-[var(--evidence-body)]">
            {highlightName(snippetRow.contextSnippet, snippetRow.contextSnippetMatches)}
          </p>
        ) : null}
        {g.rows.map((row) => (
          <StoryLinks key={row.id} row={row} busy={busy.has(row.id)} regroup={regroup} />
        ))}
      </div>

      <div className="border-apollo-border col-start-2 flex min-w-0 flex-col gap-4 border-t pt-3 md:col-start-auto md:border-t-0 md:border-l md:pt-0 md:pl-[18px]">
        {g.contested && tab === "pending" && (
          <p className="text-apollo-amber text-[12.5px]">
            More than one scholar matches this name — pick one.
          </p>
        )}
        {g.rows.map((row) => (
          <div key={row.id} className="flex flex-col gap-3">
            <Scholar
              row={row}
              tab={tab}
              pendingCount={pendingByCwid.get(row.cwid) ?? 0}
              override={pendingUncontested && row === lead ? override : null}
            />
            {pendingUncontested && row === lead ? (
              <ReassignControl
                override={override}
                disabled={busy.has(lead.id)}
                onPick={setOverride}
                idPrefix={`mh-queue-reassign-${g.key}`}
              />
            ) : null}
            {!single || (tab === "pending" && g.contested) ? rowActions(row) : null}
          </div>
        ))}
      </div>

      <div className="border-apollo-border col-[2/-1] flex flex-wrap items-center gap-2 border-t pt-3">
        {pendingUncontested ? (
          <>
            <Button
              size="sm"
              className={slateButton}
              disabled={busy.has(lead.id)}
              onClick={() => decide(lead, "approve")}
              data-testid={`mh-queue-approve-${lead.id}`}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy.has(lead.id)}
              aria-label={`Approve “${lead.articleTitle}” for ${override ? (override.name ?? override.cwid) : lead.scholarName} but hide it from their profile`}
              data-testid={`mh-queue-approve-hidden-${lead.id}`}
              onClick={() => decide(lead, "approve_hidden")}
            >
              Approve but hide
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:bg-apollo-red-tint hover:text-destructive"
              disabled={busy.has(lead.id)}
              onClick={() => decide(lead, "reject")}
            >
              Reject
            </Button>
            {focused && (
              <span className="text-muted-foreground ml-auto hidden text-xs lg:inline" aria-hidden>
                A · H · R
              </span>
            )}
          </>
        ) : tab === "pending" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={g.rows.some((r) => busy.has(r.id))}
            onClick={rejectGroup}
          >
            None of these
          </Button>
        ) : single ? (
          rowActions(lead)
        ) : (
          <span className="text-muted-foreground text-xs">Decided per scholar, above.</span>
        )}
      </div>
    </article>
  );
}

/** The matched scholar: initials, name, title, department · type, then the
 *  certainty pill and its basis. */
function Scholar({
  row,
  tab,
  pendingCount,
  override = null,
}: {
  row: NewsQueueRow;
  tab: Tab;
  pendingCount: number;
  /** A staged reassign: show that scholar in place of the matched one. */
  override?: ScholarOverride | null;
}) {
  const basis = row.matchBasis ? MATCH_BASIS[row.matchBasis] : undefined;
  const tier = row.likelihood ? TIER_LABEL[row.likelihood] : undefined;
  const shownName = override ? (override.name ?? override.cwid) : row.scholarName;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="bg-apollo-surface-2 ring-apollo-border-strong text-apollo-bar flex size-9 flex-none items-center justify-center rounded-full text-[12.5px] font-semibold ring-1"
        >
          {initials(shownName)}
        </span>
        {override ? (
          <div className="flex min-w-0 flex-col gap-0.5" data-testid="mh-queue-override">
            <span className="text-[14.5px] font-semibold">{shownName}</span>
            <span className="text-muted-foreground text-[12.5px]">
              <span className="font-mono">{override.cwid}</span> · Manually assigned
            </span>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-0.5">
            {row.slug ? (
              <a
                href={`/${row.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-apollo-slate text-[14.5px] font-semibold"
              >
                {row.scholarName}
              </a>
            ) : (
              <span className="text-[14.5px] font-semibold">{row.scholarName}</span>
            )}
            {row.title && (
              <span className="text-muted-foreground text-[12.5px] leading-[1.4]">{row.title}</span>
            )}
            {(row.department || row.roleLabel) && (
              <span className="text-muted-foreground text-[12.5px]">
                {[row.department, row.roleLabel].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {row.source === "VIVO" ? (
          <span
            className="text-muted-foreground border-border rounded-full border px-2 py-0.5 text-[11.5px] font-semibold"
            title="Linked by VIVO cwid — published automatically, never queued"
          >
            VIVO
          </span>
        ) : tier ? (
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11.5px] font-semibold tracking-[0.04em]",
              TIER_PILL[row.likelihood!],
            )}
            title="How confident the matcher is that the detected name is this scholar"
            data-testid={`mh-queue-likelihood-${row.likelihood}`}
          >
            {tier} match
          </span>
        ) : null}
        {row.source !== "VIVO" && basis && (
          <span
            className="text-muted-foreground text-xs"
            title={basis.hint}
            data-testid={`mh-queue-basis-${row.matchBasis}`}
          >
            via {basis.via}
          </span>
        )}
        {tab === "pending" && pendingCount > 1 && (
          <span className="text-muted-foreground text-xs">{pendingCount} clips pending</span>
        )}
        {override && (
          <span className="text-apollo-amber text-xs">Reassigned from {row.scholarName}</span>
        )}
      </div>
      {tab === "approved" && row.decidedByName && (
        <span className="text-muted-foreground text-xs">Last updated by {row.decidedByName}</span>
      )}
      {tab === "rejected" && row.declinedByScholar && (
        <span
          className="text-apollo-amber text-xs font-medium"
          data-testid={`mh-queue-declined-${row.id}`}
        >
          The scholar declined this clip themselves.
        </span>
      )}
    </div>
  );
}

/**
 * "Wrong person? Reassign" — search the directory for the scholar the clip is
 * really about. A pick is checked against the scholar table (a directory person
 * with no profile cannot be credited) and then only STAGED: Approve / Approve
 * but hide (or A / H, or the bulk bar) send it as the decision's `cwid`.
 */
function ReassignControl({
  override,
  disabled,
  onPick,
  idPrefix,
}: {
  override: ScholarOverride | null;
  disabled: boolean;
  onPick: (o: ScholarOverride | null) => void;
  idPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function pick(v: DirectoryValue | null) {
    if (!v) return;
    setProblem(null);
    setChecking(true);
    const hit = await lookupScholar(v.cwid);
    setChecking(false);
    if (!hit.found) {
      setProblem(`${v.name} has no scholar profile, so the clip can't be credited to them.`);
      return;
    }
    onPick({ cwid: v.cwid, name: hit.name ?? v.name });
    setOpen(false);
  }

  if (!open) {
    return (
      <div className="flex flex-wrap gap-3 text-[12.5px]">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="text-apollo-slate hover:underline disabled:opacity-60"
          data-testid={`${idPrefix}-open`}
        >
          Wrong person? Reassign
        </button>
        {override && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPick(null)}
            className="text-muted-foreground hover:text-foreground"
            data-testid={`${idPrefix}-revert`}
          >
            Revert
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="bg-apollo-page border-apollo-border-strong flex flex-col gap-1.5 rounded-lg border p-2">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <DirectoryPeopleTypeahead
            value={null}
            onChange={(v) => void pick(v)}
            placeholder="Search scholar name…"
            disabled={checking}
            idPrefix={idPrefix}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setProblem(null);
          }}
          className="text-muted-foreground hover:text-foreground text-[12.5px]"
        >
          Cancel
        </button>
      </div>
      {checking && <span className="text-muted-foreground text-xs">Checking…</span>}
      {problem && (
        <span className="text-destructive text-xs" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

/** Story grouping: a copy of another clip, a probable repeat, and the other
 *  outlets that ran this story — each with its correction. */
function StoryLinks({
  row,
  busy,
  regroup,
}: {
  row: NewsQueueRow;
  busy: boolean;
  regroup: (op: RegroupOp, id: string, leadId?: string) => void;
}) {
  const box =
    "bg-apollo-page border-apollo-border flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border px-2.5 py-[7px] text-[13px]";
  const action = "text-apollo-slate hover:underline disabled:opacity-50";
  return (
    <>
      {row.leadOf && (
        <div className={box} data-testid="mh-queue-copy-of">
          <span className="text-muted-foreground">
            Same story as {CLIP_STATUS[row.leadOf.status] ?? "another clip"}:
          </span>
          <a
            href={row.leadOf.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            {row.leadOf.title}
          </a>
          <button
            type="button"
            disabled={busy}
            className={cn(action, "ml-auto")}
            onClick={() => regroup("ungroup", row.id)}
          >
            Ungroup
          </button>
        </div>
      )}
      {row.possibleRepeatOf && (
        <div className={box} data-testid="mh-queue-possible-repeat">
          <span className="text-muted-foreground">
            Possible repeat of {CLIP_STATUS[row.possibleRepeatOf.status] ?? "another clip"}:
          </span>
          <a
            href={row.possibleRepeatOf.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            {row.possibleRepeatOf.title}
          </a>
          <button
            type="button"
            disabled={busy}
            className={cn(action, "ml-auto")}
            onClick={() => regroup("group", row.id, row.possibleRepeatOf!.id)}
            data-testid="mh-queue-group-with"
          >
            Group with it
          </button>
        </div>
      )}
      {row.placements.length > 0 && (
        <div className="text-muted-foreground text-[12.5px]" data-testid="mh-queue-placements">
          Also ran in:{" "}
          {row.placements.map((p, i) => (
            <span key={p.id}>
              {i > 0 ? "; " : ""}
              <a
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                {p.outlet ?? "another outlet"}
              </a>
              {p.publishedAt ? ` (${formatDate(p.publishedAt)})` : ""}{" "}
              <button
                type="button"
                disabled={busy}
                className={action}
                onClick={() => regroup("make_lead", p.id)}
              >
                Make lead
              </button>
              {" · "}
              <button
                type="button"
                disabled={busy}
                className={action}
                onClick={() => regroup("ungroup", p.id)}
              >
                Ungroup
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
