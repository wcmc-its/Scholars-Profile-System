"use client";

/**
 * CTL sponsor match — paste a commercial sponsor's description (an email or a
 * call transcript), rank WCM researchers on topical fit ALONE
 * (`docs/2026-07-09-ctl-technologies-handoff.md` §2). One POST to
 * `/api/edit/sponsor-match`; no stage axis, no ESI, no intake queue.
 *
 * Rows are a deliberately minimal cut of the Funding-matcher row (that markup
 * is not exported and carries stage/ESI/CSV machinery this surface rejects):
 * linked name → public profile, title/department, the paper-count evidence,
 * and a CTL-IP count badge when the researcher already holds licensable IP.
 * On top of that, the console carries:
 *  - per-row EVIDENCE — matched parent-topic chips and the top matching papers
 *    (PubMed-linked, with the BM25 relevance that drove the rank), so an
 *    officer sees WHY someone ranked;
 *  - client-side FACETS (department / matched topic / CTL-IP) over the long
 *    server list — narrowing never re-queries, and each row keeps its original
 *    rank number so "#7 overall" stays legible under a filter;
 *  - a search HISTORY in localStorage ONLY. Descriptions are commercially
 *    sensitive; the server never persists them (route contract), so history
 *    lives in the officer's own browser and nowhere else.
 */
import { useEffect, useMemo, useState } from "react";

import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Skeleton } from "@/components/ui/skeleton";
import { initials } from "@/lib/utils";

type TopicContribution = {
  topicId: string;
  contribution: number;
  pubCount: number;
  minYear: number | null;
};

type MatchedPaper = {
  pmid: string;
  title: string;
  year: number | null;
  journal: string | null;
  relevance: number;
};

type MatchedTopic = { topicId: string; label: string; pubCount: number };

/** One editable concept the spine engine extracted from the paste: a canonical term
 *  and its funder-centrality in [0,1]. Mirrors the server `SponsorConcept`; the
 *  console reweights `centrality` and posts the edited set back to re-rank. */
type SponsorConcept = { term: string; centrality: number };

type RankedResearcher = {
  cwid: string;
  slug: string;
  preferredName?: string;
  title?: string | null;
  department?: string | null;
  topicContributions: TopicContribution[];
  defaultScore: number;
  technologyCount?: number;
  topPapers?: MatchedPaper[];
  matchedTopics?: MatchedTopic[];
};

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; researchers: RankedResearcher[] }
  | { kind: "error"; message: string };

type HistoryEntry = { d: string; at: string };

const HISTORY_KEY = "sponsor-match-history";
const HISTORY_MAX = 20;

/** Topic facet stays scannable: top-N topics by researcher coverage. */
const TOPIC_FACET_MAX = 12;

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
  const [topicSel, setTopicSel] = useState<ReadonlySet<string>>(new Set());
  const [ctlOnly, setCtlOnly] = useState(false);
  // The editable concept set the spine returned + the description it was ranked
  // against. Editing a centrality and re-ranking re-POSTs THAT description with the
  // edited concepts (the server re-scores the same candidate universe, no new search).
  // Empty for the bespoke engine (no concept decomposition) ⇒ the editor stays hidden.
  const [concepts, setConcepts] = useState<SponsorConcept[]>([]);
  const [rankedDescription, setRankedDescription] = useState("");
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
    setTopicSel(new Set());
    setCtlOnly(false);
  }

  // `conceptsOverride` present ⇒ a re-rank of the SAME description with edited
  // centralities (no new extraction); absent ⇒ a fresh search that extracts concepts.
  async function runSearch(text: string, conceptsOverride?: SponsorConcept[]) {
    if (pending || text.trim().length === 0) return;
    setStatus({ kind: "loading" });
    // A fresh search re-extracts concepts, so drop any stale editor immediately; a
    // re-rank (conceptsOverride present) keeps its edited concepts visible and busy.
    if (!conceptsOverride) setConcepts([]);
    try {
      const r = await fetch("/api/edit/sponsor-match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(
          conceptsOverride ? { description: text, concepts: conceptsOverride } : { description: text },
        ),
      });
      if (r.ok) {
        const data = (await r.json()) as {
          researchers?: RankedResearcher[];
          concepts?: SponsorConcept[];
        };
        clearFilters(); // stale facet selections must not silently hide fresh results
        saveHistory(text.trim());
        // Reflect the concepts the server actually used (sanitized), so the sliders
        // stay in sync with what drove the ranking.
        setConcepts(data.concepts ?? []);
        setRankedDescription(text.trim());
        setStatus({ kind: "ok", researchers: data.researchers ?? [] });
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

  function updateCentrality(index: number, centrality: number) {
    setConcepts((prev) => prev.map((c, i) => (i === index ? { ...c, centrality } : c)));
  }

  const researchers = useMemo(
    () => (status.kind === "ok" ? status.researchers : []),
    [status],
  );

  const deptFacet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of researchers)
      if (r.department) counts.set(r.department, (counts.get(r.department) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [researchers]);

  const topicFacet = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const r of researchers)
      for (const t of r.matchedTopics ?? []) {
        const c = counts.get(t.topicId) ?? { label: t.label, count: 0 };
        c.count += 1;
        counts.set(t.topicId, c);
      }
    return [...counts].sort((a, b) => b[1].count - a[1].count).slice(0, TOPIC_FACET_MAX);
  }, [researchers]);

  const ctlHolderCount = useMemo(
    () => researchers.filter((r) => (r.technologyCount ?? 0) > 0).length,
    [researchers],
  );

  const hasFilters = deptSel.size > 0 || topicSel.size > 0 || ctlOnly;
  // Original rank travels with the row so a filtered view still reads
  // "this person is #7 overall", not "#1 of the filtered three".
  const visible = researchers
    .map((r, i) => ({ r, rank: i + 1 }))
    .filter(
      ({ r }) =>
        (deptSel.size === 0 || (r.department != null && deptSel.has(r.department))) &&
        (topicSel.size === 0 || (r.matchedTopics ?? []).some((t) => topicSel.has(t.topicId))) &&
        (!ctlOnly || (r.technologyCount ?? 0) > 0),
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

      {/* Concept editor lives OUTSIDE the status switch so a re-rank keeps the just-
          edited sliders on screen (with a live busy state) instead of flashing them away
          to the results skeleton — which also makes the button's pending affordance
          reachable. Hidden on error, matching the results area below. */}
      {concepts.length > 0 && status.kind !== "error" ? (
        <ConceptEditor
          concepts={concepts}
          onCentralityChange={updateCentrality}
          onRerank={() => void runSearch(rankedDescription, concepts)}
          pending={pending}
        />
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
          {researchers.length === 0 ? (
            <p className="text-muted-foreground py-4 text-sm">
              No researchers matched this description.
            </p>
          ) : (
            <>
            <div data-slot="sponsor-match-facets" className="border-border mb-4 rounded-lg border p-3">
              {deptFacet.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground mr-1 text-xs font-medium">Department</span>
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
              {topicFacet.length > 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground mr-1 text-xs font-medium">
                    Matched topic
                  </span>
                  {topicFacet.map(([id, t]) => (
                    <FacetChip
                      key={id}
                      active={topicSel.has(id)}
                      onClick={() => setTopicSel(toggled(topicSel, id))}
                    >
                      {t.label} · {t.count}
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
              {hasFilters ? `${visible.length} of ${researchers.length}` : researchers.length})
            </h2>
            {visible.length === 0 ? (
              <p className="text-muted-foreground py-4 text-sm">
                No researchers match the selected filters.
              </p>
            ) : (
              <ul className="mt-1">
                {visible.map(({ r, rank }) => (
                  <li key={r.cwid}>
                    <ResearcherRow r={r} rank={rank} />
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

/** The editable-centrality control: one range slider per extracted concept (0.05–1, step
 *  0.05 — the floor is 0.05, NOT 0, because the server's `sanitizeConcepts` rewrites any
 *  non-positive centrality to 0.3, so a 0 stop would silently snap back to 0.3 on
 *  re-rank; 0.05 is the smallest value that round-trips through the contract), a live mono
 *  value readout, and a Re-rank button. Editing a slider only mutates
 *  local state; Re-rank re-POSTs the same description with the edited centralities so the
 *  server re-scores the same candidate universe (no new extraction). Concept rows are NOT
 *  removable and keep their server order (most-central first) — the console reweights, it
 *  never drops a concept. Native `<input type=range>` with the panel's accent color keeps
 *  it accessible (labeled) and on-idiom (no custom slider). */
function ConceptEditor({
  concepts,
  onCentralityChange,
  onRerank,
  pending,
}: {
  concepts: SponsorConcept[];
  onCentralityChange: (index: number, centrality: number) => void;
  onRerank: () => void;
  pending: boolean;
}) {
  return (
    <div data-slot="sponsor-match-concepts" className="border-border mb-4 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Concepts</h2>
        <span className="text-muted-foreground text-xs">drag to reweight</span>
      </div>
      <p className="text-muted-foreground mt-1 mb-3 text-xs">
        How central each concept is to the sponsor&rsquo;s ask. Adjust the weights and
        re-rank — the same candidates are re-scored, no new search.
      </p>
      <ul className="space-y-3">
        {concepts.map((c, i) => (
          <li key={c.term} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{c.term}</span>
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {c.centrality.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={c.centrality}
              onChange={(e) => onCentralityChange(i, Number(e.target.value))}
              aria-label={`${c.term} centrality`}
              className="w-full accent-[var(--color-accent-slate)]"
            />
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onRerank}
        disabled={pending}
        className="mt-3 inline-flex h-9 items-center rounded-md bg-[var(--color-accent-slate)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Re-ranking…" : "Re-rank"}
      </button>
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

function ResearcherRow({ r, rank }: { r: RankedResearcher; rank: number }) {
  const name = r.preferredName ?? r.slug ?? r.cwid;
  // One synthetic topic, so the first contribution IS the whole evidence.
  const evidence = r.topicContributions[0];
  const techCount = r.technologyCount ?? 0;
  const topPapers = r.topPapers ?? [];
  const matchedTopics = r.matchedTopics ?? [];
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
            href={`/${encodeURIComponent(r.slug)}`}
            className="text-base font-semibold leading-snug text-foreground underline-offset-4 hover:underline"
          >
            {name}
          </a>
          {r.title ? <span className="text-muted-foreground text-sm">{r.title}</span> : null}
        </div>
        {r.department ? <div className="text-muted-foreground text-sm">{r.department}</div> : null}
        {evidence && evidence.pubCount > 0 ? (
          <p className="mt-1.5 text-sm text-foreground/90">
            {evidence.pubCount} matching paper{evidence.pubCount === 1 ? "" : "s"}
            {evidence.minYear ? ` since ${evidence.minYear}` : ""}
          </p>
        ) : null}
        {matchedTopics.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {matchedTopics.map((t) => (
              <span
                key={t.topicId}
                title={`${t.pubCount} matching paper${t.pubCount === 1 ? "" : "s"} in this topic`}
                className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-xs"
              >
                {t.label}
              </span>
            ))}
          </div>
        ) : null}
        {topPapers.length > 0 ? (
          <details className="mt-1.5">
            <summary className="text-muted-foreground cursor-pointer text-xs select-none">
              Why this match — top paper{topPapers.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-1 space-y-1">
              {topPapers.map((p) => (
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
                    {(p.year ? `${p.year} · ` : "") +
                      `${Math.round(p.relevance * 100)}% match`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {techCount > 0 ? (
          <span
            title="Licensable technologies this researcher already holds in the CTL portfolio."
            className="mt-1.5 inline-flex rounded-full bg-[var(--color-accent-slate)]/15 px-2 py-0.5 text-xs text-[var(--color-accent-slate)]"
          >
            {techCount} CTL technolog{techCount === 1 ? "y" : "ies"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
