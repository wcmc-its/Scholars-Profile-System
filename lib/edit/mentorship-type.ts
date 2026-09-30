/**
 * "Type of mentorship" for `/edit/reports/7` — one value per (learner,
 * mentor) pair: the program bucket × where the pair came from × how sure
 * we are. Roster / Jenzabar / ED pairs are facts; co-author pairs
 * (`mentee_suggestion`, #2634) are inferences and read as such; a
 * faculty-asserted pair (the mentor's own `manualMentees` field-override —
 * hand-entered on `/edit`, or a co-authorship suggestion they ACCEPTED
 * there) is the mentor's word, confirmed. PURE — no `@/lib/db` — the
 * report's table is a client island and labels from here.
 *
 * Two layers: the per-pair `MentorshipType` (what a pair IS, labelled by
 * `mentorshipLabel`) and the eight-key `MentorshipTypeKey` vocabulary the
 * page's "Type of mentorship" filter speaks (`mentorshipTypeKey` folds a
 * pair into it). Every user-facing string here speaks the office's
 * language, not the schema's: the `md` bucket IS the Areas of Concentration
 * (AOC) program, so it reads "AOC"; a pair reads by its category
 * ("PhD thesis advisor", "Postdoc supervisor", "likely mentee") and never
 * by its table ("roster", "Jenzabar", "ED") or the suggestion tier's
 * internal name ("presumptive" confused the office — it is "likely" here).
 * `MENTORSHIP_TYPE_DESCRIPTION` is the one-sentence hover / Sources text
 * per key. The filter is SERVER-side: the loader reads only the
 * sources a selected key needs, so an AOC-office holder (scope `md`) sees
 * AOC-defined pairs and nothing inferred — the in-memory rail facet it
 * replaces let a learner through on one roster pair and then listed every
 * co-author pair beside it.
 */
import { KIND_LABEL, type MenteeKind } from "@/lib/mentee-suggestions/kind";

export type MentorshipSource = "roster" | "jenzabar" | "ed" | "coauthor" | "faculty";
export type MentorshipTier = "confirmed" | "presumptive" | "ambiguous";
/** One (learner, mentor) pair's provenance: the program bucket (a
 *  `MentoringProgramKey`, or a `MenteeKind` for co-author pairs) and where
 *  the pair came from. */
export type MentorshipType = { program: string; source: MentorshipSource; tier: MentorshipTier };

/** Human label per program bucket (`MentoringProgramKey`). The `md` KEY
 *  stays (it is `bucketProgramType`'s output and the `report_access` scope
 *  key). Its LABEL is "MD" — the degree, not the program office's name:
 *  "AOC" (Areas of Concentration) was what the Program column, the access
 *  popover's scope options and the workbook read until 2026-09-20, and
 *  nobody outside that office knows it. AOC survives in the hovers and the
 *  report description as the SOURCE (the pairing sheet), never as a label. */
export const PROGRAM_LABEL: Record<string, string> = {
  md: "MD",
  mdphd: "MD-PhD",
  phd: "PhD",
  postdoc: "Postdoc",
  ecr: "ECR",
  /** A faculty-asserted mentee with no degree bucket (hand entry leaves
   *  `programType` unset). */
  other: "Other",
};

/** `program:source:tier` — the dedupe / React key for a pair. NOT a label:
 *  it keeps the schema words on purpose so it never moves when the wording
 *  does. */
export function mentorshipKey(t: MentorshipType): string {
  return `${t.program}:${t.source}:${t.tier}`;
}

/** The per-pair label (the Learners "Type of mentorship" column, the
 *  mentor cell lines, the workbook), read by CATEGORY: a roster pair is its
 *  program ("AOC", "MD-PhD (program office)", "ECR"); a Jenzabar pair is
 *  "<program> thesis advisor"; an ED pair "Postdoc supervisor"; a co-author
 *  pair "<kind> · likely mentee (from co-authorship)" (or "possible"). A
 *  roster bucket no filter key maps to falls back to its program label; a
 *  faculty-asserted pair is "<program> · faculty-asserted". */
export function mentorshipLabel(t: MentorshipType): string {
  switch (t.source) {
    case "roster": {
      const key = ROSTER_TYPE_BY_SCOPE[t.program];
      return key ? MENTORSHIP_TYPE_LABEL[key] : (PROGRAM_LABEL[t.program] ?? t.program);
    }
    case "jenzabar":
      return `${PROGRAM_LABEL[t.program] ?? t.program} thesis advisor`;
    case "ed":
      return MENTORSHIP_TYPE_LABEL.postdoc;
    case "coauthor": {
      const kind = KIND_LABEL[t.program as MenteeKind] ?? t.program;
      return `${kind} · ${t.tier === "presumptive" ? "likely" : "possible"} mentee (from co-authorship)`;
    }
    case "faculty":
      return `${PROGRAM_LABEL[t.program] ?? t.program} · faculty-asserted`;
  }
}

/** The filter's vocabulary, in display order: the three roster buckets,
 *  the two other confirmed sources, the two co-author inference tiers, then
 *  the mentor's own assertions (appended last so no existing link's `mtype=`
 *  order shifts). */
export const MENTORSHIP_TYPE_KEYS = [
  "aoc",
  "mdphd",
  "ecr",
  "thesis",
  "postdoc",
  "likely",
  "possible",
  "faculty",
] as const;
export type MentorshipTypeKey = (typeof MENTORSHIP_TYPE_KEYS)[number];

export const MENTORSHIP_TYPE_LABEL: Record<MentorshipTypeKey, string> = {
  aoc: "MD",
  mdphd: "MD-PhD (program office)",
  ecr: "ECR",
  thesis: "PhD / MD-PhD thesis advisor",
  postdoc: "Postdoc supervisor",
  likely: "Likely mentee (from co-authorship)",
  possible: "Possible mentee (from co-authorship)",
  faculty: "Faculty-asserted",
};

/** One sentence per key: what the source is and how sure it is — the
 *  filter checkbox's hover, each pair line's hover, and the page's
 *  "Sources" disclosure (which adds the date facts). Plain words for the
 *  office that asked what each category means. */
export const MENTORSHIP_TYPE_DESCRIPTION: Record<MentorshipTypeKey, string> = {
  aoc: "MD students' pairs, recorded by the Areas of Concentration (AOC) program — the MD scholarly-concentration program — in its pairing sheet.",
  mdphd:
    "Pairs from the MD-PhD program office's list, loaded with the AOC sheet. No entry or graduation years yet.",
  ecr: "Early Career Research pairs from the same sheet (classes 2018–2023).",
  thesis:
    "Thesis-advisor pairs from the Graduate School's Jenzabar records (MAJSP). Conferral year known; start year not.",
  postdoc:
    "The postdoc's reporting manager from the ED appointment record, with appointment dates. For roughly one in seven, the manager on record is a lab administrator rather than the PI.",
  likely:
    "Not on any roster: a trainee-type co-author (student, postdoc, fellow, volunteer…) who publishes repeatedly with this faculty member. Inferred, unconfirmed.",
  possible:
    "The same inference for research staff or MD alumni, who may be peers rather than trainees. Off by default.",
  faculty:
    "Added by the mentor on their Scholars profile, or confirmed there from a co-authorship suggestion.",
};

/** `report_access` scope key (`MENTORED_PUBS_SCOPES`, `lib/edit/report-access.ts`)
 *  → the type its `aoc_mentee` rows fall under. The three keys are repeated
 *  here rather than imported because report-access reads `@/lib/db`. An
 *  `aoc_mentee` bucket outside them (`bucketProgramType` can also yield
 *  `phd` / `postdoc`, though the roster carries neither) maps to nothing,
 *  so such a row can never be selected — the miss is explicit, not a
 *  typing lie. */
export const ROSTER_TYPE_BY_SCOPE: Partial<Record<string, MentorshipTypeKey>> = {
  md: "aoc",
  mdphd: "mdphd",
  ecr: "ecr",
};

/** The keys a `"*"` holder starts with — every sourced type, including
 *  what a mentor asserted themselves; co-author inferences are opt-in for
 *  everyone. */
const CONFIRMED_TYPE_KEYS: ReadonlyArray<MentorshipTypeKey> = [
  "aoc",
  "mdphd",
  "ecr",
  "thesis",
  "postdoc",
  "faculty",
];

/** Which filter key a pair falls under; null for a roster bucket no scope
 *  maps to (such a pair is never selectable). */
export function mentorshipTypeKey(t: MentorshipType): MentorshipTypeKey | null {
  switch (t.source) {
    case "roster":
      return ROSTER_TYPE_BY_SCOPE[t.program] ?? null;
    case "jenzabar":
      return "thesis";
    case "ed":
      return "postdoc";
    case "coauthor":
      return t.tier === "presumptive" ? "likely" : "possible";
    case "faculty":
      return "faculty";
  }
}

/** The keys a scope set may select: a roster key only when its scope is
 *  held (or `"*"`); the non-roster keys always. */
export function allowedMentorshipTypes(scopes: ReadonlySet<string>): MentorshipTypeKey[] {
  return MENTORSHIP_TYPE_KEYS.filter((k) => {
    const scope = Object.keys(ROSTER_TYPE_BY_SCOPE).find((s) => ROSTER_TYPE_BY_SCOPE[s] === k);
    return scope === undefined || scopes.has("*") || scopes.has(scope);
  });
}

/** The page's / route's starting selection: `"*"` → every confirmed key;
 *  otherwise the roster key of each held scope (an `md` holder → `["aoc"]`).
 *  Co-author keys are NEVER in a default. */
export function defaultMentorshipTypes(scopes: ReadonlySet<string>): MentorshipTypeKey[] {
  const held = new Set(
    scopes.has("*")
      ? CONFIRMED_TYPE_KEYS
      : [...scopes].flatMap((s) => ROSTER_TYPE_BY_SCOPE[s] ?? []),
  );
  return MENTORSHIP_TYPE_KEYS.filter((k) => held.has(k));
}

/** What the page and the download route both apply to a request: not
 *  given → the default; given → only the allowed keys; nothing left → the
 *  default (the same fallback shape the graduation years use — a disallowed
 *  roster key is dropped silently, never a 403, never a wider set). */
export function resolveMentorshipTypes(
  requested: ReadonlyArray<MentorshipTypeKey> | null,
  scopes: ReadonlySet<string>,
): MentorshipTypeKey[] {
  const allowed = new Set(allowedMentorshipTypes(scopes));
  const kept = (requested ?? []).filter((k) => allowed.has(k));
  return kept.length > 0 ? kept : defaultMentorshipTypes(scopes);
}
