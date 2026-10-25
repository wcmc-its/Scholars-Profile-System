"use client";

/**
 * #3071 — the grant attribution queue (`/edit/grant-attribution-queue`).
 *
 * A split review: the open awards as a list on the left (filter, sort, tick
 * for bulk), the focused one in full on the right. The detail puts the scholar
 * beside the award as RePORTER prints it, marks the scholar and the co-author
 * co-PI in the PI list, lists every cue that fired (with the shared papers for
 * a co-PI co-author), and places the award on a rule-based confidence scale.
 * Confirm shows the award; Not this person keeps it hidden with a curator hide
 * the ETL never touches, and always takes a reason; Skip moves the card to the
 * end of this session's list and writes nothing. Bulk decisions go through the
 * shared `SelectionBar`, up to GRANT_ATTRIBUTION_BULK_MAX in one all-or-nothing
 * call. The decided tabs (Confirmed, Not this person, Unproven) are
 * `grant-attribution-decided.tsx`; the page renders the tab bar.
 *
 * A decided card stays in the list, dimmed (no refresh: the replica may not
 * have the write yet). Mockup: Projects/Scholars-Profile-System/mockups/Grant
 * matching queue/Grant Attribution Redesign.dc.html.
 *
 * Imports only the pure `@/lib/edit/grant-attribution-queue` — nothing that
 * reaches the database.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Kbd, ReasonSelect, shortName } from "@/components/edit/honors-review";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { DecisionStatusBar } from "@/components/edit/news-review-shared";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { SelectionBar, SelectionBarSpacer } from "@/components/edit/selection-bar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ATTRIBUTION_LEVELS,
  GRANT_ATTRIBUTION_BULK_MAX,
  GRANT_REJECTION_REASONS,
  GRANT_REJECTION_REASON_MAX,
  attributionLevel,
  cueLabel,
  isCoauthorshipOnly,
  isScholarPi,
  reporterNameForDisplay,
  reporterProjectUrl,
  type AttributionLevel,
  type GrantAttributionItem,
} from "@/lib/edit/grant-attribution-queue";
import { profilePath } from "@/lib/profile-url";
import { cn } from "@/lib/utils";

type Outcome = { kind: "confirmed" | "rejected" | "reopened"; reason?: string };
type EvidenceFilter = "all" | "co" | "red" | "timeline";
type Sort = "oldest" | "high" | "low" | "scholar" | "start";

const LEVEL_RANK: Record<AttributionLevel, number> = Object.fromEntries(
  ATTRIBUTION_LEVELS.map((l, i) => [l.key, i]),
) as Record<AttributionLevel, number>;
const LEVEL_LABEL: Record<AttributionLevel, string> = Object.fromEntries(
  ATTRIBUTION_LEVELS.map((l) => [l.key, l.label]),
) as Record<AttributionLevel, string>;
/** The list pill (tint) and the active scale step (solid), per level. */
const LEVEL_PILL: Record<AttributionLevel, string> = {
  high: "bg-apollo-slate-tint text-apollo-slate",
  likely: "bg-apollo-surface-2 text-apollo-slate",
  conflict: "bg-apollo-amber-tint text-apollo-amber",
  unclear: "bg-apollo-surface-2 text-[#3a3532]",
  out: "bg-apollo-red-tint text-destructive",
};
const LEVEL_SOLID: Record<AttributionLevel, string> = {
  high: "bg-apollo-slate text-white",
  likely: "bg-apollo-slate text-white",
  conflict: "bg-apollo-amber text-white",
  unclear: "bg-[#3a3532] text-white",
  out: "bg-destructive text-white",
};
const EYEBROW = "text-muted-foreground text-[11.5px] font-semibold tracking-[0.08em] uppercase";
const CONTROL =
  "border-apollo-border-strong bg-apollo-surface h-[34px] rounded-lg border px-2 text-[13px] text-foreground";

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
  if (status === 403) return "Your role can read this queue but not decide it.";
  return "We couldn't record that decision. Please try again.";
}

async function postDecision(
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/edit/grant-attribution/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, message: errorMessage(res.status, data?.error) };
  } catch {
    return { ok: false, message: "We couldn't record that decision. Please try again." };
  }
}

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
  return w.length === 0 ? "" : ((w[0]![0] ?? "") + (w.length > 1 ? (w[w.length - 1]![0] ?? "") : "")).toUpperCase();
}

type Card = GrantAttributionItem & {
  order: number;
  level: AttributionLevel;
  veto: string | null;
  coOnly: boolean;
  hasNeg: boolean;
  timeline: boolean;
  search: string;
};

function prepare(items: GrantAttributionItem[]): Card[] {
  return items.map((it, order) => {
    const { level, veto } = attributionLevel(it.cues);
    return {
      ...it,
      order,
      level,
      veto,
      coOnly: isCoauthorshipOnly(it.cues),
      hasNeg: it.cues.some((c) => c.weight < 0),
      timeline: it.cues.some((c) => c.id === "timeline_impossible" || c.id === "timeline_unlikely"),
      search: [it.scholarName, it.award.title, it.award.awardNumber, ...it.award.piNames.map(reporterNameForDisplay)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });
}

const SORTS: Record<Sort, (a: Card, b: Card) => number> = {
  oldest: (a, b) => a.order - b.order,
  high: (a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.order - b.order,
  low: (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.order - b.order,
  scholar: (a, b) => a.scholarName.localeCompare(b.scholarName) || a.order - b.order,
  start: (a, b) => (a.award.startYear ?? 0) - (b.award.startYear ?? 0) || a.order - b.order,
};

function summaryOf(c: Card): string {
  return {
    high: "Strong evidence for this scholar",
    likely: c.coOnly ? "Only link is a co-PI who co-authors with the scholar" : "One supporting cue, nothing against",
    conflict: "Evidence points both ways",
    unclear: "No real evidence either way",
    out: "Strong evidence against",
  }[c.level];
}

function scaleNoteOf(c: Card): string {
  const note = {
    out: c.veto
      ? `${cueLabel(c.veto)} points strongly to someone else, and nothing strong ties it to the scholar. Most likely “Not this person”.`
      : "",
    conflict: "Strong cues on both sides. Read the evidence before deciding.",
    high: c.cues.some((x) => x.id === "pub_linked")
      ? "A linked publication supports this, with nothing against."
      : "Two or more cues support this, with nothing against.",
    likely: "One supporting cue and nothing against.",
    unclear: "No cues point either way.",
  }[c.level];
  return `${note} Levels are rule-based until they can be checked against past decisions.`;
}

export function GrantAttributionQueue({
  pending,
  readOnly,
}: {
  pending: GrantAttributionItem[];
  readOnly: boolean;
}) {
  const cards = useMemo(() => prepare(pending), [pending]);
  const [q, setQ] = useState("");
  const [evidence, setEvidence] = useState<EvidenceFilter>("all");
  const [levelFilter, setLevelFilter] = useState<AttributionLevel | "all">("all");
  const [sort, setSort] = useState<Sort>("high");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");
  const [bulkReason, setBulkReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; ids: string[] | null } | null>(null);
  const [history, setHistory] = useState<string[][]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const canDecide = !readOnly;

  const filtered = q.trim() !== "" || evidence !== "all" || levelFilter !== "all";
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = cards.filter(
      (c) =>
        (!needle || c.search.includes(needle)) &&
        (evidence === "all" ||
          (evidence === "co" && c.coOnly) ||
          (evidence === "red" && c.hasNeg) ||
          (evidence === "timeline" && c.timeline)) &&
        (levelFilter === "all" || c.level === levelFilter),
    );
    const skipRank = (c: Card) => skipped.indexOf(c.id);
    return rows.sort((a, b) => skipRank(a) - skipRank(b) || SORTS[sort](a, b));
  }, [cards, q, evidence, levelFilter, sort, skipped]);

  const open = list.filter((c) => !outcomes[c.id]);
  const current = list.find((c) => c.id === focusId) ?? list[0] ?? null;
  const focus = current?.id ?? null;

  const scrollTo = useCallback((id: string) => {
    listRef.current?.querySelector(`[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, []);

  const moveFocus = useCallback(
    (from: string | null, step: 1 | -1, decided: Record<string, Outcome>, skipDecided: boolean) => {
      let i = list.findIndex((c) => c.id === from);
      for (let k = 0; k < list.length; k++) {
        i += step;
        if (i < 0 || i >= list.length) return;
        const c = list[i]!;
        if (!skipDecided || !decided[c.id]) {
          setFocusId(c.id);
          scrollTo(c.id);
          return;
        }
      }
    },
    [list, scrollTo],
  );

  const decide = useCallback(
    async (ids: string[], decision: "confirm" | "reject", why?: string) => {
      if (!canDecide || busy) return;
      const todo = ids.filter((id) => !outcomes[id]);
      if (todo.length === 0) return;
      setBusy(true);
      setError(null);
      const body: Record<string, unknown> = todo.length === 1 ? { id: todo[0] } : { ids: todo };
      const r = await postDecision({ ...body, decision, ...(why ? { reason: why } : {}) });
      setBusy(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      const next = { ...outcomes };
      for (const id of todo) next[id] = decision === "confirm" ? { kind: "confirmed" } : { kind: "rejected", reason: why };
      setOutcomes(next);
      setSelected((s) => new Set([...s].filter((id) => !todo.includes(id))));
      setAsking(null);
      setOtherText("");
      setHistory((h) => [...h, todo]);
      const one = todo.length === 1;
      setToast({
        text:
          decision === "confirm"
            ? one
              ? "Confirmed. The award now shows on the scholar's profile; search updates within minutes."
              : `Confirmed ${todo.length} awards. They now show on profiles; search updates within minutes.`
            : one
              ? "Hidden as not this person. The scholar's profile will not show it."
              : `Hid ${todo.length} awards as not this person.`,
        ids: todo,
      });
      if (one && todo[0] === focus) moveFocus(focus, 1, next, true);
    },
    [canDecide, busy, outcomes, focus, moveFocus],
  );

  const undo = useCallback(
    async (ids: string[] | undefined) => {
      if (!ids || ids.length === 0 || undoing) return;
      setUndoing(true);
      setError(null);
      const r = await postDecision(ids.length === 1 ? { id: ids[0], decision: "undo" } : { ids, decision: "undo" });
      setUndoing(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      const pendingIds = new Set(cards.map((c) => c.id));
      setOutcomes((o) => {
        const n = { ...o };
        for (const id of ids) {
          if (pendingIds.has(id)) delete n[id];
          else n[id] = { kind: "reopened" };
        }
        return n;
      });
      setHistory((h) => h.filter((x) => x !== ids));
      setToast({ text: `Moved ${ids.length === 1 ? "the award" : `${ids.length} awards`} back to review.`, ids: null });
      if (ids.length === 1 && pendingIds.has(ids[0]!)) setFocusId(ids[0]!);
    },
    [cards, undoing],
  );

  const skip = useCallback(
    (id: string) => {
      if (outcomes[id]) return;
      const i = list.findIndex((c) => c.id === id);
      const next = list.slice(i + 1).find((c) => !outcomes[c.id]);
      setSkipped((s) => [...s.filter((x) => x !== id), id]);
      setAsking(null);
      setToast({ text: "Skipped. It moves to the end of this session’s list.", ids: null });
      if (next) {
        setFocusId(next.id);
        scrollTo(next.id);
      }
    },
    [list, outcomes, scrollTo],
  );

  const toggle = useCallback(
    (id: string, on?: boolean) => {
      if (!canDecide || outcomes[id]) return;
      setSelected((s) => {
        const n = new Set(s);
        if (on ?? !n.has(id)) n.add(id);
        else n.delete(id);
        return n;
      });
    },
    [canDecide, outcomes],
  );

  const startReject = useCallback(
    (id: string) => {
      if (!canDecide || outcomes[id]) return;
      setFocusId(id);
      setAsking(id);
      setOtherText("");
    },
    [canDecide, outcomes],
  );

  const selIds = useMemo(() => [...selected], [selected]);
  const overCap = selIds.length > GRANT_ATTRIBUTION_BULK_MAX;

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
        moveFocus(focus, 1, outcomes, false);
        return;
      }
      if (k === "k" || k === "arrowup") {
        e.preventDefault();
        moveFocus(focus, -1, outcomes, false);
        return;
      }
      if (k === "escape") {
        setSelected(new Set());
        return;
      }
      if (!canDecide) return;
      if (k === "u") {
        e.preventDefault();
        void undo(history[history.length - 1]);
        return;
      }
      if (!focus) return;
      if (k === "x") {
        e.preventDefault();
        toggle(focus);
      } else if (k === "c") {
        e.preventDefault();
        if (e.shiftKey && selIds.length > 0) {
          if (!overCap) void decide(selIds, "confirm");
        } else void decide([focus], "confirm");
      } else if (k === "n") {
        e.preventDefault();
        if (e.shiftKey && selIds.length > 0) {
          if (!bulkReason) setToast({ text: "Pick a reason in the selection bar first.", ids: null });
          else if (!overCap) void decide(selIds, "reject", bulkReason);
        } else startReject(focus);
      } else if (k === "s") {
        e.preventDefault();
        skip(focus);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking, focus, outcomes, canDecide, history, selIds, overCap, bulkReason, decide, undo, moveFocus, toggle, startReject, skip]);

  const countOf = (f: (c: Card) => boolean) => cards.filter(f).length;
  const coOnlyOpen = open.filter((c) => c.coOnly);
  const allSel = open.length > 0 && open.every((c) => selected.has(c.id));
  const showBar = canDecide && selIds.length > 0;

  return (
    <div className="flex flex-col gap-[18px]" data-slot="grant-attribution-queue">
      {error ? (
        <div
          role="alert"
          className="border-destructive bg-apollo-red-tint text-destructive flex items-center gap-3 rounded-lg border px-3 py-[9px] text-[13.5px]"
          data-testid="grant-attribution-error"
        >
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="ml-auto text-[13px]">
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Scholar, award or PI…"
              aria-label="Search"
              className={cn(CONTROL, "w-[220px] max-w-full px-2.5 text-[13.5px] outline-none")}
            />
            <label className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
              Evidence
              <select value={evidence} onChange={(e) => setEvidence(e.target.value as EvidenceFilter)} className={CONTROL}>
                <option value="all">All evidence</option>
                <option value="co">Co-authorship only ({countOf((c) => c.coOnly)})</option>
                <option value="red">Has a red flag ({countOf((c) => c.hasNeg)})</option>
                <option value="timeline">Timeline problem ({countOf((c) => c.timeline)})</option>
              </select>
            </label>
            <label className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
              Confidence
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value as AttributionLevel | "all")}
                className={CONTROL}
              >
                <option value="all">Any confidence</option>
                {ATTRIBUTION_LEVELS.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label} ({countOf((c) => c.level === l.key)})
                  </option>
                ))}
              </select>
            </label>
            {filtered ? (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  setEvidence("all");
                  setLevelFilter("all");
                }}
                className="text-apollo-slate text-[13px]"
              >
                Show all
              </button>
            ) : null}
            <label className="text-muted-foreground ml-auto flex items-center gap-1.5 text-[13px]">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={CONTROL}>
                <option value="oldest">Oldest first</option>
                <option value="high">Most confident first</option>
                <option value="low">Least confident first</option>
                <option value="scholar">Scholar A–Z</option>
                <option value="start">Award start year</option>
              </select>
            </label>
          </div>

          <div className="text-muted-foreground flex flex-wrap items-center gap-3.5 text-[13px]">
            {canDecide ? (
              <>
                <label className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={allSel}
                    onCheckedChange={(v) => setSelected(v === true ? new Set(open.map((c) => c.id)) : new Set())}
                  />
                  <span>Select all shown ({open.length})</span>
                </label>
                {coOnlyOpen.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setSelected(new Set(coOnlyOpen.map((c) => c.id)))}
                    className="text-apollo-slate text-[13px]"
                  >
                    Select {coOnlyOpen.length} co-authorship-only
                  </button>
                ) : null}
              </>
            ) : null}
            <span className="whitespace-nowrap">
              Showing {list.length} of {cards.length} · {open.length} open{filtered ? " · filtered" : ""}
            </span>
            {canDecide ? (
              <div aria-hidden className="ml-auto hidden flex-wrap items-center gap-2.5 text-xs md:flex">
                <span className="flex items-center gap-1">
                  <Kbd>J</Kbd>
                  <Kbd>K</Kbd> move
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>C</Kbd> confirm
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>N</Kbd> not this person
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>S</Kbd> skip
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>X</Kbd> select
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>U</Kbd> undo
                </span>
              </div>
            ) : null}
          </div>

          {list.length === 0 ? (
            <div
              className="bg-apollo-surface border-apollo-border-strong text-muted-foreground rounded-[var(--apollo-radius-card)] border p-8 text-center text-[14px]"
              data-testid="grant-attribution-empty"
            >
              {filtered ? "No cards match. Try a wider filter." : "Nothing to review."}
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-4">
              <div
                ref={listRef}
                className="bg-apollo-surface border-apollo-border-strong max-h-[calc(100vh-32px)] max-w-full min-w-[280px] flex-[0_1_340px] overflow-auto rounded-[var(--apollo-radius-card)] border"
                data-testid="grant-attribution-list"
              >
                {list.map((c) => (
                  <ListRow
                    key={c.id}
                    card={c}
                    focused={c.id === focus}
                    selected={selected.has(c.id)}
                    outcome={outcomes[c.id] ?? null}
                    canDecide={canDecide}
                    onFocus={() => {
                      setFocusId(c.id);
                      if (asking !== c.id) setAsking(null);
                    }}
                    onToggle={(on) => toggle(c.id, on)}
                  />
                ))}
              </div>
              {current ? (
                <Detail
                  card={current}
                  position={`${list.indexOf(current) + 1} of ${list.length}`}
                  outcome={outcomes[current.id] ?? null}
                  canDecide={canDecide}
                  busy={busy}
                  undoing={undoing}
                  asking={asking === current.id}
                  otherText={otherText}
                  onOtherText={setOtherText}
                  also={cards.filter((o) => o.id !== current.id && o.cwid === current.cwid && !outcomes[o.id])}
                  onGo={(id) => {
                    setFocusId(id);
                    setAsking(null);
                    scrollTo(id);
                  }}
                  onConfirm={() => void decide([current.id], "confirm")}
                  onStartReject={() => startReject(current.id)}
                  onReject={(why) => void decide([current.id], "reject", why)}
                  onCancelReject={() => setAsking(null)}
                  onSkip={() => skip(current.id)}
                  onUndo={() => void undo([current.id])}
                />
              ) : null}
            </div>
          )}
          <SelectionBarSpacer count={showBar ? selIds.length : 0} />
        </div>

      {toast ? (
        <DecisionStatusBar
          text={toast.text}
          canUndo={canDecide && toast.ids !== null}
          undoing={undoing}
          onUndo={() => void undo(toast.ids ?? undefined)}
          onDismiss={() => setToast(null)}
          testId="grant-attribution-status"
          className={cn(
            "fixed left-1/2 z-20 w-max max-w-[calc(100vw-32px)] -translate-x-1/2 shadow-[0_6px_20px_rgba(0,0,0,.18)]",
            showBar ? "bottom-[92px]" : "bottom-5",
          )}
        />
      ) : null}

      {showBar ? (
        <SelectionBar
          count={selIds.length}
          noun="award"
          nounPlural="awards"
          busy={busy}
          onClear={() => setSelected(new Set())}
          actions={
            <>
              {overCap ? (
                <span className="text-apollo-amber text-[12.5px]">Up to {GRANT_ATTRIBUTION_BULK_MAX} at a time</span>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={busy || overCap}
                onClick={() => void decide(selIds, "confirm")}
                className="bg-apollo-slate hover:bg-apollo-slate/90 text-[13px] text-white"
                data-testid="grant-attribution-bulk-confirm"
              >
                Confirm {selIds.length}
              </Button>
              <ReasonSelect
                value={bulkReason}
                onChange={setBulkReason}
                disabled={busy}
                small
                reasons={GRANT_REJECTION_REASONS}
                placeholder="Reason (required)"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || overCap || !bulkReason}
                onClick={() => void decide(selIds, "reject", bulkReason)}
                className="text-destructive hover:bg-apollo-red-tint hover:text-destructive text-[13px] font-normal"
                data-testid="grant-attribution-bulk-reject"
              >
                Not this person
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function ListRow({
  card: c,
  focused,
  selected,
  outcome,
  canDecide,
  onFocus,
  onToggle,
}: {
  card: Card;
  focused: boolean;
  selected: boolean;
  outcome: Outcome | null;
  canDecide: boolean;
  onFocus: () => void;
  onToggle: (on: boolean) => void;
}) {
  const a = c.award;
  return (
    <div
      data-row={c.id}
      onClick={onFocus}
      aria-current={focused ? "true" : undefined}
      className={cn(
        "border-apollo-border grid cursor-pointer items-center gap-2.5 border-b px-3.5 py-2.5",
        canDecide ? "grid-cols-[16px_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
        focused ? "bg-apollo-page shadow-[inset_3px_0_0_var(--color-apollo-slate)]" : selected ? "bg-apollo-slate-tint" : "bg-apollo-surface",
        outcome && "opacity-55",
      )}
      data-testid={`grant-attribution-item-${c.id}`}
    >
      {canDecide ? (
        <div onClick={(e) => e.stopPropagation()} className="flex">
          <Checkbox
            checked={selected}
            disabled={!!outcome}
            onCheckedChange={(v) => onToggle(v === true)}
            aria-label={`Select ${c.scholarName}`}
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[13.5px] font-semibold">{c.scholarName}</span>
        <span className="text-muted-foreground truncate text-[12.5px]">
          {[a.activityCode, years(a.startYear, a.endYear), a.title ?? "Untitled award"].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {outcome?.kind === "confirmed" ? (
          <span className="text-apollo-slate text-xs" data-testid="grant-attribution-outcome">
            Confirmed
          </span>
        ) : outcome?.kind === "rejected" ? (
          <span className="text-destructive text-xs" data-testid="grant-attribution-outcome">
            Not this person
          </span>
        ) : (
          <span className={cn("rounded-full px-2 py-px text-xs font-semibold whitespace-nowrap", LEVEL_PILL[c.level])}>
            {LEVEL_LABEL[c.level]}
          </span>
        )}
      </div>
    </div>
  );
}

function Detail({
  card: c,
  position,
  outcome,
  canDecide,
  busy,
  undoing,
  asking,
  otherText,
  onOtherText,
  also,
  onGo,
  onConfirm,
  onStartReject,
  onReject,
  onCancelReject,
  onSkip,
  onUndo,
}: {
  card: Card;
  position: string;
  outcome: Outcome | null;
  canDecide: boolean;
  busy: boolean;
  undoing: boolean;
  asking: boolean;
  otherText: string;
  onOtherText: (v: string) => void;
  also: Card[];
  onGo: (id: string) => void;
  onConfirm: () => void;
  onStartReject: () => void;
  onReject: (why: string) => void;
  onCancelReject: () => void;
  onSkip: () => void;
  onUndo: () => void;
}) {
  const a = c.award;
  const reporter = reporterProjectUrl(a.applId);
  const short = shortName(c.scholarName);
  const coPi = c.cues.find((x) => x.id === "copi_coauthor")?.coPi ?? null;
  const cues = [...c.cues].sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight));
  const decided = outcome && outcome.kind !== "reopened" ? outcome : null;
  return (
    <section
      className="bg-apollo-surface border-apollo-border-strong sticky top-4 flex max-w-full min-w-0 flex-[1_1_400px] flex-col rounded-[var(--apollo-radius-card)] border"
      aria-label="Award under review"
      data-testid="grant-attribution-detail"
    >
      <div className="flex flex-col gap-5 px-6 py-[22px]">
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden
            className="bg-apollo-surface-2 ring-apollo-border-strong flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ring-1"
          >
            {initials(c.scholarName)}
          </span>
          <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
            <ScholarHoverCard cwid={c.cwid}>
              <span className="text-[17px] font-semibold">{c.scholarName}</span>
            </ScholarHoverCard>
            <span className="text-muted-foreground text-[13px]">
              {[c.title, c.department].filter(Boolean).join(" · ")} {/* pub-html-ok: the scholar's job title */}
              {c.title || c.department ? " · " : ""}
              {c.slug ? (
                <a href={profilePath(c.slug)} target="_blank" rel="noopener noreferrer" className="text-apollo-slate hover:underline">
                  profile ↗
                </a>
              ) : (
                <span className="italic">no public profile</span>
              )}
            </span>
          </div>
          <span className="text-muted-foreground text-[12.5px]">{position}</span>
        </div>

        {decided ? (
          <div className="bg-apollo-surface-2 flex items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-[13.5px]">
            {decided.kind === "confirmed" ? (
              <span className="text-apollo-slate font-medium">Confirmed</span>
            ) : (
              <span className="text-destructive font-medium">Not this person · {decided.reason}</span>
            )}
            {canDecide ? (
              <button
                type="button"
                disabled={undoing}
                onClick={onUndo}
                className="border-apollo-border-strong bg-apollo-surface ml-auto rounded-md border px-2.5 py-0.5 text-[13px]"
              >
                Undo
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className={EYEBROW}>Award, as RePORTER prints it</span>
          <span className="text-[16px] leading-[1.4] font-semibold text-pretty">{a.title ?? "Untitled award"}</span>
          <span className="text-[13.5px] text-[#3a3532]">
            <span className="font-mono text-[12.5px]">{[a.activityCode, a.awardNumber].filter(Boolean).join(" · ")}</span>
            {years(a.startYear, a.endYear) ? ` · ${years(a.startYear, a.endYear)}` : ""}
            {reporter ? (
              <>
                {" · "}
                <a href={reporter} target="_blank" rel="noopener noreferrer" className="text-apollo-slate hover:underline">
                  RePORTER ↗
                </a>
              </>
            ) : null}
          </span>
          {a.orgs.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {a.orgs.map((o, i) => (
                <span
                  key={i}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[12.5px]",
                    o.wcm ? "bg-apollo-slate-tint text-apollo-slate" : "bg-apollo-surface-2 text-[#3a3532]",
                  )}
                >
                  {o.name}
                  {years(o.from, o.to) ? ` (${years(o.from, o.to)})` : ""}
                </span>
              ))}
            </div>
          ) : null}
          {a.piNames.length > 0 ? (
            <div className="flex flex-wrap items-baseline gap-1.5 text-[13.5px]" data-testid="grant-attribution-pis">
              <span className="text-muted-foreground">{a.piNames.length > 1 ? "PIs" : "PI"}</span>
              {a.piNames.map((raw, i) => {
                const name = reporterNameForDisplay(raw);
                const me = isScholarPi(raw, c.scholarSurname);
                const co = !me && coPi !== null && coPi.name.toLowerCase() === raw.toLowerCase();
                return (
                  <span key={i} className="inline-flex items-baseline gap-1">
                    {me ? (
                      <mark className="bg-apollo-slate-tint text-apollo-slate rounded-[3px] px-[3px] font-semibold">{name}</mark>
                    ) : co ? (
                      <>
                        <span className="decoration-apollo-slate underline underline-offset-[3px]">{name}</span>
                        <span className="text-apollo-slate text-[11.5px]">co-author</span>
                      </>
                    ) : (
                      <span>{name}</span>
                    )}
                    {i < a.piNames.length - 1 ? <span className="text-muted-foreground">·</span> : null}
                  </span>
                );
              })}
            </div>
          ) : null}
          {c.reopenedAt ? (
            <span className="text-apollo-amber text-[12.5px]">
              {c.decidedAt !== null && c.decidedAt === c.reopenedAt
                ? `Sent back to review by ${c.decidedByName ?? "a curator"}; the weekly check had settled it on its own.`
                : c.decidedByName
                  ? `Reopened: the evidence changed after a decision by ${c.decidedByName}, which stands until this is decided again.`
                  : "Reopened: the evidence changed after a decision."}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span className={EYEBROW}>Evidence</span>
            <span
              className={cn(
                "text-[13.5px] font-medium",
                c.level === "out" ? "text-destructive" : c.level === "conflict" ? "text-apollo-amber" : "text-foreground",
              )}
            >
              {summaryOf(c)}
            </span>
          </div>
          {cues.length === 0 ? (
            <p className="text-muted-foreground m-0 text-[13.5px]">Nothing ties this award to the scholar.</p>
          ) : (
            <ul className="border-apollo-border m-0 flex list-none flex-col overflow-hidden rounded-[10px] border p-0">
              {cues.map((x, i) => (
                <li key={x.id} className={cn("flex flex-col gap-1.5 px-3.5 py-2.5", i > 0 && "border-apollo-border border-t")}>
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-[9px] py-px text-xs font-medium",
                        x.weight > 0 ? "bg-apollo-slate-tint text-apollo-slate" : "bg-apollo-red-tint text-destructive",
                      )}
                      data-testid={`grant-attribution-cue-${x.id}`}
                    >
                      {x.weight > 0 ? "✓" : "✕"} {cueLabel(x.id)}
                    </span>
                    <span className="min-w-[200px] flex-1 text-[13.5px] leading-[1.45] text-[#3a3532]">
                      {x.coPi
                        ? `${reporterNameForDisplay(x.coPi.name)}, a co-PI on this award, co-authored ${x.coPi.total} of the scholar's papers.`
                        : x.reason}
                    </span>
                  </div>
                  {x.coPi && x.coPi.papers.length > 0 ? (
                    <div className="flex flex-col gap-[3px] pl-0.5">
                      {x.coPi.papers.map((p) => (
                        <a
                          key={p.pmid}
                          href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-apollo-slate text-[12.5px] leading-[1.4] hover:underline"
                        >
                          <PubTitle value={p.title} />{" "}
                          <span className="text-muted-foreground">
                            · <PubJournal as="span" value={p.journal} /> {p.year ?? ""}
                          </span>
                        </a>
                      ))}
                      {x.coPi.total > x.coPi.papers.length ? (
                        <span className="text-muted-foreground text-[12.5px]">+ {x.coPi.total - x.coPi.papers.length} more</span>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3.5">
            <div className="flex flex-wrap gap-[3px]" aria-label={`Confidence: ${LEVEL_LABEL[c.level]}`}>
              {ATTRIBUTION_LEVELS.map((l) => (
                <span
                  key={l.key}
                  className={cn(
                    "flex h-6 items-center justify-center rounded px-[9px] text-xs whitespace-nowrap",
                    l.key === c.level
                      ? cn(LEVEL_SOLID[l.key], "font-semibold")
                      : "bg-apollo-surface text-muted-foreground ring-apollo-border ring-1 ring-inset",
                  )}
                >
                  {l.label}
                </span>
              ))}
            </div>
            <span className="text-muted-foreground min-w-[220px] flex-1 text-[12.5px] leading-[1.45]">{scaleNoteOf(c)}</span>
          </div>
        </div>

        {also.length > 0 ? (
          <div className="flex flex-col gap-[5px] text-[13px]">
            <span className={EYEBROW}>Also pending for {short}</span>
            {also.map((o) => (
              <button key={o.id} type="button" onClick={() => onGo(o.id)} className="text-apollo-slate text-left text-[13px]">
                {o.award.title ?? "Untitled award"}{" "}
                <span className="text-muted-foreground">
                  · {[o.award.activityCode, years(o.award.startYear, o.award.endYear)].filter(Boolean).join(" · ")}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {asking ? (
          <div
            className="border-apollo-border-strong bg-apollo-surface-2 flex flex-col gap-2.5 rounded-[10px] border px-3.5 py-3"
            data-testid="grant-attribution-reasons"
          >
            <span className="text-[13.5px] font-semibold">
              Why isn’t this {short}’s award?{" "}
              <span className="text-muted-foreground font-normal">A reason is required.</span>
            </span>
            <div className="flex flex-wrap gap-2">
              {GRANT_REJECTION_REASONS.map((r, i) => (
                <button
                  key={r}
                  type="button"
                  disabled={busy}
                  onClick={() => onReject(r)}
                  className="border-apollo-border-strong bg-apollo-surface flex items-center gap-[7px] rounded-lg border px-2.5 py-1.5 text-[13px]"
                >
                  <span aria-hidden className="hidden md:inline">
                    <Kbd>{i + 1}</Kbd>
                  </span>
                  <span>{r}</span>
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
              <button type="button" onClick={onCancelReject} className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
                Cancel
                <span aria-hidden className="hidden md:inline">
                  <Kbd>Esc</Kbd>
                </span>
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {!outcome && canDecide && !asking ? (
        <div className="border-apollo-border bg-apollo-surface sticky bottom-0 flex flex-wrap items-center gap-2.5 rounded-b-[var(--apollo-radius-card)] border-t px-6 py-3.5">
          <Button disabled={busy} onClick={onConfirm} className="bg-apollo-slate hover:bg-apollo-slate/90 text-[13px] text-white">
            Confirm
            <span aria-hidden className="ml-1.5 hidden md:inline">
              <Kbd light>C</Kbd>
            </span>
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={onStartReject}
            className="text-destructive hover:bg-apollo-red-tint hover:text-destructive text-[13px] font-normal"
          >
            Not this person
            <span aria-hidden className="ml-1.5 hidden md:inline">
              <Kbd>N</Kbd>
            </span>
          </Button>
          <button type="button" onClick={onSkip} className="text-muted-foreground ml-auto flex items-center gap-1.5 text-[13px]">
            Skip
            <span aria-hidden className="hidden md:inline">
              <Kbd>S</Kbd>
            </span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
