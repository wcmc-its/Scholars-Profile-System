/**
 * "From your publications" — the self-only advisory SUB-VIEW of Conflicts of
 * Interest (`SELF_EDIT_COI_GAP_HINT`, dormant). It surfaces relationships named
 * in a scholar's OWN PubMed competing-interest statements that we could not
 * match to a current Weill Research Gateway disclosure.
 *
 * Each row is ONE relationship, DEDUPED across the scholar's papers: the same
 * entity named in several "Competing interests" statements collapses to a single
 * row that CITES every source publication (its verbatim sentence + PMID + year).
 * "Not relevant" / Undo therefore act on the WHOLE relationship — they fan out to
 * every underlying candidate id (the per-id routes are idempotent, so a retry
 * after a partial failure converges).
 *
 * THREE surfaces, partitioned upstream so a relationship is never in two at once
 * (`loadEditContext` — "any new source ⇒ active, never in Reviewed"):
 *   - `candidates`        — High-tier ACTIVE relationships (the primary list).
 *   - `lowerCandidates`   — pure-Medium ACTIVE relationships, tucked behind a
 *                            collapsed "lower-confidence" expander (weaker matches,
 *                            often a co-author's disclosure, not the scholar's own).
 *   - `reviewed`          — fully-acted relationships, shown SETTLED in a collapsed
 *                            "Reviewed" section that records the scholar's response
 *                            (and date) and lets them change their mind or undo. It
 *                            is history, never a nag.
 *
 * It is deliberately NOT styled like the read-only SOR panels: this is a
 * DERIVED SUGGESTION, not authoritative data on file, so it carries no "Locked —
 * managed at its source" chip (which would imply the list is ground truth).
 * Instead three reassurance chips state the posture up front, and color tracks
 * REASSURANCE not alarm — amber "Worth reviewing" (look when you get a chance),
 * green "Likely covered" (probably already disclosed). Never red.
 *
 * Governance posture (non-negotiable — `docs/coi-pubmed-unmatched-feasibility.md`):
 *   - SUGGEST, never accuse. The forbidden vocabulary (undisclosed / failed to
 *     disclose / missing / violation / gap) appears nowhere on this surface.
 *   - The verbatim `sourceSentence` of every source is ALWAYS rendered so the
 *     human, not a score, adjudicates. Confidence is a qualitative tier only —
 *     never a percentage, never the numeric score (which never crosses to the
 *     client). The sort control orders by tier and/or recency, never by score.
 *   - SPS is NOT the COI system of record: no in-app COI editing. "Review in
 *     Gateway" routes to WRG via the existing `coi` Request-a-Change flow.
 *   - "Not relevant" is the scholar's PRIVATE hide of a suggestion, with undo —
 *     never a compliance decision, and it reads back to no one. It persists
 *     durably (the daily `etl:coi-gap` respects it and never re-nags); Undo
 *     restores it. Only the scholar's own `reason` + action `reviewedAt` cross to
 *     the client (for the Reviewed section) — the score / status / attribution /
 *     category never do.
 *
 * Visibility was originally self-only; an operator decision (#836 follow-on) also
 * lets a (non-impersonating) superuser view + act on this surface on the scholar's
 * behalf, with a confirmation "nag" before any action and the privacy chip
 * reframed so it never falsely promises "only you". Who may load it is enforced
 * upstream (`loadEditContext` populates these arrays only for an allowed actor
 * behind the flag) and again at the feedback/restore APIs (genuine-self OR
 * genuine-superuser); this component renders only what it is handed.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft, EyeOff, Info, Lock } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  EditContextCoiGapCandidate,
  EditContextCoiGapReviewed,
} from "@/lib/api/edit-context";
import { FEEDBACK_REASONS, type FeedbackReason } from "@/lib/coi-gap/feedback";

export type CoiGapCardProps = {
  cwid: string;
  /** `superuser` reframes the advisory copy + the privacy chip to the scholar's
   *  name and gates every action behind a confirmation "nag" — a superuser acts
   *  on this sensitive surface on the scholar's behalf (operator decision). */
  mode?: "self" | "superuser";
  scholarName?: string;
  /** One entry per DEDUPED High-tier ACTIVE relationship; each cites all of its
   *  source papers. */
  candidates: ReadonlyArray<EditContextCoiGapCandidate>;
  /** Pure-Medium ACTIVE relationships — the weaker, "lower-confidence" matches,
   *  tucked behind a collapsed expander rather than fronted with the High list. */
  lowerCandidates?: ReadonlyArray<EditContextCoiGapCandidate>;
  /** Fully-acted relationships — shown settled in the Reviewed section, with
   *  change-of-mind + undo. */
  reviewed?: ReadonlyArray<EditContextCoiGapReviewed>;
};

const PUBMED_URL = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;

/**
 * The scholar's three responses (operator decision — verbatim copy). Order
 * matches `FEEDBACK_REASONS`. Presented as EQUAL, neutral choices (no option
 * emphasized) so the response isn't nudged — `historical` vs `invalid` is an
 * honest precision signal only if the scholar isn't steered. None of the
 * forbidden accusatory words appear.
 */
const CHOICE_LABEL: Record<FeedbackReason, string> = {
  will_disclose: "I intend to update my COI statement",
  historical: "Historically true but not currently valid",
  invalid: "Not a valid suggestion",
};
/** The shorter recorded form shown once a response is filed (and in the superuser
 *  nag), phrased to read in either voice. */
const ACTED_LABEL: Record<FeedbackReason, string> = {
  will_disclose: "Will update COI statement",
  historical: "Historically true, not currently valid",
  invalid: "Not a valid suggestion",
};

/**
 * The three sort modes (operator decision — locked). Default = "newest +
 * confidence". All order by tier and/or recency only; the numeric entity score
 * never crosses to the client and is never a sort input here.
 */
type SortMode = "newest-confidence" | "newest" | "confidence";
const SORT_OPTIONS: ReadonlyArray<{ value: SortMode; label: string }> = [
  { value: "newest-confidence", label: "Newest + confidence" },
  { value: "newest", label: "Newest" },
  { value: "confidence", label: "Confidence" },
];

const tierRank = (t: "High" | "Medium") => (t === "High" ? 0 : 1);

/** Pure, deterministic re-order of the deduped relationships for a chosen mode. */
function sortCandidates(
  list: ReadonlyArray<EditContextCoiGapCandidate>,
  mode: SortMode,
): EditContextCoiGapCandidate[] {
  const byEntity = (a: EditContextCoiGapCandidate, b: EditContextCoiGapCandidate) =>
    a.entity.localeCompare(b.entity);
  const byNewest = (a: EditContextCoiGapCandidate, b: EditContextCoiGapCandidate) =>
    b.newestTs - a.newestTs;
  const byTier = (a: EditContextCoiGapCandidate, b: EditContextCoiGapCandidate) =>
    tierRank(a.tier) - tierRank(b.tier);
  const arr = [...list];
  switch (mode) {
    case "newest":
      // Pure recency; tier only breaks date ties.
      arr.sort((a, b) => byNewest(a, b) || byTier(a, b) || byEntity(a, b));
      break;
    case "confidence":
      // Tier groups (High then Medium); alphabetical within a tier.
      arr.sort((a, b) => byTier(a, b) || byEntity(a, b));
      break;
    default:
      // "Newest + confidence": tier groups, newest within each tier.
      arr.sort((a, b) => byTier(a, b) || byNewest(a, b) || byEntity(a, b));
  }
  return arr;
}

export function CoiGapCard({
  cwid,
  mode = "self",
  scholarName = "",
  candidates,
  lowerCandidates = [],
  reviewed = [],
}: CoiGapCardProps) {
  const su = mode === "superuser";
  // The back-link returns to the COI panel on the actor's own surface.
  const backHref = su ? `/edit/scholar/${cwid}?attr=coi` : "/edit?attr=coi";
  // The "nag" (operator decision): a superuser confirms before recording any
  // response (or undoing one), since these are the scholar's private suggestions.
  // `target` is the chosen reason, or null for an undo. Null when closed.
  const [confirm, setConfirm] = React.useState<{
    key: string;
    target: FeedbackReason | null;
  } | null>(null);
  const [sortMode, setSortMode] = React.useState<SortMode>("newest-confidence");
  // ACTIVE rows (High list + Medium expander) always render; once the scholar
  // records a response the row flips IN PLACE to a "<reason> — Undo" line. State
  // is keyed by the relationship GROUP key (the normalized entity), not a per-paper
  // id, since a row spans many papers; the value is the chosen reason. Group keys
  // are globally unique across all three surfaces, so one map covers them all. The
  // DB is the source of truth on reload — a recorded response moves the
  // relationship into Reviewed, an undo brings it back to the active list.
  const [acted, setActed] = React.useState<Map<string, FeedbackReason>>(new Map());
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
  // Reviewed-section local state. `reviewedOverride` lets a change-of-mind update
  // the recorded label IN PLACE (the row stays in Reviewed); `reverted` replaces a
  // row body with a "moved back" confirmation after a successful Undo; `expandKey`
  // tracks which Reviewed row's change-of-mind choice strip is open.
  const [reviewedOverride, setReviewedOverride] = React.useState<Map<string, FeedbackReason>>(
    new Map(),
  );
  const [reverted, setReverted] = React.useState<Set<string>>(new Set());
  const [expandKey, setExpandKey] = React.useState<string | null>(null);

  // A single key→group lookup over EVERY surface so `mutate` can fan out to any
  // relationship's source ids — active rows, the Medium expander, AND Reviewed
  // (change-of-mind / undo). Reviewed groups expose the same `{ key, sources }`
  // shape the active candidates do, so they merge transparently.
  const groupByKey = React.useMemo(() => {
    const m = new Map<string, { key: string; sources: ReadonlyArray<{ id: string }> }>();
    for (const g of [...candidates, ...lowerCandidates, ...reviewed]) m.set(g.key, g);
    return m;
  }, [candidates, lowerCandidates, reviewed]);

  function setError(key: string, msg: string | null) {
    setErrors((prev) => {
      const next = new Map(prev);
      if (msg === null) next.delete(key);
      else next.set(key, msg);
      return next;
    });
  }
  function setActedReason(key: string, reason: FeedbackReason | null) {
    setActed((prev) => {
      const next = new Map(prev);
      if (reason === null) next.delete(key);
      else next.set(key, reason);
      return next;
    });
  }

  // Recording a response — and its inverse Undo (`target === null`) — acts on the
  // WHOLE relationship: flip the local state, then POST to the per-id route for
  // EVERY source (a reason → /feedback, an undo → /restore). Both routes are
  // idempotent + genuine-self-or-superuser-guarded server-side, so a retry after a
  // partial failure converges. On success in the Reviewed section we record the
  // change-of-mind / revert locally; on any failure we roll the row back to its
  // previous state and surface a retry; the rows we did flip reconcile on reload.
  function mutate(key: string, target: FeedbackReason | null) {
    const group = groupByKey.get(key);
    if (!group) return;
    const isReviewedRow = reviewed.some((r) => r.key === key);
    // For active rows the "previous" is the locally-acted reason (usually null);
    // for Reviewed rows it is the currently-displayed reason (override or filed).
    const reviewedReason =
      reviewedOverride.get(key) ?? reviewed.find((r) => r.key === key)?.reason ?? null;
    const previous = isReviewedRow ? reviewedReason : (acted.get(key) ?? null);
    setError(key, null);
    setPending((p) => new Set(p).add(key));
    if (isReviewedRow) {
      // Optimistically reflect the change-of-mind / undo in the Reviewed row.
      if (target === null) setRevertedKey(key, true);
      else setReviewedOverrideReason(key, target);
    } else {
      setActedReason(key, target); // optimistic (null = undo)
    }
    void (async () => {
      try {
        const results = await Promise.all(
          group.sources.map(async (s) => {
            const base = `/api/edit/coi-gap/${encodeURIComponent(s.id)}`;
            const res = await fetch(target === null ? `${base}/restore` : `${base}/feedback`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: target === null ? "{}" : JSON.stringify({ reason: target }),
            });
            const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
            return res.ok && data.ok === true;
          }),
        );
        if (results.every(Boolean)) {
          // On a successful re-pick close the change-of-mind strip in place.
          if (isReviewedRow && target !== null && expandKey === key) setExpandKey(null);
        } else {
          rollBack(key, isReviewedRow, previous);
          setError(key, "We couldn't update this just now. Please try again.");
        }
      } catch {
        rollBack(key, isReviewedRow, previous);
        setError(key, "We couldn't update this just now. Please try again.");
      } finally {
        setPending((p) => {
          const next = new Set(p);
          next.delete(key);
          return next;
        });
      }
    })();
  }

  // Restore the prior displayed state after a failed mutation, per surface.
  function rollBack(key: string, isReviewedRow: boolean, previous: FeedbackReason | null) {
    if (isReviewedRow) {
      setRevertedKey(key, false);
      setReviewedOverrideReason(key, previous);
    } else {
      setActedReason(key, previous);
    }
  }

  function setReviewedOverrideReason(key: string, reason: FeedbackReason | null) {
    setReviewedOverride((prev) => {
      const next = new Map(prev);
      if (reason === null) next.delete(key);
      else next.set(key, reason);
      return next;
    });
  }
  function setRevertedKey(key: string, on: boolean) {
    setReverted((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  // A superuser routes every response through the confirm "nag" first; a scholar
  // records directly on their own suggestions. Shared by ALL surfaces (active
  // rows, the Medium expander, and the Reviewed change-of-mind / undo).
  function requestMutate(key: string, target: FeedbackReason | null) {
    if (su) setConfirm({ key, target });
    else mutate(key, target);
  }

  const orderedHigh = sortCandidates(candidates, sortMode);
  const orderedLower = sortCandidates(lowerCandidates, sortMode);
  // The summary line tracks ONLY the High active list (Medium + Reviewed counts
  // live in their own expander / section labels).
  const active = orderedHigh.filter((c) => !acted.has(c.key));
  const reviewing = active.filter((c) => c.tier === "High").length;
  const summary = reviewing
    ? `${reviewing} worth reviewing`
    : "Nothing left to review";

  const confirmName = scholarName || "the scholar";

  // Shared active-row renderer — reused verbatim by the High list AND the Medium
  // expander so both lists offer the same tier chip, citations, 3-way response,
  // Review-in-Gateway, and the acted-flip + Undo. Keyed by group key (unique), so
  // the `acted` / `pending` / `errors` maps disambiguate rows across both lists.
  function renderActiveRow(c: EditContextCoiGapCandidate) {
    const actedReason = acted.get(c.key) ?? null;
    const isPending = pending.has(c.key);
    const error = errors.get(c.key) ?? null;
    return (
      <li
        key={c.key}
        className="border-apollo-border border-t py-4 first:border-t-0"
        data-testid={`coi-gap-row-${c.key}`}
      >
        {actedReason !== null ? (
          <div className="flex items-center justify-between gap-3 opacity-80">
            <span className="text-muted-foreground text-sm">
              <span className="text-foreground font-semibold">{c.entity}</span> —{" "}
              <span data-testid={`coi-gap-acted-${c.key}`}>{ACTED_LABEL[actedReason]}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => requestMutate(c.key, null)}
              data-testid={`coi-gap-undo-${c.key}`}
            >
              Undo
            </Button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex items-center gap-2.5">
                <TierChip tier={c.tier} />
                <span className="text-foreground text-base font-semibold">{c.entity}</span>
                {c.sources.length > 1 && (
                  <span
                    className="text-muted-foreground text-xs"
                    data-testid={`coi-gap-source-count-${c.key}`}
                  >
                    {c.sources.length} publications
                  </span>
                )}
              </div>
              {/* Every citing paper is listed with its verbatim sentence —
                  the human adjudicates each, the score never shows. */}
              <ul className="flex flex-col gap-3">
                {c.sources.map((s) => (
                  <li key={s.id}>
                    <blockquote
                      className="border-apollo-slate-tint-border text-foreground border-l-2 pl-3 text-sm leading-snug italic"
                      data-testid={`coi-gap-source-${s.id}`}
                    >
                      “{s.sourceSentence}”
                    </blockquote>
                    <p className="text-muted-foreground mt-1.5 text-[0.8rem]">
                      From{" "}
                      <a
                        href={PUBMED_URL(s.pmid)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-apollo-slate font-medium underline-offset-2 hover:underline"
                      >
                        PMID {s.pmid}
                      </a>
                      {s.year != null && <span> · {s.year}</span>}
                    </p>
                  </li>
                ))}
              </ul>
              {/* The scholar's 3-way response — equal, neutral choices (no
                  default emphasis) so the precision split stays honest.
                  "Review in Gateway" stays in the rail: it routes to WRG,
                  the system of record, never an in-app COI edit. */}
              <div className="mt-3 flex flex-wrap gap-2" data-testid={`coi-gap-choices-${c.key}`}>
                {FEEDBACK_REASONS.map((r) => (
                  <Button
                    key={r}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isPending}
                    onClick={() => requestMutate(c.key, r)}
                    data-testid={`coi-gap-choice-${r}-${c.key}`}
                  >
                    {CHOICE_LABEL[r]}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2.5">
              <RequestAChangeDialog
                attribute="coi"
                cwid={cwid}
                itemLabel={c.entity}
                triggerTestId={`coi-gap-review-${c.key}`}
                trigger={(open) => (
                  <button
                    type="button"
                    onClick={open}
                    className="text-apollo-slate inline-flex items-center gap-1 text-[0.85rem] font-medium hover:underline"
                  >
                    Review in Gateway
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  </button>
                )}
              />
            </div>
          </div>
        )}
        {error && (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </li>
    );
  }

  // A settled Reviewed row — history, never a nag. Shows the recorded response +
  // date, with an opt-in change-of-mind strip and an Undo (both route through
  // `requestMutate`, so a superuser still gets the confirmation nag).
  function renderReviewedRow(r: EditContextCoiGapReviewed) {
    const isPending = pending.has(r.key);
    const error = errors.get(r.key) ?? null;
    const wasReverted = reverted.has(r.key);
    const shownReason = reviewedOverride.get(r.key) ?? r.reason;
    const isOpen = expandKey === r.key;
    return (
      <li
        key={r.key}
        className="border-apollo-border border-t py-3 first:border-t-0"
        data-testid={`coi-gap-reviewed-row-${r.key}`}
      >
        {wasReverted ? (
          <p className="text-muted-foreground text-sm">Moved back to your review.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-muted-foreground text-sm">
                <span className="text-foreground font-semibold">{r.entity}</span> —{" "}
                <span data-testid={`coi-gap-reviewed-reason-${r.key}`}>
                  {ACTED_LABEL[shownReason]}
                </span>{" "}
                <span
                  className="text-muted-foreground/80 text-xs"
                  data-testid={`coi-gap-reviewed-date-${r.key}`}
                >
                  {r.reviewedAt}
                </span>
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => setExpandKey((k) => (k === r.key ? null : r.key))}
                  data-testid={`coi-gap-reviewed-change-${r.key}`}
                >
                  Change response
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => requestMutate(r.key, null)}
                  data-testid={`coi-gap-reviewed-undo-${r.key}`}
                >
                  Undo
                </Button>
              </div>
            </div>
            {isOpen && (
              <div className="mt-2 flex flex-wrap gap-2">
                {FEEDBACK_REASONS.map((reason) => (
                  <Button
                    key={reason}
                    type="button"
                    variant={reason === shownReason ? "default" : "outline"}
                    size="sm"
                    disabled={isPending}
                    onClick={() => requestMutate(r.key, reason)}
                    data-testid={`coi-gap-reviewed-choice-${reason}-${r.key}`}
                  >
                    {CHOICE_LABEL[reason]}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
        {error && (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </li>
    );
  }

  return (
    <>
      <Link
        href={backHref}
        data-testid="coi-gap-back"
        className="text-apollo-slate -mb-1 inline-flex w-fit items-center gap-1 text-sm font-medium hover:underline"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Conflicts of Interest
      </Link>

      <EditPanel
        slot="coi-gap-panel"
        heading={su ? "From the scholar’s publications" : "From your publications"}
        description={`Relationships named in the “Competing interests” statements of ${
          su ? `${scholarName}’s` : "your"
        } own PubMed-indexed papers that we couldn’t match to a current Weill Research Gateway disclosure.`}
      >
        <ul className="flex flex-wrap gap-2" data-testid="coi-gap-reassure">
          {/* The "Visible only to you" promise was removed — admins can now see
              this surface, so it would no longer be truthful. The superuser keeps
              an explicit (accurate) visibility note; the self view simply drops it. */}
          {su && (
            <ReassureChip icon={EyeOff} label="Visible to administrators and the scholar" />
          )}
          <ReassureChip icon={Info} label="Not a compliance judgement" />
          <ReassureChip icon={Lock} label="Managed in the Gateway, never here" />
        </ul>

        <div className="border-apollo-border flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p className="text-muted-foreground text-sm" data-testid="coi-gap-summary">
            {summary}
          </p>
          {/* The sort control only earns its keep with more than one relationship. */}
          {candidates.length > 1 && (
            <label className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              Sort
              <select
                data-testid="coi-gap-sort"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="border-apollo-border bg-apollo-surface-2 text-foreground rounded border px-2 py-1 text-xs"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <ul data-slot="coi-gap-panel-list">{orderedHigh.map(renderActiveRow)}</ul>

        {/* LOWER-CONFIDENCE (Medium-tier active) — collapsed by default so it
            never competes with the High list. Same active-row markup inside. */}
        {orderedLower.length > 0 && (
          <details data-testid="coi-gap-lower" className="border-apollo-border border-t pt-3">
            <summary className="text-apollo-slate cursor-pointer text-sm font-medium">
              Show {orderedLower.length} lower-confidence match
              {orderedLower.length === 1 ? "" : "es"}
            </summary>
            <p className="text-muted-foreground mt-1.5 text-xs">
              These are weaker matches — often a co-author’s disclosure rather than your own.
            </p>
            <ul className="mt-1">{orderedLower.map(renderActiveRow)}</ul>
          </details>
        )}

        {/* REVIEWED (current state) — settled history of recorded responses, with
            change-of-mind + undo. No amber, no "worth reviewing": it must NOT nag. */}
        {reviewed.length > 0 && (
          <details data-testid="coi-gap-reviewed" className="border-apollo-border border-t pt-3">
            <summary className="text-muted-foreground cursor-pointer text-sm font-medium">
              Reviewed ({reviewed.length})
            </summary>
            <ul className="mt-1">{reviewed.map(renderReviewedRow)}</ul>
          </details>
        )}
      </EditPanel>

      {/* The superuser "nag" (operator decision): confirm before acting on the
          scholar's private suggestions. Self never sees this — `requestMutate`
          only opens it when `su`. */}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={`Act on ${confirmName}’s private suggestion?`}
        description={
          // Governance: the forbidden accusatory vocabulary (undisclosed / failed
          // to disclose / missing / violation / gap) must NOT appear here either.
          `These are ${confirmName}’s private suggestions worth reviewing, surfaced from their own ` +
          `publications — visible to administrators and ${confirmName}, never a compliance judgement. ` +
          (confirm && confirm.target !== null
            ? `Recording “${ACTED_LABEL[confirm.target]}” files ${confirmName}’s response and removes it from their review. `
            : `Undoing brings this suggestion back to ${confirmName}’s review. `) +
          `Continue only if you have a legitimate reason to act on their behalf.`
        }
        reasonMode="none"
        confirmLabel="Continue"
        confirmVariant="default"
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c) mutate(c.key, c.target);
        }}
      />
    </>
  );
}

/** A slate "posture" pill — states the self-only / not-a-judgement framing up
 *  front instead of burying it in prose. */
function ReassureChip({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
}) {
  return (
    <li className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium">
      <Icon className="size-3.5" aria-hidden />
      {label}
    </li>
  );
}

/**
 * Qualitative confidence chip — color tracks reassurance, never alarm. High =
 * amber "Worth reviewing" (look when you get a chance); Medium = green "Likely
 * covered" (probably already disclosed). Never a percentage, never the numeric
 * score (which never crosses to the client).
 */
function TierChip({ tier }: { tier: "High" | "Medium" }) {
  const review = tier === "High";
  return (
    <span
      data-testid={`coi-gap-tier-${tier}`}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        review
          ? "text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border"
          : "text-apollo-green bg-apollo-green-tint border-apollo-green-tint-border",
      )}
    >
      {review ? "Worth reviewing" : "Likely covered"}
    </span>
  );
}
