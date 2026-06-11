/**
 * "From your publications" — the self-only advisory SUB-VIEW of Conflicts of
 * Interest (`SELF_EDIT_COI_GAP_HINT`, dormant). It surfaces relationships named
 * in a scholar's OWN PubMed competing-interest statements that we could not
 * match to a current Weill Research Gateway disclosure.
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
 *   - The verbatim `sourceSentence` is ALWAYS rendered so the human, not a
 *     score, adjudicates. Confidence is a qualitative tier only — never a
 *     percentage, never the numeric score (which never crosses to the client).
 *   - SPS is NOT the COI system of record: no in-app COI editing. "Review in
 *     Gateway" routes to WRG via the existing `coi` Request-a-Change flow.
 *   - "Not relevant" is the scholar's PRIVATE hide of a suggestion, with undo —
 *     never a compliance decision, and it reads back to no one. It persists
 *     durably (the daily `etl:coi-gap` respects it and never re-nags); Undo
 *     restores it.
 *
 * Visibility was originally self-only; an operator decision (#836 follow-on) also
 * lets a (non-impersonating) superuser view + act on this surface on the scholar's
 * behalf, with a confirmation "nag" before any action and the privacy chip
 * reframed so it never falsely promises "only you". Who may load it is enforced
 * upstream (`loadEditContext` populates `unmatchedPubmedCoi` only for an allowed
 * actor behind the flag) and again at the dismiss/restore APIs (genuine-self OR
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
import type { EditContextCoiGapCandidate } from "@/lib/api/edit-context";

export type CoiGapCardProps = {
  cwid: string;
  /** `superuser` reframes the advisory copy + the privacy chip to the scholar's
   *  name and gates every action behind a confirmation "nag" — a superuser acts
   *  on this sensitive surface on the scholar's behalf (operator decision). */
  mode?: "self" | "superuser";
  scholarName?: string;
  candidates: ReadonlyArray<EditContextCoiGapCandidate>;
};

const PUBMED_URL = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;

export function CoiGapCard({ cwid, mode = "self", scholarName = "", candidates }: CoiGapCardProps) {
  const su = mode === "superuser";
  // The back-link returns to the COI panel on the actor's own surface.
  const backHref = su ? `/edit/scholar/${cwid}?attr=coi` : "/edit?attr=coi";
  // The "nag" (operator decision): a superuser confirms before any dismiss /
  // restore, since these are the scholar's private suggestions. Null when closed.
  const [confirm, setConfirm] = React.useState<{ id: string; action: "dismiss" | "restore" } | null>(
    null,
  );
  // The full set always renders; a "Not relevant" row flips IN PLACE to a
  // "marked not relevant — Undo" line (the `dismissed` set is this session's
  // view of which rows the scholar hid). The DB is the source of truth on
  // reload — a committed dismissal is filtered out by the loader next time.
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());

  function setError(id: string, msg: string | null) {
    setErrors((prev) => {
      const next = new Map(prev);
      if (msg === null) next.delete(id);
      else next.set(id, msg);
      return next;
    });
  }
  function setDismissedFlag(id: string, on: boolean) {
    setDismissed((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // `dismiss` and its inverse `restore` (Undo) are the same optimistic shape: flip
  // the local flag, POST, and roll back on failure. Both are durable + genuine-
  // self-guarded server-side.
  function mutate(id: string, action: "dismiss" | "restore") {
    const dismiss = action === "dismiss";
    setError(id, null);
    setPending((prev) => new Set(prev).add(id));
    setDismissedFlag(id, dismiss); // optimistic
    void (async () => {
      try {
        const res = await fetch(`/api/edit/coi-gap/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
        if (!res.ok || data.ok !== true) {
          setDismissedFlag(id, !dismiss); // roll back
          setError(id, "We couldn't update this just now. Please try again.");
        }
      } catch {
        setDismissedFlag(id, !dismiss);
        setError(id, "We couldn't update this just now. Please try again.");
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    })();
  }

  // A superuser routes every action through the confirm "nag" first; a scholar
  // acts directly on their own suggestions.
  function requestMutate(id: string, action: "dismiss" | "restore") {
    if (su) setConfirm({ id, action });
    else mutate(id, action);
  }

  const active = candidates.filter((c) => !dismissed.has(c.id));
  const reviewing = active.filter((c) => c.tier === "High").length;
  const covered = active.filter((c) => c.tier === "Medium").length;
  const summaryParts: string[] = [];
  if (reviewing) summaryParts.push(`${reviewing} worth reviewing`);
  if (covered) summaryParts.push(`${covered} likely already covered`);
  const summary = summaryParts.length > 0 ? summaryParts.join(" · ") : "Nothing left to review";

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

        <p
          className="border-apollo-border text-muted-foreground border-t pt-3 text-sm"
          data-testid="coi-gap-summary"
        >
          {summary}
        </p>

        <ul data-slot="coi-gap-panel-list">
          {candidates.map((c) => {
            const isDismissed = dismissed.has(c.id);
            const isPending = pending.has(c.id);
            const error = errors.get(c.id) ?? null;
            return (
              <li
                key={c.id}
                className="border-apollo-border border-t py-4 first:border-t-0"
                data-testid={`coi-gap-row-${c.id}`}
              >
                {isDismissed ? (
                  <div className="flex items-center justify-between gap-3 opacity-80">
                    <span className="text-muted-foreground text-sm">
                      <span className="text-foreground font-semibold">{c.entity}</span> — marked not
                      relevant
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => requestMutate(c.id, "restore")}
                      data-testid={`coi-gap-undo-${c.id}`}
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
                      </div>
                      <blockquote
                        className="border-apollo-slate-tint-border text-foreground border-l-2 pl-3 text-sm leading-snug italic"
                        data-testid={`coi-gap-source-${c.id}`}
                      >
                        “{c.sourceSentence}”
                      </blockquote>
                      <p className="text-muted-foreground mt-2 text-[0.8rem]">
                        From{" "}
                        <a
                          href={PUBMED_URL(c.pmid)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-apollo-slate font-medium underline-offset-2 hover:underline"
                        >
                          PMID {c.pmid}
                        </a>
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2.5">
                      <RequestAChangeDialog
                        attribute="coi"
                        cwid={cwid}
                        itemLabel={c.entity}
                        triggerTestId={`coi-gap-review-${c.id}`}
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
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => requestMutate(c.id, "dismiss")}
                        className="text-muted-foreground hover:text-foreground text-[0.8rem] disabled:opacity-50"
                        data-testid={`coi-gap-dismiss-${c.id}`}
                      >
                        Not relevant
                      </button>
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
          })}
        </ul>
      </EditPanel>

      {/* The superuser "nag" (operator decision): confirm before acting on the
          scholar's private suggestions. Self never sees this — `requestMutate`
          only opens it when `su`. */}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={`Act on ${scholarName}’s private suggestion?`}
        description={
          // Governance: the forbidden accusatory vocabulary (undisclosed / failed
          // to disclose / missing / violation / gap) must NOT appear here either.
          `These are ${scholarName}’s private suggestions worth reviewing, surfaced from their own ` +
          `publications — visible to administrators and ${scholarName}, never a compliance judgement. ` +
          (confirm?.action === "restore"
            ? `Restoring brings this suggestion back to ${scholarName}’s review. `
            : `Marking it not relevant hides this suggestion from ${scholarName}’s review. `) +
          `Continue only if you have a legitimate reason to act on their behalf.`
        }
        reasonMode="none"
        confirmLabel="Continue"
        confirmVariant="default"
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c) mutate(c.id, c.action);
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
