/**
 * "Type of mentorship" for `/edit/reports/7` — one value per (learner,
 * mentor) pair: the program bucket × where the pair came from × how sure
 * we are. Roster / Jenzabar / ED pairs are facts; co-author pairs
 * (`mentee_suggestion`, #2634) are inferences and read as such. PURE — no
 * `@/lib/db` — the report's table is a client island and labels from here.
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

/** The rail's starting selection: sourced pairs checked, co-author
 *  inferences unchecked until someone opts in. */
export function mentorshipDefaultSelected(t: MentorshipType): boolean {
  return t.source !== "coauthor";
}
