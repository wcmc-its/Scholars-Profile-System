"use client";

/**
 * CTL sponsor match — paste a commercial sponsor's description (an email or a
 * call transcript), rank WCM researchers on topical fit ALONE
 * (`docs/2026-07-09-ctl-technologies-handoff.md` §2). One POST to
 * `/api/edit/matcha`; no stage axis, no ESI, no intake queue.
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
import type { ResultEvidence } from "@/lib/api/result-evidence";
import { Button } from "@/components/ui/button";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  conceptCoverage,
  conceptWeight,
  evidenceMatchCount,
  evidenceProvenance,
  fitTier,
  hasMatchEvidence,
  latestEvidenceYear,
  matchedConcepts,
  matchedEvidence,
  preferenceBoost,
  PREFERENCE_LAMBDA,
  rareTerms,
  staleBefore,
  hiddenBefore,
  TIER_GOOD,
  rerankCandidates,
  askTitleFrom,
  type ConceptCoverage,
  type RecencyMode,
  type EvidenceProvenance,
  type MatchaCandidate,
  type MatchaConcept,
  type MatchaFitTier,
  type MatchaResponse,
  type MatchaPreference,
} from "@/lib/api/matcha-contract";
import type { CareerStage } from "@/lib/career-stage";
import { buildMatchaCsv } from "@/lib/edit/matcha-export";
import { careerStageLabel, roleCategoryLabel } from "@/lib/match-display";
import { extractLastNameSort } from "@/lib/name-sort";
import { profilePath } from "@/lib/profile-url";
import { markPaste, markedConceptCount } from "@/lib/matcha-paste-highlight";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

/** A retained search, as `GET /api/edit/matcha` ships it (#6d). */
type Submission = {
  id: string;
  description: string;
  title: string | null;
  engine: string;
  candidateCount: number;
  /** Who ran it. The route resolves `Scholar.preferredName` at READ TIME and falls back to the
   *  actor's cwid, so this is ALWAYS non-empty — never "" and never "Unknown". The raw cwid is
   *  deliberately not on the wire: not every submitter is an affiliated scholar, and the route
   *  has already made that decision correctly. */
  submittedByName: string;
  createdAt: string;
};

/** Whose retained searches this list holds — the SERVER's verdict, not a second one derived from
 *  the page's session (§9). `"all"` only for a superuser; everything else is the viewer's own. */
type HistoryScope = "all" | "own";

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

/** What the tool does (round-2 §3, user-authored 2026-07-17 — "people will not understand the full
 *  scope"). It leads with the VERB, names the input shapes, and says the output is ranked people
 *  with openable evidence you can re-weight; the old sentence stated what the ranker ignores before
 *  it stated what you can do, and never mentioned the shortlist at all.
 *  The lead is split out only because it renders bold — the words are one sentence, not two facts.
 *  ⚠ "Recommendations, not endorsements" was dropped DELIBERATELY (user, 2026-07-17), not lost. It
 *  still stands on the Funding matcher (`find-researchers.tsx`); do not re-add it here on the
 *  assumption that its absence is an oversight. */
const MATCHA_LEAD = "Matcha turns a raw ask into a ranked shortlist of researchers.";
const MATCHA_BLURB =
  "Paste any description of an opportunity — a funding call, an email, a few bullet points. Matcha pulls out the topics and methods it's really asking for, weighs how much each one matters, and ranks scholars by fit across all of them. Every recommendation comes with the evidence behind it, and you can adjust the weights to re-rank on the spot.";

/** Three-register hierarchy (mockup): the first N matched concepts render as FULL evidence blocks
 *  (badge, artifact, role, recency); the rest demote to a one-line supporting row. `matchedEvidence`
 *  hands blocks back strongest-first, so the primary N are the strongest N. A demoted row does NOT
 *  fetch its artifact — that is what makes demoting it cheaper, and why it shows only the tagged
 *  count, never a role or year it never fetched. */
const PRIMARY_BLOCKS = 2;

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

const TIER_LABEL: Record<MatchaFitTier, string> = {
  strong: "Strong fit",
  good: "Good fit",
  weak: "Weak fit",
};

/** Mockup's tier palette, which reads better than the old all-slate ramp: green / amber / grey.
 *  Every hex already exists as a house token — nothing new is introduced. */
const TIER_CLASS: Record<MatchaFitTier, string> = {
  strong:
    "border-[var(--apollo-green-tint-border)] bg-[var(--apollo-green-tint)] text-[var(--apollo-green-foreground)]",
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

/** D8 — Detailed (the full evidence card) vs Compact (one scannable row per scholar). */
type Density = "detailed" | "compact";
const DENSITY_KEY = "sponsor-match-density";

/** D3 — the recency dial. Same detached-pill idiom as the density tabs beside it (the sort pair is
 *  conjoined instead — see the header). "Since" carries a year, so it opens on a sensible cutoff
 *  and offers a span back from today. */
const RECENCY_TABS = [
  { key: "any", label: "Any" },
  { key: "recent", label: "Prefer recent" },
  { key: "since", label: "Since" },
] as const;
const RECENCY_SINCE_DEFAULT_AGE = 5;
const RECENCY_SINCE_SPAN = 15;

/** Facet order is the career ladder, not a count ranking — a stage list that reordered itself
 *  per search would be unreadable. */
const CAREER_STAGE_ORDER: readonly CareerStage[] = ["grad", "postdoc", "early", "mid", "senior"];

function toggled(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * A–Z by SURNAME — the only order an officer scanning for a name expects, and the one this sort
 * did not have: it compared `name`, so "Name" meant by FIRST name.
 *
 * `lastNameSort` is the ETL's own key (lowercased, suffix-stripped), not a split of `name`. Do not
 * be tempted back to `name.split(" ").pop()`: that lands on the suffix for "… Jr", on the
 * postnominals for "… MD, PhD", and on the wrong half of a particle surname — and it would fail
 * exactly on the names it is hardest to notice failing on.
 *
 * ONE KEY PER ROW, ALWAYS — this comparator must be TOTAL, and a keyed-vs-unkeyed split is not.
 * An earlier shape compared surnames only when BOTH rows carried the key and fell back to the full
 * name otherwise; that is two comparators over one list, and it admits a real 3-cycle: given
 * `Zoe Abbott`(abbott), `Bob Unindexed`(none), `Alice Zephyr`(zephyr) you get abbott<zephyr,
 * "Alice Zephyr"<"Bob Unindexed", "Bob Unindexed"<"Zoe Abbott" — so a single UNKEYED row silently
 * inverts the A–Z order of two fully KEYED ones, differently depending on the fit order it arrived
 * in. `Array.prototype.sort` on an inconsistent comparator is implementation-defined, so the same
 * pool could order differently run to run.
 *
 * So an absent key is re-derived with `extractLastNameSort` — the ETL's OWN function
 * (`search-index-docs.ts` builds the field with it), not a guess. That is the whole reason this
 * helper is dependency-free and shared. It is a reindex-window fallback: normally the key is on
 * the wire and this never fires.
 *
 * ⚠ Note `extractLastNameSort` returns "" (never null) for a blank name, so an emptiness check
 * cannot be `!= null` — "" is a live string that sorts AHEAD of every real surname. Falsy-check it.
 *
 * Equal surnames tie-break on the full name, so siblings order deterministically instead of by
 * whatever order the ranker happened to fuse them in.
 *
 * Two consequences of the re-derivation, both wanted:
 *   - The BESPOKE engine ships no `lastNameSort` at all (`bespokeToCandidate` in the route emits
 *     `name` only), so under a keyed-only comparator that whole engine silently reverted to
 *     first-name order with nothing in the UI to say so. It re-keys off `name`, which IS the
 *     `preferredName` the ETL itself feeds `extractLastNameSort`, so it now sorts correctly too.
 *   - This orders with `localeCompare`, while the PUBLIC People search sorts server-side on
 *     `{ lastNameSort: "asc" }` — OpenSearch keyword BYTE order. Same field, different collation:
 *     an accented surname sorts near its unaccented neighbour here and after "zzz" there. That is
 *     a real divergence and this side is the better behaviour; do not "fix" it into byte order.
 */
function surnameKey(c: MatchaCandidate): string {
  const key = c.lastNameSort?.trim();
  return key ? key : extractLastNameSort(c.name);
}

function compareByName(a: MatchaCandidate, b: MatchaCandidate): number {
  return surnameKey(a).localeCompare(surnameKey(b)) || a.name.localeCompare(b.name);
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

export function MatchaPanel() {
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // The paste is EDITABLE until a search commits, then the ask (title + read-only, highlighted
  // request + Edit/Re-run) takes its place — the mockup's "THE ASK" section. "Edit paste"
  // flips this back to the textarea. Starts true (nothing searched yet).
  const [editing, setEditing] = useState(true);
  // D10 — the ask card has two states: Full (eyebrow + title + clamped paste + audit + actions) and
  // Compact (a pinned bar: title + top concept chips + read ratio + actions). Fresh paste/re-run
  // opens Full; a Recent replay opens Compact (already read). Scrolling past the header collapses it
  // (the effect below); "Show original" restores Full. Per-search state — a new search resets it.
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  // "Show original" PINS Full open, and the pin is the whole fix (round-2 §6). The control was never
  // broken: it set `headerCollapsed` false and scrolled the card back into view — and the act of
  // scrolling re-armed the observer below on a sentinel that was still above the viewport top, which
  // re-collapsed the header on the same frame. The officer asked to see the paste and the observer
  // out-voted them. So an EXPLICIT request disarms the scroll-collapse for the REST OF THE ASK; only
  // a new search re-arms it. A longer timeout would have made the race quieter, not decided it.
  //
  // Consequence, and it is intended: once "Show original" is used, scrolling no longer auto-collapses
  // the header to the sticky bar. "Collapse ▴" is how the officer asks for the sticky bar back — an
  // explicit request answered by an explicit control, which is the trade §6 asked for.
  const [headerPinned, setHeaderPinned] = useState(false);
  // D11 — the read-only paste clamps to ~4 lines until the officer asks for the rest. Reset per
  // search so a new paste always starts clamped.
  const [showFullText, setShowFullText] = useState(false);
  const [history, setHistory] = useState<Submission[]>([]);
  /** Defaults to `"own"` so a response without a `scope` never renders a submitter column the
   *  server did not authorise — the same fail-closed direction the route's `where` takes. */
  const [historyScope, setHistoryScope] = useState<HistoryScope>("own");
  const [deptSel, setDeptSel] = useState<ReadonlySet<string>>(new Set());
  const [conceptSel, setConceptSel] = useState<ReadonlySet<string>>(new Set());
  const [ctlOnly, setCtlOnly] = useState(false);
  // #1654 — selection is keyed by the DISPLAY label (what FacetGroup renders and toggles),
  // so the filter compares labels too. One vocabulary, no id↔label map to drift.
  const [stageSel, setStageSel] = useState<ReadonlySet<string>>(new Set());
  const [clinicianOnly, setClinicianOnly] = useState(false);
  const [roleSel, setRoleSel] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<SortKey>("fit");
  // D8 — density, remembered across visits. The results only render after a client fetch, so reading
  // localStorage in the initializer is safe (no server render reaches this — the idle page has no list).
  const [density, setDensity] = useState<Density>(() =>
    typeof window !== "undefined" && window.localStorage.getItem(DENSITY_KEY) === "compact"
      ? "compact"
      : "detailed",
  );
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(DENSITY_KEY, density);
  }, [density]);
  // D3 — how much recency counts for THIS ask. NOT remembered like density: it is a property of the
  // sponsor's request, not of the officer, and carrying one ask's dial onto the next would silently
  // re-rank a fresh search. Default "recent" = D1's curve = what the server fused with, so the list
  // opens exactly as the ranker sent it; moving this re-ranks the already-fetched candidates in the
  // browser, like the centrality slider — no re-query.
  const [recency, setRecency] = useState<RecencyMode>("recent");
  const currentYear = useMemo(() => new Date().getUTCFullYear(), []);
  // D8 — cwids force-expanded to the detailed card while in Compact mode (a row click). Cleared on
  // each new search: a previous run's expansions do not carry to different people.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The shortlist — the people the officer picked out of THIS ask, and the default export.
  // Per-ask for the same reason `expanded` is, and it is the stronger case of the two: a cwid set
  // carried onto the next sponsor would export people that sponsor never asked about, under the
  // new ask's title, with the new ask's ranks. Cleared in `runSearch` beside `expanded`.
  //
  // Uncapped. The earlier design capped picks at 5–6, which was never a fact about shortlisting —
  // it was Compare's column budget. Compare is parked, and a CSV has no columns to run out of.
  const [shortlist, setShortlist] = useState<ReadonlySet<string>>(new Set());
  // The two halves of the contract payload. `candidates` is fetched ONCE per search and
  // never refetched by a slider; `concepts` is the editable rail. Everything below is
  // derived from them.
  const [candidates, setCandidates] = useState<MatchaCandidate[]>([]);
  const [concepts, setConcepts] = useState<MatchaConcept[]>([]);
  // The extractor's essence title (org + focus). Stable across slider/preference edits — only
  // a new search replaces it — so the header does not churn as the officer tunes the ranking.
  const [titleSummary, setTitleSummary] = useState<string | undefined>(undefined);
  // #1654 — the sponsor's non-topical asks, and which of them the officer is honouring.
  // Keyed by label: an extractor that fires twice on the same ask would emit one entry.
  const [preferences, setPreferences] = useState<MatchaPreference[]>([]);
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
  // (read back a past paste, re-run it) and adds the thing it could not — a delete that actually
  // erases the sponsor's words rather than clearing one browser. Two histories would have been
  // two sources of truth for the same question.
  //
  // §9 — THE LIST IS SCOPED SERVER-SIDE. It once carried every officer's searches to anyone on
  // this surface; a superuser still sees that, and everybody else now gets only their own. The
  // client does not filter — it renders what the route decided it may see, and `scope` says
  // which of the two lists this is.
  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/edit/matcha", { credentials: "same-origin" });
      if (!r.ok) return; // a failed history load must never disturb the matcher
      const data = (await r.json()) as { submissions?: Submission[]; scope?: HistoryScope };
      setHistory(data.submissions ?? []);
      setHistoryScope(data.scope === "all" ? "all" : "own");
    } catch {
      /* offline / transient — the list is a convenience, not the product. */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function deleteSubmission(id: string) {
    try {
      const r = await fetch("/api/edit/matcha", {
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

  /** The ONLY network call. A search — never a re-rank. `fromHistory` opens the ask card COMPACT
   *  (a Recent replay is text the officer has already read), a fresh paste/re-run opens it Full. */
  async function runSearch(text: string, opts: { fromHistory?: boolean } = {}) {
    if (pending || text.trim().length === 0) return;
    setStatus({ kind: "loading" });
    try {
      const r = await fetch("/api/edit/matcha", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ description: text }),
      });
      if (r.ok) {
        // Typed as the CONTRACT's response, not an anonymous shape. The contract's headline
        // promise is that a drift between ranker and panel is a compile error; an inline
        // `{candidates?; concepts?}` opted the envelope out of exactly that.
        const data = (await r.json()) as Partial<MatchaResponse>;
        clearFilters(); // stale facet selections must not silently hide fresh results
        setExpanded(new Set()); // D8 — previous run's per-row expansions don't carry to new people
        setShortlist(new Set()); // the shortlist is per-ask: last sponsor's picks are not this one's
        void loadHistory(); // the row the server just retained
        setCandidates(data.candidates ?? []);
        setConcepts(data.concepts ?? []);
        setTitleSummary(data.titleSummary);
        setMatchedText(text);
        setEditing(false); // a committed search → show the read-only ask, not the textarea
        setHeaderCollapsed(!!opts.fromHistory); // D10 — Full on a fresh paste/re-run, Compact on replay
        setHeaderPinned(false); // §6 — the pin is per-ask: a new paste re-arms the scroll-collapse
        setShowFullText(false); // D11 — new paste starts clamped
        setRecency("recent"); // D3 — the dial is per-ask; a new sponsor starts at the ranker's default
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

  // Zero-evidence candidates are excluded from the RESULT set entirely — not collapsed under the
  // floor. `hasMatchEvidence` keeps only the scholars the spine shipped a research-match block for;
  // the rest ranked into a concept's top-100 on an identity-tail hit and answer "who is this", not
  // "why did they match". A card with an empty strip is noise. We keep the raw pool count for an
  // honest "N with no evidence hidden" note, but everything downstream ranks over `results`.
  const results = useMemo(() => candidates.filter(hasMatchEvidence), [candidates]);
  const excludedCount = candidates.length - results.length;

  const ranked = useMemo(
    () =>
      rerankCandidates(results, concepts, {
        // D3 — the officer's dial. "recent" (the default) is the server's own weighting, so an
        // untouched control reproduces the shipped order; anything else is a deliberate re-rank.
        recency,
        ...(activePreferences.length > 0
          ? {
              prefBoost: (c) => preferenceBoost(c, activePreferences),
              lambda: PREFERENCE_LAMBDA,
            }
          : {}),
      }),
    [results, concepts, activePreferences, recency],
  );

  // D4 — the hard cutoff. Only `{ since }` hides (see `hiddenBefore`); the default dial position
  // never removes anyone. A candidate with NO year is KEPT: absent is not old, and a missing
  // `mostRecentYear` means the flag is off or nobody curated their publications — neither is a
  // fact about the scholar, and we do not delete people for a gap in our own data.
  //
  // Why this is filtered here and not fused into the score: D1's demotion is bounded (the ×0.5
  // floor), so a stale scholar still ranks and the officer can see and judge them. Removal is
  // unbounded and unnoticeable — you cannot spot the expert who is not on the page — so it stays
  // OUT of the ranking function and lives here, where it is an explicit officer action with a
  // count attached.
  // It REDEFINES THE POOL rather than filtering the painted rows, and that is the whole of it:
  // facets count it, the facet filters search it, the rank is stamped from it, and the CSV
  // exports it. Hiding only at the render layer would leave a "Neurology · 12" facet that filters
  // down to 9, and would export scholars the officer had just excluded.
  const yearCutoff = hiddenBefore(recency);
  const rankedInYear = useMemo(
    () =>
      yearCutoff == null
        ? ranked
        : ranked.filter((c) => c.mostRecentYear == null || c.mostRecentYear >= yearCutoff),
    [ranked, yearCutoff],
  );
  const hiddenByYear = ranked.length - rankedInYear.length;

  // D3 — the dial only means anything when the payload carries years (SPONSOR_MATCH_RECENCY on).
  // Absent ⇒ every weight is 1 and the control would be a lie, so it does not render.
  const hasRecencyData = useMemo(() => results.some((c) => c.mostRecentYear != null), [results]);
  // D8 — the boundary the compact row's year is flagged against, derived from the ACTIVE mode
  // (see `staleBefore`): the officer's own cutoff under "Since", one half-life under "Prefer
  // recent", and null under "Any" — where nothing is weighing recency, so nothing claims stale.
  const staleYear = useMemo(() => staleBefore(recency, currentYear), [recency, currentYear]);

  // Tiers are a share of the top of the POOL the officer is actually looking at, so they re-tier
  // against a year-restricted pool the same way D2 re-tiers against a re-ranked one. Reading
  // `ranked[0]` would let a hidden scholar set the bar for a list they are not in — and if the top
  // match were filtered out, every remaining row could read "weak" against someone the officer
  // cannot see. Identical under "any"/"recent", where nothing is hidden.
  const topScore = rankedInYear[0]?.fusedScore ?? 0;

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
    () =>
      askTitleFrom(
        concepts,
        preferences.filter((p) => activePrefs.has(p.label)),
        titleSummary,
      ),
    [concepts, preferences, activePrefs, titleSummary],
  );

  // The committed request, with the pulled-out terms marked — the mockup's read-only ask quote.
  // `matchedText` (not `description`) so an in-progress textarea edit can't desync the marks.
  const askSegments = useMemo(() => markPaste(matchedText, concepts), [matchedText, concepts]);
  const askMarked = useMemo(() => markedConceptCount(askSegments), [askSegments]);
  // Show the read-only ask once a search has committed and the officer is not editing the paste.
  const showAskCard = !editing && matchedText.length > 0;

  // D10 — the ask card's scroll-collapse. A 0-height sentinel sits at the top of the Full card;
  // once it scrolls above the viewport top the header collapses to the pinned Compact bar. One-way
  // (like the one-shot observers elsewhere in this file) — "Show original" is the only way back.
  //
  // §6 — `headerPinned` DISARMS it, and that guard is the fix. Scroll-collapse is an inference from
  // behaviour ("you have scrolled past, you are done reading"); "Show original" is a statement of
  // intent. When they disagree the statement wins, so the observer is not merely reset here — it is
  // never constructed while the pin is held. (Constructing it and ignoring its first callback would
  // not work: every later scroll fires it again.)
  const askWrapRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showAskCard || headerCollapsed || headerPinned) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e && !e.isIntersecting && e.boundingClientRect.top < 0) setHeaderCollapsed(true);
      },
      { threshold: 0 },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [showAskCard, headerCollapsed, headerPinned]);

  // D10 — the compact bar's chips: the most-asked-for concepts (by the same conceptWeight the strip
  // and the ranking use), a few shown and the rest counted (+N).
  const topConceptChips = useMemo(() => {
    const sorted = [...concepts].sort((a, b) => conceptWeight(b) - conceptWeight(a));
    return { head: sorted.slice(0, 3), extra: Math.max(0, sorted.length - 3) };
  }, [concepts]);

  // D10/§6 — restore Full, PIN it, and bring it into view. The pin has to be set here rather than
  // left to the scroll landing: `scrollIntoView` is `behavior: "smooth"`, so it resolves over many
  // frames, while the observer re-arms on the very next commit — the old code lost that race every
  // time, which is the whole of the "show original won't stay open" bug.
  const showOriginal = useCallback(() => {
    setHeaderPinned(true);
    setHeaderCollapsed(false);
    requestAnimationFrame(() =>
      askWrapRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  }, []);

  // Facet over the POOL (see RESULT_MAX) — which under a year cutoff IS the year-restricted pool.
  // A facet offering "Neurology · 12" that filters down to 9 because 3 were hidden by the cutoff
  // would be lying about its own result set.
  const deptFacet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of rankedInYear)
      if (c.department) counts.set(c.department, (counts.get(c.department) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, DEPT_FACET_MAX);
  }, [rankedInYear]);

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

  // Active filters, as removable chips above the results (mockup) — the rail's checkboxes are how
  // you SET a filter; the chips are what is currently ON, one click to drop. Keyed and labelled by
  // the same display value the facet toggles, so a chip's ✕ is exactly the checkbox's toggle.
  const filterChips: { key: string; label: string; onRemove: () => void }[] = [
    ...[...deptSel].map((v) => ({
      key: `dept:${v}`,
      label: v,
      onRemove: () => setDeptSel(toggled(deptSel, v)),
    })),
    ...[...conceptSel].map((v) => ({
      key: `concept:${v}`,
      label: v,
      onRemove: () => setConceptSel(toggled(conceptSel, v)),
    })),
    ...[...stageSel].map((v) => ({
      key: `stage:${v}`,
      label: v,
      onRemove: () => setStageSel(toggled(stageSel, v)),
    })),
    ...[...roleSel].map((v) => ({
      key: `role:${v}`,
      label: v,
      onRemove: () => setRoleSel(toggled(roleSel, v)),
    })),
    ...(clinicianOnly
      ? [{ key: "clinician", label: "Practicing clinician", onRemove: () => setClinicianOnly(false) }]
      : []),
    ...(ctlOnly
      ? [{ key: "ctl", label: "Holds CTL technology", onRemove: () => setCtlOnly(false) }]
      : []),
  ];

  // Live rank travels with the row, so a filtered view still reads "this person is #7 overall",
  // not "#1 of the filtered three". It re-derives as sliders move. Ranks are POOL ranks — a
  // CTL-filtered view can legitimately read #137, because the filter now searches the pool.
  //
  // The rank is stamped from the FIT order and then carried, never recomputed — so sorting by
  // Name reorders the rows while each row keeps the rank it holds in the ranking. A sort that
  // renumbered rows would be claiming Alice is the best match because her name comes first.
  //
  // Stamped ONCE, here, and read by both consumers below: the facet-filtered view and the
  // shortlist. They must agree on what "#7" means, and they can only do that by numbering the
  // same list — a second `.map((c, i) => …)` further down would be a second, silently different
  // ranking the moment anything upstream of it filtered.
  const rankedRows = useMemo(
    () => rankedInYear.map((c, i) => ({ c, rank: i + 1 })),
    [rankedInYear],
  );

  // Uncapped, and deliberately: this is every candidate that matches the filters, and it is
  // what the CSV exports. `visible` below is the same list with the render cap applied.
  const filtered = useMemo(
    () =>
      rankedRows.filter(
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
    [rankedRows, deptSel, conceptSel, ctlOnly, stageSel, clinicianOnly, roleSel],
  );

  // The cap lands on the FIT-ordered rows, then Name reorders that hundred. Slicing after the
  // name sort would paint the alphabetically-first 100 and call them the best matches.
  const visible = useMemo(() => {
    const rows = filtered.slice(0, RESULT_MAX);
    return sort === "name" ? [...rows].sort((a, b) => compareByName(a.c, b.c)) : rows;
  }, [filtered, sort]);

  // The relevance floor. Full cards for strong/good; the weak tier collapses under one bar the
  // officer can expand. Relative BY CONSTRUCTION — `fitTier` buckets each row against the TOP hit
  // (the #1 always scores share 1.0 → "strong", so this never collapses everything), so the floor
  // tracks the result set's own distribution rather than an absolute cutoff. Only meaningful in fit
  // order: a name sort mixes tiers alphabetically, so it stays a flat list with no floor.
  const [showWeak, setShowWeak] = useState(false);
  const aboveFloor = useMemo(
    () =>
      sort === "fit"
        ? visible.filter((r) => fitTier(r.c.fusedScore, topScore) !== "weak")
        : visible,
    [visible, sort, topScore],
  );
  const belowFloor = useMemo(
    () =>
      sort === "fit" ? visible.filter((r) => fitTier(r.c.fusedScore, topScore) === "weak") : [],
    [visible, sort, topScore],
  );

  // Never strand a collapse bar over an empty list. If nothing cleared the floor — a facet that
  // isolated only weak matches, or a weak top hit — there is no floor to draw, so show what we
  // have as flat cards. The bar appears only when there is genuinely a head above a tail.
  const primaryRows = aboveFloor.length > 0 ? aboveFloor : belowFloor;
  const collapsedWeak = aboveFloor.length > 0 ? belowFloor : [];

  /** The shortlist AS ROWS, and the single source for both the bar's count and the file it
   *  downloads — so the count can never promise rows the export does not write.
   *
   *  Read off `rankedRows`: the pool AFTER the year cutoff, BEFORE the facets. That split is not
   *  arbitrary, it is the one this whole file already draws — the cutoff REDEFINES the pool (see
   *  `rankedInYear`: facets count it, the rank is stamped from it), while a facet is a VIEW. A
   *  view must not quietly drop a person the officer picked by hand: shortlist three people, then
   *  narrow to one department to look for a fourth, and the other two are still shortlisted,
   *  because they were CHOSEN rather than matched. */
  const shortlistRows = useMemo(
    () => rankedRows.filter(({ c }) => shortlist.has(c.cwid)),
    [rankedRows, shortlist],
  );

  /** One mapping, both exports. Two copies of it would drift, and the CSV would then depend on
   *  which button the officer pressed — the rows are the same rows either way. */
  function exportCsv(rows: readonly { c: MatchaCandidate; rank: number }[], filename: string) {
    const csv = buildMatchaCsv(
      rows.map(({ c, rank }) => ({
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
    downloadCsv(filename, csv);
  }

  /** Exports every row the filters matched — current sliders, current filters — NOT just the
   *  hundred we painted. An officer who filters to the CTL portfolio and gets 180 hits must
   *  download 180, not the first 100 with no warning that the rest exist. A server route could
   *  not do this at all: it would re-run the match and emit the DEFAULT ranking, not the one
   *  the officer re-weighted.
   *
   *  Still REACHABLE once a shortlist exists, just no longer the unqualified "Export" — see the
   *  button, which renames itself rather than disappearing. Dropping it would strand the officer
   *  who ticked one row and still wanted the whole filtered list. */
  function exportFiltered() {
    exportCsv(filtered, "sponsor-match-researchers.csv");
  }

  /** The default export once anything is ticked. Its own filename: these two files have the same
   *  columns and wildly different meanings, and a shortlist landing in Downloads under the name of
   *  the 400-row list is how the wrong one gets sent to a sponsor. */
  function exportShortlist() {
    exportCsv(shortlistRows, "sponsor-match-shortlist.csv");
  }

  // #6d retained searches, in a right-side drawer (reused shadcn Sheet — no hand-rolled
  // overlay/focus-trap). Declared once and rendered beside the search action in BOTH the edit
  // form and the read-only ask, so history stays reachable in either state. The retention notice
  // lives in the drawer header, where #6d requires it be said.
  const historyDrawer =
    history.length > 0 ? (
      <Sheet>
        <SheetTrigger asChild>
          <Button type="button" variant="outline">
            Recent ({history.length})
          </Button>
        </SheetTrigger>
        <SheetContent data-slot="matcha-history">
          <SheetHeader>
            <SheetTitle>Recent searches ({history.length})</SheetTitle>
            {/* The retention notice, and it must track §9's scope or it is a lie in whichever
                direction it is left. It said "Everyone with access to this console can see them",
                which was true of the global list and is now false for a normal user — and this is
                the sentence a chair reads before pasting a donor email, so under-promising
                privacy is not the safe default here either. Each branch states exactly who can
                read THIS list, and it leads: who can see this is what the reader needs BEFORE
                they paste, not after. */}
            <SheetDescription>
              {historyScope === "all"
                ? "As an administrator you are seeing every user's searches."
                : "Only you and console administrators can see your searches."}{" "}
              They&rsquo;re saved — including the description you pasted — so we can measure and
              improve match quality against real opportunity text. Delete any search to remove its
              text for good.
            </SheetDescription>
          </SheetHeader>
          <ul className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {history.map((h) => (
              <li key={h.id} className="border-border border-b pb-4 last:border-b-0 last:pb-0">
                <div className="text-muted-foreground flex items-baseline gap-2 text-xs">
                  <span className="shrink-0 tabular-nums">
                    {new Date(h.createdAt).toLocaleDateString()}
                  </span>
                  {/* §10 — SUPERUSER VIEW ONLY, and the name rather than the cwid.
                      Once the list is scoped (§9) a normal user's rows are ALL their own, so the
                      column is a constant repeated down the list: it tells them nothing they did
                      not already know and spends the width this drawer does not have. It earns
                      its place only where rows differ by actor, which is the superuser's list.
                      `submittedByName` is resolved server-side from `Scholar.preferredName` with
                      a cwid fallback — never blank, never "Unknown". */}
                  {historyScope === "all" ? (
                    <span className="min-w-0 truncate">{h.submittedByName}</span>
                  ) : null}
                  <span className="ml-auto shrink-0 tabular-nums">{h.candidateCount} matched</span>
                </div>
                {/* Replaying closes the drawer so the results are visible — SheetClose composes
                    with the button's own onClick. The replayed request re-renders as the read-only
                    ask above, so the row itself needs no request preview (that was the duplicative
                    §2c compact preview, removed). */}
                <SheetClose asChild>
                  <button
                    type="button"
                    onClick={() => {
                      setDescription(h.description);
                      void runSearch(h.description, { fromHistory: true }); // D10 — replay opens Compact
                    }}
                    className="text-foreground/90 mt-1 block w-full text-left text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {h.title ?? "Untitled search"}
                  </button>
                </SheetClose>
                <button
                  type="button"
                  aria-label={`Delete search: ${h.title ?? h.description.slice(0, 60)}`}
                  onClick={() => void deleteSubmission(h.id)}
                  className="text-muted-foreground mt-1 text-xs underline-offset-4 hover:underline"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    ) : null;

  // D8 — a result row is the detailed card when density is Detailed OR the officer expanded it from
  // Compact; otherwise the one-line CompactRow, which expands in place on click. Used for both the
  // primary rows and the below-floor weak rows, so the floor and the density toggle compose.
  const renderResult = ({ c, rank }: { c: MatchaCandidate; rank: number }) => {
    // THE ONLY STATE A COLLAPSE MEANS ANYTHING IN. `toggled` was always a correct toggle, but it
    // hung solely off CompactRow — so the instant it ADDED a cwid the row it lived on unmounted,
    // and the expanded card that replaced it offered no way to fire it in the delete direction.
    // The toggle could only ever add; nothing but a new search emptied the set.
    //
    // Under Detailed the card IS the density: there is nothing to collapse TO, so the control must
    // not render — an affordance that puts a row back into a mode the officer is not in is worse
    // than the bug.
    const expandedFromCompact = density !== "detailed" && expanded.has(c.cwid);
    return density === "detailed" || expandedFromCompact ? (
      <ResearcherRow
        candidate={c}
        rank={rank}
        concepts={concepts}
        topScore={topScore}
        runId={runId}
        {...(expandedFromCompact
          ? { onCollapse: () => setExpanded((s) => toggled(s, c.cwid)) }
          : {})}
        selected={shortlist.has(c.cwid)}
        onSelect={() => setShortlist((s) => toggled(s, c.cwid))}
      />
    ) : (
      <CompactRow
        candidate={c}
        rank={rank}
        concepts={concepts}
        topScore={topScore}
        staleYear={staleYear}
        onExpand={() => setExpanded((s) => toggled(s, c.cwid))}
        selected={shortlist.has(c.cwid)}
        onSelect={() => setShortlist((s) => toggled(s, c.cwid))}
      />
    );
  };

  return (
    <div data-slot="matcha-panel">
      <div className="mb-5">
        {/* No hover on the h1: the subtitle directly beneath it now carries the full scope, so a
            hover repeating it would be a tooltip for a paragraph already on screen. The name is
            opaque BEFORE you land here, which is why the explanatory hover lives on the nav tab
            (`admin-subnav`) instead — that is the moment it is needed. */}
        <h1 className="text-2xl font-bold tracking-tight">Matcha</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
          <strong className="text-foreground font-semibold">{MATCHA_LEAD}</strong> {MATCHA_BLURB}
        </p>
      </div>

      {showAskCard ? (
        /* The mockup's "THE ASK": once a search commits, the textarea is replaced by the request
           shown READ-ONLY with its pulled-out terms highlighted, titled by the extractor's essence
           handle, with Edit paste / Re-run. (Title stays the console's sans, not the mockup's
           serif chrome — the panel deliberately keeps console chrome; see the file header.) */
        headerCollapsed ? (
          /* D10 — COMPACT / pinned. `sticky top-0` keeps the sponsor's ask in view while the officer
             scrolls the results, without the full card eating the screen. Title + the most-asked-for
             concepts (+N) + the read ratio (D11) + the same actions. Direct child of the panel (not
             a short wrapper) so its containing block is tall enough for sticky to hold. */
          <div
            data-slot="matcha-ask-compact"
            className="border-border bg-background sticky top-0 z-30 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-2.5 shadow-md"
          >
            <span aria-hidden="true" className="text-xs">
              📌
            </span>
            {ask ? (
              <span
                data-slot="matcha-ask"
                className="min-w-0 truncate text-sm font-semibold"
              >
                {ask.title}
              </span>
            ) : null}
            {topConceptChips.head.length > 0 ? (
              <span className="flex flex-wrap items-center gap-1">
                {topConceptChips.head.map((c) => (
                  <span
                    key={c.term}
                    className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px]"
                  >
                    {c.term}
                  </span>
                ))}
                {topConceptChips.extra > 0 ? (
                  <span className="text-muted-foreground text-[11px]">+{topConceptChips.extra}</span>
                ) : null}
              </span>
            ) : null}
            {/* D11 — the extraction audit rides the pinned bar, so an under-read is visible without
                expanding; tapping it restores the highlighted full text. */}
            {concepts.length > 0 ? (
              <HoverTooltip
                wide
                placement="bottom"
                text="Concepts found verbatim in the paste (the rest were canonicalized to standard terms). Show the highlighted original."
              >
                <button
                  type="button"
                  onClick={showOriginal}
                  className="text-muted-foreground text-[11px] tabular-nums underline-offset-2 hover:underline"
                >
                  {askMarked}/{concepts.length} read
                </button>
              </HoverTooltip>
            ) : null}
            <span className="flex-1" />
            <button
              type="button"
              onClick={showOriginal}
              className="text-xs text-[var(--color-facet-topic-count)] underline-offset-4 hover:underline"
            >
              Show original ▾
            </button>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit paste
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => void runSearch(matchedText)}
              className="bg-[var(--color-accent-slate)] text-white hover:bg-[var(--color-accent-slate)]/90"
            >
              {pending ? "Ranking…" : "Re-run"}
            </Button>
          </div>
        ) : (
          /* D10/D11 — FULL. `askWrapRef` is the scroll-into-view target for "Show original"; the
             sentinel after the card is what the collapse observer watches (past the header). */
          <div ref={askWrapRef} className="mb-4">
            <section
              data-slot="matcha-ask-card"
              className="border-border bg-background rounded-xl border px-5 py-4"
            >
              {/* The mockup's header row: eyebrow + title on the left, the actions on the right —
                  ONE continuous padded card, no rule between header and body. */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-muted-foreground block text-[11px] tracking-[0.05em] uppercase">
                    What we read from the sponsor
                  </span>
                  {ask ? (
                    <h2
                      data-slot="matcha-ask"
                      className="mt-1 text-base font-medium"
                    >
                      {ask.title}
                    </h2>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                    Edit paste
                  </Button>
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={() => void runSearch(matchedText)}
                    className="bg-[var(--color-accent-slate)] text-white hover:bg-[var(--color-accent-slate)]/90"
                  >
                    {pending ? "Ranking…" : "Re-run match"}
                  </Button>
                  {historyDrawer}
                </div>
              </div>

              {/* The pasted request, read-only, each pulled-out term marked. `break-words` for the
                  300-char Outlook SafeLinks URL that carries no break opportunity. D11 — clamped to
                  ~4 lines until "Show full text". The marks are facet-blue: the highlights ARE the
                  provenance ("what we read"), the one place this console reaches for that accent. */}
              <p
                data-slot="matcha-ask-quote"
                className={`text-muted-foreground mt-3 text-[13px] leading-[1.6] break-words whitespace-pre-wrap ${
                  showFullText ? "" : "line-clamp-4"
                }`}
              >
                {askSegments.map((s, i) =>
                  s.term ? (
                    // The wrapper span is `inline-flex`, so a marked RUN can no longer break across
                    // lines — it wraps as a unit. Accepted: a mark spans one canonicalised term (a
                    // word or two), never the 300-char SafeLinks URL `break-words` above exists for.
                    // If a long term ever wraps badly here, that is this trade, not a mystery.
                    <HoverTooltip key={i} text={s.term}>
                      <mark
                        data-slot="matcha-ask-mark"
                        data-term={s.term}
                        className="rounded-[3px] bg-[var(--color-facet-topic-fill)] px-[3px] text-[var(--color-facet-topic-text)]"
                      >
                        {s.text}
                      </mark>
                    </HoverTooltip>
                  ) : (
                    <span key={i}>{s.text}</span>
                  ),
                )}
              </p>
              {/* D11 — expand the clamped paste; D10 — collapse the whole header to the pinned bar. */}
              <div className="mt-1.5 flex items-center gap-3.5">
                <button
                  type="button"
                  onClick={() => setShowFullText((v) => !v)}
                  className="text-xs text-[var(--color-facet-topic-count)] underline-offset-4 hover:underline"
                >
                  {showFullText ? "Show less ▴" : "Show full text ▾"}
                </button>
                {/* Collapsing by hand does NOT release the pin, and that is not an oversight: while
                    the header is collapsed the observer early-returns on `headerCollapsed` anyway,
                    and every path back to Full writes `headerPinned` itself (`showOriginal` → true,
                    `runSearch` → false). So the pin's value here is never read — releasing it was
                    written first, passed every test, and was removed for that reason. */}
                <button
                  type="button"
                  onClick={() => setHeaderCollapsed(true)}
                  className="text-muted-foreground text-xs underline-offset-4 hover:underline"
                >
                  Collapse ▴
                </button>
              </div>
              {/* Honest lower bound: a concept goes unmarked when the matcher canonicalised it to a
                  form not verbatim in the paste — never because it was ignored. Shown only when
                  something is actually unmarked; sits at the card foot, ruled off, per the mockup. */}
              {concepts.length > 0 && askMarked < concepts.length ? (
                <p className="text-muted-foreground border-border mt-3 border-t pt-2.5 text-[11px] leading-[1.5]">
                  {askMarked} of {concepts.length} concepts are highlighted — a concept goes unmarked
                  when the matcher wrote it in standard terms (an abbreviation expanded, a brand
                  resolved). Unmarked never means ignored.
                </p>
              ) : null}
            </section>
            {/* D10 — the collapse sentinel sits just past the header; when it scrolls above the
                viewport top the observer pins the compact bar. `aria-hidden` — it is a scroll probe. */}
            <div
              ref={sentinelRef}
              data-slot="matcha-ask-sentinel"
              aria-hidden="true"
              className="h-0"
            />
          </div>
        )
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(description);
          }}
          className="mb-4"
        >
          <label htmlFor="matcha-description" className="mb-1.5 block text-sm font-medium">
            The ask
          </label>
          <textarea
            id="matcha-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder="Paste the sponsor's description of their interest…"
            className="border-border w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
            spellCheck={false}
          />
          {/* Slate, not `variant="apollo"` (maroon) — the whole matcher family (find-researchers,
              opportunity intake, and the mockup) is slate. */}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              disabled={pending || description.trim().length === 0}
              className="bg-[var(--color-accent-slate)] text-white hover:bg-[var(--color-accent-slate)]/90"
            >
              {pending ? "Ranking…" : "Rank researchers"}
            </Button>
            {historyDrawer}
          </div>
        </form>
      )}

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
          {/* The ask (title + read-only, highlighted request) renders in the ask card above,
              in place of the textarea — see `showAskCard`. */}
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
                    data-slot="matcha-preferences"
                    className="border-border mb-3 rounded-lg border p-3"
                  >
                    <h2 className="text-base font-semibold">Preferences</h2>
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
                  data-slot="matcha-facets"
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
                  {/* gap-4 BETWEEN groups, tighter WITHIN: three adjacent pill groups with a
                      near-equal gap read as one long undifferentiated row (the D3 dial made it
                      seven pills), and the officer can no longer see which pill answers which
                      question. The container wraps, so the extra width costs nothing.
                      Within-group spacing is gap-1 for the recency dial and the density toggle, and
                      ZERO for the sort pair, which is conjoined into one segmented control — a
                      tighter bond than the other two, not a fourth idiom. The three-group read is
                      what gap-4 protects; do not flatten it. */}
                  <div className="ml-auto flex flex-wrap items-center gap-4">
                    {/* D3 — recency dial. Same detached-pill idiom as the density toggle. Hidden
                        entirely when the payload carries no years, because a dial that cannot move
                        anything is worse than no dial. "Since" reveals a native year picker — a soft
                        cutoff that down-weights older evidence to the floor, never hides it (D4). */}
                    {hasRecencyData ? (
                      <div role="group" aria-label="Recency" className="flex items-center gap-1">
                        {RECENCY_TABS.map((t) => {
                          const active =
                            t.key === "since" ? typeof recency === "object" : recency === t.key;
                          return (
                            <button
                              key={t.key}
                              type="button"
                              aria-pressed={active}
                              onClick={() =>
                                setRecency(
                                  t.key === "since"
                                    ? { since: currentYear - RECENCY_SINCE_DEFAULT_AGE }
                                    : t.key,
                                )
                              }
                              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                                active
                                  ? "border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
                                  : "border-border text-foreground/80 hover:border-[var(--color-accent-slate)]"
                              }`}
                            >
                              {t.label}
                            </button>
                          );
                        })}
                        {typeof recency === "object" ? (
                          <select
                            aria-label="Recency cutoff year"
                            value={recency.since}
                            onChange={(e) => setRecency({ since: Number(e.target.value) })}
                            className="border-border bg-background text-foreground/80 rounded-full border px-1.5 py-0.5 text-xs"
                          >
                            {Array.from({ length: RECENCY_SINCE_SPAN }, (_, i) => currentYear - i).map(
                              (y) => (
                                <option key={y} value={y}>
                                  {y}
                                </option>
                              ),
                            )}
                          </select>
                        ) : null}
                      </div>
                    ) : null}
                    {/* D8 — density toggle. Detached pills, like the recency dial beside it — NOT
                        like the sort pair, which is conjoined. */}
                    <div
                      role="group"
                      aria-label="Result density"
                      className="flex items-center gap-1"
                    >
                      {(["detailed", "compact"] as const).map((d) => (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={density === d}
                          onClick={() => setDensity(d)}
                          className={`rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors ${
                            density === d
                              ? "border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
                              : "border-border text-foreground/80 hover:border-[var(--color-accent-slate)]"
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                    {/* Fit/Name are CONJOINED into one segmented control — no gap, one shared
                        border, radius on the pair's outer edges only. They are not two questions
                        like the groups either side of them; they are two positions of ONE, and
                        mutually exclusive, so the control should look like something with a
                        position rather than like two independent toggles that happen to disagree.
                        This TIGHTENS the pair within the three-group header — the gap-4 between
                        groups above still does the grouping, and must stay. `-ml-px` laps the
                        second pill's border onto the first's so the seam is one line, not two;
                        `z-10` on the active pill lifts its slate edge over that seam. */}
                    <div role="group" aria-label="Sort researchers" className="flex items-center">
                      {SORT_TABS.map((t, i) => (
                        <button
                          key={t.key}
                          type="button"
                          aria-pressed={sort === t.key}
                          onClick={() => setSort(t.key)}
                          className={`relative border px-2.5 py-0.5 text-xs transition-colors ${
                            i === 0 ? "rounded-l-full" : "-ml-px"
                          } ${i === SORT_TABS.length - 1 ? "rounded-r-full" : ""} ${
                            sort === t.key
                              ? "z-10 border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
                              : "border-border text-foreground/80 hover:border-[var(--color-accent-slate)]"
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    {/* Once a shortlist exists this button RENAMES rather than disappears: the
                        unqualified "Export" is then the shortlist's, in the bar below, and this
                        one has to say out loud that it is the wider list. An officer who ticks
                        three rows and presses a button still labelled "Export (400)" gets 400
                        rows — and would have no reason to look at the filename to find out. */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={exportFiltered}
                      disabled={filtered.length === 0}
                    >
                      <Download className="size-3.5" />
                      {shortlistRows.length > 0
                        ? `Export all (${filtered.length})`
                        : `Export (${filtered.length})`}
                    </Button>
                  </div>
                </div>

                {filterChips.length > 0 ? (
                  <div
                    data-slot="matcha-active-filters"
                    className="mb-3 flex flex-wrap items-center gap-1.5"
                  >
                    {filterChips.map((chip) => (
                      <span
                        key={chip.key}
                        className="border-border bg-muted/40 inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 text-xs"
                      >
                        <span className="max-w-[16rem] truncate">{chip.label}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${chip.label} filter`}
                          onClick={chip.onRemove}
                          className="text-muted-foreground hover:text-foreground leading-none"
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="text-muted-foreground ml-1 text-xs underline-offset-4 hover:underline"
                    >
                      Clear all
                    </button>
                  </div>
                ) : null}

                {/* The shortlist bar. It carries exactly ONE action, because exactly one exists:
                    Compare and "Draft sponsor intro" are parked (2026-07-16, decisions 4/5) and
                    are not stubbed here — a disabled button for an unbuilt feature is a promise
                    the surface cannot keep, and this console has shipped enough inert controls.
                    The count is `shortlistRows`, not `shortlist.size`, so it counts what Export
                    will actually write rather than what the Set remembers. */}
                {shortlistRows.length > 0 ? (
                  <div
                    data-slot="matcha-shortlist"
                    className="border-border bg-muted/40 mb-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
                  >
                    <span className="text-sm font-medium">
                      {shortlistRows.length} shortlisted
                    </span>
                    <span className="text-muted-foreground text-sm" aria-hidden="true">
                      ·
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={exportShortlist}>
                      <Download className="size-3.5" />
                      Export shortlist ({shortlistRows.length})
                    </Button>
                  </div>
                ) : null}

                {visible.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-sm">
                    No researchers match the selected filters.
                  </p>
                ) : (
                  <>
                    <ul>
                      {primaryRows.map(({ c, rank }) => (
                        <li key={c.cwid}>{renderResult({ c, rank })}</li>
                      ))}
                    </ul>

                    {/* The relevance floor: everything in the weak tier collapses into one bar the
                        officer can open — a toggle, never a silent cut. The divider names the line. */}
                    {collapsedWeak.length > 0 ? (
                      <div data-slot="matcha-floor">
                        <div className="my-4 flex items-center gap-3" aria-hidden="true">
                          <div className="border-border h-0 flex-1 border-t border-dashed" />
                          <span className="text-muted-foreground text-[11px] tracking-[0.04em]">
                            RELEVANCE FLOOR
                          </span>
                          <div className="border-border h-0 flex-1 border-t border-dashed" />
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowWeak((v) => !v)}
                          aria-expanded={showWeak}
                          className="bg-muted/40 hover:bg-muted/60 flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors"
                        >
                          <span className="text-muted-foreground">
                            {collapsedWeak.length} weaker match{collapsedWeak.length === 1 ? "" : "es"}{" "}
                            — below {Math.round(TIER_GOOD * 100)}% of the top result
                          </span>
                          <span className="shrink-0 font-medium text-[var(--color-accent-slate)]">
                            {showWeak ? "Hide ↑" : "Show ↓"}
                          </span>
                        </button>
                        {showWeak ? (
                          <ul className="mt-4">
                            {collapsedWeak.map(({ c, rank }) => (
                              <li key={c.cwid}>{renderResult({ c, rank })}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}

                    {/* Excluded entirely (not collapsed): scholars the spine ranked but shipped no
                        research-match evidence for. A count, not names — a results view names people
                        it is FOR, not the ones it rejected. */}
                    {excludedCount > 0 ? (
                      <p className="text-muted-foreground mt-4 text-[11px]">
                        {excludedCount} with no evidence hidden
                      </p>
                    ) : null}

                    {/* D4 — removed by the officer's own year cutoff. This count is the ONLY thing
                        standing between the filter and a silent wrong answer: an absent scholar is
                        unnoticeable (you cannot spot the expert who is not on the page), and the
                        year it filters on is `mostRecentPubDate`, which counts CURATED pubs only —
                        so an uncurated backlog reads as dormancy and removes a live expert. Naming
                        the escape ("Any") in the copy matters for the same reason: the officer has
                        to be told the door exists to think of opening it. Same count-not-names rule
                        as above. */}
                    {hiddenByYear > 0 ? (
                      <p className="text-muted-foreground mt-4 text-[11px]">
                        {hiddenByYear} hidden · no publication since {yearCutoff} — set recency to
                        “Any” to include them
                      </p>
                    ) : null}
                  </>
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
  concepts: MatchaConcept[];
  /** Terms to badge, computed once across the whole ask by `rareTerms`. */
  rare: ReadonlySet<string>;
  onCentralityChange: (term: string, centrality: number) => void;
}) {
  return (
    <div data-slot="matcha-concepts" className="border-border rounded-lg border p-3">
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
                  <HoverTooltip
                    wide
                    triggerClassName="ml-1.5"
                    text={`Scarce at Weill Cornell relative to the other concepts in this ask — ${oneInN(
                      c.corpusCoverage,
                    )}.`}
                  >
                    <span className="rounded-full bg-[var(--color-facet-method-fill)] px-1.5 py-0.5 text-xs text-[var(--color-facet-method-count)]">
                      ·rare
                    </span>
                  </HoverTooltip>
                ) : null}
              </span>
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {c.centrality.toFixed(2)}
              </span>
            </div>
            {/* The funder's own words for this concept — the qualifying context the canonical term
                strips. Shown once here, next to the concept it defines; the spine also SEARCHES it,
                so the ranking and this line are the same signal. Absent ⇒ nothing rendered. */}
            {c.gloss ? (
              <p className="text-muted-foreground text-xs italic leading-snug">
                sponsor&rsquo;s words: &ldquo;{c.gloss}&rdquo;
              </p>
            ) : null}
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
  /** What the GROUP measures. Hung on the group's heading, which is the thing it describes. */
  title?: string;
}) {
  return (
    <div className="mt-3">
      {/* The hover moved from every option row to the heading, and the anchor is the correction:
          the text describes the GROUP ("Years since terminal degree, bucketed"), so hanging it on
          each option asserted it of that option, and a group of five stamped the identical
          tooltip five times. It cannot go back on the `<label>` regardless — the tooltip wrapper
          becomes the flex item, and the row's `flex-1 truncate` value and `shrink-0` count would
          collapse to their natural widths, unaligning every count in the rail. */}
      {title ? (
        <HoverTooltip wide text={title}>
          <h3 className="text-muted-foreground decoration-muted-foreground/40 text-[11px] font-semibold tracking-[0.08em] uppercase underline decoration-dotted underline-offset-4">
            {label}
          </h3>
        </HoverTooltip>
      ) : (
        <h3 className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
          {label}
        </h3>
      )}
      <ul className="mt-1.5 space-y-1">
        {options.map(([value, n]) => (
          <li key={value}>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
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
 *  under that concept — but it is a SEPARATE state, not a lighter grade of found, and its tooltip
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

/** What the STRIP is — round-2 §4's actual complaint. Every segment already explained ITSELF
 *  ("Cancer Metabolism — no evidence") and nothing explained the row: eight anonymous bars whose
 *  widths encode a number the reader was never told was a number. A segment's own state is
 *  meaningless until you know the bar is one concept, the width is how hard the sponsor asked for
 *  it, and the fill is whether we can show evidence — so the legend rides EVERY segment tooltip
 *  rather than a caption the hover doesn't reach, and leads the strip's aria-label. */
/** ⚠ "this opportunity", not "the sponsor" — the audience is chairs, and an ask is as often an email
 *  or a few bullet points as a funding call (round-2 §3, user 2026-07-17). The strip's own spec text
 *  said "the sponsor's whole ask"; that framing is what §3 retires.
 *  ⚠ Not the literal words "the ask" either: this string rides the strip's `aria-label`, and the
 *  paste textarea is ALREADY labelled "the ask" — two accessible names matching the same phrase is
 *  a screen reader hearing one label for two unrelated things (and it collides in tests). */
const COVERAGE_LEGEND =
  "One bar per concept this opportunity calls for · width = how much it matters · fill = whether we can show evidence.";

/**
 * The ask, drawn as a bar: one segment per concept the sponsor asked for, width = how much they
 * asked for it. The width IS `conceptWeight` — the very number the fusion ranks on — so the bar
 * cannot drift from the ranking, and it re-draws live as the sliders move, exactly like the chips.
 *
 * The mockup's hover-to-trace (segment lights up its term row) is skipped: the segment tooltip
 * already names the concept, and cross-highlighting needs hover state threaded through every block
 * for a cue the tooltip gives. Add it when someone asks for it.
 *
 * ACCESSIBILITY: this used to be `aria-hidden`, on the reasoning that "a bar of eight divs is not a
 * thing a screen reader can be made to say usefully" and that the caption carried the same facts.
 * The first half is right; the second was false. The caption says "Evidence for 1 of 3" — a count,
 * naming no concept and no state — and the INLINE variant has no caption at all, so a screen reader
 * got a `w-[110px]` void. The strip is now one `role="img"` whose label reads the legend and then
 * every concept and its state: the graphic spoken as a sentence, which is the usual answer for a
 * data graphic and the one the old comment stopped one step short of.
 */
function CoverageStrip({ coverage, inline = false }: { coverage: ConceptCoverage[]; inline?: boolean }) {
  if (coverage.length === 0) return null;
  const withEvidence = coverage.filter((c) => c.state === "evidence");
  const spoken = coverage
    .map(({ concept, state }) => `${concept.term} — ${COVERAGE_TITLE[state]}`)
    .join("; ");
  const bar = (
    <div className="flex gap-0.5" role="img" aria-label={`Concept coverage. ${COVERAGE_LEGEND} ${spoken}`}>
      {coverage.map(({ concept, weight, state }) => (
        <HoverTooltip
          key={concept.term}
          wide
          text={`${concept.term} — ${COVERAGE_TITLE[state]}`}
          body={
            <span className="block">
              <span className="block font-semibold">{concept.term}</span>
              <span className="block">{COVERAGE_TITLE[state]}</span>
              <span className="mt-1 block border-t border-white/25 pt-1 text-white/70">
                {COVERAGE_LEGEND}
              </span>
            </span>
          }
          // THE WEIGHTS LIVE ON THE WRAPPER, and they have to: the wrapper is what the bar's flex
          // container sizes. Leave `flexGrow` on the child and every segment silently collapses to
          // `min-w-[3px]` — eight equal slivers, the widths (the ranking's own numbers) gone, and
          // not one test the poorer for it. `flexBasis: 0` so width is weight and nothing else; the
          // min-width keeps a near-muted concept hoverable instead of an invisible sliver.
          triggerStyle={{ flexGrow: weight, flexBasis: 0 }}
          triggerClassName="min-w-[3px]"
        >
          <span
            data-slot="matcha-coverage-segment"
            data-coverage={state}
            data-term={concept.term}
            className={`h-2 w-full rounded-[2px] ${COVERAGE_CLASS[state]}`}
          />
        </HoverTooltip>
      ))}
    </div>
  );
  // D8 — inline (compact-row) variant: the bar only, at a fixed width, no caption. The row's x/8
  // carries the count the caption would. Same segments as the detailed strip, so they read alike.
  if (inline) {
    return (
      <div className="w-[110px] shrink-0" data-slot="matcha-coverage">
        {bar}
      </div>
    );
  }
  return (
    <div className="mt-2" data-slot="matcha-coverage">
      {bar}
      {/* D7 — the "also ranked under X, Y" prose is gone. A sub-threshold hit is now carried by
          the strip's own lighter `ranked` fill (see COVERAGE_CLASS) and the segment's hover,
          not a sentence that duplicated it. The line states only the fact the strip can't: how many
          of the asked concepts we can SHOW evidence for. */}
      <p className="text-muted-foreground mt-1.5 text-xs">
        Evidence for {withEvidence.length} of {coverage.length} concepts asked
      </p>
    </div>
  );
}

/**
 * D8 — one scannable row per scholar: rank · name+title · tier · coverage strip · asks covered
 * (x/8) · latest-evidence year · ›. A button that expands to the detailed card in place.
 *
 * Everything here is client-derived from the candidate already in the browser — NO artifact fetch,
 * which is the whole point of the compact register: 100 rows cost 0 key-paper requests. `latest YYYY`
 * comes from `latestEvidenceYear`; D1 surfaced the per-scholar year on the production spine path
 * (`candidate.mostRecentYear`, under `SPONSOR_MATCH_RECENCY`), so the slot now renders there when the
 * flag is on. The bespoke path still reads `evidence.papers`. Absent (flag off / no year) ⇒ no year.
 *
 * D3/D8 — the year is FLAGGED (de-emphasised) below `staleYear`, the boundary derived from the
 * officer's active recency mode (`staleBefore`). Under "Any" the boundary is null and the year
 * renders unflagged: nothing is weighing recency there, so nothing may claim a match is stale.
 */
function CompactRow({
  candidate,
  rank,
  concepts,
  topScore,
  staleYear,
  onExpand,
  selected,
  onSelect,
}: {
  candidate: MatchaCandidate;
  rank: number;
  concepts: MatchaConcept[];
  topScore: number;
  /** D8 — flag the year below this; `null` ⇒ unflagged (see `staleBefore`). */
  staleYear: number | null;
  onExpand: () => void;
  /** Shortlist membership, and its toggle. Per-ask; owned by the panel (see `shortlist`). */
  selected: boolean;
  onSelect: () => void;
}) {
  const coverage = conceptCoverage(candidate, concepts);
  const withEvidence = coverage.filter((c) => c.state === "evidence").length;
  const tier = fitTier(candidate.fusedScore, topScore);
  const year = latestEvidenceYear(candidate);
  const stale = year != null && staleYear != null && year < staleYear;
  return (
    // THE ROOT IS A DIV, AND IT HAS TO BE. It was a `<button>` — the whole row was the expand
    // target — and a checkbox cannot live inside one: interactive content nested in a button is
    // invalid HTML, and the two click targets fight (the label's click bubbles to the button, so
    // ticking a row would also expand it). So the row splits into two siblings: the checkbox, and
    // a button that carries the expand and fills the rest of the width. The row LOOKS the same —
    // the border/padding/hover moved up to the div verbatim, and the button re-declares the flex
    // that used to be the root's — and `data-slot` stays on the root, which is what selects a row.
    <div
      data-slot="matcha-compact-row"
      className="border-border hover:bg-muted/40 flex w-full items-center gap-2.5 border-t px-2 py-2 transition-colors"
    >
      {/* Named for the PERSON, not "Select": the row's own name is the only thing that
          distinguishes 100 otherwise identical checkboxes to a screen reader. Same house
          checkbox as the facet rail — `FacetGroup`'s classes, verbatim. */}
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        aria-label={`Shortlist ${candidate.name}`}
        className="size-3.5 shrink-0 accent-[var(--color-accent-slate)]"
      />
      <button
        type="button"
        onClick={onExpand}
        aria-label={`Expand ${candidate.name}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span className="text-muted-foreground w-6 shrink-0 text-right text-xs tabular-nums">
          {rank}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-sm font-medium">{candidate.name}</span>
          {candidate.title ? (
            <span className="text-muted-foreground ml-1.5 text-xs">{candidate.title}</span>
          ) : null}
        </span>
        {/* Short tier word here (mockup's dense list), not the detailed card's "Strong fit". */}
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${TIER_CLASS[tier]}`}
        >
          {tier}
        </span>
        <CoverageStrip coverage={coverage} inline />
        <span className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums">
          {withEvidence}/{coverage.length}
        </span>
        {/* D8 — the stale flag is DE-EMPHASIS, not a hue, and deliberately so: every house colour is
            already spoken for (green = strong/tagged, amber = good-tier AND keyword-only, blue =
            provenance, purple = technology), so an "old" colour would make one of them mean three
            things. A stale year recedes instead — which is also what the ranker is doing to it.
            Which is exactly why the tooltip is LOAD-BEARING here and not a nicety: de-emphasis with
            no hue is a treatment that cannot say what it means, so the hover is the only thing that
            explains why this row is dimmer than the one above it. That made it the worst possible
            place for a `title` nobody waits 1s to read. */}
        {stale ? (
          <HoverTooltip
            wide
            triggerClassName="w-16 shrink-0 justify-end"
            text={`Latest evidence predates ${staleYear} — recency is down-weighting this match`}
          >
            <span
              data-slot="matcha-latest-year"
              className="text-muted-foreground/50 text-right text-[11px] tabular-nums"
            >
              {year != null ? `latest ${year}` : ""}
            </span>
          </HoverTooltip>
        ) : (
          <span
            data-slot="matcha-latest-year"
            className="text-muted-foreground w-16 shrink-0 text-right text-[11px] tabular-nums"
          >
            {year != null ? `latest ${year}` : ""}
          </span>
        )}
        <span className="text-muted-foreground shrink-0 text-xs" aria-hidden="true">
          ›
        </span>
      </button>
    </div>
  );
}

/** The provenance palette — the house green/amber tints (solid, not alpha) so the chips carry
 *  colour, not just a border. `tagged` reuses the strong-tier hue, `keyword` the position/warning
 *  hue; both already ship in `globals.css`. */
const PROVENANCE_META: Record<
  EvidenceProvenance,
  { mark: string; label: string; title: string; className: string }
> = {
  tagged: {
    mark: "✓",
    label: "subject-tagged",
    title:
      "Matched via a MeSH subject tag or a curated method/clinical/topic signal — structured, but not proof of the sponsor's specific sense.",
    className:
      "border-[var(--apollo-green-tint-border)] bg-[var(--apollo-green-tint)] text-[var(--apollo-green-foreground)]",
  },
  keyword: {
    mark: "⚠",
    label: "keyword only",
    title:
      "Matched on free text only — the concept's bare keyword, which can hit a paper unrelated to what the sponsor asked for.",
    className:
      "border-[var(--color-facet-position-border)] bg-[var(--color-facet-position-fill)] text-[var(--color-facet-position-text)]",
  },
};

/** How an evidence block landed — a structured tag vs a bare-keyword hit — as a small coloured chip
 *  that LEADS the block beside its concept, so the colour reads before the paper does. The honest,
 *  cheap half of the context-vs-keyword distinction: it says HOW the hit matched, never that it
 *  matched the sponsor's SENSE (a MeSH-tagged off-topic paper still reads `subject-tagged`).
 *  Renders nothing for evidence that carries no such signal. */
function ProvenanceChip({ evidence }: { evidence: ResultEvidence }) {
  const provenance = evidenceProvenance(evidence);
  if (!provenance) return null;
  const { mark, label, title, className } = PROVENANCE_META[provenance];
  return (
    <HoverTooltip wide text={title} triggerClassName="shrink-0">
      <span
        data-slot="matcha-provenance-chip"
        data-provenance={provenance}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-[0.02em] ${className}`}
      >
        <span aria-hidden="true">{mark}</span>
        {label}
      </span>
    </HoverTooltip>
  );
}

function ResearcherRow({
  candidate,
  rank,
  concepts,
  topScore,
  runId,
  onCollapse,
  selected,
  onSelect,
}: {
  candidate: MatchaCandidate;
  rank: number;
  concepts: MatchaConcept[];
  topScore: number;
  /** #1696 — the current ranking run. See `claimedPmids` below: this row can OUTLIVE a run. */
  runId: number;
  /** Put this card back to its compact row. OPTIONAL, and the option is the point: under Detailed
   *  density this card is not an expansion of anything, so there is no state to return to and the
   *  caller supplies nothing. Only the expanded-from-compact caller passes it (`renderResult`). */
  onCollapse?: () => void;
  /** Shortlist state. NOT optional, unlike `onCollapse` — the shortlist is a verb of the RESULT
   *  SET, not of a density. Detailed is the DEFAULT density (see `DENSITY_KEY`), so a checkbox that
   *  rendered only on compact rows would leave the whole feature invisible on first visit, and the
   *  selection bar — which is not density-gated — would then offer "Export shortlist (2)" over rows
   *  carrying no checkbox to audit or untick it with. The mockup draws the compact row only because
   *  that is the row it draws; it is silent on this card, which is not the same as forbidding it. */
  selected: boolean;
  onSelect: () => void;
}) {
  const name = candidate.name;
  // Chips + tier are DERIVED, never wired — so both stay live under the sliders. The raw
  // fused score is never rendered: it is an RRF sum and means nothing on its own.
  // The whole ask, not just the part this person answered — the only thing on the card that can
  // say what they DON'T have. Live under the sliders, like everything else derived here.
  const coverage = conceptCoverage(candidate, concepts);
  // The concepts the sponsor asked for that this scholar has NOTHING for — moved off the coverage
  // strip's caption to a single muted line at the card's foot (mockup), where a gap belongs: after
  // the evidence, not ahead of it.
  const gaps = coverage.filter((c) => c.state === "none");
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

  return (
    // Each candidate is its own bordered card (mockup): a full border + radius replacing the old
    // top-rule divider, so a card's variable-height evidence stack reads as one unit. The pool rank
    // keeps its own left column (mockup nit) — first in the row, aligned down the margin — so a
    // filter/sort that reorders cards still shows each one its POOL rank ("#30 overall").
    <div
      ref={rowRef}
      data-slot="matcha-row"
      className="border-border mb-4 flex gap-3 rounded-xl border p-5"
    >
      {/* Rank over checkbox, sharing the compact row's left margin so the tick column runs straight
          down the list whichever density you are in. Same markup as the compact row's — one
          affordance, drawn once. */}
      <div className="flex w-6 shrink-0 flex-col items-end gap-2 pt-1">
        <span className="text-muted-foreground text-sm tabular-nums">{rank}</span>
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          aria-label={`Shortlist ${candidate.name}`}
          className="size-3.5 shrink-0 accent-[var(--color-accent-slate)]"
        />
      </div>
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
          {/* The way back. `↑` is this file's existing word for "collapse" — the relevance floor's
              toggle already reads "Hide ↑" — rather than a third glyph for a second idea; the
              compact row's `›` is its opposite number. It needs a REAL name because it is the only
              control on a card whose visible content is a single character, and "button" is not a
              thing an officer with 100 rows open can act on. */}
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              aria-label={`Collapse ${name}`}
              className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-xs leading-none"
            >
              ↑
            </button>
          ) : null}
        </div>
        {candidate.department ? (
          <div className="text-muted-foreground text-sm">{candidate.department}</div>
        ) : null}
        <CoverageStrip coverage={coverage} />
        {/* The matched-concept CHIPS used to live here. Deleted: every concept they named is now
            named by something that also says something — the strip (with its weight), the block
            captions (with their evidence), and the coverage line (with the gaps). A row of pills
            repeating those names was the third listing of the same set. */}
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
          <div className="mt-2 space-y-2.5">
            {/* PRIMARY register — the strongest concepts carry the full artifact. */}
            {evidenceBlocks.slice(0, PRIMARY_BLOCKS).map(({ concept, evidence }, i) => (
              // `runId` in the key is the OTHER HALF of the claimedPmids reset above, and it is
              // required: a fresh Set is useless if the `EvidenceLine` beneath keeps its one-shot
              // `keyPaperFetched` ref from the last run and never fetches again. Baking the run
              // into the key remounts the line, dropping that guard along with its expand state
              // and any papers it resolved for the PREVIOUS paste. (Same two-part idiom as
              // `people-result-card.tsx`, which bakes `qParam` into both.) `term` alone keeps a
              // card's sibling blocks distinct WITHIN a run.
              <div key={`${runId}:${concept.term}`} data-slot="matcha-evidence">
                {/* The concept, its provenance, and what the sponsor asked for it — the facts the
                    block answers, on one line. The provenance chip LEADS the block (colour first),
                    so an officer sees whether a hit is structured or keyword-only before reading the
                    paper. `centrality` is the slider's own value — the number the officer set. */}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-foreground text-sm font-semibold">{concept.term}</span>
                    <ProvenanceChip evidence={evidence.evidence} />
                  </span>
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
            {/* SUPPORTING register — the weaker matched concepts demote to a one-line row: the
                concept, its ask weight, and the tagged paper count. It does NOT mount an
                `EvidenceLine`, so it fires no key-paper fetch (fewer requests per card) — which
                is also why it carries no role or year: those live in the artifact it never
                fetched. Absent ≠ hidden: the concept and its count are the honest supporting fact. */}
            {evidenceBlocks.slice(PRIMARY_BLOCKS).map(({ concept, evidence }) => {
              // The MATCHED count for THIS concept — not `pubCount`, which is the scholar's total and
              // is identical for every concept on the card (the count "seemed off" because it was the
              // same big number everywhere). Absent for a countless kind ⇒ render no count, never the
              // total.
              const matched = evidenceMatchCount(evidence.evidence);
              return (
                <div
                  key={`${runId}:${concept.term}`}
                  data-slot="matcha-evidence-supporting"
                  className="border-border flex items-baseline justify-between gap-2 border-t pt-2.5 text-sm"
                >
                  <span className="text-muted-foreground">
                    {concept.term}{" "}
                    <span className="text-[11px] tabular-nums">{concept.centrality.toFixed(2)}</span>
                  </span>
                  {matched != null ? (
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {matched} of {evidence.pubCount} pub{evidence.pubCount === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {/* The "ranked, no evidence shown" rows used to live here, one per concept. Deleted: the
            strip's lighter `ranked` segment now carries that fact (D7), and a per-concept row said
            it in a way that read as a contradiction of the count beside it. */}
        {topics.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {topics.map((t) => (
              <HoverTooltip
                key={t.label}
                text={`${t.pubCount} matching paper${t.pubCount === 1 ? "" : "s"} in this topic`}
              >
                <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-xs">
                  {t.label}
                </span>
              </HoverTooltip>
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
          // `mt-1.5` rides the WRAPPER: it is the inline-level box the surrounding block lays out
          // now, so a margin left on the child would indent inside the wrapper instead of spacing
          // the badge off the block above it.
          <HoverTooltip
            wide
            triggerClassName="mt-1.5"
            text="Licensable technologies this researcher already holds in the CTL portfolio."
          >
            <span className="inline-flex rounded-full bg-[#e0eded] px-2 py-0.5 text-xs font-medium text-[#2c5862]">
              {candidate.technologyCount} CTL technolog
              {candidate.technologyCount === 1 ? "y" : "ies"}
            </span>
          </HoverTooltip>
        ) : null}
        {/* Gaps at the foot of the card (mockup): the sponsor asks this scholar answers with
            nothing. A single muted line, not a per-concept row — it is the last thing read, and it
            is context for the evidence above it, not a headline. */}
        {gaps.length > 0 ? (
          <div
            data-slot="matcha-gaps"
            className="border-border mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t pt-2.5"
          >
            <span className="rounded bg-[var(--color-facet-position-fill)] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.02em] text-[var(--color-facet-position-text)]">
              No evidence
            </span>
            <span className="text-muted-foreground text-xs">
              {gaps.map((g) => g.concept.term).join(" · ")}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
