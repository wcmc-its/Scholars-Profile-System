"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
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
/**
 * The artifact on the card face: a titled paper with its venue and year, badged by kind.
 *
 * Renders NOTHING until a paper resolves — no skeleton, no "loading…" row. The count line beneath
 * already states what was matched, so an empty lead is a card that has not finished rather than a
 * card that is broken, and a spinner per concept per card would be the noisiest thing on the page.
 *
 * `+N more pubs (2023, 2021)` names the years of the papers it can ACTUALLY show — the fetch caps
 * at 3 — and never the scholar's full tagged count. The card's count line says "15 of 347
 * publications tagged"; if this button also said "+14 more" it would be promising 14 papers the
 * response does not contain and the click could not produce. It offers the two it has.
 */
function ArtifactLead({
  papers,
  status,
  expanded,
  onToggle,
  panelId,
}: {
  papers: EvidencePub[];
  status: ExemplarFetchStatus;
  expanded: boolean;
  onToggle: () => void;
  panelId: string;
}) {
  if (papers.length === 0) return null;
  const [lead, ...rest] = papers;
  const years = rest.map((p) => p.year).filter((y): y is number => y != null);
  return (
    <div className="mt-1.5" data-slot="evidence-artifact">
      <ArtifactRow pub={lead} />
      {expanded ? rest.map((p) => <ArtifactRow key={p.pmid} pub={p} />) : null}
      {rest.length > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="text-muted-foreground mt-1 ml-[46px] text-xs underline-offset-4 hover:underline"
        >
          {expanded
            ? "− collapse"
            : `+ ${rest.length} more pub${rest.length === 1 ? "" : "s"}${
                years.length > 0 ? ` (${years.join(", ")})` : ""
              }`}
        </button>
      ) : null}
      {/* `status` is read only to keep an in-flight fetch from rendering a premature "no papers"
          state; there is nothing to show while it runs. */}
      <span className="sr-only">{status === "loading" ? "Resolving publications" : ""}</span>
    </div>
  );
}

function ArtifactRow({ pub }: { pub: EvidencePub }) {
  return (
    <div className="mt-1.5 flex gap-2.5">
      {/* PUB, and only PUB. A GRANT badge needs the funding route, which is uncached and heavy
          (one call per card), and the CONCEPT-tagged grants a sponsor ask actually wants are
          behind a prod-off flag whose flip changes the PUBLIC People card. Separate change. */}
      <span className="text-muted-foreground bg-muted h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] tracking-[0.04em]">
        PUB
      </span>
      <div className="min-w-0 flex-1">
        <a
          href={`https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground text-sm leading-snug underline-offset-4 hover:underline"
        >
          <PubTitle value={pub.titleHtml ?? pub.title} />
        </a>
        {pub.journal || pub.year != null ? (
          <div className="text-muted-foreground mt-0.5 text-xs">
            {pub.journal ? <PubJournal className="not-italic" value={pub.journal} /> : null}
            {pub.journal && pub.year != null ? " · " : null}
            {pub.year ?? null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

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
  stacked,
  tier = "primary",
  defaultExpanded = false,
  autoResolve = false,
  artifactLead = false,
  onResolved,
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
  claimedPmids: Set<string>;
  /** Resolve the representative papers WITHOUT a click, when the caller says this line is worth
   *  paying for (the sponsor console passes its card's in-view state). Default false ⇒ the public
   *  People card is untouched, and the ~700 candidates nobody scrolls to still cost nothing.
   *
   *  This is not a new fetch path: `ensureExemplar`/`ensureKeyPaper` are already standalone and
   *  ref-guarded, and `defaultExpanded` has kicked them outside a click since #1381. This only adds
   *  a second reason to call them, and calling twice is a no-op. */
  autoResolve?: boolean;
  /** Lead with the ARTIFACT, not the count — a titled paper on the card face with its venue and
   *  year, and the "N of M publications tagged" line demoted beneath it. The sponsor console's
   *  design spec; the public People card leads with the count and keeps its chevron. Implies
   *  nothing about fetching: pair it with `autoResolve`, or the lead has nothing to show. */
  artifactLead?: boolean;
  /** Fired once this line's lazy fetch has SETTLED (resolved or failed) and it has therefore
   *  finished claiming its pmids. It exists to let a caller that auto-resolves several lines run
   *  them in ORDER instead of all at once — see the sponsor panel. Without that, every line on a
   *  card fires in the same commit, every one of them reads an empty `claimedPmids`, and the
   *  cross-concept de-dup this whole file is built around silently stops working: the same paper
   *  is offered as the evidence for two different concepts. On the click path this could only
   *  happen if a user opened two collapsed lines in the same instant; under `autoResolve` it is
   *  the DEFAULT, which is why the callback is not optional machinery. */
  onResolved?: () => void;
  /** #1381 follow-up — mount this line already expanded (and kick its lazy fetch on
   *  mount), so a LONE "Also matched" secondary reveals its records in one click on
   *  the umbrella toggle rather than two. Default false ⇒ unchanged. */
  defaultExpanded?: boolean;
  /** #1366 follow-up — true only in the tiered (`evidenceLines`) context. Parts A/B
   *  (panel relabel + relevance cues) are scoped to it so the single-evidence path
   *  keeps the legacy "Key paper(s)" header + no cues, matching the `stacked`-gated
   *  C/D tiering. */
  stacked: boolean;
  /** #1366 follow-up — "primary" = the prominent lead line; "lesser" = a compact
   *  "Also matched" dot row. Only restyles the summary row; the disclosure panel,
   *  lazy fetch, and de-dup are identical across tiers. */
  tier?: "primary" | "lesser";
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();
  // Held in a ref so a caller passing an inline arrow cannot re-trigger the fetch effects.
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;

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
  // Whether this line's exemplar fetch actually excluded sibling-claimed pmids — so
  // an empty resolve can be read as "papers shown under a stronger sibling" (drop the
  // chevron) vs "genuinely nothing renderable" (keep the fallback link). See canExpand.
  const exemplarExcluded = useRef(false);

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
  // paper). `claimedPmids` is a Set shared across this card's lines, stable for a
  // given query (the parent mints a fresh one per query via useMemo) and remounted
  // with the card lines on a query change, so reading/mutating it needs no reset here.
  const inlinePubs = evidence.kind === "publications" ? (evidence.pubs ?? null) : null;
  // Inline pubs (legacy agg path) claim immediately so lazy siblings exclude them.
  useEffect(() => {
    if (inlinePubs)
      for (const p of inlinePubs) claimedPmids.add(p.pmid);
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
    const ex = Array.from(claimedPmids).join(",");
    if (ex) params.set("exclude", ex);
    fetch(`/api/search/key-paper?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { pubs: [] }))
      .then((d: { pubs?: EvidencePub[] }) => {
        const pubs = d?.pubs ?? [];
        for (const p of pubs) claimedPmids.add(p.pmid);
        setKeyPapers(pubs);
      })
      .catch(() => setKeyPapers([]))
      .finally(() => {
        setKeyPaperStatus("done");
        // SETTLED, not "succeeded" — a failed fetch claims nothing, but a caller chaining its
        // lines in order must still be released or the rest of the card never resolves.
        onResolvedRef.current?.();
      });
  }, [wantsLazyKeyPaper, cwid, keyPaperConfig, keyPaperMentionOnly, claimedPmids]);

  const ensureExemplar = useCallback(() => {
    if (!exemplarQuery || exemplarFetched.current) return;
    exemplarFetched.current = true;
    setExemplarStatus("loading");
    const ex = Array.from(claimedPmids).join(",");
    exemplarExcluded.current = ex.length > 0;
    const url = `/api/scholar/${encodeURIComponent(cwid)}/method-exemplar?${exemplarQuery}${
      ex ? `&exclude=${encodeURIComponent(ex)}` : ""
    }`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : { pubs: [], total: 0 }))
      .then((d: ExemplarPayload) => {
        const pubs = d?.pubs ?? [];
        for (const p of pubs) claimedPmids.add(p.pmid);
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

  // #1366 follow-up — the chevron must not offer an empty panel. The key-paper path
  // already drops on empty-resolve; the exemplar path was unconditionally `true`
  // (optimistic), so a line whose papers were all claimed by a higher-priority
  // sibling expanded to nothing while its count still read "2 of 44". Drop the
  // chevron ONLY for that de-dup case (this line actually excluded sibling pmids);
  // a genuine empty (no exclude — every family/topic pub suppressed) keeps its
  // `fallback` profile link, the existing graceful degradation.
  const canExpand = wantsLazyKeyPaper
    ? !(keyPaperStatus === "done" && keyPapers.length === 0)
    : inlinePubs != null
      ? inlinePubs.length > 0
      : isLazyExemplar &&
        !(exemplarStatus === "done" && exemplar.pubs.length === 0 && exemplarExcluded.current);

  const onToggle = useCallback(() => {
    if (isLazyExemplar) ensureExemplar();
    if (wantsLazyKeyPaper) ensureKeyPaper();
    setExpanded((v) => !v);
  }, [isLazyExemplar, ensureExemplar, wantsLazyKeyPaper, ensureKeyPaper]);

  // #1381 follow-up — a lone secondary mounts pre-expanded (defaultExpanded); kick its
  // lazy fetch on mount so the records are there for the single umbrella click.
  useEffect(() => {
    if (!defaultExpanded) return;
    if (isLazyExemplar) ensureExemplar();
    if (wantsLazyKeyPaper) ensureKeyPaper();
    // Once, on mount — the toggle/fetch helpers are stable for a card line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve without a click, when the caller asks. Both `ensure*` are one-shot ref-guarded, so
  // this racing the click path (or a re-render flipping `autoResolve` back and forth) is a no-op
  // rather than a double fetch.
  useEffect(() => {
    if (!autoResolve) return;
    if (isLazyExemplar) ensureExemplar();
    else if (wantsLazyKeyPaper) ensureKeyPaper();
    // Nothing to fetch — release the caller's chain immediately, or a line with no lazy loader
    // would stall every line queued behind it and the rest of the card would never resolve.
    else onResolvedRef.current?.();
  }, [autoResolve, isLazyExemplar, ensureExemplar, wantsLazyKeyPaper, ensureKeyPaper]);

  const profileHref = `${profilePath(slug)}#publications`;
  const exemplarFallback =
    evidence.kind === "method"
      ? { href: profilePath(slug), label: "View their methods & tools" }
      : evidence.kind === "topic"
        ? { href: profilePath(slug), label: "View their research areas" }
        : undefined;

  // #1366 follow-up Part A — the honesty relabel: method/publications exemplars ARE
  // the query match → "Matching publications"; the research-area panel lists the
  // scholar's top papers IN that area (not matched to the query), so it reads
  // "Representative papers" + a clarifying subtitle. Scoped to the tiered (`stacked`)
  // context — the single-evidence path keeps the legacy "Key paper(s)" header.
  const isTopicPanel = evidence.kind === "topic";
  const panelLabel = !stacked
    ? undefined
    : isTopicPanel
      ? "Representative papers"
      : "Matching publications";
  const panelSubtitle =
    stacked && isTopicPanel ? "not from your search" : undefined;

  // Signal-colored left rail on the expanded panel, keyed to the row's category
  // (blue = research area, green handled by KeyFunding). Undefined ⇒ the panel's
  // default flush padding (no rail).
  const railClassName =
    evidence.kind === "method"
      ? "border-l-2 border-[#8B4A2F] pl-[14px]"
      : evidence.kind === "topic"
        ? "border-l-2 border-[#2563eb] pl-[14px]"
        : evidence.kind === "clinical"
          ? "border-l-2 border-[#0891b2] pl-[14px]"
          : evidence.kind === "publications"
            ? evidence.strength === "mention"
              ? "border-l-2 border-[#64748b] pl-[14px]"
              : "border-l-2 border-[#7c3aed] pl-[14px]"
            : undefined;

  // ARTIFACT-LEAD. The papers ARE the disclosure here — they sit on the card face — so the count
  // line below keeps no chevron of its own (`canExpand={false}`), and the "+N more" affordance
  // lives on the artifact list where the papers are. Two chevrons for one panel would be a bug.
  if (artifactLead) {
    return (
      <>
        <ArtifactLead
          papers={repPapers}
          status={wantsLazyKeyPaper ? keyPaperStatus : isLazyExemplar ? exemplarStatus : "done"}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          panelId={panelId}
        />
        <ResultEvidence
          evidence={evidence}
          canExpand={false}
          expanded={false}
          onToggle={onToggle}
          panelId={panelId}
          hasQuery={hasQuery}
          slug={slug}
          badged={badged}
          pubCount={pubCount}
          stacked={stacked}
          // The caller's tier, NOT a forced "lesser". Demoting it here looked tidier and quietly
          // cost an honesty guarantee: the compact tier carries the literal-mention caveat in the
          // papers panel (`mentionNote`), which artifact-lead does not render — so a "mention"
          // match would have lost the one line that says it is only a mention.
          tier={tier}
        />
      </>
    );
  }

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
        stacked={stacked}
        tier={tier}
      />
      {expanded && canExpand ? (
        <RepresentativePapers
          papers={repPapers}
          total={repTotal}
          profileHref={profileHref}
          status={isLazyExemplar ? exemplarStatus : wantsLazyKeyPaper ? keyPaperStatus : "done"}
          panelId={panelId}
          fallback={exemplarFallback}
          panelLabel={panelLabel}
          panelSubtitle={panelSubtitle}
          railClassName={railClassName}
          // #1366 follow-up — the honesty note only on a literal-mention lesser row.
          mentionNote={
            tier === "lesser" &&
            evidence.kind === "publications" &&
            evidence.strength === "mention"
          }
        />
      ) : null}
    </>
  );
}
