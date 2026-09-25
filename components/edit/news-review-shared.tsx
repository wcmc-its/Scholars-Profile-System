/**
 * Pieces shared by the two name-match review queues, `/edit/news-queue`
 * (`news-approval-queue.tsx`) and `/edit/media-highlights-queue`
 * (`media-highlights-queue.tsx`). Both POST to the same routes, so the error
 * copy, the match-basis wording, the snippet highlight, the decision / undo
 * calls, the "Wrong person?" CWID override and the status bar live here once.
 *
 * Client-safe: imports only `lib/cwid` (pure) and UI primitives.
 */
"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { isCwid } from "@/lib/cwid";
import { cn } from "@/lib/utils";

export type ReviewDecision = "approve" | "approve_hidden" | "reject";

/** One decision to POST. `cwid` = the "Wrong person?" override target. */
export type DecisionStep = { id: string; decision: ReviewDecision; cwid?: string };

/** A reviewer-entered replacement scholar for a pending mention. `name` is null
 *  when the directory could not be checked from the browser; the route checks it
 *  again on save either way. */
export type ScholarOverride = { cwid: string; name: string | null };

/** How the ETL found the name (#2578), in reviewer language. `label` is the
 *  News facet / pill wording; `via` reads after "via" on a Media card. */
export const MATCH_BASIS: Readonly<
  Record<string, { label: string; via: string; hint: string; tone: "slate" | "neutral" | "amber" }>
> = {
  TAG: {
    label: "Newsroom tag",
    via: "newsroom tag",
    hint: "The newsroom's own story tags name this scholar — attribution by the article's authors.",
    tone: "slate",
  },
  BODY: {
    label: "Name in text",
    via: "article text",
    hint: "Named in the article prose; no newsroom tag.",
    tone: "neutral",
  },
  CAPTION: {
    label: "Photo caption",
    via: "photo caption",
    hint: "Named only in a photo's alt text, nowhere in the prose.",
    tone: "amber",
  },
  TITLE: {
    label: "Endowed title only",
    via: "endowed title only",
    hint:
      "Named only inside an endowed-chair or memorial phrase (e.g. “the … Professor of…”). " +
      "The story is usually about the chair's holder, not the person it is named for.",
    tone: "amber",
  },
};

/** A decision failure in reviewer language. The 409s and the CWID refusals are
 *  all actionable by a human. `noun` is "mention" (News) or "clip" (Media). */
export function decisionErrorMessage(
  status: number,
  code: string | undefined,
  noun: "mention" | "clip" = "mention",
): string {
  if (status === 409 && code === "already_decided") {
    return (
      "Another scholar is already approved for this story — a mention can only be credited " +
      "to one person. Remove their approval first, on that scholar's own edit page, then " +
      "approve this one."
    );
  }
  if (status === 409 && code === "not_pending") {
    return `That ${noun} has already been decided by someone else. Refresh the page to see where it landed.`;
  }
  if (status === 422 && code === "unknown_cwid") {
    return "No scholar with that CWID is in the directory. Check the CWID and try again.";
  }
  if (status === 400 && code === "invalid_cwid") {
    return "That doesn't look like a CWID. Check it and try again.";
  }
  return "We couldn't record that decision. Please try again.";
}

/** An undo failure in reviewer language. */
export function undoErrorMessage(status: number, code: string | undefined): string {
  if (code === "undo_expired") {
    return "It's too late to undo that — Undo lasts 15 minutes. Change it from the Approved or Rejected tab instead.";
  }
  if (code === "undo_unavailable") {
    return "That can't be undone any more — it was already undone, or someone has changed it since. Refresh to see where it is now.";
  }
  if (status === 403 && code === "not_yours") {
    return "Only the person who made that decision can undo it.";
  }
  return "We couldn't undo that. Please try again.";
}

/** The snippet with the detected name marked at `ranges` — React nodes, never
 *  HTML: this is scraped article prose. */
export function highlightName(snippet: string, ranges: [number, number][]): ReactNode {
  if (ranges.length === 0) return snippet;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at || end > snippet.length || start >= end) continue;
    if (start > at) out.push(snippet.slice(at, start));
    out.push(
      <mark
        key={start}
        className="bg-apollo-amber-tint text-foreground rounded-[3px] px-0.5 font-semibold"
      >
        {snippet.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < snippet.length) out.push(snippet.slice(at));
  return out;
}

type DecisionResult =
  | { ok: true; decisionId: string | null; reassignedTo: ScholarOverride | null }
  | { ok: false; message: string };

/** POST one decision. Never throws; never refreshes. */
export async function postDecision(
  step: DecisionStep,
  noun: "mention" | "clip" = "mention",
): Promise<DecisionResult> {
  try {
    const res = await fetch("/api/edit/news-mention/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        step.cwid
          ? { id: step.id, decision: step.decision, cwid: step.cwid }
          : { id: step.id, decision: step.decision },
      ),
    });
    // `.catch` because a 500 can arrive as non-JSON.
    const data = (await res.json().catch(() => null)) as {
      error?: string;
      decisionId?: string;
      reassignedTo?: { cwid: string; name: string };
    } | null;
    if (!res.ok) return { ok: false, message: decisionErrorMessage(res.status, data?.error, noun) };
    return {
      ok: true,
      decisionId: data?.decisionId ?? null,
      reassignedTo: data?.reassignedTo ?? null,
    };
  } catch {
    return { ok: false, message: "We couldn't record that decision. Please try again." };
  }
}

/** POST an undo for these decisions, all or nothing. Never throws. */
export async function postUndo(
  decisionIds: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/edit/news-mention/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisionIds }),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, message: undoErrorMessage(res.status, data?.error) };
  } catch {
    return { ok: false, message: "We couldn't undo that. Please try again." };
  }
}

/**
 * The dark confirmation bar after a decision. Offers Undo while the decision
 * ids it would take back are known (the route returned them), then Dismiss.
 */
export function DecisionStatusBar({
  text,
  canUndo,
  undoing,
  onUndo,
  onDismiss,
  testId,
  className,
}: {
  text: string;
  canUndo: boolean;
  undoing: boolean;
  onUndo: () => void;
  onDismiss: () => void;
  testId: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-apollo-bar flex items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-[13.5px] text-white",
        className,
      )}
      role="status"
      data-testid={testId}
    >
      <span className="min-w-0 flex-1">{text}</span>
      {canUndo ? (
        <button
          type="button"
          onClick={onUndo}
          disabled={undoing}
          className="rounded-md border border-white/35 px-2.5 py-0.5 text-[13px] disabled:opacity-60"
          data-testid={`${testId}-undo`}
        >
          {undoing ? "Undoing…" : "Undo"}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded-md px-1.5 py-0.5 text-[15px] leading-none text-white/70 hover:text-white"
      >
        ×
      </button>
    </div>
  );
}

/** Look a CWID up for the override preview. `null` name = could not check. */
async function lookupScholar(
  cwid: string,
): Promise<{ found: true; name: string | null } | { found: false }> {
  try {
    const res = await fetch(`/api/edit/scholar-card/${encodeURIComponent(cwid)}`);
    if (res.status === 404) return { found: false };
    if (!res.ok) return { found: true, name: null };
    const data = (await res.json().catch(() => null)) as { name?: string } | null;
    return { found: true, name: data?.name ?? null };
  } catch {
    return { found: true, name: null };
  }
}

/** "Override · was <cwid>" — the amber pill beside an overridden name. */
export function OverridePill({ was }: { was: string | null }) {
  return (
    <span
      className="bg-apollo-amber-tint text-apollo-amber rounded-full px-2 py-px text-[11.5px] whitespace-nowrap"
      data-testid="news-override-pill"
    >
      Override{was ? " · was " : ""}
      {was ? <span className="font-mono">{was}</span> : null}
    </span>
  );
}

/**
 * "Wrong person? Enter CWID" — the reviewer names the scholar the story is
 * really about. Apply checks the shape, then the directory (the /edit scholar
 * card); a CWID the directory does not know is refused here, and the decision
 * route re-checks on save. Applying only stages the override: Approve / Hide
 * then credit that scholar.
 */
export function WrongPersonControl({
  override,
  disabled,
  onApply,
  onClear,
  linkLabel = "Wrong person? Enter CWID",
  testId,
}: {
  override: ScholarOverride | null;
  disabled: boolean;
  onApply: (o: ScholarOverride) => void;
  onClear: () => void;
  linkLabel?: string;
  testId: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState<string | null>(null);

  const value = (draft ?? "").trim().toLowerCase();
  const valid = isCwid(value);

  async function apply() {
    if (!valid || checking) return;
    setChecking(true);
    setNotFound(null);
    const hit = await lookupScholar(value);
    setChecking(false);
    if (!hit.found) {
      setNotFound(value);
      return;
    }
    onApply({ cwid: value, name: hit.name });
    setDraft(null);
  }

  if (draft === null) {
    return (
      <div className="mt-0.5 flex flex-wrap gap-3 text-[12.5px]">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setDraft("")}
          className="text-apollo-slate hover:underline disabled:opacity-60"
          data-testid={`${testId}-open`}
        >
          {linkLabel}
        </button>
        {override ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            className="text-muted-foreground hover:text-foreground"
            data-testid={`${testId}-clear`}
          >
            Remove override
          </button>
        ) : null}
      </div>
    );
  }

  const message =
    notFound && notFound === value
      ? `No scholar with CWID ${notFound} is in the directory.`
      : !value
        ? "Enter the CWID of the scholar this story is actually about."
        : !valid
          ? "That doesn't look like a CWID."
          : checking
            ? "Checking the directory…"
            : "Press Apply to check it against the directory.";
  const bad = (value.length > 0 && !valid) || (notFound !== null && notFound === value);

  return (
    <div className="mt-1 flex flex-col gap-1" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void apply();
            }
            if (e.key === "Escape") setDraft(null);
          }}
          placeholder="e.g. abc1234"
          aria-label="Replacement scholar CWID"
          aria-invalid={bad}
          autoFocus
          className={cn(
            "bg-apollo-surface h-[30px] w-[130px] rounded-md border px-2 font-mono text-[13px] outline-none",
            bad ? "border-destructive" : "border-apollo-border-strong",
          )}
          data-testid={`${testId}-input`}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!valid || checking}
          onClick={() => void apply()}
          className="border-apollo-slate text-apollo-slate hover:bg-apollo-slate-tint hover:text-apollo-slate h-[30px] text-[13px]"
          data-testid={`${testId}-apply`}
        >
          Apply
        </Button>
        <button
          type="button"
          onClick={() => {
            setDraft(null);
            setNotFound(null);
          }}
          className="text-muted-foreground hover:text-foreground text-[12.5px]"
        >
          Cancel
        </button>
      </div>
      <span
        className={cn("text-[12px]", bad ? "text-destructive" : "text-muted-foreground")}
        role={bad ? "alert" : undefined}
      >
        {message}
      </span>
    </div>
  );
}
