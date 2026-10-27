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
 * Rules on top of the sum:
 *   1. (Retired 2026-10-24: cue 1's named branch used to hide outright. It is
 *      now a strong weight like any other, so a strong tie the other way sends
 *      the award to a curator instead of hiding it.)
 *   2. CONFLICT. A strong positive and a strong negative together go to the
 *      queue, whatever the sum says. A curator, not arithmetic, settles a
 *      linked paper against an impossible timeline.
 *   3. TIE-BREAK. Topic similarity (cue 7) only counts while the rest of the
 *      score sits inside the queue band. It can tip a borderline award but can
 *      never lift a hide, or sink a show, on its own.
 *   4. NAME RARITY. How many NIH PI profiles share the scholar's name counts
 *      only for a name-only profile, and only when another cue fired. With
 *      nothing else found, the award stays where the prior puts it.
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
  | "wcm_org_shared_name"
  | "infoed_other_wcm_pi_named"
  | "infoed_other_wcm_pi"
  | "rejected_pmids"
  | "timeline_impossible"
  | "timeline_unlikely"
  | "middle_initial_conflict"
  | "prior_institution"
  | "copi_coauthor"
  | "topic_match"
  | "topic_mismatch"
  | "profile_proven"
  | "name_rare"
  | "name_common"
  | "pi_name_mismatch"
  | "pi_given_name_mismatch";

export interface CueHit {
  id: CueId;
  /** Signed weight that went into the score. Reviews stored before 2026-10-24
   *  carry 0 for the named InfoEd cue, then decisive. */
  weight: number;
  /** One short line for the curator. Built from the award and the scholar's own
   *  record; never logged by the ETL. */
  reason: string;
  /** Cue 6 only: the co-PI and the scholar's PMIDs they co-authored, so the
   *  queue can name them and list the papers. */
  coPi?: { name: string; pmids: string[]; total: number };
  /** Cue 2 only: the rejected papers RePORTER links to the award (capped), with
   *  PubMed's title when the ETL could fetch it, so the queue can list them. */
  rejected?: Array<{ pmid: string; title: string | null }>;
}

export interface AttributionScore {
  band: AttributionBand;
  score: number;
  /** Every cue that fired, strongest first. */
  reasons: CueHit[];
  /** The rule that settled the band, when it was not the plain sum. */
  rule: "conflict" | "sum";
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
  /** WCM in the award's org history, but the WCM directory has another person,
   *  current or former, who could hold an NIH award and shares the scholar's
   *  first and last name. The award may be theirs, so WCM alone no longer
   *  settles it: moderate, which queues an award with nothing else. */
  wcm_org_shared_name: 2,
  /** Another WCM investigator holds the award in InfoEd as PI, and our NIH
   *  profile's name matches theirs. Strong, not an override: a strong tie the
   *  other way queues the award (rule 2). */
  infoed_other_wcm_pi_named: -5,
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
  /** The RePORTER PI's middle initial matches none of the scholar's. Fires
   *  only when both sides have one, so a missing middle name never counts.
   *  Strong: staging 2026-10-24 found it on 191 awards, 176 with nothing else
   *  for the scholar, and on 12 a confirmed paper cites (a data error on one
   *  side). Strong, so those 12 queue rather than hide (rule 2). */
  middle_initial_conflict: -4,
  /** The award's institution and years match a degree the scholar earned
   *  there. */
  prior_institution: 2,
  /** A co-PI on the award co-authored at least COAUTHOR_MIN_PAPERS of the
   *  scholar's confirmed papers. */
  copi_coauthor: 2,
  /** Tie-break only, see rule 3. */
  topic_match: 1,
  topic_mismatch: -1,
  /** The award's PI profile is proven the scholar's: matched by publications,
   *  or PROFILE_PROVEN_MIN_LINKED of its other awards cite the scholar's papers.
   *  A pre-WCM award no paper cites (a conference grant, an old contract) then
   *  shows on the strength of the profile. STRONG, so a strong negative still
   *  queues it. */
  profile_proven: 4,
  /** Name-only profiles: the only NIH PI profile in RePORTER with the
   *  scholar's first and last name. Counts only next to other evidence (rule
   *  4): a scholar never funded by NIH shares a rare name with a namesake. */
  name_rare: 1,
  /** Name-only profiles: NAME_COMMON_MIN or more NIH PI profiles share the
   *  name. Same gate as name_rare. */
  name_common: -1,
  /** RePORTER's PI on the NIH profile we hold for the scholar has a surname
   *  that appears nowhere in the scholar's names: the profile is most likely
   *  someone else's (a grant-join that paired the wrong PI). Strong, not an
   *  override, because people change surnames: with a strong tie the other way
   *  it queues (rule 2). Staging 2026-10-25: 102 awards, 11 scholars, 60 shown. */
  pi_name_mismatch: -5,
  /** RePORTER's PI on our NIH profile shares the scholar's surname but not a
   *  first name (`piGivenNameConflicts`): a relative or a namesake, e.g. a
   *  spouse whose co-authored papers also cite the awards. Same weight and
   *  effect as pi_name_mismatch. Staging 2026-10-27: 10 scholar/PI pairs, 11
   *  shown awards. */
  pi_given_name_mismatch: -5,
} as const satisfies Record<CueId, number>;

/** NIH PI profiles sharing the scholar's name at or above which it is common
 *  (staging 2026-10-24: 348 of 472 name-only scholars have 1, 6 have 10+). */
export const NAME_COMMON_MIN = 10;

/** Rule 4's count from one page of a RePORTER name search. A full page may be
 *  cut short, so its count is a lower bound: still safe to call common, never
 *  rare. null ⇒ unknown. Pure. */
export function nameProfileCountFrom(
  distinctProfiles: number,
  projectsReturned: number,
  pageLimit: number,
): number | null {
  if (projectsReturned < pageLimit) return distinctProfiles;
  return distinctProfiles >= NAME_COMMON_MIN ? distinctProfiles : null;
}

/** Other awards on one NIH profile that a confirmed paper ties to the scholar
 *  before that profile vouches for the rest. Two, so one stray citation by a
 *  co-author does not prove a namesake's profile. */
export const PROFILE_PROVEN_MIN_LINKED = 2;
/** Shared papers with a co-PI before cue 6 fires. One shared paper is too easy
 *  to hit through a common surname and initial. */
export const COAUTHOR_MIN_PAPERS = 2;
/** Years of slack on each side of a degree year before cue 3 fires. */
export const TIMELINE_SLACK_YEARS = 1;
/** A gap this large or larger is "impossible"; smaller (beyond the slack) is
 *  "unlikely". */
export const TIMELINE_STRONG_YEARS = 5;
/** Share of the award's MeSH descriptors in >= 2 of the scholar's papers at or
 *  above which cue 7 counts as a match. Staging, 2026-10-18 (award terms vs
 *  paper MeSH): visible awards p75 4-6%, p90 8-10%; hidden-unverified p75 1%,
 *  p90 3-5%. */
export const TOPIC_MATCH_AT = 0.1;
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
  /** First year the scholar held the award: their earliest fiscal year on the
   *  core (cue 3). Not the project's start, which predates a transferred PI. */
  startYear: number | null;
  /** Cue 1. null ⇒ no other WCM investigator holds this core in InfoEd. */
  infoedOther: { piLevel: boolean; profileNameMatchesOther: boolean } | null;
  /** Cue 2. null ⇒ the scholar's ReCiter rejections are unavailable.
   *  `linkedTotal` null ⇒ the core is over RePORTER's offset cap, so its true
   *  link count is unknown and it counts as a large set. */
  rejected: { overlap: number; linkedTotal: number | null; pmids?: string[] } | null;
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
  /** Cue 6's detail for the curator: that co-PI's RePORTER name and the shared
   *  PMIDs (capped). Absent in older callers. */
  coPi?: { name: string; pmids: string[] } | null;
  /** Cue 7. null ⇒ the award has no MeSH descriptors yet, or the scholar has
   *  no MeSH-tagged papers. */
  topic: { share: number; descriptors: number; papers: number } | null;
  /** Cue 8. The award's PI profile is proven the scholar's, by its resolution
   *  source ("matched") or by sibling awards a confirmed paper ties to them
   *  ("siblings"). null ⇒ neither. Set by `profileProof`, after every award of
   *  the scholar has its `publicationLinked`. */
  profileProven: { kind: "matched" } | { kind: "siblings"; linked: number } | null;
  /** Rule 4. Distinct NIH PI profiles in RePORTER whose name matches the
   *  scholar's, theirs included. null ⇒ unknown (the search failed or found
   *  none, not even theirs). Absent in older callers. */
  nameProfileCount?: number | null;
  /** WCM directory people, other than the scholar, who share their first and
   *  last name and could hold an NIH award (faculty, postdocs, students, other
   *  academic staff; current or former). null ⇒ not looked up. Absent in older
   *  callers. */
  wcmNamesakes?: number | null;
  /** Whether RePORTER's PI on our NIH profile carries the scholar's surname
   *  (`piSurnameMatches`). null ⇒ no PI name to compare. Absent in older
   *  callers. */
  piSurnameMatches?: boolean | null;
  /** Whether that PI, with the scholar's surname, has a first name the
   *  scholar's names rule out (`piGivenNameConflicts`). null ⇒ not compared.
   *  Absent in older callers. */
  piGivenNameConflicts?: boolean | null;
}

// ---------------------------------------------------------------------------
// Cue 1 helpers.
// ---------------------------------------------------------------------------

/** How the RePORTER PI's first name agrees with a person's: the same full
 *  first name, only the initial, or not at all. */
export function firstNameAgreement(
  piFirstName: string | null | undefined,
  names: ReadonlyArray<string | null | undefined>,
): "full" | "initial" | "none" {
  const pi = (piFirstName ?? "").replace(/[^A-Za-z]/g, "").toLowerCase();
  if (!pi) return "none";
  let best: "full" | "initial" | "none" = "none";
  for (const n of names) {
    if (!n) continue;
    const first = nameTokens(n)[0]?.replace(/-/g, "");
    if (!first) continue;
    if (pi.length > 1 && first.length > 1 && pi === first) return "full";
    if (pi[0] === first[0]) best = "initial";
  }
  return best;
}

/** InfoEd roles that make the other WCM investigator the award's holder.
 *  Co-I, key personnel and PI-Subaward (the core is another institution's
 *  prime) do not. */
export function isInfoedPiLevel(role: string): boolean {
  return role === "PI" || role === "Co-PI";
}

/**
 * Cue 1 evidence from the other WCM investigators InfoEd lists on the core.
 *
 * A holder a RePORTER co-PI accounts for (`namesMatch` against the award's
 * other PIs) is EXPLAINED and dropped: on a multi-PI award InfoEd naming the
 * other PI is exactly what it should say. Staging, 2026-10-18: every visible,
 * publication-linked award with another WCM PI in InfoEd was multi-PI.
 *
 * `profileNameMatchesOther` needs the RePORTER PI (our NIH profile) to share an
 * unexplained holder's surname (`namesMatch`) AND full first name, while NOT
 * sharing the scholar's full first name: a grant-join profile already passed a
 * surname-plus-initial check against the scholar, so that alone proves
 * nothing. Pure; `namesMatch` is injected so this module stays free of the
 * resolver.
 */
export function infoedOtherEvidence(args: {
  ourPis: ReadonlyArray<{ first_name: string | null; piName: string }>;
  coPiNames?: ReadonlyArray<string>;
  scholarNames: ReadonlyArray<string | null | undefined>;
  others: ReadonlyArray<{ role: string; names: ReadonlyArray<string | null | undefined> }>;
  namesMatch: (a: string, b: string) => boolean;
}): { piLevel: boolean; profileNameMatchesOther: boolean } | null {
  if (args.others.length === 0) return null;
  const coPis = args.coPiNames ?? [];
  const piLevel = args.others.filter(
    (o) =>
      isInfoedPiLevel(o.role) &&
      !coPis.some((c) => o.names.some((n) => !!n && args.namesMatch(c, n))),
  );
  if (piLevel.length === 0) return { piLevel: false, profileNameMatchesOther: false };
  const matches = args.ourPis.some(
    (pi) =>
      firstNameAgreement(pi.first_name, args.scholarNames) !== "full" &&
      piLevel.some(
        (o) =>
          o.names.some((n) => !!n && args.namesMatch(pi.piName, n)) &&
          firstNameAgreement(pi.first_name, o.names) === "full",
      ),
  );
  return { piLevel: true, profileNameMatchesOther: matches };
}

// ---------------------------------------------------------------------------
// Cue 2 helpers.
// ---------------------------------------------------------------------------

/** Individual research, career and fellowship awards. Center, program,
 *  training and resource cores (P, T, UL1, U54, S10 ...) link thousands of
 *  papers by many people, so a rejected paper among them proves nothing. */
export function isIndividualAward(code: string | null): boolean {
  if (!code) return false;
  return /^(R\d|K\d|F\d|DP\d|U01)/i.test(code) && !/^(R25|K12|KL2)/i.test(code);
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
 *  slack: a predoctoral award starting after the LATEST doctorate, or an
 *  individual award (`isIndividualAward`) starting before the EARLIEST one.
 *  0 when plausible or unknown.
 *
 *  `startYear` must be the first year THIS scholar held the award (their first
 *  fiscal year on the core), not the project's start: a T32, P or U award
 *  passes from PI to PI, and its original start says nothing about the
 *  current holder. Institutional awards are left out of the "before the
 *  doctorate" branch for the same reason (staging, 2026-10-18: most of the
 *  visible rows the cue hit were T, P, S and U awards). */
export function timelineGapYears(
  activityCode: string | null,
  startYear: number | null,
  doctoral: { earliest: number; latest: number } | null,
): number {
  if (activityCode === null || startYear === null || doctoral === null) return 0;
  if (isPredoctoralCode(activityCode)) {
    return Math.max(0, startYear - doctoral.latest - TIMELINE_SLACK_YEARS);
  }
  if (!isIndividualAward(activityCode)) return 0;
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

/** Letters-only lower-case words of a name, hyphenated parts split. */
function nameWords(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[\s,.\-']+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter((w) => w.length >= 2);
}

/**
 * Whether RePORTER's PI name carries the scholar's surname. RePORTER prints
 * "LAST, FIRST M" (surname before the comma) or "First … Last" (any word after
 * the first).
 * Matches when any surname word appears anywhere in the scholar's names on
 * record, so compound and hyphenated surnames and a surname used as a middle
 * name still match. null ⇒ nothing to compare. Pure.
 */
export function piSurnameMatches(
  piName: string | null | undefined,
  scholarNames: ReadonlyArray<string | null | undefined>,
): boolean | null {
  const raw = (piName ?? "").trim();
  if (!raw) return null;
  // "First Last": every word after the first, so a trailing "Jr" or a
  // compound surname still finds its match.
  const surname = raw.includes(",") ? nameWords(raw.split(",")[0]!) : nameWords(raw).slice(1);
  const ours = new Set(scholarNames.flatMap((n) => (n ? nameWords(n.split(",")[0]!) : [])));
  if (surname.length === 0 || ours.size === 0) return null;
  return surname.some((w) => ours.has(w));
}

/**
 * Whether RePORTER's PI name, which carries the scholar's surname, has a first
 * name the scholar's names rule out: they share no other full word, no name
 * word contains another (Beth in Elizabeth), and RePORTER's first given
 * initial starts none of the scholar's words. Lenient on purpose: a middle
 * name in use ("R. Brad Jones", "Maria Virginia Pascual") shares a full word,
 * and an initial-only first name rarely conflicts. null ⇒ the surnames don't
 * match or there is nothing to compare. Pure.
 */
export function piGivenNameConflicts(
  piName: string | null | undefined,
  scholarNames: ReadonlyArray<string | null | undefined>,
): boolean | null {
  if (piSurnameMatches(piName, scholarNames) !== true) return null;
  const raw = (piName ?? "").trim();
  const words = (n: string) =>
    n
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[\s,.\-']+/)
      .map((w) => w.replace(/[^a-z]/g, ""))
      .filter((w) => w.length > 0);
  const theirs = words(raw);
  const ours = new Set(scholarNames.flatMap((n) => (n ? words(n) : [])));
  const first = (raw.includes(",") ? words(raw.split(",")[1] ?? "") : theirs)[0];
  if (!first || ours.size === 0) return null;
  // The surname is one shared full word; a second one is a given name.
  if (theirs.filter((w) => w.length >= 2 && ours.has(w)).length >= 2) return false;
  for (const x of theirs)
    for (const y of ours)
      if (x !== y && x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x))) return false;
  // Initials of the scholar's given names only: the shared surname's would
  // pass a "Charles Choi" for a "Mary Choi".
  for (const y of ours) if (!(y.length >= 2 && theirs.includes(y)) && y[0] === first[0]) return false;
  return true;
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

/** Co-author keys and the PMIDs of the scholar's papers each appears on.
 *  `selfKey` is dropped so the scholar never counts as their own co-author. */
export function coauthorPapers(
  papers: ReadonlyArray<{ pmid: string; authorsString: string | null }>,
  selfKey: string | null,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { pmid, authorsString: s } of papers) {
    if (!s) continue;
    const seen = new Set<string>();
    for (const a of s.split(/,\s*/)) {
      const m = a.trim().match(/^(.+?)\s+([A-Z]{1,4})$/);
      if (!m) continue;
      const key = authorKey(m[1]!, m[2]!);
      if (!key || key === selfKey || seen.has(key)) continue;
      seen.add(key);
      out.set(key, [...(out.get(key) ?? []), pmid]);
    }
  }
  return out;
}

/** Co-author keys and how many of the scholar's papers each appears on. */
export function coauthorCounts(
  authorsStrings: ReadonlyArray<string | null>,
  selfKey: string | null,
): Map<string, number> {
  const papers = coauthorPapers(authorsStrings.map((authorsString, i) => ({ pmid: String(i), authorsString })), selfKey);
  return new Map([...papers].map(([k, v]) => [k, v.length]));
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
  const add = (id: CueId, reason: string) => hits.push({ id, weight: WEIGHTS[id], reason });

  if (e.publicationLinked) {
    add("pub_linked", "A confirmed publication of the scholar cites this award");
  }
  if (e.policy === "wcm-or-publication" && e.wcmOrgHistory) {
    if (e.wcmNamesakes != null && e.wcmNamesakes > 0) {
      add(
        "wcm_org_shared_name",
        `Held at WCM at some point, but ${e.wcmNamesakes === 1 ? "another WCM person shares" : `${e.wcmNamesakes} other WCM people share`} the scholar's name`,
      );
    } else {
      add("wcm_org", "Held at WCM at some point, and the NIH profile was matched by name only");
    }
  }

  if (e.infoedOther?.piLevel) {
    if (e.infoedOther.profileNameMatchesOther) {
      add(
        "infoed_other_wcm_pi_named",
        "InfoEd lists another WCM investigator as PI, and the NIH profile's name matches theirs",
      );
    } else {
      add("infoed_other_wcm_pi", "InfoEd lists another WCM investigator as PI or Co-PI");
    }
  }

  if (e.rejected && e.rejected.overlap > 0 && isIndividualAward(e.activityCode)) {
    const { overlap, linkedTotal } = e.rejected;
    const small = linkedTotal !== null && linkedTotal <= REJECTED_SMALL_SET;
    if (small || overlap >= REJECTED_MIN_OVERLAP_LARGE) {
      add(
        "rejected_pmids",
        linkedTotal === null
          ? `${overlap} papers RePORTER links to this award were rejected in ReCiter as not the scholar's`
          : `${overlap} of the ${linkedTotal} papers RePORTER links to this award were rejected ` +
              `in ReCiter as not the scholar's`,
      );
      const pmids = e.rejected.pmids ?? [];
      if (pmids.length > 0) hits[hits.length - 1]!.rejected = pmids.map((pmid) => ({ pmid, title: null }));
    }
  }

  const gap = timelineGapYears(e.activityCode, e.startYear, e.doctoralYears);
  if (gap > 0 && e.doctoralYears) {
    const when = isPredoctoralCode(e.activityCode)
      ? `${gap + TIMELINE_SLACK_YEARS} years after the scholar's last doctorate (${e.doctoralYears.latest})`
      : `${gap + TIMELINE_SLACK_YEARS} years before the scholar's first doctorate (${e.doctoralYears.earliest})`;
    const what = `A ${e.activityCode} first held in ${e.startYear}, ${when}`;
    if (gap + TIMELINE_SLACK_YEARS >= TIMELINE_STRONG_YEARS) add("timeline_impossible", what);
    else add("timeline_unlikely", what);
  }

  if (e.middleInitialConflict === true) {
    add("middle_initial_conflict", "The NIH PI's middle initial differs from the scholar's");
  }
  if (e.priorInstitution) {
    add("prior_institution", `Held at an institution the scholar trained at (${e.priorInstitution})`);
  }
  const surnameMismatch = e.piSurnameMatches === false;
  if (surnameMismatch) {
    add("pi_name_mismatch", "The NIH profile's PI has a different surname from the scholar");
  }
  const givenMismatch = !surnameMismatch && e.piGivenNameConflicts === true;
  if (givenMismatch) {
    add("pi_given_name_mismatch", "The NIH profile's PI has the scholar's surname but a different first name");
  }
  const piMismatch = surnameMismatch || givenMismatch;
  // A profile that is not the scholar's vouches for nothing.
  if (!piMismatch && e.profileProven?.kind === "matched") {
    add("profile_proven", "The award is on the scholar's NIH profile that was matched by their publications");
  } else if (!piMismatch && e.profileProven?.kind === "siblings") {
    add(
      "profile_proven",
      `${e.profileProven.linked} other awards on the same NIH profile are cited by the scholar's papers`,
    );
  }
  if (e.coPiSharedPapers !== null && e.coPiSharedPapers >= COAUTHOR_MIN_PAPERS) {
    add("copi_coauthor", `A co-PI on this award co-authored ${e.coPiSharedPapers} of the scholar's papers`);
    if (e.coPi) hits[hits.length - 1]!.coPi = { ...e.coPi, total: e.coPiSharedPapers };
  }

  // Rule 4: name rarity, name-only profiles, next to other evidence only.
  const n = e.nameProfileCount;
  if (e.policy === "wcm-or-publication" && hits.length > 0 && n != null && n > 0) {
    if (n === 1) add("name_rare", "The only NIH PI profile with the scholar's name");
    else if (n >= NAME_COMMON_MIN) add("name_common", `${n} NIH PI profiles share the scholar's name`);
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

  const reasons = [...hits].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  // Rule 2: strong evidence both ways.
  const strongFor = hits.some((h) => h.weight >= STRONG);
  const strongAgainst = hits.some((h) => h.weight <= -STRONG);
  if (strongFor && strongAgainst) return { band: "queue", score, reasons, rule: "conflict" };

  return { band: band(score), score, reasons, rule: "sum" };
}

/** Cues left out of the evidence key: tie-breaks, and name rarity, whose count
 *  moves as other people win awards. */
const KEYLESS_CUES: ReadonlySet<CueId> = new Set(["topic_match", "topic_mismatch", "name_rare", "name_common"]);

/**
 * The cues that decide a review, for spotting changed evidence: the band plus
 * every cue but KEYLESS_CUES. Topic is left out so enrichment landing a run
 * later does not reopen a decided item. Pure.
 */
export function evidenceKey(s: AttributionScore): string {
  const ids = s.reasons
    .map((r) => r.id)
    .filter((id) => !KEYLESS_CUES.has(id))
    .sort();
  return `${s.band}|${ids.join(",")}`.slice(0, 255);
}
