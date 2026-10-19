/**
 * #3071 — grant attribution scorer for RePORTER awards. Pure: no DB, no fetch.
 *
 * `etl/reporter-grants` materializes every award on a scholar's NIH profile(s).
 * When a profile was linked by name only, or through a WCM grant and a name
 * check, a same-named investigator's awards can ride along. #3088/#3092 hid any
 * such award nothing ties to the scholar. This module replaces that yes/no rule
 * with a score over several cues, and three outcomes:
 *
 *   - show:  enough ties the award to the scholar.
 *   - hide:  nothing does, or something rules the scholar out.
 *   - queue: the evidence is weak or points both ways. Hidden by default (the
 *            safe side) and put in front of a curator.
 *
 * THE SCORE. `PRIOR` plus the weight of every cue that fired. An award with no
 * cue at all scores `PRIOR` and lands in hide, so the #3088/#3092 baseline holds:
 * no tie means hidden. Positive weights are evidence the award is the scholar's,
 * negative weights evidence it is someone else's.
 *
 * Three rules sit on top of the sum:
 *   1. DECISIVE. Cue 1 (the award is in InfoEd under another WCM investigator
 *      whose name our NIH profile also matches) hides outright, whatever else
 *      fired, except a linked confirmed publication: that pair is a real
 *      conflict and goes to the queue.
 *   2. CONFLICT. A strong positive and a strong negative together go to the
 *      queue, whatever the sum says. A curator, not arithmetic, settles a
 *      linked paper against an impossible timeline.
 *   3. TIE-BREAK. Topic similarity (cue 7) only counts while the rest of the
 *      score sits inside the queue band. It can tip a borderline award but can
 *      never lift a hide, or sink a show, on its own.
 *
 * DEGRADED INPUT. Every cue input is nullable, and null means "not known", never
 * "no". A null never fires a cue in either direction. The caller is responsible
 * for the scholar-level skips (no confirmed PMIDs, a failed RePORTER call) and
 * for refusing to revoke when a negative source is unavailable.
 */
import { doctoralDegree } from "@/lib/edit/honor-queue";
import type { CorroborationPolicy } from "./transform";

export type AttributionBand = "show" | "hide" | "queue";

export type CueId =
  | "pub_linked"
  | "wcm_org"
  | "infoed_other_wcm_pi_named"
  | "infoed_other_wcm_pi"
  | "rejected_pmids"
  | "timeline_impossible"
  | "timeline_unlikely"
  | "middle_initial_conflict"
  | "prior_institution"
  | "copi_coauthor"
  | "topic_match"
  | "topic_mismatch";

export interface CueHit {
  id: CueId;
  /** Signed weight that went into the score (0 for the decisive cue). */
  weight: number;
  /** One short line for the curator. Built from the award and the scholar's own
   *  record; never logged by the ETL. */
  reason: string;
}

export interface AttributionScore {
  band: AttributionBand;
  score: number;
  /** Every cue that fired, strongest first. */
  reasons: CueHit[];
  /** The rule that settled the band, when it was not the plain sum. */
  rule: "decisive" | "conflict" | "sum";
}

// ---------------------------------------------------------------------------
// Constants. Calibrated on the 2026-10-18 staging run (see the PR): an award
// with no cue keeps the #3088/#3092 hide, one strong tie shows it, one moderate
// tie queues it, and two moderate ties show it.
// ---------------------------------------------------------------------------

/** Where an award with no evidence at all starts: inside the hide band. */
export const PRIOR = -2;
/** score >= SHOW_AT ⇒ show. */
export const SHOW_AT = 2;
/** score <= HIDE_AT ⇒ hide. Between the two ⇒ queue. */
export const HIDE_AT = -2;
/** |weight| at or above this counts as STRONG for the conflict rule. */
export const STRONG = 4;

export const WEIGHTS = {
  /** A confirmed publication of the scholar cites the award (RePORTER linkage
   *  or ReCiter's grant citation). The #3088 baseline's strongest tie. */
  pub_linked: 5,
  /** WCM in the award's org history. Name-only profiles only: for a grant-join
   *  profile every candidate award is WCM's, so it says nothing (#3092). */
  wcm_org: 5,
  /** Another WCM investigator holds the award in InfoEd as PI or Co-PI, but our
   *  NIH profile's name does not match theirs (a multi-PI award, or InfoEd
   *  listing only the contact PI). Moderate. */
  infoed_other_wcm_pi: -2,
  /** RePORTER links the award to papers the scholar rejected in ReCiter. */
  rejected_pmids: -4,
  /** The award type is impossible at that point in the scholar's training,
   *  by five years or more. */
  timeline_impossible: -5,
  /** Same, by two to four years. Degree years in ASMS are sometimes off. */
  timeline_unlikely: -3,
  /** The RePORTER PI's middle initial matches none of the scholar's. Per
   *  profile, not per award, and middle names are often missing: weak. */
  middle_initial_conflict: -1,
  /** The award's institution and years match a degree the scholar earned
   *  there. */
  prior_institution: 2,
  /** A co-PI on the award co-authored at least COAUTHOR_MIN_PAPERS of the
   *  scholar's confirmed papers. */
  copi_coauthor: 2,
  /** Tie-break only, see rule 3. */
  topic_match: 1,
  topic_mismatch: -1,
} as const satisfies Record<Exclude<CueId, "infoed_other_wcm_pi_named">, number>;

/** Shared papers with a co-PI before cue 6 fires. One shared paper is too easy
 *  to hit through a common surname and initial. */
export const COAUTHOR_MIN_PAPERS = 2;
/** Years of slack on each side of a degree year before cue 3 fires. */
export const TIMELINE_SLACK_YEARS = 1;
/** A gap this large or larger is "impossible"; smaller (beyond the slack) is
 *  "unlikely". */
export const TIMELINE_STRONG_YEARS = 5;
/** Share of the award's MeSH descriptors in >= 2 of the scholar's papers at or
 *  above which cue 7 counts as a match. */
export const TOPIC_MATCH_AT = 0.4;
/** Cue 7 counts a mismatch only with this many descriptors on the award and
 *  this many MeSH-tagged papers on the scholar, and none shared. */
export const TOPIC_MIN_DESCRIPTORS = 5;
export const TOPIC_MIN_PAPERS = 10;
/** Cue 2 ignores awards linked to more papers than this unless at least
 *  REJECTED_MIN_OVERLAP_LARGE rejected papers overlap: a center or training
 *  core links thousands, and one stray overlap proves nothing. */
export const REJECTED_SMALL_SET = 50;
export const REJECTED_MIN_OVERLAP_LARGE = 2;

// ---------------------------------------------------------------------------
// Evidence: everything the caller gathered for one (scholar, award) pair.
// ---------------------------------------------------------------------------

export interface AttributionEvidence {
  /** The scholar's corroboration policy (`corroborationPolicy`). "none" ⇒ the
   *  scorer is not consulted for hides, see `scoreAttribution`. */
  policy: CorroborationPolicy;
  /** WCM anywhere in the award's org history. */
  wcmOrgHistory: boolean;
  /** A confirmed publication of the scholar is linked to the award. */
  publicationLinked: boolean;
  /** NIH activity code (R01, F31, ...), or null when unparseable. */
  activityCode: string | null;
  /** Calendar year the award started. */
  startYear: number | null;
  /** Cue 1. null ⇒ no other WCM investigator holds this core in InfoEd. */
  infoedOther: { piLevel: boolean; profileNameMatchesOther: boolean } | null;
  /** Cue 2. null ⇒ the scholar's ReCiter rejections are unavailable. */
  rejected: { overlap: number; linkedTotal: number } | null;
  /** Cue 3. The scholar's earliest and latest doctoral degree years, or null
   *  when none is on file. */
  doctoralYears: { earliest: number; latest: number } | null;
  /** Cue 4. null ⇒ either side has no middle initial. */
  middleInitialConflict: boolean | null;
  /** Cue 5. The scholar's degree institution the award's org matched, or null. */
  priorInstitution: string | null;
  /** Cue 6. Most papers the scholar shares with any one co-PI on the award;
   *  null ⇒ single-PI award or no co-author data. */
  coPiSharedPapers: number | null;
  /** Cue 7. null ⇒ the award has no MeSH descriptors yet, or the scholar has
   *  no MeSH-tagged papers. */
  topic: { share: number; descriptors: number; papers: number } | null;
}

// ---------------------------------------------------------------------------
// Cue 3 helpers.
// ---------------------------------------------------------------------------

/** Awards held BEFORE the doctorate: predoctoral fellowships (F30, F31), the
 *  F99 phase of the F99/K00 transition award, and R36 dissertation awards. */
const PREDOC_CODES = new Set(["F30", "F31", "F99", "R36"]);

export function isPredoctoralCode(code: string | null): boolean {
  return code !== null && PREDOC_CODES.has(code.toUpperCase());
}

/** UK-style primary medical degrees, which the doctoral matcher does not know
 *  (MBBS, MB BS, MB ChB, MB BCh, BMBS). Counted as the terminal degree so a
 *  scholar whose only degree is one does not fail OPEN on every award. */
const PRIMARY_MEDICAL_RE = /\b(MBBS|MBBCH|MBCHB|MBBCHIR|BMBS|MBBCHBAO)\b/i;

export function isDoctoralForTimeline(degree: string): boolean {
  if (doctoralDegree(degree) !== null) return true;
  const squashed = degree.replace(/[.,\s]/g, "");
  return PRIMARY_MEDICAL_RE.test(squashed);
}

/** Earliest and latest doctoral year, or null when none is on file. Pure. */
export function doctoralYearRange(
  educations: ReadonlyArray<{ degree: string; year: number | null }>,
): { earliest: number; latest: number } | null {
  const years = educations
    .filter((e) => e.year != null && isDoctoralForTimeline(e.degree))
    .map((e) => e.year as number);
  if (years.length === 0) return null;
  return { earliest: Math.min(...years), latest: Math.max(...years) };
}

/** Years by which the award's start is out of place for its type, beyond the
 *  slack: a predoctoral award starting after the LATEST doctorate, or any
 *  other award starting before the EARLIEST one. 0 when plausible or unknown. */
export function timelineGapYears(
  activityCode: string | null,
  startYear: number | null,
  doctoral: { earliest: number; latest: number } | null,
): number {
  if (activityCode === null || startYear === null || doctoral === null) return 0;
  if (isPredoctoralCode(activityCode)) {
    return Math.max(0, startYear - doctoral.latest - TIMELINE_SLACK_YEARS);
  }
  return Math.max(0, doctoral.earliest - startYear - TIMELINE_SLACK_YEARS);
}

// ---------------------------------------------------------------------------
// Cue 4 helpers.
// ---------------------------------------------------------------------------

/** Lower-case particles that belong to a surname, not a middle name. */
const SURNAME_PARTICLES = new Set([
  "de", "del", "della", "der", "di", "da", "dos", "das", "du", "la", "le", "van", "von", "st", "y",
]);

/** The name tokens before the postnominals ("Jane Q. Public, MD" ⇒ jane q public). */
function nameTokens(name: string): string[] {
  return (name.split(/,\s*/)[0] ?? "")
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z-]/g, "").toLowerCase())
    .filter((t) => t.length > 0);
}

/** A scholar's first and middle initials, from every name form on file. */
export function scholarInitials(names: ReadonlyArray<string | null | undefined>): {
  first: Set<string>;
  middle: Set<string>;
} {
  const first = new Set<string>();
  const middle = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    const toks = nameTokens(n);
    if (toks.length === 0) continue;
    first.add(toks[0]![0]!);
    for (const t of toks.slice(1, -1)) {
      if (SURNAME_PARTICLES.has(t)) continue;
      middle.add(t[0]!);
    }
  }
  return { first, middle };
}

/**
 * True when the RePORTER PI's middle initial matches neither a middle nor a
 * first initial of the scholar (some people go by their middle name). null when
 * either side has no middle initial to compare. Pure.
 */
export function middleInitialConflict(
  reporterMiddleNames: ReadonlyArray<string | null | undefined>,
  scholar: { first: Set<string>; middle: Set<string> },
): boolean | null {
  const theirs = new Set(
    reporterMiddleNames
      .map((m) => (m ?? "").replace(/[^A-Za-z]/g, "").toLowerCase()[0])
      .filter((c): c is string => !!c),
  );
  if (theirs.size === 0 || scholar.middle.size === 0) return null;
  for (const c of theirs) if (scholar.middle.has(c) || scholar.first.has(c)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Cue 5 helpers.
// ---------------------------------------------------------------------------

/** Words that say what KIND of institution it is, not which one. */
const ORG_STOPWORDS = new Set([
  "university", "univ", "of", "the", "at", "college", "coll", "school", "sch", "medical", "med",
  "medicine", "center", "ctr", "cntr", "hospital", "hosp", "institute", "inst", "and", "for",
  "health", "sciences", "science", "sci", "inc", "llc", "research", "res", "foundation", "fdn",
  "campus", "system", "in", "graduate", "faculty", "dept", "department", "s", "fac", "hlth",
  "scis", "ctrs", "grad", "dental", "nursing", "public", "affairs",
]);

export function orgTokens(org: string): Set<string> {
  return new Set(
    org
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0 && !ORG_STOPWORDS.has(w) && !SURNAME_PARTICLES.has(w)),
  );
}

/**
 * Same institution? Equal distinctive-token sets, or at least two shared
 * distinctive tokens covering half the union. One shared token is not enough:
 * "University of California" must not match every UC campus. Pure.
 */
export function sameInstitution(a: string, b: string): boolean {
  const x = orgTokens(a);
  const y = orgTokens(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  if (shared === x.size && shared === y.size) return true;
  return shared >= 2 && shared / (x.size + y.size - shared) >= 0.5;
}

/** A degree year's window of plausible affiliation: training before it, and a
 *  postdoc or first faculty post after it. */
export const PRIOR_INSTITUTION_YEARS_BEFORE = 8;
export const PRIOR_INSTITUTION_YEARS_AFTER = 10;

/**
 * The scholar's degree institution the award was held at, in a plausible year,
 * or null. WCM on either side never counts: that is cue `wcm_org`'s job, and a
 * WCM degree says nothing about which WCM person holds a WCM award. Pure.
 */
export function priorInstitutionMatch(
  awardOrgs: ReadonlyArray<{ orgName: string | null; fiscalYear: number | null }>,
  educations: ReadonlyArray<{ institution: string; year: number | null }>,
  isWcm: (org: string) => boolean,
): string | null {
  for (const e of educations) {
    if (e.year == null || !e.institution.trim() || isWcm(e.institution)) continue;
    for (const o of awardOrgs) {
      if (!o.orgName || o.fiscalYear == null || isWcm(o.orgName)) continue;
      if (o.fiscalYear < e.year - PRIOR_INSTITUTION_YEARS_BEFORE) continue;
      if (o.fiscalYear > e.year + PRIOR_INSTITUTION_YEARS_AFTER) continue;
      if (sameInstitution(o.orgName, e.institution)) return e.institution;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cue 6 helpers.
// ---------------------------------------------------------------------------

/** "surname f" — how `authorsString` ("Lastname FM, Other A") names an author. */
export function authorKey(lastName: string, firstName: string | null | undefined): string | null {
  const last = lastName.toLowerCase().replace(/[^a-z\s-]/g, "").trim();
  const f = (firstName ?? "").replace(/[^A-Za-z]/g, "").toLowerCase()[0];
  if (!last || !f) return null;
  return `${last} ${f}`;
}

/** Co-author keys and how many of the scholar's papers each appears on.
 *  `selfKey` is dropped so the scholar never counts as their own co-author. */
export function coauthorCounts(
  authorsStrings: ReadonlyArray<string | null>,
  selfKey: string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of authorsStrings) {
    if (!s) continue;
    const seen = new Set<string>();
    for (const a of s.split(/,\s*/)) {
      const m = a.trim().match(/^(.+?)\s+([A-Z]{1,4})$/);
      if (!m) continue;
      const key = authorKey(m[1]!, m[2]!);
      if (!key || key === selfKey || seen.has(key)) continue;
      seen.add(key);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cue 7 helpers.
// ---------------------------------------------------------------------------

/** MEDLINE check tags and other near-universal descriptors that would make any
 *  two biomedical records look alike. */
const MESH_STOPLIST = new Set([
  "D006801", // Humans
  "D000818", // Animals
  "D008297", // Male
  "D005260", // Female
  "D051379", // Mice
  "D051381", // Rats
  "D000328", // Adult
  "D008875", // Middle Aged
  "D000368", // Aged
  "D000369", // Aged, 80 and over
  "D055815", // Young Adult
  "D000293", // Adolescent
  "D002648", // Child
  "D002675", // Child, Preschool
  "D007223", // Infant
  "D007231", // Infant, Newborn
  "D012107", // Research
  "D035843", // Biomedical Research
]);

/**
 * Share of the award's MeSH descriptors that appear in at least two of the
 * scholar's papers. null when the award has no usable descriptors or the
 * scholar has no MeSH-tagged papers. Pure.
 */
export function topicOverlap(
  awardDescriptorUis: ReadonlyArray<string>,
  scholarDescriptorCounts: ReadonlyMap<string, number>,
  scholarTaggedPapers: number,
): { share: number; descriptors: number; papers: number } | null {
  const uis = [...new Set(awardDescriptorUis)].filter((u) => !MESH_STOPLIST.has(u));
  if (uis.length === 0 || scholarTaggedPapers === 0) return null;
  const hits = uis.filter((u) => (scholarDescriptorCounts.get(u) ?? 0) >= 2).length;
  return { share: hits / uis.length, descriptors: uis.length, papers: scholarTaggedPapers };
}

// ---------------------------------------------------------------------------
// The scorer.
// ---------------------------------------------------------------------------

function band(score: number): AttributionBand {
  if (score >= SHOW_AT) return "show";
  if (score <= HIDE_AT) return "hide";
  return "queue";
}

/**
 * Score one (scholar, award) pair. For `policy === "none"` (every profile
 * confirmed by publications) the award shows: the scorer exists to catch
 * name-linked profiles, and a publication-confirmed one is not that. Pure.
 */
export function scoreAttribution(e: AttributionEvidence): AttributionScore {
  if (e.policy === "none") return { band: "show", score: SHOW_AT, reasons: [], rule: "sum" };

  const hits: CueHit[] = [];
  const add = (id: Exclude<CueId, "infoed_other_wcm_pi_named">, reason: string) =>
    hits.push({ id, weight: WEIGHTS[id], reason });

  if (e.publicationLinked) {
    add("pub_linked", "A confirmed publication of the scholar cites this award");
  }
  if (e.policy === "wcm-or-publication" && e.wcmOrgHistory) {
    add("wcm_org", "Held at WCM at some point, and the NIH profile was matched by name only");
  }

  let decisive: CueHit | null = null;
  if (e.infoedOther?.piLevel) {
    if (e.infoedOther.profileNameMatchesOther) {
      decisive = {
        id: "infoed_other_wcm_pi_named",
        weight: 0,
        reason:
          "InfoEd lists another WCM investigator as PI, and the NIH profile's name matches theirs",
      };
      hits.push(decisive);
    } else {
      add("infoed_other_wcm_pi", "InfoEd lists another WCM investigator as PI or Co-PI");
    }
  }

  if (e.rejected && e.rejected.overlap > 0) {
    const { overlap, linkedTotal } = e.rejected;
    if (linkedTotal <= REJECTED_SMALL_SET || overlap >= REJECTED_MIN_OVERLAP_LARGE) {
      add(
        "rejected_pmids",
        `${overlap} of the ${linkedTotal} papers RePORTER links to this award were rejected ` +
          `in ReCiter as not the scholar's`,
      );
    }
  }

  const gap = timelineGapYears(e.activityCode, e.startYear, e.doctoralYears);
  if (gap > 0 && e.doctoralYears) {
    const when = isPredoctoralCode(e.activityCode)
      ? `${gap + TIMELINE_SLACK_YEARS} years after the scholar's last doctorate (${e.doctoralYears.latest})`
      : `${gap + TIMELINE_SLACK_YEARS} years before the scholar's first doctorate (${e.doctoralYears.earliest})`;
    const what = `A ${e.activityCode} starting in ${e.startYear}, ${when}`;
    if (gap + TIMELINE_SLACK_YEARS >= TIMELINE_STRONG_YEARS) add("timeline_impossible", what);
    else add("timeline_unlikely", what);
  }

  if (e.middleInitialConflict === true) {
    add("middle_initial_conflict", "The NIH PI's middle initial differs from the scholar's");
  }
  if (e.priorInstitution) {
    add("prior_institution", `Held at an institution the scholar trained at (${e.priorInstitution})`);
  }
  if (e.coPiSharedPapers !== null && e.coPiSharedPapers >= COAUTHOR_MIN_PAPERS) {
    add("copi_coauthor", `A co-PI on this award co-authored ${e.coPiSharedPapers} of the scholar's papers`);
  }

  const base = PRIOR + hits.reduce((s, h) => s + h.weight, 0);
  let score = base;
  // Rule 3: topic only inside the queue band.
  if (e.topic && band(base) === "queue") {
    const pct = Math.round(e.topic.share * 100);
    if (e.topic.share >= TOPIC_MATCH_AT) {
      add("topic_match", `${pct}% of the award's MeSH topics recur in the scholar's papers`);
      score += WEIGHTS.topic_match;
    } else if (
      e.topic.share === 0 &&
      e.topic.descriptors >= TOPIC_MIN_DESCRIPTORS &&
      e.topic.papers >= TOPIC_MIN_PAPERS
    ) {
      add("topic_mismatch", "None of the award's MeSH topics recur in the scholar's papers");
      score += WEIGHTS.topic_mismatch;
    }
  }

  const reasons = [...hits].sort(
    (a, b) => (a === decisive ? -1 : b === decisive ? 1 : Math.abs(b.weight) - Math.abs(a.weight)),
  );

  // Rule 1: decisive, unless a linked paper contradicts it.
  if (decisive) {
    return e.publicationLinked
      ? { band: "queue", score, reasons, rule: "conflict" }
      : { band: "hide", score, reasons, rule: "decisive" };
  }
  // Rule 2: strong evidence both ways.
  const strongFor = hits.some((h) => h.weight >= STRONG);
  const strongAgainst = hits.some((h) => h.weight <= -STRONG);
  if (strongFor && strongAgainst) return { band: "queue", score, reasons, rule: "conflict" };

  return { band: band(score), score, reasons, rule: "sum" };
}

/**
 * The cues that decide a review, for spotting changed evidence: the band plus
 * every non-tie-break cue. Topic is left out so enrichment landing a run later
 * does not reopen a decided item. Pure.
 */
export function evidenceKey(s: AttributionScore): string {
  const ids = s.reasons
    .map((r) => r.id)
    .filter((id) => id !== "topic_match" && id !== "topic_mismatch")
    .sort();
  return `${s.band}|${ids.join(",")}`.slice(0, 255);
}
