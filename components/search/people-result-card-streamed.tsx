"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";
import {
  PeopleResultCard,
  type PeopleResultCardProps,
  type KeyPaperConfig,
} from "@/components/search/people-result-card";
import type { PeopleHit, PeopleMatchReason, RepresentativePub } from "@/lib/api/search";
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
 * Search reason-from-doc (lazy key papers, §5) — when `keyPaperConfig` is set
 * (the doc-sourced reason path), the reason line arrives WITHOUT a key paper (the
 * count is an O(1) doc lookup; no up-front `top_hits`). This wrapper then fetches
 * the concept-tagged, highlighted key paper for THIS card only when it enters the
 * viewport (IntersectionObserver), via `/api/search/key-paper`, and patches it
 * into the already-rendered reason line. Off the critical path: a slow / failed
 * fetch just leaves the reason line without its "— incl. …" clause.
 *
 * ponytail (full): renders `PeopleResultCard` twice (fallback fast hit + resolved
 * patched hit) rather than threading a Suspense boundary through the card's
 * reason+disclosure internals. Ceiling — a second mount of the card subtree when
 * the patch resolves (disclosure state resets, but it starts collapsed and the
 * swap is sub-second). Keeps all B logic in this one wrapper; the card stays
 * byte-identical to its pre-B self.
 */
type ReasonPatch = {
  matchReason?: PeopleMatchReason;
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
    matchReason: patch.matchReason,
    evidence: patch.evidence,
    evidenceLines: patch.evidenceLines,
  };
}

/**
 * A reason is "key-paper-eligible" when it's a pub-evidence line (the doc-sourced
 * tagged/mention reason — `icon` present) that doesn't already carry a pub. The
 * method/topic (`kind`) and concept-fallback reasons never take a key paper.
 */
export function reasonWantsKeyPaper(reason: PeopleMatchReason | undefined): boolean {
  return (
    !!reason &&
    !("kind" in reason) &&
    (reason.icon === "publications") &&
    !reason.pub
  );
}

export function patchKeyPaper(hit: PeopleHit, pub: RepresentativePub): PeopleHit {
  const reason = hit.matchReason;
  if (!reason || "kind" in reason) return hit;
  return { ...hit, matchReason: { ...reason, pub } };
}

/**
 * Fetch + patch the lazy key paper once this card enters the viewport. The hit
 * already carries the reason line (count); we only add the "— incl. …" clause.
 * Off the critical path: a slow / failed fetch leaves the reason line as-is.
 */
function CardWithLazyKeyPaper({
  keyPaperConfig,
  ...props
}: PeopleResultCardProps & { keyPaperConfig: KeyPaperConfig | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pub, setPub] = useState<RepresentativePub | null>(null);
  // Eager fetch ONLY for the LEGACY render path (`SEARCH_RESULT_EVIDENCE` off),
  // where the key paper renders inline ("— incl. …") via `matchReason.pub`. On the
  // evidence path the card owns a fetch-on-EXPAND for the disclosure (via
  // `keyPaperConfig`), so we must not also eager-fetch here — that's the
  // per-visible-card load the chevron lets us avoid.
  // #1366 — the evidence path is active when EITHER the single `evidence` OR the
  // stacked `evidenceLines` is present; in both cases the card owns a
  // fetch-on-EXPAND, so the wrapper must NOT also eager-fetch.
  const wants =
    keyPaperConfig !== null &&
    !props.hit.evidence &&
    !props.hit.evidenceLines &&
    reasonWantsKeyPaper(props.hit.matchReason);

  useEffect(() => {
    if (!wants || pub) return;
    const node = ref.current;
    let cancelled = false;
    const run = () => {
      const params = new URLSearchParams({
        cwid: props.hit.cwid,
        q: keyPaperConfig!.contentQuery,
        descriptorUis: keyPaperConfig!.descriptorUis.join(","),
      });
      fetch(`/api/search/key-paper?${params.toString()}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { pubs?: RepresentativePub[] } | null) => {
          // The legacy inline path shows ONE representative pub — take the top.
          const first = data?.pubs?.[0];
          if (!cancelled && first) setPub(first);
        })
        .catch(() => {});
    };
    if (!node || typeof IntersectionObserver === "undefined") {
      run();
      return () => {
        cancelled = true;
      };
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          run();
          obs.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(node);
    return () => {
      cancelled = true;
      obs.disconnect();
    };
  }, [wants, pub, props.hit.cwid, keyPaperConfig]);

  const hit = pub ? patchKeyPaper(props.hit, pub) : props.hit;
  return (
    <div ref={ref}>
      <PeopleResultCard {...props} hit={hit} keyPaperConfig={keyPaperConfig} />
    </div>
  );
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
  return <CardWithLazyKeyPaper {...props} hit={merged} keyPaperConfig={keyPaperConfig} />;
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
  // Either way route through the lazy wrapper so a doc-sourced reason still gets
  // its key paper on viewport-enter (CardWithLazyKeyPaper no-ops when config null).
  if (reasonPromise === null) {
    return <CardWithLazyKeyPaper {...props} keyPaperConfig={keyPaperConfig} />;
  }
  return (
    // The fallback is the fast (reason-less) hit that immediately unmounts when the
    // reason promise resolves — force `evidenceRows={false}` on it so the heavy
    // per-card /grants fetch fires only on the RESOLVED card, not twice. Mirrors the
    // key-paper pattern (CardWithLazyKeyPaper wraps only the resolved child).
    <Suspense fallback={<PeopleResultCard {...props} evidenceRows={false} />}>
      <PatchedCard {...props} reasonPromise={reasonPromise} keyPaperConfig={keyPaperConfig} />
    </Suspense>
  );
}
