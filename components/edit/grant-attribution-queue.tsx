"use client";

/**
 * #3071 — the grant attribution queue (`/edit/grant-attribution-queue`).
 *
 * One card per RePORTER award the scorer could not settle. Each card puts the
 * scholar (as the profile shows them) beside the award (as RePORTER prints it),
 * then lists the evidence: every cue that fired, green when it ties the award
 * to the scholar and red when it points elsewhere. Confirm shows the award;
 * Not this person keeps it hidden with a curator hide the ETL never touches;
 * Skip moves the card to the end of this session's list and writes nothing.
 *
 * Composed from existing pieces only (no new styling): the news queue's tab
 * strip, card shell and badge classes, honors' `Kbd` and `ReasonSelect`, the
 * shared `DecisionStatusBar`, and `ScholarHoverCard` for the name. A decided
 * card stays in place with its outcome (no immediate refresh: the replica may
 * not have the write yet).
 *
 * Imports only the pure `@/lib/edit/grant-attribution-queue` — nothing that
 * reaches the database.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Kbd, ReasonSelect } from "@/components/edit/honors-review";
import { DecisionStatusBar } from "@/components/edit/news-review-shared";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Button } from "@/components/ui/button";
import {
  GRANT_REJECTION_REASONS,
  cueLabel,
  reporterProjectUrl,
  type GrantAttributionItem,
} from "@/lib/edit/grant-attribution-queue";
import { cn } from "@/lib/utils";

type Tab = "pending" | "confirmed" | "rejected";
type Outcome = { kind: "confirmed" | "rejected" | "reopened"; reason?: string };

const CUE_FOR = "border-apollo-green-tint-border bg-apollo-green-tint text-apollo-green-foreground";
const CUE_AGAINST = "border-apollo-red-tint-border bg-apollo-red-tint text-destructive";

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
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

export function GrantAttributionQueue({
  pending,
  confirmed,
  rejected,
  readOnly,
}: {
  pending: GrantAttributionItem[];
  confirmed: GrantAttributionItem[];
  rejected: GrantAttributionItem[];
  readOnly: boolean;
}) {
  const [tab, setTab] = useState<Tab>("pending");
  const [order, setOrder] = useState<string[]>(() => pending.map((p) => p.id));
  const [focusId, setFocusId] = useState<string | null>(pending[0]?.id ?? null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bar, setBar] = useState<{ text: string; ids: string[] } | null>(null);
  const [undoing, setUndoing] = useState(false);

  const byId = useMemo(() => new Map(pending.map((p) => [p.id, p])), [pending]);
  const list = tab === "pending" ? order.map((id) => byId.get(id)!).filter(Boolean) : tab === "confirmed" ? confirmed : rejected;

  const decide = useCallback(
    async (id: string, decision: "confirm" | "reject", why?: string) => {
      if (readOnly || busy) return;
      setBusy(true);
      setError(null);
      const r = await postDecision(why ? { id, decision, reason: why } : { id, decision });
      setBusy(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setOutcomes((o) => ({
        ...o,
        [id]: decision === "confirm" ? { kind: "confirmed" } : { kind: "rejected", reason: why },
      }));
      setRejecting(null);
      setReason("");
      setBar({
        text:
          decision === "confirm"
            ? "Confirmed. The award now shows on the scholar's profile; search catches up after the nightly reindex."
            : "Hidden as not this person. The scholar's profile will not show it.",
        ids: [id],
      });
      const next = order.find((x) => x !== id && !outcomes[x]);
      if (next) setFocusId(next);
    },
    [readOnly, busy, order, outcomes],
  );

  const skip = useCallback(
    (id: string) => {
      setOrder((o) => [...o.filter((x) => x !== id), id]);
      const next = order.find((x) => x !== id && !outcomes[x]);
      if (next) setFocusId(next);
    },
    [order, outcomes],
  );

  const undo = useCallback(
    async (ids: string[]) => {
      setUndoing(true);
      setError(null);
      const r = await postDecision(ids.length === 1 ? { id: ids[0], decision: "undo" } : { ids, decision: "undo" });
      setUndoing(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setOutcomes((o) => {
        const n = { ...o };
        for (const id of ids) {
          if (byId.has(id)) delete n[id];
          else n[id] = { kind: "reopened" };
        }
        return n;
      });
      setBar(null);
    },
    [byId],
  );

  useEffect(() => {
    if (tab !== "pending") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const live = order.filter((id) => !outcomes[id]);
      const at = focusId ? live.indexOf(focusId) : -1;
      const key = e.key.toLowerCase();
      if (key === "j" || key === "k") {
        const next = live[Math.min(live.length - 1, Math.max(0, at + (key === "j" ? 1 : -1)))];
        if (next) {
          setFocusId(next);
          document.getElementById(`grant-review-${next}`)?.scrollIntoView({ block: "nearest" });
        }
        e.preventDefault();
        return;
      }
      if (!focusId || outcomes[focusId] || readOnly) return;
      if (key === "c") {
        void decide(focusId, "confirm");
        e.preventDefault();
      } else if (key === "n") {
        setRejecting(focusId);
        e.preventDefault();
      } else if (key === "s") {
        skip(focusId);
        e.preventDefault();
      } else if (key === "escape") {
        setRejecting(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, order, outcomes, focusId, readOnly, decide, skip]);

  const remaining = order.filter((id) => !outcomes[id]).length;

  return (
    <div className="flex flex-col gap-[22px]" data-slot="grant-attribution-queue">
      <div className="border-apollo-border-strong flex flex-wrap items-end gap-x-7 border-b" role="tablist">
        {(
          [
            ["pending", "To review", remaining],
            ["confirmed", "Confirmed", confirmed.length],
            ["rejected", "Not this person", rejected.length],
          ] as const
        ).map(([t, label, n]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-0.5 pt-2.5 pb-3 text-[15px] whitespace-nowrap",
              tab === t
                ? "border-apollo-maroon text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
            data-testid={`grant-attribution-tab-${t}`}
          >
            {label}
            <span
              className={cn(
                "text-foreground rounded-full px-[7px] py-px text-xs tabular-nums",
                tab === t ? "bg-apollo-rail" : "bg-apollo-surface-2",
              )}
            >
              {n.toLocaleString("en-US")}
            </span>
          </button>
        ))}
      </div>

      {tab === "pending" && !readOnly ? (
        <p aria-hidden className="text-muted-foreground m-0 hidden items-center gap-2 text-[13px] md:flex">
          <Kbd>J</Kbd>/<Kbd>K</Kbd> move · <Kbd>C</Kbd> confirm · <Kbd>N</Kbd> not this person ·{" "}
          <Kbd>S</Kbd> skip
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="border-apollo-red-tint-border bg-apollo-red-tint text-destructive m-0 rounded-md border px-3 py-2 text-sm"
          data-testid="grant-attribution-error"
        >
          {error}
        </p>
      ) : null}

      {list.length === 0 ? (
        <p className="text-muted-foreground m-0 text-[14.5px]" data-testid="grant-attribution-empty">
          {tab === "pending" ? "Nothing to review." : "Nothing here yet."}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {list.map((item) => (
            <li key={item.id}>
              <ReviewCard
                item={item}
                focused={tab === "pending" && item.id === focusId}
                outcome={outcomes[item.id] ?? null}
                readOnly={readOnly}
                busy={busy}
                rejecting={rejecting === item.id}
                reason={reason}
                onReason={setReason}
                onConfirm={() => void decide(item.id, "confirm")}
                onStartReject={() => {
                  setRejecting(item.id);
                  setFocusId(item.id);
                }}
                onCancelReject={() => setRejecting(null)}
                onReject={() => void decide(item.id, "reject", reason || undefined)}
                onSkip={() => skip(item.id)}
                onUndo={() => void undo([item.id])}
                undoing={undoing}
              />
            </li>
          ))}
        </ul>
      )}

      {bar ? (
        <DecisionStatusBar
          text={bar.text}
          canUndo
          undoing={undoing}
          onUndo={() => void undo(bar.ids)}
          onDismiss={() => setBar(null)}
          testId="grant-attribution-status"
          className="sticky bottom-4"
        />
      ) : null}
    </div>
  );
}

function ReviewCard({
  item,
  focused,
  outcome,
  readOnly,
  busy,
  rejecting,
  reason,
  onReason,
  onConfirm,
  onStartReject,
  onCancelReject,
  onReject,
  onSkip,
  onUndo,
  undoing,
}: {
  item: GrantAttributionItem;
  focused: boolean;
  outcome: Outcome | null;
  readOnly: boolean;
  busy: boolean;
  rejecting: boolean;
  reason: string;
  onReason: (v: string) => void;
  onConfirm: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onReject: () => void;
  onSkip: () => void;
  onUndo: () => void;
  undoing: boolean;
}) {
  const a = item.award;
  const reporter = reporterProjectUrl(a.applId);
  const decidedHere = item.status !== "pending";
  return (
    <article
      id={`grant-review-${item.id}`}
      className={cn(
        "bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[var(--apollo-radius-card)] border",
        focused && "ring-apollo-slate ring-2",
      )}
      data-testid={`grant-attribution-item-${item.id}`}
    >
      <div className="grid gap-4 px-4 pt-4 pb-3 sm:grid-cols-2 sm:px-5">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-muted-foreground text-[11.5px] font-semibold tracking-[0.08em] uppercase">
            Scholar
          </span>
          <ScholarHoverCard cwid={item.cwid}>
            <span className="text-[15px] font-semibold">{item.scholarName}</span>
          </ScholarHoverCard>
          {item.title ? <span className="text-[13.5px]">{item.title}</span> : null}
          {item.department ? <span className="text-muted-foreground text-[13px]">{item.department}</span> : null}
          <span className="text-[13px]">
            {item.slug ? (
              <a
                href={`/scholars/${item.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-apollo-slate hover:underline"
              >
                profile ↗
              </a>
            ) : (
              <span className="italic">no public profile</span>
            )}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-muted-foreground text-[11.5px] font-semibold tracking-[0.08em] uppercase">
            Award (as RePORTER prints it)
          </span>
          <span className="text-[15px] font-semibold text-pretty">{a.title ?? "Untitled award"}</span>
          <span className="text-[13.5px] tabular-nums">
            {[a.activityCode, a.awardNumber, years(a.startYear, a.endYear)].filter(Boolean).join(" · ")}
          </span>
          {a.orgs.length > 0 ? (
            <span className="text-muted-foreground text-[13px]">
              {a.orgs.map((o) => `${o.name}${years(o.from, o.to) ? ` (${years(o.from, o.to)})` : ""}`).join("; ")}
            </span>
          ) : null}
          {a.piNames.length > 0 ? (
            <span className="text-[13px]">PI{a.piNames.length > 1 ? "s" : ""}: {a.piNames.join(", ")}</span>
          ) : null}
          {reporter ? (
            <span className="text-[13px]">
              <a href={reporter} target="_blank" rel="noopener noreferrer" className="text-apollo-slate hover:underline">
                RePORTER ↗
              </a>
            </span>
          ) : null}
        </div>
      </div>

      <div className="border-apollo-border border-t px-4 py-3 sm:px-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-[11.5px] font-semibold tracking-[0.08em] uppercase">
            Evidence
          </span>
          <span className="text-muted-foreground border-apollo-border-strong rounded-full border px-2 py-px text-[11.5px] whitespace-nowrap tabular-nums">
            score {item.score > 0 ? `+${item.score}` : item.score}
          </span>
          {item.reopenedAt ? (
            <span className="border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber rounded-full border px-2 py-px text-[11.5px] font-semibold">
              Reopened: the evidence changed after a decision
            </span>
          ) : null}
        </div>
        {item.cues.length === 0 ? (
          <p className="text-muted-foreground m-0 text-[13.5px]">Nothing ties this award to the scholar.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {item.cues.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-2 text-[13.5px]">
                <span
                  className={cn(
                    "rounded-full border px-2 py-px text-[11.5px] font-semibold whitespace-nowrap",
                    c.weight > 0 ? CUE_FOR : CUE_AGAINST,
                  )}
                  data-testid={`grant-attribution-cue-${c.id}`}
                >
                  {cueLabel(c.id)}
                </span>
                <span className="min-w-0 flex-1">{c.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {decidedHere ? (
        <div className="border-apollo-border text-muted-foreground flex flex-wrap items-center gap-2.5 border-t px-4 py-3 text-[13px] sm:px-5">
          <span>
            {item.status === "confirmed" ? "Confirmed" : "Not this person"}
            {item.decidedByName ? ` by ${item.decidedByName}` : ""}
            {item.decidedAt ? `, ${item.decidedAt.slice(0, 10)}` : ""}
            {item.rejectionReason ? ` — ${item.rejectionReason}` : ""}
          </span>
          {readOnly || outcome?.kind === "reopened" ? null : (
            <Button variant="ghost" size="sm" disabled={undoing} onClick={onUndo} className="ml-auto text-[13px] font-normal">
              Move back to review
            </Button>
          )}
          {outcome?.kind === "reopened" ? <span className="ml-auto">Back in To review after a refresh</span> : null}
        </div>
      ) : outcome ? (
        <div className="border-apollo-border flex flex-wrap items-center gap-2.5 border-t px-4 py-3 sm:px-5">
          <span
            className={cn(
              "rounded-full border px-2 py-px text-[11.5px] font-semibold",
              outcome.kind === "confirmed" ? CUE_FOR : CUE_AGAINST,
            )}
            data-testid="grant-attribution-outcome"
          >
            {outcome.kind === "confirmed" ? "Confirmed" : "Not this person"}
          </span>
        </div>
      ) : readOnly ? null : rejecting ? (
        <div className="border-apollo-border flex flex-wrap items-center gap-2.5 border-t px-4 py-3 sm:px-5">
          <ReasonSelect value={reason} onChange={onReason} disabled={busy} small reasons={GRANT_REJECTION_REASONS} />
          <Button
            variant="ghost"
            disabled={busy}
            onClick={onReject}
            className="text-destructive hover:bg-apollo-red-tint hover:text-destructive text-[13px] font-normal"
          >
            Hide as not this person
          </Button>
          <button type="button" onClick={onCancelReject} className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
            Cancel
            <span aria-hidden className="hidden md:inline">
              <Kbd>Esc</Kbd>
            </span>
          </button>
        </div>
      ) : (
        <div className="border-apollo-border flex flex-wrap items-center gap-2.5 border-t px-4 py-3 sm:px-5">
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
      )}
    </article>
  );
}
