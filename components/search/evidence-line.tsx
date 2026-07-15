"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { RepresentativePapers, type ExemplarFetchStatus } from "@/components/search/match-reason";
import { ResultEvidence } from "@/components/search/result-evidence";
import { profilePath } from "@/lib/profile-url";
import type {
  EvidenceGrant,
  EvidencePub,
  ResultEvidence as ResultEvidenceT,
} from "@/lib/api/result-evidence";
import type { AuthorRole } from "@/lib/search-index-docs";
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
 * The match, as one plain sentence — no kind word, no dot, no chevron.
 *
 * `ResultEvidence` renders this same fact with a fixed-width KIND column ("Concept", "Method", …),
 * which earns its place on the public People card, where the kind is the only thing distinguishing
 * one row from the next. On a sponsor card the caption directly above already names the concept, so
 * the kind word is a label on a labelled thing. Reusing the component here was the lazy call and
 * the wrong one.
 *
 * For `publications`, `text` is deliberately only the PREFIX ("3 of 301 publications tagged") and
 * `term` is the descriptor it was tagged with — which is often not the sponsor's word for it, and
 * is exactly the fact worth surfacing.
 */
function evidenceSummary(evidence: ResultEvidenceT, pubCount: number): string {
  switch (evidence.kind) {
    case "publications": {
      const term = evidence.term ? ` ${evidence.term}` : "";
      const desc = evidence.descendantTerms?.length
        ? ` (matched ${evidence.descendantTerms.join(", ")})`
        : "";
      return `${evidence.text}${term}${desc}`;
    }
    case "method":
      return `${evidence.count ?? 0} of ${pubCount} publications used ${evidence.family}`;
    case "topic":
      return `${evidence.count ?? 0} of ${pubCount} publications in ${evidence.label}`;
    case "clinical":
      return evidence.boardCertified
        ? `Board certified in ${evidence.specialty}`
        : `Clinical specialty: ${evidence.specialty}`;
    // Identity kinds are filtered out server-side and cannot reach a sponsor card.
    default:
      return "";
  }
}

/** The funding index's per-person role vocabulary (`FundingPersonChip.role`) → the sponsor
 *  card's brevity. `Multi-PI → MPI` mirrors the rebuild; unknown roles fall back to raw. */
const FUNDING_ROLE_LABEL: Record<string, string> = {
  PI: "PI",
  "Multi-PI": "MPI",
  "Co-I": "Co-I",
  "Sub-PI": "Sub-PI",
  KP: "KP",
};

function GrantRow({ grant }: { grant: EvidenceGrant }) {
  // Absent role renders NOTHING — the scholar is on the grant but the index carries no role for
  // them; a default here would assert a rank in the award we cannot stand behind. (Same rule as
  // an absent authorship role below.)
  const roleLabel = grant.role ? (FUNDING_ROLE_LABEL[grant.role] ?? grant.role) : null;
  // Status closes the line, and it is the fact a sponsor reads first: an active award is a live
  // pitch (green); an expired one is a materially different conversation and says so plainly
  // (muted). "expired 2020" over a bare "2014–2020" — the end date is the only date that changes
  // the read.
  const status: ReactNode = grant.isActive ? (
    <span className="text-[var(--apollo-green)]">
      {grant.endYear ? `active to ${grant.endYear}` : "active"}
    </span>
  ) : grant.endYear ? (
    `expired ${grant.endYear}`
  ) : (
    [grant.startYear, grant.endYear].filter(Boolean).join("–") || null
  );
  const parts = [
    grant.projectId || null,
    grant.sponsor || null,
    // Is this scholar the PI? is the first question asked of a grant, so the role carries weight
    // rather than the muted tone the rest of the line takes.
    roleLabel ? (
      <span key="role" className="text-foreground/90">
        {roleLabel}
      </span>
    ) : null,
    status,
  ].filter(Boolean);
  return (
    <div className="mt-1.5 flex gap-2.5">
      <span className="h-fit shrink-0 rounded bg-[var(--color-accent-slate)]/10 px-1.5 py-0.5 text-[10px] tracking-[0.04em] text-[var(--color-accent-slate)]">
        GRANT
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm leading-snug">
          <PubTitle value={grant.titleHighlight ?? grant.title} />
        </div>
        {parts.length > 0 ? (
          <div className="text-muted-foreground mt-0.5 text-xs">
            {parts
              .flatMap((part, i) => (i === 0 ? [part] : [" · ", part]))
              .map((part, i) => (
                <span key={i}>{part}</span>
              ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

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
  grants,
  summary,
  expanded,
  onToggle,
  panelId,
}: {
  papers: EvidencePub[];
  grants: EvidenceGrant[];
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  panelId: string;
}) {
  // Grants lead. A funded award is the strongest thing a sponsor can be told about a concept, and
  // it is the one artifact that carries a FORWARD date — a paper says what someone did, an active
  // R01 says what they are doing.
  const [leadPub, ...restPubs] = papers;
  const hasArtifact = grants.length > 0 || papers.length > 0;
  const years = restPubs.map((p) => p.year).filter((y): y is number => y != null);
  return (
    <div className="mt-1.5" data-slot="evidence-artifact">
      {grants.map((g) => (
        <GrantRow key={g.projectId} grant={g} />
      ))}
      {leadPub ? <ArtifactRow pub={leadPub} /> : null}
      {expanded ? restPubs.map((p) => <ArtifactRow key={p.pmid} pub={p} />) : null}
      {restPubs.length > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="text-muted-foreground mt-1 ml-[46px] text-xs underline-offset-4 hover:underline"
        >
          {expanded
            ? "− collapse"
            : `+ ${restPubs.length} more pub${restPubs.length === 1 ? "" : "s"}${
                years.length > 0 ? ` (${years.join(", ")})` : ""
              }`}
        </button>
      ) : null}
      {/* The count, and ONLY where the spec puts it: inside the expanded detail, or standing in for
          the artifacts when none resolved. On the face it was the thing the design brief objected
          to — a card that answers "why did this person match?" with a statistic instead of a paper.
          The fallback is not optional: a block whose fetch returns nothing must still say what was
          matched, or it renders as a scholar with nothing to show. */}
      {summary && (expanded || !hasArtifact) ? (
        <p className="text-muted-foreground mt-1.5 text-xs">{summary}</p>
      ) : null}
    </div>
  );
}

/** The index stores the facet's vocabulary ("senior"); a person says "last author". `middle`
 *  reads as "contributing author" here (sponsor console only — this map is not shared): the
 *  honest word for a scholar who was neither lead nor senior on the paper, which is exactly the
 *  read an officer needs when it is the ONLY evidence for the sponsor's top ask. */
const ROLE_LABEL: Record<AuthorRole, string> = {
  sole: "sole author",
  first: "first author",
  last: "last author",
  middle: "contributing author",
};

/** A lead artifact older than this reads as stale: its year takes the warning tone so a
 *  decades-old headline cannot be skimmed past. The cutoff is a DISPLAY heuristic — recency is
 *  not (yet) a ranking input (see issue #1736); the display can only stop laundering the year. */
const STALE_AFTER_YEARS = 10;

function isStaleYear(year: number | null | undefined): boolean {
  return year != null && new Date().getFullYear() - year >= STALE_AFTER_YEARS;
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
        {pub.journal || pub.year != null || pub.role ? (
          <div className="text-muted-foreground mt-0.5 text-xs">
            {[
              pub.journal ? <PubJournal key="j" className="not-italic" value={pub.journal} /> : null,
              // A stale year takes the warning tone; a current one stays grey. Same fact the line
              // always carried — now impossible to skim past when it is the whole case for a match.
              pub.year != null ? (
                isStaleYear(pub.year) ? (
                  <span key="y" className="text-[var(--color-facet-position-count)]">{pub.year}</span>
                ) : (
                  pub.year
                )
              ) : null,
              // ABSENT ROLE RENDERS NOTHING — it is not "middle author". A document indexed before
              // the `wcmAuthors.role` reindex carries no role, and printing the weakest role on a
              // missing field would quietly demote every senior author on every stale document.
              pub.role ? ROLE_LABEL[pub.role] : null,
            ]
              .filter(Boolean)
              .flatMap((part, i) => (i === 0 ? [part] : [" · ", part]))
              .map((part, i) => (
                <span key={i}>{part}</span>
              ))}
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

  // Concept-matched GRANTS, artifact-lead only. Same params as the key-paper route by design.
  //
  // The route is gated on SEARCH_EVIDENCE_ROWS, which is already on in prod, so this needs no flag
  // flip and changes nothing on the public card (which fetches its own funding row independently).
  //
  // ONLY CONCEPT-ADMITTED GRANTS MAY LEAD A CONCEPT-CAPTIONED BLOCK. The funding query is an OR —
  // literal text OR concept tag — so an untagged grant can surface having matched nothing but a
  // stray word of the ask. Verified on staging (cwid stt2007, "HER2-low breast cancer" / D001943):
  // the concept axis admits ZERO grants, yet the text arm returns three, led by "WCM SPORE in
  // PROSTATE Cancer". Rendering that under a HER2-low caption asserts evidence that does not
  // exist. An earlier comment here claimed the text path gave "fewer grants, never wrong ones";
  // it gives wrong ones. So filter on the ROW's `matchedConcept` — absent ⇒ unknown, never "yes".
  //
  // Consequence, deliberately: with SEARCH_FUNDING_CONCEPT_GRANTS off there is no concept axis, so
  // nothing is admitted and the block shows no grant at all. That is the honest answer — with the
  // flag off we cannot prove ANY grant is evidence for this concept. (Moot in prod today: this path
  // is artifact-lead, i.e. the sponsor card, which is behind SPONSOR_MATCH.)
  //
  // It does NOT participate in `claimedPmids`: grants have no pmid and cannot collide with papers.
  const [grants, setGrants] = useState<EvidenceGrant[]>([]);
  const grantsFetched = useRef(false);

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

  const ensureGrants = useCallback(() => {
    if (!artifactLead || !keyPaperConfig || grantsFetched.current) return;
    grantsFetched.current = true;
    const params = new URLSearchParams({
      q: keyPaperConfig.contentQuery,
      descriptorUis: keyPaperConfig.descriptorUis.join(","),
      label: keyPaperConfig.conceptLabel ?? "",
    });
    fetch(`/api/scholar/${encodeURIComponent(cwid)}/grants?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { grants: [] }))
      .then((d: { grants?: EvidenceGrant[] }) =>
        setGrants((d?.grants ?? []).filter((g) => g.matchedConcept === true)),
      )
      .catch(() => setGrants([]));
  }, [artifactLead, keyPaperConfig, cwid]);

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
    // Grants ride the same in-view gate but NOT the ordered chain — they claim no pmids, so nothing
    // downstream depends on them having settled.
    ensureGrants();
    if (isLazyExemplar) ensureExemplar();
    else if (wantsLazyKeyPaper) ensureKeyPaper();
    // Nothing to fetch — release the caller's chain immediately, or a line with no lazy loader
    // would stall every line queued behind it and the rest of the card would never resolve.
    else onResolvedRef.current?.();
  }, [
    autoResolve,
    isLazyExemplar,
    ensureExemplar,
    wantsLazyKeyPaper,
    ensureKeyPaper,
    ensureGrants,
  ]);

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

  // ARTIFACT-LEAD. Just the artifacts: the grants and the papers. `ResultEvidence` is NOT rendered
  // here — its fixed KIND column ("Concept ·") is a label on a thing the caption above already
  // labelled, and it put a statistic where the design brief wants a paper. Its fact survives as
  // `evidenceSummary`, which the disclosure shows on expand and the empty case shows on its own.
  if (artifactLead) {
    return (
      <ArtifactLead
        papers={repPapers}
        grants={grants}
        summary={evidenceSummary(evidence, pubCount)}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        panelId={panelId}
      />
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
