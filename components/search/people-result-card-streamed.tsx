"use client";

import { Suspense, use } from "react";
import { PeopleResultCard, type PeopleResultCardProps } from "@/components/search/people-result-card";
import type { PeopleHit, PeopleMatchReason } from "@/lib/api/search";
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
 * streamed `matchReason`/`evidence` patched in. So a slow agg degrades to "the
 * reason line appears a beat later," never a blocked render / nav-watchdog hang.
 *
 * ponytail (full): renders `PeopleResultCard` twice (fallback fast hit + resolved
 * patched hit) rather than threading a Suspense boundary through the card's
 * reason+disclosure internals. Ceiling — a second mount of the card subtree when
 * the patch resolves (disclosure state resets, but it starts collapsed and the
 * swap is sub-second). Keeps all B logic in this one wrapper; the card stays
 * byte-identical to its pre-B self.
 */
type ReasonPatch = { matchReason?: PeopleMatchReason; evidence?: ResultEvidence };
type ReasonMap = Map<string, ReasonPatch>;

function mergeHit(hit: PeopleHit, patch: ReasonPatch | undefined): PeopleHit {
  if (!patch) return hit;
  // Overlay only the reason-bearing fields; everything else is the fast hit.
  return { ...hit, matchReason: patch.matchReason, evidence: patch.evidence };
}

function PatchedCard({
  reasonPromise,
  ...props
}: PeopleResultCardProps & { reasonPromise: Promise<ReasonMap> }) {
  const patch = use(reasonPromise).get(props.hit.cwid);
  return <PeopleResultCard {...props} hit={mergeHit(props.hit, patch)} />;
}

export function PeopleResultCardStreamed({
  reasonPromise,
  ...props
}: PeopleResultCardProps & { reasonPromise: Promise<ReasonMap> | null }) {
  // No deferred reason (matchExplain off) — render the card directly.
  if (reasonPromise === null) return <PeopleResultCard {...props} />;
  return (
    <Suspense fallback={<PeopleResultCard {...props} />}>
      <PatchedCard {...props} reasonPromise={reasonPromise} />
    </Suspense>
  );
}
