/**
 * "From your publications" — the self-only, read-only panel that surfaces
 * relationships named in a scholar's OWN PubMed competing-interest statements
 * that we did not find among their current Weill Research Gateway disclosures
 * (`SELF_EDIT_COI_GAP_HINT`, dormant). It mirrors `coi-card.tsx` (the
 * `EditPanel` + `LockedBadge` shell) because this is a SIBLING of the disclosed
 * COI panel, not a new chrome.
 *
 * Governance posture (non-negotiable — `docs/coi-pubmed-unmatched-feasibility.md`
 * § /edit UX + § Governance):
 *   - SUGGEST, never accuse. The forbidden vocabulary (undisclosed / failed to
 *     disclose / missing / violation / gap) appears nowhere in this surface. The
 *     framing is "we noticed … you may want to review", a candidate, not a
 *     verdict.
 *   - The verbatim `sourceSentence` is ALWAYS rendered so the human, not a
 *     score, adjudicates.
 *   - Confidence is a qualitative tier chip (High / Medium) only — never a
 *     percentage, never the numeric score (which never crosses to the client).
 *   - SPS is NOT the COI system of record: there is no in-app COI editing. The
 *     "review this" action routes to the Weill Research Gateway via the existing
 *     `coi` Request-a-Change flow. Nothing here notifies anyone.
 *   - The scholar can DISMISS a candidate they consider not relevant; the daily
 *     `etl:coi-gap` job respects a dismissal durably and never re-nags. The
 *     dismiss is optimistic (the row clears immediately), mirroring the
 *     publications / mentees hide pattern.
 *
 * Self-only is enforced upstream at the data layer (`loadEditContext` only
 * populates `unmatchedPubmedCoi` for a genuine, non-impersonating self viewer
 * behind the flag) and again at the dismiss API; this component renders only
 * what it is handed.
 */
"use client";

import * as React from "react";

import { EditPanel } from "@/components/edit/edit-panel";
import { LockedBadge } from "@/components/edit/locked-badge";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EditContextCoiGapCandidate } from "@/lib/api/edit-context";

export type CoiGapCardProps = {
  cwid: string;
  candidates: ReadonlyArray<EditContextCoiGapCandidate>;
};

const PUBMED_URL = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;

export function CoiGapCard({ cwid, candidates }: CoiGapCardProps) {
  // Local list seeds from the server array; a dismissed candidate is removed
  // from it optimistically and the removal is confirmed by the API. On failure
  // the row is restored with an inline error (no whole-page refresh — this page
  // is force-dynamic and the local state is authoritative once committed).
  const [list, setList] = React.useState<EditContextCoiGapCandidate[]>([...candidates]);
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

  function dismiss(candidate: EditContextCoiGapCandidate) {
    const id = candidate.id;
    setError(id, null);
    setPending((prev) => new Set(prev).add(id));
    // Optimistic remove — keep the snapshot so we can restore on failure.
    setList((prev) => prev.filter((c) => c.id !== id));
    void (async () => {
      try {
        const res = await fetch(`/api/edit/coi-gap/${encodeURIComponent(id)}/dismiss`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
        if (!res.ok || data.ok !== true) {
          // Restore the row in its original order and surface a quiet error.
          setList((prev) =>
            [...prev, candidate].sort(
              (a, b) =>
                candidates.findIndex((c) => c.id === a.id) -
                candidates.findIndex((c) => c.id === b.id),
            ),
          );
          setError(id, "We couldn't update this just now. Please try again.");
        }
      } catch {
        setList((prev) =>
          [...prev, candidate].sort(
            (a, b) =>
              candidates.findIndex((c) => c.id === a.id) -
              candidates.findIndex((c) => c.id === b.id),
          ),
        );
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

  return (
    <EditPanel
      slot="coi-gap-panel"
      heading="From your publications"
      description={
        <>
          These relationships were named in the &ldquo;Competing interests&rdquo; statements of your
          own PubMed-indexed publications, and we did not find a matching entry among your current
          Weill Research Gateway disclosures. This is a suggestion to help you keep your disclosures
          current &mdash; it is shown only to you, it is not a compliance judgement, and disclosures
          are always managed in the Weill Research Gateway, never here. When in doubt, it&rsquo;s
          worth a look.
        </>
      }
    >
      <LockedBadge />

      <ul className="divide-apollo-border divide-y" data-slot="coi-gap-panel-list">
        {list.map((c) => {
          const isPending = pending.has(c.id);
          const error = errors.get(c.id) ?? null;
          return (
            <li
              key={c.id}
              className="flex flex-col gap-2.5 py-4"
              data-testid={`coi-gap-row-${c.id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center gap-2">
                    <TierChip tier={c.tier} />
                    <span className="text-foreground text-base font-medium">{c.entity}</span>
                  </div>
                  <blockquote
                    className="border-apollo-border text-foreground border-l-2 pl-3 text-sm leading-snug italic"
                    data-testid={`coi-gap-source-${c.id}`}
                  >
                    &ldquo;{c.sourceSentence}&rdquo;
                  </blockquote>
                  <p className="text-muted-foreground mt-1.5 text-sm">
                    Mentioned in{" "}
                    <a
                      href={PUBMED_URL(c.pmid)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-apollo-maroon underline underline-offset-2"
                    >
                      PMID {c.pmid}
                    </a>
                    . You may want to review this relationship in the Weill Research Gateway.
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <RequestAChangeDialog
                    attribute="coi"
                    cwid={cwid}
                    itemLabel={c.entity}
                    triggerTestId={`coi-gap-review-${c.id}`}
                    trigger={(open) => (
                      <Button type="button" variant="outline" size="sm" onClick={open}>
                        Review in the Weill Research Gateway
                      </Button>
                    )}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isPending}
                    onClick={() => dismiss(c)}
                    data-testid={`coi-gap-dismiss-${c.id}`}
                  >
                    Not relevant
                  </Button>
                </div>
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </li>
          );
        })}
      </ul>

      {list.length === 0 && (
        <p className="text-muted-foreground text-sm" data-testid="coi-gap-empty">
          Nothing here right now.
        </p>
      )}
    </EditPanel>
  );
}

/**
 * The qualitative confidence chip. High = the relationship cleanly bound to this
 * scholar; Medium = a softer match worth a glance. Never a percentage, never the
 * numeric score. Wording is neutral ("Worth reviewing" / "Possible match") — it
 * describes the suggestion's strength, not a finding.
 */
function TierChip({ tier }: { tier: "High" | "Medium" }) {
  const label = tier === "High" ? "Worth reviewing" : "Possible match";
  return (
    <Badge
      variant="outline"
      data-testid={`coi-gap-tier-${tier}`}
      className={cn(
        "rounded-full",
        tier === "High"
          ? "bg-apollo-maroon/10 text-apollo-maroon border-apollo-maroon/20"
          : "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border",
      )}
    >
      {label}
    </Badge>
  );
}
