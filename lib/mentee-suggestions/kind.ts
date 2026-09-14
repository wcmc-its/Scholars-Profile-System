/**
 * #2634 — career-stage classification for co-authorship-derived mentee
 * suggestions. Pure: shared by the ETL builder (classifies ReCiterDB
 * `person_person_type` rows) and the /edit card (labels). MUST stay free of
 * `@/lib/db` — it reaches the client bundle.
 *
 * The person type alone does not establish career stage for everyone, so a
 * kind carries a TIER:
 *   presumptive — students, postdocs, fellows, volunteers: shown by default.
 *   ambiguous   — research staff (a technician or a biostatistician) and MD
 *                 alumni (may be a peer physician now): shown with the ED
 *                 title visible and a "may be a colleague" hint.
 *   unknown     — collaborators, bare affiliates, unclassified: collapsed,
 *                 never a default suggestion.
 * Professors are excluded upstream (never a row) — see the ETL builder.
 */
export type MenteeKind =
  | "postdoc"
  | "fellow"
  | "doctoral"
  | "md_phd"
  | "md_student"
  | "masters"
  | "student_employee"
  | "volunteer"
  | "resident"
  | "alumni_phd"
  | "alumni_md"
  | "research_staff"
  | "collaborator"
  | "unknown";

export type MenteeTier = "presumptive" | "ambiguous" | "unknown";

export type DismissReason = "colleague" | "never_worked" | "private";
export const DISMISS_REASONS: readonly DismissReason[] = ["colleague", "never_worked", "private"];

/** First match wins — ordered most-specific first so a paid PhD student
 *  (`employee-student-paid` + `student-phd-weill`) classifies as doctoral. */
const RULES: ReadonlyArray<[MenteeKind, (t: string) => boolean]> = [
  ["fellow", (t) => t === "academic-nonfaculty-postdoc-fellow"],
  ["postdoc", (t) => t === "academic-nonfaculty-postdoc"],
  ["md_phd", (t) => t.startsWith("student-md-phd")],
  ["doctoral", (t) => t.startsWith("student-phd")],
  ["md_student", (t) => t.startsWith("student-md")],
  ["masters", (t) => t === "student-masters"],
  ["student_employee", (t) => t === "employee-student-paid"],
  ["volunteer", (t) => t === "affiliate-volunteer"],
  ["resident", (t) => t === "affiliate-nyp-resident"],
  // Departed trainees: 80% of live rows had no current-appointment type at all
  // (measured 09-14). PhD alumni co-publishing within the window are trainees
  // by construction; MD alumni may be peer physicians now, so they're ambiguous.
  // `academic-inactive` carries no career-stage information and stays unknown.
  ["alumni_phd", (t) => t === "affiliate-alumni-phd" || t === "affiliate-alumni-md-phd"],
  ["alumni_md", (t) => t === "affiliate-alumni-md"],
  ["research_staff", (t) => t === "academic-nonfaculty"],
  ["collaborator", (t) => t === "affiliate-collaborator"],
];

export function classifyMenteeKind(personTypes: readonly string[]): MenteeKind {
  for (const [kind, test] of RULES) if (personTypes.some(test)) return kind;
  return "unknown";
}

export function tierOf(kind: MenteeKind): MenteeTier {
  if (kind === "research_staff" || kind === "alumni_md") return "ambiguous";
  if (kind === "collaborator" || kind === "unknown") return "unknown";
  return "presumptive";
}

export const KIND_LABEL: Record<MenteeKind, string> = {
  postdoc: "Postdoc",
  fellow: "Fellow",
  doctoral: "PhD student",
  md_phd: "MD-PhD student",
  md_student: "Medical student",
  masters: "Masters student",
  student_employee: "Student",
  volunteer: "Volunteer",
  resident: "Resident",
  alumni_phd: "PhD alum",
  alumni_md: "MD alum",
  research_staff: "Research staff",
  collaborator: "Collaborator",
  unknown: "Career stage unknown",
};
