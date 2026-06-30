"use client";

import { type MutableRefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { RepresentativePapers, type ExemplarFetchStatus } from "@/components/search/match-reason";
import { ResultEvidence } from "@/components/search/result-evidence";
import { profilePath } from "@/lib/profile-url";
import type { EvidencePub, ResultEvidence as ResultEvidenceT } from "@/lib/api/result-evidence";
import type { KeyPaperConfig } from "@/components/search/people-result-card";

/**
 * #1366 — ONE evidence reason line plus its own representative-papers disclosure.
 * Extracted from `PeopleResultCard` so the STACKED path can render several lines,
 * each with INDEPENDENT expand/fetch state (React needs a component instance per
 * disclosure). The single-evidence path renders exactly one `<EvidenceLine>` with
 * a fresh (empty) `claimedPmids`, so its behavior is identical to before.
 *
 * Exemplar DE-DUP (handoff §3): representative papers must be globally disjoint
 * across the stacked lines even though counts may overlap. Each line's lazy fetch
 * (`?family=`/`?topic=` exemplar, or `/key-paper`) sends `exclude=<claimedPmids>`
 * and adds its returned pmids to the shared set; inline pubs claim on mount. So
 * no paper appears under two disclosures.
 * ponytail: a simultaneous expand of two collapsed lines (both before either
 * fetch resolves) can transiently share a paper — the `claimed` set updates on
 * resolve, not on click. Accepted; users open one disclosure at a time. Upgrade
 * path if it ever matters: claim optimistically by reserving the line's slot.
 */
export function EvidenceLine({
  evidence,
  cwid,
  slug,
  pubCount,
  q,
  keyPaperConfig,
  hasQuery,
  badged,
  claimedPmids,
}: {
  evidence: ResultEvidenceT;
  cwid: string;
  slug: string;
  pubCount: number;
  q: string;
  keyPaperConfig: KeyPaperConfig | null;
  hasQuery: boolean;
  badged: boolean;
  /** Shared across a card's stacked lines for exemplar de-dup. */
  claimedPmids: MutableRefObject<Set<string>>;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  // method/topic resolve their representative papers LAZILY (on first expand). The
  // query string selects the loader: `?family=` / `?topic=`.
  const qParam = (q ?? "").trim();
  const qSuffix = qParam ? `&q=${encodeURIComponent(qParam)}` : "";
  const exemplarQuery =
    evidence.kind === "method"
      ? `family=${encodeURIComponent(evidence.family)}${qSuffix}`
      : evidence.kind === "topic"
        ? `topic=${encodeURIComponent(evidence.id)}${qSuffix}`
        : null;

  type ExemplarPayload = {
    pubs: EvidencePub[];
    total: number;
    methodContext?: { tool: string; context: string } | null;
  };
  const [exemplar, setExemplar] = useState<{ pubs: EvidencePub[]; total: number }>({
    pubs: [],
    total: 0,
  });
  const [exemplarStatus, setExemplarStatus] = useState<ExemplarFetchStatus>("idle");
  const exemplarFetched = useRef(false);

  // publications kind under reason-from-doc — pubs arrive empty, fetched lazily.
  const wantsLazyKeyPaper =
    keyPaperConfig != null &&
    evidence.kind === "publications" &&
    (evidence.pubs?.length ?? 0) === 0 &&
    (evidence.count ?? 0) > 0;
  const keyPaperMentionOnly =
    evidence.kind === "publications" && evidence.strength === "mention";
  const [keyPapers, setKeyPapers] = useState<EvidencePub[]>([]);
  const [keyPaperStatus, setKeyPaperStatus] = useState<ExemplarFetchStatus>("idle");
  const keyPaperFetched = useRef(false);

  // #1366 — the pmids already shown on a sibling line drive `exclude` so this
  // line's fetch stays disjoint (cumulative; whoever resolves first owns a shared
  // paper). `claimedPmids` is a stable ref, so reading/mutating `.current` inside
  // the callbacks needs no dependency (helpers are inlined to keep deps honest).
  const inlinePubs = evidence.kind === "publications" ? (evidence.pubs ?? null) : null;
  // Inline pubs (legacy agg path) claim immediately so lazy siblings exclude them.
  useEffect(() => {
    if (inlinePubs)
      for (const p of inlinePubs) claimedPmids.current.add(p.pmid);
    // claim once per line; `evidence` is stable for a card line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureKeyPaper = useCallback(() => {
    if (!wantsLazyKeyPaper || keyPaperFetched.current) return;
    keyPaperFetched.current = true;
    setKeyPaperStatus("loading");
    const params = new URLSearchParams({
      cwid,
      q: keyPaperConfig!.contentQuery,
      descriptorUis: keyPaperMentionOnly ? "" : keyPaperConfig!.descriptorUis.join(","),
      label: keyPaperMentionOnly ? "" : (keyPaperConfig!.conceptLabel ?? ""),
    });
    const ex = Array.from(claimedPmids.current).join(",");
    if (ex) params.set("exclude", ex);
    fetch(`/api/search/key-paper?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { pubs: [] }))
      .then((d: { pubs?: EvidencePub[] }) => {
        const pubs = d?.pubs ?? [];
        for (const p of pubs) claimedPmids.current.add(p.pmid);
        setKeyPapers(pubs);
      })
      .catch(() => setKeyPapers([]))
      .finally(() => setKeyPaperStatus("done"));
  }, [wantsLazyKeyPaper, cwid, keyPaperConfig, keyPaperMentionOnly, claimedPmids]);

  const ensureExemplar = useCallback(() => {
    if (!exemplarQuery || exemplarFetched.current) return;
    exemplarFetched.current = true;
    setExemplarStatus("loading");
    const ex = Array.from(claimedPmids.current).join(",");
    const url = `/api/scholar/${encodeURIComponent(cwid)}/method-exemplar?${exemplarQuery}${
      ex ? `&exclude=${encodeURIComponent(ex)}` : ""
    }`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : { pubs: [], total: 0 }))
      .then((d: ExemplarPayload) => {
        const pubs = d?.pubs ?? [];
        for (const p of pubs) claimedPmids.current.add(p.pmid);
        setExemplar({ pubs, total: d?.total ?? 0 });
      })
      .catch(() => setExemplar({ pubs: [], total: 0 }))
      .finally(() => setExemplarStatus("done"));
  }, [cwid, exemplarQuery, claimedPmids]);

  const isLazyExemplar = !!exemplarQuery;
  const evidenceCount = evidence.kind === "publications" ? evidence.count : undefined;

  const repPapers = wantsLazyKeyPaper ? keyPapers : (inlinePubs ?? exemplar.pubs);
  const repTotal = wantsLazyKeyPaper
    ? (evidenceCount ?? keyPapers.length)
    : inlinePubs != null
      ? (evidenceCount ?? inlinePubs.length)
      : exemplar.total;

  const canExpand = wantsLazyKeyPaper
    ? !(keyPaperStatus === "done" && keyPapers.length === 0)
    : inlinePubs != null
      ? inlinePubs.length > 0
      : isLazyExemplar;

  const onToggle = useCallback(() => {
    if (isLazyExemplar) ensureExemplar();
    if (wantsLazyKeyPaper) ensureKeyPaper();
    setExpanded((v) => !v);
  }, [isLazyExemplar, ensureExemplar, wantsLazyKeyPaper, ensureKeyPaper]);

  const profileHref = `${profilePath(slug)}#publications`;
  const exemplarFallback =
    evidence.kind === "method"
      ? { href: profilePath(slug), label: "View their methods & tools" }
      : evidence.kind === "topic"
        ? { href: profilePath(slug), label: "View their research areas" }
        : undefined;

  return (
    <>
      <ResultEvidence
        evidence={evidence}
        canExpand={canExpand}
        expanded={expanded}
        onToggle={onToggle}
        panelId={panelId}
        hasQuery={hasQuery}
        slug={slug}
        badged={badged}
        pubCount={pubCount}
      />
      {expanded && canExpand ? (
        <RepresentativePapers
          papers={repPapers}
          total={repTotal}
          profileHref={profileHref}
          status={isLazyExemplar ? exemplarStatus : wantsLazyKeyPaper ? keyPaperStatus : "done"}
          panelId={panelId}
          fallback={exemplarFallback}
        />
      ) : null}
    </>
  );
}
