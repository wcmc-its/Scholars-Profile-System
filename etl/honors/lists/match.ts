/**
 * The honors-list matcher: roster entry -> candidate scholars. Pure, no DB.
 *
 * CONSERVATIVE BY DESIGN. A match only ever becomes a PENDING row for a curator
 * (`/edit/honors-queue` Possible); nothing here can publish. Even so, a wrong
 * candidate costs a curator's time and a wrong approval credits a real person
 * with someone else's award, so every gate below errs toward a miss:
 *
 *   1. AFFILIATION. The roster entry's printed institution must name Weill
 *      Cornell (or one of its former names). Plain "Cornell University" is the
 *      Ithaca campus and does NOT pass. An entry with no affiliation cannot pass.
 *   2. NAME (the F1 rule the seed used): the FULL first name and the surname must
 *      both equal the scholar's, after folding case, accents and punctuation. An
 *      initial ("J. Doe") never matches a first name. Middle names are ignored
 *      on both sides, so "Jane Q. Doe" matches "Jane Doe".
 *   3. BREADTH. A line that matches more than MAX_CANDIDATES_PER_LINE scholars
 *      is too common a name to be worth a curator's pick; it is dropped.
 *
 * The one stronger signal: a roster that links the person's VIVO profile
 * (`vivo.weill.cornell.edu/display/cwid-<cwid>`, which the NAI roster does). That
 * is an identifier join, so the candidate is exactly that scholar, but it still
 * lands as pending.
 */

export type RosterEntry = {
  /** The name exactly as the roster printed it, for "Listed as". */
  printedName: string;
  /** Given name as a separate token, when the roster separates it ("Doe, Jane"). */
  given: string;
  family: string;
  affiliation: string | null;
  year: number | null;
  /** A CWID the roster itself links to (VIVO profile URL). */
  cwidHint?: string | null;
};

export type ScholarForMatch = {
  cwid: string;
  preferredName: string;
  fullName: string;
};

export type Candidate = {
  cwid: string;
  /** Short, curator-facing: what the match rests on. Stored on `honor.evidence`. */
  evidence: string;
};

export const MAX_CANDIDATES_PER_LINE = 3;
/** `honor.evidence` is VARCHAR(255). */
export const EVIDENCE_MAX = 255;

/**
 * Weill Cornell and its former names as a roster prints them. Deliberately NOT
 * bare "Cornell" (most "Cornell University" affiliations are the Ithaca campus)
 * and NOT bare "Weill": Ithaca's "Weill Institute for Cell & Molecular Biology"
 * is on the AAAS roster. `weil+` tolerates a roster typo seen live ("Weilll").
 */
const WCM_AFFILIATION =
  /\bweil+\s+(?:cornell|medical)|cornell university medical college|cornell medical (?:college|center)|new york hospital[- ]+cornell|medical college of cornell/i;

export function isWcmAffiliation(affiliation: string | null | undefined): boolean {
  return typeof affiliation === "string" && WCM_AFFILIATION.test(affiliation);
}

/** Fold a name token the way a human compares it: case, accents, punctuation. */
export function foldToken(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

/**
 * Honorifics, generational suffixes and degrees a roster prints around a name.
 * No token here may also be a plausible surname: "Do" (a degree, and a common
 * surname) is deliberately absent. Degrees normally follow a comma, which
 * `splitDisplayName` already cuts.
 */
const NAME_NOISE =
  /^(?:dr|prof|jr|sr|ii|iii|iv|md|phd|mph|mba|mbbs|mbchb|dphil|scd|dvm|facp|pharmd)$/;

/** Name tokens with suffixes/degrees and empty tokens dropped (folded). */
function nameTokens(s: string): string[] {
  return s
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .map(foldToken)
    .filter((t) => t.length > 0 && !NAME_NOISE.test(t));
}

/**
 * Split a printed "First Middle Last[, MD, PhD]" into given + family. Anything
 * after the first comma is taken to be degrees/suffixes ("Jane Doe, MD, PhD").
 * Returns null when there are not two usable tokens.
 */
export function splitDisplayName(printed: string): { given: string; family: string } | null {
  const head = printed.split(",")[0];
  const tokens = nameTokens(head);
  if (tokens.length < 2) return null;
  return { given: tokens[0], family: tokens[tokens.length - 1] };
}

/**
 * Split a "Last, First Middle" roster name (AAAS prints this form). Returns null
 * when either side is empty.
 */
export function splitSortName(printed: string): { given: string; family: string } | null {
  const comma = printed.indexOf(",");
  if (comma < 0) return splitDisplayName(printed);
  const familyTokens = nameTokens(printed.slice(0, comma));
  const givenTokens = nameTokens(printed.slice(comma + 1));
  if (familyTokens.length === 0 || givenTokens.length === 0) return null;
  return { given: givenTokens[0], family: familyTokens[familyTokens.length - 1] };
}

/** A usable given name: a full name, not an initial. */
function isFullGiven(given: string): boolean {
  return given.replace(/-/g, "").length >= 2;
}

export type ScholarIndex = {
  byKey: Map<string, Set<string>>;
  cwids: Set<string>;
};

const key = (given: string, family: string) => `${given}|${family}`;

/**
 * Index scholars by (given, family) from BOTH preferred and full name, so a
 * roster printing the legal name and one printing the preferred name both hit.
 */
export function buildScholarIndex(scholars: readonly ScholarForMatch[]): ScholarIndex {
  const byKey = new Map<string, Set<string>>();
  const cwids = new Set<string>();
  for (const s of scholars) {
    cwids.add(s.cwid);
    for (const name of [s.preferredName, s.fullName]) {
      const split = splitDisplayName(name);
      if (!split || !isFullGiven(split.given)) continue;
      const k = key(split.given, split.family);
      const set = byKey.get(k) ?? new Set<string>();
      set.add(s.cwid);
      byKey.set(k, set);
    }
  }
  return { byKey, cwids };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** The evidence line for a name + institution match. */
export function affiliationEvidence(entry: RosterEntry): string {
  const where = entry.affiliation ? `listed at ${entry.affiliation}` : "listed";
  return clip(`Name and institution match: ${where}`, EVIDENCE_MAX);
}

/**
 * Candidates for one roster entry, or [] when any gate fails. Sorted by cwid so
 * a re-run proposes the same rows in the same order.
 */
export function matchEntry(entry: RosterEntry, index: ScholarIndex): Candidate[] {
  // A roster that links the scholar's own VIVO page names them outright.
  const hint = entry.cwidHint?.toLowerCase() ?? null;
  if (hint && index.cwids.has(hint)) {
    return [{ cwid: hint, evidence: "Roster links this scholar's Weill Cornell profile" }];
  }
  if (!isWcmAffiliation(entry.affiliation)) return [];
  const given = foldToken(entry.given);
  const family = foldToken(entry.family);
  if (!isFullGiven(given) || family.length === 0) return [];
  const hits = index.byKey.get(key(given, family));
  if (!hits || hits.size === 0 || hits.size > MAX_CANDIDATES_PER_LINE) return [];
  const evidence = affiliationEvidence(entry);
  return [...hits].sort().map((cwid) => ({ cwid, evidence }));
}
