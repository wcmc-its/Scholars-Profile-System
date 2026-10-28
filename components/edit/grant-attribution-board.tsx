"use client";

/**
 * #3071 — the grant attribution queue (`/edit/grant-attribution-queue`): one
 * layout for To review, Confirmed and Not this person. The awards as a list on
 * the left, the focused one in full on the right, with a fixed action footer.
 *
 * The detail keeps evidence and decision apart: the weekly check's score and
 * level in one cell, who placed the award in this tab in the other. Below
 * them, the award as RePORTER prints it (the name on the award first, the
 * parts that differ from the profile marked), and one ledger of how the score
 * adds up.
 *
 * To review holds every card and filters in the browser. Confirmed and Not
 * this person run to thousands, so their filters, sort and page live in the
 * URL and the server loads one page (`loadDecidedPage`).
 *
 * A decision takes the award out of the list and shows a toast with Undo. An
 * undo returns the award to review: the route reverses exactly what the
 * decision did and leaves the review pending.
 *
 * Mockup: Projects/Scholars-Profile-System/mockups/Reporter Update/Grant
 * Attribution.dc.html. Imports only pure `@/lib/edit/*` modules.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Kbd } from "@/components/edit/honors-review";
import { postRequeue } from "@/components/edit/grant-attribution-shared";
import { DecisionStatusBar } from "@/components/edit/news-review-shared";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import {
  EVIDENCE_LEVELS,
  decisionSummary,
  defaultSort,
  evidenceLevelLabel,
  filterRows,
  levelTone,
  mainCue,
  provenance,
  scalePct,
  type BoardFilters,
  type BoardRow,
  type BoardTab,
  type EvidenceLevel,
} from "@/lib/edit/grant-attribution-board";
import {
  DECIDED_PAGE_SIZE,
  HIDE_AT,
  PRIOR,
  SHOW_AT,
  checkedNothingFound,
  decidedHref,
  signed,
  type DecidedParams,
} from "@/lib/edit/grant-attribution-decided";
import {
  GRANT_ATTRIBUTION_BULK_MAX,
  GRANT_REJECTION_REASONS,
  GRANT_REJECTION_REASON_MAX,
  cueLabel,
  reporterNameForDisplay,
  reporterNameParts,
  reporterProjectUrl,
} from "@/lib/edit/grant-attribution-queue";
import { profilePath } from "@/lib/profile-url";
import { cn } from "@/lib/utils";

const TABS: ReadonlyArray<readonly [BoardTab, string]> = [
  ["pending", "To review"],
  ["confirmed", "Confirmed"],
  ["rejected", "Not this person"],
];

const TAB_DESC: Record<BoardTab, string> = {
  pending: "The check couldn't settle these. Each stays off the profile until a curator decides.",
  confirmed:
    "On the profile. Automatic confirmations can move if evidence against turns up; curator decisions never change on their own.",
  rejected:
    "Kept off the profile because evidence points to someone else. Curator decisions never change on their own.",
};

type Verb = "confirm" | "reject" | "review" | "skip";
type Action = { verb: Verb; label: string; key: string; variant: "default" | "outline" | "ghost" };

const ACTIONS: Record<BoardTab, Action[]> = {
  pending: [
    { verb: "confirm", label: "Confirm", key: "C", variant: "default" },
    { verb: "reject", label: "Not this person", key: "N", variant: "outline" },
    { verb: "skip", label: "Skip", key: "S", variant: "ghost" },
  ],
  confirmed: [
    { verb: "reject", label: "Not this person", key: "N", variant: "outline" },
    { verb: "review", label: "Move to review", key: "R", variant: "ghost" },
  ],
  rejected: [
    { verb: "confirm", label: "Confirm instead", key: "C", variant: "outline" },
    { verb: "review", label: "Move to review", key: "R", variant: "ghost" },
  ],
};

const EYEBROW =
  "text-[11px] font-semibold tracking-[0.08em] uppercase text-[var(--evidence-faint)]";
const CONTROL =
  "border-apollo-border-strong bg-apollo-surface text-foreground h-9 rounded-lg border px-2.5 text-[14px]";
const BODY = "text-[var(--evidence-body)]";
const FAINT = "text-[var(--evidence-faint)]";

/** The level chip's colors: slate for evidence for, amber against, neutral
 *  for none or mixed. */
const CHIP: Record<EvidenceLevel, string> = {
  supports: "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border",
  "leans-for": "bg-apollo-surface text-apollo-slate border-apollo-slate-tint-border",
  mixed: "bg-apollo-surface-2 border-apollo-border-strong text-[var(--evidence-body)]",
  none: "bg-apollo-surface-2 border-apollo-border text-[var(--evidence-faint)]",
  "leans-against": "bg-apollo-surface text-apollo-amber border-apollo-amber-tint-border",
  against: "bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border",
};
const TONE_TEXT = {
  for: "text-apollo-slate",
  against: "text-apollo-amber",
  neutral: "text-[var(--evidence-body)]",
};

function years(from: number | null, to: number | null): string {
  if (from === null && to === null) return "";
  if (from === to || to === null) return String(from);
  if (from === null) return String(to);
  return `${from}–${to}`;
}

function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  if (t.tagName === "INPUT") return (t as HTMLInputElement).type !== "checkbox";
  return t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable;
}

function initials(name: string): string {
  const w = name.split(",")[0]!.trim().split(/\s+/).filter(Boolean);
  return w.length === 0
    ? ""
    : ((w[0]![0] ?? "") + (w.length > 1 ? (w[w.length - 1]![0] ?? "") : "")).toUpperCase();
}

function shortName(name: string): string {
  const w = name.split(",")[0]!.trim().split(/\s+/).filter(Boolean);
  return w.length > 1 ? `${w[0]} ${w[w.length - 1]}` : (w[0] ?? name);
}

const fmt = (n: number) => n.toLocaleString("en-US");

function errorMessage(status: number, code: string | undefined): string {
  if (status === 409 && code === "not_pending") {
    return "Someone else has already decided this award. Refresh the page to see where it landed.";
  }
  if (status === 409 && code === "hidden_by_age") {
    return "This award is also hidden because it is old, so confirming it would not show it. Nothing was changed.";
  }
  if (status === 409 && (code === "state_changed" || code === "not_undoable")) {
    return "This award has changed since it was decided, so it can't be undone from here. Refresh to see where it is now.";
  }
  if (status === 409)
    return "This award changed since the page loaded. Refresh to see where it is now.";
  if (status === 403) return "Your role can read this queue but not decide it.";
  return "We couldn't record that decision. Please try again.";
}

async function postDecision(
  body: Record<string, unknown>,
): Promise<{ ok: true; reviews: Record<string, string> } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/edit/grant-attribution/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        reviews?: Record<string, string>;
      } | null;
      return { ok: true, reviews: data?.reviews ?? {} };
    }
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, message: errorMessage(res.status, data?.error) };
  } catch {
    return { ok: false, message: "We couldn't record that decision. Please try again." };
  }
}

/** A decision the toast (and U) can take back: the reviews it left decided. */
type Undoable = { reviewIds: string[]; rowIds: string[]; to: BoardTab };

export type GrantAttributionBoardProps = {
  tab: BoardTab;
  rows: BoardRow[];
  /** Every award on each tab, as the page loaded. */
  counts: Record<BoardTab, number>;
  readOnly: boolean;
  /** Confirmed and Not this person: the URL state the server filtered by. */
  server: {
    params: DecidedParams;
    matched: number;
    byCounts: { curator: number; auto: number };
    changed: number;
  } | null;
};

export function GrantAttributionBoard({
  tab,
  rows,
  counts,
  readOnly,
  server,
}: GrantAttributionBoardProps) {
  const router = useRouter();
  const canDecide = !readOnly;
  const p = server?.params ?? null;

  const [local, setLocal] = useState<BoardFilters>({
    q: "",
    level: "all",
    by: "all",
    changed: false,
    sort: defaultSort(tab),
  });
  const [q, setQ] = useState(p?.q ?? "");
  const filters: BoardFilters = p
    ? { q, level: p.level, by: p.by, changed: p.changed, sort: p.sort }
    : { ...local, q };

  const go = useCallback(
    (over: Partial<DecidedParams>) => {
      if (p) router.push(decidedHref(p, { page: 1, ...over }), { scroll: false });
    },
    [router, p],
  );
  const setFilter = (over: Partial<Omit<BoardFilters, "q">>) => {
    if (p) go(over);
    else setLocal((f) => ({ ...f, ...over }));
  };

  // Decided tabs: follow the URL when it changes under us (Back, a link), and
  // push typing to it after a pause. Compared trimmed, as the server stores it.
  useEffect(() => {
    if (p) setQ(p.q);
  }, [p?.q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!p || q.trim().slice(0, 200) === p.q) return;
    const t = setTimeout(() => go({ q: q.trim() }), 350);
    return () => clearTimeout(t);
  }, [q, p, go]);

  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [skipped, setSkipped] = useState<string[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");
  const [bulkAsking, setBulkAsking] = useState(false);
  const [bulkReason, setBulkReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo: Undoable | null } | null>(null);
  const [history, setHistory] = useState<Undoable[]>([]);
  /** Row id → review id, for an award a by-grant decision just opened a review for. */
  const [reviewOf, setReviewOf] = useState<Record<string, string>>({});
  const [delta, setDelta] = useState<Record<BoardTab, number>>({
    pending: 0,
    confirmed: 0,
    rejected: 0,
  });
  const [showNothing, setShowNothing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const list = useMemo(() => {
    const kept = (p ? rows : filterRows(rows, { ...filters, q })).filter((r) => !removed.has(r.id));
    if (skipped.length === 0) return kept;
    const rank = (r: BoardRow) => skipped.indexOf(r.id);
    return kept
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
      .map((x) => x.r);
  }, [rows, p, filters.level, filters.by, filters.changed, filters.sort, q, removed, skipped]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = list.find((r) => r.id === focusId) ?? list[0] ?? null;
  const focus = current?.id ?? null;
  const idx = current ? list.indexOf(current) : -1;
  const actions = ACTIONS[tab];
  const selIds = useMemo(
    () => [...selected].filter((id) => list.some((r) => r.id === id)),
    [selected, list],
  );
  const overCap = selIds.length > GRANT_ATTRIBUTION_BULK_MAX;
  const count = (t: BoardTab) => Math.max(0, counts[t] + delta[t]);

  const scrollTo = useCallback((id: string) => {
    const sel =
      typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
    listRef.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const step = useCallback(
    (d: 1 | -1) => {
      if (list.length === 0) return;
      const n = list[Math.min(Math.max(idx + d, 0), list.length - 1)]!;
      setFocusId(n.id);
      setAsking(null);
      scrollTo(n.id);
    },
    [list, idx, scrollTo],
  );

  /** Take rows out of this tab and land the focus where they were. */
  const takeOut = useCallback(
    (ids: string[], to: BoardTab) => {
      const gone = new Set(ids);
      const remaining = list.filter((r) => !gone.has(r.id));
      const next = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)];
      setRemoved((s) => new Set([...s, ...ids]));
      setSelected((s) => new Set([...s].filter((id) => !gone.has(id))));
      setDelta((d) => ({ ...d, [tab]: d[tab] - ids.length, [to]: d[to] + ids.length }));
      setAsking(null);
      setBulkAsking(false);
      setOtherText("");
      if (next) {
        setFocusId(next.id);
        scrollTo(next.id);
      }
    },
    [list, idx, tab, scrollTo],
  );

  const decide = useCallback(
    async (ids: string[], decision: "confirm" | "reject", why?: string) => {
      if (!canDecide || busy || ids.length === 0) return;
      const byId = new Map(list.map((r) => [r.id, r]));
      const todo = ids.map((id) => byId.get(id)).filter((r): r is BoardRow => !!r);
      if (todo.length === 0) return;
      setBusy(true);
      setError(null);
      // To review: reviews by id, and awards with no review yet by grant, in one
      // call. The decided tabs always go by grant.
      const byReview = tab === "pending" ? todo.filter((r) => r.reviewId || reviewOf[r.id]) : [];
      const byGrant = todo.filter((r) => !byReview.includes(r));
      const rids = byReview.map((r) => reviewOf[r.id] ?? r.reviewId!);
      const gids = byGrant.map((r) => r.grantId);
      const body: Record<string, unknown> =
        gids.length === 0
          ? rids.length === 1
            ? { id: rids[0] }
            : { ids: rids }
          : gids.length === 1 && rids.length === 0
            ? { grant: gids[0] }
            : { grants: gids, ...(rids.length ? { ids: rids } : {}) };
      const res = await postDecision({ ...body, decision, ...(why ? { reason: why } : {}) });
      setBusy(false);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      const opened: Record<string, string> = {};
      for (const r of byGrant) if (res.reviews[r.grantId]) opened[r.id] = res.reviews[r.grantId]!;
      setReviewOf((m) => ({ ...m, ...opened }));
      const to: BoardTab = decision === "confirm" ? "confirmed" : "rejected";
      const undo: Undoable = {
        reviewIds: [...rids, ...byGrant.map((r) => opened[r.id]).filter((x): x is string => !!x)],
        rowIds: todo.map((r) => r.id),
        to,
      };
      takeOut(undo.rowIds, to);
      setHistory((h) => [...h, undo]);
      const who = todo.length === 1 ? shortName(todo[0]!.scholar.name) : `${todo.length} awards`;
      setToast({
        text: decision === "confirm" ? `Confirmed: ${who}` : `Marked not this person: ${who}`,
        undo: undo.reviewIds.length === undo.rowIds.length ? undo : null,
      });
    },
    [canDecide, busy, list, tab, reviewOf, takeOut],
  );

  const undo = useCallback(
    async (u: Undoable | null | undefined) => {
      if (!u || undoing) return;
      setUndoing(true);
      setError(null);
      const res = await postDecision(
        u.reviewIds.length === 1
          ? { id: u.reviewIds[0], decision: "undo" }
          : { ids: u.reviewIds, decision: "undo" },
      );
      setUndoing(false);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setHistory((h) => h.filter((x) => x !== u));
      setDelta((d) => ({
        ...d,
        [u.to]: d[u.to] - u.rowIds.length,
        pending: d.pending + u.rowIds.length,
      }));
      // On To review the awards come back; elsewhere they are in To review now.
      if (tab === "pending") {
        setRemoved((s) => new Set([...s].filter((id) => !u.rowIds.includes(id))));
        if (u.rowIds.length === 1) setFocusId(u.rowIds[0]!);
      }
      setToast({
        text: `Moved ${u.rowIds.length === 1 ? "the award" : `${u.rowIds.length} awards`} back to review.`,
        undo: null,
      });
    },
    [undoing, tab],
  );

  /** Confirmed and Not this person: send awards back to To review. A curator's
   *  decision is undone; one the check made is requeued. */
  const moveToReview = useCallback(
    async (ids: string[]) => {
      if (!canDecide || busy || ids.length === 0) return;
      const todo = list.filter((r) => ids.includes(r.id));
      setBusy(true);
      setError(null);
      const done: string[] = [];
      const curator = todo.filter((r) => r.by === "curator" && r.reviewId);
      if (curator.length > 0) {
        const res = await postDecision(
          curator.length === 1
            ? { id: curator[0]!.reviewId, decision: "undo" }
            : { ids: curator.map((r) => r.reviewId), decision: "undo" },
        );
        if (!res.ok) {
          setBusy(false);
          setError(res.message);
          return;
        }
        done.push(...curator.map((r) => r.id));
      }
      // One at a time; the first refusal stops the rest.
      for (const r of todo.filter((x) => !curator.includes(x))) {
        const res = await postRequeue(r.grantId);
        if (!res.ok) {
          setError(res.message);
          break;
        }
        done.push(r.id);
      }
      setBusy(false);
      if (done.length === 0) return;
      takeOut(done, "pending");
      setToast({
        text: `Moved to review: ${done.length === 1 ? shortName(todo.find((r) => r.id === done[0])!.scholar.name) : `${done.length} awards`}`,
        undo: null,
      });
    },
    [canDecide, busy, list, takeOut],
  );

  const skip = useCallback(
    (id: string) => {
      const i = list.findIndex((r) => r.id === id);
      const next = list[i + 1];
      setSkipped((s) => [...s.filter((x) => x !== id), id]);
      setAsking(null);
      setToast({ text: "Skipped. It moves to the end of this session’s list.", undo: null });
      if (next) {
        setFocusId(next.id);
        scrollTo(next.id);
      }
    },
    [list, scrollTo],
  );

  const run = useCallback(
    (verb: Verb, ids: string[] | null) => {
      if (!canDecide) return;
      const target = ids ?? (focus ? [focus] : []);
      if (target.length === 0) return;
      if (verb === "skip") return ids ? undefined : skip(target[0]!);
      if (verb === "confirm") return void decide(target, "confirm");
      if (verb === "review") return void moveToReview(target);
      // Not this person always takes a reason.
      if (ids) setBulkAsking(true);
      else {
        setAsking(target[0]!);
        setOtherText("");
      }
    },
    [canDecide, focus, skip, decide, moveToReview],
  );

  const toggle = useCallback(
    (id: string) => {
      if (!canDecide) return;
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    },
    [canDecide],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (asking) {
        if (k === "escape") setAsking(null);
        const n = Number.parseInt(k, 10);
        if (n >= 1 && n <= GRANT_REJECTION_REASONS.length) {
          e.preventDefault();
          void decide([asking], "reject", GRANT_REJECTION_REASONS[n - 1]);
        }
        return;
      }
      if (k === "j" || k === "arrowdown") {
        e.preventDefault();
        step(1);
        return;
      }
      if (k === "k" || k === "arrowup") {
        e.preventDefault();
        step(-1);
        return;
      }
      if (k === "escape") {
        setSelected(new Set());
        setBulkAsking(false);
        return;
      }
      if (!canDecide) return;
      if (k === "u") {
        e.preventDefault();
        void undo(history[history.length - 1]);
        return;
      }
      if (k === "x" && focus) {
        e.preventDefault();
        toggle(focus);
        return;
      }
      const a = actions.find((x) => x.key.toLowerCase() === k);
      if (!a) return;
      e.preventDefault();
      // Shift applies the action to the selection.
      if (e.shiftKey && selIds.length > 0) {
        if (!overCap && a.verb !== "skip") run(a.verb, selIds);
      } else run(a.verb, null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    asking,
    focus,
    canDecide,
    history,
    selIds,
    overCap,
    actions,
    decide,
    undo,
    step,
    toggle,
    run,
  ]);

  const changedCount = p ? (server?.changed ?? 0) : rows.filter((r) => r.changed !== null).length;
  const allChecked = list.length > 0 && selIds.length === list.length;
  const filtered =
    filters.q.trim() !== "" || filters.level !== "all" || filters.by !== "all" || filters.changed;
  const first = p ? (p.all ? 1 : (p.page - 1) * DECIDED_PAGE_SIZE + 1) : 1;
  const matched = p ? (server?.matched ?? 0) : list.length;
  const last = p ? (p.all ? matched : Math.min(matched, p.page * DECIDED_PAGE_SIZE)) : list.length;
  const summary = p
    ? matched === 0
      ? `Showing 0 of ${fmt(count(tab))}`
      : matched > DECIDED_PAGE_SIZE && !p.all
        ? `Showing ${fmt(first)}–${fmt(last)} of ${fmt(matched)}`
        : `Showing ${fmt(list.length)} of ${fmt(filtered ? matched : count(tab))}`
    : `Showing ${fmt(list.length)} of ${fmt(count(tab))}`;

  return (
    <div className="flex flex-col" data-slot="grant-attribution-board">
      <nav
        aria-label="Grant attribution"
        className="border-apollo-border-strong flex gap-x-7 overflow-x-auto border-b whitespace-nowrap max-md:-mx-4 max-md:gap-x-5 max-md:px-4"
      >
        {TABS.map(([t, label]) => (
          <Link
            key={t}
            href={t === "pending" ? "?" : `?tab=${t}`}
            aria-current={tab === t ? "page" : undefined}
            className={cn(
              "-mb-px flex min-h-11 items-center gap-2 border-b-2 px-0.5 pt-2.5 pb-3 text-[16px] no-underline",
              tab === t
                ? "border-apollo-maroon text-foreground font-semibold"
                : "hover:text-foreground border-transparent font-normal text-[var(--evidence-faint)]",
            )}
            data-testid={`grant-attribution-tab-${t}`}
          >
            {label}
            <span className="bg-apollo-surface-2 rounded-full px-2 py-px text-xs font-semibold text-[var(--evidence-body)] tabular-nums">
              {fmt(count(t))}
            </span>
          </Link>
        ))}
      </nav>
      <p className={cn("m-0 mt-3.5 mb-[18px] text-[14px] text-pretty", BODY)}>{TAB_DESC[tab]}</p>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Scholar, award or PI…"
          aria-label="Search"
          className={cn(CONTROL, "min-w-[200px] flex-[0_1_280px] px-3 outline-none")}
        />
        <label className={cn("flex items-center gap-2 text-[13px]", FAINT)}>
          Evidence
          <select
            value={filters.level}
            onChange={(e) => setFilter({ level: e.target.value as EvidenceLevel | "all" })}
            className={CONTROL}
          >
            <option value="all">All levels</option>
            {EVIDENCE_LEVELS.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        {server ? (
          <div className={cn("flex items-center gap-2 text-[13px]", FAINT)}>
            Decided by
            <div
              role="group"
              aria-label="Decided by"
              className="border-apollo-border-strong bg-apollo-surface flex overflow-hidden rounded-lg border"
            >
              {(
                [
                  ["all", "All", null],
                  ["curator", "Curator", server.byCounts.curator],
                  ["auto", "Automatic", server.byCounts.auto],
                ] as const
              ).map(([k, label, n], i) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={filters.by === k}
                  onClick={() => setFilter({ by: k })}
                  className={cn(
                    "px-3 py-[7px] text-[13px] whitespace-nowrap",
                    i > 0 && "border-apollo-border border-l",
                    filters.by === k ? "bg-apollo-surface-2 text-foreground" : BODY,
                  )}
                  data-testid={`grant-attribution-by-${k}`}
                >
                  {label}
                  {n === null ? null : (
                    <span className={cn("ml-1 tabular-nums", FAINT)}>{fmt(n)}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <label className="flex cursor-pointer items-center gap-2 text-[13px] whitespace-nowrap">
          <input
            type="checkbox"
            checked={filters.changed}
            onChange={() => setFilter({ changed: !filters.changed })}
            className="m-0 size-4 accent-[#2a2421]"
            data-testid="grant-attribution-changed"
          />
          Changed this run ({fmt(changedCount)})
        </label>
        <label className={cn("ml-auto flex items-center gap-2 text-[13px]", FAINT)}>
          Sort
          <select
            value={filters.sort}
            onChange={(e) => setFilter({ sort: e.target.value as BoardFilters["sort"] })}
            className={CONTROL}
          >
            <option value="high">Score, high to low</option>
            <option value="low">Score, low to high</option>
            <option value="name">Scholar A–Z</option>
          </select>
        </label>
      </div>

      {error ? (
        <div
          role="alert"
          className="border-destructive bg-apollo-red-tint text-destructive mb-4 flex items-center gap-3 rounded-lg border px-3 py-[9px] text-[13.5px]"
          data-testid="grant-attribution-error"
        >
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="ml-auto text-[13px]">
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(280px,380px)_minmax(0,1fr)] items-start gap-5 max-md:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-3">
          <div
            className="bg-apollo-surface border-apollo-border overflow-hidden rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)]"
            data-testid="grant-attribution-list"
          >
            <div
              className={cn(
                "bg-apollo-surface-2 border-apollo-border flex min-h-11 flex-wrap items-center gap-2.5 border-b px-4 py-1.5 text-[13px]",
                BODY,
              )}
            >
              {canDecide ? (
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() =>
                    setSelected(allChecked ? new Set() : new Set(list.map((r) => r.id)))
                  }
                  aria-label="Select all shown"
                  className="m-0 size-4 accent-[#2a2421]"
                />
              ) : null}
              {selIds.length === 0 ? (
                <>
                  <span>{summary}</span>
                  <span
                    aria-hidden
                    className={cn("ml-auto hidden items-center gap-1 text-xs md:flex", FAINT)}
                  >
                    <Kbd>J</Kbd>
                    <Kbd>K</Kbd> move
                  </span>
                </>
              ) : bulkAsking ? (
                <BulkReason
                  count={selIds.length}
                  value={bulkReason}
                  onChange={setBulkReason}
                  busy={busy}
                  disabled={overCap}
                  onSubmit={() => void decide(selIds, "reject", bulkReason)}
                  onCancel={() => setBulkAsking(false)}
                />
              ) : (
                <>
                  <span className="text-foreground font-semibold">{selIds.length} selected</span>
                  <div className="ml-auto flex flex-wrap gap-1.5">
                    {actions
                      .filter((a) => a.verb !== "skip")
                      .map((a) => (
                        <Button
                          key={a.verb}
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busy || overCap}
                          onClick={() => run(a.verb, selIds)}
                          data-testid={`grant-attribution-bulk-${a.verb}`}
                        >
                          {a.label}
                        </Button>
                      ))}
                  </div>
                  {overCap ? (
                    <span className="text-apollo-amber w-full text-[12.5px]">
                      Up to {GRANT_ATTRIBUTION_BULK_MAX} at a time
                    </span>
                  ) : null}
                </>
              )}
            </div>
            {list.length === 0 ? (
              <div
                className={cn("px-5 py-10 text-center text-[14px]", FAINT)}
                data-testid="grant-attribution-empty"
              >
                {filtered ? "Nothing matches these filters." : "Nothing here."}
              </div>
            ) : (
              <div
                ref={listRef}
                className="max-h-[calc(100vh-200px)] overflow-auto max-md:max-h-[60vh]"
              >
                {list.map((r) => (
                  <ListRow
                    key={r.id}
                    row={r}
                    focused={r.id === focus}
                    checked={selected.has(r.id)}
                    canDecide={canDecide}
                    onFocus={() => {
                      setFocusId(r.id);
                      if (asking !== r.id) setAsking(null);
                    }}
                    onToggle={() => toggle(r.id)}
                  />
                ))}
              </div>
            )}
          </div>
          {p && matched > DECIDED_PAGE_SIZE ? (
            <nav
              aria-label="Pages"
              className={cn("flex flex-wrap items-center gap-2.5 text-[13px]", BODY)}
            >
              {p.all ? (
                <button
                  type="button"
                  onClick={() => go({ all: false })}
                  className="text-apollo-slate hover:underline"
                  data-testid="grant-attribution-show-paged"
                >
                  Show {DECIDED_PAGE_SIZE} per page
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => go({ all: true })}
                  className="text-apollo-slate hover:underline"
                  data-testid="grant-attribution-show-all"
                >
                  Show all {fmt(matched)}
                </button>
              )}
              {p.all ? null : (
                <span className="ml-auto flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={p.page <= 1}
                    onClick={() => go({ page: p.page - 1 })}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={last >= matched}
                    onClick={() => go({ page: p.page + 1 })}
                  >
                    Next
                  </Button>
                </span>
              )}
            </nav>
          ) : null}
        </div>

        {current ? (
          <Detail
            row={current}
            position={`${idx + 1} of ${list.length}`}
            canDecide={canDecide}
            busy={busy}
            actions={actions}
            asking={asking === current.id}
            otherText={otherText}
            onOtherText={setOtherText}
            showNothing={showNothing}
            onToggleNothing={() => setShowNothing((v) => !v)}
            also={
              tab === "pending"
                ? list.filter((o) => o.id !== current.id && o.scholar.cwid === current.scholar.cwid)
                : []
            }
            onGo={(id) => {
              setFocusId(id);
              setAsking(null);
              scrollTo(id);
            }}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            onRun={(verb) => run(verb, null)}
            onReject={(why) => void decide([current.id], "reject", why)}
            onCancelReject={() => setAsking(null)}
          />
        ) : null}
      </div>

      {toast ? (
        <DecisionStatusBar
          text={toast.text}
          canUndo={canDecide && toast.undo !== null}
          undoing={undoing}
          onUndo={() => void undo(toast.undo)}
          onDismiss={() => setToast(null)}
          testId="grant-attribution-status"
          className="fixed bottom-6 left-1/2 z-20 w-max max-w-[calc(100vw-32px)] -translate-x-1/2 shadow-[0_6px_20px_rgba(0,0,0,.18)]"
        />
      ) : null}
    </div>
  );
}

function BulkReason({
  count,
  value,
  onChange,
  busy,
  disabled,
  onSubmit,
  onCancel,
}: {
  count: number;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  disabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex w-full flex-wrap items-center gap-1.5"
      data-testid="grant-attribution-bulk-reasons"
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Reason for not this person"
        className="border-apollo-border-strong bg-apollo-surface text-foreground h-[26px] min-w-0 flex-1 rounded-md border px-1.5 text-[12.5px]"
      >
        <option value="">Reason (required)</option>
        {GRANT_REJECTION_REASONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={busy || disabled || !value}
        onClick={onSubmit}
      >
        Mark {count}
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function LevelChip({ row, showScore = true }: { row: BoardRow; showScore?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex gap-1.5 self-start rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap",
        CHIP[row.level],
      )}
      data-testid="grant-attribution-level"
    >
      {showScore ? <span className="tabular-nums">{signed(row.score)}</span> : null}
      <span>{evidenceLevelLabel(row.level)}</span>
    </span>
  );
}

function ListRow({
  row: r,
  focused,
  checked,
  canDecide,
  onFocus,
  onToggle,
}: {
  row: BoardRow;
  focused: boolean;
  checked: boolean;
  canDecide: boolean;
  onFocus: () => void;
  onToggle: () => void;
}) {
  const a = r.award;
  const prov = provenance(r);
  return (
    <div
      data-row={r.id}
      onClick={onFocus}
      aria-current={focused ? "true" : undefined}
      className={cn(
        "border-apollo-border grid cursor-pointer gap-3 border-b px-4 py-[13px] last:border-b-0",
        canDecide ? "grid-cols-[16px_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
        focused ? "bg-apollo-surface-2 shadow-[inset_3px_0_0_#2a2421]" : "bg-apollo-surface",
      )}
      data-testid={`grant-attribution-item-${r.id}`}
    >
      {canDecide ? (
        <input
          type="checkbox"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
          aria-label={`Select ${r.scholar.name}`}
          className="m-0 mt-[3px] size-4 accent-[#2a2421]"
        />
      ) : null}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className="truncate text-[15px] font-semibold"
          data-testid="grant-attribution-row-name"
        >
          {r.scholar.name}
        </span>
        <span className={cn("truncate text-[13px]", BODY)}>
          {[a.activityCode, years(a.startYear, a.endYear), a.title ?? "Untitled award"]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {prov ? <span className={cn("text-xs", FAINT)}>{prov}</span> : null}
      </div>
      <LevelChip row={r} />
    </div>
  );
}

function Detail({
  row: r,
  position,
  canDecide,
  busy,
  actions,
  asking,
  otherText,
  onOtherText,
  showNothing,
  onToggleNothing,
  also,
  onGo,
  onPrev,
  onNext,
  onRun,
  onReject,
  onCancelReject,
}: {
  row: BoardRow;
  position: string;
  canDecide: boolean;
  busy: boolean;
  actions: Action[];
  asking: boolean;
  otherText: string;
  onOtherText: (v: string) => void;
  showNothing: boolean;
  onToggleNothing: () => void;
  also: BoardRow[];
  onGo: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onRun: (verb: Verb) => void;
  onReject: (why: string) => void;
  onCancelReject: () => void;
}) {
  const a = r.award;
  const reporter = reporterProjectUrl(a.applId);
  const tone = levelTone(r.level);
  const level = EVIDENCE_LEVELS.find((l) => l.key === r.level)!;
  const decision = decisionSummary(r);
  const coPi = r.cues.find((x) => x.id === "copi_coauthor")?.coPi ?? null;
  const nameParts = r.reporterName ? reporterNameParts(r.reporterName, r.scholar.names) : [];
  const mismatch = nameParts.some((n) => n.differs);
  const main = mainCue(r);
  const nothing = checkedNothingFound(
    new Set(r.cues.map((c) => c.id)),
    a.orgs.some((o) => o.wcm),
  );
  const orgs =
    a.orgs.length === 1
      ? a.orgs[0]!.name
      : a.orgs
          .map((o) => `${o.name}${years(o.from, o.to) ? ` (${years(o.from, o.to)})` : ""}`)
          .join(", ");
  const short = shortName(r.scholar.name);

  return (
    <section
      className="bg-apollo-surface border-apollo-border sticky top-4 flex max-h-[calc(100vh-32px)] min-w-0 flex-col overflow-hidden rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)] max-md:static max-md:max-h-none"
      aria-label="Award detail"
      data-testid="grant-attribution-detail"
    >
      <div className="flex min-h-0 flex-[1_1_auto] flex-col gap-6 overflow-auto px-7 pt-6 pb-2 max-md:px-4">
        <div className="flex flex-none items-start gap-4">
          <span
            aria-hidden
            className={cn(
              "bg-apollo-surface-2 border-apollo-border-strong flex size-12 flex-none items-center justify-center rounded-full border text-[15px] font-semibold",
              BODY,
            )}
          >
            {initials(r.scholar.name)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* self-start: a stretched full-width trigger left no room on the right, so the card flipped over the list */}
            <ScholarHoverCard cwid={r.scholar.cwid}>
              <span className="self-start text-[22px] font-semibold">{r.scholar.name}</span>
            </ScholarHoverCard>
            {r.scholar.sub ? (
              <span className={cn("text-[14px] text-pretty", BODY)}>{r.scholar.sub}</span>
            ) : null}
            <span className="flex items-center gap-2.5 text-[13px]">
              <span className={cn("font-mono", FAINT)}>{r.scholar.cwid}</span>
              {r.scholar.slug ? (
                <a
                  href={profilePath(r.scholar.slug)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-apollo-slate"
                >
                  Profile ↗
                </a>
              ) : (
                <span className={cn("italic", FAINT)}>no public profile</span>
              )}
            </span>
          </div>
          <div
            className={cn("flex flex-none items-center gap-1 text-[13px] whitespace-nowrap", FAINT)}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onPrev}
              aria-label="Previous"
            >
              ‹
            </Button>
            <span className="tabular-nums">{position}</span>
            <Button type="button" variant="ghost" size="icon-sm" onClick={onNext} aria-label="Next">
              ›
            </Button>
          </div>
        </div>

        <div className="border-apollo-border bg-apollo-surface flex flex-none flex-wrap rounded-[10px] border">
          <div className="border-apollo-border -ml-px flex flex-[1_1_240px] flex-col gap-1 border-l px-4 py-3">
            <span className={EYEBROW}>Evidence · from the weekly check</span>
            <span className="flex items-center gap-2.5">
              <span className={cn("text-[20px] font-semibold tabular-nums", TONE_TEXT[tone])}>
                {signed(r.score)}
              </span>
              <span className="font-semibold whitespace-nowrap">{level.label}</span>
            </span>
            <span className={cn("text-[13px]", BODY)}>{level.desc}</span>
          </div>
          <div
            className="border-apollo-border -ml-px flex flex-[1_1_240px] flex-col gap-1 border-l px-4 py-3"
            data-testid="grant-attribution-decision"
          >
            <span className={EYEBROW}>Decision</span>
            <span className="pt-[3px] text-[15px] font-semibold">{decision.title}</span>
            <span className={cn("text-[13px]", BODY)}>{decision.note}</span>
          </div>
        </div>

        <div className="flex flex-none flex-col gap-2">
          <span className={EYEBROW}>Award, as RePORTER prints it</span>
          {nameParts.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-1.5 text-[18px]"
              data-testid="grant-attribution-on-award"
            >
              <span className={cn("text-[14px]", FAINT)}>Name on award</span>
              {nameParts.map((n, i) =>
                n.differs ? (
                  <mark
                    key={i}
                    className="bg-apollo-amber-tint text-foreground rounded-[3px] px-0.5 font-bold underline underline-offset-[3px]"
                  >
                    {n.text}
                  </mark>
                ) : (
                  <span key={i} className="px-0.5 font-semibold">
                    {n.text}
                  </span>
                ),
              )}
              {mismatch ? (
                <span className="text-apollo-amber text-xs">differs from profile</span>
              ) : null}
            </div>
          ) : null}
          <span className="text-[15px] leading-[1.35] font-medium text-pretty">
            {a.title ?? "Untitled award"}
          </span>
          <span className={cn("text-[14px]", BODY)}>
            {[
              a.activityCode ? (
                <span key="m" className="text-foreground font-semibold">
                  {a.activityCode}
                </span>
              ) : null,
              (a.awardNumber ?? a.coreProjectNum) ? (
                <span key="n" className="font-mono text-[13px]">
                  {a.awardNumber ?? a.coreProjectNum}
                </span>
              ) : null,
              years(a.startYear, a.endYear) || null,
              orgs || null,
              reporter ? (
                <a
                  key="r"
                  href={reporter}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-apollo-slate"
                >
                  RePORTER ↗
                </a>
              ) : null,
            ]
              .filter((x) => x !== null)
              .map((x, i) => (
                <span key={i}>
                  {i > 0 ? " · " : null}
                  {x}
                </span>
              ))}
          </span>
          {a.piNames.length > 0 ? (
            <span className={cn("text-[14px]", BODY)} data-testid="grant-attribution-pis">
              <span className={FAINT}>{a.piNames.length > 1 ? "PIs " : "PI "}</span>
              {a.piNames
                .map((raw) => {
                  const co = coPi !== null && coPi.name.toLowerCase() === raw.toLowerCase();
                  return `${reporterNameForDisplay(raw)}${co ? " (co-author)" : ""}`;
                })
                .join(" · ")}
            </span>
          ) : null}
        </div>

        <div className="flex flex-none flex-col gap-3">
          <span className={EYEBROW}>How the score adds up</span>
          <div
            className="border-apollo-border flex flex-none flex-col rounded-[10px] border"
            data-testid="grant-attribution-evidence"
          >
            <div
              className={cn(
                "bg-apollo-surface-2 grid grid-cols-[44px_minmax(0,1fr)] gap-3 rounded-t-[9px] px-4 py-2.5 text-[14px]",
                BODY,
              )}
            >
              <span className="text-right tabular-nums">{signed(PRIOR)}</span>
              <span>Every award starts here</span>
            </div>
            {r.cues.map((c) => (
              <LedgerRow key={c.id} cue={c} main={c === main} />
            ))}
            <div className="border-apollo-border-strong grid grid-cols-[44px_minmax(0,1fr)] gap-3 border-t px-4 py-3.5">
              <span className="text-right text-[18px] font-bold tabular-nums">
                {signed(r.score)}
              </span>
              <div className="flex flex-col gap-2.5">
                <span className="font-semibold">Score · {level.label}</span>
                <Scale score={r.score} />
              </div>
            </div>
          </div>
          {nothing.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                aria-expanded={showNothing}
                onClick={onToggleNothing}
                className={cn("flex items-center gap-1.5 self-start text-[13px]", BODY)}
                data-testid="grant-attribution-nothing-toggle"
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-block w-3 transition-transform",
                    showNothing && "rotate-90",
                  )}
                >
                  ›
                </span>
                Checked, nothing found
                <span className="bg-apollo-surface-2 rounded-full px-[7px] text-xs font-semibold">
                  {nothing.length}
                </span>
              </button>
              {showNothing ? (
                <ul
                  className={cn(
                    "m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-5 gap-y-1 p-0 pl-[18px] text-[13px]",
                    FAINT,
                  )}
                >
                  {nothing.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        {also.length > 0 ? (
          <div className="flex flex-none flex-col gap-[5px] text-[13px]">
            <span className={EYEBROW}>Also to review for {short}</span>
            {also.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onGo(o.id)}
                className="text-apollo-slate text-left text-[13px]"
              >
                {o.award.title ?? "Untitled award"}{" "}
                <span className={FAINT}>
                  ·{" "}
                  {[o.award.activityCode, years(o.award.startYear, o.award.endYear)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {canDecide && asking ? (
        <div
          className="border-apollo-border bg-apollo-surface-2 flex flex-none flex-col gap-2.5 border-t px-7 py-3.5 max-md:px-4"
          data-testid="grant-attribution-reasons"
        >
          <span className="text-[13.5px] font-semibold">
            Why isn’t this {short}’s award?{" "}
            <span className={cn("font-normal", FAINT)}>A reason is required.</span>
          </span>
          <div className="flex flex-wrap gap-2">
            {GRANT_REJECTION_REASONS.map((reason, i) => (
              <button
                key={reason}
                type="button"
                disabled={busy}
                onClick={() => onReject(reason)}
                className="border-apollo-border-strong bg-apollo-surface flex items-center gap-[7px] rounded-lg border px-2.5 py-1.5 text-[13px]"
              >
                <span aria-hidden className="hidden md:inline">
                  <Kbd>{i + 1}</Kbd>
                </span>
                <span>{reason}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={otherText}
              onChange={(e) => onOtherText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && otherText.trim()) onReject(otherText.trim());
                if (e.key === "Escape") onCancelReject();
              }}
              maxLength={GRANT_REJECTION_REASON_MAX}
              placeholder="Or type a reason, then Enter"
              aria-label="Other reason"
              className="border-apollo-border-strong bg-apollo-surface h-8 min-w-[200px] flex-1 rounded-md border px-2.5 text-[13px] outline-none"
            />
            <button
              type="button"
              onClick={onCancelReject}
              className={cn("flex items-center gap-1.5 text-[13px]", FAINT)}
            >
              Cancel
              <span aria-hidden className="hidden md:inline">
                <Kbd>Esc</Kbd>
              </span>
            </button>
          </div>
        </div>
      ) : canDecide ? (
        <div className="border-apollo-border bg-apollo-surface flex flex-none flex-wrap items-center gap-2 border-t px-7 py-3.5 max-md:px-4">
          {actions.map((x) => (
            <Button
              key={x.verb}
              type="button"
              variant={x.variant}
              disabled={busy}
              onClick={() => onRun(x.verb)}
              className={cn(
                x.variant === "default" && "bg-[#2a2421] text-white hover:bg-[#2a2421]/90",
              )}
            >
              {x.label}
              <span aria-hidden className="hidden md:inline">
                <Kbd light={x.variant === "default"}>{x.key}</Kbd>
              </span>
            </Button>
          ))}
          <span aria-hidden className={cn("ml-auto hidden text-xs md:inline", FAINT)}>
            U undo
          </span>
        </div>
      ) : null}
    </section>
  );
}

function LedgerRow({ cue, main }: { cue: BoardRow["cues"][number]; main: boolean }) {
  const color = cue.weight > 0 ? "text-apollo-slate" : cue.weight < 0 ? "text-apollo-amber" : FAINT;
  return (
    <div className="border-apollo-border grid grid-cols-[44px_minmax(0,1fr)] gap-3 border-t px-4 py-3">
      <span className={cn("text-right font-semibold tabular-nums", color)}>
        {signed(cue.weight)}
      </span>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold" data-testid={`grant-attribution-cue-${cue.id}`}>
            {cueLabel(cue.id)}
          </span>
          {main ? (
            <span
              className={cn(
                "border-apollo-border-strong rounded-full border px-[7px] text-[11px] font-semibold",
                BODY,
              )}
            >
              Main reason
            </span>
          ) : null}
        </div>
        <span className={cn("text-[14px] text-pretty", BODY)}>
          {cue.coPi
            ? `${reporterNameForDisplay(cue.coPi.name)}, a co-PI on this award, co-authored ${cue.coPi.total} of the scholar's papers.`
            : cue.reason}
        </span>
        {cue.coPi && cue.coPi.papers.length > 0 ? (
          <div className="flex flex-col gap-1">
            {cue.coPi.papers.map((p) => (
              <div key={p.pmid} className="border-apollo-border border-l-2 pl-3 text-[13px]">
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-apollo-slate"
                >
                  <PubTitle value={p.title} />
                </a>{" "}
                <span className={FAINT}>
                  · <PubJournal as="span" value={p.journal} /> {p.year ?? ""}
                </span>
              </div>
            ))}
            {cue.coPi.total > cue.coPi.papers.length ? (
              <span className={cn("pl-3.5 text-[13px]", FAINT)}>
                + {cue.coPi.total - cue.coPi.papers.length} more
              </span>
            ) : null}
          </div>
        ) : null}
        {cue.rejected && cue.rejected.length > 0 ? (
          <div className="flex flex-col gap-1" data-testid="grant-attribution-rejected-papers">
            {cue.rejected.map((p) => (
              <div key={p.pmid} className="border-apollo-border border-l-2 pl-3 text-[13px]">
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-apollo-slate"
                >
                  {p.title ? <PubTitle value={p.title} /> : `PMID ${p.pmid}`}
                </a>
                {p.title ? <span className={FAINT}> · PMID {p.pmid}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The score on a −8…+6 line, with the hide and confirm marks. */
function Scale({ score }: { score: number }) {
  const hide = scalePct(HIDE_AT);
  const show = scalePct(SHOW_AT);
  return (
    <div
      role="img"
      aria-label={`Score ${signed(score)}. Hide at ${signed(HIDE_AT)} or below, confirm at ${signed(SHOW_AT)} or above.`}
      className="relative h-7 max-w-[460px]"
    >
      <div
        className="absolute inset-x-0 top-1.5 h-2 rounded-full"
        style={{
          background: `linear-gradient(90deg, var(--apollo-amber-tint) 0 ${hide}%, var(--apollo-surface-2) ${hide}% ${show}%, var(--apollo-slate-tint) ${show}% 100%)`,
        }}
      />
      <div
        className={cn(
          "absolute top-0 h-5 border-l border-dashed",
          "border-[var(--evidence-faint)]",
        )}
        style={{ left: `${hide}%` }}
      />
      <div
        className={cn(
          "absolute top-0 h-5 border-l border-dashed",
          "border-[var(--evidence-faint)]",
        )}
        style={{ left: `${show}%` }}
      />
      <div
        className="absolute top-[3px] -ml-[7px] size-3.5 rounded-full border-2 border-white bg-[#2a2421] shadow-[0_0_0_1px_#2a2421]"
        style={{ left: `${scalePct(score)}%` }}
      />
      <span
        className={cn("absolute top-5 -translate-x-1/2 text-[11px] whitespace-nowrap", FAINT)}
        style={{ left: `${hide}%` }}
      >
        {signed(HIDE_AT)} hide
      </span>
      <span
        className={cn("absolute top-5 -translate-x-1/2 text-[11px] whitespace-nowrap", FAINT)}
        style={{ left: `${show}%` }}
      >
        {signed(SHOW_AT)} confirm
      </span>
    </div>
  );
}
