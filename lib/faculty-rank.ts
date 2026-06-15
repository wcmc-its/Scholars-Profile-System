/**
 * Professorial-rank helpers for Grad-School (Jenzabar) appointment titles (#1034).
 *
 * The Graduate School independently maintains its faculty appointments in
 * Jenzabar, so the `INSTRUCTOR TYPE` carried verbatim into `Appointment.title`
 * (etl/jenzabar/import-gs-faculty.ts) is often right but sometimes wrong in two
 * ways this module corrects:
 *
 *   Rule A — strip chair / program-head designations. The Grad School has no
 *     department chairs or program heads, yet Jenzabar emits compound titles
 *     like "Professor/Chair" (the chair role is a WCM College role that already
 *     surfaces on the ED appointment tier). `stripGradSchoolChairDesignation`
 *     removes the leadership segment, never blanking the title.
 *
 *   Rule B — tie professorial rank to ASMS. ASMS is authoritative for
 *     professorial rank (Faculty Affairs -> ASMS -> Enterprise Directory). The
 *     rank is read from the ED person-type code, NOT parsed from a title string:
 *     probe #1036 showed `fslee`'s primaryTitle is "Chair of Psychiatry" — no
 *     rank token at all — while his rank leaf is `academic-faculty-fullprofessor`.
 *     `deriveProfessorialRank` maps the leaf; the ED ETL persists the result on
 *     `Scholar.professorialRank`, and the Jenzabar import applies it via
 *     `normalizeGradSchoolFacultyTitle`.
 *
 * Rank leaves, confirmed present in `weillCornellEduPersonTypeCode` by probe
 * #1036 (etl/ed/probe-gs-rank-leaf.ts) and effectively single-valued per person:
 *   academic-faculty-assistant     -> Assistant Professor   (4,213)
 *   academic-faculty-associate     -> Associate Professor   (1,132)
 *   academic-faculty-fullprofessor -> Professor             (1,271)
 * Modifier leaves (-adjunct / -voluntary / -visiting / -emeritus / ...) are a
 * separate axis and are intentionally NOT part of the rank label, so a GS title
 * never shows "Adjunct Professor" — only the clean rank.
 */

export type ProfessorialRank = "Assistant Professor" | "Associate Professor" | "Professor";

/** Highest-rank-first so highest-rank-wins if a record ever carries two leaves
 *  (probe #1036 found the leaf effectively single-valued, but be defensive). */
const RANK_BY_LEAF: ReadonlyArray<readonly [string, ProfessorialRank]> = [
  ["academic-faculty-fullprofessor", "Professor"],
  ["academic-faculty-associate", "Associate Professor"],
  ["academic-faculty-assistant", "Assistant Professor"],
];

/**
 * Rule B source. Map the ASMS-authoritative person-type rank leaf to a clean
 * professorial rank. Returns null when the scholar carries no professorial-rank
 * leaf (e.g. instructor / lecturer / non-faculty), in which case the GS title is
 * left as-is.
 */
export function deriveProfessorialRank(
  personTypeCodes: readonly string[],
): ProfessorialRank | null {
  for (const [leaf, rank] of RANK_BY_LEAF) {
    if (personTypeCodes.includes(leaf)) return rank;
  }
  return null;
}

/** Leadership segments the Grad School does not confer; stripped from a GS title
 *  when they appear as a slash-delimited segment (the observed compound form is
 *  "Professor/Chair"). Covers chair, program head/director/chair, and bare head —
 *  but NOT standalone administrative titles like "Course Director" or "Associate
 *  Dean", which arrive without a "/" and are left untouched. */
const GS_LEADERSHIP_SEGMENT =
  /^(co-?\s*)?(vice[-\s]?|associate\s+|deputy\s+|assistant\s+)?(chair|program\s+(head|director|chair)|head)\b/i;

/**
 * Rule A. Remove chair / program-head designations from a Grad-School title.
 * Splits on "/", drops leadership segments, and rejoins. Never returns empty: if
 * every segment is a leadership designation (no rank to fall back on) the
 * original title is returned unchanged.
 */
export function stripGradSchoolChairDesignation(title: string): string {
  const trimmed = title.trim();
  if (!trimmed.includes("/")) return trimmed;
  const segments = trimmed
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = segments.filter((s) => !GS_LEADERSHIP_SEGMENT.test(s));
  if (kept.length === 0) return trimmed;
  return kept.join("/");
}

/** Does this (de-chaired) Jenzabar title denote a professorial rank — i.e. one
 *  of Assistant / Associate / (full) Professor, with or without an adjunct
 *  modifier? Matches the professorial INSTRUCTOR TYPE values ("Professor",
 *  "Assistant Professor", "Associate Professor", "Adjunct Professor", "Adjunct
 *  Associate Professor", "Adjunct Assistant") and not the non-professorial ones
 *  ("Instructor", "Lecturer", "Librarian", "Course Director", "Associate Dean",
 *  "Dean", "Retired"). */
function isProfessorialTitle(title: string): boolean {
  return /professor/i.test(title) || /\badjunct\s+(assistant|associate)\b/i.test(title);
}

/**
 * Combined Rule A + Rule B normalization for a Grad-School (Jenzabar)
 * appointment title.
 *
 *  - Always strips chair / program-head designations (Rule A).
 *  - When the resulting title is a professorial rank AND the scholar has an ASMS
 *    professorial rank, replaces it with that clean rank (Rule B) — ASMS wins,
 *    and adjunct/voluntary modifiers are dropped.
 *  - Leaves the title verbatim otherwise: non-professorial titles
 *    (Instructor/Lecturer/...) are never relabeled, and a professorial title
 *    with no resolvable ASMS rank keeps its de-chaired Jenzabar rank.
 *
 * `professorialRank` is the persisted `Scholar.professorialRank` value (one of
 * the three rank strings, or null), produced by `deriveProfessorialRank` in the
 * ED ETL.
 */
export function normalizeGradSchoolFacultyTitle(args: {
  jenzabarTitle: string;
  professorialRank: string | null;
}): string {
  const deChaired = stripGradSchoolChairDesignation(args.jenzabarTitle);
  if (args.professorialRank && isProfessorialTitle(deChaired)) {
    return args.professorialRank;
  }
  return deChaired;
}
