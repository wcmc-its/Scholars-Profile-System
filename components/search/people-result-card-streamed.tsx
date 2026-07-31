"use client";

import { Suspense, use } from "react";
import {
  PeopleResultCard,
  type PeopleResultCardProps,
  type KeyPaperConfig,
} from "@/components/search/people-result-card";
import type { PeopleHit } from "@/lib/api/search";
import type { ResultEvidence } from "@/lib/api/result-evidence";

/**
 * Scaling fix B — stream the per-row reason line in AFTER the People list paints.
 *
 * The list shell + this card's identity (name/title/dept/counts) render
 * immediately from the fast `searchPeople({ skipReasonAgg: true })` call. The
 * slow publications-index reason agg runs in a SEPARATE promise (`reasonPromise`,
 * a cwid→patch map) that is NOT on the list's critical path. This wrapper sits in
 * its own Suspense boundary: the fallback is the card rendered with the fast
 * (reason-less) hit, and the resolved child re-renders the same card with the
 * streamed `evidence` patched in. So a slow agg degrades to "the reason line
 * appears a beat later," never a blocked render / nav-watchdog hang.
 *
 * ponytail (full): renders `PeopleResultCard` twice (fallback fast hit + resolved
 * patched hit) rather than threading a Suspense boundary through the card's
 * reason+disclosure internals. Ceiling — a second mount of the card subtree when
 * the patch resolves (disclosure state resets, but it starts collapsed and the
 * swap is sub-second). Keeps all B logic in this one wrapper; the card stays
 * byte-identical to its pre-B self.
 */
type ReasonPatch = {
  evidence?: ResultEvidence;
  // #1366 — the stacked, counted lines (present instead of `evidence` under
  // SEARCH_EVIDENCE_REASON_COUNTS); overlaid the same way.
  evidenceLines?: ResultEvidence[];
};
type ReasonMap = Map<string, ReasonPatch>;

// Search reason-from-doc — `KeyPaperConfig` now lives in `people-result-card`
// (the card owns the lazy-on-expand fetch for the evidence path). Re-exported
// here for the search page, which builds it and threads it through this wrapper.
export type { KeyPaperConfig };

function mergeHit(hit: PeopleHit, patch: ReasonPatch | undefined): PeopleHit {
  if (!patch) return hit;
  // Overlay only the reason-bearing fields; everything else is the fast hit.
  return {
    ...hit,
    evidence: patch.evidence,
    evidenceLines: patch.evidenceLines,
  };
}

function PatchedCard({
  reasonPromise,
  keyPaperConfig,
  ...props
}: PeopleResultCardProps & {
  reasonPromise: Promise<ReasonMap>;
  keyPaperConfig: KeyPaperConfig | null;
}) {
  const patch = use(reasonPromise).get(props.hit.cwid);
  const merged = mergeHit(props.hit, patch);
  return <PeopleResultCard {...props} hit={merged} keyPaperConfig={keyPaperConfig} />;
}

export function PeopleResultCardStreamed({
  reasonPromise,
  keyPaperConfig = null,
  ...props
}: PeopleResultCardProps & {
  reasonPromise: Promise<ReasonMap> | null;
  keyPaperConfig?: KeyPaperConfig | null;
}) {
  // No deferred reason promise. Either matchExplain is off (keyPaperConfig also
  // null → a plain card) OR reason-from-doc (D) already put the reason on the hit
  // inline via the single list query, so there's no second-query map to stream.
  if (reasonPromise === null) {
    return <PeopleResultCard {...props} keyPaperConfig={keyPaperConfig} />;
  }
  return (
    // The fallback is the fast (reason-less) hit that immediately unmounts when the
    // reason promise resolves — force `evidenceRows={false}` on it so the heavy
    // per-card /grants fetch fires only on the RESOLVED card, not twice.
    <Suspense fallback={<PeopleResultCard {...props} evidenceRows={false} />}>
      <PatchedCard {...props} reasonPromise={reasonPromise} keyPaperConfig={keyPaperConfig} />
    </Suspense>
  );
}
