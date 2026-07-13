"use client";

/**
 * CTL sponsor match — paste a commercial sponsor's description (an email or a
 * call transcript), rank WCM researchers on topical fit ALONE
 * (`docs/2026-07-09-ctl-technologies-handoff.md` §2). One POST to
 * `/api/edit/sponsor-match`; no stage axis, no ESI, no intake queue.
 *
 * THE SLIDERS DO NOT TALK TO THE SERVER. The response carries the decomposed score
 * inputs — each concept's editable `centrality` and fixed `weightFactor`, and each candidate's
 * per-concept `rank` — so a slider move re-ranks the ALREADY-FETCHED candidates with
 * `rerankCandidates`, in a `useMemo`, in the browser. That is the UI ⇄ ranker contract's
 * central invariant (`lib/api/sponsor-match-contract.ts`), and it is why there is no
 * "Re-rank" button here: re-ranking is not an action, it is a render.
 *
 * PR #1673 did the opposite — it re-POSTed the description with edited concepts on every
 * drag, so each drag re-ran up to 8 concepts × paged `searchPeople` (seconds, not live).
 * If you find yourself adding a fetch inside a slider handler, re-read the contract.
 *
 * Rows are a deliberately minimal cut of the Funding-matcher row (that markup is not
 * exported and carries stage/ESI/CSV machinery this surface rejects): linked name →
 * public profile, title/department, a fit tier, the concepts the person actually matched,
 * and a CTL-IP badge when they already hold licensable IP. On top of that:
 *  - client-side FACETS (department / matched concept / CTL-IP) over the long server list
 *    — narrowing never re-queries, and each row keeps its live rank so "#7 overall" stays
 *    legible under a filter;
 *  - a search HISTORY in localStorage ONLY. Descriptions are commercially sensitive; the
 *    server never persists them (route contract), so history lives in the officer's own
 *    browser and nowhere else.
 *
 * VISUAL: this is the working console's idiom, wired to the contract. The Scholars-skinned
 * reskin (`sponsor-match-scholars.html`) is a separate pass — the data seam is the fix here.
 */
import { useEffect, useMemo, useState } from "react";

import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fitTier,
  matchedConcepts,
  rareTerms,
  rerankCandidates,
  type SponsorCandidate,
  type SponsorConcept,
  type SponsorFitTier,
} from "@/lib/api/sponsor-match-contract";
import { initials } from "@/lib/utils";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

type HistoryEntry = { d: string; at: string };

const HISTORY_KEY = "sponsor-match-history";
const HISTORY_MAX = 20;

/** Concept facet stays scannable: top-N by researcher coverage. */
const CONCEPT_FACET_MAX = 12;

/** Rows rendered from the re-ranked pool. The RESPONSE carries the whole fused pool so the
 *  sliders have something to re-rank over (see the `ranked` memo); this is only how much of
 *  the current ranking we put on screen, and it matches what the console showed before. */
const RESULT_MAX = 100;

/** Coverage 7.17e-4 → "about 1 in 1,400 papers". Reads better than a fraction in a tooltip. */
function oneInN(coverage: number): string {
  return `about 1 in ${Math.round(1 / coverage).toLocaleString()} Weill Cornell papers`;
}

const TIER_LABEL: Record<SponsorFitTier, string> = {
  strong: "Strong fit",
  good: "Good fit",
  weak: "Weak fit",
};

const TIER_CLASS: Record<SponsorFitTier, string> = {
  strong: "bg-[var(--color-accent-slate)] text-white",
  good: "bg-[var(--color-accent-slate)]/25 text-[var(--color-accent-slate)]",
  weak: "border-border text-muted-foreground border",
};

function toggled(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function SponsorMatchPanel() {
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [deptSel, setDeptSel] = useState<ReadonlySet<string>>(new Set());
  const [conceptSel, setConceptSel] = useState<ReadonlySet<string>>(new Set());
  const [ctlOnly, setCtlOnly] = useState(false);
  // The two halves of the contract payload. `candidates` is fetched ONCE per search and
  // never refetched by a slider; `concepts` is the editable rail. Everything below is
  // derived from them.
  const [candidates, setCandidates] = useState<SponsorCandidate[]>([]);
  const [concepts, setConcepts] = useState<SponsorConcept[]>([]);
  const pending = status.kind === "loading";

  // SSR-safe history load: start empty, read localStorage in an effect (no
  // hydration mismatch — same pattern as the COI-gap card's sticky group-by).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed))
        setHistory(
          parsed.filter(
            (h): h is HistoryEntry =>
              !!h && typeof h === "object" && typeof (h as HistoryEntry).d === "string",
          ),
        );
    } catch {
      /* private mode / disabled storage / corrupt entry — start empty. */
    }
  }, []);

  function saveHistory(text: string) {
    setHistory((prev) => {
      const next = [
        { d: text, at: new Date().toISOString() },
        ...prev.filter((h) => h.d !== text),
      ].slice(0, HISTORY_MAX);
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function clearHistory() {
    setHistory([]);
    try {
      window.localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
  }

  function clearFilters() {
    setDeptSel(new Set());
    setConceptSel(new Set());
    setCtlOnly(false);
  }

  /** The ONLY network call. A search — never a re-rank. */
  async function runSearch(text: string) {
    if (pending || text.trim().length === 0) return;
    setStatus({ kind: "loading" });
    try {
      const r = await fetch("/api/edit/sponsor-match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ description: text }),
      });
      if (r.ok) {
        const data = (await r.json()) as {
          candidates?: SponsorCandidate[];
          concepts?: SponsorConcept[];
        };
        clearFilters(); // stale facet selections must not silently hide fresh results
        saveHistory(text.trim());
        setCandidates(data.candidates ?? []);
        setConcepts(data.concepts ?? []);
        setStatus({ kind: "ok" });
        return;
      }
      setStatus({
        kind: "error",
        message:
          r.status === 403
            ? "You don't have access to the sponsor matcher."
            : "Couldn't rank researchers. Please try again.",
      });
    } catch {
      setStatus({ kind: "error", message: "Couldn't rank researchers. Please try again." });
    }
  }

  /** THE HINGE. A slider writes `centrality` here; the `ranked` memo below recomputes the
   *  whole ordering from data already in the browser. No fetch, no loading state. */
  function setCentrality(term: string, centrality: number) {
    setConcepts((prev) => prev.map((c) => (c.term === term ? { ...c, centrality } : c)));
  }

  // Live re-rank. This is the contract's promise, and it is one line: the decomposed
  // inputs are all here, so re-ranking is pure arithmetic over state.
  //
  // `candidates` is the ranker's FULL fused pool (up to ~800), not its top-100 — it has to
  // be, or sliding a concept up could not surface that concept's own best people, because
  // they would have been truncated away at default weights before the response was written
  // (see `sponsor-match-spine-run.ts`). We re-rank the whole pool and show the head of it,
  // so the visible list is the true top-N under the CURRENT weights, recomputed live.
  const ranked = useMemo(
    () => rerankCandidates(candidates, concepts).slice(0, RESULT_MAX),
    [candidates, concepts],
  );

  const topScore = ranked[0]?.fusedScore ?? 0;

  const conceptPanels = useMemo(
    () => ({
      concept: concepts.filter((c) => c.kind === "concept"),
      method: concepts.filter((c) => c.kind === "method"),
    }),
    [concepts],
  );

  // Rarity is judged across the WHOLE ask, not per panel — a method is scarce relative to
  // the other concepts the sponsor named, not just to the other methods.
  const rare = useMemo(() => rareTerms(concepts), [concepts]);

  const deptFacet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of ranked)
      if (c.department) counts.set(c.department, (counts.get(c.department) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [ranked]);

  // Facet over the concepts people actually MATCHED (their contributions), not the whole
  // rail — a concept nobody ranked under is not a useful filter. Counts are over the full
  // candidate set, pre-filter.
  const conceptFacet = useMemo(() => {
    const label = new Map(concepts.map((c) => [c.term, c]));
    const counts = new Map<string, number>();
    for (const c of ranked)
      for (const term of new Set(c.contributions.map((x) => x.term)))
        if (label.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, CONCEPT_FACET_MAX);
  }, [ranked, concepts]);

  const ctlHolderCount = useMemo(
    () => ranked.filter((c) => c.technologyCount > 0).length,
    [ranked],
  );

  const hasFilters = deptSel.size > 0 || conceptSel.size > 0 || ctlOnly;
  // Live rank travels with the row, so a filtered view still reads "this person is #7
  // overall", not "#1 of the filtered three". It re-derives as sliders move.
  const visible = ranked
    .map((c, i) => ({ c, rank: i + 1 }))
    .filter(
      ({ c }) =>
        (deptSel.size === 0 || (c.department != null && deptSel.has(c.department))) &&
        (conceptSel.size === 0 ||
          c.contributions.some((x) => conceptSel.has(x.term))) &&
        (!ctlOnly || c.technologyCount > 0),
    );

  return (
    <div data-slot="sponsor-match-panel">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Sponsor match</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Paste a commercial sponsor&rsquo;s description of their interest and rank Weill
          Cornell researchers by topical fit alone — no career-stage or grant-eligibility
          weighting. Recommendations, not endorsements.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(description);
        }}
        className="mb-4"
      >
        <label htmlFor="sponsor-description" className="mb-1.5 block text-sm font-medium">
          Sponsor&rsquo;s description
        </label>
        <textarea
          id="sponsor-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          placeholder="Paste the sponsor's description of their interest…"
          className="border-border w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={pending || description.trim().length === 0}
          className="mt-2 inline-flex h-9 items-center rounded-md bg-[var(--color-accent-slate)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Ranking…" : "Rank researchers"}
        </button>
      </form>

      {history.length > 0 ? (
        <details data-slot="sponsor-match-history" className="mb-6">
          <summary className="text-muted-foreground cursor-pointer text-sm select-none">
            Recent searches ({history.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {history.map((h) => (
              <li key={h.d} className="flex items-baseline gap-2">
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {new Date(h.at).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  title={h.d}
                  onClick={() => {
                    setDescription(h.d);
                    void runSearch(h.d);
                  }}
                  className="min-w-0 truncate text-left text-sm text-foreground/90 underline-offset-4 hover:underline"
                >
                  {h.d}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={clearHistory}
            className="text-muted-foreground mt-2 text-xs underline-offset-4 hover:underline"
          >
            Clear history
          </button>
        </details>
      ) : null}

      {status.kind === "loading" ? (
        <div aria-busy="true">
          <p className="text-muted-foreground py-3 text-sm">Ranking researchers…</p>
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="border-border rounded-lg border p-4">
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="mt-2 h-4 w-2/3" />
              </div>
            ))}
          </div>
        </div>
      ) : status.kind === "error" ? (
        <p role="alert" className="text-muted-foreground py-4 text-sm">
          {status.message}
        </p>
      ) : status.kind === "ok" ? (
        <>
          {ranked.length === 0 ? (
            <p className="text-muted-foreground py-4 text-sm">
              No researchers matched this description.
            </p>
          ) : (
            <>
              {conceptPanels.concept.length > 0 ? (
                <ConceptRail
                  title="Concepts"
                  concepts={conceptPanels.concept}
                  rare={rare}
                  onCentralityChange={setCentrality}
                />
              ) : null}
              {conceptPanels.method.length > 0 ? (
                <ConceptRail
                  title="Methods"
                  concepts={conceptPanels.method}
                  rare={rare}
                  onCentralityChange={setCentrality}
                />
              ) : null}

              <div
                data-slot="sponsor-match-facets"
                className="border-border mb-4 rounded-lg border p-3"
              >
                {deptFacet.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground mr-1 text-xs font-medium">
                      Department
                    </span>
                    {deptFacet.map(([dept, n]) => (
                      <FacetChip
                        key={dept}
                        active={deptSel.has(dept)}
                        onClick={() => setDeptSel(toggled(deptSel, dept))}
                      >
                        {dept} · {n}
                      </FacetChip>
                    ))}
                  </div>
                ) : null}
                {conceptFacet.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground mr-1 text-xs font-medium">
                      Matched concept
                    </span>
                    {conceptFacet.map(([term, n]) => (
                      <FacetChip
                        key={term}
                        active={conceptSel.has(term)}
                        onClick={() => setConceptSel(toggled(conceptSel, term))}
                      >
                        {term} · {n}
                      </FacetChip>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <FacetChip
                    active={ctlOnly}
                    onClick={() => setCtlOnly(!ctlOnly)}
                    title="Only researchers who already hold licensable technology in the CTL portfolio."
                  >
                    ★ Holds CTL technology · {ctlHolderCount}
                  </FacetChip>
                  {hasFilters ? (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="text-muted-foreground ml-1 text-xs underline-offset-4 hover:underline"
                    >
                      Clear filters
                    </button>
                  ) : null}
                </div>
              </div>

              <h2 className="text-base font-semibold">
                Researchers for this description (
                {hasFilters ? `${visible.length} of ${ranked.length}` : ranked.length})
              </h2>
              {visible.length === 0 ? (
                <p className="text-muted-foreground py-4 text-sm">
                  No researchers match the selected filters.
                </p>
              ) : (
                <ul className="mt-1">
                  {visible.map(({ c, rank }) => (
                    <li key={c.cwid}>
                      <ResearcherRow
                        candidate={c}
                        rank={rank}
                        concepts={concepts}
                        topScore={topScore}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

/**
 * The editable rail: one range slider per merged concept.
 *
 * The floor is 0, not 0.05. Under #1673 a 0 round-tripped through the server's
 * `sanitizeConcepts`, which rewrote any non-positive centrality to 0.3 — so a 0 stop
 * silently snapped back and "mute this concept" was impossible to express. Now that the
 * re-rank is client-side there is no sanitize hop, and 0 means exactly what it looks like:
 * the concept's fusion weight goes to zero and it stops contributing, without being
 * dropped from the rail (slide it back up and its candidates return).
 *
 * Rows are NOT removable and keep their server order (most-central first) — the console
 * reweights, it never drops a concept. Native `<input type=range>` keeps it accessible
 * and on-idiom (no custom slider).
 */
function ConceptRail({
  title,
  concepts,
  rare,
  onCentralityChange,
}: {
  title: string;
  concepts: SponsorConcept[];
  /** Terms to badge, computed once across the whole ask by `rareTerms`. */
  rare: ReadonlySet<string>;
  onCentralityChange: (term: string, centrality: number) => void;
}) {
  return (
    <div data-slot="sponsor-match-concepts" className="border-border mb-4 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-muted-foreground text-xs">drag to reweight — updates live</span>
      </div>
      <ul className="mt-3 space-y-3">
        {concepts.map((c) => (
          <li key={c.term} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0">
                <span className="text-sm font-medium">{c.term}</span>
                {/* Reads `corpusCoverage`, never `weightFactor` — the badge is a claim about
                    the LITERATURE, not about the ranking. The tooltip states the measured
                    fact and stops there; it deliberately does NOT say "so it counts for
                    more", which is what made the old badge misleading. */}
                {rare.has(c.term) && c.corpusCoverage != null ? (
                  <span
                    title={`Scarce at Weill Cornell relative to the other concepts in this ask — ${oneInN(
                      c.corpusCoverage,
                    )}.`}
                    className="text-muted-foreground ml-1.5 text-xs"
                  >
                    ·rare
                  </span>
                ) : null}
              </span>
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {c.centrality.toFixed(2)}
              </span>
            </div>
            {/* The merged forms that collapsed into this concept — so an officer can see
                that "cancer" and "oncology" are one slider, not two. */}
            {c.members.length > 1 ? (
              <div className="flex flex-wrap gap-1">
                {c.members.slice(1).map((m) => (
                  <span
                    key={m}
                    className="border-border text-muted-foreground rounded-full border px-1.5 py-0.5 text-xs"
                  >
                    {m}
                  </span>
                ))}
              </div>
            ) : null}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={c.centrality}
              onChange={(e) => onCentralityChange(c.term, Number(e.target.value))}
              aria-label={`${c.term} centrality`}
              className="w-full accent-[var(--color-accent-slate)]"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FacetChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        active
          ? "border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
          : "border-border bg-background text-foreground/80 hover:border-[var(--color-accent-slate)]"
      }`}
    >
      {children}
    </button>
  );
}

function ResearcherRow({
  candidate,
  rank,
  concepts,
  topScore,
}: {
  candidate: SponsorCandidate;
  rank: number;
  concepts: SponsorConcept[];
  topScore: number;
}) {
  const name = candidate.name;
  // Chips + tier are DERIVED, never wired — so both stay live under the sliders. The raw
  // fused score is never rendered: it is an RRF sum and means nothing on its own.
  const matched = matchedConcepts(candidate, concepts);
  const tier = fitTier(candidate.fusedScore, topScore);
  const papers = candidate.evidence?.papers ?? [];
  const topics = candidate.evidence?.topics ?? [];
  return (
    <div className="border-t border-border flex gap-3 py-4 first:border-t-0">
      <div className="text-muted-foreground w-5 pt-1 text-right text-sm tabular-nums">{rank}</div>
      <div
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-slate)]/15 text-sm font-medium text-[var(--color-accent-slate)]"
      >
        {initials(name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <a
            href={`/${encodeURIComponent(candidate.profileSlug)}`}
            className="text-base font-semibold leading-snug text-foreground underline-offset-4 hover:underline"
          >
            {name}
          </a>
          {candidate.title ? (
            <span className="text-muted-foreground text-sm">{candidate.title}</span>
          ) : null}
          <span
            className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs ${TIER_CLASS[tier]}`}
          >
            {TIER_LABEL[tier]}
          </span>
        </div>
        {candidate.department ? (
          <div className="text-muted-foreground text-sm">{candidate.department}</div>
        ) : null}
        {matched.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {matched.map(({ concept }) => (
              <span
                key={concept.term}
                title={`Ranked under "${concept.term}" for this description.`}
                className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-xs"
              >
                {concept.term}
              </span>
            ))}
          </div>
        ) : null}
        {topics.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {topics.map((t) => (
              <span
                key={t.label}
                title={`${t.pubCount} matching paper${t.pubCount === 1 ? "" : "s"} in this topic`}
                className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-xs"
              >
                {t.label}
              </span>
            ))}
          </div>
        ) : null}
        {papers.length > 0 ? (
          <details className="mt-1.5">
            <summary className="text-muted-foreground cursor-pointer text-xs select-none">
              Why this match — top paper{papers.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-1 space-y-1">
              {papers.map((p) => (
                <li key={p.pmid} className="text-xs">
                  <a
                    href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(p.pmid)}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground/90 underline-offset-4 hover:underline"
                  >
                    <PubTitle value={p.title} />
                  </a>{" "}
                  <span className="text-muted-foreground">
                    {p.journal ? (
                      <>
                        <PubJournal value={p.journal} className="not-italic" />
                        {" · "}
                      </>
                    ) : null}
                    {(p.year ? `${p.year}` : "") +
                      (p.relevance != null
                        ? `${p.year ? " · " : ""}${Math.round(p.relevance * 100)}% match`
                        : "")}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {candidate.technologyCount > 0 ? (
          <span
            title="Licensable technologies this researcher already holds in the CTL portfolio."
            className="mt-1.5 inline-flex rounded-full bg-[var(--color-accent-slate)]/15 px-2 py-0.5 text-xs text-[var(--color-accent-slate)]"
          >
            {candidate.technologyCount} CTL technolog
            {candidate.technologyCount === 1 ? "y" : "ies"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
