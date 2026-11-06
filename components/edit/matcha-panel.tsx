"use client";

/**
 * CTL sponsor match — paste a commercial sponsor's description (an email or a
 * call transcript), rank WCM researchers on topical fit ALONE. One POST to
 * `/api/edit/matcha`; no stage axis, no ESI, no intake queue — those axes belong
 * to the Funding matcher, whose URL-scrape intake cannot take a sponsor's email
 * in the first place, which is why this is a separate surface at all.
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
 * next to `/edit/grant-matcha` under the Apollo bar, so it keeps the console's h1, its list
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
import {
  Download,
  ExternalLink,
  FileText,
  Lock,
  Mail,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { EvidenceLine } from "@/components/search/evidence-line";
import type { ResultEvidence } from "@/lib/api/result-evidence";
import { Button } from "@/components/ui/button";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  conceptCoverage,
  assessMatchSignal,
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
  type CulledConcept,
  type RecencyMode,
  type EvidenceProvenance,
  type MatchaCandidate,
  type MatchaConcept,
  type MatchaFitTier,
  type MatchaResponse,
  type MatchaPreference,
  type MatchSignal,
  type MatchaMeasures,
  RESEARCHER_TYPE_LABEL,
  RESEARCHER_TYPE_ORDER,
  RESEARCH_ACTIVE_YEARS,
  type GrantCandidate,
} from "@/lib/api/matcha-contract";
import type { CareerStage } from "@/lib/career-stage";
import { RESEARCH_TYPE_MIN_PUBS } from "@/lib/research-type";
import { briefCsvFields, buildMatchaCsv } from "@/lib/edit/matcha-export";
import {
  briefAngle,
  briefSourceLabel,
  briefSourceUrl,
  briefTopics,
  briefWhy,
  firstSentence,
  methodLabel,
  methodsSummary,
  reporterUrl,
  UNSOURCED_LABEL,
  type BriefRecords,
  type BriefWire,
} from "@/lib/edit/matcha-brief-types";
import {
  MAILTO_SOFT_LIMIT,
  addressList,
  buildGroupEmail,
  buildMailto,
  buildPersonEmail,
  emailFocus,
} from "@/lib/edit/matcha-email";
import { readOverviewStream } from "@/lib/edit/overview-stream";
import type { EligibilityRequirements } from "@/lib/funding/screening";
import {
  careerStageLabel,
  roleCategoryLabel,
  deadlineLabel,
  dueUrgency,
  formatUsd,
} from "@/lib/match-display";
import { extractLastNameSort } from "@/lib/name-sort";
import { profilePath } from "@/lib/profile-url";
import { markPaste, markedConceptCount } from "@/lib/matcha-paste-highlight";
import { Caret, SUMMARY_NO_MARKER } from "@/components/ui/caret";

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
  /** Runs of this paste in the viewer's scope (the row is the newest). Absent on older payloads. */
  runCount?: number;
  /** The viewer ran this paste at least once — the drawer's Mine filter. */
  mine?: boolean;
};

/** Whose retained searches this list holds — the SERVER's verdict, not a second one derived from
 *  the page's session (§9). `"all"` only for a superuser; everything else is the viewer's own. */
type HistoryScope = "all" | "own";

/** Facet groups stay scannable: top-N by researcher coverage. As a vertical checkbox panel
 *  (rather than the old wrapping chip row) an uncapped department list runs to ~20 rows on a
 *  broad paste and swamps the rail — and the tail is all count-1 departments, which are the
 *  least useful thing to filter by. Both groups cap the same way. */
/** #1780 Phase 2 — total-term ceiling once the officer manually adds culled terms. Mirrors the
 *  spine's `MAX_TERMS_WITH_INCLUDES`; the chips disable when the searched set reaches it. */
const MAX_TERMS_WITH_INCLUDES = 12;
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
 *  scope"). It names the input shapes and says the output is ranked people with openable evidence
 *  you can re-weight. The always-visible subtitle was removed in the warm-palette redesign — this
 *  copy now backs the h1's hover `ⓘ` (the "on the page" explainer; the nav-tab hover serves the
 *  "before you land" moment). Keep it verbatim: §5 of the redesign handoff quotes this exact text.
 *  ⚠ "Recommendations, not endorsements" was dropped DELIBERATELY (user, 2026-07-17), not lost —
 *  do not re-add it here on the assumption that its absence is an oversight. (It last stood on the
 *  Funding matcher, retired by the find-researchers sunset.) */
const MATCHA_BLURB =
  "Paste any ask — a funding call, a request for collaborators, an email, a few bullet points. Matcha pulls out the topics and methods it's really asking for, weighs how much each one matters, and ranks scholars by fit across all of them. Every recommendation comes with the evidence behind it, and you can adjust the weights to re-rank on the spot.";

/** Three-register hierarchy (mockup): the first N matched concepts render as FULL evidence blocks
 *  (badge, artifact, role, recency); the rest demote to a one-line supporting row. `matchedEvidence`
 *  hands blocks back strongest-first, so the primary N are the strongest N. A demoted row does NOT
 *  fetch its artifact — that is what makes demoting it cheaper, and why it shows only the tagged
 *  count, never a role or year it never fetched. */
const PRIMARY_BLOCKS = 2;

/** Three numbers, and they are three DIFFERENT things: how many rows we painted, how many the
 *  filters matched, how many are in the pool. The old header printed two of them as if they
 *  were one ("100 of 100 researchers", while the history row beside it said 430). Say all
 *  three, or say the one that is true.
 *
 *  `gateHidden` (Grant Matcha) is what the hard eligibility gate dropped from `matched` — and
 *  `matched` is the POST-gate count. The header once passed the pre-gate count there, which put
 *  two pipelines in one phrase: a postdoc-only gate over a faculty pool rendered "Top 0 of 77"
 *  above an empty list. When the gate is hiding anyone, `matched` is named "eligible" and the
 *  hidden count is said out loud, so every number in the phrase comes from one stage. */
export function resultsSummary(
  shown: number,
  matched: number,
  pool: number,
  gateHidden = 0,
): string {
  const head = shown < matched ? `Top ${shown} of ${matched}` : `${matched}`;
  if (gateHidden > 0) {
    // `matched + gateHidden` is the pre-gate filter-match count, so `< pool` still means "an
    // earlier stage (the year window or the facet filters) is ALSO narrowing" — the only case
    // that earns naming the pool.
    const base =
      matched + gateHidden < pool ? `${head} matching · ${pool} ranked` : `${head} eligible`;
    return `${base} · ${gateHidden} filtered by eligibility`;
  }
  if (matched < pool) return `${head} matching · ${pool} ranked`;
  return `${head} researcher${matched === 1 ? "" : "s"}`;
}

/** Coverage 7.17e-4 → "about 1 in 1,400 papers". Reads better than a fraction in a tooltip. */
function oneInN(coverage: number): string {
  return `about 1 in ${Math.round(1 / coverage).toLocaleString()} Weill Cornell papers`;
}

/** Matcha Empty State redesign — "Aug 20, 2026" for a retained search's `createdAt`. Unlike
 *  `formatDue` (lib/match-display.ts), `createdAt` is a real timestamp, not a date-only DB
 *  column, so this renders in the viewer's local time rather than pinning UTC. */
function formatSubmittedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

/** Grant-path reskin (Matcha Redesign.dc.html) — the artboard's segmented pill: greige track,
 *  white active segment with a shadow. CHROME ONLY: every control keeps its role/aria wiring,
 *  and `/edit/matcha` (no `eligibility`) keeps its detached-pill chrome verbatim. */
const SEG_TRACK =
  "border-apollo-border bg-apollo-surface-2 inline-flex items-center rounded-lg border p-[3px]";
const segClass = (active: boolean) =>
  `rounded-md px-2.5 py-1 text-[12.5px] transition-colors ${
    active
      ? "bg-white font-semibold text-foreground shadow-[0_1px_2px_rgba(34,30,28,0.1)]"
      : "text-foreground/80 hover:text-foreground"
  }`;

/** The grant table's grid — the artboard's six columns (# / Researcher / Match / Evidence /
 *  Latest work / chevron). Shared by the header row and every compact row so they cannot
 *  misalign. The shortlist checkbox rides a fixed cell BEFORE this grid (see `CompactRow`'s
 *  table branch): the artboard omits it, and artboard omission is not a removal decision. */
const GRANT_TABLE_COLUMNS = "34px minmax(200px,1fr) 120px minmax(120px,0.6fr) 90px 24px";

/** Artboard match-chip tones for the grant table: green tint = strong, amber tint = good,
 *  neutral greige = weak. Every value is a house token; borderless per the artboard. */
const GRANT_TIER_CLASS: Record<MatchaFitTier, string> = {
  strong: "bg-apollo-green-tint text-apollo-green-foreground",
  good: "bg-apollo-amber-tint text-apollo-amber",
  weak: "bg-apollo-surface-2 text-muted-foreground",
};

/** D3 — the recency dial. Stays DETACHED pills: it is a three-mode dial with a year sub-control, not
 *  a clean binary, so it does not conjoin the way the density and sort pairs now do (see the header).
 *  "Since" carries a year, so it opens on a sensible cutoff and offers a span back from today. */
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

/** The sponsor console's default researcher-type selection: everyone but "Clinician". CTL's
 *  usual ask is a lab to partner with; the clinicians stay one click away (consultant or
 *  patient-data asks). "Unclassified" stays in, since it holds scientists funded outside NIH. */
/** The sponsor console's default person-type selection (a `roleCategoryLabel` value). */
const DEFAULT_PERSON_TYPE = roleCategoryLabel("full_time_faculty");

const DEFAULT_RESEARCHER_TYPES: ReadonlySet<string> = new Set(
  RESEARCHER_TYPE_ORDER.filter((t) => t !== "clinician").map((t) => RESEARCHER_TYPE_LABEL[t]),
);

/** Why this scholar got their researcher type, the pill's hover. */
function researcherTypeReason(m: MatchaMeasures): string {
  const inWindow = `in the last ${RESEARCH_ACTIVE_YEARS} years`;
  const lab = m.labPubs5y ?? 0;
  const clinical = m.clinicalPubs5y ?? 0;
  const award = m.researchAward
    ? `PI on ${m.researchAward.label} funding, ${
        m.researchAward.endYear >= new Date().getFullYear() ? "active through" : "ended"
      } ${m.researchAward.endYear}`
    : null;
  const labText =
    lab >= RESEARCH_TYPE_MIN_PUBS ? `${lab} first/last-author lab research papers ${inWindow}` : null;
  const clinicalText =
    clinical >= RESEARCH_TYPE_MIN_PUBS ? ` ${clinical} first/last-author clinical research papers.` : "";
  // Funded but the award is withheld (hidden Funding section) and no lab volume.
  const evidence = [award, labText].filter(Boolean).join("; ") || `PI on a research award ${inWindow}`;
  switch (m.researcherType) {
    case "physician_scientist":
      return `${evidence}. Has a clinical profile.${clinicalText}`;
    case "basic_scientist":
      return `${evidence}. No clinical profile.${clinicalText}`;
    case "clinician":
      return `Has a clinical profile, but no research award as PI and under ${RESEARCH_TYPE_MIN_PUBS} lab papers ${inWindow}.${clinicalText}`;
    case "unclassified":
      return `No research award as PI and under ${RESEARCH_TYPE_MIN_PUBS} first/last-author lab papers ${inWindow}.${clinicalText}${
        m.roleCategory === "part_time_faculty" || m.roleCategory === "affiliated_faculty"
          ? " Part-time and affiliated faculty often hold awards and see patients elsewhere, so this is unknown, not no."
          : ""
      }`;
    default:
      return "";
  }
}

/** The active-filter chip, phrased by whichever side is shorter: the default reads
 *  "all but Clinician", not a list of three. */
function researcherTypeChip(selected: ReadonlySet<string>, present: readonly string[]): string {
  const on = present.filter((l) => selected.has(l));
  const off = present.filter((l) => !selected.has(l));
  if (on.length === 0) return `Researcher type: hiding all ${off.join(", ")}`;
  return off.length > 0 && off.length < on.length
    ? `Researcher type: all but ${off.join(", ")}`
    : `Researcher type: ${on.join(", ")}`;
}

function ResearcherTypePill({ measures }: { measures?: MatchaMeasures }) {
  const type = measures?.researcherType;
  if (!type) return null;
  return (
    <HoverTooltip wide text={researcherTypeReason(measures)}>
      <span className="border-border text-muted-foreground inline-flex shrink-0 rounded-full border px-2 py-0.5 text-xs">
        {RESEARCHER_TYPE_LABEL[type]}
      </span>
    </HoverTooltip>
  );
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

// `EligibilityRequirements` moved to `lib/funding/screening.ts` beside `requirementsFrom`
// (browse data-wiring 2026-08 — the list route derives eligibility labels server-side and must
// not import a client component). Re-exported so this panel's consumers keep importing it here.
export type { EligibilityRequirements };

/** Per-row eligibility verdict. `eligible`/`relaxed` are computed from the opportunity's stated
 *  rule; `filtered` is asserted by the eligibility floor for the rows the gate dropped. */
export type EligBadge = "eligible" | "relaxed" | "filtered";

const ELIG_BADGE_TEXT: Record<EligBadge, string> = {
  eligible: "Eligible",
  relaxed: "Relaxed",
  filtered: "Ineligible",
};

const ELIG_BADGE_CLASS: Record<EligBadge, string> = {
  eligible: "bg-elig-border/15 text-elig-text",
  relaxed: "bg-apollo-amber-tint text-apollo-amber border border-apollo-amber-tint-border",
  filtered: "text-muted-foreground border border-dashed border-border",
};

/** Copy for the ask card's thin-match caution, keyed on `assessMatchSignal`'s `reason` — see
 *  `MatchSignal`'s doc comment in matcha-contract.ts for what each case means. */
const THIN_SIGNAL_COPY: Record<Extract<MatchSignal, { thin: true }>["reason"], string> = {
  "single-broad-concept":
    "This match is based on a single broad concept — it may surface anyone who touches the general category, not the funder's specific target.",
  "single-bare-method":
    "This match is based on a single method with nothing to narrow it — it may surface anyone using that method, regardless of disease or population.",
};

/** The inline eligibility pill (mockup: badge inline, beside the fit tier). */
function EligBadgePill({ badge }: { badge: EligBadge }) {
  return (
    <span
      data-slot="matcha-elig-badge"
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${ELIG_BADGE_CLASS[badge]}`}
    >
      {ELIG_BADGE_TEXT[badge]}
    </span>
  );
}

export function MatchaPanel({
  initialDescription,
  autoRun,
  grantMatcha = false,
  eligibility,
  allowEditPaste = true,
  sourceUrl,
  matchaBrief = false,
}: {
  /** Grant Matcha — seed the ask from an opportunity's title + synopsis so the officer lands on
   *  the extracted concepts + ranked researchers instead of a blank textarea. */
  initialDescription?: string;
  /** Run the seeded ask once on mount (opportunity → people). No-op without initialDescription. */
  autoRun?: boolean;
  /** Grant Matcha (increment 3) — show the people|grants target toggle. Server-computed from
   *  `GRANT_MATCHA`; the API route re-checks the flag as the real boundary. */
  grantMatcha?: boolean;
  /** Grant Matcha — THIS opportunity's eligibility requirements. Presence is the whole gate:
   *  absent ⇒ `/edit/matcha`, which renders no eligibility axes, filters nobody, and does not
   *  ask the route for signals. The rail is RELEVANCE-DRIVEN — an axis renders only when the
   *  opportunity actually carries that requirement, so most opportunities show 0–2 axes. */
  eligibility?: EligibilityRequirements;
  /** Default true (`/edit/matcha`, search): the ask IS user-typed, so editing it back is the
   *  point. Grant Matcha seeds the ask from the opportunity record — source-originated data,
   *  not user input — so `grant-matcha-panel.tsx` passes `false` and drops "Edit paste"
   *  (redesign 2026-08, owner: "editing the paste doesn't make sense" for that case).
   *  `/edit/matcha`'s own paste-an-email flow is unaffected either way. */
  allowEditPaste?: boolean;
  /** Grant Matcha — the opportunity's own landing page, off the SAME detail fetch that seeds
   *  the ask (`grant-matcha-panel.tsx`). Read ONLY by the nothing-extracted empty state (the
   *  NIGMS RM1 case), where the FOA's full text is the recovery path and this is the link to
   *  it. Absent — the email path, or an opportunity without one — renders exactly as before. */
  sourceUrl?: string | null;
  /** Matcha Phase 3 — per-PI briefs + search Rename. Server-computed from `MATCHA_BRIEF` (the
   *  brief route re-checks it). Off ⇒ the panel renders exactly as before. */
  matchaBrief?: boolean;
} = {}) {
  const [description, setDescription] = useState(initialDescription ?? "");
  // Grant Matcha — which corpus this ask searches. "grants" POSTs `{ target: "grants" }` and
  // renders GrantCandidate cards; "people" is the original sponsor→researcher path. Toggle is only
  // reachable when `grantMatcha`, so this is pinned to "people" on the dark surface.
  const [target, setTarget] = useState<"people" | "grants">("people");
  const [grantCandidates, setGrantCandidates] = useState<GrantCandidate[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // The paste is EDITABLE until a search commits, then the ask (title + read-only, highlighted
  // request + Edit/Re-run) takes its place — the mockup's "THE ASK" section. "Edit paste"
  // flips this back to the textarea. Starts true (nothing searched yet).
  const [editing, setEditing] = useState(true);
  // D11 — the read-only paste clamps to ~4 lines until the officer asks for the rest. Reset per
  // search so a new paste always starts clamped.
  const [showFullText, setShowFullText] = useState(false);
  // Grant-path reskin — the highlighted source text sits behind a collapsed-by-default
  // disclosure ("Show source text with matched concepts"). Reset per search like the clamp
  // above; unused (always false, nothing reads it) on `/edit/matcha`, where the paste stays
  // inline.
  const [showSource, setShowSource] = useState(false);
  const [history, setHistory] = useState<Submission[]>([]);
  /** Defaults to `"own"` so a response without a `scope` never renders a submitter column the
   *  server did not authorise — the same fail-closed direction the route's `where` takes. */
  const [historyScope, setHistoryScope] = useState<HistoryScope>("own");
  // Recent-searches drawer (Matcha.dc.html) — one controlled Sheet, opened from every path.
  // Its search, scope and per-row menu/confirm state touch nothing else on the page.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerQuery, setDrawerQuery] = useState("");
  const [drawerScope, setDrawerScope] = useState<"everyone" | "mine">("everyone");
  const [recentMenuFor, setRecentMenuFor] = useState<string | null>(null);
  const [recentConfirmFor, setRecentConfirmFor] = useState<string | null>(null);
  const [deptSel, setDeptSel] = useState<ReadonlySet<string>>(new Set());
  const [conceptSel, setConceptSel] = useState<ReadonlySet<string>>(new Set());
  const [ctlOnly, setCtlOnly] = useState(false);
  // #1654 — selection is keyed by the DISPLAY label (what FacetGroup renders and toggles),
  // so the filter compares labels too. One vocabulary, no id↔label map to drift.
  const [stageSel, setStageSel] = useState<ReadonlySet<string>>(new Set());
  // Researcher type. `null` = untouched, which means the DEFAULT selection on the sponsor path
  // (see `typeSelEffective`); an explicit empty set means "show everyone".
  const [typeSel, setTypeSel] = useState<ReadonlySet<string> | null>(null);
  // Grant Matcha — the officer owns the predicate. The hard career-stage axis defaults ON (it IS
  // the opportunity's own rule); unchecking RELAXES it, interleaving the dropped people back into
  // the ranking by fit, badged — a client-side toggle over already-fetched candidates, never a
  // re-query (the Matcha invariant). The ESI boost is soft and hides nobody.
  const [stageGateOn, setStageGateOn] = useState(true);
  const [esiBoostOn, setEsiBoostOn] = useState(true);
  // Person type. `null` = untouched ⇒ the sponsor-path default (see `roleSelEffective`).
  const [roleSel, setRoleSel] = useState<ReadonlySet<string> | null>(null);
  const [sort, setSort] = useState<SortKey>("fit");
  // D8 — density, remembered across visits. Warm-palette redesign flipped the DEFAULT to compact:
  // officers land on the scannable list, and a compact row expands to its full card in place, so
  // nothing is lost. The initializer reads compact UNLESS localStorage pins detailed. Reading
  // localStorage here is safe — results only render after a client fetch (no server render reaches
  // this; the idle page has no list).
  const [density, setDensity] = useState<Density>(() =>
    typeof window !== "undefined" && window.localStorage.getItem(DENSITY_KEY) === "detailed"
      ? "detailed"
      : "compact",
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
  // #1780 Phase 2 — the extractor's terms the cut did NOT search, offered as click-to-include
  // chips, and the terms the officer has clicked to add back. `included` is threaded into the NEXT
  // `runSearch` so the server force-pins them; both reset on a fresh paste (not on an add re-run).
  const [culled, setCulled] = useState<CulledConcept[]>([]);
  const [included, setIncluded] = useState<string[]>([]);
  // The extractor's essence title (org + focus). Stable across slider/preference edits — only
  // a new search replaces it — so the header does not churn as the officer tunes the ranking.
  const [titleSummary, setTitleSummary] = useState<string | undefined>(undefined);
  // Who is asking: the extractor's requester (same call as the title) and the officer's
  // correction of it (PATCH `{ submissionId, requester }`). The title reads "{requester} — {focus}".
  const [requester, setRequester] = useState<string | undefined>(undefined);
  const [requesterOverride, setRequesterOverride] = useState<string | null>(null);
  const [editingRequester, setEditingRequester] = useState(false);
  const [requesterDraft, setRequesterDraft] = useState("");
  const [requesterError, setRequesterError] = useState(false);
  /** When the server answered from a persisted earlier run: that run's ISO timestamp. Undefined
   *  ⇒ computed for this request. Labels the results; Re-run forces a fresh computation. */
  const [asOf, setAsOf] = useState<string | undefined>(undefined);
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

  // ── Matcha Phase 3: briefs + Rename (MATCHA_BRIEF) ──
  // The retained row this run wrote (null: grant path, or the retention write failed). Briefs and
  // the Rename key off it; the server re-resolves everything else from the saved search.
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [renameError, setRenameError] = useState(false);
  const [briefMap, setBriefMap] = useState<ReadonlyMap<string, BriefWire>>(new Map());
  const [briefRecords, setBriefRecords] = useState<Readonly<Record<string, BriefRecords>>>({});
  const [briefDrafting, setBriefDrafting] = useState<ReadonlySet<string>>(new Set());
  const [briefFailed, setBriefFailed] = useState<ReadonlySet<string>>(new Set());
  // Fail closed: no Draft/Edit controls until the GET says this viewer may write.
  const [briefCanEdit, setBriefCanEdit] = useState(false);
  /** The oldest saved brief's date when briefs were LOADED (a replay), else null. */
  const [briefsSavedAt, setBriefsSavedAt] = useState<string | null>(null);
  // Matcha Phase 4 — the missing-brief prompt in front of "Report (PDF)". Null = closed.
  const [reportPrompt, setReportPrompt] = useState<ReportPrompt | null>(null);
  // Matcha contact — the "Email selected (BCC)" dialog. Null = closed.
  const [emailDialog, setEmailDialog] = useState<EmailDialogState | null>(null);
  // The submission a draft belongs to — a result landing after a new search is dropped.
  const briefSubRef = useRef<string | null>(null);
  const briefQueueRef = useRef<{ cwid: string; sid: string }[]>([]);
  const briefActiveRef = useRef(0);
  const briefInflightRef = useRef<Set<string>>(new Set());
  const pending = status.kind === "loading";
  // What this ask ranks — drives the submit/loading/empty copy so grant mode never says "researchers".
  const targetNoun = target === "grants" ? "opportunities" : "researchers";
  // The grant-path reskin gate (Matcha Redesign.dc.html). `eligibility` presence is already this
  // file's grant-vs-email boundary (see the prop's doc comment), so the re-chrome hangs off the
  // same fact rather than a second flag that could drift from it. `/edit/matcha` passes no
  // `eligibility` and must render exactly as before.
  const grantPath = eligibility != null;

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

  // Grant Matcha — when seeded with an opportunity's text, run the ask once on mount so the
  // officer lands on the extracted concepts + ranked researchers. Mount-only by design: the
  // find-researchers MatchedView remounts this per opportunity (via its `key`), so a fresh
  // opportunity is a fresh mount and the empty dep array is intended, not a missing dependency.
  useEffect(() => {
    if (autoRun && (initialDescription ?? "").trim().length > 0) {
      void runSearch(initialDescription as string);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  /** A new run: forget the last run's briefs and drafts, then (flag on) load the paste's saved
   *  briefs — a replay from Recent shows them with no click. Briefs are keyed on the PASTE, so
   *  a fresh paste simply comes back empty. */
  function startBriefsFor(sid: string | null) {
    briefSubRef.current = sid;
    briefQueueRef.current = [];
    setBriefMap(new Map());
    setBriefRecords({});
    setBriefDrafting(new Set());
    setBriefFailed(new Set());
    setBriefCanEdit(false);
    setBriefsSavedAt(null);
    setReportPrompt(null);
    setRenaming(false);
    if (matchaBrief && sid) void loadBriefs(sid);
  }

  async function loadBriefs(sid: string) {
    try {
      const r = await fetch(`/api/edit/matcha/brief?submissionId=${encodeURIComponent(sid)}`, {
        credentials: "same-origin",
      });
      if (!r.ok || briefSubRef.current !== sid) return;
      const data = (await r.json()) as {
        briefs?: BriefWire[];
        records?: Record<string, BriefRecords>;
        canEdit?: boolean;
      };
      if (briefSubRef.current !== sid) return;
      const list = data.briefs ?? [];
      // Merge, never replace: a draft the officer started before this GET returned must survive it.
      setBriefMap((prev) => {
        const next = new Map(list.map((b) => [b.cwid, b] as const));
        for (const [k, v] of prev) next.set(k, v);
        return next;
      });
      setBriefRecords((prev) => ({ ...(data.records ?? {}), ...prev }));
      setBriefCanEdit(data.canEdit === true);
      setBriefsSavedAt(
        list.length > 0 ? list.map((b) => b.draftedAt).reduce((a, b) => (a < b ? a : b)) : null,
      );
    } catch {
      /* the briefs are an add-on; a failed load leaves the results untouched */
    }
  }

  /** Queue PIs for drafting. One POST per PI, `BRIEF_CONCURRENCY` in flight across every caller
   *  (toolbar and per-card), each row filling in as its own stream's result lands. */
  function enqueueBriefs(cwids: readonly string[]) {
    const sid = submissionId;
    if (!sid || !briefCanEdit) return;
    const queued = new Set(briefQueueRef.current.map((j) => j.cwid));
    const fresh = cwids.filter((c) => !briefInflightRef.current.has(c) && !queued.has(c));
    if (fresh.length === 0) return;
    setBriefDrafting((prev) => new Set([...prev, ...fresh]));
    setBriefFailed((prev) => new Set([...prev].filter((c) => !fresh.includes(c))));
    briefQueueRef.current.push(...fresh.map((cwid) => ({ cwid, sid })));
    pumpBriefs();
  }

  function pumpBriefs() {
    while (briefActiveRef.current < BRIEF_CONCURRENCY && briefQueueRef.current.length > 0) {
      const job = briefQueueRef.current.shift()!;
      briefActiveRef.current += 1;
      briefInflightRef.current.add(job.cwid);
      void draftOneBrief(job).finally(() => {
        briefActiveRef.current -= 1;
        briefInflightRef.current.delete(job.cwid);
        pumpBriefs();
      });
    }
  }

  async function draftOneBrief({ cwid, sid }: { cwid: string; sid: string }) {
    let ok = false;
    try {
      const r = await fetch("/api/edit/matcha/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ submissionId: sid, cwids: [cwid] }),
      });
      if (r.ok) {
        // NDJSON (`editOkStream`): progress lines, padded heartbeats, then one result line. The
        // overview generator's reader skips blanks and returns the result line.
        const result = await readOverviewStream(r, () => {});
        if (result?.ok && briefSubRef.current === sid) {
          const brief = (result.briefs as BriefWire[] | undefined)?.find((b) => b.cwid === cwid);
          const records = (result.records as Record<string, BriefRecords> | undefined)?.[cwid];
          if (brief) {
            ok = true;
            setBriefMap((prev) => new Map(prev).set(cwid, brief));
            if (records) setBriefRecords((prev) => ({ ...prev, [cwid]: records }));
          }
        }
      }
    } catch {
      /* reported as failed below */
    }
    if (briefSubRef.current !== sid) return;
    setBriefDrafting((prev) => {
      const next = new Set(prev);
      next.delete(cwid);
      return next;
    });
    if (!ok) setBriefFailed((prev) => new Set(prev).add(cwid));
  }

  async function patchBrief(cwid: string, patch: BriefPatch): Promise<boolean> {
    const sid = submissionId;
    if (!sid) return false;
    try {
      const r = await fetch("/api/edit/matcha/brief", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ submissionId: sid, cwid, ...patch }),
      });
      if (!r.ok) return false;
      const data = (await r.json()) as { brief?: BriefWire };
      if (!data.brief || briefSubRef.current !== sid) return false;
      const brief = data.brief;
      setBriefMap((prev) => new Map(prev).set(cwid, brief));
      return true;
    } catch {
      return false;
    }
  }

  /** Rename the search (PATCH /api/edit/matcha). Empty reverts to the generated title (with the
   *  officer's requester, when they set one — the server composes it). */
  async function saveTitle(generated: string) {
    const sid = submissionId;
    if (!sid) return;
    const trimmed = titleDraft.trim();
    const title = trimmed === generated ? "" : trimmed;
    setRenameError(false);
    try {
      const r = await fetch("/api/edit/matcha", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ submissionId: sid, title }),
      });
      if (!r.ok) {
        setRenameError(true);
        return;
      }
      const data = (await r.json()) as { title?: string | null; titleOverride?: string | null };
      setTitleOverride(data.titleOverride ?? null);
      setRenaming(false);
      relabelHistory(sid, data.title ?? null);
    } catch {
      setRenameError(true);
    }
  }

  /** Recent lists one entry per paste; relabel the one this run belongs to. */
  function relabelHistory(sid: string, title: string | null) {
    setHistory((prev) =>
      prev.map((h) => (h.id === sid || h.description === matchedText ? { ...h, title } : h)),
    );
  }

  /** Correct who is asking (PATCH /api/edit/matcha `{ submissionId, requester }`). Empty reverts
   *  to the model's requester. The server keeps the visible title in step unless it was Renamed. */
  async function saveRequester() {
    const sid = submissionId;
    if (!sid) return;
    const trimmed = requesterDraft.trim();
    setRequesterError(false);
    try {
      const r = await fetch("/api/edit/matcha", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          submissionId: sid,
          requester: trimmed === requester ? "" : trimmed,
        }),
      });
      if (!r.ok) {
        setRequesterError(true);
        return;
      }
      const data = (await r.json()) as {
        title?: string | null;
        titleOverride?: string | null;
        requester?: string | null;
        requesterOverride?: string | null;
      };
      setTitleOverride(data.titleOverride ?? null);
      setRequesterOverride(data.requesterOverride ?? null);
      setEditingRequester(false);
      relabelHistory(sid, data.title ?? null);
    } catch {
      setRequesterError(true);
    }
  }

  function clearFilters() {
    setDeptSel(new Set());
    setConceptSel(new Set());
    setCtlOnly(false);
    setStageSel(new Set());
    setTypeSel(new Set());
    setRoleSel(new Set());
  }

  /** The ONLY network call. A search — never a re-rank. The ask card always opens Full (the
   *  read-only paste with its highlighted terms + actions) — fresh, re-run, AND replay. It never
   *  collapses: an already-read ask is still the officer's context, and hiding it was the gripe. */
  async function runSearch(
    text: string,
    opts: { include?: readonly string[]; fresh?: boolean } = {},
  ) {
    if (pending || text.trim().length === 0) return;
    setStatus({ kind: "loading" });
    // #1991 — THE ASK IS SNAPSHOTTED AT SUBMIT, NOT AT RESOLVE. The card above the results answers
    // "what are we ranking?", and it was answering with the last thing FOUND: everything below moved
    // only inside `r.ok`, so for the whole in-flight window a replay from Recent left the previous
    // sponsor's prose, handle and highlights standing over a skeletoned list.
    //
    // The response-derived halves travel with the text because each is a fact about the run that
    // just ENDED — carried onto new text they would mark words that never produced them, or (for
    // `included`) force-pin the previous sponsor's concept into a ranking of this one's.
    //
    // Guarded on the text actually CHANGING, which leaves the re-run paths byte-identical: the
    // Re-run button and an added culled chip both pass `matchedText` straight back in, so the guard
    // is false and cannot clobber the `included` set `addCulled` has just written.
    //
    // Not done by gating `showAskCard` on `pending`: that swaps a committed ask back to the
    // textarea mid-run and back again, a layout jump for a paste nobody asked to edit.
    if (text !== matchedText) {
      setMatchedText(text);
      setConcepts([]);
      setCulled([]);
      setIncluded([]);
      setTitleSummary(undefined);
      setRequester(undefined);
      setRequesterOverride(null);
      setEditingRequester(false);
      setAsOf(undefined);
      setPreferences([]);
      setActivePrefs(new Set());
      setShowFullText(false); // D11 — a new paste starts clamped
      setShowSource(false); // grant path — a new paste starts with the source text collapsed
    }
    try {
      const r = await fetch("/api/edit/matcha", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        // #1780 Phase 2 — force-include the officer's culled picks. Absent opt ⇒ a fresh search ⇒ [].
        // `target` selects the corpus; the route ignores anything but "grants" (→ people path).
        body: JSON.stringify({
          description: text,
          include: opts.include ?? [],
          target,
          // Re-run: skip the persisted answer and compute now. Omitted on every other path so a
          // replay from Recent is served from the stored run when one exists.
          ...(opts.fresh ? { fresh: true } : {}),
          // Grant Matcha — ask the spine to hydrate `measures.esiEligible`. Sent ONLY when this
          // panel was handed an opportunity's requirements; the route re-checks GRANT_MATCHA as
          // the real boundary, and omitting the key leaves `/edit/matcha` byte-unchanged.
          ...(eligibility ? { eligibilitySignals: true } : {}),
        }),
      });
      if (r.ok) {
        // Grant Matcha (increment 3) — the funding-opportunities corpus. The route's grant branch
        // ships a DIFFERENT candidate shape (GrantCandidate[]) and no preferences/retention, so this
        // parses + fans out separately from the people path below. `concepts`/`titleSummary` are the
        // same extraction, so the ask card (derived from them) renders unchanged.
        if (target === "grants") {
          const data = (await r.json()) as {
            concepts?: MatchaConcept[];
            candidates?: GrantCandidate[];
            titleSummary?: string;
            requester?: string;
            culled?: CulledConcept[];
          };
          clearFilters();
          setCandidates([]); // the people list stays empty in grant mode
          setGrantCandidates(data.candidates ?? []);
          setConcepts(data.concepts ?? []);
          setCulled(data.culled ?? []);
          if (!opts.include) setIncluded([]);
          setTitleSummary(data.titleSummary);
          setRequester(data.requester);
          setRequesterOverride(null); // nothing retained ⇒ nothing to correct
          setAsOf(undefined); // the grant branch never serves a stored run
          setMatchedText(text);
          setEditing(false);
          setShowFullText(false);
          setShowSource(false);
          setRunId((n) => n + 1);
          setPreferences([]); // grant path ships none — never surface stale people prefs in the ask
          setActivePrefs(new Set());
          if (matchaBrief) {
            setSubmissionId(null); // the grant branch retains nothing to brief or rename
            setTitleOverride(null);
            startBriefsFor(null);
          }
          setStatus({ kind: "ok" });
          return;
        }
        // Typed as the CONTRACT's response, not an anonymous shape. The contract's headline
        // promise is that a drift between ranker and panel is a compile error; an inline
        // `{candidates?; concepts?}` opted the envelope out of exactly that.
        const data = (await r.json()) as Partial<MatchaResponse> & {
          /** Matcha Phase 3 — the retained row (null if the retention write failed). */
          submissionId?: string | null;
          titleOverride?: string | null;
          requesterOverride?: string | null;
        };
        setGrantCandidates([]); // toggling back to people clears any prior grant results
        clearFilters(); // stale facet selections must not silently hide fresh results
        setTypeSel(null); // ...except researcher type and person type, which return to their defaults
        setRoleSel(null);
        setExpanded(new Set()); // D8 — previous run's per-row expansions don't carry to new people
        setShortlist(new Set()); // the shortlist is per-ask: last sponsor's picks are not this one's
        void loadHistory(); // the row the server just retained
        setCandidates(data.candidates ?? []);
        setConcepts(data.concepts ?? []);
        setCulled(data.culled ?? []); // #1780 Phase 2 — the latest tail (excludes anything now searched)
        // Reset the officer's include picks ONLY on a fresh search. An add re-run passes `include`,
        // and the click handler already set `included` to the new set — don't clobber it.
        if (!opts.include) setIncluded([]);
        setTitleSummary(data.titleSummary);
        setRequester(data.requester);
        setRequesterOverride(data.requesterOverride ?? null);
        setEditingRequester(false);
        setAsOf(data.asOf);
        setMatchedText(text);
        setEditing(false); // a committed search → show the read-only ask, not the textarea
        setShowFullText(false); // D11 — new paste starts clamped
        setShowSource(false); // grant path — the source-text disclosure starts collapsed
        setRecency("recent"); // D3 — the dial is per-ask; a new sponsor starts at the ranker's default
        setRunId((n) => n + 1); // #1696 — a new run: every row's claimed-pmid set starts empty
        // #1654 — detected preferences arrive ACTIVE. The sponsor said it; the default is to
        // honour it. Deselecting is the officer's override, not their opt-in.
        const prefs = data.preferences ?? [];
        setPreferences(prefs);
        setActivePrefs(new Set(prefs.map((p) => p.label)));
        if (matchaBrief) {
          setSubmissionId(data.submissionId ?? null);
          setTitleOverride(data.titleOverride ?? null);
          startBriefsFor(data.submissionId ?? null);
        }
        setStatus({ kind: "ok" });
        return;
      }
      setStatus({
        kind: "error",
        message:
          r.status === 403
            ? "You don't have access to Matcha."
            : `Couldn't rank ${targetNoun}. Please try again.`,
      });
    } catch {
      setStatus({ kind: "error", message: `Couldn't rank ${targetNoun}. Please try again.` });
    }
  }

  /** #1780 Phase 2 — the officer clicks a culled chip to add it. Unlike a slider, adding a term
   *  cannot be a client-only re-rank (a new term has no contributions in any candidate yet), so it
   *  force-includes and RE-RUNS. Additive: the term joins the searched set (up to the ceiling), it
   *  does not displace an existing concept. */
  function addCulled(term: string) {
    if (pending) return;
    const next = [...included, term];
    setIncluded(next);
    void runSearch(matchedText, { include: next });
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
  const activePreferences = useMemo(() => {
    const base = preferences.filter((p) => activePrefs.has(p.label));
    // Grant Matcha — ESI rides the SAME soft machinery as the extractor's preferences (λ=0.25),
    // so an ESI-targeted opportunity nudges early-stage investigators up without hiding anyone.
    if (!eligibility?.esiTargeted || !esiBoostOn) return base;
    return [
      ...base,
      {
        label: "Early-stage investigator",
        evidence: "from this opportunity's eligibility",
        importance: 1,
        measure: "esiEligible",
      } as const,
    ];
  }, [preferences, activePrefs, eligibility?.esiTargeted, esiBoostOn]);

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

  // D3 — the dial only means anything when the payload carries years (MATCHA_RECENCY on).
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

  // Grant Matcha — the denominator fed to `fitTier` for grant cards. Server returns them sorted, so
  // `[0]` is usually the max, but reduce to be robust to an unsorted response.
  const grantTopScore = useMemo(
    () => grantCandidates.reduce((m, c) => Math.max(m, c.fusedScore), 0),
    [grantCandidates],
  );

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

  // Self-awareness for a thin extraction — see `assessMatchSignal`'s doc comment. Render-only:
  // the officer gets a caution up front rather than discovering the scatter in the ranking.
  const matchSignal = useMemo(() => assessMatchSignal(concepts), [concepts]);

  // #1780 Phase 2 — culled chips still worth offering: the extractor's tail minus anything now in
  // the searched set (a just-added term drops off). `atCap` disables adds once the searched set
  // reaches the ceiling — the officer can add culled terms, but not without bound.
  const culledVisible = useMemo(() => {
    const searched = new Set(concepts.map((c) => c.term.trim().toLowerCase()));
    return culled.filter((c) => !searched.has(c.term.trim().toLowerCase()));
  }, [culled, concepts]);
  // The server enforces the ceiling on the PRE-cluster term set (`extracted`), but the wire
  // `concepts` are POST-cluster — MeSH-equivalent terms merge, so `concepts.length` under-counts
  // and would never reach the cap once any merge happens (letting the officer add past what the
  // server honours, which `applyIncludes` then silently truncates). `members` carries every term
  // that merged into a cluster, so their sum IS the server's real searched-term count.
  const searchedTermCount = useMemo(
    () => concepts.reduce((n, c) => n + c.members.length, 0),
    [concepts],
  );
  const atCap = searchedTermCount >= MAX_TERMS_WITH_INCLUDES;

  // The search's handle. DERIVED HERE, not taken from `response.ask`, for the same reason the
  // ranking is: the officer can DESELECT a preference the extractor got wrong, and a title
  // frozen at submit would go on asserting "· Early career" after they had said the sponsor
  // never asked for that — the header contradicting the ranking directly beneath it. The
  // server still ships `ask` (it is the canonical handle for a caller that does not re-rank),
  // but the console owns what it displays, exactly as it owns the preference predicate.
  //
  // `ask` is what the header shows: composed with the officer's requester when they corrected it.
  // `generatedAsk` is the model's (what the server stored as `title`): Rename compares against it,
  // so typing back the generated title clears the override rather than freezing a copy of it.
  const effectiveRequester = requesterOverride ?? requester;
  const ask = useMemo(
    () =>
      askTitleFrom(
        concepts,
        preferences.filter((p) => activePrefs.has(p.label)),
        titleSummary,
        effectiveRequester,
      ),
    [concepts, preferences, activePrefs, titleSummary, effectiveRequester],
  );
  const generatedAsk = useMemo(
    () =>
      askTitleFrom(
        concepts,
        preferences.filter((p) => activePrefs.has(p.label)),
        titleSummary,
        requester,
      ),
    [concepts, preferences, activePrefs, titleSummary, requester],
  );

  // The committed request, with the pulled-out terms marked — the mockup's read-only ask quote.
  // `matchedText` (not `description`) so an in-progress textarea edit can't desync the marks.
  const askSegments = useMemo(() => markPaste(matchedText, concepts), [matchedText, concepts]);
  const askMarked = useMemo(() => markedConceptCount(askSegments), [askSegments]);
  // Show the read-only ask once a search has committed and the officer is not editing the paste.
  const showAskCard = !editing && matchedText.length > 0;

  // The committed paste with its marks, the D11 clamp, and the honest-lower-bound explainer —
  // ONE block with two homes: inline on `/edit/matcha`, behind the grant path's collapsed
  // "Show source text" disclosure (Matcha Redesign.dc.html). Extracted so the two cannot drift.
  const askQuote = (
    <>
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
              {/* #1780 — method marks take the rail's purple (facet-method) token, concepts
                  the blue (facet-topic) one, so the paste read-back matches the Concept/Method
                  rail split. */}
              <mark
                data-slot="matcha-ask-mark"
                data-term={s.term}
                data-kind={s.kind}
                className={`rounded-[3px] px-[3px] ${
                  s.kind === "method"
                    ? "bg-[var(--color-facet-method-fill)] text-[var(--color-facet-method-text)]"
                    : "bg-[var(--color-facet-topic-fill)] text-[var(--color-facet-topic-text)]"
                }`}
              >
                {s.text}
              </mark>
            </HoverTooltip>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </p>
      {/* D11 — expand the clamped paste. */}
      <div className="mt-1.5 flex items-center gap-3.5">
        <button
          type="button"
          onClick={() => setShowFullText((v) => !v)}
          className="text-xs text-[var(--color-facet-topic-count)] underline-offset-4 hover:underline"
        >
          {showFullText ? "Show less" : "Show full text"}
          <Caret dropdown open={showFullText} className="ml-0.5 inline-block align-[-2px]" />
        </button>
      </div>
      {/* Honest lower bound: a concept goes unmarked when the matcher canonicalised it to a
          form not verbatim in the paste — never because it was ignored. Shown only when
          something is actually unmarked; sits at the card foot, ruled off, per the mockup.
          ⚠ THE SECOND SENTENCE EXISTS BECAUSE THE FIRST ANSWERS THE WRONG QUESTION. This
          note explains why a CONCEPT is unmarked. A reader who notices unhighlighted PROSE
          is looking at text that was never elected a concept at all, and reads this line as
          the explanation for THAT — so "unmarked never means ignored" reassured about
          something they had not asked. Observed live (#1780): a reader asked why "induced
          pluripotent stem cell models" was unhighlighted; it was not a concept. Whether it
          SHOULD have been is extractor coverage, and is not this sentence's job — but the
          sentence must not imply the highlight is a complete account of the paste. */}
      {concepts.length > 0 && askMarked < concepts.length ? (
        <p className="text-muted-foreground border-border mt-3 border-t pt-2.5 text-[11px] leading-[1.5]">
          {askMarked} of {concepts.length} concepts are highlighted — a concept goes unmarked
          when the matcher wrote it in standard terms (an abbreviation expanded, a brand
          resolved). Unmarked never means ignored. Highlighting marks the concepts and methods
          above, so other wording in the paste going unmarked does not mean it was read — it
          means it is not one of them.
        </p>
      ) : null}
    </>
  );

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

  // Researcher type. Counts only rows that CARRY the measure, like the groups above.
  const typeFacet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of ranked) {
      const t = c.measures?.researcherType;
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return RESEARCHER_TYPE_ORDER.filter((t) => counts.has(t)).map(
      (t) => [RESEARCHER_TYPE_LABEL[t], counts.get(t)!] as const,
    );
  }, [ranked]);
  // The default applies only on the sponsor path and only when the run carries the measure:
  // a stored run from before this field existed has no types, and a default there would hide
  // every row. Grant Matcha states its own eligibility, so it starts unfiltered.
  const typeSelEffective = useMemo<ReadonlySet<string>>(
    () => typeSel ?? (!grantPath && typeFacet.length > 0 ? DEFAULT_RESEARCHER_TYPES : new Set()),
    [typeSel, grantPath, typeFacet.length],
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
  // Sponsor-path default: full-time faculty only, the people who can take on an industry
  // collaboration. Applied only when the run actually has some (else it would hide every row),
  // and never on Grant Matcha, whose opportunities can target postdocs and trainees.
  const hasFullTimeFaculty = roleFacet.some(([l]) => l === DEFAULT_PERSON_TYPE);
  const roleSelEffective = useMemo<ReadonlySet<string>>(
    () => roleSel ?? (!grantPath && hasFullTimeFaculty ? new Set([DEFAULT_PERSON_TYPE]) : new Set()),
    [roleSel, grantPath, hasFullTimeFaculty],
  );

  const hasFilters =
    deptSel.size > 0 ||
    conceptSel.size > 0 ||
    ctlOnly ||
    stageSel.size > 0 ||
    typeSelEffective.size > 0 ||
    roleSelEffective.size > 0;

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
    ...[...roleSelEffective].map((v) => ({
      key: `role:${v}`,
      label: v,
      onRemove: () => setRoleSel(toggled(roleSelEffective, v)),
    })),
    ...(typeSelEffective.size > 0
      ? [
          {
            key: "researcherType",
            label: researcherTypeChip(typeSelEffective, typeFacet.map(([l]) => l)),
            onRemove: () => setTypeSel(new Set()),
          },
        ]
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
          (typeSelEffective.size === 0 ||
            (c.measures?.researcherType != null &&
              typeSelEffective.has(RESEARCHER_TYPE_LABEL[c.measures.researcherType]))) &&
          (roleSelEffective.size === 0 ||
            roleSelEffective.has(roleCategoryLabel(c.measures?.roleCategory))),
      ),
    [rankedRows, deptSel, conceptSel, ctlOnly, stageSel, typeSelEffective, roleSelEffective],
  );

  // Grant Matcha — the HARD eligibility gate, applied CLIENT-SIDE over already-fetched
  // candidates so relaxing an axis costs no round-trip. No requirements (or a relaxed toggle)
  // ⇒ `stageGate` is null ⇒ `eligibleRows === filtered`, so `/edit/matcha` gets the identical
  // list and an empty floor. A candidate with no career stage FAILS the gate rather than being
  // waved through — the same "absent is not zero" posture the measure filters above take — and
  // lands in the floor, recoverable by unchecking the axis.
  const stageGate = stageGateOn ? (eligibility?.careerStages ?? null) : null;
  const [eligibleRows, ineligibleRows] = useMemo(() => {
    if (!stageGate) return [filtered, [] as typeof filtered];
    const ok: typeof filtered = [];
    const no: typeof filtered = [];
    for (const row of filtered) {
      const stage = row.c.measures?.careerStage;
      (stage != null && stageGate.includes(stage) ? ok : no).push(row);
    }
    return [ok, no];
  }, [filtered, stageGate]);

  // Badging is INDEPENDENT of the toggle: it answers "does this candidate meet the opportunity's
  // STATED rule?", which is exactly what makes a row legible once the officer relaxes the gate and
  // ineligible people interleave back in by fit. Null ⇒ the opportunity states no rule ⇒ no badge
  // renders anywhere, which is the `/edit/matcha` case.
  const meetsStageRule = useMemo(() => {
    const stages = eligibility?.careerStages ?? null;
    if (!stages) return null;
    return (c: MatchaCandidate) => {
      const stage = c.measures?.careerStage;
      return stage != null && stages.includes(stage);
    };
  }, [eligibility?.careerStages]);

  // The cap lands on the FIT-ordered rows, then Name reorders that hundred. Slicing after the
  // name sort would paint the alphabetically-first 100 and call them the best matches.
  const visible = useMemo(() => {
    const rows = eligibleRows.slice(0, RESULT_MAX);
    return sort === "name" ? [...rows].sort((a, b) => compareByName(a.c, b.c)) : rows;
  }, [eligibleRows, sort]);

  /** The ineligible floor's painted rows — the SINGLE source for what the expanded list renders, so
   *  the truncation notice beside it can never disagree with it (the `shortlistRows` rule, applied
   *  to a fold instead of an export). `ineligibleRows` runs to the filtered pool's size (~800), not
   *  to `RESULT_MAX`, so above 100 this genuinely bites. */
  const ineligibleShown = useMemo(() => ineligibleRows.slice(0, RESULT_MAX), [ineligibleRows]);

  // The relevance floor. Full cards for strong/good; the weak tier collapses under one bar the
  // officer can expand. Relative BY CONSTRUCTION — `fitTier` buckets each row against the TOP hit
  // (the #1 always scores share 1.0 → "strong", so this never collapses everything), so the floor
  // tracks the result set's own distribution rather than an absolute cutoff. Only meaningful in fit
  // order: a name sort mixes tiers alphabetically, so it stays a flat list with no floor.
  const [showWeak, setShowWeak] = useState(false);
  // Grant Matcha — the eligibility floor's own collapse, independent of the relevance floor.
  const [showIneligible, setShowIneligible] = useState(false);
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

  // ── Matcha Phase 3: briefs ──
  // On only for the email path's people results with a retained run to key on. Off ⇒ every row is
  // handed no brief props and the toolbar/title render exactly as master.
  const briefsOn = matchaBrief && !grantPath && target === "people" && submissionId != null;

  /** What "Draft briefs" drafts: the CURRENT view (sliders + filters applied), rows without a
   *  brief and not already drafting. Ticked rows win (the shortlist, capped at the server's 20);
   *  otherwise the top 10 of the filtered, fit-ordered view. */
  const briefTargets = useMemo(() => {
    const lacks = (cwid: string) => !briefMap.has(cwid) && !briefDrafting.has(cwid);
    if (shortlistRows.length > 0) {
      return shortlistRows
        .map(({ c }) => c.cwid)
        .filter(lacks)
        .slice(0, BRIEF_SHORTLIST_MAX);
    }
    return eligibleRows
      .slice(0, BRIEF_TOP_N)
      .map(({ c }) => c.cwid)
      .filter(lacks);
  }, [shortlistRows, eligibleRows, briefMap, briefDrafting]);

  function briefStateFor(cwid: string): BriefState {
    if (briefDrafting.has(cwid)) return { kind: "drafting" };
    const brief = briefMap.get(cwid);
    if (brief) return { kind: "ready", brief };
    if (briefFailed.has(cwid)) return { kind: "failed" };
    return { kind: "none" };
  }

  function briefPropsFor(cwid: string): BriefRowProps {
    return {
      state: briefStateFor(cwid),
      records: briefRecords[cwid],
      canEdit: briefCanEdit,
      ...(contactOn ? { onEmail: () => emailOne(cwid) } : {}),
      onDraft: () => enqueueBriefs([cwid]),
      onPatch: (patch) => patchBrief(cwid, patch),
    };
  }

  function compactBriefLineFor(cwid: string): CompactBriefLine | undefined {
    const state = briefStateFor(cwid);
    if (state.kind === "drafting") return { kind: "drafting" };
    if (state.kind === "failed") return { kind: "failed" };
    if (state.kind === "ready") return { kind: "text", text: firstSentence(briefWhy(state.brief)) };
    return undefined;
  }

  const briefFailedCount = [...briefFailed].filter(
    (c) => !briefMap.has(c) && !briefDrafting.has(c),
  ).length;

  // ── Matcha Phase 4: the printable report ──
  /** Who "Report (PDF)" covers: the shortlist when anything is ticked (briefed or not — the
   *  prompt below says who lacks one), else every PI in the current view that HAS a brief.
   *  Capped at `REPORT_MAX`, in the view's rank order. */
  const reportCwids = useMemo(() => {
    if (!briefsOn) return [];
    const rows =
      shortlistRows.length > 0
        ? shortlistRows
        : eligibleRows.filter(({ c }) => briefMap.has(c.cwid));
    return rows.slice(0, REPORT_MAX).map(({ c }) => c.cwid);
  }, [briefsOn, shortlistRows, eligibleRows, briefMap]);

  /** "Report (PDF)": straight to the new tab when every selected PI has a brief (synchronously,
   *  inside the click, so no popup blocker objects); otherwise the in-page prompt first. */
  function openReport() {
    if (!submissionId || reportCwids.length === 0) return;
    const missing = reportCwids.filter((c) => !briefMap.has(c));
    if (missing.length === 0) {
      window.open(reportHref(submissionId, reportCwids), "_blank", "noopener");
      return;
    }
    setReportPrompt({
      cwids: reportCwids,
      missing,
      noun: shortlistRows.length > 0 ? "shortlisted" : "selected",
      phase: "ask",
      blocked: false,
    });
  }

  /** "Open report without them": still a click, so the tab opens synchronously. */
  function openReportAnyway() {
    if (!submissionId || !reportPrompt) return;
    window.open(reportHref(submissionId, reportPrompt.cwids), "_blank", "noopener");
    setReportPrompt(null);
  }

  /** "Draft N briefs, then open report": the SAME queue as the toolbar (one POST per PI,
   *  `BRIEF_CONCURRENCY` in flight), for the missing PIs only. */
  function draftThenReport() {
    if (!reportPrompt || !briefCanEdit) return;
    enqueueBriefs(reportPrompt.missing);
    setReportPrompt({ ...reportPrompt, phase: "drafting" });
  }

  // ── Matcha contact ──
  // Drafters only (the contacts route uses the brief-drafting gate; observers never see these).
  const contactOn = briefsOn && briefCanEdit;
  /** The search's focus for the outreach text: the title without its "{requester} — " prefix and
   *  without the preference suffix ("· Early career" describes the sponsor's ask, not the topic). */
  const contactFocus = titleOverride
    ? emailFocus(titleOverride, effectiveRequester)
    : (askTitleFrom(concepts, [], titleSummary, null)?.title ?? "");

  /** Addresses for `cwids`, resolved on CLICK by the gated route — never at render, never stored. */
  async function fetchContacts(cwids: readonly string[]): Promise<ContactsResult> {
    const r = await fetch("/api/edit/matcha/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ submissionId, cwids }),
    });
    const body = (await r.json().catch(() => null)) as
      | (Partial<ContactsResult> & { ok?: boolean; error?: string })
      | null;
    if (!r.ok || !body?.ok) {
      throw new Error(
        CONTACT_ERRORS[body?.error ?? ""] ?? "Couldn't load the email addresses. Please try again.",
      );
    }
    return {
      contacts: body.contacts ?? [],
      missing: body.missing ?? [],
      officer: body.officer ?? { name: "", email: null },
    };
  }

  /** "Email selected (BCC)": resolve the ticked rows' addresses, then the editable dialog. */
  async function openEmailDialog() {
    if (!contactOn || shortlistRows.length === 0) return;
    const cwids = shortlistRows.map(({ c }) => c.cwid);
    setEmailDialog({ kind: "loading" });
    try {
      const res = await fetchContacts(cwids);
      const { subject, body } = buildGroupEmail({
        focus: contactFocus,
        requester: effectiveRequester,
        officerName: res.officer.name,
      });
      setEmailDialog({ kind: "ready", ...res, subject, body, copied: null });
    } catch (err) {
      setEmailDialog({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Per-person "Email": that person alone, greeted by name, with their partnership angle. */
  async function emailOne(cwid: string): Promise<boolean> {
    const res = await fetchContacts([cwid]);
    const person = res.contacts[0];
    if (!person) return false;
    const brief = briefMap.get(cwid);
    const { subject, body } = buildPersonEmail({
      focus: contactFocus,
      requester: effectiveRequester,
      officerName: res.officer.name,
      name: person.name,
      angle: brief ? briefAngle(brief) : null,
    });
    window.location.href = buildMailto({ to: person.email, subject, body });
    return true;
  }

  /** Missing PIs whose draft has landed (brief) or failed. */
  const reportSettled = reportPrompt
    ? reportPrompt.missing.filter(
        (c) => !briefDrafting.has(c) && (briefMap.has(c) || briefFailed.has(c)),
      )
    : [];
  const reportFailed = reportPrompt ? reportSettled.filter((c) => !briefMap.has(c)) : [];

  // Every missing PI settled ⇒ open the report. This runs after an async wait, so a popup blocker
  // may refuse the tab: then the prompt stays up with an "Open report" link (a click) instead. A
  // failed PI is listed and still included, records only.
  useEffect(() => {
    if (!reportPrompt || reportPrompt.phase !== "drafting" || !submissionId) return;
    if (reportSettled.length < reportPrompt.missing.length) return;
    const tab = window.open(reportHref(submissionId, reportPrompt.cwids), "_blank");
    if (tab) tab.opener = null;
    if (tab && reportFailed.length === 0) setReportPrompt(null);
    else setReportPrompt({ ...reportPrompt, phase: "done", blocked: !tab });
  }, [reportPrompt, reportSettled.length, reportFailed.length, submissionId]);

  const nameOf = (cwid: string) => rankedRows.find(({ c }) => c.cwid === cwid)?.c.name ?? cwid;

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
        researcherType: c.measures?.researcherType
          ? RESEARCHER_TYPE_LABEL[c.measures.researcherType]
          : "",
        technologyCount: c.technologyCount,
        profileUrl: new URL(
          profilePath(c.profileSlug),
          window.location.origin,
        ).toString(),
        // The export deliberately carries the PRE-gate set (an officer's outreach list), so
        // each row must say whether the page's gate shows it. `meetsStageRule` is the SAME
        // predicate the gate and the badges use — the stated rule, not the toggle — and it is
        // null on `/edit/matcha`, where the column (see the option below) does not exist.
        ...(meetsStageRule ? { eligible: meetsStageRule(c) ? "Yes" : "No" } : {}),
        // Matcha Phase 3 — the brief's why + topics (edited text when present). Never the note.
        ...(briefsOn ? briefCsvFields(briefMap.get(c.cwid)) : {}),
      })),
      { eligibility: meetsStageRule != null, brief: briefsOn },
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

  // #6d retained searches — the "Recent searches" drawer (Matcha.dc.html). ONE controlled shadcn
  // Sheet (no hand-rolled overlay/focus-trap), opened from a "Recent searches (N)" button on every
  // path: the page header while idle, the read-only ask card once a search has committed (grant
  // and email paths), and the idle inline list's "Show all N searches". The retention notice lives
  // in the drawer header, where #6d requires it be said.
  function closeRecentDrawer() {
    setDrawerOpen(false);
    setRecentMenuFor(null);
    setRecentConfirmFor(null);
  }

  /** Open results / Run again — the existing replay: set the textarea, run it. Open results is
   *  served from the stored run when one exists; Run again forces a fresh computation. Either way
   *  the drawer closes so the results are visible (D10 — the ask opens Full). */
  function replayRecent(h: Submission, opts: { fresh?: boolean } = {}) {
    closeRecentDrawer();
    setDescription(h.description);
    void runSearch(h.description, opts.fresh ? { fresh: true } : {});
  }

  /** Edit ask and re-run — the paste goes back in the textarea, on the idle view, unrun. */
  function editRecent(h: Submission) {
    closeRecentDrawer();
    setDescription(h.description);
    setEditing(true);
    setStatus({ kind: "idle" });
  }

  const recentButton =
    history.length > 0 ? (
      // Grant path — the artboard sits this beside the icon re-run in the summary card's corner,
      // at the small control scale. Same drawer either way.
      <Button
        type="button"
        variant="outline"
        {...(grantPath ? { size: "sm" as const } : {})}
        onClick={() => setDrawerOpen(true)}
      >
        Recent searches ({history.length})
      </Button>
    ) : null;

  // The drawer's own filters. Search covers the title and the pasted text everywhere, and the
  // submitter's name only in the admin view (§10 — elsewhere the name is never shown, so matching
  // on it would surface rows for a reason the officer cannot see). Mine is offered only when the
  // server says this list holds other people's searches.
  const drawerQ = drawerQuery.trim().toLowerCase();
  const drawerRows = history.filter((h) => {
    if (historyScope === "all" && drawerScope === "mine" && h.mine !== true) return false;
    if (!drawerQ) return true;
    const hay = [h.title ?? "", h.description, historyScope === "all" ? h.submittedByName : ""]
      .join(" ")
      .toLowerCase();
    return hay.includes(drawerQ);
  });

  const historyDrawer = (
    <Sheet open={drawerOpen} onOpenChange={(o) => (o ? setDrawerOpen(true) : closeRecentDrawer())}>
      <SheetContent data-slot="matcha-history" className="gap-0">
        <SheetHeader className="border-apollo-border gap-3 border-b">
          <SheetTitle>Recent searches ({history.length})</SheetTitle>
          {/* The retention notice, and it must track §9's scope or it is a lie in whichever
              direction it is left. Each branch states exactly who can read THIS list, and it
              leads: who can see this is what the reader needs BEFORE they paste, not after. */}
          <SheetDescription className="pr-6">
            {historyScope === "all"
              ? "You are seeing every user's searches."
              : "Only you, developers, and console administrators can see your searches."}{" "}
            They&rsquo;re saved — including the description you pasted — so we can measure and
            improve match quality against real opportunity text. Delete any search to remove its
            text for good.
          </SheetDescription>
          <Input
            type="search"
            aria-label="Search recent searches"
            placeholder={
              historyScope === "all"
                ? "Search titles, pasted text, people…"
                : "Search titles and pasted text…"
            }
            value={drawerQuery}
            onChange={(e) => {
              setDrawerQuery(e.target.value);
              setRecentMenuFor(null);
            }}
          />
          {historyScope === "all" ? (
            <div
              role="group"
              aria-label="Whose searches"
              className="bg-apollo-surface-2 inline-flex self-start rounded-lg p-[3px]"
            >
              {(
                [
                  ["everyone", "Everyone"],
                  ["mine", "Mine"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={drawerScope === k}
                  onClick={() => {
                    setDrawerScope(k);
                    setRecentMenuFor(null);
                    setRecentConfirmFor(null);
                  }}
                  className={`rounded-md px-3 py-1 text-[13px] ${
                    drawerScope === k
                      ? "bg-apollo-surface text-foreground shadow-sm"
                      : "text-muted-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </SheetHeader>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {drawerRows.map((h) => {
            const title = h.title ?? "Untitled search";
            const runs = h.runCount ?? 1;
            const menuOpen = recentMenuFor === h.id;
            const confirming = recentConfirmFor === h.id;
            const menuItems: { label: string; onSelect: () => void; destructive?: boolean }[] = [
              { label: "Open results", onSelect: () => replayRecent(h) },
              { label: "Run again", onSelect: () => replayRecent(h, { fresh: true }) },
              // The grant path's ask is the opportunity's own text (allowEditPaste=false) —
              // there is no textarea to put it back into.
              ...(allowEditPaste
                ? [{ label: "Edit ask and re-run", onSelect: () => editRecent(h) }]
                : []),
              {
                // The server erases EVERY run of the paste in the viewer's scope (DELETE), so a
                // grouped row says so before the officer confirms.
                label: runs > 1 ? `Delete all ${runs} runs…` : "Delete…",
                destructive: true,
                onSelect: () => {
                  setRecentMenuFor(null);
                  setRecentConfirmFor(h.id);
                },
              },
            ];
            return (
              <li
                key={h.id}
                data-slot="matcha-history-row"
                className="border-apollo-border relative flex flex-col gap-2 border-b px-4 py-3.5 sm:px-[22px]"
              >
                <div className="flex items-start gap-2.5">
                  {/* The row itself is Open results — the replayed request re-renders as the
                      read-only ask, so the row needs no request preview beyond its meta. */}
                  <button
                    type="button"
                    onClick={() => replayRecent(h)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                  >
                    <span className="text-foreground/90 text-[15px] leading-snug font-medium break-words hover:underline">
                      {title}
                    </span>
                    {/* §10 — SUPERUSER VIEW ONLY, and the name rather than the cwid. Once the
                        list is scoped (§9) a normal user's rows are ALL their own, so the name
                        would be a constant repeated down the list. `submittedByName` is resolved
                        server-side with a cwid fallback — never blank, never "Unknown". */}
                    <span className="text-muted-foreground text-[12.5px]">
                      {formatSubmittedDate(h.createdAt)}
                      {historyScope === "all" ? ` · ${h.submittedByName}` : null}
                    </span>
                  </button>
                  <span className="text-muted-foreground shrink-0 pt-0.5 text-[12.5px] whitespace-nowrap">
                    {h.candidateCount} matched
                  </span>
                  <button
                    type="button"
                    aria-label={`Actions for search: ${title}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => {
                      setRecentMenuFor(menuOpen ? null : h.id);
                      setRecentConfirmFor(null);
                    }}
                    className={`border-apollo-border text-foreground flex size-7 shrink-0 items-center justify-center rounded-md border ${
                      menuOpen ? "bg-apollo-surface-2" : "bg-apollo-surface"
                    }`}
                  >
                    <MoreHorizontal className="size-4" aria-hidden />
                  </button>
                </div>
                {runs > 1 ? (
                  <span className="bg-apollo-surface-2 text-foreground self-start rounded-full px-2.5 py-0.5 text-[12px]">
                    {runs} runs
                  </span>
                ) : null}
                {menuOpen ? (
                  <div
                    role="menu"
                    aria-label={`Actions for ${title}`}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation(); // close the menu, not the whole drawer
                        setRecentMenuFor(null);
                      }
                    }}
                    className="border-apollo-border-strong bg-apollo-surface absolute top-12 right-4 z-10 flex min-w-[190px] flex-col rounded-[10px] border p-1 shadow-lg sm:right-[22px]"
                  >
                    {menuItems.map((m) => (
                      <button
                        key={m.label}
                        type="button"
                        role="menuitem"
                        onClick={m.onSelect}
                        className={`hover:bg-apollo-surface-2 rounded-md px-2.5 py-2 text-left text-[13.5px] ${
                          m.destructive
                            ? "text-destructive border-apollo-border mt-1 border-t"
                            : "text-foreground"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {confirming ? (
                  // In-row confirm (never window.confirm) — Cancel keeps the row, Delete erases.
                  <div
                    role="group"
                    aria-label={`Confirm delete: ${title}`}
                    className="bg-apollo-red-tint border-apollo-border flex flex-col gap-2.5 rounded-lg border px-3.5 py-3"
                  >
                    <span className="text-[13.5px] leading-snug">
                      {runs > 1
                        ? `Delete all ${runs} runs of “${title}”, including the pasted text? This can't be undone.`
                        : `Delete “${title}” and its pasted text? This can't be undone.`}
                    </span>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setRecentConfirmFor(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setRecentConfirmFor(null);
                          void deleteSubmission(h.id);
                        }}
                      >
                        {runs > 1 ? "Delete all" : "Delete"}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
          {drawerRows.length === 0 ? (
            <li className="text-muted-foreground px-[22px] py-8 text-center text-sm">
              {history.length === 0 ? "No saved searches." : "No searches match."}
            </li>
          ) : null}
        </ul>
      </SheetContent>
    </Sheet>
  );

  // Matcha Empty State redesign — retained searches, inline, below the idle ask card. Idle has
  // nothing to cover, so the newest searches are on the page rather than behind a click; the full
  // list (with search, scope and the per-row menu) is the drawer, which "Show all N searches"
  // opens. Same data (`history`/`historyScope`), same replay + delete handlers, no new fetch.
  const recentSearchesSection =
    history.length > 0 ? (
      <div data-slot="matcha-recent" className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold">
            Recent searches <span className="font-normal text-[#8b857b]">· {history.length}</span>
          </h2>
          {/* §9 — this note (and the drawer's own retention notice) only needs to say WHO can see
              the list when that list is bigger than "just you", i.e. the superuser view. */}
          {historyScope === "all" ? (
            <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
              <Lock className="size-[11px]" aria-hidden />
              <span>Admin view: all users&rsquo; searches.</span>
              <HoverTooltip
                wide
                text="Searches are saved, including the description pasted, so match quality can be measured against real opportunity text. Deleting a search removes its text for good."
              >
                <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">
                  Why?
                </span>
              </HoverTooltip>
            </div>
          ) : null}
        </div>
        <div className="border-apollo-border bg-apollo-surface overflow-hidden rounded-xl border shadow-[var(--apollo-shadow-card)]">
          {history.slice(0, 7).map((h) => (
            <div key={h.id} className="group relative">
              {/* Same replay as the drawer row: set the textarea, run it — the read-only ask
                  card renders once the response lands (D10). */}
              <button
                type="button"
                onClick={() => {
                  setDescription(h.description);
                  void runSearch(h.description);
                }}
                className="border-apollo-border hover:bg-apollo-rail block w-full border-b px-5 py-[13px] pr-10 text-left transition-colors last:border-b-0"
              >
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 text-[13.5px] font-semibold">
                    {h.title ?? "Untitled search"}
                  </span>
                  {(h.runCount ?? 1) > 1 ? (
                    <span className="bg-apollo-surface-2 text-foreground shrink-0 rounded-full px-2 py-0.5 text-[11.5px]">
                      {h.runCount} runs
                    </span>
                  ) : null}
                  <span className="text-muted-foreground shrink-0 text-[12px] whitespace-nowrap">
                    {h.candidateCount} matched
                  </span>
                </div>
                {/* §10 — SUPERUSER VIEW ONLY, same rule the drawer applies. */}
                <div className="text-muted-foreground mt-1 text-[12px]">
                  {formatSubmittedDate(h.createdAt)}
                  {historyScope === "all" ? ` · ${h.submittedByName}` : null}
                </div>
              </button>
              {/* Hover-revealed, and a SIBLING of the row button (not nested inside it) — a
                  button-in-a-button is invalid HTML and would make this un-clickable in some
                  browsers. */}
              <button
                type="button"
                aria-label={`Delete search: ${h.title ?? h.description.slice(0, 60)}`}
                title="Delete: removes the saved text for good"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteSubmission(h.id);
                }}
                className="text-muted-foreground hover:bg-apollo-red-tint hover:text-apollo-maroon absolute top-2 right-2 rounded-md p-1.5 opacity-0 transition-colors group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
          {history.length > 7 ? (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="block w-full px-5 py-2.5 text-center text-[12.5px] font-medium text-[var(--color-accent-slate)] hover:underline"
            >
              Show all {history.length} searches
            </button>
          ) : null}
        </div>
      </div>
    ) : null;

  // D8 — a result row is the detailed card when density is Detailed OR the officer expanded it from
  // Compact; otherwise the one-line CompactRow, which expands in place on click. Used for both the
  // primary rows and the below-floor weak rows, so the floor and the density toggle compose.
  const renderResult = ({
    c,
    rank,
    eligBadge,
  }: {
    c: MatchaCandidate;
    rank: number;
    /** Explicit verdict for the eligibility floor. Omitted elsewhere ⇒ derived from the
     *  opportunity's stated rule, so the ordinary call sites need no change and
     *  `/edit/matcha` (no rule) gets `undefined` and renders no pill. */
    eligBadge?: EligBadge;
  }) => {
    const badge = eligBadge ?? (meetsStageRule ? (meetsStageRule(c) ? "eligible" : "relaxed") : undefined);
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
        {...(badge ? { eligBadge: badge } : {})}
        {...(briefsOn ? { brief: briefPropsFor(c.cwid) } : {})}
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
        table={grantTable}
        {...(badge ? { eligBadge: badge } : {})}
        {...(briefsOn ? { briefsOn: true, briefLine: compactBriefLineFor(c.cwid) } : {})}
      />
    );
  };

  // Grant path × compact density = the artboard's results TABLE: header row + grid rows in one
  // card. Detailed keeps its card list untouched (spec), and `/edit/matcha` keeps everything.
  const grantTable = grantPath && density === "compact";

  /** The relevance floor, in either chrome. Grant path: the artboard's full-width greige toggle
   *  bar (label inline, slate Show/Hide right, revealed rows dimmed); email path: the dashed
   *  divider + rounded bar, verbatim. Numbers come from what the code computes today — no
   *  threshold or predicate moved. */
  const weakFloorSection =
    collapsedWeak.length > 0 ? (
      <div data-slot="matcha-floor">
        {grantPath ? (
          <button
            type="button"
            onClick={() => setShowWeak((v) => !v)}
            aria-expanded={showWeak}
            className={`bg-apollo-surface-2 hover:bg-apollo-rail flex w-full items-center justify-between gap-3 px-[18px] py-[11px] text-left text-[12.5px] transition-colors ${
              grantTable ? "border-apollo-border border-t" : "my-4 rounded-lg"
            }`}
          >
            <span className="text-muted-foreground">
              Relevance floor · {collapsedWeak.length} weaker match
              {collapsedWeak.length === 1 ? "" : "es"}, below {Math.round(TIER_GOOD * 100)}% of
              the top result
            </span>
            <span className="text-apollo-slate shrink-0 font-medium">
              {showWeak ? "Hide" : "Show"}
            </span>
          </button>
        ) : (
          <>
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
                {collapsedWeak.length} weaker match{collapsedWeak.length === 1 ? "" : "es"} —
                below {Math.round(TIER_GOOD * 100)}% of the top result
              </span>
              <span className="shrink-0 font-medium text-[var(--color-accent-slate)]">
                {showWeak ? "Hide ↑" : "Show ↓"}
              </span>
            </button>
          </>
        )}
        {showWeak ? (
          /* Artboard: revealed floor rows render dimmed — they are below the floor for a
             reason, and 0.65 says so without hiding them. */
          <ul className={grantPath ? (grantTable ? "opacity-65" : "mt-4 opacity-65") : "mt-4"}>
            {collapsedWeak.map(({ c, rank }) => (
              <li key={c.cwid}>{renderResult({ c, rank })}</li>
            ))}
          </ul>
        ) : null}
      </div>
    ) : null;

  /** Grant Matcha — the ELIGIBILITY floor, distinct from the relevance floor above. Everyone the
   *  hard axis dropped stays reachable behind a toggle: a matcher that silently buries a
   *  well-matched researcher teaches the officer to distrust it. Empty (so absent) on
   *  `/edit/matcha`, which has no hard axis — the non-grant chrome branch below survives only
   *  for that impossibility's sake (this floor cannot render without `eligibility`). */
  const eligFloorSection =
    ineligibleRows.length > 0 ? (
      <div data-slot="matcha-elig-floor">
        {grantPath ? (
          <button
            type="button"
            onClick={() => setShowIneligible((v) => !v)}
            aria-expanded={showIneligible}
            className={`bg-apollo-surface-2 hover:bg-apollo-rail flex w-full items-center justify-between gap-3 px-[18px] py-[11px] text-left text-[12.5px] transition-colors ${
              grantTable ? "border-apollo-border border-t" : "my-4 rounded-lg"
            }`}
          >
            <span className="text-muted-foreground">
              Filtered by eligibility · {ineligibleRows.length} researcher
              {ineligibleRows.length === 1 ? "" : "s"}, well-matched but ineligible
            </span>
            <span className="text-apollo-slate shrink-0 font-medium">
              {showIneligible ? "Hide" : "Show"}
            </span>
          </button>
        ) : (
          <>
            <div className="my-4 flex items-center gap-3" aria-hidden="true">
              <div className="border-border h-0 flex-1 border-t border-dashed" />
              <span className="text-muted-foreground text-[11px] tracking-[0.04em]">
                FILTERED BY ELIGIBILITY
              </span>
              <div className="border-border h-0 flex-1 border-t border-dashed" />
            </div>
            <button
              type="button"
              onClick={() => setShowIneligible((v) => !v)}
              aria-expanded={showIneligible}
              className="bg-muted/40 hover:bg-muted/60 flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors"
            >
              <span className="text-muted-foreground">
                {ineligibleRows.length} researcher
                {ineligibleRows.length === 1 ? "" : "s"} filtered out — well-matched but
                ineligible for this opportunity
              </span>
              <span className="shrink-0 font-medium text-[var(--color-accent-slate)]">
                {showIneligible ? "Hide ↑" : "Show ↓"}
              </span>
            </button>
          </>
        )}
        {showIneligible ? (
          <>
            <ul className={grantPath ? (grantTable ? "opacity-65" : "mt-4 opacity-65") : "mt-4"}>
              {ineligibleShown.map(({ c, rank }) => (
                <li key={c.cwid}>{renderResult({ c, rank, eligBadge: "filtered" })}</li>
              ))}
            </ul>
            {/* The bar counts the whole exclusion (that IS the number the officer
                needs); the list is capped by the same render bound as the main one.
                Say so when it bites, or the bar promises N and delivers 100. */}
            {ineligibleRows.length > ineligibleShown.length ? (
              <p
                className={`text-muted-foreground text-[11px] ${
                  grantTable ? "px-[18px] py-3" : "mt-4"
                }`}
              >
                Showing the first {ineligibleShown.length} of {ineligibleRows.length} — narrow
                the results to see the rest
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    ) : null;

  return (
    <div data-slot="matcha-panel">
      <div className="mb-5 flex items-center gap-2">
        {/* The SCOPE copy rides the hover `ⓘ` beside the h1 — the "on the page" explainer. The
            nav-tab hover (`admin-subnav`) keeps the "before you land here" moment; the name is
            opaque until then, which is why BOTH hovers exist rather than one. (The idle-only
            subtitle below is different copy — paste-flow HOW-TO, not scope — per the Matcha
            Empty State artboard; it disappears once a search commits, the ⓘ never does.) */}
        <h1 className="text-2xl font-bold tracking-tight">Matcha</h1>
        <HoverTooltip wide text={MATCHA_BLURB}>
          {/* tabIndex so the ⓘ is keyboard-reachable: this hover now carries the tool's scope copy
              that used to live in an always-visible subtitle, so focus-to-open + Radix's
              aria-describedby are what keep it accessible to keyboard/SR users. */}
          <span
            tabIndex={0}
            aria-label="About Matcha"
            className="text-muted-foreground inline-flex size-[18px] cursor-help items-center justify-center rounded-full border border-apollo-border-strong text-xs font-medium"
          >
            i
          </span>
        </HoverTooltip>
        {/* Recent searches (N) — the idle page's trigger (Matcha.dc.html header). Once a search
            commits, the same button moves into the read-only ask card beside Re-run. */}
        {!showAskCard && recentButton ? <div className="ml-auto">{recentButton}</div> : null}
      </div>

      {/* Matcha Empty State — the artboard's maroon title rule + subtitle. Idle-only (the same
          `!showAskCard` condition the ask form below renders on): once a search commits, the
          ask card takes over as the page's headline element and this chrome steps back. */}
      {!showAskCard ? (
        <>
          <div aria-hidden="true" className="bg-apollo-maroon mt-2 mb-2.5 h-[3px] w-8 rounded-[2px]" />
          {/* Grant Matcha's corpus toggle changes what this surface ranks, so the paste-flow /
              researcher-ranking prose below would misdescribe it — subtitle is people-path only. */}
          {!grantMatcha ? (
            <p className="text-muted-foreground mb-4 max-w-[620px] text-[13.5px] leading-[1.55] text-pretty">
              Paste an opportunity description, an email from a sponsor, or a few phrases. Matcha
              reads it, extracts the concepts, and ranks Weill Cornell researchers against them.
            </p>
          ) : null}
        </>
      ) : null}

      {showAskCard ? (
        /* The mockup's "THE ASK": once a search commits, the textarea is replaced by the request
           shown READ-ONLY with its pulled-out terms highlighted, titled by the extractor's essence
           handle, with Edit paste / Re-run. (Title stays the console's sans, not the mockup's
           serif chrome — the panel deliberately keeps console chrome; see the file header.) */
        <div className="mb-4">
            <section
              data-slot="matcha-ask-card"
              className={`border-apollo-border bg-apollo-surface border px-5 py-4 shadow-[var(--apollo-shadow-card)] ${
                grantPath ? "rounded-[var(--apollo-radius-card)]" : "rounded-xl"
              }`}
            >
              {/* The mockup's header row: eyebrow + title on the left, the actions on the right —
                  ONE continuous padded card, no rule between header and body. Grant path
                  (Matcha Redesign.dc.html): the eyebrow names the SOURCE ("…from the opportunity
                  text" — the ask is the opportunity's own words, not something the officer
                  typed), the summary line is the extracted concepts, and the re-run is the
                  circular-arrows icon. NO "parsed …/scored …" dates ride this label: no data
                  source exists for them, and the artboard's dates are fiction. */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {grantPath ? (
                    <span className="block text-[11px] font-semibold tracking-[0.06em] text-[#6f6a5e] uppercase">
                      Matcha · what we read from the opportunity text
                    </span>
                  ) : (
                    <span className="text-muted-foreground block text-[11px] tracking-[0.05em] uppercase">
                      What we read from the ask
                    </span>
                  )}
                  {grantPath ? (
                    concepts.length > 0 ? (
                      /* The artboard's 16px/600 summary: every extracted concept, joined — with
                         the active non-topical asks as a muted suffix, live under the officer's
                         checkboxes exactly as `ask.title` is on the email path. text-[16px], not
                         text-base — this theme remaps text-base to 15px (globals.css --text-base)
                         and the artboard's one exact headline value for this card is 16px. */
                      <h2 data-slot="matcha-ask" className="mt-1 text-[16px] font-semibold">
                        {concepts.map((c) => c.term).join(", ")}
                        {(() => {
                          const suffix = preferences
                            .filter((p) => activePrefs.has(p.label))
                            .map((p) => p.label);
                          return suffix.length > 0 ? (
                            <span className="font-normal text-[#8b857b]">
                              {" · "}
                              {suffix.join(" · ")}
                            </span>
                          ) : null;
                        })()}
                      </h2>
                    ) : null
                  ) : matchaBrief && submissionId && (titleOverride ?? ask?.title) ? (
                    // Matcha Phase 3 — the officer can rename the search (an industry ask's
                    // generated handle can be wrong, or a wave name is wanted). The generated
                    // title is never overwritten; display = override ?? generated.
                    renaming ? (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Input
                          value={titleDraft}
                          maxLength={120}
                          aria-label="Search title"
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveTitle(generatedAsk?.title ?? "");
                            if (e.key === "Escape") setRenaming(false);
                          }}
                          className="bg-apollo-surface min-w-0 flex-[1_1_320px] text-base font-semibold"
                        />
                        <Button
                          type="button"
                          variant="apollo"
                          size="sm"
                          onClick={() => void saveTitle(generatedAsk?.title ?? "")}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setRenaming(false)}
                        >
                          Cancel
                        </Button>
                        {renameError ? (
                          <span className="text-destructive w-full text-xs">
                            Couldn&apos;t rename. Please try again.
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <h2 data-slot="matcha-ask" className="text-base font-medium">
                          {titleOverride ?? ask?.title}
                        </h2>
                        <span
                          data-slot="matcha-title-tag"
                          className="text-muted-foreground text-xs"
                        >
                          {/* A title the server composed from the officer's requester is still
                              the generated one, not a Rename. */}
                          {titleOverride && titleOverride !== ask?.title
                            ? "Renamed by you"
                            : "Generated title"}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          aria-label="Rename this search"
                          onClick={() => {
                            setTitleDraft(titleOverride ?? ask?.title ?? "");
                            setRenameError(false);
                            setRenaming(true);
                          }}
                        >
                          Rename
                        </Button>
                        {/* Who is asking — the model's guess, correctable. Same gate as Rename. */}
                        <div
                          data-slot="matcha-requester"
                          className="text-muted-foreground flex w-full flex-wrap items-center gap-1.5 text-xs"
                        >
                          {editingRequester ? (
                            <>
                              <Input
                                value={requesterDraft}
                                maxLength={120}
                                aria-label="Requester (who is asking)"
                                placeholder="Organization asking"
                                onChange={(e) => setRequesterDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void saveRequester();
                                  if (e.key === "Escape") setEditingRequester(false);
                                }}
                                className="bg-apollo-surface h-7 min-w-0 flex-[0_1_260px] text-xs"
                              />
                              <Button
                                type="button"
                                variant="apollo"
                                size="xs"
                                onClick={() => void saveRequester()}
                              >
                                Save
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => setEditingRequester(false)}
                              >
                                Cancel
                              </Button>
                              {requesterError ? (
                                <span className="text-destructive w-full">
                                  Couldn&apos;t save the requester. Please try again.
                                </span>
                              ) : null}
                            </>
                          ) : (
                            <>
                              {effectiveRequester ? (
                                <span>
                                  Requester:{" "}
                                  <span className="text-foreground font-medium">
                                    {effectiveRequester}
                                  </span>
                                  {" · "}
                                </span>
                              ) : null}
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                aria-label={effectiveRequester ? "Edit requester" : "Add requester"}
                                onClick={() => {
                                  setRequesterDraft(effectiveRequester ?? "");
                                  setRequesterError(false);
                                  setEditingRequester(true);
                                }}
                              >
                                {effectiveRequester ? "Edit" : "Add requester"}
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    )
                  ) : ask ? (
                    <h2
                      data-slot="matcha-ask"
                      className="mt-1 text-base font-medium"
                    >
                      {ask.title}
                    </h2>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {asOf ? (
                    /* Served from a persisted earlier run — say so, next to the button that
                       forces a fresh one. */
                    <span
                      data-slot="matcha-as-of"
                      className="text-muted-foreground mr-1 text-[12px] whitespace-nowrap"
                    >
                      Results from{" "}
                      {new Date(asOf).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  ) : null}
                  {allowEditPaste ? (
                    <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                      Edit paste
                    </Button>
                  ) : null}
                  {grantPath ? (
                    <>
                      {recentButton}
                      {/* The artboard's circular-arrows re-run. Same handler as "Re-run match";
                          `title` + `aria-label` because the visible content is an icon. */}
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={pending}
                        onClick={() =>
                          void runSearch(matchedText, { include: included, fresh: true })
                        }
                        title="Match researchers again"
                        aria-label="Match researchers again"
                      >
                        <RefreshCw className="size-4" aria-hidden />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void runSearch(matchedText, { include: included, fresh: true })
                        }
                        className="bg-[var(--color-accent-slate)] text-white hover:bg-[var(--color-accent-slate)]/90"
                      >
                        {pending ? "Ranking…" : "Re-run match"}
                      </Button>
                      {recentButton}
                    </>
                  )}
                </div>
              </div>

              {/* Self-awareness caveat for a thin extraction — read BEFORE the highlighted terms
                  below, so it caveats the ask rather than trailing the ranking it explains. */}
              {matchSignal.thin ? (
                <div
                  role="status"
                  data-testid="matcha-thin-signal"
                  className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
                >
                  <span className="font-medium">Thin match.</span>{" "}
                  {THIN_SIGNAL_COPY[matchSignal.reason]}
                </div>
              ) : null}

              {/* The committed paste (see `askQuote`). Grant path: collapsed behind the
                  artboard's disclosure — the opportunity's own synopsis is already on the page
                  above this card, so its highlighted copy is a reveal, not the headline. The
                  existing highlight markup and its explainer render unchanged inside. */}
              {grantPath ? (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setShowSource((v) => !v)}
                    aria-expanded={showSource}
                    className="text-xs font-medium text-[var(--apollo-slate)] underline-offset-4 hover:underline"
                  >
                    {showSource
                      ? "Hide source text with matched concepts"
                      : "Show source text with matched concepts"}
                      <Caret dropdown open={showSource} className="ml-0.5 inline-block align-[-2px]" />
                  </button>
                  {showSource ? askQuote : null}
                </div>
              ) : (
                askQuote
              )}
            </section>
          </div>
      ) : (
        <>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(description);
          }}
          className="mb-4"
        >
          {/* Matcha Empty State — the artboard's ask card. Wraps the whole idle ask block (label,
              corpus toggle, textarea, footer) in the file's standard apollo card chrome; the
              recents section below stays a SIBLING, outside this card. */}
          <div className="border-apollo-border bg-apollo-surface rounded-xl border px-[22px] py-5 shadow-[var(--apollo-shadow-card)]">
            <label htmlFor="matcha-description" className="mb-1.5 block text-[13px] font-semibold">
              The ask
            </label>
            {/* Grant Matcha (increment 3) — the corpus toggle, mirroring the increment-1 engine
                toggle chrome. Switching clears results back to the editable textarea so the officer
                re-runs the ask under the new target rather than reading a stale cross-target list. */}
            {grantMatcha ? (
              <div
                role="tablist"
                aria-label="Search target"
                className="mb-3 inline-flex rounded-md border border-[var(--color-border)] p-0.5 text-sm"
              >
                {(["people", "grants"] as const).map((t) => {
                  const isActive = target === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => {
                        if (t === target) return;
                        setTarget(t);
                        setStatus({ kind: "idle" });
                        setEditing(true);
                      }}
                      data-testid={`matcha-target-${t}`}
                      className={[
                        "rounded px-3 py-1 transition-colors",
                        isActive
                          ? "bg-[var(--color-accent-slate)] font-medium text-white"
                          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
                      ].join(" ")}
                    >
                      {t === "people" ? "Researchers" : "Opportunities"}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <textarea
              id="matcha-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              placeholder={
                target === "grants"
                  ? "Describe the research to find matching funding opportunities…"
                  : "Paste the opportunity's description of their interest…"
              }
              className="border-border w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
              spellCheck={false}
            />
            {/* Slate, not `variant="apollo"` (maroon) — the whole matcher family (find-researchers,
                opportunity intake, and the mockup) is slate. */}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              {/* Matcha Empty State — the idle hint. Empty paste: what nothing-typed-yet means
                  (and, since nothing is sent until submit, that nothing is retained yet either).
                  Non-empty: a live word count, so the officer has some sense of what they pasted
                  before running it. */}
              <span className="text-muted-foreground text-[12px]">
                {description.trim().length === 0
                  ? "Paste text to enable matching. Nothing is saved until you run it"
                  : `${description.trim().split(/\s+/).length} words read`}
              </span>
              <Button
                type="submit"
                disabled={pending || description.trim().length === 0}
                className="bg-[var(--color-accent-slate)] text-white hover:bg-[var(--color-accent-slate)]/90"
              >
                {pending
                  ? "Ranking…"
                  : target === "grants"
                    ? "Rank opportunities"
                    : "Rank researchers"}
              </Button>
            </div>
          </div>
        </form>
        {recentSearchesSection}
        </>
      )}

      {status.kind === "loading" ? (
        <div aria-busy="true">
          <p className="text-muted-foreground py-3 text-sm">Ranking {targetNoun}…</p>
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="border-apollo-border bg-apollo-surface rounded-lg border p-4">
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
        target === "grants" ? (
          <GrantResults candidates={grantCandidates} topScore={grantTopScore} />
        ) : (
        <>
          {/* The ask (title + read-only, highlighted request) renders in the ask card above,
              in place of the textarea — see `showAskCard`. */}
          {ranked.length === 0 ? (
            /* #1919 — a bare "no researchers matched" reads as "Weill Cornell has nobody for
               this", which is rarely what happened. The concepts are already in state and are
               the only evidence of WHY nothing ranked, so the empty state names them: either
               the ask yielded no research concept at all (a mechanism or eligibility rules
               rather than a subject — the NIGMS RM1 case), or it yielded concepts that no
               profile matched. The officer can tell those apart at a glance; nothing here
               predicts the outcome, it reports it. */
            <div className="text-muted-foreground py-4 text-sm">
              <p>No researchers matched this description.</p>
              {concepts.length === 0 ? (
                <>
                  <p className="mt-1">
                    Nothing was extracted to search on — the ask may describe a funding mechanism or
                    its eligibility rules rather than a research area.
                  </p>
                  {/* The recovery path (grant path only — the email path's ask is already the
                      officer's own paste): the synopsis this ask was seeded from is often pure
                      mechanism prose, while the FOA's research-strategy section carries the
                      science the extractor needs. The grant ask itself is READ-ONLY
                      (allowEditPaste={false}, owner-ruled), so the paste has to happen on
                      /edit/matcha — the copy names that page. Extraction, seeding and the
                      auto-run are deliberately untouched — this is advice, not behavior. */}
                  {grantPath ? (
                    <p className="mt-1">
                      Pasting the FOA&rsquo;s research-strategy or program-description section into
                      a new ask on the Matcha page usually finds the research area.
                    </p>
                  ) : null}
                  {/* Same idiom as the synopsis header's More-information link (grant-matcha-panel):
                      the officer needs the FOA's full text to do the recovery above, and this is
                      where it lives. Absent `sourceUrl` — today's render, byte-identical. */}
                  {sourceUrl ? (
                    <a
                      href={sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)] hover:underline"
                    >
                      More information <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  ) : null}
                </>
              ) : (
                <p className="mt-1">
                  Searched on {concepts.map((c) => c.term).join(", ")} — no Weill Cornell
                  researcher matched {concepts.length === 1 ? "it" : "any of them"}.
                </p>
              )}
            </div>
          ) : (
            /* Two-column shell, matching the mockup's rail + results split and
               `/edit/find-researchers`'s idiom. lg:w-80 (not find-researchers' w-64) because
               this rail carries sliders and member chips. */
            <div className="flex flex-col gap-x-8 gap-y-6 lg:flex-row">
              {/* Warm-palette redesign — the rail is ONE greige unit (bg-apollo-rail + hairline
                  border), and the inner groups drop their own boxes: `divide-y` draws a single
                  hairline between whichever groups actually render (adjacent-sibling, so a hidden
                  group leaves no orphan rule). `p-1.5` is the mockup's 6px rail inset. */}
              <aside className="w-full shrink-0 divide-y divide-apollo-border rounded-xl border border-apollo-rail-border bg-apollo-rail p-1.5 lg:w-80">
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

                {/* #1780 Phase 2 — the extractor pulled these from the paste but the cut did NOT
                    search them. Click one to include it: unlike a slider, adding a term has to
                    RE-RUN (a new term has no scores in the browser yet). Additive up to the term
                    ceiling; kind-coloured to match the rail and the paste marks (blue concept /
                    purple method). Disappears once nothing is left to add. */}
                {culledVisible.length > 0 ? (
                  <div data-slot="matcha-culled" className="p-3">
                    <h2 className="text-base font-semibold">Also detected</h2>
                    <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                      Pulled from the paste but not searched. Add one to include it — this re-runs
                      the match.
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {culledVisible.map((c) => (
                        <li key={c.term}>
                          <button
                            type="button"
                            disabled={pending || atCap}
                            onClick={() => addCulled(c.term)}
                            aria-label={`Add ${c.term} to the search`}
                            className={`rounded-full border px-2 py-0.5 text-xs font-medium transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50 ${
                              c.kind === "method"
                                ? "border-[var(--color-facet-method-border)] bg-[var(--color-facet-method-fill)] text-[var(--color-facet-method-text)]"
                                : "border-[var(--color-facet-topic-border)] bg-[var(--color-facet-topic-fill)] text-[var(--color-facet-topic-text)]"
                            }`}
                          >
                            <span aria-hidden="true">+ </span>
                            {c.term}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {atCap ? (
                      <p className="text-muted-foreground mt-2 text-xs italic">
                        Maximum terms reached.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {/* #1654 — the sponsor's non-topical asks, renamed "Eligibility" in the warm-palette
                    redesign and given the teal THIRD accent (blue/purple are the concept/method kinds,
                    green/amber the fit tiers — see the ELIGIBILITY role in globals.css). It stays a
                    NUDGE, not a filter: it reweights the ranking and hides no one, which is why it sits
                    apart from Filter. Each is checked by default — the sponsor said it — and unchecking
                    re-ranks live, the escape hatch when the extractor reads an ask that was never there.
                    ⚠ Open product Q for review: "Eligibility" reads like a hard gate but this only
                    NUDGES; keep the nudge sub-note, or change it to actually gate (a behaviour change,
                    not a rename). Default here: keep it a nudge. */}
                {preferences.length > 0 || eligibility ? (
                  <div data-slot="matcha-preferences" className="p-3">
                    <h2 className="flex items-center gap-2 text-base font-semibold text-elig-text">
                      <span
                        aria-hidden
                        className="inline-block size-2 shrink-0 rounded-full bg-elig-border"
                      />
                      Eligibility
                    </h2>
                    {/* Grant Matcha — the HARD axes, rendered RELEVANCE-DRIVEN: an axis appears only
                        when THIS opportunity carries that requirement, so most opportunities show
                        0–2. Absent on `/edit/matcha`, which keeps the nudge-only section verbatim. */}
                    {eligibility?.careerStages ? (
                      <div data-slot="matcha-elig-hard" className="mt-2">
                        <p className="text-muted-foreground text-xs leading-relaxed">
                          Hard filters from the opportunity. <b>Uncheck to reveal researchers
                          who&rsquo;d otherwise be filtered out</b> — you own the predicate, not the
                          extractor.
                        </p>
                        <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-[3px] size-3.5 shrink-0 accent-elig-border"
                            checked={stageGateOn}
                            onChange={() => setStageGateOn((v) => !v)}
                          />
                          <span className="min-w-0">
                            <span className="font-medium">Career stage</span>
                            <span className="text-muted-foreground block text-xs leading-snug">
                              {stageGateOn
                                ? `Required: ${eligibility.careerStages
                                    .map((s) => careerStageLabel(s))
                                    .join(" · ")}`
                                : "Relaxed — ineligible researchers are shown, badged"}
                            </span>
                            {/* A checked hard filter that removes nobody is indistinguishable from
                                a broken one: the pool reads "160 → 160", every row badges Eligible,
                                and nothing says whether the gate ran. It usually HAS run and found
                                nothing to drop — most ranked pools are faculty, and this axis only
                                excludes students. Say so, rather than leaving the officer to guess.
                                (The gate itself is covered by the floor tests: absent or
                                out-of-set stages ARE dropped.) */}
                            {stageGateOn && ineligibleRows.length === 0 ? (
                              <span className="text-muted-foreground/80 block text-xs leading-snug">
                                Nobody in these results is excluded by it.
                              </span>
                            ) : null}
                            {/* Cite the sponsor, not just our mapping of it. The stage list is
                                SPS's vocabulary; this is the text it was derived from, and it is
                                usually absent from the synopsis on screen — so without it the axis
                                reads as a requirement nobody stated. */}
                            {eligibility.stageSource ? (
                              <span
                                className="text-muted-foreground/80 mt-0.5 block line-clamp-2 text-xs italic leading-snug"
                                title={eligibility.stageSource}
                              >
                                Opportunity&rsquo;s eligibility: &ldquo;{eligibility.stageSource}
                                &rdquo;
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </div>
                    ) : null}
                    {/* US is DISPLAY-ONLY by design: only 4.2% of opportunities require person-level
                        citizenship and SPS holds no scholar citizenship field, so a toggle here would
                        either filter nothing or imply data we do not have. */}
                    {eligibility?.usRequired ? (
                      <p
                        data-slot="matcha-elig-us"
                        className="text-muted-foreground mt-2 text-xs leading-relaxed"
                      >
                        Requires US citizenship or permanent residency — confirm per candidate. Not
                        filterable here: the directory carries no citizenship field.
                      </p>
                    ) : null}
                    {preferences.length > 0 || eligibility?.esiTargeted ? (
                      <>
                    <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                      Requirements detected in the ask. These nudge the ranking — they don&rsquo;t hide
                      anyone.
                    </p>
                    <ul className="mt-2 space-y-2">
                      {/* ESI is SOFT on purpose — the extractor's `esi_targeted` is a priority, not a
                          gate — so it rides the same λ=0.25 preference boost and hides nobody. */}
                      {eligibility?.esiTargeted ? (
                        <li>
                          <label className="flex cursor-pointer items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="mt-[3px] size-3.5 shrink-0 accent-elig-border"
                              checked={esiBoostOn}
                              onChange={() => setEsiBoostOn((v) => !v)}
                            />
                            <span className="min-w-0">
                              <span className="font-medium">Early-stage investigator</span>
                              <span className="text-muted-foreground block text-xs italic leading-snug">
                                from this opportunity&rsquo;s eligibility — nudges ESI researchers up,
                                hides no one
                              </span>
                            </span>
                          </label>
                        </li>
                      ) : null}
                      {preferences.map((p) => (
                        <li key={p.label}>
                          <label className="flex cursor-pointer items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="mt-[3px] size-3.5 shrink-0 accent-elig-border"
                              checked={activePrefs.has(p.label)}
                              onChange={() => setActivePrefs(toggled(activePrefs, p.label))}
                            />
                            <span className="min-w-0">
                              <span className="font-medium">{p.label}</span>
                              <span className="text-muted-foreground block text-xs italic leading-snug">
                                from the ask: &ldquo;{p.evidence}&rdquo;
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {/* The mockup's five groups. `Career stage` and `Clinician` were held back until
                    `measures` had a producer (#1654) — a filter that cannot filter is worse than
                    no filter. Both now render only when at least one ranked row carries the
                    measure, so they still disappear rather than lie. */}
                <div data-slot="matcha-facets" className="p-3">
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
                      selected={roleSelEffective}
                      onToggle={(v) => setRoleSel(toggled(roleSelEffective, v))}
                      title="The Enterprise Directory's person type — faculty, postdoc, doctoral student, and so on."
                    />
                  ) : null}
                  {typeFacet.length > 0 ? (
                    <FacetGroup
                      label="Researcher type"
                      options={typeFacet}
                      selected={typeSelEffective}
                      onToggle={(v) => setTypeSel(toggled(typeSelEffective, v))}
                      title={`Research-active = PI on a research award from any sponsor, or ${RESEARCH_TYPE_MIN_PUBS}+ first/last-author lab research papers, in the last ${RESEARCH_ACTIVE_YEARS} years. Physician-scientists and clinicians also have a clinical profile in the Enterprise Directory. Clinicians are hidden by default.`}
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
                  {/* Grant path — the artboard's 15px/600 header; the email path keeps 16px. */}
                  <h2 className={grantPath ? "text-[15px] font-semibold" : "text-base font-semibold"}>
                    {/* `eligibleRows`, not `filtered` — the header must count the post-gate stage
                        it paints, with the gate's own count named beside it (see resultsSummary).
                        No gate ⇒ eligibleRows === filtered and the fourth argument is 0, so
                        `/edit/matcha` renders byte-identically. */}
                    {resultsSummary(
                      visible.length,
                      eligibleRows.length,
                      ranked.length,
                      ineligibleRows.length,
                    )}
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
                    {/* D3 — recency dial. Stays DETACHED pills — a three-mode dial with a year
                        sub-control, not a clean binary, so it does NOT conjoin the way the density and
                        sort pairs now do. Hidden entirely when the payload carries no years, because a
                        dial that cannot move anything is worse than no dial. "Since" reveals a native
                        year picker — a soft cutoff that down-weights older evidence to the floor,
                        never hides it (D4). */}
                    {hasRecencyData ? (
                      <div role="group" aria-label="Recency" className="flex items-center gap-1">
                        {/* Grant path — the three modes ride ONE artboard segmented pill (the
                            year sub-control stays a detached select beside it); the email path
                            keeps its detached pills. Same buttons, same handlers, either way. */}
                        <div className={grantPath ? SEG_TRACK : "contents"}>
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
                                className={
                                  grantPath
                                    ? segClass(active)
                                    : `rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                                        active
                                          ? "border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
                                          : "border-border text-foreground/80 hover:border-[var(--color-accent-slate)]"
                                      }`
                                }
                              >
                                {grantPath && t.key === "since" ? "Since…" : t.label}
                              </button>
                            );
                          })}
                        </div>
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
                    {/* D8 — density toggle, CONJOINED like the Sort pair (warm-palette redesign): one
                        shared border, radius on the outer edges only, `-ml-px` seam laps the second
                        segment's border onto the first, `z-10` on the active segment lifts its slate
                        edge over that seam. Density is ONE axis with two mutually-exclusive positions —
                        exactly the criterion the Sort comment uses to justify conjoining — so it should
                        read as a control with a position, not two independent pills that happen to
                        disagree. Recency stays detached: three-mode dial + year sub-control, not a
                        clean binary. The gap-4 between the three groups still does the grouping. */}
                    <div
                      role="group"
                      aria-label="Result density"
                      className={grantPath ? SEG_TRACK : "flex items-center"}
                    >
                      {(["detailed", "compact"] as const).map((d, i, arr) => (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={density === d}
                          onClick={() => setDensity(d)}
                          className={
                            grantPath
                              ? `${segClass(density === d)} capitalize`
                              : `relative border px-2.5 py-0.5 text-xs capitalize transition-colors ${
                                  i === 0 ? "rounded-l-full" : "-ml-px"
                                } ${i === arr.length - 1 ? "rounded-r-full" : ""} ${
                                  density === d
                                    ? "z-10 border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
                                    : "border-border text-foreground/80 hover:border-[var(--color-accent-slate)]"
                                }`
                          }
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
                    {/* Fit/Name is NOT on the artboard — artboard omission is not a removal
                        decision, so it stays, restyled to the same segmented idiom. */}
                    <div
                      role="group"
                      aria-label="Sort researchers"
                      className={grantPath ? SEG_TRACK : "flex items-center"}
                    >
                      {SORT_TABS.map((t, i) => (
                        <button
                          key={t.key}
                          type="button"
                          aria-pressed={sort === t.key}
                          onClick={() => setSort(t.key)}
                          className={
                            grantPath
                              ? segClass(sort === t.key)
                              : `relative border px-2.5 py-0.5 text-xs transition-colors ${
                                  i === 0 ? "rounded-l-full" : "-ml-px"
                                } ${i === SORT_TABS.length - 1 ? "rounded-r-full" : ""} ${
                                  sort === t.key
                                    ? "z-10 border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
                                    : "border-border text-foreground/80 hover:border-[var(--color-accent-slate)]"
                                }`
                          }
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
                    {briefsOn ? (
                      <div
                        data-slot="matcha-brief-toolbar"
                        className="flex flex-wrap items-center gap-2"
                      >
                        <span className="text-muted-foreground text-[12.5px]">
                          <b className="text-foreground font-semibold">Briefs</b>{" "}
                          {briefMap.size} drafted
                          {briefDrafting.size > 0 ? ` · ${briefDrafting.size} drafting` : ""}
                          {briefFailedCount > 0 ? ` · ${briefFailedCount} failed` : ""}
                          {briefsSavedAt
                            ? ` · drafted ${formatBriefDate(briefsSavedAt, true)}` +
                              " · records may have changed"
                            : ""}
                        </span>
                        {briefCanEdit ? (
                          <Button
                            type="button"
                            variant="apollo"
                            size="sm"
                            disabled={briefTargets.length === 0}
                            onClick={() => enqueueBriefs(briefTargets)}
                          >
                            {shortlistRows.length > 0
                              ? `Draft briefs (${Math.min(
                                  shortlistRows.length,
                                  BRIEF_SHORTLIST_MAX,
                                )} shortlisted)`
                              : `Draft briefs (top ${BRIEF_TOP_N})`}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
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
                    {/* Matcha Phase 4 — the printable report. Same flag as the briefs. */}
                    {briefsOn ? (
                      reportCwids.length > 0 ? (
                        <Button type="button" variant="outline" size="sm" onClick={openReport}>
                          <FileText className="size-3.5" />
                          Report (PDF)
                        </Button>
                      ) : (
                        <HoverTooltip
                          wide
                          text="Shortlist researchers, or draft briefs, to build a report."
                        >
                          <Button type="button" variant="outline" size="sm" disabled>
                            <FileText className="size-3.5" />
                            Report (PDF)
                          </Button>
                        </HoverTooltip>
                      )
                    ) : null}
                    {/* Matcha contact — drafters only; the ticked rows are the recipients. */}
                    {contactOn ? (
                      shortlistRows.length > CONTACT_MAX ? (
                        <HoverTooltip
                          wide
                          text={`Email addresses are available for ${CONTACT_MAX} or fewer people. Untick some rows.`}
                        >
                          <Button type="button" variant="outline" size="sm" disabled>
                            <Mail className="size-3.5" />
                            Email selected (BCC)
                          </Button>
                        </HoverTooltip>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-slot="matcha-email-selected"
                          disabled={shortlistRows.length === 0 || emailDialog?.kind === "loading"}
                          onClick={() => void openEmailDialog()}
                        >
                          <Mail className="size-3.5" />
                          Email selected (BCC)
                        </Button>
                      )
                    ) : null}
                    {emailDialog ? (
                      <EmailSelectedDialog
                        state={emailDialog}
                        onChange={setEmailDialog}
                        onClose={() => setEmailDialog(null)}
                      />
                    ) : null}
                    {reportPrompt ? (
                      <Dialog
                        open
                        onOpenChange={(open) => {
                          if (!open) setReportPrompt(null);
                        }}
                      >
                        <DialogContent data-slot="matcha-report-prompt">
                          <DialogHeader>
                            <DialogTitle className="leading-snug">
                              {reportPrompt.missing.length} of {reportPrompt.cwids.length}{" "}
                              {reportPrompt.noun} researcher
                              {reportPrompt.cwids.length === 1 ? "" : "s"}{" "}
                              {reportPrompt.missing.length === 1 ? "has" : "have"} no brief yet.
                            </DialogTitle>
                            <DialogDescription>
                              {
                                'Their sections will show records only (funding, appointments, key papers), with no "Why this PI" or discussion topics.'
                              }
                            </DialogDescription>
                          </DialogHeader>
                          {!briefCanEdit ? (
                            <p className="text-sm">Ask a Scholars admin to draft them.</p>
                          ) : null}
                          {reportPrompt.phase === "drafting" ? (
                            <p className="text-sm" role="status">
                              Drafting{" "}
                              {Math.min(reportSettled.length + 1, reportPrompt.missing.length)} of{" "}
                              {reportPrompt.missing.length}…
                            </p>
                          ) : null}
                          {reportPrompt.phase === "done" && !reportPrompt.blocked ? (
                            <p className="text-sm" role="status">
                              The report opened in a new tab.
                            </p>
                          ) : null}
                          {reportFailed.length > 0 && reportPrompt.phase !== "ask" ? (
                            <p className="text-destructive text-sm">
                              Could not draft: {reportFailed.map(nameOf).join(", ")}. They stay in
                              the report, records only.
                            </p>
                          ) : null}
                          <DialogFooter>
                            {reportPrompt.phase === "ask" ? (
                              <>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setReportPrompt(null)}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={openReportAnyway}
                                >
                                  Open report without them
                                </Button>
                                {briefCanEdit ? (
                                  <Button
                                    type="button"
                                    variant="apollo"
                                    size="sm"
                                    onClick={draftThenReport}
                                  >
                                    Draft {reportPrompt.missing.length} brief
                                    {reportPrompt.missing.length === 1 ? "" : "s"}, then open report
                                  </Button>
                                ) : null}
                              </>
                            ) : reportPrompt.phase === "done" ? (
                              <>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setReportPrompt(null)}
                                >
                                  Close
                                </Button>
                                {reportPrompt.blocked && submissionId ? (
                                  <Button asChild variant="apollo" size="sm">
                                    <a
                                      href={reportHref(submissionId, reportPrompt.cwids)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={() => setReportPrompt(null)}
                                    >
                                      Open report
                                    </a>
                                  </Button>
                                ) : null}
                              </>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setReportPrompt(null)}
                              >
                                Cancel
                              </Button>
                            )}
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    ) : null}
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
                        className="border-apollo-border bg-apollo-surface-2 inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 text-xs"
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
                    className="border-apollo-border bg-apollo-surface-2 mb-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
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

                {visible.length === 0 && ineligibleRows.length === 0 ? (
                  /* Genuinely empty — the facets matched nobody and the gate hid nobody. The
                     gate-hid-everyone case is NOT this branch: it renders below, where the
                     eligibility fold can come with it. */
                  <p className="text-muted-foreground py-4 text-sm">
                    No researchers match the selected filters.
                  </p>
                ) : (
                  <>
                    {(() => {
                      /* Zero-results fix (2026-08-21): when the hard career-stage gate hides
                         EVERY match (a postdoc-only K99 against a faculty-dominant pool), the
                         old empty-state branch swallowed the eligibility fold with the rows —
                         "No researchers match the selected filters" over nothing, with every
                         match one unreachable click away. Say what happened, in the rail's own
                         vocabulary (the "Career stage" axis under "Eligibility"), and keep the
                         fold on screen. NO predicate moved: the gate still hides exactly the
                         same rows, and the fold's own show/hide behavior is unchanged. */
                      const gateHidAll = visible.length === 0;
                      const explain = gateHidAll ? (
                        <div
                          data-slot="matcha-gate-empty"
                          className="text-muted-foreground py-4 text-sm"
                        >
                          <p>
                            All {ineligibleRows.length} matched researcher
                            {ineligibleRows.length === 1 ? " is" : "s are"} hidden by the Career
                            stage filter.
                          </p>
                          <p className="mt-1">
                            Uncheck Career stage under Eligibility in the rail to reveal them,
                            badged as ineligible.
                          </p>
                        </div>
                      ) : null;
                      const primaryList = gateHidAll ? null : (
                        <ul>
                          {primaryRows.map(({ c, rank }) => (
                            <li key={c.cwid}>{renderResult({ c, rank })}</li>
                          ))}
                        </ul>
                      );
                      // Grant path × compact — the artboard's TABLE: one card (its own x-scroll,
                      // so a narrow console never squeezes the grid), header row on greige, the
                      // rows + both floor bars inside so their columns and rules line up. The
                      // header's leading spacer mirrors the row's checkbox cell (w-[44px]).
                      if (!grantTable) {
                        return (
                          <>
                            {explain}
                            {primaryList}
                            {weakFloorSection}
                            {eligFloorSection}
                          </>
                        );
                      }
                      return (
                        <>
                          {explain}
                          <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)]">
                            <div className="min-w-[660px]">
                              {/* The header row stays even when the gate hid every row — it is
                                  what labels the columns the fold reveals. */}
                              <div className="bg-apollo-surface-2 flex items-center text-[10.5px] font-semibold tracking-[0.06em] text-[#6f6a5e] uppercase">
                                <span className="w-[44px] shrink-0" aria-hidden />
                                <div
                                  className="grid flex-1 items-center gap-3 py-[11px] pr-[18px]"
                                  style={{ gridTemplateColumns: GRANT_TABLE_COLUMNS }}
                                >
                                  <span className="text-right">#</span>
                                  <span>Researcher</span>
                                  <span>Match</span>
                                  <span>Evidence · concepts hit</span>
                                  <span>Latest work</span>
                                  <span aria-hidden />
                                </div>
                              </div>
                              {primaryList}
                              {weakFloorSection}
                              {eligFloorSection}
                            </div>
                          </div>
                        </>
                      );
                    })()}

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
        )
      ) : null}
      {historyDrawer}
    </div>
  );
}

/**
 * Grant Matcha (increment 3) — the query→grants results view. A lean ranked list of the
 * opportunities the spine matched, reusing the forward matcher's at-a-glance fact line
 * (sponsor · mechanism · deadline · ceiling) and THIS panel's own fit-tier vocabulary so grant
 * tiers read identically to person tiers. No rail / facets / centrality sliders yet — letting the
 * officer relax an eligibility or centrality predicate is a later increment.
 */
function GrantResults({ candidates, topScore }: { candidates: GrantCandidate[]; topScore: number }) {
  if (candidates.length === 0) {
    return (
      <p className="text-muted-foreground py-4 text-sm">
        No opportunities matched this description.
      </p>
    );
  }
  return (
    <section aria-label="Ranked opportunities">
      <p className="text-muted-foreground py-3 text-sm">
        {candidates.length} matching opportunit{candidates.length === 1 ? "y" : "ies"}
      </p>
      <ul className="space-y-3">
        {candidates.map((c) => (
          <li key={c.opportunityId}>
            <GrantResultCard candidate={c} topScore={topScore} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One opportunity card: title + fit tier, the at-a-glance fact line, and the concepts it ranked
 *  under as explanation chips (the same "Ranks here" pill idiom as the people rows). */
function GrantResultCard({
  candidate,
  topScore,
}: {
  candidate: GrantCandidate;
  topScore: number;
}) {
  const tier = fitTier(candidate.fusedScore, topScore);
  const urgency = dueUrgency(candidate.dueDate, Date.now());
  const facts = [candidate.sponsor, candidate.mechanism].filter((x): x is string => Boolean(x));
  // Distinct concept terms this opportunity ranked under — the "why it matched" chips.
  const terms = Array.from(new Set(candidate.contributions.map((c) => c.term)));
  return (
    <div
      data-slot="grant-result-card"
      className="border-apollo-border bg-apollo-surface rounded-lg border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-foreground font-medium">
          {candidate.title ?? "Untitled opportunity"}
        </h3>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TIER_CLASS[tier]}`}
        >
          {TIER_LABEL[tier]}
        </span>
      </div>
      <div className="text-muted-foreground mt-0.5 text-sm">
        {facts.length > 0 ? `${facts.join(" · ")} · ` : ""}
        <span
          className={
            urgency === "soon" ? "font-medium text-apollo-amber" : undefined
          }
        >
          {deadlineLabel(candidate.dueDate, candidate.status)}
        </span>
        {candidate.awardCeiling ? ` · up to ${formatUsd(candidate.awardCeiling)}` : null}
      </div>
      {terms.length > 0 ? (
        <p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          <span className="text-foreground rounded bg-[var(--color-accent-slate)]/30 px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.02em]">
            Matches
          </span>
          {terms.join(" · ")}
        </p>
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
    <div data-slot="matcha-concepts" className="p-3">
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
                {/* #1972 side-finding — the ranker already weights on MeSH resolution confidence
                    internally (a 10x difference between `exact` and `partial` in the fusion), but
                    until now nothing on the wire said so. Surface only the uncertain case: `exact`/
                    `entry-term` are the default, unremarkable path and would just be noise on every
                    row. Absent `meshConfidence` (never resolved to a descriptor at all) is not this
                    case either — that concept still searches on bare text, just without the MeSH
                    boost, and is not what this badge is warning about. */}
                {c.meshConfidence === "partial" ? (
                  <HoverTooltip
                    wide
                    triggerClassName="ml-1.5"
                    text="This concept only matched a MeSH term via a partial (word-window) resolution, not a verbatim one — the topical boost behind it is weaker and less certain."
                  >
                    <span className="border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber rounded-full border px-1.5 py-0.5 text-xs">
                      ·weak match
                    </span>
                  </HoverTooltip>
                ) : null}
                {/* Warm-palette redesign — provenance `ⓘ` on EVERY concept/method, replacing the old
                    inline gloss paragraph AND the inline member chips. Reuses the SAME `HoverTooltip`
                    primitive `·rare` uses (no Radix-in-server-component hazard). Leads with "From the
                    ask": the gloss quote when present, else a plain provenance line so the tooltip is
                    never empty; and when a concept merged multiple forms, they follow as kind-coloured
                    chips under "One slider · merged forms" — so it is clear e.g. IPF rides the fibrosis
                    slider. The marker's mere presence signals "pulled from the ask"; its chips-vs-none
                    signals multi-form vs single term. */}
                <HoverTooltip
                  wide
                  triggerClassName="ml-1.5 align-middle"
                  text={c.gloss ? `From the ask: “${c.gloss}”` : "Detected in the paste."}
                  body={
                    <span className="block space-y-1.5 text-left">
                      <span className="block text-[10px] font-medium tracking-[0.05em] text-white/60 uppercase">
                        From the ask
                      </span>
                      {c.gloss ? (
                        <span className="block italic">&ldquo;{c.gloss}&rdquo;</span>
                      ) : (
                        <span className="block text-white/80">Detected in the paste.</span>
                      )}
                      {c.members.length > 1 ? (
                        <>
                          <span className="block text-[10px] font-medium tracking-[0.05em] text-white/60 uppercase">
                            One slider · merged forms
                          </span>
                          <span className="flex flex-wrap gap-1">
                            {c.members.map((m) => (
                              <span
                                key={m}
                                className={`rounded-full border px-1.5 py-0.5 text-[11px] ${
                                  c.kind === "method"
                                    ? "border-[var(--color-facet-method-border)] bg-[var(--color-facet-method-fill)] text-[var(--color-facet-method-text)]"
                                    : "border-[var(--color-facet-topic-border)] bg-[var(--color-facet-topic-fill)] text-[var(--color-facet-topic-text)]"
                                }`}
                              >
                                {m}
                              </span>
                            ))}
                          </span>
                        </>
                      ) : null}
                    </span>
                  }
                >
                  {/* tabIndex so the ⓘ is keyboard-reachable: it now carries the gloss + merged-form
                      provenance that used to render as always-visible DOM, so focus-to-open + Radix's
                      aria-describedby keep it accessible to keyboard/SR users. */}
                  <span
                    tabIndex={0}
                    aria-label={`Where “${c.term}” came from`}
                    className="text-muted-foreground inline-flex size-[15px] cursor-help items-center justify-center rounded-full border border-apollo-border-strong text-[10px] font-medium"
                  >
                    i
                  </span>
                </HoverTooltip>
              </span>
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {c.centrality.toFixed(2)}
              </span>
            </div>
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
 * Matcha contact — the "Email selected (BCC)" dialog: editable Subject and Body prefilled from the
 * standard template (`lib/edit/matcha-email.ts`), then "Open in mail app" (a `mailto:` with the
 * officer as To, so clients accept it, and the researchers in Bcc) or "Copy addresses" (for long
 * lists). Addresses live only in this dialog's state; nothing is sent from Scholars.
 */
function EmailSelectedDialog({
  state,
  onChange,
  onClose,
}: {
  state: EmailDialogState;
  onChange: (next: EmailDialogState) => void;
  onClose: () => void;
}) {
  const emails = state.kind === "ready" ? state.contacts.map((c) => c.email) : [];
  const mailto =
    state.kind === "ready" && emails.length > 0
      ? buildMailto({
          to: state.officer.email,
          bcc: emails,
          subject: state.subject,
          body: state.body,
        })
      : "";
  const tooLong = mailto.length > MAILTO_SOFT_LIMIT;

  async function copyAddresses() {
    if (state.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(addressList(emails));
      onChange({ ...state, copied: "ok" });
    } catch {
      onChange({ ...state, copied: "manual" });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-slot="matcha-email-dialog" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Email selected researchers</DialogTitle>
          <DialogDescription>
            {state.kind === "ready"
              ? `${state.contacts.length} ${state.contacts.length === 1 ? "address" : "addresses"} in Bcc. Edit the message, then open it in your mail app.`
              : "Addresses are looked up when you ask and are not saved."}
          </DialogDescription>
        </DialogHeader>
        {state.kind === "loading" ? (
          <p className="text-sm" role="status">
            Looking up addresses…
          </p>
        ) : state.kind === "error" ? (
          <p className="text-destructive text-sm" role="alert">
            {state.message}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {state.missing.length > 0 ? (
              <p className="text-muted-foreground text-sm" data-slot="matcha-email-missing">
                {state.missing.length} without an email on record:{" "}
                {state.missing.map((m) => m.name).join(", ")}
              </p>
            ) : null}
            <label className="flex flex-col gap-1 text-sm font-medium">
              Subject
              <Input
                value={state.subject}
                onChange={(e) => onChange({ ...state, subject: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Body
              <Textarea
                rows={10}
                value={state.body}
                onChange={(e) => onChange({ ...state, body: e.target.value })}
              />
            </label>
            {tooLong ? (
              <p className="text-sm" data-slot="matcha-email-too-long">
                This message is long for some mail apps to open with every address. If it does
                not open, copy the addresses and paste them into Bcc.
              </p>
            ) : null}
            {state.copied === "ok" ? (
              <p className="text-sm" role="status">
                Copied {emails.length} {emails.length === 1 ? "address" : "addresses"}. Paste them
                into Bcc.
              </p>
            ) : state.copied === "manual" ? (
              <textarea
                readOnly
                rows={3}
                value={addressList(emails)}
                aria-label="Email addresses"
                className="border-border w-full rounded border p-2 text-xs"
                onFocus={(e) => e.currentTarget.select()}
                autoFocus
              />
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {state.kind === "ready" && emails.length > 0 ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyAddresses()}>
                Copy addresses
              </Button>
              <Button asChild variant="apollo" size="sm">
                <a href={mailto} data-slot="matcha-email-open">
                  Open in mail app
                </a>
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Matcha contact — one researcher's templated email (with their partnership angle). Resolves the
 *  address on CLICK, like `ContactButton`, through the gated contacts route. */
function EmailPersonButton({ onEmail }: { onEmail: () => Promise<boolean> }) {
  const [state, setState] = useState<"idle" | "loading" | "none" | "error">("idle");
  if (state === "none") {
    return <span className="text-muted-foreground shrink-0 text-xs">No email on record</span>;
  }
  return (
    <button
      type="button"
      data-slot="matcha-email-person"
      disabled={state === "loading"}
      onClick={() => {
        setState("loading");
        onEmail()
          .then((ok) => setState(ok ? "idle" : "none"))
          .catch(() => setState("error"));
      }}
      className="border-border text-foreground/80 shrink-0 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:border-[var(--color-accent-slate)] disabled:opacity-50"
    >
      {state === "loading" ? "Resolving…" : state === "error" ? "Email (retry)" : "Email"}
    </button>
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
 * route below is built for. (Matcha contact later added "Email selected (BCC)" for DRAFTERS only,
 * through `/api/edit/matcha/contacts`: the #847 scope-export rule, i.e. refused above the 50-person
 * cap and filtered by the release code, consistent with docs/email-visibility-spec.md; a drafter's card
 * shows `EmailPersonButton` in place of this one.)
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
  // NOT "evidence below": the strip rides the COMPACT row too (the default density), where there is
  // nothing below it — the evidence only appears when the row is expanded to the detailed card. So
  // the label names WHERE the evidence is, not a direction that is only true in one density.
  evidence: "Evidence shown in the Detailed view",
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
              {/* Lead with the KIND + term ("Concept: …" / "Method: …") so the bold first line reads
                  as a labelled title, then the state on a dimmer line — the two were the same white
                  weight and ran together as one broken-looking title. */}
              <span className="block font-semibold">
                {concept.kind === "method" ? "Method" : "Concept"}: {concept.term}
              </span>
              <span className="block text-white/80">{COVERAGE_TITLE[state]}</span>
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
 * (`candidate.mostRecentYear`, under `MATCHA_RECENCY`), so the slot now renders there when the
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
  table = false,
  eligBadge,
  briefsOn = false,
  briefLine,
}: {
  candidate: MatchaCandidate;
  rank: number;
  concepts: MatchaConcept[];
  topScore: number;
  /** Matcha Phase 3 — the brief feature is live on this surface (phone layout rules apply). */
  briefsOn?: boolean;
  /** Matcha Phase 3 — the muted line under the name. Absent ⇒ no brief ⇒ nothing extra. */
  briefLine?: CompactBriefLine;
  /** D8 — flag the year below this; `null` ⇒ unflagged (see `staleBefore`). */
  staleYear: number | null;
  onExpand: () => void;
  /** Shortlist membership, and its toggle. Per-ask; owned by the panel (see `shortlist`). */
  selected: boolean;
  onSelect: () => void;
  /** Grant-path reskin — render as the artboard's TABLE row (`GRANT_TABLE_COLUMNS`) instead of
   *  the flex row. Same checkbox, same expand button, same slots; chrome only. False on
   *  `/edit/matcha`, whose row is untouched. */
  table?: boolean;
  /** Grant Matcha — inline eligibility pill. Absent ⇒ no pill (the `/edit/matcha` case). */
  eligBadge?: EligBadge;
}) {
  const coverage = conceptCoverage(candidate, concepts);
  // §5a — COUNT WHAT THE SCHOLAR RANKS UNDER, NOT WHAT WE CAN EVIDENCE.
  //
  // This read `state === "evidence"`, which is capped at MAX_EVIDENCE_CONCEPTS (3) by the
  // contract's strength cap. So on any ask with >3 concepts the column COULD NOT read above 3,
  // and it did not: measured on staging over 17 real asks, 39–83% of candidates (mean ~60%) had
  // more contributions than evidence. On a 7-concept ask EVERY visible row read "3/7" — a column
  // that distinguishes nobody. Worse, the strip beside it is drawn from `contributions` and so
  // showed the true count: the same row answered its own question two different ways.
  //
  // `!== "none"` is ranked + evidence — every concept the scholar actually ranks under.
  // `contributions` ship in full, so this is free and has no ceiling.
  //
  // NO RANK THRESHOLD, deliberately. The worry was that unbounded counts tail hits ("rank 97
  // reads as covered"). Measured over the same 17 asks: `contributions` never carry a rank above
  // 100 — the engine returns 100 per concept, so the pool bound IS the threshold. At that bound
  // only 0.8% of candidates peg at N/N and the mean reads ~1.8 of 7: a spread column, not a mush.
  // A hand-picked T would only push it toward 0 (T=25 ⇒ mean 0.52) — the same "display constant
  // chosen by taste" that made MAX_EVIDENCE_CONCEPTS a bug here. Do not add one without new data.
  const asksCovered = coverage.filter((c) => c.state !== "none").length;
  const tier = fitTier(candidate.fusedScore, topScore);
  const year = latestEvidenceYear(candidate);
  const stale = year != null && staleYear != null && year < staleYear;
  if (table) {
    // Grant-path reskin — the artboard's grid row. Structure is the SAME two siblings as the
    // flex row below (checkbox cell + expand button), for the same invalid-HTML reason; the
    // button carries the grid so its cells align under the header row, which mirrors the
    // 44px checkbox cell with a spacer. The evidence cell swaps the segmented strip for the
    // artboard's single fill bar (fraction = concepts hit); the per-segment detail stays one
    // click away on the expanded card. Stale years turn amber here (the artboard's tone) but
    // the boundary is still `staleBefore` — under "Any" nothing claims stale, exactly as the
    // flex row behaves.
    const hitFraction =
      coverage.length > 0 ? Math.round((asksCovered / coverage.length) * 100) : 0;
    return (
      <div
        data-slot="matcha-compact-row"
        className="border-apollo-border hover:bg-apollo-surface-2 flex w-full items-center border-t transition-colors"
      >
        <span className="flex w-[44px] shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={onSelect}
            aria-label={`Shortlist ${candidate.name}`}
            className="size-3.5 shrink-0 accent-[var(--color-accent-slate)]"
          />
        </span>
        <button
          type="button"
          onClick={onExpand}
          aria-label={`Expand ${candidate.name}`}
          className="grid min-w-0 flex-1 items-center gap-3 py-[11px] pr-[18px] text-left"
          style={{ gridTemplateColumns: GRANT_TABLE_COLUMNS }}
        >
          <span className="text-muted-foreground text-right text-xs tabular-nums">{rank}</span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13.5px] font-semibold">{candidate.name}</span>
              {eligBadge ? <EligBadgePill badge={eligBadge} /> : null}
            </span>
            {candidate.title ? (
              <span className="text-muted-foreground block truncate text-xs">
                {candidate.title}
              </span>
            ) : null}
          </span>
          <span>
            <span
              className={`inline-flex rounded-full px-[9px] py-[2px] text-[11.5px] font-semibold capitalize ${GRANT_TIER_CLASS[tier]}`}
            >
              {tier}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="bg-apollo-surface-2 h-[6px] min-w-0 flex-1 overflow-hidden rounded-[3px]">
              <span
                aria-hidden
                className="bg-apollo-slate block h-full rounded-[3px]"
                style={{ width: `${hitFraction}%` }}
              />
            </span>
            <HoverTooltip
              wide
              text={`Ranks under ${asksCovered} of the ${coverage.length} concepts this opportunity calls for — every concept the scholar ranks under, not only the ones we can show evidence for. Open the row to see which.`}
            >
              <span
                className="text-muted-foreground shrink-0 text-right text-xs tabular-nums"
                data-slot="matcha-asks-count"
              >
                {asksCovered}/{coverage.length}
              </span>
            </HoverTooltip>
          </span>
          {stale ? (
            <HoverTooltip
              wide
              triggerClassName="justify-self-end"
              text={`Latest evidence predates ${staleYear} — recency is down-weighting this match`}
            >
              <span
                data-slot="matcha-latest-year"
                className="text-apollo-amber text-right text-xs tabular-nums"
              >
                {year != null ? year : ""}
              </span>
            </HoverTooltip>
          ) : (
            <span
              data-slot="matcha-latest-year"
              className="text-right text-xs tabular-nums text-[#1a1a1a]"
            >
              {year != null ? year : ""}
            </span>
          )}
          <span className="text-muted-foreground justify-self-end text-xs" aria-hidden="true">
            ›
          </span>
        </button>
      </div>
    );
  }
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
      className="border-apollo-border hover:bg-apollo-surface-2 flex w-full items-center gap-2.5 border-t px-2 py-2 transition-colors"
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
        {briefLine ? (
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate">
              <span className="text-sm font-medium">{candidate.name}</span>
              {candidate.title ? (
                <span className="text-muted-foreground ml-1.5 text-xs">{candidate.title}</span>
              ) : null}
            </span>
            <CompactBriefLineView line={briefLine} />
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            <span className="text-sm font-medium">{candidate.name}</span>
            {candidate.title ? (
              <span className="text-muted-foreground ml-1.5 text-xs">{candidate.title}</span>
            ) : null}
          </span>
        )}
        {/* Grant Matcha — the eligibility pill sits INLINE beside the fit tier (mockup §9). */}
        {eligBadge ? <EligBadgePill badge={eligBadge} /> : null}
        {/* Native `title`, not HoverTooltip: this row is one big button, and a tooltip trigger
            nested inside it would be a second interactive element. */}
        {candidate.measures?.researcherType ? (
          <span
            title={researcherTypeReason(candidate.measures)}
            className="border-border text-muted-foreground hidden shrink-0 rounded-full border px-2 py-0.5 text-[11px] sm:inline-flex"
          >
            {RESEARCHER_TYPE_LABEL[candidate.measures.researcherType]}
          </span>
        ) : null}
        {/* Short tier word here (mockup's dense list), not the detailed card's "Strong fit". */}
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${TIER_CLASS[tier]}`}
        >
          {tier}
        </span>
        {briefsOn ? (
          // Phone (<480px, layout v3): the strip yields its width to the name + brief line.
          <span className="contents max-[480px]:hidden">
            <CoverageStrip coverage={coverage} inline />
          </span>
        ) : (
          <CoverageStrip coverage={coverage} inline />
        )}
        {/* The mockup heads this column "ASKS", but a compact row has no header to hang that on,
            so a bare "3/8" has to say what it counts itself — it is the strip's number, and the
            strip's own legend is one hover away on the bars beside it. */}
        <HoverTooltip
          wide
          text={`Ranks under ${asksCovered} of the ${coverage.length} concepts this opportunity calls for — every concept the scholar ranks under, not only the ones we can show evidence for. Open the row to see which.`}
        >
          <span
            className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums"
            data-slot="matcha-asks-count"
          >
            {asksCovered}/{coverage.length}
          </span>
        </HoverTooltip>
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

/** The provenance palette. `keyword` carries the house amber (position/warning) tint, solid not
 *  alpha, so the chip reads as colour rather than a border.
 *
 *  `tagged` is deliberately NEUTRAL, and it used to be `--apollo-green-tint`. In SPS green is a
 *  RELIABILITY claim — after #1934 the public people card reserves it for `credential`, a fact the
 *  label does not state, and it dropped its own `subject-tagged` pill outright. Provenance is not a
 *  reliability claim: it says HOW the hit matched, never that it matched the ask's SENSE. The live
 *  failure mode is on record at `cdk/lib/app-stack.ts` (the `SEARCH_MESH_RESOLVE_TOKEN_COVERAGE`
 *  note) and was confirmed on staging 2026-07-25 — "foreign policy" resolves to the MeSH `Policy`
 *  descriptor and returns 7 evidence blocks, 100% `tagged`, every one of them green and none of
 *  them about foreign policy. Same probe: 565/618 blocks (91.4%) are `tagged`, and 13 of the 19
 *  queries returning evidence are 100% `tagged` — so green was near-zero-bits where it fired, and
 *  confidently wrong where it mattered. The chip keeps its ✓ (it still says "structured"); it stops
 *  saying "verified". Amber is the one that earns its slot. Do NOT "harmonize" this back to green
 *  on the grounds that the tint exists — its absence here is the decision. */
const PROVENANCE_META: Record<
  EvidenceProvenance,
  { mark: string; label: string; title: string; className: string }
> = {
  tagged: {
    mark: "✓",
    label: "subject-tagged",
    title:
      "Matched via a MeSH subject tag or a curated method/clinical/topic signal — structured, but not proof of the ask's specific sense.",
    className: "border-border bg-muted text-muted-foreground",
  },
  keyword: {
    mark: "⚠",
    label: "keyword only",
    title:
      "Matched on free text only — the concept's bare keyword, which can hit a paper unrelated to what the ask is about.",
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
  eligBadge,
  brief,
}: {
  candidate: MatchaCandidate;
  rank: number;
  concepts: MatchaConcept[];
  topScore: number;
  /** Matcha Phase 3 (MATCHA_BRIEF) — the brief panel + note. Absent ⇒ master's card, untouched. */
  brief?: BriefRowProps;
  /** #1696 — the current ranking run. See `claimedPmids` below: this row can OUTLIVE a run. */
  runId: number;
  /** Put this card back to its compact row. OPTIONAL, and the option is the point: under Detailed
   *  density this card is not an expansion of anything, so there is no state to return to and the
   *  caller supplies nothing. Only the expanded-from-compact caller passes it (`renderResult`). */
  onCollapse?: () => void;
  /** Shortlist state. NOT optional, unlike `onCollapse` — the shortlist is a verb of the RESULT
   *  SET, not of a density, so the checkbox must render in BOTH densities. Compact is the DEFAULT
   *  density now (see `DENSITY_KEY`), so it is a DETAILED-only checkbox that would leave the feature
   *  invisible on first visit — the mirror of the old risk — and the selection bar, which is not
   *  density-gated, would then offer "Export shortlist (2)" over rows carrying no checkbox to audit or
   *  untick it with. The mockup draws the compact row only because that is the row it draws; it is
   *  silent on this card, which is not the same as forbidding it. */
  selected: boolean;
  onSelect: () => void;
  /** Grant Matcha — inline eligibility pill. Absent ⇒ no pill (the `/edit/matcha` case). */
  eligBadge?: EligBadge;
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
  // #1780 follow-up — the concepts this scholar RANKS under (drives the score) but for which the
  // spine shipped no evidence: keyword-level, or capped below the evidence blocks above. Named
  // here because nothing else does: the strip shows an unlabeled `ranked` segment, the blocks
  // caption only the evidenced concepts, and the gaps line only the `none` ones. Live-derived, so
  // muting a concept drops it. This is what makes reweighting legible — an officer who zeroes the
  // concepts a #1 "ranks under, no evidence" would otherwise see nothing to zero (Safford, staging).
  const rankedNoEvidence = coverage.filter((c) => c.state === "ranked");
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
      className={`border-apollo-border bg-apollo-surface mb-4 flex gap-3 rounded-xl border p-5 shadow-[var(--apollo-shadow-card)] ${
        brief ? "max-[480px]:gap-2 max-[480px]:p-3.5" : ""
      }`}
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
      {brief ? (
        // Phone (<480px, layout v3): the avatar yields its width to the brief.
        <div className="shrink-0 max-[480px]:hidden">
          <HeadshotAvatar
            size="md"
            cwid={candidate.cwid}
            preferredName={name}
            identityImageEndpoint={candidate.identityImageEndpoint ?? ""}
          />
        </div>
      ) : (
        <HeadshotAvatar
          size="md"
          cwid={candidate.cwid}
          preferredName={name}
          identityImageEndpoint={candidate.identityImageEndpoint ?? ""}
        />
      )}
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
          {/* Grant Matcha — the eligibility pill sits INLINE beside the fit tier (mockup §9). */}
          {eligBadge ? <EligBadgePill badge={eligBadge} /> : null}
          <ResearcherTypePill measures={candidate.measures} />
          {brief?.onEmail ? (
            <EmailPersonButton onEmail={brief.onEmail} />
          ) : (
            <ContactButton cwid={candidate.cwid} />
          )}
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
        {brief ? <BriefPanel name={name} brief={brief} /> : null}
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
                  //
                  // ponytail: MATCHA_GLOSS_INWORDS marks the sponsor's phrasing on the artifact
                  // title, but nothing LABELS the mark as theirs (the redesign spec's 4th
                  // touchpoint). Deferred, not forgotten: `titleHtml` is one opaque string whose
                  // marks come from three merged `should` clauses (literal query, concept label,
                  // gloss), so the client cannot attribute a mark today, and a client-side compare
                  // against `glossTerms` would be wrong on exactly the stemmed cases the gloss
                  // subtraction exists to handle ("decline" vs a marked "Declining"). An honest
                  // label needs per-mark attribution — a separate highlight field on the contract.
                  // Re-decide at the staging flip, once the §1 gate reports a non-zero population.
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
        {/* #1780 follow-up — name the "ranks under, no evidence" concepts. They once rendered one
            row PER CONCEPT and were deleted: those read as a contradiction of the evidence count,
            and the strip's lighter `ranked` segment carries the FILL fact. But a strip segment is
            UNLABELED — the concept actually DRIVING a rank is otherwise un-nameable anywhere on the
            card, so an officer reweighting a #1 whose reasons are all keyword-level (Safford, staging
            2026-07-17) has nothing to grab. Back as a SINGLE muted line, not per-concept rows, in the
            strip's own `ranked` colour: it names the drivers without masquerading as evidence, and
            fulfils the `asksCovered` tooltip's promise ("open the row to see which"). */}
        {rankedNoEvidence.length > 0 ? (
          <div
            data-slot="matcha-ranked-no-evidence"
            className="border-border mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t pt-2.5"
          >
            <HoverTooltip
              wide
              text="Drives this scholar's rank, but the match is keyword-level or capped below the evidence shown above — so there is no publication to display here. Reweighting these still moves the ranking."
            >
              <span className="rounded bg-[var(--color-accent-slate)]/30 px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.02em] text-foreground">
                Ranks here
              </span>
            </HoverTooltip>
            <span className="text-muted-foreground text-xs">
              {rankedNoEvidence.map((r) => r.concept.term).join(" · ")}
            </span>
          </div>
        ) : null}
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
            <summary className={`flex w-fit items-center gap-1 text-muted-foreground cursor-pointer text-xs select-none ${SUMMARY_NO_MARKER}`}>
              <Caret />
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
        {brief ? <BriefNote name={name} brief={brief} /> : null}
      </div>
    </div>
  );
}

// ── Matcha Phase 3: per-PI briefs (MATCHA_BRIEF) ─────────────────────────────
//
// Layout v3.1 (`Matcha Brief Layout v3.dc.html`): the brief lives INSIDE the existing card. The
// model writes only Why this PI, Partnership angle + Discussion topics; Funding / Translation /
// Appointments / Methods and tools render
// from Scholars records and are never editable. Every control below is absent while the flag is
// off — the rows are handed no `brief` prop, so master's markup renders untouched.

/** Where one PI's brief stands, derived by the panel from its brief map + in-flight sets. */
type BriefState =
  | { kind: "none" }
  | { kind: "drafting" }
  | { kind: "failed" }
  | { kind: "ready"; brief: BriefWire };

type BriefPatch = {
  why?: string | null;
  angle?: string | null;
  topics?: string[] | null;
  note?: string | null;
};

/** What a row needs to render its brief. Absent ⇒ the flag is off (or there is no saved run). */
type BriefRowProps = {
  state: BriefState;
  records: BriefRecords | undefined;
  /** False for an observer (GET `canEdit:false`): read-only, no draft/edit/revert/retry/note. */
  canEdit: boolean;
  onDraft: () => void;
  onPatch: (patch: BriefPatch) => Promise<boolean>;
  /** Matcha contact — the per-person templated "Email". Present only for a drafter (the contacts
   *  route's gate); resolves false when the person has no address on record. */
  onEmail?: () => Promise<boolean>;
};

/** What `/api/edit/matcha/contacts` returns. Held only in the open dialog's state. */
type ContactsResult = {
  contacts: { cwid: string; name: string; email: string }[];
  missing: { cwid: string; name: string }[];
  officer: { name: string; email: string | null };
};

type EmailDialogState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | (ContactsResult & {
      kind: "ready";
      subject: string;
      body: string;
      /** After "Copy addresses": "ok", or "manual" when the clipboard refused (shown to select). */
      copied: "ok" | "manual" | null;
    });

const CONTACT_ERRORS: Record<string, string> = {
  over_contact_cap: "Email addresses are available for 50 or fewer people at a time.",
  not_developer_contact: "Only Matcha drafters can email researchers.",
  impersonation_readonly: "Emailing is not available while viewing as someone else.",
};

/** The policy cap the contacts route enforces (`SCHOLAR_EXPORT_CAP`); this copy disables the
 *  button rather than letting the server refuse. */
const CONTACT_MAX = 50;

/** The compact row's single muted line. Absent ⇒ no brief ⇒ nothing extra on the row. */
type CompactBriefLine = { kind: "text"; text: string } | { kind: "drafting" } | { kind: "failed" };

/** Draft requests in flight at once (one POST per PI, rows fill in as each lands). */
const BRIEF_CONCURRENCY = 4;
const BRIEF_TOP_N = 10;
/** The server's per-request cap, which the shortlisted draft also honours. */
const BRIEF_SHORTLIST_MAX = 20;
/** Matcha Phase 4 — the printable report's selection cap. The page enforces it too
 *  (`MATCHA_REPORT_CAP`, the scholar-export policy cap); this copy keeps the URL honest. */
const REPORT_MAX = 50;

/** The report page for `cwids` on this search. Opened in a new tab; printed by the browser. */
function reportHref(submissionId: string, cwids: readonly string[]): string {
  return (
    `/edit/matcha/report?submissionId=${encodeURIComponent(submissionId)}` +
    `&cwids=${cwids.map(encodeURIComponent).join(",")}`
  );
}

/** The missing-brief prompt's state: who the report covers, who lacks a brief, and how far the
 *  "Draft N briefs, then open report" run has got. */
type ReportPrompt = {
  cwids: string[];
  missing: string[];
  /** "shortlisted" when the ticked rows are the selection, else "selected". */
  noun: string;
  phase: "ask" | "drafting" | "done";
  /** The tab could not be opened after drafting (popup blocker): offer a link instead. */
  blocked: boolean;
};

/** The mockup's `.cap` eyebrow: 10.5px / 600 / .08em uppercase, muted. */
const BRIEF_CAP =
  "text-muted-foreground text-[10.5px] font-semibold tracking-[0.08em] whitespace-nowrap uppercase";

function formatBriefDate(iso: string, withYear = false): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

function briefMeta(brief: BriefWire): string {
  const whyEdited = brief.edited?.why !== undefined;
  const edits =
    (whyEdited ? 1 : 0) +
    (brief.edited?.angle !== undefined ? 1 : 0) +
    (brief.edited?.topics !== undefined ? 1 : 0);
  const removed = brief.generated.removedCount;
  // The removed count describes the GENERATED why; once the officer has rewritten it the count
  // no longer describes what is on screen (mockup: hidden when Why is edited).
  return (
    `Drafted ${formatBriefDate(brief.draftedAt)} · fact-checked` +
    (removed > 0 && !whyEdited
      ? ` (${removed} unsupported statement${removed === 1 ? "" : "s"} removed)`
      : "") +
    (edits > 0 ? ` · ${edits} edited` : "")
  );
}

function CompactBriefLineView({ line }: { line: CompactBriefLine }) {
  if (line.kind === "drafting") {
    return <Skeleton data-slot="matcha-brief-line" className="mt-1 h-2.5 w-3/5" />;
  }
  if (line.kind === "failed") {
    return (
      <span data-slot="matcha-brief-line" className="text-destructive text-[12.5px]">
        Brief failed · open to retry
      </span>
    );
  }
  return (
    <span
      data-slot="matcha-brief-line"
      className="text-muted-foreground block truncate text-[12.5px]"
    >
      {line.text}
    </span>
  );
}

/** One generated, editable section's header: label, Generated / Edited by you, Revert, Edit. */
function BriefSectionHeader({
  label,
  edited,
  editing,
  canEdit,
  name,
  onEdit,
  onRevert,
}: {
  label: string;
  edited: boolean;
  editing: boolean;
  canEdit: boolean;
  name: string;
  onEdit: () => void;
  onRevert: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[13px] font-semibold">{label}</span>
      <span
        className={`text-[11.5px] ${edited ? "text-apollo-green-foreground" : "text-muted-foreground"}`}
      >
        {edited ? "Edited by you" : "Generated"}
      </span>
      <span className="flex-1" />
      {canEdit && edited && !editing ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Revert ${label} for ${name}`}
          onClick={onRevert}
        >
          Revert
        </Button>
      ) : null}
      {canEdit && !editing ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Edit ${label} for ${name}`}
          onClick={onEdit}
        >
          Edit
        </Button>
      ) : null}
    </div>
  );
}

function BriefEditor({
  value,
  rows,
  label,
  hint,
  placeholder,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  rows: number;
  label: string;
  hint?: string;
  placeholder?: string;
  saving: boolean;
  error: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={value}
        rows={rows}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="bg-apollo-surface min-h-0 text-[14px]"
      />
      {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
      {error ? (
        <div className="text-destructive text-xs">Couldn&apos;t save. Please try again.</div>
      ) : null}
      <div className="flex gap-1.5">
        <Button type="button" variant="apollo" size="xs" disabled={saving} onClick={onSave}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="xs" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BriefRecordsBlock({ records }: { records: BriefRecords | undefined }) {
  const funding = records?.funding ?? [];
  const translation = records?.translation ?? [];
  const secondary = [...new Set((records?.secondaryAppointments ?? []).map((a) => a.organization))];
  const centers = records?.centers ?? [];
  const methods = records?.methods ?? [];
  const trialCount = records?.trialCount ?? 0;
  const appointments = [
    ...(secondary.length > 0 ? [`Secondary: ${secondary.join("; ")}`] : []),
    ...(centers.length > 0 ? [`Centers: ${centers.join("; ")}`] : []),
  ].join(" · ");
  const none = (
    <span className="text-muted-foreground italic">Not evident from Scholars records.</span>
  );
  const linkClass = "text-apollo-slate whitespace-nowrap underline-offset-4 hover:underline";
  const capClass = `${BRIEF_CAP} pt-0.5 max-[480px]:mt-1.5`;
  return (
    <div
      data-slot="matcha-brief-records"
      className="border-apollo-border-strong flex flex-col gap-2 border-t pt-2.5"
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
        <Lock className="size-2.5" aria-hidden />
        From Scholars records, not generated
      </div>
      <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] max-[480px]:grid-cols-1 max-[480px]:gap-y-0.5">
        <dt className={capClass}>Funding</dt>
        <dd className="flex flex-col gap-0.5">
          {funding.length > 0
            ? funding.map((f, i) => (
                <div key={`${f.applId ?? f.title}:${i}`}>
                  {[f.funder, f.mechanism].filter(Boolean).join(" ")} · {f.title} ·{" "}
                  <span className="whitespace-nowrap">through {f.endYear}</span>
                  {f.applId != null ? (
                    <>
                      {" · "}
                      <a
                        href={reporterUrl(f.applId)}
                        target="_blank"
                        rel="noreferrer"
                        className={linkClass}
                      >
                        RePORTER ↗
                      </a>
                    </>
                  ) : null}
                </div>
              ))
            : none}
        </dd>
        <dt className={capClass}>Translation</dt>
        <dd className="flex flex-col gap-0.5">
          {translation.length > 0
            ? translation.map((t, i) => (
                <div key={`${t.url}:${i}`}>
                  {t.title}
                  {t.patentStatus ? ` · ${t.patentStatus}` : ""} ·{" "}
                  <a href={t.url} target="_blank" rel="noreferrer" className={linkClass}>
                    CTL ↗
                  </a>
                </div>
              ))
            : none}
        </dd>
        <dt className={capClass}>Appointments</dt>
        <dd>{appointments ? <span>{appointments}</span> : none}</dd>
        {methods.length > 0 || trialCount > 0 ? (
          // The full list (up to the loader's cap) is tucked behind one collapsed line.
          <dd className="col-span-full" data-slot="matcha-brief-methods">
            {methods.length > 0 ? (
              <details>
                <summary className="text-apollo-slate cursor-pointer">
                  {methodsSummary(methods.length, trialCount)}
                </summary>
                <div className="mt-1 flex flex-col gap-0.5 pl-4">
                  {methods.map((m) => (
                    <div key={m.name}>{methodLabel(m)}</div>
                  ))}
                </div>
              </details>
            ) : (
              <span>{methodsSummary(0, trialCount)}</span>
            )}
          </dd>
        ) : null}
      </dl>
    </div>
  );
}

/** The tinted brief panel inside the Detailed card (after the department line, above the strip). */
function BriefPanel({ name, brief }: { name: string; brief: BriefRowProps }) {
  const { state, records, canEdit, onDraft, onPatch } = brief;
  const [editing, setEditing] = useState<null | "why" | "angle" | "topics">(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  async function save(patch: BriefPatch) {
    setSaving(true);
    setSaveError(false);
    const ok = await onPatch(patch);
    setSaving(false);
    if (ok) setEditing(null);
    else setSaveError(true);
  }

  let body: React.ReactNode;
  if (state.kind === "drafting") {
    body = (
      <div className="flex flex-col gap-2">
        <span className={BRIEF_CAP}>Drafting brief…</span>
        <Skeleton className="h-2.5 w-[92%]" />
        <Skeleton className="h-2.5 w-[70%]" />
      </div>
    );
  } else if (state.kind === "failed") {
    body = (
      <div className="text-destructive flex flex-wrap items-center gap-2 text-[13px]">
        <span>Brief couldn&apos;t be drafted.</span>
        {canEdit ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={`Retry brief for ${name}`}
            onClick={onDraft}
          >
            Retry
          </Button>
        ) : null}
      </div>
    );
  } else if (state.kind === "none") {
    body = (
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[13px]">
        <span>No brief yet.</span>
        {canEdit ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={`Draft brief for ${name}`}
            onClick={onDraft}
          >
            Draft brief
          </Button>
        ) : null}
      </div>
    );
  } else {
    const b = state.brief;
    const why = briefWhy(b);
    const angle = briefAngle(b);
    const topics = briefTopics(b);
    const whyEdited = b.edited?.why !== undefined;
    const angleEdited = b.edited?.angle !== undefined;
    const topicsEdited = b.edited?.topics !== undefined;
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className={`${BRIEF_CAP} text-foreground`}>Brief</span>
          <span className="text-muted-foreground text-xs" data-slot="matcha-brief-meta">
            {briefMeta(b)}
          </span>
          <span className="flex-1" />
          {canEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Redraft brief for ${name}`}
              onClick={onDraft}
            >
              Redraft
            </Button>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <BriefSectionHeader
            label="Why this PI"
            edited={whyEdited}
            editing={editing === "why"}
            canEdit={canEdit}
            name={name}
            onEdit={() => {
              setDraft(why);
              setSaveError(false);
              setEditing("why");
            }}
            onRevert={() => void save({ why: null })}
          />
          {editing === "why" ? (
            <BriefEditor
              value={draft}
              rows={4}
              label={`Why this PI for ${name}`}
              saving={saving}
              error={saveError}
              onChange={setDraft}
              onSave={() => void save({ why: draft.trim() ? draft : null })}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <p className="text-[14px] text-pretty">{why}</p>
          )}
        </div>

        <div className="flex flex-col gap-1" data-slot="matcha-brief-angle">
          <BriefSectionHeader
            label="Partnership angle"
            edited={angleEdited}
            editing={editing === "angle"}
            canEdit={canEdit}
            name={name}
            onEdit={() => {
              setDraft(angle);
              setSaveError(false);
              setEditing("angle");
            }}
            onRevert={() => void save({ angle: null })}
          />
          {editing === "angle" ? (
            <BriefEditor
              value={draft}
              rows={3}
              label={`Partnership angle for ${name}`}
              saving={saving}
              error={saveError}
              onChange={setDraft}
              onSave={() => void save({ angle: draft.trim() ? draft : null })}
              onCancel={() => setEditing(null)}
            />
          ) : angle ? (
            <p className="text-[14px] text-pretty">{angle}</p>
          ) : b.generated.angle === undefined ? (
            // A brief drafted before angles existed: the header's Redraft adds one.
            <p className="text-muted-foreground text-[13px] italic">
              Drafted before partnership angles.{canEdit ? " Redraft to add one." : ""}
            </p>
          ) : (
            // The fact-check removed every statement in it.
            <p className="text-muted-foreground text-[13px] italic">
              No grounded angle in this draft.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <BriefSectionHeader
            label="Discussion topics"
            edited={topicsEdited}
            editing={editing === "topics"}
            canEdit={canEdit}
            name={name}
            onEdit={() => {
              setDraft(topics.map((t) => t.text).join("\n"));
              setSaveError(false);
              setEditing("topics");
            }}
            onRevert={() => void save({ topics: null })}
          />
          {editing === "topics" ? (
            <BriefEditor
              value={draft}
              rows={3}
              label={`Discussion topics for ${name}`}
              hint="One topic per line. A line you change loses its source."
              saving={saving}
              error={saveError}
              onChange={setDraft}
              onSave={() =>
                void save({
                  topics: draft
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean),
                })
              }
              onCancel={() => setEditing(null)}
            />
          ) : (
            <ul className="flex list-disc flex-col gap-[3px] pl-[18px] text-[14px]">
              {topics.map((t, i) => (
                <li key={`${i}:${t.text}`}>
                  {t.text}{" "}
                  <span className="text-muted-foreground text-xs">
                    ·{" "}
                    {t.sources.length > 0
                      ? t.sources.map((s, j) => {
                          const url = briefSourceUrl(s);
                          const label = briefSourceLabel(s);
                          return (
                            <span key={j}>
                              {j > 0 ? "; " : ""}
                              {url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline-offset-4 hover:underline"
                                >
                                  {label}
                                </a>
                              ) : (
                                label
                              )}
                            </span>
                          );
                        })
                      : UNSOURCED_LABEL}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <BriefRecordsBlock records={records} />
      </div>
    );
  }

  return (
    <section
      aria-label={`Brief for ${name}`}
      data-slot="matcha-brief"
      className="border-apollo-border bg-apollo-surface-2 my-2.5 flex flex-col gap-3 rounded-lg border px-3.5 py-3 text-[14px]"
    >
      {body}
    </section>
  );
}

/** The shared note at the card's foot. Collapsed until used; NEVER exported (see
 *  `briefCsvFields`). Shared by everyone who opens the paste, which is what the label says. */
function BriefNote({ name, brief }: { name: string; brief: BriefRowProps }) {
  const { state, canEdit, onPatch } = brief;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  if (state.kind !== "ready") return null;
  const note = state.brief.note;
  if (!note && !canEdit) return null;

  async function save(value: string | null) {
    setSaving(true);
    setSaveError(false);
    const ok = await onPatch({ note: value });
    setSaving(false);
    if (ok) setEditing(false);
    else setSaveError(true);
  }

  const lock = <Lock className="size-3" aria-hidden />;
  return (
    <div data-slot="matcha-brief-note" className="border-apollo-border mt-3 border-t pt-2.5">
      {editing || note ? (
        <div className="bg-apollo-lock-bg flex flex-col gap-1.5 rounded-lg px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            {lock}
            <span className="font-semibold">Note</span>
            <span className="text-muted-foreground text-xs">
              Never exported · visible to anyone who opens this search
            </span>
            <span className="flex-1" />
            {canEdit && !editing ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Edit note for ${name}`}
                onClick={() => {
                  setDraft(note ?? "");
                  setSaveError(false);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            ) : null}
          </div>
          {editing ? (
            <BriefEditor
              value={draft}
              rows={2}
              label={`Note for ${name}`}
              placeholder="Disclosures, encumbrances, prior conversations…"
              saving={saving}
              error={saveError}
              onChange={setDraft}
              onSave={() => void save(draft.trim() ? draft : null)}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <p className="text-[13px] whitespace-pre-wrap">{note}</p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft("");
            setSaveError(false);
            setEditing(true);
          }}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[12.5px]"
        >
          <Lock className="size-[11px]" aria-hidden />
          Add a note (never exported)
        </button>
      )}
    </div>
  );
}
