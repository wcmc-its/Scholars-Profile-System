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
 *  - a search HISTORY that is now SERVER-SIDE and shared (#6d). It used to live in the
 *    officer's own localStorage, on the stated grounds that descriptions are commercially
 *    sensitive and the server never persisted them. That rule turned out to rest on nothing but
 *    the comment asserting it, and the cost of keeping it was high: the λ preference weighting
 *    cannot be tuned without REAL sponsor text, and a private per-browser list could not tell an
 *    officer that a colleague had already run this sponsor. Searches are now retained, the panel
 *    SAYS SO where they are listed, and any of them can be deleted — which erases the text for
 *    good, because the result cache deliberately holds none of it.
 *
 * VISUAL: skinned to `sponsor-match-scholars.html`, but to that mockup's INFORMATION design and
 * token values only — not its chrome. The mockup is drawn as the PUBLIC Scholars site (Cornell-red
 * header, serif title, a white card per candidate); this is an `/edit` console surface that sits
 * next to `/edit/find-researchers` under the Apollo bar, so it keeps the console's h1, its list
 * rows, and its two-column shell. The mockup's palette needed no translation: it was authored from
 * this app's own tokens (its `--accent #2C4F6E` IS `--color-accent-slate`, its shadow IS
 * `--apollo-shadow-card`), so the reskin adds no new CSS.
 *
 * TWO MOCKUP ELEMENTS ARE DELIBERATELY NOT BUILT, because the contract forbids them:
 *  - the fit METER (a bar of `fusedScore / topScore`) — that is the raw fused score, drawn. The
 *    score never reaches the DOM; the tier pill is the sanctioned abstraction for it.
 *  - the rarity badge's NUMBER and the word "common" — `weightFactor` is a claim about the
 *    RANKING and must not be shown, and "common" is unsayable because absent ≠ zero for the 40%
 *    of descriptors with no coverage row.
 * Career stage and clinician status HAVE a producer (#1654) and render as the mockup's two
 * remaining facet groups; each hides itself when no ranked row carries the measure, so an absent
 * signal still shows nothing rather than a lie.
 *
 * SPONSOR PREFERENCES (#1654) are the one thing here that touches the ranking rather than the
 * view. The route ships the non-topical asks it read out of the paste ("early-career
 * physician-scientists"); this panel feeds the active ones to the contract's `preferenceBoost`
 * and re-ranks live, on the same code path as a slider. They are a NUDGE, bounded by
 * `PREFERENCE_LAMBDA` — a preference can lift a near-miss over a marginally better topical
 * match, never a weak match over a strong one. Every detected ask is checked by default and can
 * be unchecked, because an extractor that reads an ask the sponsor never made must not be able
 * to skew a ranking with no way for the officer to say so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";

import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { EvidenceLine } from "@/components/search/evidence-line";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  conceptCoverage,
  fitTier,
  matchedConcepts,
  matchedEvidence,
  preferenceBoost,
  PREFERENCE_LAMBDA,
  rareTerms,
  rerankCandidates,
  sponsorAskFrom,
  type ConceptCoverage,
  type SponsorCandidate,
  type SponsorConcept,
  type SponsorFitTier,
  type SponsorMatchResponse,
  type SponsorPreference,
} from "@/lib/api/sponsor-match-contract";
import type { CareerStage } from "@/lib/career-stage";
import { buildSponsorMatchCsv } from "@/lib/edit/sponsor-match-export";
import { careerStageLabel, roleCategoryLabel } from "@/lib/match-display";
import { profilePath } from "@/lib/profile-url";
import { markPaste, markedConceptCount } from "@/lib/sponsor-paste-highlight";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

/** A retained search, as `GET /api/edit/sponsor-match` ships it (#6d). */
type Submission = {
  id: string;
  description: string;
  title: string | null;
  engine: string;
  candidateCount: number;
  submittedBy: string;
  createdAt: string;
};

/** Facet groups stay scannable: top-N by researcher coverage. As a vertical checkbox panel
 *  (rather than the old wrapping chip row) an uncapped department list runs to ~20 rows on a
 *  broad paste and swamps the rail — and the tail is all count-1 departments, which are the
 *  least useful thing to filter by. Both groups cap the same way. */
const CONCEPT_FACET_MAX = 12;
const DEPT_FACET_MAX = 12;

/** A RENDER cap, and nothing else. It is applied to the FILTERED rows (see `visible`), so it
 *  bounds how many rows we mount — never which candidates a filter or a facet can see.
 *
 *  It used to sit inside `ranked`, which silently made it all three: every facet counted, and
 *  every filter searched, only the top 100 of a pool that runs to ~800. "Holds CTL technology:
 *  9" meant 9 of the top 100, not 9 of the pool, and a CTL holder at rank 101 was unreachable
 *  by the one filter this console exists for. Facet over the pool; cap what you paint. */
const RESULT_MAX = 100;

/** Three numbers, and they are three DIFFERENT things: how many rows we painted, how many the
 *  filters matched, how many are in the pool. The old header printed two of them as if they
 *  were one ("100 of 100 researchers", while the history row beside it said 430). Say all
 *  three, or say the one that is true. */
export function resultsSummary(shown: number, matched: number, pool: number): string {
  const head = shown < matched ? `Top ${shown} of ${matched}` : `${matched}`;
  if (matched < pool) return `${head} matching · ${pool} ranked`;
  return `${head} researcher${matched === 1 ? "" : "s"}`;
}

/** Coverage 7.17e-4 → "about 1 in 1,400 papers". Reads better than a fraction in a tooltip. */
function oneInN(coverage: number): string {
  return `about 1 in ${Math.round(1 / coverage).toLocaleString()} Weill Cornell papers`;
}

const TIER_LABEL: Record<SponsorFitTier, string> = {
  strong: "Strong fit",
  good: "Good fit",
  weak: "Weak fit",
};

/** Mockup's tier palette, which reads better than the old all-slate ramp: green / amber / grey.
 *  Every hex already exists as a house token — nothing new is introduced. */
const TIER_CLASS: Record<SponsorFitTier, string> = {
  strong:
    "border-[var(--apollo-green)]/25 bg-[var(--apollo-green)]/10 text-[var(--apollo-green)]",
  good: "border-[var(--color-facet-position-count)]/25 bg-[var(--color-facet-position-fill)] text-[var(--color-facet-position-count)]",
  weak: "border-border text-muted-foreground bg-transparent",
};

/** Sort is presentation only — it reorders the rows, it never changes a rank. The mockup's
 *  `Seniority` option is now producible (#1654) but deliberately not added here: the two
 *  shipped sorts answer "who fits" and "find a name", and a seniority SORT would bury the
 *  best match under the most senior one. Career stage is a FILTER instead — it narrows the
 *  pool without reordering fit. */
const SORT_TABS = [
  { key: "fit", label: "Fit" },
  { key: "name", label: "Name" },
] as const;
type SortKey = (typeof SORT_TABS)[number]["key"];

/** Facet order is the career ladder, not a count ranking — a stage list that reordered itself
 *  per search would be unreadable. */
const CAREER_STAGE_ORDER: readonly CareerStage[] = ["grad", "postdoc", "early", "mid", "senior"];

function toggled(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** Client-side download — the matcher is admin-only and the whole pool is already in the
 *  browser, so a server hop would only be able to re-export the DEFAULT ranking, not the
 *  re-ranked one the officer is actually looking at. Mirrors `find-researchers.tsx`. */
function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SponsorMatchPanel() {
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [history, setHistory] = useState<Submission[]>([]);
  const [deptSel, setDeptSel] = useState<ReadonlySet<string>>(new Set());
  const [conceptSel, setConceptSel] = useState<ReadonlySet<string>>(new Set());
  const [ctlOnly, setCtlOnly] = useState(false);
  // #1654 — selection is keyed by the DISPLAY label (what FacetGroup renders and toggles),
  // so the filter compares labels too. One vocabulary, no id↔label map to drift.
  const [stageSel, setStageSel] = useState<ReadonlySet<string>>(new Set());
  const [clinicianOnly, setClinicianOnly] = useState(false);
  const [roleSel, setRoleSel] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<SortKey>("fit");
  // The two halves of the contract payload. `candidates` is fetched ONCE per search and
  // never refetched by a slider; `concepts` is the editable rail. Everything below is
  // derived from them.
  const [candidates, setCandidates] = useState<SponsorCandidate[]>([]);
  const [concepts, setConcepts] = useState<SponsorConcept[]>([]);
  // #1654 — the sponsor's non-topical asks, and which of them the officer is honouring.
  // Keyed by label: an extractor that fires twice on the same ask would emit one entry.
  const [preferences, setPreferences] = useState<SponsorPreference[]>([]);
  const [activePrefs, setActivePrefs] = useState<ReadonlySet<string>>(new Set());
  // #6a — the text THAT WAS SEARCHED, snapshotted at submit. Not `description`: the textarea
  // stays mounted and editable while results are on screen, so highlighting the live value
  // would mark words that never produced these concepts (and, after a history replay, a
  // different paste entirely).
  const [matchedText, setMatchedText] = useState("");
  // #1696 — THE RANKING RUN'S IDENTITY. Bumped once per successful search, and threaded down to
  // each row as the reset key for its per-card `claimedPmids` set + its evidence-block keys.
  //
  // A COUNTER, not `matchedText`. The rows are keyed by cwid (`<li key={c.cwid}>`), so a scholar
  // who appears in two consecutive runs keeps the SAME mounted `ResearcherRow` — the run key is
  // the only thing that tells that row a new run happened. Re-running the IDENTICAL paste (the
  // history list's replay button does exactly this) is still a new run whose blocks must re-fetch
  // from a clean slate, and `matchedText` cannot see that: it would be unchanged.
  const [runId, setRunId] = useState(0);
  const pending = status.kind === "loading";

  // #6d — the retained searches, from the SERVER. This REPLACES the old localStorage history
  // outright rather than sitting beside it: the server list does everything the private one did
  // (read back a past paste, re-run it) and adds the two things it could not — a colleague's
  // searches, and a delete that actually erases the sponsor's words rather than clearing one
  // browser. Two histories would have been two sources of truth for the same question.
  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/edit/sponsor-match", { credentials: "same-origin" });
      if (!r.ok) return; // a failed history load must never disturb the matcher
      const data = (await r.json()) as { submissions?: Submission[] };
      setHistory(data.submissions ?? []);
    } catch {
      /* offline / transient — the list is a convenience, not the product. */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function deleteSubmission(id: string) {
    try {
      const r = await fetch("/api/edit/sponsor-match", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ submissionId: id }),
      });
      if (r.ok) setHistory((prev) => prev.filter((h) => h.id !== id));
    } catch {
      /* ignore — the row stays listed, and the next load will show the truth. */
    }
  }

  function clearFilters() {
    setDeptSel(new Set());
    setConceptSel(new Set());
    setCtlOnly(false);
    setStageSel(new Set());
    setClinicianOnly(false);
    setRoleSel(new Set());
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
        // Typed as the CONTRACT's response, not an anonymous shape. The contract's headline
        // promise is that a drift between ranker and panel is a compile error; an inline
        // `{candidates?; concepts?}` opted the envelope out of exactly that.
        const data = (await r.json()) as Partial<SponsorMatchResponse>;
        clearFilters(); // stale facet selections must not silently hide fresh results
        void loadHistory(); // the row the server just retained
        setCandidates(data.candidates ?? []);
        setConcepts(data.concepts ?? []);
        setMatchedText(text);
        setRunId((n) => n + 1); // #1696 — a new run: every row's claimed-pmid set starts empty
        // #1654 — detected preferences arrive ACTIVE. The sponsor said it; the default is to
        // honour it. Deselecting is the officer's override, not their opt-in.
        const prefs = data.preferences ?? [];
        setPreferences(prefs);
        setActivePrefs(new Set(prefs.map((p) => p.label)));
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
  // #1654 — the preference nudge rides the SAME live re-rank. Only the preferences the
  // officer left active count, so unchecking one re-ranks instantly, exactly like a slider.
  // `preferenceBoost` is the contract's reference predicate, not a local copy: the ranking
  // eval scores through the same function, so what we measure is what an officer sees.
  const activePreferences = useMemo(
    () => preferences.filter((p) => activePrefs.has(p.label)),
    [preferences, activePrefs],
  );

  const ranked = useMemo(
    () =>
      rerankCandidates(
        candidates,
        concepts,
        activePreferences.length > 0
          ? {
              prefBoost: (c) => preferenceBoost(c, activePreferences),
              lambda: PREFERENCE_LAMBDA,
            }
          : {},
      ),
    [candidates, concepts, activePreferences],
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

  // The search's handle. DERIVED HERE, not taken from `response.ask`, for the same reason the
  // ranking is: the officer can DESELECT a preference the extractor got wrong, and a title
  // frozen at submit would go on asserting "· Early career" after they had said the sponsor
  // never asked for that — the header contradicting the ranking directly beneath it. The
  // server still ships `ask` (it is the canonical handle for a caller that does not re-rank),
  // but the console owns what it displays, exactly as it owns the preference predicate.
  const ask = useMemo(
    () => sponsorAskFrom(concepts, preferences.filter((p) => activePrefs.has(p.label))),
    [concepts, preferences, activePrefs],
  );

  const deptFacet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of ranked)
      if (c.department) counts.set(c.department, (counts.get(c.department) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, DEPT_FACET_MAX);
  }, [ranked]);

  // Facet over the concepts people actually MATCHED (their contributions), not the whole
  // rail — a concept nobody ranked under is not a useful filter. Counts are over the full
  // re-ranked pool, pre-filter — `ranked` is the whole pool now, which is what makes that
  // sentence true. It was written when it was not.
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

  // #1654 — the mockup's two remaining groups, now that `measures` has a producer. Both
  // count only rows that actually CARRY the measure: a candidate with no Scholar row is
  // absent from the facet rather than silently counted as "not a clinician" / unstaged.
  const stageFacet = useMemo(() => {
    const counts = new Map<CareerStage, number>();
    for (const c of ranked) {
      const s = c.measures?.careerStage;
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return CAREER_STAGE_ORDER.filter((s) => counts.has(s)).map(
      (s) => [careerStageLabel(s), counts.get(s)!] as const,
    );
  }, [ranked]);

  const clinicianCount = useMemo(
    () => ranked.filter((c) => c.measures?.isClinician === true).length,
    [ranked],
  );

  // Person type. Same discipline as the two above: only rows that CARRY a role are counted, so
  // a candidate with no Scholar row is absent from the facet rather than invented into one.
  // Ordered by count — unlike career stage there is no natural ladder to preserve.
  const roleFacet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of ranked) {
      const label = roleCategoryLabel(c.measures?.roleCategory);
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [ranked]);

  const hasFilters =
    deptSel.size > 0 ||
    conceptSel.size > 0 ||
    ctlOnly ||
    stageSel.size > 0 ||
    clinicianOnly ||
    roleSel.size > 0;

  // Live rank travels with the row, so a filtered view still reads "this person is #7 overall",
  // not "#1 of the filtered three". It re-derives as sliders move. Ranks are POOL ranks — a
  // CTL-filtered view can legitimately read #137, because the filter now searches the pool.
  //
  // The rank is stamped from the FIT order and then carried, never recomputed — so sorting by
  // Name reorders the rows while each row keeps the rank it holds in the ranking. A sort that
  // renumbered rows would be claiming Alice is the best match because her name comes first.
  //
  // Uncapped, and deliberately: this is every candidate that matches the filters, and it is
  // what the CSV exports. `visible` below is the same list with the render cap applied.
  const filtered = useMemo(
    () =>
      ranked
        .map((c, i) => ({ c, rank: i + 1 }))
        .filter(
          ({ c }) =>
            (deptSel.size === 0 || (c.department != null && deptSel.has(c.department))) &&
            (conceptSel.size === 0 || c.contributions.some((x) => conceptSel.has(x.term))) &&
            (!ctlOnly || c.technologyCount > 0) &&
            // A row with no measure fails a measure filter — it cannot be shown to satisfy a
            // constraint we have no evidence it meets.
            (stageSel.size === 0 ||
              (c.measures?.careerStage != null &&
                stageSel.has(careerStageLabel(c.measures.careerStage)))) &&
            (!clinicianOnly || c.measures?.isClinician === true) &&
            (roleSel.size === 0 || roleSel.has(roleCategoryLabel(c.measures?.roleCategory))),
        ),
    [ranked, deptSel, conceptSel, ctlOnly, stageSel, clinicianOnly, roleSel],
  );

  // The cap lands on the FIT-ordered rows, then Name reorders that hundred. Slicing after the
  // name sort would paint the alphabetically-first 100 and call them the best matches.
  const visible = useMemo(() => {
    const rows = filtered.slice(0, RESULT_MAX);
    return sort === "name"
      ? [...rows].sort((a, b) => a.c.name.localeCompare(b.c.name))
      : rows;
  }, [filtered, sort]);

  /** Exports every row the filters matched — current sliders, current filters — NOT just the
   *  hundred we painted. An officer who filters to the CTL portfolio and gets 180 hits must
   *  download 180, not the first 100 with no warning that the rest exist. A server route could
   *  not do this at all: it would re-run the match and emit the DEFAULT ranking, not the one
   *  the officer re-weighted. */
  function exportFiltered() {
    const csv = buildSponsorMatchCsv(
      filtered.map(({ c, rank }) => ({
        rank,
        cwid: c.cwid,
        name: c.name,
        title: c.title,
        department: c.department,
        fit: TIER_LABEL[fitTier(c.fusedScore, topScore)],
        matchedConcepts: matchedConcepts(c, concepts).map((m) => m.concept.term),
        // Blank = the measure is absent, never "no stage" / "not a clinician" (#1654).
        careerStage: c.measures?.careerStage ? careerStageLabel(c.measures.careerStage) : "",
        clinician:
          c.measures?.isClinician === undefined ? "" : c.measures.isClinician ? "Yes" : "No",
        personType: roleCategoryLabel(c.measures?.roleCategory),
        technologyCount: c.technologyCount,
        profileUrl: new URL(
          profilePath(c.profileSlug),
          window.location.origin,
        ).toString(),
      })),
    );
    downloadCsv("sponsor-match-researchers.csv", csv);
  }

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
        {/* Slate, not `variant="apollo"` (maroon) — the whole matcher family (find-researchers,
            opportunity intake, and the mockup) is slate. */}
        <Button
          type="submit"
          disabled={pending || description.trim().length === 0}
          className="mt-2 bg-[var(--color-accent-slate)] text-white hover:bg-[var(--color-accent-slate)]/90"
        >
          {pending ? "Ranking…" : "Rank researchers"}
        </Button>
      </form>

      {history.length > 0 ? (
        <details data-slot="sponsor-match-history" className="mb-6">
          <summary className="text-muted-foreground cursor-pointer text-sm select-none">
            Recent searches ({history.length})
          </summary>
          {/* Say it plainly, on the surface where it happens. Searches are kept, they are kept
              for a stated reason, everyone here can see them, and anyone here can erase one.
              A retention notice buried in a policy page nobody opens is not a notice. */}
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
            Searches are saved — including the description you pasted — so we can measure and
            improve match quality against real sponsor text. Everyone with access to this console
            can see them. Delete any search to remove its text for good.
          </p>
          <ul className="mt-3 space-y-1">
            {history.map((h) => (
              <li key={h.id} className="flex items-baseline gap-2">
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {new Date(h.createdAt).toLocaleDateString()}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">{h.submittedBy}</span>
                <button
                  type="button"
                  title={h.description}
                  onClick={() => {
                    setDescription(h.description);
                    void runSearch(h.description);
                  }}
                  className="min-w-0 flex-1 truncate text-left text-sm text-foreground/90 underline-offset-4 hover:underline"
                >
                  {h.title ?? h.description}
                </button>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {h.candidateCount}
                </span>
                <button
                  type="button"
                  aria-label={`Delete search: ${h.title ?? h.description.slice(0, 60)}`}
                  onClick={() => void deleteSubmission(h.id)}
                  className="text-muted-foreground shrink-0 text-xs underline-offset-4 hover:underline"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
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
          {ask ? (
            <h2 data-slot="sponsor-match-ask" className="pt-4 text-base font-semibold">
              {ask.title}
            </h2>
          ) : null}
          {concepts.length > 0 && matchedText.length > 0 ? (
            <PasteReadback text={matchedText} concepts={concepts} />
          ) : null}
          {ranked.length === 0 ? (
            <p className="text-muted-foreground py-4 text-sm">
              No researchers matched this description.
            </p>
          ) : (
            /* Two-column shell, matching the mockup's rail + results split and
               `/edit/find-researchers`'s idiom. lg:w-80 (not find-researchers' w-64) because
               this rail carries sliders and member chips. */
            <div className="flex flex-col gap-x-8 gap-y-6 lg:flex-row">
              <aside className="w-full shrink-0 space-y-4 lg:w-80">
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

                {/* #1654 — the sponsor's non-topical asks. Sits ABOVE Filter, and apart from it,
                    because it is not a filter: it reweights the ranking (nothing is hidden), and
                    that is a different promise to the officer. Each is checked by default — the
                    sponsor said it — and unchecking re-ranks live, which is the escape hatch when
                    the extractor reads an ask that was never there. */}
                {preferences.length > 0 ? (
                  <div
                    data-slot="sponsor-match-preferences"
                    className="border-border mb-3 rounded-lg border p-3"
                  >
                    <h2 className="text-base font-semibold">Sponsor preferences</h2>
                    <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                      Detected in the paste. These nudge the ranking; they never filter anyone out.
                    </p>
                    <ul className="mt-2 space-y-2">
                      {preferences.map((p) => (
                        <li key={p.label}>
                          <label className="flex cursor-pointer items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="mt-[3px] size-3.5 shrink-0 accent-[var(--color-accent-slate)]"
                              checked={activePrefs.has(p.label)}
                              onChange={() => setActivePrefs(toggled(activePrefs, p.label))}
                            />
                            <span className="min-w-0">
                              <span className="font-medium">{p.label}</span>
                              <span className="text-muted-foreground block text-xs italic leading-snug">
                                from paste: &ldquo;{p.evidence}&rdquo;
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* The mockup's five groups. `Career stage` and `Clinician` were held back until
                    `measures` had a producer (#1654) — a filter that cannot filter is worse than
                    no filter. Both now render only when at least one ranked row carries the
                    measure, so they still disappear rather than lie. */}
                <div
                  data-slot="sponsor-match-facets"
                  className="border-border rounded-lg border p-3"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="text-base font-semibold">Filter</h2>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {ranked.length} → {filtered.length}
                    </span>
                  </div>

                  {deptFacet.length > 0 ? (
                    <FacetGroup
                      label="Department"
                      options={deptFacet}
                      selected={deptSel}
                      onToggle={(v) => setDeptSel(toggled(deptSel, v))}
                    />
                  ) : null}
                  {conceptFacet.length > 0 ? (
                    <FacetGroup
                      label="Matched concept"
                      options={conceptFacet}
                      selected={conceptSel}
                      onToggle={(v) => setConceptSel(toggled(conceptSel, v))}
                    />
                  ) : null}
                  {stageFacet.length > 0 ? (
                    <FacetGroup
                      label="Career stage"
                      options={stageFacet}
                      selected={stageSel}
                      onToggle={(v) => setStageSel(toggled(stageSel, v))}
                      title="Years since terminal degree, bucketed — the same derivation the funding matcher ranks on."
                    />
                  ) : null}
                  {roleFacet.length > 0 ? (
                    <FacetGroup
                      label="Person type"
                      options={roleFacet}
                      selected={roleSel}
                      onToggle={(v) => setRoleSel(toggled(roleSel, v))}
                      title="The Enterprise Directory's person type — faculty, postdoc, doctoral student, and so on."
                    />
                  ) : null}
                  {clinicianCount > 0 ? (
                    <FacetGroup
                      label="Clinician"
                      options={[["Practicing clinician", clinicianCount]]}
                      selected={clinicianOnly ? new Set(["Practicing clinician"]) : new Set()}
                      onToggle={() => setClinicianOnly(!clinicianOnly)}
                      title="Carries a clinical or NYP-credentialed signal in the Enterprise Directory."
                    />
                  ) : null}
                  <FacetGroup
                    label="CTL portfolio"
                    options={[["Holds CTL technology", ctlHolderCount]]}
                    selected={ctlOnly ? new Set(["Holds CTL technology"]) : new Set()}
                    onToggle={() => setCtlOnly(!ctlOnly)}
                    title="Only researchers who already hold licensable technology in the CTL portfolio."
                  />

                  <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                    Any within a group · all across groups. Filtering keeps each row&rsquo;s
                    original rank.
                  </p>
                  {hasFilters ? (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="text-muted-foreground mt-2 text-xs underline-offset-4 hover:underline"
                    >
                      Clear filters
                    </button>
                  ) : null}
                </div>
              </aside>

              <main className="min-w-0 flex-1">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <h2 className="text-base font-semibold">
                    {resultsSummary(visible.length, filtered.length, ranked.length)}
                  </h2>
                  <div className="ml-auto flex items-center gap-2">
                    <div
                      role="group"
                      aria-label="Sort researchers"
                      className="flex items-center gap-1"
                    >
                      {SORT_TABS.map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          aria-pressed={sort === t.key}
                          onClick={() => setSort(t.key)}
                          className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                            sort === t.key
                              ? "border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
                              : "border-border text-foreground/80 hover:border-[var(--color-accent-slate)]"
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={exportFiltered}
                      disabled={filtered.length === 0}
                    >
                      <Download className="size-3.5" />
                      Export ({filtered.length})
                    </Button>
                  </div>
                </div>

                {visible.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-sm">
                    No researchers match the selected filters.
                  </p>
                ) : (
                  <ul>
                    {visible.map(({ c, rank }) => (
                      <li key={c.cwid}>
                        <ResearcherRow
                          candidate={c}
                          rank={rank}
                          concepts={concepts}
                          topScore={topScore}
                          runId={runId}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </main>
            </div>
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
    <div data-slot="sponsor-match-concepts" className="border-border rounded-lg border p-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {/* The mockup's caption here read "Rarity (fixed) rewards experts in areas few at WCM
          cover." That is now FALSE and must not ship: rarity is a bounded ±15% tiebreaker, and
          centrality is what drives the ranking (see the IDF-inversion finding). Describing the
          slider is also more useful than describing a multiplicand nobody can edit. */}
      <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
        How central each concept is to the ask. Drag to reweight — the ranking updates live, with
        no new search.
      </p>
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
                    className="ml-1.5 rounded-full bg-[var(--color-facet-method-fill)] px-1.5 py-0.5 text-xs text-[var(--color-facet-method-count)]"
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

/**
 * One checkbox facet group — the mockup's `.facet` shape.
 *
 * Local to this file rather than reusing `RosterFacet` (center-roster / data-quality) on purpose:
 * that component hardcodes the PUBLIC Cornell-red accent, and re-theming it to slate would bleed
 * into the two surfaces that already depend on it. `find-researchers` sets the same precedent of
 * keeping its facet UI local.
 *
 * Counts are over the currently-ranked rows, so a count is exactly how many rows selecting it
 * will leave you with — not a number from a pool you cannot see. They move as sliders move,
 * which is correct: the ranking moved.
 */
/**
 * #6a — the paste, read back with each extracted concept marked where it literally occurs.
 *
 * This is the decomposition's audit trail: it lets an officer see that the matcher read
 * "our CAR-T program" as *chimeric antigen receptor T-cell therapy* — and, more usefully,
 * catch it when it read something as a concept that was never the point.
 *
 * IT IS A LOWER BOUND, AND IT SAYS SO. The extractor canonicalises ("CF" → "cystic fibrosis"),
 * so a concept whose canonical form never appears in the paste cannot be anchored to any span
 * (`lib/sponsor-paste-highlight.ts` documents why). Rather than let the officer read an unmarked
 * paragraph as "the matcher ignored this", the count is stated plainly. Absent ≠ ignored — the
 * same rule the rest of this contract keeps.
 *
 * Collapsed by default: it repeats text the officer just pasted, and the results are the point.
 * It is a <details> over a <div>, not the <textarea> — a textarea cannot contain a <mark>.
 */
function PasteReadback({ text, concepts }: { text: string; concepts: SponsorConcept[] }) {
  const segments = useMemo(() => markPaste(text, concepts), [text, concepts]);
  const marked = useMemo(() => markedConceptCount(segments), [segments]);

  return (
    <details data-slot="sponsor-match-readback" className="mt-3">
      <summary className="text-muted-foreground cursor-pointer text-xs underline-offset-4 hover:underline">
        What we read from the description
      </summary>
      <div className="border-border mt-2 rounded-lg border p-3">
        {/* `break-words`: a sponsor email routinely carries an Outlook SafeLinks URL — 300+
            characters with no break opportunity in it. `pre-wrap` alone honours existing break
            points but introduces none, so such a token would run straight out of the column. */}
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
          {segments.map((s, i) =>
            s.term ? (
              <mark
                key={i}
                title={s.term}
                className="rounded bg-[var(--color-accent-slate)]/15 px-0.5 text-inherit"
              >
                {s.text}
              </mark>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
        </p>
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
          {`${marked} of ${concepts.length} ${
            concepts.length === 1 ? "concept is" : "concepts are"
          } highlighted above. A concept goes unhighlighted when it could not be pointed at a span — most often because the matcher wrote it in standard terms that do not appear verbatim here (an abbreviation expanded, a brand name resolved), and sometimes because a longer concept already claimed the same words. Unhighlighted never means ignored: every concept below was extracted and every one of them ranks.`}
        </p>
      </div>
    </details>
  );
}

function FacetGroup({
  label,
  options,
  selected,
  onToggle,
  title,
}: {
  label: string;
  options: readonly (readonly [string, number])[];
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  title?: string;
}) {
  return (
    <div className="mt-3">
      <h3 className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </h3>
      <ul className="mt-1.5 space-y-1">
        {options.map(([value, n]) => (
          <li key={value}>
            <label
              title={title}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                checked={selected.has(value)}
                onChange={() => onToggle(value)}
                className="size-3.5 shrink-0 accent-[var(--color-accent-slate)]"
              />
              <span className="min-w-0 flex-1 truncate">{value}</span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{n}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * ONE scholar's email, resolved on click.
 *
 * SCOPE, and it is the whole design: this is the per-card `Contact` of the mockup and NOTHING
 * else. The mockup also draws `Contact selected` + a compose modal — bulk email over the result
 * set — and that is a standing policy no-go, not a deferral: `docs/email-visibility-spec.md`
 * forbids bulk email download "even for internal users" at a cap of 50, and a sponsor pool runs
 * to 800. Per-person is a different act with a different consent story, and it is the one the
 * route below is built for.
 *
 * NO ADDRESS EVER ENTERS THE MATCH PAYLOAD. `/api/profile/[cwid]/contact-email` is a separate,
 * `no-store`, per-person directory lookup that fails CLOSED — release gate off, external viewer,
 * or an unreleased `email_visibility` all return `{ email: null }`. So the officer's own session
 * is what authorises the reveal, one colleague at a time, and the ranking contract stays free of
 * PII (`sponsor-match-contract.ts` keeps it out on purpose).
 *
 * FETCH ON CLICK, NOT ON RENDER, and this is load-bearing rather than tidy: a paste ranks up to
 * ~341 candidates, so resolving eagerly would fire ~341 uncached directory lookups per search to
 * populate a button almost none of them will press. The `tests/unit/sponsor-match-contact.test.tsx`
 * case that asserts ZERO fetches at render is guarding exactly that, and it fails if anyone moves
 * this into a `useEffect`.
 *
 * ponytail: `mailto:` — the officer's own mail client composes, which is why there is no compose
 * modal to build, no Cc/Bcc/Send to get wrong, and no address for us to store.
 */
function ContactButton({ cwid }: { cwid: string }) {
  const [state, setState] = useState<"idle" | "loading" | "none">("idle");

  // Absent ≠ zero, applied to an address: "we could not release an email" is not "this person has
  // none", so the copy says what actually happened rather than asserting a fact about the scholar.
  if (state === "none") {
    return (
      <span className="text-muted-foreground shrink-0 text-xs">No email released</span>
    );
  }

  return (
    <button
      type="button"
      disabled={state === "loading"}
      onClick={() => {
        setState("loading");
        fetch(`/api/profile/${encodeURIComponent(cwid)}/contact-email`)
          .then((r) => (r.ok ? r.json() : { email: null }))
          .then((d: { email?: string | null }) => {
            if (d?.email) {
              window.location.href = `mailto:${d.email}`;
              setState("idle");
            } else {
              setState("none");
            }
          })
          .catch(() => setState("none"));
      }}
      className="border-border text-foreground/80 shrink-0 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:border-[var(--color-accent-slate)] disabled:opacity-50"
    >
      {state === "loading" ? "Resolving…" : "Contact"}
    </button>
  );
}

/**
 * True once the node has been on screen, and true forever after — the papers it triggers do not
 * become unfetched when you scroll past. Same shape as the observer in
 * `people-result-card-streamed.tsx`, which arms the same endpoint on the same signal.
 *
 * With no `IntersectionObserver` (jsdom, and any browser old enough to lack it) it reports IN view
 * rather than out. Degrade toward FETCHING: the failure mode of guessing "visible" is some extra
 * requests, and the failure mode of guessing "hidden" is a card that never shows its evidence and
 * looks, silently, like a scholar with nothing to say.
 */
function useInViewOnce<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      // Resolve just before the row arrives, so the artifact is there when the eye is.
      { rootMargin: "200px" },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [inView]);
  return [ref, inView];
}

/** The three fills. `ranked` is the same hue as `evidence` because the person genuinely ranked
 *  under that concept — but it is a SEPARATE state, not a lighter grade of found, and its title
 *  says so. The distinction the officer needs is "we have nothing for this" (`none`) versus
 *  "we have something and are not showing it here" (`ranked`), and a ramp would erase it. */
const COVERAGE_CLASS: Record<ConceptCoverage["state"], string> = {
  evidence: "bg-[var(--color-accent-slate)]",
  ranked: "bg-[var(--color-accent-slate)]/30",
  none: "bg-muted",
};

const COVERAGE_TITLE: Record<ConceptCoverage["state"], string> = {
  evidence: "evidence below",
  // Deliberately not "partial evidence" — see `conceptCoverage`. The cap is at default weights,
  // so this state is reachable by dragging a slider, and it must not read as a weaker match.
  ranked: "ranked under this, evidence not shown",
  none: "no evidence",
};

/**
 * The ask, drawn as a bar: one segment per concept the sponsor asked for, width = how much they
 * asked for it. The width IS `conceptWeight` — the very number the fusion ranks on — so the bar
 * cannot drift from the ranking, and it re-draws live as the sliders move, exactly like the chips.
 *
 * The mockup's hover-to-trace (segment lights up its term row) is skipped: `title` is a native
 * tooltip for free, and cross-highlighting needs hover state threaded through every block for a
 * cue the tooltip already gives. Add it when someone asks for it.
 *
 * The strip is `aria-hidden` and the line beneath it carries the same facts as text — a bar of
 * eight divs is not a thing a screen reader can be made to say usefully, and the coverage
 * sentence is what a reader would want read out anyway.
 */
function CoverageStrip({ coverage }: { coverage: ConceptCoverage[] }) {
  if (coverage.length === 0) return null;
  const covered = coverage.filter((c) => c.state !== "none");
  const gaps = coverage.filter((c) => c.state === "none");
  return (
    <div className="mt-2" data-slot="sponsor-match-coverage">
      <div className="flex gap-0.5" aria-hidden="true">
        {coverage.map(({ concept, weight, state }) => (
          <div
            key={concept.term}
            title={`${concept.term} — ${COVERAGE_TITLE[state]}`}
            // `flexBasis: 0` so the widths are the weights and nothing else; the min-width keeps a
            // near-muted concept from collapsing to an invisible sliver you cannot hover.
            style={{ flexGrow: weight, flexBasis: 0 }}
            className={`h-2 min-w-[3px] rounded-[2px] ${COVERAGE_CLASS[state]}`}
          />
        ))}
      </div>
      <p className="text-muted-foreground mt-1.5 text-xs">
        Covers {covered.length} of {coverage.length} concepts asked
        {gaps.length > 0 ? (
          <> · no evidence for {gaps.map((g) => g.concept.term).join(", ")}</>
        ) : null}
      </p>
    </div>
  );
}

function ResearcherRow({
  candidate,
  rank,
  concepts,
  topScore,
  runId,
}: {
  candidate: SponsorCandidate;
  rank: number;
  concepts: SponsorConcept[];
  topScore: number;
  /** #1696 — the current ranking run. See `claimedPmids` below: this row can OUTLIVE a run. */
  runId: number;
}) {
  const name = candidate.name;
  // Chips + tier are DERIVED, never wired — so both stay live under the sliders. The raw
  // fused score is never rendered: it is an RRF sum and means nothing on its own.
  const matched = matchedConcepts(candidate, concepts);
  // The whole ask, not just the part this person answered — the only thing on the card that can
  // say what they DON'T have. Derived from the same props as the chips, so it moves with them.
  const coverage = conceptCoverage(candidate, concepts);
  const tier = fitTier(candidate.fusedScore, topScore);
  const papers = candidate.evidence?.papers ?? [];
  const topics = candidate.evidence?.topics ?? [];
  // #1696 — one evidence block per concept this candidate matched, joined to the chips above by
  // `term` and ordered the same way, because it IS the same list: `matchedEvidence` derives from
  // `matchedConcepts`. Mute a concept and its chip and its evidence block disappear together —
  // a block still captioned "Fibrosis" under a slider dragged to zero would be the card
  // contradicting the ranking beside it.
  const evidenceBlocks = matchedEvidence(candidate, concepts);
  /**
   * #1689 — `EvidenceLine` de-dups representative papers across a card's lines through this
   * shared set, and since #1696 that de-dup is doing real work: the card now renders one line PER
   * CONCEPT, and a paper a scholar wrote about two of them would otherwise be offered as the
   * representative for both. Whichever line's lazy fetch resolves first claims it; the loser sends
   * the claimed pmids as `exclude=` and surfaces its own next-best paper instead.
   *
   * THE SET'S LIFETIME IS THE PROBLEM, and `[]` was the wrong answer. `EvidenceLine` only ever
   * ADDS to this set — it has no release-on-unmount — so a claim outlives the line that made it.
   * Mute a concept and its block unmounts with its pmids still claimed; unmute it and the block
   * remounts, re-fetches (a fresh line, so its one-shot `keyPaperFetched` ref is clean) and
   * EXCLUDES THE VERY PAPER IT ITSELF SHOWED A MOMENT AGO. The officer sees the disclosure come
   * back with a worse paper — or empty, so the chevron silently vanishes while the count line
   * beside it still reads "142 of 210 publications tagged". Reproduced, not theorised.
   *
   * So the set is keyed to WHAT IS ACTUALLY ON SCREEN: the current run, and the current block
   * list. Both are needed and neither is redundant:
   *   - `runId` — a new ranking run. (Belt-and-braces today: the panel swaps the whole results
   *     tree for skeletons while `status.kind === "loading"`, so these rows already unmount
   *     between runs and the set is rebuilt regardless. That unmount is INCIDENTAL — a future
   *     "don't flash skeletons on re-rank" change would remove it and silently reintroduce the
   *     leak across runs. Keying on the run makes the reset a property of this component instead
   *     of a side effect of a conditional 500 lines away.)
   *   - `blockTerms` — the set of blocks currently rendered. THIS is the one that fires today: it
   *     changes on exactly the mute/unmute above, and on nothing else. A slider dragged 0.9 → 0.5
   *     does not change WHICH concepts matched, so the key holds, the set survives, and the lines
   *     do not re-fetch papers they already claimed — which is what the old `[]` was protecting.
   *
   * `useMemo`-as-reset, not a computed value (the factory reads neither dep) — minting the set
   * during render is pure, unlike clearing a ref's contents, which persists across React's
   * discarded/StrictMode renders. Same idiom, for the same reason, as
   * `components/search/people-result-card.tsx`'s `useMemo(() => new Set<string>(), [qParam])`.
   *
   * RESIDUAL, and it is the honest trade: re-minting the set on a mute also forgets the claims of
   * the SIBLING blocks that stayed mounted, so after a mute/unmute cycle two blocks can briefly
   * offer the same paper. That is a cosmetic duplicate; the bug it replaces is a block that hides
   * its own best paper or renders an empty disclosure. The real fix is release-on-unmount inside
   * `EvidenceLine` (the set would then be exactly "claims by mounted lines", with no reset needed
   * at all) — but that is a shared component the public People card renders too, so it belongs in
   * its own change rather than riding along here.
   */
  const blockTerms = JSON.stringify(evidenceBlocks.map((b) => b.concept.term));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const claimedPmids = useMemo(() => new Set<string>(), [runId, blockTerms]);
  const [rowRef, inView] = useInViewOnce<HTMLDivElement>();

  // AUTO-RESOLVE IN ORDER, ONE BLOCK AT A TIME — the de-dup depends on it.
  //
  // `claimedPmids` makes a card's blocks show DIFFERENT papers: whoever resolves first claims the
  // paper, and the others send it as `exclude=`. That works on the click path because a human opens
  // one disclosure at a time. Auto-resolving fires every block in the SAME commit, so every one of
  // them reads an empty claimed set, and a paper that is the best evidence for two of the sponsor's
  // concepts gets offered as the representative for both — the exact duplicate #1696 removed.
  //
  // So block i waits for block i-1 to settle. `resolvedCount` is keyed to the block list (same key
  // as the claimed set itself), so a mute/unmute restarts the chain along with the Set it protects.
  const [resolvedCount, setResolvedCount] = useState(0);
  useEffect(() => setResolvedCount(0), [runId, blockTerms]);

  // The concepts this candidate RANKED under but for which the server shipped no evidence block —
  // `coverage`'s middle state, named. They have a chip and a strip segment and nothing else, and
  // without a line here the officer is left to infer their absence from a gap in a bar.
  //
  // What this row does NOT do is cite a paper. The mockup's compact row reads "1 pub · Cancer Cell
  // 2022, middle author"; we have no paper for these concepts precisely BECAUSE no block shipped,
  // so any citation here would be invented. It says what is true instead.
  const rankedNoBlock = coverage.filter((c) => c.state === "ranked");
  return (
    <div ref={rowRef} className="border-t border-border flex gap-3 py-4 first:border-t-0">
      <div className="text-muted-foreground w-5 pt-1 text-right text-sm tabular-nums">{rank}</div>
      {/* The shared headshot, not a bespoke initials circle — this is a list of PEOPLE, and the
          public People card has rendered their faces all along. `HeadshotAvatar` degrades to a
          name-gradient with initials when the directory has no photo (the endpoint is requested
          with `returnGenericOn404=false`), so the no-photo case still looks like what this card
          rendered before, and an absent `identityImageEndpoint` lands in the same place. */}
      <HeadshotAvatar
        size="md"
        cwid={candidate.cwid}
        preferredName={name}
        identityImageEndpoint={candidate.identityImageEndpoint ?? ""}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {/* `profilePath`, not a hand-built path — the CSV export builds its URL column from
              the same helper, so the link and the export cannot drift apart. */}
          <a
            href={profilePath(encodeURIComponent(candidate.profileSlug))}
            className="text-base font-semibold leading-snug text-foreground underline-offset-4 hover:underline"
          >
            {name}
          </a>
          {candidate.title ? (
            <span className="text-muted-foreground text-sm">{candidate.title}</span>
          ) : null}
          {/* The tier, and ONLY the tier. The mockup also draws a `.meter` bar whose width is
              fusedScore/topScore — that is the raw score rendered as a length, and the contract
              keeps that number out of the DOM. */}
          <span
            className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${TIER_CLASS[tier]}`}
          >
            {TIER_LABEL[tier]}
          </span>
          <ContactButton cwid={candidate.cwid} />
        </div>
        {candidate.department ? (
          <div className="text-muted-foreground text-sm">{candidate.department}</div>
        ) : null}
        <CoverageStrip coverage={coverage} />
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
        {/* #1689 — the SPINE's evidence, rendered by the PUBLIC SEARCH'S OWN component.
            Not a lookalike built for this console: the same `<EvidenceLine>` the People card
            uses, fed the same `ResultEvidence` the server selected. It brings the reason line
            ("142 of 210 publications tagged Systemic Sclerosis") and, on expand, the lazy
            representative-papers disclosure — which costs nothing for the ~700 candidates
            nobody opens, because it fetches on click, not on render.
            Two surfaces answering "why did this scholar match?" with one renderer is the point:
            it is the only way they cannot come to disagree.

            #1696 — one block PER MATCHED CONCEPT, each captioned with the concept it answers
            for. The caption is not decoration: the reason line names the MeSH descriptor the
            search matched ("Receptors, Chimeric Antigen"), which is often not the word the
            sponsor used and not the label on the slider ("CAR-T"). Without the caption an
            officer cannot tell which concept a block belongs to — and with several blocks, that
            is the only question the stack raises. Each block carries its OWN `keyPaper`, so its
            disclosure reveals papers about ITS concept; the shared `claimedPmids` keeps those
            sets disjoint across the stack. */}
        {evidenceBlocks.length > 0 ? (
          <div className="mt-1.5 space-y-2">
            {evidenceBlocks.map(({ concept, evidence }, i) => (
              // `runId` in the key is the OTHER HALF of the claimedPmids reset above, and it is
              // required: a fresh Set is useless if the `EvidenceLine` beneath keeps its one-shot
              // `keyPaperFetched` ref from the last run and never fetches again. Baking the run
              // into the key remounts the line, dropping that guard along with its expand state
              // and any papers it resolved for the PREVIOUS paste. (Same two-part idiom as
              // `people-result-card.tsx`, which bakes `qParam` into both.) `term` alone keeps a
              // card's sibling blocks distinct WITHIN a run.
              <div key={`${runId}:${concept.term}`} data-slot="sponsor-match-evidence">
                {/* The concept, and what the sponsor asked for it — the two facts the block is an
                    answer to, on one line. `centrality` is the slider's own value, so the number
                    here is the number the officer set, not a derived weight they cannot locate. */}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-foreground text-sm font-medium">{concept.term}</span>
                  <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                    ask {concept.centrality.toFixed(2)}
                  </span>
                </div>
                <EvidenceLine
                  evidence={evidence.evidence}
                  cwid={candidate.cwid}
                  slug={candidate.profileSlug}
                  pubCount={evidence.pubCount}
                  q={evidence.keyPaper.contentQuery}
                  keyPaperConfig={evidence.keyPaper}
                  hasQuery
                  badged={false}
                  claimedPmids={claimedPmids}
                  stacked={false}
                  // The artifact on the face, resolved when the card is on screen. `inView` is the
                  // whole reason this is affordable: the pool runs to ~800 and we render 100, so
                  // fetching a paper per concept per RENDERED card would be ~300 requests for a
                  // page the officer sees five rows of. The observer buys the design spec back.
                  artifactLead
                  autoResolve={inView && i <= resolvedCount}
                  onResolved={() => setResolvedCount((n) => Math.max(n, i + 1))}
                />
              </div>
            ))}
          </div>
        ) : null}
        {rankedNoBlock.length > 0 ? (
          <div
            className="border-border mt-2 space-y-1 border-t pt-2"
            data-slot="sponsor-match-ranked-no-block"
          >
            {rankedNoBlock.map(({ concept }) => (
              <div
                key={concept.term}
                className="text-muted-foreground flex items-baseline justify-between gap-2 text-xs"
              >
                <span>
                  {concept.term}{" "}
                  <span className="tabular-nums">{concept.centrality.toFixed(2)}</span>
                </span>
                <span className="shrink-0">ranked, no evidence shown</span>
              </div>
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
        {/* Teal, per the mockup — CTL-IP gets its own hue so it does not read as another
            concept chip. Both hexes already ship in globals.css on `.entity-badge--institute`. */}
        {candidate.technologyCount > 0 ? (
          <span
            title="Licensable technologies this researcher already holds in the CTL portfolio."
            className="mt-1.5 inline-flex rounded-full bg-[#e0eded] px-2 py-0.5 text-xs font-medium text-[#2c5862]"
          >
            {candidate.technologyCount} CTL technolog
            {candidate.technologyCount === 1 ? "y" : "ies"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
