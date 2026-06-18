/**
 * COI-gap detection pipeline (Phase 1 core).
 *
 * Compares a scholar's PubMed competing-interest statement text against their
 * officially-disclosed COI set and surfaces "unmatched" relationships — a named
 * relationship in the publication that is NOT in the disclosed set (the Case-1
 * gap). Each surfaced candidate carries a qualitative confidence tier reflecting
 * how likely the relationship actually belongs to *this* scholar.
 *
 * This is a faithful TypeScript port of the validated Track-A harness
 * (`scripts/coi-phase0/analyze.mjs`); see `docs/coi-pubmed-phase0-trackA-results.md`
 * for the validation run and `docs/coi-pubmed-unmatched-feasibility.md` for the
 * design. The module is intentionally PURE — no I/O, no framework, no `@/`
 * imports — so it is unit-testable and reusable from the ETL (Track B ingestion)
 * and any precompute job. Normalization can be upgraded by injecting a
 * `canonicalize` hook (e.g. `lib/sponsor-canonicalize.canonicalizeSponsor`)
 * without coupling the core to the sponsor lookup.
 *
 * Correctness guards that make the confidence meaningful (and stop false
 * accusations):
 *  - attribution treats initials as an author only in author-ref position and
 *    requires an EXACT initials match (a bare "SAS" in "HalioDx SAS" must not
 *    read as author "AS");
 *  - delimiter-free ASCO/ICMJE multi-author blobs are sliced to the scholar's
 *    own section, and suppressed wholesale if the section can't be bounded;
 *  - co-author names, the scholar's home institution, and grant IDs are never
 *    entities; grant/research-funding clauses have no WRG analog and are dropped;
 *  - normalization is recall-biased: an entity within fuzzy range of any
 *    disclosed entity is treated as already-disclosed (suppressed).
 */

export type Tier = "High" | "Medium" | "Low";
export type Category = "personal" | "funder" | "employer";
export type AttributionLevel = "scholar" | "other" | "unattributed";

/**
 * The grammatical SUBJECT of the clause that names an organization, for the
 * redesigned review surface (#1112). This is the per-mention attribution the UI
 * highlights:
 *   - `self`     — the clause subject resolves to the scholar (their own tie);
 *   - `coauthor` — it resolves to a DIFFERENT author of this paper (roster-confirmed
 *                  or an honorific/initials author-ref that is not the scholar);
 *   - `unknown`  — no subject is resolvable (NEVER guessed `self`: a wrong
 *                  self-attribution is worse than an honest "unclear").
 *
 * Derived from the SAME author-resolution primitives `attribute` already uses
 * (`surnameRe`, `authorRefInitials`, `drSurnames`, `initialSurnameRefs`), so the
 * subject and the existing tier-driving attribution stay consistent.
 */
export type SubjectType = "self" | "coauthor" | "unknown";

/** A disclosure-relationship kind parsed from the clause's verbs/cues (advisory
 *  board, consulting, grant, …). `[]` when no kind is recognized. */
export type RelationshipKind =
  | "advisory_board"
  | "consulting"
  | "honoraria"
  | "grant"
  | "speaker_fees"
  | "royalties"
  | "ownership"
  | "dsmb"
  | "steering_committee"
  | "lecture_fees"
  | "other";

export interface Scholar {
  surname: string;
  /** Regex matching the surname as a whole word (null when surname is empty). */
  surnameRe: RegExp | null;
  /** First-initial + last-initial, uppercase, e.g. John Leonard -> "JL". */
  initials: string;
  /** Surname-first variant, e.g. "LJ". */
  initialsAlt: string;
}

export interface Attribution {
  level: AttributionLevel;
  score: number;
  reason: string;
}

export interface EntityCandidate {
  raw: string;
  score: number;
  cat: Category;
}

export interface GapCandidate {
  entity: string;
  normalized: string;
  tier: Tier;
  attribution: AttributionLevel;
  attributionReason: string;
  entityScore: number;
  category: Category;
  nearestDisclosed: string;
  nearestScore: number;
  failureModeGuess: string;
  tierReason: string;
  sourceSentence: string;
  // --- #1112 review-redesign per-mention metadata (the data layer feeds these
  // through to the client projection; the score/attribution above still never
  // cross to the client). ---
  /** Grammatical subject of the clause naming THIS org. NEVER guessed `self`
   *  when unresolvable (emits `unknown`). See {@link SubjectType}. */
  subjectType: SubjectType;
  /** The exact subject token as written ("Dr Altorki", "A Saxena", "SR"), or
   *  null when `subjectType === "unknown"`. */
  subjectMention: string | null;
  /** The organization as printed in the clause (`EntityCandidate.raw`), kept for
   *  display fidelity inside the trimmed clause; `entity` is the same raw value
   *  today, `normalized` is the deduped/canonical key. */
  organizationRaw: string;
  /** Trimmed span for the Organization-view row: subject token (if present) +
   *  the matched org + ~6 words of connective context, eliding with "…". The
   *  full statement stays available in `sourceSentence`. */
  clause: string;
  /** Disclosure kinds parsed from the clause (advisory_board, grant, …); `[]`
   *  when none recognized. */
  relationshipKinds: RelationshipKind[];
}

export interface AnalyzeOptions {
  /** Optional canonicalizer (e.g. canonicalizeSponsor). When both an extracted
   *  entity and a disclosed entity canonicalize to the same non-null short name,
   *  they are treated as an exact match. */
  canonicalize?: (s: string) => string | null;
  /** Fuzzy score at/above which an entity is treated as already-disclosed. */
  nearDisclosedThreshold?: number;
  /** DIAGNOSTIC ONLY (default false). When true, the result `candidates` also
   *  include the suppressed `Low` entities (matched-as-disclosed, co-author, or
   *  non-personal) — each carrying its `nearestDisclosed` / `tierReason` so the
   *  offline export can study what we matched and why. The production paths
   *  (`computeScholarGaps`) never set this and still see only High/Medium. */
  includeSuppressed?: boolean;
  /** This paper's author byline, parsed to surname → first-initials (see
   *  `buildAuthorRoster`). When present, a person-shaped entity that matches a
   *  co-author of THIS paper is suppressed as a co-author name bled through
   *  extraction (see `matchesCoAuthor`). Omitted ⇒ the cross-check is skipped and
   *  behaviour is unchanged. */
  roster?: AuthorRoster;
}

export interface StatementResult {
  /** Surfaced candidates (High + Medium), deduped per normalized entity within
   *  this statement, highest tier kept. */
  candidates: GapCandidate[];
  /** Counts of entities suppressed (Low) by reason — for offline metrics. */
  suppressed: {
    coauthor: number;
    nearDisclosed: number;
    funderEmployer: number;
    multiAuthor: number;
    /** Extracted phrase was a bare junk/boilerplate word, not an org. */
    junkEntity: number;
    /** Person-shaped phrase that matched a co-author on this paper's byline
     *  (`opts.roster` cross-check) — a co-author name bled through extraction. */
    coauthorRoster: number;
  };
  /** True when the statement was a structured multi-author blob naming the
   *  scholar but whose section could not be cleanly bounded (whole blob dropped). */
  unparsedStructured: boolean;
  /** True when the statement carried no disclosure (pure negation / boilerplate). */
  isNegation: boolean;
}

const DEFAULT_NEAR_DISCLOSED = 0.6;

// --------------------------- negation / segmentation ---------------------------

const NEG_PHRASE =
  /\b(no(ne)?|not|nothing|without)\b[^.;]*?\b(competing|conflict|conflicts|interest|interests|disclos\w*|relevant financial|financial relationship|to declare|to disclose|to report)\b/gi;
const NEG_SIMPLE =
  /\b(the authors? (have|has|declare|report)?\s*(no|none|nothing)|nothing to (disclose|declare|report)|no (competing|conflict|relevant|financial|potential)\b[^.;]*?(interest|relationship|disclos)\w*|declares? (no|none)|none (declared|to declare|reported))/gi;

/** A statement is pure boilerplate (no disclosure) if almost nothing of
 *  substance remains after stripping negation/none phrases. */
export function isPureNegation(text: string): boolean {
  if (!text || !text.trim()) return true;
  let t = text.replace(NEG_PHRASE, " ").replace(NEG_SIMPLE, " ");
  t = t.replace(
    /\b(competing|conflict|conflicts|of|interest|interests|disclosure|disclosures|disclose|declared|declare|financial|the|authors?|author|all|other|relevant|potential|report|reported|reports|have|has|was|were|is|are|and|to|a|an|in|on|with|statement|coi|none|no|not|nothing|this|study|work|paper|manuscript|article|research)\b/gi,
    " ",
  );
  t = t.replace(/[^A-Za-z]+/g, " ").trim();
  const toks = t.split(/\s+/).filter((w) => w.length > 2);
  return toks.length < 2;
}

/** Clean common double-encoded UTF-8 mojibake + curly punctuation. */
export function cleanText(s: string): string {
  return String(s ?? "")
    .replace(/‚Äô|’|`/g, "'")
    .replace(/‚Äú|‚Äù|“|”/g, '"')
    .replace(/‚Äì|‚Äî|–|—/g, "-")
    .replace(/Â|�/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a statement into clause-level units, protecting abbreviations/initials. */
export function segment(text: string): string[] {
  let t = " " + text.replace(/\s+/g, " ").trim() + " ";
  t = t.replace(/\b(Dr|Drs|Mr|Ms|Mrs|Prof|Inc|Ltd|Co|Corp|Mt|St|vs|U\.S|U\.K|Ph\.D|M\.D|Jr|Sr)\./gi, (m) =>
    m.replace(".", ""),
  );
  t = t.replace(/\b([A-Z])\.(?=\s?[A-Z][.\s])/g, "$1");
  t = t.replace(/\b([A-Z])\.(?=\s[A-Z][a-z])/g, "$1");
  const parts = t.split(/[.;]\s+|\s+[•·]\s+/);
  return parts.map((s) => s.replace(/\x00/g, ".").trim()).filter((s) => s.length > 0);
}

// ------------------------------- attribution -------------------------------

export function deriveScholar(first: string | null | undefined, last: string | null | undefined): Scholar {
  const fi = (first ?? "").trim()[0] ?? "";
  const li = (last ?? "").trim()[0] ?? "";
  const surname = (last ?? "").trim();
  return {
    surname,
    surnameRe: surname ? new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null,
    initials: (fi + li).toUpperCase(),
    initialsAlt: (li + fi).toUpperCase(),
  };
}

const REPORTING_VERB =
  "(?:has|have|is|are|was|were|reports?|reported|receives?|received|serves?|served|declares?|disclos\\w+|owns?|holds?|consults?|sits?|acts?)";

/** Author-reference initials groups in author-ref position only: at clause start
 *  or immediately before a reporting verb. */
export function authorRefInitials(clause: string): string[] {
  const out = new Set<string>();
  const head = clause.match(/^\s*(?:Drs?\.?\s+|Prof\.?\s+)?([A-Z]\.?\s?){2,4}\b/);
  if (head) {
    const letters = head[0].replace(/[^A-Z]/g, "");
    if (letters.length >= 2 && letters.length <= 4) out.add(letters);
  }
  const re = new RegExp(`\\b([A-Z]\\.?\\s?){2,4}\\s+${REPORTING_VERB}\\b`, "g");
  let g: RegExpExecArray | null;
  while ((g = re.exec(clause))) {
    const letters = g[0].replace(new RegExp(`\\s+${REPORTING_VERB}\\b.*$`), "").replace(/[^A-Z]/g, "");
    if (letters.length >= 2 && letters.length <= 4) out.add(letters);
  }
  return [...out];
}

/** "Dr <Surname>" / "Dr R.B. Kumar" -> the referenced surname. */
export function drSurnames(clause: string): string[] {
  const out: string[] = [];
  const re = /\bDrs?\.?\s+(?:[A-Z]\.?\s*){0,3}([A-Z][a-z]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause))) out.push(m[1]);
  return out;
}

/** Author subjects written as a SINGLE first-initial + surname with NO honorific —
 *  "A.Ashworth", "A. Ashworth" (de-dotted by `segment` to "A Ashworth"), "C Lehman"
 *  — in author-ref position (clause start or immediately before a reporting verb).
 *  Returns `{ initial, surname }` pairs.
 *
 *  These read as `unattributed` today (`authorRefInitials` needs ≥2 initials,
 *  `drSurnames` needs an honorific), so a co-author disclosing this way ("A.Ashworth
 *  is a cofounder of Tango Therapeutics") leaks their org onto every co-author — the
 *  dominant surviving false positive. The caller (`attribute`) confirms each pair
 *  against the paper's byline before trusting it, so a company initial-name ("B.
 *  Braun", "C. R. Bard") that is not actually an author is never read as one. */
export function initialSurnameRefs(clause: string): Array<{ initial: string; surname: string }> {
  const out: Array<{ initial: string; surname: string }> = [];
  const seen = new Set<string>();
  const push = (initial: string, surname: string): void => {
    const key = `${initial}:${surname}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ initial: initial.toUpperCase(), surname });
  };
  const NAME = "([A-Z])\\.?\\s*([A-Z][a-z]{2,}(?:[-'’][A-Z][a-z]+)?)";
  // Clause start: "A.Ashworth …", "C Lehman …".
  const head = clause.match(new RegExp(`^\\s*${NAME}\\b`));
  if (head) push(head[1], head[2]);
  // Anywhere immediately before a reporting verb: "… C Lehman is a consultant …".
  const re = new RegExp(`\\b${NAME}\\s+${REPORTING_VERB}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause))) push(m[1], m[2]);
  return out;
}

export function attribute(clause: string, scholar: Scholar, roster?: AuthorRoster): Attribution {
  const surnameHit = !!(scholar.surnameRe && scholar.surnameRe.test(clause));
  const refs = authorRefInitials(clause);
  const drs = drSurnames(clause);
  const scholarInit = refs.some((g) => g === scholar.initials || g === scholar.initialsAlt);
  const drScholar = drs.some((s) => s.toLowerCase() === scholar.surname.toLowerCase());
  const otherInit = refs.some((g) => g !== scholar.initials && g !== scholar.initialsAlt);
  const drOther = drs.some((s) => s.toLowerCase() !== scholar.surname.toLowerCase());

  // First-initial + surname author subjects with no honorific ("A.Ashworth",
  // "C Lehman"), CONFIRMED against the paper's byline so a company initial-name
  // ("B. Braun", "C. R. Bard") is never misread as an author. A confirmed co-author
  // (surname ≠ the scholar) marks the clause as another author's — the fix for the
  // dominant residual where such a clause read as `unattributed` and the co-author's
  // org leaked onto every co-author. Requires the byline: with no roster the form is
  // ignored (unchanged behaviour). The scholar's own surname is already caught by
  // `surnameHit`, so only the "other author" signal is new here.
  const initSurn = roster && roster.size > 0 ? initialSurnameRefs(clause) : [];
  const otherInitSurn = initSurn.some(
    (r) =>
      bareSurname(r.surname) !== bareSurname(scholar.surname) &&
      !!roster!.get(bareSurname(r.surname))?.has(r.initial),
  );

  const otherRef = otherInit || drOther || otherInitSurn;
  const scholarRef = surnameHit || scholarInit || drScholar;
  const allAuthors = /\b(the |all )?authors?\b/i.test(clause) && !scholarRef && !otherRef;

  if (scholarRef && otherRef)
    return { level: "scholar", score: 0.55, reason: "scholar named alongside another author — ambiguous" };
  if (surnameHit || drScholar) return { level: "scholar", score: 0.9, reason: `surname "${scholar.surname}" in clause` };
  if (scholarInit) return { level: "scholar", score: 0.75, reason: `initials ${scholar.initials} match (author-ref position)` };
  if (otherRef) {
    const named = refs.join(",") || drs.join(",") || initSurn.map((r) => `${r.initial} ${r.surname}`).join(",");
    return { level: "other", score: 0.85, reason: `names other author (${named})` };
  }
  if (allAuthors) return { level: "unattributed", score: 0.45, reason: '"the authors" — collective' };
  return { level: "unattributed", score: 0.5, reason: "no author named in clause" };
}

// ------------------------- subject attribution (#1112) -------------------------

/**
 * Resolve the GRAMMATICAL SUBJECT of a clause for the review-redesign surface:
 * who, in this clause, holds the named relationship.
 *
 * Heuristic (two sentences): reuse the SAME author-reference primitives
 * `attribute` uses — the scholar's surname / author-ref initials / "Dr <surname>"
 * / no-honorific first-initial+surname (roster-confirmed) — and return the FIRST
 * such reference in clause order as the subject token, typed `self` if it is the
 * scholar and `coauthor` if it is a different author; when NO author reference is
 * found we return `unknown` with a null token rather than guessing `self`,
 * because a wrong self-attribution is worse than an honest "unclear".
 *
 * This is intentionally consistent with `attribute` (it consumes the same
 * signals) but is a SEPARATE concern: `attribute` decides the tier-driving
 * attribution LEVEL (and is roster-gated to avoid suppressing the scholar's own
 * tie), whereas this returns the exact display token + a self/coauthor/unknown
 * label for the UI mark. `self`/`coauthor` here therefore track `attribute`'s
 * scholar/other, and an `unattributed` clause maps to `unknown`.
 */
export function deriveSubject(
  clause: string,
  scholar: Scholar,
  roster?: AuthorRoster,
): { type: SubjectType; mention: string | null } {
  // Each candidate subject reference, tagged with its position in the clause so
  // we can pick the FIRST (the grammatical subject normally leads the clause).
  type Ref = { index: number; mention: string; isScholar: boolean };
  const refs: Ref[] = [];
  const indexOf = (needle: string): number => {
    const i = clause.indexOf(needle);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };

  // 1. "Dr <Surname>" / "Drs <Surname>" — honorific + surname (group 1 = surname).
  {
    const re = /\bDrs?\.?\s+(?:[A-Z]\.?\s*){0,3}([A-Z][a-z]{2,})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clause))) {
      refs.push({
        index: m.index,
        mention: m[0].trim(),
        isScholar: m[1].toLowerCase() === scholar.surname.toLowerCase(),
      });
    }
  }

  // 2. The scholar's bare surname ("Altorki reports …" / "… for Altorki"), only
  //    when not already captured by a "Dr <Surname>" hit above.
  if (scholar.surnameRe) {
    const sm = clause.match(scholar.surnameRe);
    if (sm && sm.index != null) {
      const already = refs.some((r) => r.mention.toLowerCase().includes(scholar.surname.toLowerCase()));
      if (!already) refs.push({ index: sm.index, mention: sm[0], isScholar: true });
    }
  }

  // 3. Author-ref initials groups ("A.P.:", "SMM has …", "SR declared …").
  for (const letters of authorRefInitials(clause)) {
    const isScholar = letters === scholar.initials || letters === scholar.initialsAlt;
    // Recover the printed token (spacing/dots vary) by scanning for the letters
    // in author-ref position; fall back to the bare letters.
    const tok = findInitialsToken(clause, letters) ?? letters;
    refs.push({ index: indexOf(tok), mention: tok, isScholar });
  }

  // 4. No-honorific first-initial + surname ("A Saxena", "C Lehman"). Only trust
  //    the co-author form when the byline CONFIRMS it (mirrors `attribute`); the
  //    scholar's own surname is already covered by (2).
  const initSurn = roster && roster.size > 0 ? initialSurnameRefs(clause) : [];
  for (const r of initSurn) {
    const isScholar = bareSurname(r.surname) === bareSurname(scholar.surname);
    const confirmedCo = !!roster!.get(bareSurname(r.surname))?.has(r.initial);
    if (!isScholar && !confirmedCo) continue; // unconfirmed → not a trusted subject
    const tok = findInitialSurnameToken(clause, r.initial, r.surname) ?? `${r.initial} ${r.surname}`;
    refs.push({ index: indexOf(tok), mention: tok, isScholar });
  }

  if (refs.length === 0) return { type: "unknown", mention: null };

  // The grammatical subject is the EARLIEST author reference in the clause.
  refs.sort((a, b) => a.index - b.index);
  // Prefer the scholar when they and a co-author share the earliest position
  // band — `attribute` already treats "scholar named alongside another author" as
  // the scholar's; mirror that so the mark is calm (self) not alarming (coauthor).
  const first = refs[0];
  const scholarAtFront = refs.find((r) => r.isScholar && r.index <= first.index);
  const chosen = scholarAtFront ?? first;
  return { type: chosen.isScholar ? "self" : "coauthor", mention: chosen.mention };
}

/** Recover the printed initials token for a letters group ("AP" → "A.P." / "A P")
 *  at clause start or before a reporting verb, so the UI shows what was written. */
function findInitialsToken(clause: string, letters: string): string | null {
  // Build a tolerant pattern: each letter, optional dot, optional space.
  const pat = letters
    .split("")
    .map((c) => `${c}\\.?\\s?`)
    .join("");
  const head = clause.match(new RegExp(`^\\s*(?:Drs?\\.?\\s+|Prof\\.?\\s+)?(${pat})`));
  if (head) return head[1].trim();
  const verb = clause.match(new RegExp(`\\b(${pat})\\s+${REPORTING_VERB}\\b`));
  if (verb) return verb[1].trim();
  return null;
}

/** Recover the printed "A Saxena" / "A.Saxena" token for an initial+surname ref. */
function findInitialSurnameToken(clause: string, initial: string, surname: string): string | null {
  const re = new RegExp(`\\b${initial}\\.?\\s*${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const m = clause.match(re);
  return m ? m[0].trim() : null;
}

// --------------------- relationship-kind parsing (#1112) ---------------------

/** Ordered cue → relationship-kind table. First-match-per-kind; a clause can
 *  carry several kinds ("advisory board and consulting fees"). Patterns are
 *  deliberately specific so a generic "fees" alone does not mint a kind. */
const RELATIONSHIP_CUES: ReadonlyArray<{ kind: RelationshipKind; re: RegExp }> = [
  { kind: "advisory_board", re: /\b(advisory board|scientific advisory|advisor[y]?\b|advisory committee)\b/i },
  { kind: "consulting", re: /\b(consult(?:ant|ing|s)?|consultancy)\b/i },
  { kind: "steering_committee", re: /\b(steering committee)\b/i },
  { kind: "dsmb", re: /\b(data (?:and )?safety monitoring|dsmb|data monitoring committee|\bdmc\b)\b/i },
  { kind: "speaker_fees", re: /\b(speaker(?:s'?)?(?: bureau| fees?| honoraria)?|speakers'? bureau)\b/i },
  { kind: "lecture_fees", re: /\b(lecture fees?|lecture honorari\w+|payment for lectures)\b/i },
  { kind: "honoraria", re: /\b(honorari\w+)\b/i },
  { kind: "royalties", re: /\b(royalt\w+|licens\w+|patent\w*)\b/i },
  { kind: "ownership", re: /\b(equity|stock|shares?|shareholder|ownership|owns?\b|co-?founder|founder|holds? equity)\b/i },
  { kind: "grant", re: /\b(research (?:support|funding|grant)s?|grants?(?: from| support| funding)?|grant (?:support|funding)|funded by|research funding)\b/i },
];

/** Parse the disclosure kinds named in a clause. `[]` when none recognized
 *  (e.g. "has a relationship with X"). Order is the cue-table order, deduped. */
export function relationshipKinds(clause: string): RelationshipKind[] {
  const out: RelationshipKind[] = [];
  for (const { kind, re } of RELATIONSHIP_CUES) {
    if (re.test(clause) && !out.includes(kind)) out.push(kind);
  }
  return out;
}

// ------------------------------ clause trimming (#1112) ------------------------------

/** Trim a clause to the smallest span containing the subject token (when present)
 *  and the matched org, plus ~`context` words on each side, eliding the rest with
 *  "…". When the subject is far from the org, render `subject … org-clause`. The
 *  full statement stays available via `sourceSentence`. Organization-view only;
 *  Paper view uses `fullText` verbatim. */
export function trimClause(
  clause: string,
  organizationRaw: string,
  subjectMention: string | null,
  context = 6,
): string {
  const full = clause.trim();
  if (!full) return "";
  const words = full.split(/\s+/);
  if (words.length <= context * 3) return full; // short enough — show whole clause

  // Locate a needle as a WORD range, tolerant of trivial punctuation/spacing
  // differences (the subject token can arrive de-dotted — "Dr Smith" — while the
  // source clause still carries "Dr. Smith,"). Compares on a punctuation-stripped
  // lowercase form of each word.
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wordsNorm = words.map(norm);
  const findRange = (needle: string | null): [number, number] | null => {
    if (!needle) return null;
    const needleWords = needle.trim().split(/\s+/).map(norm).filter(Boolean);
    if (needleWords.length === 0) return null;
    for (let i = 0; i + needleWords.length <= wordsNorm.length; i++) {
      let ok = true;
      for (let j = 0; j < needleWords.length; j++) {
        if (wordsNorm[i + j] !== needleWords[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return [i, i + needleWords.length - 1];
    }
    return null;
  };

  const orgRange = findRange(organizationRaw);
  const subjRange = findRange(subjectMention);
  if (!orgRange) return full; // can't locate the org → don't risk dropping it

  // Window around the org, plus the subject if it's nearby; if the subject is far,
  // emit a separate leading subject window joined by "…".
  const segments: Array<[number, number]> = [];
  const orgWin: [number, number] = [Math.max(0, orgRange[0] - context), Math.min(words.length - 1, orgRange[1] + context)];

  if (subjRange) {
    const subjWin: [number, number] = [
      Math.max(0, subjRange[0] - 1),
      Math.min(words.length - 1, subjRange[1] + 1),
    ];
    if (subjWin[1] + 1 >= orgWin[0]) {
      // Overlapping / adjacent → one merged window from subject to org.
      segments.push([Math.min(subjWin[0], orgWin[0]), Math.max(subjWin[1], orgWin[1])]);
    } else {
      segments.push(subjWin, orgWin); // disjoint → "subject … org-clause"
    }
  } else {
    segments.push(orgWin);
  }

  const parts: string[] = [];
  if (segments[0][0] > 0) parts.push("…");
  segments.forEach((seg, i) => {
    if (i > 0) parts.push("…");
    parts.push(words.slice(seg[0], seg[1] + 1).join(" "));
  });
  if (segments[segments.length - 1][1] < words.length - 1) parts.push("…");
  return parts.join(" ").replace(/\s+…\s+/g, " … ").trim();
}

// ------------------------------- extraction -------------------------------

const GAZETTEER = [
  "Pfizer","Merck","Novartis","Genentech","Roche","AbbVie","Bristol-Myers Squibb","Bristol Myers Squibb",
  "Boston Scientific","Medtronic","Gilead","Amgen","Janssen","Johnson & Johnson","Bayer","Novo Nordisk",
  "AstraZeneca","GlaxoSmithKline","GSK","Sanofi","Eli Lilly","Lilly","Regeneron","Biogen","Vertex","Takeda",
  "Celgene","Abbott","Stryker","Edwards Lifesciences","Acerta","Pharmacyclics","Sunesis","Verastem","Gelesis",
  "Vivus","Preventice","Jansen","Jazz Pharmaceuticals","Incyte","Seattle Genetics","Seagen","BeiGene","Kite",
  "Karyopharm","MorphoSys","Epizyme","ADC Therapeutics","Genmab","TG Therapeutics","Alexion","Ionis","Moderna",
  "BioNTech","Daiichi Sankyo","Exelixis","Blueprint Medicines","Mirati","Deciphera","Servier","UCB","Grifols",
  "CSL Behring","Octapharma","Shire","Alnylam","Sarepta","Ultragenyx","BioMarin","Intuitive Surgical","Olympus",
  "Cook Medical","Baxter","Becton Dickinson","Siemens","Philips","GE Healthcare","UpToDate","Elsevier","Wolters Kluwer",
  "Chromadex","ChromaDex","Mannkind","NuRevelation","Critica","Broadview Ventures","Vaniam Group","Optum",
];
const GAZ: ReadonlyArray<{ name: string; re: RegExp }> = GAZETTEER.map((n) => ({
  name: n,
  re: new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
}));

/** Does the phrase match a known gazetteer organization? Such a phrase is never
 *  a person or junk, even when it reads like a name ("Eli Lilly", "Boston
 *  Scientific") — so this is the precision backstop for the person/junk guards. */
function isGazetteerOrg(p: string): boolean {
  return GAZ.some((g) => g.re.test(p));
}

// A high-precision common-given-name gate. Used to decide a bare "First Last"
// TitleCase phrase is a person (a co-author bled into extraction), NOT a company.
// PRECISION over recall by construction: a name we miss merely stays surfaced for
// a later pass, but a wrong inclusion would drop a real company — so any given
// name that also heads a real company or place (boston/edwards/forest/eli/...) is
// deliberately EXCLUDED, and a handful of surnames the source list mislabeled as
// given names (zhang/liu/...) plus the self-flagged "sun" are stripped at load.
// Stored as a space-joined string and split once for compactness.
const _GIVEN_NAMES_RAW =
  "aaron abbas abdul abdullah abhishek abraham adam adrian adriana ahmad ahmed akira alain alan albert alberto alejandro aleksandr alessandro alex alexander alexandra alexei alfredo ali alice alok amanda amir amit amy ana anand anders andre andrea andreas andrei andres andrew andrey angela anil anita anna anne annette anthony antoine antonio anubha anup arjun arnaud arun ashish ashok ashley asuka atsushi aung barbara benjamin bernard bernhard beatriz bharat bin bo bohdan boris brian bruce bruno bryan carl carla carlos carmen carol caroline catherine cesar chang chao charles cheng chiara chih ching chong chris christian christina christine christophe christopher claire claudia claudio clara craig cristina cynthia dai daisuke dan daniel daniela daniele danielle daria dario david dean deborah deepak denis dennis diana diego dieter dmitri dmitry dominik dong donald douglas duc duong edmund eduardo edward elena elias elizabeth emily emma emmanuel enrique eric erik erika ernesto esteban eugene eva evelyn fabio fabrice fang farah farhan fatima federico feng fernando filippo florence florian francesca francesco francis francisco frank franz fred frederic fumiko gabriel gabriela gang gaurav george gerald gerard gerhard giorgio giovanni giulia giuseppe gonzalo grace greg gregory guido guillaume guo gustavo haitham hai hana hans hao haruki hassan heather hector hee heidi helen helena henri henrik henry hideki hideo hiroaki hiroki hiroshi hong hossein howard hua huan hugo hui hussein ian ibrahim ignacio igor ilya ines irene isabel isabella ismail ivan jack jacob jacques jaime jakob james jamie jan jane janet janice javier jay jean jeffrey jennifer jens jeremy jeroen jerome jessica jesus jia jian jiang jianhua jianjun jianping jie jin jing jinhua joan joana joao joaquin joel johan johann johannes john jon jonas jonathan jorge jose josef joseph josephine joshua juan judith judy julia julian juliana julie julien julio jun jung junichi junko jurgen justin kai kamal kaori karen karim karl kate katherine kathleen kathryn katsuhiko kazuhiko kazuo kei keiko keith ken kenji kenneth kentaro kevin khaled kim kiran klaus kohei koji konstantin krishna kristina kumar kunal kurt kyle kyoko lai lakshmi lars laura laurent lawrence lei leo leon leonardo leonid liang lijun lin linda ling lisa lorenzo louis luc luca lucas lucia luciano ludwig luigi luis luka lukas lydia maciej magnus mahmoud mai makoto mamta manabu manfred manish manoj manuel marc marcel marcelo marcin marco marcos marcus margaret maria mariana marie marina mario marion mariusz mark markus marta martin martina masaaki masahiro masaki masako masao masashi masato massimo mateusz mathias mathieu matteo matthew matthias maurizio mauro maxim maximilian mehmet mei melissa meng mengyu michael michel michele michiko miguel mihai mika mikael mike miki milan ming mingming minh miriam miroslav mitra mitsuru mohamed mohammad mohammed monica mustafa nada nadia nan nancy naoki naoko naoto narendra natalia natalie natasha nathan navid neha neil nicholas nick nicolas nicole niels nikhil nikolai nikos nils ning nina nora norbert norio oleg olga oliver olivier omar oscar osman pablo palak pamela paolo pascal patrick paul paula paulo pavel pedro peng peter petra philip philippe pierre ping piotr pooja prakash pranav prasad praveen preeti priya priyanka qi qian qiang qin qing rachel radhika rafael rahul raj rajeev rajesh ralf ralph ramesh ramon randy raphael rashid raul ravi raymond rebecca reiko rene renu ricardo riccardo richard rita rob robert roberto robin rodrigo roger roland rolf roman ronald rosa ruben rui ruth ryan ryo ryoichi ryuichi sabine sachin sadia saeed sageer salim salvatore sam samir samuel sandeep sandra sandro sanjay sanjeev sara sarah sashi satoshi saurabh scott sean sebastian sebastien sergei sergey sergio seung shafiq shankar sharad sharon shaun shawn sheng shiela shigeru shin shinichi shinji shiro shivani shogo shu shuang shuji shunsuke silvia simon simone smita sofia sonia soo sophia sophie srinivas stefan stefano stephan stephane stephanie stephen steven subhash sudhir sue suguru suja sujata suman sumit sunil susan susana suzanne sven swati sylvia tadashi taha tai takashi takeshi takuya tamara tania tao tarek tariq taro tatiana tatsuya ted teresa tetsuo tetsuya theodore thierry thomas tianyi tibor tim timothy tina tobias toru toshihiro toshiki toshio tracy tushar ulrich umberto ursula uwe vadim valentina valeria varun vasilios veena venkat veronica victor victoria vijay vikas viktor vincent vincenzo vinay vinod violetta vivek vladimir walter wei weidong weihua weijun weiming weiwei wen wendy wenjun wilhelm william wojciech wolfgang xiang xiao xiaodong xiaofeng xiaohong xiaohua xiaojun xiaoli xiaoming xiaoping xin xing xinyu xiulan xu xue yan yang yann yannick yasuhiro yasuo yi yian yifei yihong yijun yiming ying yinghui yixin yohei yoichi yong yongjun yoshiaki yoshihiro yoshiko yoshinori yoshio yu yuan yuanyuan yue yuhong yuichi yuji yuka yuki yukiko yuko yun yuriko yusuke yuta yutaka yuxin yvonne zachary zahra zaid zexin zhanna zhe zhen zheng zhenhua zhi zhihua zhiyong zhong zhongwei ziad ziyang zoltan vikram ingrid aisha";
const _NOT_GIVEN = new Set(["sun", "tanaka", "nguyen", "tran", "zhang", "zhao", "zhou", "zhu", "liu"]);
const GIVEN_NAMES = new Set(_GIVEN_NAMES_RAW.split(/\s+/).filter((n) => n && !_NOT_GIVEN.has(n)));

/** Token's lowercased alpha form is a recognized common given name. */
export function isCommonGivenName(tok: string): boolean {
  return GIVEN_NAMES.has(tok.toLowerCase().replace(/[^a-z]/g, ""));
}

// Domain/org words that, as the SECOND word of a two-word phrase, mark it a
// company rather than a person's surname — so "<Given> Pharmaceuticals/
// Diagnostics/Therapeutics/Institute/…" (Marius Pharmaceuticals, Helix
// Diagnostics) is never misread as a name. Broad on purpose: more org words ⇒
// fewer person classifications ⇒ higher precision (the safe direction).
const ORG_TOKEN =
  /^(inc|llc|ltd|lp|llp|plc|gmbh|co|corp|corporation|company|companies|pharmaceuticals?|pharma|biopharma|therapeutics?|biosciences?|bioscience|sciences?|science|biologics|biomedical|biotech|diagnostics?|genomics|genetics|medical|medicine|health|healthcare|surgical|laboratories|laboratory|labs|lifesciences|life|dialysis|endovascular|robotics|imaging|oncology|neuroscience|neurosciences|cardiovascular|vascular|devices?|technologies|technology|systems?|holdings|group|partners|ventures|capital|institute|institutes|foundation|fund|associates|international|industries|solutions|networks?|ag|sa|bv|nv)$/i;

/** Junk words that leak from COI boilerplate as fake single-token "entities"
 *  ("All", "Various", "Travel") — never an organization. Single token only; real
 *  coined single-word companies ("Genmab") and multi-word names are untouched. */
const JUNK_WORDS = new Set<string>([
  "all", "other", "various", "study", "studies", "during", "outside", "none", "authors", "author",
  "following", "both", "several", "these", "those", "including", "received", "receive", "personal",
  "grants", "grant", "fees", "fee", "consulting", "reports", "report", "declares", "declare", "etc",
  "data", "work", "manuscript", "ongoing", "current", "former", "relevant", "potential", "above", "below",
  // ASCO/ICMJE category words and generic quantifiers that recur in COI prose and
  // are never an organization (verified absent from any real company name).
  "travel", "salary", "lecture", "lectures", "compensation", "membership", "honoraria", "honorarium",
  "royalties", "royalty", "patents", "patent", "employment", "leadership", "expenses", "accommodations",
  "multiple", "numerous", "certain", "additional", "respectively", "namely",
]);

const PERSONAL_CUE =
  /\b(consultant|consulting|consults?|advisor[y]?|advis\w+|advisory board|scientific advisory|speaker|speakers' ?bureau|honorari\w+|equity|stock|shares?|shareholder|ownership|owns?|founder|co-?founder|board of directors|royalt\w+|licens\w+|patent|fees? from|received (?:personal )?fees|compensation from)\b/i;
const FUNDER_CUE =
  /\b(research (?:support|funding|grant)s?|grants?(?: from| support| funding)?|grant (?:support|funding)|funded by|sponsored by|supported by|support from|study sponsor|institutional (?:support|funding))\b/i;
const EMPLOYER_CUE = /\b(employee of|employed by|salary from|full-?time|works? for)\b/i;
const SUFFIX_RE =
  /\b(Inc|LLC|Ltd|LP|LLP|PLC|GmbH|Corp|Co|Pharmaceuticals?|Pharma|Therapeutics|Biosciences?|Sciences?|Technologies|Biotech|Ventures|Group|Holdings|Foundation|University|Institute|Hospital|Medical|Health|Genomics|Diagnostics)\b/i;

const ENTITY_STOP = new Set<string>([
  "the","a","an","of","and","for","from","to","in","on","with","is","are","has","have","received","serves",
  "serve","member","board","advisory","scientific","consultant","speaker","company","companies","author","authors",
  "research","support","funding","grant","grants","fees","honoraria","honorarium","equity","stock","shares","other",
  "interests","interest","competing","conflict","conflicts","disclosure","disclosures","clinical","investigator",
  "study","trial","data","drug","device","this","that","work","manuscript","relationships","relationship","reports",
  "report","outside","submitted","during","conduct","personal","institution","none","no","i","we","he","she","they",
  "bureau","speakers","role","roles","consulting","advisor","advisors","fees","fee","funds","funding","payments",
  "declaration","conflicting","declared","declare","disclosures","statement","statements","following","potential",
]);

const HOME_INSTITUTION =
  /\b(weill cornell|cornell university|cornell medic\w+|newyork[- ]?presbyterian|new york[- ]?presbyterian|\bNYP\b|memorial sloan[- ]?kettering|hospital for special surgery)\b/i;

/** A dotted-initials person form: "A. A. Sauve", "Y. Yang", "J.K. Smith". This is
 *  the ONLY person shape that production suppresses (unchanged from the original
 *  pipeline). It is applied at extraction, where the structured ASCO path still
 *  carries the dots; the prose path has its initials de-dotted by `segment`, so
 *  this fires mainly inside structured blocks. NOTE: a few initial+surname COMPANY
 *  names share this shape ("B. Braun", "C. R. Bard") — a pre-existing limitation,
 *  intentionally left unchanged here. */
export function looksLikeInitialsName(p: string): boolean {
  const t = p.trim();
  if (/^(?:[A-Z]\.\s*){1,3}[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/.test(t)) return true;
  if (/^[A-Z]\.\s+[A-Z][a-z]+$/.test(t)) return true;
  return false;
}

/** Looks like a person's name — dotted initials (see `looksLikeInitialsName`) OR a
 *  bare "First Last" / "First M. Last" gated on a recognized given name and a
 *  surname-shaped (non-org-word) second token.
 *
 *  The bare two-word form is used ONLY by the diagnostic export to SIZE co-author
 *  leakage; it is deliberately NOT suppressed in production. A bare "First Last" is
 *  structurally identical to a founder-/eponymous-named organization or foundation
 *  ("Leon Levy", "Karl Storz", "Grace Bio-Labs", "Ludwig Cancer", "Henry Schein"),
 *  and no regex signal reliably separates "John Leonard" (a co-author) from "Leon
 *  Levy" (a funder). Suppressing the class on shape ALONE would hide real conflicts,
 *  so this stays a measurement signal. The actual production fix is the per-paper
 *  author-roster cross-check (`matchesCoAuthor` + `AuthorRoster`): when the paper's
 *  byline is known, a person-shaped entity that IS a co-author is dropped, while a
 *  founder-named org ("Leon Levy") — never on the byline — stays surfaced. */
export function looksLikePersonName(p: string): boolean {
  if (looksLikeInitialsName(p)) return true;
  const t = p.trim();
  // A plausible surname: TitleCase, ending lowercase (rules out acronyms), allowing
  // apostrophe/hyphen ("O'Brien", "Al-Rashid"), and NOT a corporate/domain word.
  const surnameLike = (w: string) =>
    /^[A-Z][A-Za-z'’.-]*[a-z]$/.test(w) && !ORG_TOKEN.test(w.replace(/[^A-Za-z]/g, ""));
  const parts = t.split(/\s+/);
  if (parts.length === 2 && isCommonGivenName(parts[0]) && surnameLike(parts[1])) return true;
  if (parts.length === 3 && /^[A-Z]\.?$/.test(parts[1]) && isCommonGivenName(parts[0]) && surnameLike(parts[2]))
    return true;
  return false;
}

// ------------------------ author-roster co-author cross-check ------------------------

/** A paper's author byline parsed for the co-author cross-check: surname
 *  (lowercased, non-letters stripped) → the set of FIRST initials seen for that
 *  surname on the byline.
 *
 *  This is the precision fix the founder-org collision (`looksLikePersonName`)
 *  deferred. An extracted entity that is really a CO-AUTHOR's name in INITIAL form
 *  ("C Lehman", "A Ashworth", "Lehman C") matches the byline and is dropped. The
 *  match requires the first initial to AGREE ("C Lehman" is not dropped against an
 *  unrelated co-author "Lehman R"), and `matchesCoAuthor` deliberately ignores the
 *  bare "Given Surname" shape ("Leon Levy", "Karl Storz") because it is structurally
 *  an eponymous org. Initial-form ORGS ("B. Braun", "C. R. Bard") can still collide
 *  with a co-author, so the caller (`analyzeStatement`) only applies this on a
 *  non-scholar-attributed clause and exempts gazetteer orgs — a scholar's own
 *  disclosure is never second-guessed by the byline. */
export type AuthorRoster = Map<string, Set<string>>;

/** A trailing initials group in a surname-first byline entry: "A", "BJ", "JKL". */
const ROSTER_INITIALS_RE = /^[A-Z]{1,3}$/;

const bareSurname = (w: string): string => w.replace(/[^A-Za-z]/g, "").toLowerCase();

/** A surname-shaped token: TitleCase ending lowercase (rules out acronyms), allowing
 *  apostrophe/hyphen, ≥3 letters, and NOT a corporate/domain word. */
function isSurnameShaped(w: string): boolean {
  const t = w.replace(/\.$/, "");
  return /^[A-Z][A-Za-z'’-]*[a-z]$/.test(t) && bareSurname(t).length >= 3 && !ORG_TOKEN.test(bareSurname(t));
}

/** Build an {@link AuthorRoster} from a `Publication.fullAuthorsString` /
 *  `authorsString` byline (comma-separated, surname-first "Lastname Initials" —
 *  e.g. "Ashworth A, Lehman C, Druker BJ") or a pre-split list of such entries.
 *  Entries that are not "Lastname Initials"-shaped (group/consortium authors,
 *  initials-only) are skipped — an empty roster simply skips the cross-check. */
export function buildAuthorRoster(authors: string | ReadonlyArray<string> | null | undefined): AuthorRoster {
  const roster: AuthorRoster = new Map();
  if (!authors) return roster;
  const entries = Array.isArray(authors) ? authors : String(authors).split(/[;,]/);
  for (const raw of entries) {
    const entry = String(raw)
      // The `authorsString` fallback wraps WCM authors in `((…))` markers (see
      // word-bibliography.ts / topics.ts). Strip the markers FIRST — a lazy
      // `\(.*?\)` would eat "((Lehman C)" and lose the surname — then drop any
      // remaining single-paren affiliation groups.
      .replace(/\(\(|\)\)/g, " ")
      .replace(/\(.*?\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const toks = entry.split(" ").filter(Boolean);
    if (toks.length < 2) continue; // need at least surname + initials
    const last = toks[toks.length - 1].replace(/\./g, "");
    if (!ROSTER_INITIALS_RE.test(last)) continue; // not surname-first "Lastname Initials"
    const surname = bareSurname(toks.slice(0, -1).join(""));
    if (surname.length < 3) continue;
    let set = roster.get(surname);
    if (!set) roster.set(surname, (set = new Set()));
    set.add(last[0].toUpperCase());
  }
  return roster;
}

/** Does the extracted entity look like one of THIS paper's co-authors — a person
 *  name bled through extraction? **Initial-form names only** ("C Lehman", "Lehman C",
 *  "A B Lehman"): an explicit initial token plus a byline-confirmed surname. A bare
 *  "Given Surname" ("Carl Zeiss", "Leon Levy", "John Leonard") is DELIBERATELY not
 *  matched, even when the leading word is a common given name — because that shape is
 *  structurally identical to a founder-/eponymous-named org, and an org whose surname
 *  coincidentally matches a co-author + first-initial would otherwise be wrongly
 *  dropped. Initial-form orgs ("B. Braun", "C. R. Bard") can still collide, so the
 *  caller additionally never applies this on a SCHOLAR-attributed clause and exempts
 *  gazetteer orgs. 2–3 name tokens only; no corporate/domain word. */
export function matchesCoAuthor(entity: string, roster: AuthorRoster): boolean {
  if (roster.size === 0) return false;
  const toks = entity.trim().split(/\s+/).filter(Boolean);
  if (toks.length < 2 || toks.length > 3) return false;
  // Any corporate/domain word ⇒ an org, not a person.
  if (toks.some((w) => ORG_TOKEN.test(bareSurname(w))) || SUFFIX_RE.test(entity)) return false;

  const isInitial = (w: string): boolean => /^[A-Z]\.?$/.test(w);
  const onByline = (surnameTok: string, initialTok: string): boolean =>
    isSurnameShaped(surnameTok) && !!roster.get(bareSurname(surnameTok))?.has(initialTok[0].toUpperCase());

  if (toks.length === 2) {
    const [a, b] = toks;
    // "C Lehman" (initial + surname) — the de-dotted prose / "A.Ashworth" form.
    if (isInitial(a) && onByline(b, a)) return true;
    // "Lehman C" (surname + initial) — surname-first byline form.
    if (isInitial(b) && onByline(a, b)) return true;
    return false;
  }
  // 3 tokens: "A B Lehman" / "A. B. Lehman" — leading initial + trailing surname.
  const [a, , c] = toks;
  return isInitial(a) && onByline(c, a);
}

/** A bare single common/boilerplate word that leaked as a fake entity ("All",
 *  "Various", "Travel") — never an organization. Single token only; real
 *  multi-word and coined-single-word company names are untouched.
 *
 *  Single-token-ness is checked on the RAW phrase, BEFORE any corporate-suffix
 *  stripping. `normalizeEntity` strips `CORP_SUFFIX` ("pharma", "ventures", …), so
 *  normalizing first would collapse a real two-word company like "Royalty Pharma"
 *  or "Additional Ventures" to the bare token "royalty" / "additional" and wrongly
 *  suppress it. A multi-word phrase is therefore never junk. */
export function looksLikeJunkEntity(p: string): boolean {
  const raw = String(p ?? "").trim();
  if (!raw || /\s/.test(raw)) return false; // multi-word ⇒ never junk
  const tok = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return tok.length > 0 && JUNK_WORDS.has(tok);
}

/** A grant/award identifier, never an org entity (e.g. K23 HL140199, R01CA123456). */
export function looksLikeGrantId(p: string): boolean {
  const t = p.trim();
  if (/\b[A-Z]\d{2}\b/.test(t)) return true; // space-delimited activity code: "K23 HL140199"
  if (/\b[A-Z]\d{2}[A-Z]{0,3}\d{2,}/.test(t)) return true; // concatenated NIH grant: "R01CA123456"
  if (/^[A-Z]{1,3}\s?\d{3,}/.test(t)) return true; // serial: "HL140199"
  if (/\bgrant\b/i.test(t) && /\d/.test(t)) return true;
  return false;
}

/** Capture proper-noun org phrases from a clause, split on list connectors. */
export function captureProperNouns(clause: string): string[] {
  const out: string[] = [];
  const tokens = clause.split(/\s+/);
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) {
      let phrase = cur.join(" ").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9)]+$/g, "").trim();
      const words = phrase.split(/\s+/).filter(Boolean);
      while (words.length && ENTITY_STOP.has(words[0].toLowerCase().replace(/[^a-z]/gi, ""))) words.shift();
      while (words.length && ENTITY_STOP.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/gi, ""))) words.pop();
      phrase = words.join(" ");
      if (phrase && /[A-Za-z]{2,}/.test(phrase) && !/^[A-Z]\.?[A-Z]?\.?$/.test(phrase)) out.push(phrase);
      cur = [];
    }
  };
  for (const raw of tokens) {
    const t = raw.replace(/[,;:]+$/, "");
    const connector = /^(and|&|\/|,)$/i.test(t);
    const cap = /^[A-Z]/.test(t) || /^[A-Z0-9].*[A-Z]/.test(t);
    const joinWord = /^(of|the|for|de|von|van)$/i.test(t) && cur.length > 0;
    if (connector) {
      flush();
      continue;
    }
    if (cap || joinWord || /^[A-Z]/.test(raw)) {
      cur.push(t);
      if (/[,;]$/.test(raw)) flush();
    } else {
      flush();
    }
  }
  flush();
  return out;
}

export function extractEntities(clause: string): EntityCandidate[] {
  const personal = PERSONAL_CUE.test(clause);
  const funder = FUNDER_CUE.test(clause);
  const employer = EMPLOYER_CUE.test(clause);
  // Category is decided by the clause's cue context and applied to ALL entities
  // in the clause, gazetteer hits included — so "research support from <Co>"
  // classifies <Co> as funder (no WRG analog) even when <Co> is a known pharma
  // name. Personal cues win when present; a gazetteer-only mention with no cue
  // defaults to personal.
  const clauseCat: Category = funder && !personal ? "funder" : employer && !personal ? "employer" : "personal";
  const found = new Map<string, EntityCandidate>();
  const upsert = (raw: string, score: number) => {
    const prev = found.get(raw);
    found.set(raw, { raw, score: prev ? Math.max(prev.score, score) : score, cat: clauseCat });
  };
  for (const g of GAZ) if (g.re.test(clause)) upsert(g.name, 0.9);
  if (personal || funder || employer) {
    for (const p of captureProperNouns(clause)) {
      // Dotted-initials person names, the home institution, and grant ids are
      // never entities (unchanged). Bare/initial "First Last" co-author names are
      // NOT dropped here — extraction has no paper context. They are dropped later
      // in `analyzeStatement` by the author-roster cross-check (which can tell a
      // co-author from a founder-named org), and sized by the diagnostic.
      if (looksLikeInitialsName(p) || HOME_INSTITUTION.test(p) || looksLikeGrantId(p)) continue;
      const words = p.split(/\s+/).length;
      const hasSuffix = SUFFIX_RE.test(p);
      const score = words >= 2 || hasSuffix ? 0.7 : 0.5;
      upsert(p, score);
    }
  }
  return [...found.values()];
}

// ------------------------------ normalization ------------------------------

const CORP_SUFFIX =
  /\b(inc|llc|ltd|lp|llp|plc|gmbh|co|corp|corporation|company|pharmaceuticals?|pharma|therapeutics|biosciences?|sciences?|science|technologies|technology|biotech|ag|sa|bv|nv|holdings|group|intl|international|ventures|partners)\b/g;

export function normalizeEntity(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(CORP_SUFFIX, " ")
    .replace(/^\s*the\s+/, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): Set<string> {
  return new Set(normalizeEntity(s).split(" ").filter((w) => w.length > 1));
}

export function fuzzyScore(a: string, b: string): number {
  const na = normalizeEntity(a);
  const nb = normalizeEntity(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = tokenize(a);
  const B = tokenize(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  const jacc = inter / union;
  const contain = inter / Math.min(A.size, B.size);
  return Math.max(jacc, contain * 0.95);
}

export function nearestDisclosed(
  entity: string,
  disclosedEntities: ReadonlyArray<string>,
  canonicalize?: (s: string) => string | null,
): { score: number; entity: string } {
  let best = { score: 0, entity: "" };
  const ec = canonicalize ? canonicalize(entity) : null;
  for (const d of disclosedEntities) {
    let s = fuzzyScore(entity, d);
    if (ec && canonicalize) {
      const dc = canonicalize(d);
      if (dc && dc === ec) s = 1;
    }
    if (s > best.score) best = { score: s, entity: d };
  }
  return best;
}

// --------------------------- structured ASCO blobs ---------------------------

const CAT_ALT =
  "Honoraria|Consulting or Advisory Role|Advisory Role|Research Funding|Speakers?'?s? Bureau|Stock and Other Ownership Interests|Stock and Other Ownership|Ownership Interests|Employment|Expert Testimony|Patents, Royalties, Other Intellectual Property|Patents, Royalties|Leadership|Travel, Accommodations, Expenses|Other Relationship";
const CAT_COLON = new RegExp(`\\b(?:${CAT_ALT})\\s*:`, "g");
const NAME_HEADER = new RegExp(
  `\\b([A-Z][a-z]+(?:\\s+[A-Z]\\.?)?(?:\\s+(?:van|von|de|del|della|di|la))?\\s+[A-Z][a-z]+)\\s+(?=(?:${CAT_ALT})\\s*:)`,
  "g",
);

export function isStructured(stmt: string): boolean {
  const m = stmt.match(CAT_COLON);
  return !!m && m.length >= 3;
}

const NOT_A_NAME_LEADER = new Set<string>([
  "american","national","other","research","memorial","foundation","university","institute","society",
  "center","clinical","personal","travel","patents","stock","consulting","honoraria","employment","royalties",
  "ownership","leadership","expert","accommodations","expenses","new","the","board","scientific","advisory",
  "international","european","college","association","department","medical","health","cancer","oncology","school",
]);

/** The scholar's own section text, or null if it can't be cleanly bounded. */
export function scholarSlice(stmt: string, scholar: Scholar): string | null {
  if (!scholar.surnameRe) return null;
  const headers: Array<{ name: string; index: number }> = [];
  let m: RegExpExecArray | null;
  NAME_HEADER.lastIndex = 0;
  while ((m = NAME_HEADER.exec(stmt))) {
    const lead = m[1].trim().split(/\s+/)[0].toLowerCase();
    if (NOT_A_NAME_LEADER.has(lead)) continue;
    headers.push({ name: m[1], index: m.index });
  }
  if (!headers.length) return null;
  const si = headers.findIndex((h) => scholar.surnameRe!.test(h.name));
  if (si === -1) return null;
  const start = headers[si].index;
  const end = si + 1 < headers.length ? headers[si + 1].index : stmt.length;
  return stmt.slice(start, end);
}

function catClass(catName: string): Category {
  if (/research funding|grant/i.test(catName)) return "funder";
  if (/employment/i.test(catName)) return "employer";
  return "personal";
}

function splitOrgs(text: string): string[] {
  return text
    .replace(/\((?:Inst|I)\)/gi, " ")
    .split(/,| and | & |\//i)
    .map((s) => s.replace(/[^A-Za-z0-9 .&'-]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

interface Unit {
  attribution: Attribution;
  entities: EntityCandidate[];
  source: string;
  /** #1112 — grammatical subject of this unit's clause (self/coauthor/unknown)
   *  + the exact printed token, for the per-mention review mark. */
  subject: { type: SubjectType; mention: string | null };
}

/** Turn the scholar's structured section into attributed entity units. */
export function structuredEntities(slice: string, scholar: Scholar): Unit[] {
  const units: Unit[] = [];
  // The slice begins with the scholar's own name header (scholarSlice bounds it),
  // so the structured section's subject is ALWAYS the scholar. Use the printed
  // header text as the subject token when present, else the bare surname.
  const headerMatch = slice.match(/^\s*([A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+(?:van|von|de|del|della|di|la))?\s+[A-Z][a-z]+)/);
  const subjectMention = headerMatch ? headerMatch[1].trim() : scholar.surname || null;
  const subject: { type: SubjectType; mention: string | null } = { type: "self", mention: subjectMention };
  const re = new RegExp(`\\b(${CAT_ALT})\\s*:\\s*([^]*?)(?=\\b(?:${CAT_ALT})\\s*:|$)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) {
    const cat = catClass(m[1]);
    const entities: EntityCandidate[] = [];
    for (const org of splitOrgs(m[2])) {
      if (org.length < 2) continue;
      // The structured path preserves dots, so dotted-initials names are dropped
      // here (unchanged). Bare/initial First-Last is dropped later by the
      // author-roster cross-check in `analyzeStatement`, sized by the diagnostic.
      if (looksLikeInitialsName(org) || HOME_INSTITUTION.test(org) || looksLikeGrantId(org)) continue;
      if (scholar.surname && fuzzyScore(org, scholar.surname) >= 0.8) continue;
      const words = org.split(/\s+/).filter(Boolean);
      if (words.every((w) => ENTITY_STOP.has(w.toLowerCase().replace(/[^a-z]/gi, "")))) continue;
      const gaz = GAZ.some((g) => g.re.test(org));
      entities.push({ raw: org, score: gaz ? 0.9 : 0.75, cat });
    }
    if (entities.length)
      units.push({
        attribution: { level: "scholar", score: 0.85, reason: "ASCO-structured section header" },
        entities,
        source: `${m[1]}: ${m[2].trim()}`.slice(0, 400),
        subject,
      });
  }
  return units;
}

/** Attributed entity units for a statement (prose or structured). The optional
 *  `roster` is the paper's byline, used by `attribute` to confirm a no-honorific
 *  first-initial + surname author subject (the structured ASCO path already bounds
 *  the scholar's own section, so it does not need it). */
export function statementUnits(
  stmtRaw: string,
  scholar: Scholar,
  roster?: AuthorRoster,
): { units: Unit[]; unparsedStructured: boolean } {
  const stmt = cleanText(stmtRaw);
  if (isStructured(stmt)) {
    const slice = scholarSlice(stmt, scholar);
    if (!slice) {
      const present = !!(scholar.surnameRe && scholar.surnameRe.test(stmt));
      return { units: [], unparsedStructured: present };
    }
    return { units: structuredEntities(slice, scholar), unparsedStructured: false };
  }
  const units = segment(stmt).map((clause) => ({
    attribution: attribute(clause, scholar, roster),
    entities: extractEntities(clause),
    source: clause,
    subject: deriveSubject(clause, scholar, roster),
  }));
  return { units, unparsedStructured: false };
}

// ------------------------------ multi-author ------------------------------

// A disclosure-statement SUBJECT immediately followed by a disclosure verb
// ("… has received / is a consultant / discloses / serves / reports"), in either
// form: an honorific + surname ("Dr. Shah discloses") OR a first + last name
// ("Scott Kasner has received"). The captured surname is group 1 or group 2.
// Best-effort: a 3-word company in "X Y Z has provided" form can be miscounted as
// an author, so the count is an upper-ish estimate — used only to decide whether a
// statement names MULTIPLE authors (≥2), never for per-clause attribution.
const VERB = "(?:has|have|is\\s+a|was\\s+a|holds?|reports?|disclos\\w*|receiv\\w*|serv\\w*)";
const AUTHOR_REF = new RegExp(
  `\\b(?:(?:Drs?|Prof|Mr|Ms|Mrs)\\.?\\s+([A-Z][a-z]+(?:[-‐‑][A-Z][a-z]+)?)` +
    `|[A-Z][a-z]+\\s+([A-Z][a-z]+(?:[-‐‑][A-Z][a-z]+)?))\\s+${VERB}\\b`,
  "g",
);

/** Distinct author subjects named in a statement (best-effort). 1 ⇒ effectively
 *  single-author (the lone subject is the scholar); ≥2 ⇒ a shared/multi-author
 *  disclosure block. */
export function countAuthorMentions(stmt: string): number {
  const surnames = new Set<string>();
  AUTHOR_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AUTHOR_REF.exec(stmt)) !== null) surnames.add((m[1] ?? m[2]).toLowerCase());
  return surnames.size;
}

/** A statement is "multi-author" when it is a structured ASCO/ICMJE blob (one
 *  section per author) OR it names ≥2 distinct author-subjects. On such a shared
 *  statement an UNATTRIBUTED clause (no author named) cannot be confidently
 *  assigned to the scholar — it may be a co-author's — so it is suppressed. */
export function isMultiAuthorStatement(stmt: string): boolean {
  return isStructured(stmt) || countAuthorMentions(stmt) >= 2;
}

// --------------------------------- tiering ---------------------------------

export function tierOf(args: {
  attribution: Attribution;
  entityScore: number;
  cat: Category;
  nearScore: number;
  nearDisclosedThreshold: number;
  /** The source statement names ≥2 authors — an unattributed clause is then
   *  leakage-prone and suppressed (see `isMultiAuthorStatement`). */
  isMultiAuthor?: boolean;
}): { tier: Tier; why: string } {
  const { attribution, entityScore, cat, nearScore, nearDisclosedThreshold, isMultiAuthor } = args;
  if (nearScore >= nearDisclosedThreshold) return { tier: "Low", why: "near a disclosed entity (treat as disclosed)" };
  if (cat !== "personal") return { tier: "Low", why: `${cat} clause — no WRG analog` };
  if (attribution.level === "other") return { tier: "Low", why: "attributed to another author" };
  // A multi-author statement's unattributed clause isn't confidently the
  // scholar's — suppress it (the dominant precision win, measured at ~13% of
  // surfaced rows). A single-author statement's unattributed clause is untouched
  // (the lone subject IS the scholar), and a scholar-attributed clause still
  // surfaces even in a multi-author statement.
  if (isMultiAuthor && attribution.level === "unattributed")
    return { tier: "Low", why: "unattributed clause in a multi-author statement" };
  if (attribution.level === "scholar" && attribution.score >= 0.7 && entityScore >= 0.7)
    return { tier: "High", why: "scholar-attributed + strong entity, not disclosed" };
  // "other" already returned Low above, so any remaining entity with enough score is Medium.
  if (entityScore >= 0.5) return { tier: "Medium", why: "plausible but soft attribution or weak entity" };
  return { tier: "Low", why: "weak signal" };
}

export function failureModeGuess(args: {
  attribution: Attribution;
  cat: Category;
  nearScore: number;
  entityScore: number;
}): string {
  const { attribution, cat, nearScore, entityScore } = args;
  if (attribution.level === "other") return "co-author";
  if (cat === "funder") return "funder";
  if (cat === "employer") return "employer";
  if (nearScore >= 0.4 && nearScore < DEFAULT_NEAR_DISCLOSED) return "entity-variant?";
  if (entityScore < 0.6) return "extraction-noise?";
  return "candidate-TRUE?";
}

// ------------------------------- orchestration -------------------------------

/** Build the #1112 per-mention metadata (subject, org-raw, trimmed clause,
 *  relationship kinds) for one (unit, entity) pairing — shared by every
 *  GapCandidate construction site so the four fields stay in lock-step. */
function mentionMeta(
  unit: Unit,
  e: EntityCandidate,
): Pick<GapCandidate, "subjectType" | "subjectMention" | "organizationRaw" | "clause" | "relationshipKinds"> {
  return {
    subjectType: unit.subject.type,
    subjectMention: unit.subject.mention,
    organizationRaw: e.raw,
    clause: trimClause(unit.source, e.raw, unit.subject.mention),
    relationshipKinds: relationshipKinds(unit.source),
  };
}

/**
 * Analyze one COI statement for a scholar against their disclosed entities.
 * Returns surfaced (High/Medium) candidates deduped per normalized entity,
 * plus suppression counts for offline metrics.
 */
export function analyzeStatement(
  statement: string,
  scholar: Scholar,
  disclosedEntities: ReadonlyArray<string>,
  opts: AnalyzeOptions = {},
): StatementResult {
  const nearThreshold = opts.nearDisclosedThreshold ?? DEFAULT_NEAR_DISCLOSED;
  const suppressed = {
    coauthor: 0,
    nearDisclosed: 0,
    funderEmployer: 0,
    multiAuthor: 0,
    junkEntity: 0,
    coauthorRoster: 0,
  };

  const stmt = cleanText(statement);
  if (isPureNegation(stmt)) {
    return { candidates: [], suppressed, unparsedStructured: false, isNegation: true };
  }

  // A statement-level signal: when several authors are named, an unattributed
  // clause can't be assigned to the scholar, so `tierOf` suppresses it.
  const multiAuthor = isMultiAuthorStatement(stmt);
  const { units, unparsedStructured } = statementUnits(stmt, scholar, opts.roster);
  const RANK: Record<Tier, number> = { High: 3, Medium: 2, Low: 1 };
  const byEntity = new Map<string, GapCandidate>();

  for (const unit of units) {
    for (const e of unit.entities) {
      if (scholar.surname && fuzzyScore(e.raw, scholar.surname) >= 0.8) continue;
      const norm = normalizeEntity(e.raw);
      if (!norm || norm.replace(/\s/g, "").length < 3) continue;

      // Junk-word suppression: a bare boilerplate word ("All", "Various",
      // "Travel") is never a COI organization. Person-name suppression on SHAPE
      // alone is still not applied here — a bare "First Last" is structurally
      // indistinguishable from a founder-named org/foundation (see
      // looksLikePersonName). Instead the author-roster cross-check below drops the
      // ones confirmed to be co-authors of THIS paper. Gazetteer orgs are exempt.
      // Like co-author / near-disclosed suppression, junk is tiered Low: production
      // drops it; the diagnostic export (includeSuppressed) keeps it with its reason.
      if (!isGazetteerOrg(e.raw) && looksLikeJunkEntity(e.raw)) {
        suppressed.junkEntity++;
        if (!opts.includeSuppressed) continue;
        const nd0 = nearestDisclosed(e.raw, disclosedEntities, opts.canonicalize);
        const cand: GapCandidate = {
          entity: e.raw,
          normalized: norm,
          tier: "Low",
          attribution: unit.attribution.level,
          attributionReason: unit.attribution.reason,
          entityScore: e.score,
          category: e.cat,
          nearestDisclosed: nd0.entity,
          nearestScore: nd0.score,
          failureModeGuess: "junk-token",
          tierReason: "extracted phrase is a boilerplate/junk word, not an organization",
          sourceSentence: unit.source,
          ...mentionMeta(unit, e),
        };
        const prev0 = byEntity.get(norm);
        if (!prev0 || RANK[cand.tier] > RANK[prev0.tier]) byEntity.set(norm, cand);
        continue;
      }

      // Author-roster cross-check: a person-shaped, INITIAL-form entity that IS a
      // co-author of this paper (surname + first initial on the byline) is a name
      // bled through extraction, not the scholar's COI org — drop it. NOT applied to
      // a SCHOLAR-attributed clause: there the entity is the scholar's own genuine
      // tie ("Dr. Smith is a consultant for Karl Storz" / "B. Braun"), which must
      // never be suppressed just because a same-surname co-author is on the byline.
      // Gazetteer orgs are exempt. Tiered Low like junk: production drops it, the
      // diagnostic (includeSuppressed) keeps it with its reason.
      if (
        opts.roster &&
        unit.attribution.level !== "scholar" &&
        !isGazetteerOrg(e.raw) &&
        matchesCoAuthor(e.raw, opts.roster)
      ) {
        suppressed.coauthorRoster++;
        if (!opts.includeSuppressed) continue;
        const ndR = nearestDisclosed(e.raw, disclosedEntities, opts.canonicalize);
        const candR: GapCandidate = {
          entity: e.raw,
          normalized: norm,
          tier: "Low",
          attribution: unit.attribution.level,
          attributionReason: unit.attribution.reason,
          entityScore: e.score,
          category: e.cat,
          nearestDisclosed: ndR.entity,
          nearestScore: ndR.score,
          failureModeGuess: "co-author",
          tierReason: "entity matches a co-author of this paper (roster cross-check)",
          sourceSentence: unit.source,
          ...mentionMeta(unit, e),
        };
        const prevR = byEntity.get(norm);
        if (!prevR || RANK[candR.tier] > RANK[prevR.tier]) byEntity.set(norm, candR);
        continue;
      }

      const nd = nearestDisclosed(e.raw, disclosedEntities, opts.canonicalize);
      const t = tierOf({
        attribution: unit.attribution,
        entityScore: e.score,
        cat: e.cat,
        nearScore: nd.score,
        nearDisclosedThreshold: nearThreshold,
        isMultiAuthor: multiAuthor,
      });
      if (t.tier === "Low") {
        if (unit.attribution.level === "other") suppressed.coauthor++;
        else if (nd.score >= nearThreshold) suppressed.nearDisclosed++;
        else if (e.cat !== "personal") suppressed.funderEmployer++;
        else if (multiAuthor && unit.attribution.level === "unattributed") suppressed.multiAuthor++;
        // Production drops Low here; the diagnostic export keeps it (with its
        // match + reason) by setting includeSuppressed, falling through to build
        // the candidate below.
        if (!opts.includeSuppressed) continue;
      }
      const cand: GapCandidate = {
        entity: e.raw,
        normalized: norm,
        tier: t.tier,
        attribution: unit.attribution.level,
        attributionReason: unit.attribution.reason,
        entityScore: e.score,
        category: e.cat,
        nearestDisclosed: nd.entity,
        nearestScore: nd.score,
        failureModeGuess: failureModeGuess({
          attribution: unit.attribution,
          cat: e.cat,
          nearScore: nd.score,
          entityScore: e.score,
        }),
        tierReason: t.why,
        sourceSentence: unit.source,
        ...mentionMeta(unit, e),
      };
      const prev = byEntity.get(norm);
      if (!prev || RANK[cand.tier] > RANK[prev.tier]) byEntity.set(norm, cand);
    }
  }

  return { candidates: [...byEntity.values()], suppressed, unparsedStructured, isNegation: false };
}
