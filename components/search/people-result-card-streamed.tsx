"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";
import { PeopleResultCard, type PeopleResultCardProps } from "@/components/search/people-result-card";
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
type ReasonPatch = { matchReason?: PeopleMatchReason; evidence?: ResultEvidence };
type ReasonMap = Map<string, ReasonPatch>;

/**
 * Search reason-from-doc — the per-search config the card needs to fetch a lazy
 * key paper. `descriptorUis` is the resolved concept's subtree (empty for a
 * free-text-only query); `contentQuery` drives the `<mark>` highlight. Null when
 * the doc-sourced reason path is off (the inline rep-pub serves the key paper).
 */
export type KeyPaperConfig = {
  descriptorUis: string[];
  contentQuery: string;
};

function mergeHit(hit: PeopleHit, patch: ReasonPatch | undefined): PeopleHit {
  if (!patch) return hit;
  // Overlay only the reason-bearing fields; everything else is the fast hit.
  return { ...hit, matchReason: patch.matchReason, evidence: patch.evidence };
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
  const wants = keyPaperConfig !== null && reasonWantsKeyPaper(props.hit.matchReason);

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
        .then((data: { pub?: RepresentativePub | null } | null) => {
          if (!cancelled && data?.pub) setPub(data.pub);
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
      <PeopleResultCard {...props} hit={hit} />
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
  // No deferred reason (matchExplain off) — render the card directly.
  if (reasonPromise === null) return <PeopleResultCard {...props} />;
  return (
    <Suspense fallback={<PeopleResultCard {...props} />}>
      <PatchedCard {...props} reasonPromise={reasonPromise} keyPaperConfig={keyPaperConfig} />
    </Suspense>
  );
}
