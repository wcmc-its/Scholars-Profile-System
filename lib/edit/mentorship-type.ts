/**
 * "Type of mentorship" for `/edit/reports/7` — one value per (learner,
 * mentor) pair: the program bucket × where the pair came from × how sure
 * we are. Roster / Jenzabar / ED pairs are facts; co-author pairs
 * (`mentee_suggestion`, #2634) are inferences and read as such. PURE — no
 * `@/lib/db` — the report's table is a client island and labels from here.
 *
 * Two layers: the per-pair `MentorshipType` (what a pair IS, labelled by
 * `mentorshipLabel`) and the seven-key `MentorshipTypeKey` vocabulary the
 * page's "Type of mentorship" filter speaks (`mentorshipTypeKey` folds a
 * pair into it). The filter is SERVER-side: the loader reads only the
 * sources a selected key needs, so an AOC-office holder (scope `md`) sees
 * AOC-defined pairs and nothing inferred — the in-memory rail facet it
 * replaces let a learner through on one roster pair and then listed every
 * co-author pair beside it.
 */
import { KIND_LABEL, type MenteeKind } from "@/lib/mentee-suggestions/kind";

export type MentorshipSource = "roster" | "jenzabar" | "ed" | "coauthor";
export type MentorshipTier = "confirmed" | "presumptive" | "ambiguous";
/** One (learner, mentor) pair's provenance: the program bucket (a
 *  `MentoringProgramKey`, or a `MenteeKind` for co-author pairs) and where
 *  the pair came from. */
export type MentorshipType = { program: string; source: MentorshipSource; tier: MentorshipTier };

/** Human label per program bucket (`MentoringProgramKey`). */
export const PROGRAM_LABEL: Record<string, string> = {
  md: "MD",
  mdphd: "MD-PhD",
  phd: "PhD",
  postdoc: "Postdoc",
  ecr: "ECR",
};

const SOURCE_LABEL: Record<MentorshipSource, string> = {
  roster: "roster",
  jenzabar: "Jenzabar",
  ed: "ED",
  coauthor: "co-author",
};

/** `program:source:tier` — the facet value. */
export function mentorshipKey(t: MentorshipType): string {
  return `${t.program}:${t.source}:${t.tier}`;
}

/** "MD · roster", "PhD · Jenzabar", "Postdoc · ED", "Volunteer · co-author
 *  (presumptive)" — the tier suffix only when not confirmed. */
export function mentorshipLabel(t: MentorshipType): string {
  const program = PROGRAM_LABEL[t.program] ?? KIND_LABEL[t.program as MenteeKind] ?? t.program;
  const tier = t.tier === "confirmed" ? "" : ` (${t.tier})`;
  return `${program} · ${SOURCE_LABEL[t.source]}${tier}`;
}

/** The filter's vocabulary, in display order: the three roster buckets,
 *  the two other confirmed sources, then the two co-author inference tiers. */
export const MENTORSHIP_TYPE_KEYS = [
  "aoc",
  "mdphd",
  "ecr",
  "thesis",
  "postdoc",
  "likely",
  "possible",
] as const;
export type MentorshipTypeKey = (typeof MENTORSHIP_TYPE_KEYS)[number];

export const MENTORSHIP_TYPE_LABEL: Record<MentorshipTypeKey, string> = {
  aoc: "AOC",
  mdphd: "MD-PhD (program office)",
  ecr: "ECR",
  thesis: "PhD / MD-PhD thesis advisor",
  postdoc: "Postdoc supervisor",
  likely: "Likely mentee (from co-authorship)",
  possible: "Possible mentee (from co-authorship)",
};

/** `report_access` scope key (`MENTORED_PUBS_SCOPES`, `lib/edit/report-access.ts`)
 *  → the type its `aoc_mentee` rows fall under. The three keys are repeated
 *  here rather than imported because report-access reads `@/lib/db`. An
 *  `aoc_mentee` bucket outside them (`phd` / `postdoc` never occur there)
 *  maps to nothing, so it can never be selected. */
export const ROSTER_TYPE_BY_SCOPE: Record<string, MentorshipTypeKey> = {
  md: "aoc",
  mdphd: "mdphd",
  ecr: "ecr",
};

/** The keys a `"*"` holder starts with — every sourced type; co-author
 *  inferences are opt-in for everyone. */
const CONFIRMED_TYPE_KEYS: ReadonlyArray<MentorshipTypeKey> = [
  "aoc",
  "mdphd",
  "ecr",
  "thesis",
  "postdoc",
];

/** Which filter key a pair falls under. */
export function mentorshipTypeKey(t: MentorshipType): MentorshipTypeKey {
  switch (t.source) {
    case "roster":
      return ROSTER_TYPE_BY_SCOPE[t.program];
    case "jenzabar":
      return "thesis";
    case "ed":
      return "postdoc";
    case "coauthor":
      return t.tier === "presumptive" ? "likely" : "possible";
  }
}

/** The keys a scope set may select: a roster key only when its scope is
 *  held (or `"*"`); the four non-roster keys always. */
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
    scopes.has("*") ? CONFIRMED_TYPE_KEYS : [...scopes].map((s) => ROSTER_TYPE_BY_SCOPE[s]),
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
