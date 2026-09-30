/**
 * Opportunity screening signals — `docs/2026-07-24-grant-opportunity-screening-spec.md`.
 *
 * Both signals here are properties of the OPPORTUNITY alone (never of a scholar), so they are
 * known before any ask runs and are cheap enough to compute per browse row.
 *
 * CLIENT-SAFE — this module reaches the browser bundle (grant-matcha-panel imports it), so it
 * must never import `@/lib/db` or anything that constructs prisma at module scope (the
 * `manageable-units` trap in CLAUDE.md).
 */
import type { CareerStage } from "@/lib/career-stage";

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asMap(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The structured map's `career_stages`, or `[]` when absent — `[]` means "no restriction". */
export function careerStagesOf(eligibility: unknown): string[] {
  return stringArray(asMap(eligibility).career_stages);
}

/**
 * Career stages that leave an award holdable by a WCM faculty PI.
 *
 * 🔴 `any_faculty` is a FOURTH faculty value (24 rows, 7.9%) alongside early/mid/senior. Writing
 * the faculty set without it misclassifies those as faculty-ineligible — the first audit probe for
 * the spec did exactly that and produced 14 false exclusions, including the NSF Major Research
 * Instrumentation call.
 *
 * The discriminator is NOT "trainee": postdoc fellowships, late-stage-postdoc transition awards,
 * K-awards and clinical-fellow awards are high-interest faculty-transition money and stay.
 * `resident` stays too — residents are neither students nor faculty, and §5's fail-open posture
 * resolves that ambiguity toward showing the row (spec §3.1 leaves it open; keeping is also what
 * the measured derivation B did).
 */
const HOLDABLE_STAGES: ReadonlySet<string> = new Set([
  "any_faculty",
  "early_career_faculty",
  "mid_career_faculty",
  "senior_faculty",
  "postdoc",
  "late_stage_postdoc",
  "clinical_fellow",
  "resident",
  "clinician",
]);

/**
 * Spec §3.1 — can a WCM faculty PI hold this award at all?
 *
 * Measured on staging 2026-07-24: 40 of the 304 clickable opportunities (13.2%) fail this, and the
 * flag-based derivation (`student_only` && not `faculty_eligible`) agrees on all 40. This reads the
 * structured map rather than the derived flags because it states the keep-set explicitly instead of
 * trusting `student_only` to have been set correctly.
 *
 * Two invariants, both deliberate:
 * - **Fail open** (§5): an absent, malformed or empty `career_stages` NEVER excludes. A screen that
 *   buries every record an extractor happened to skip looks curated and is arbitrary.
 * - **Flags win for inclusion** (§3.2): the map wins for exclusion, but any faculty signal from
 *   either source keeps the row. On today's corpus the two derivations agree on every row, so this
 *   line only matters if the map drifts — and it drifts in the safe direction.
 */
export function facultyPiMayHold(eligibilityFlags: unknown, eligibility: unknown): boolean {
  if (stringArray(eligibilityFlags).includes("faculty_eligible")) return true;
  const stages = careerStagesOf(eligibility);
  if (stages.length === 0) return true;
  return stages.some((s) => HOLDABLE_STAGES.has(s));
}

/**
 * Grant Matcha — what THIS opportunity actually requires of a researcher. Every field is
 * "absent ⇒ that axis does not render": the rail is relevance-driven, not a fixed 3-axis panel.
 *
 * `careerStages` is the load-bearing HARD axis (33.8% of mapped opportunities restrict it).
 * `esiTargeted` is SOFT by design — the extractor's `esi_targeted` is a priority, not a gate,
 * so it demotes and never hides. `usRequired` is DISPLAY-ONLY: person-level US citizenship is
 * required by only 4.2% of opportunities and SPS holds no scholar citizenship field, so a US
 * toggle would either filter nothing or imply data we do not have.
 */
export type EligibilityRequirements = {
  /** Stages the opportunity admits. `null` ⇒ unrestricted ⇒ no career-stage axis. */
  careerStages: readonly CareerStage[] | null;
  /**
   * The sponsor's OWN eligibility wording, verbatim, so the axis can cite what produced it.
   *
   * 🔴 Without this the rail states "Required: Early career · Mid career · Senior · Postdoc" —
   * SPS's internal stage vocabulary — over an opportunity whose SYNOPSIS never mentions career
   * stage, because the eligibility text lives in a different column that nothing renders. It reads
   * as a requirement the matcher invented. It is not: `spin:095001` carries "Physician or Medical
   * Professional; Faculty Member; Researcher or Investigator; Postdoctoral".
   */
  stageSource?: string | null;
  esiTargeted: boolean;
  usRequired: boolean;
};

/** Faculty maps to the three post-training stages; `careerStageBucket` has no "faculty" bucket. */
export const FACULTY_STAGES: readonly CareerStage[] = ["early", "mid", "senior"];

/**
 * Values that appear in `career_stages` but are NOT career stages (screening spec §3.2 — the
 * extraction contract mixes two axes into one array).
 *
 * 🔴 A role must not trip the restriction signal. Measured on staging 2026-07-28: 27 of 304
 * opportunities carry `clinician`, and on the 2 where it is the ONLY value the rail stated
 * "Required: Early career · Mid career · Senior" — stages taken from the derived flags, which the
 * sponsor never mentioned — while the restriction it DID state (be a clinician) went unshown and
 * unenforced. Dropping roles here makes those 2 render no axis, which is the truth: they state no
 * career-stage requirement.
 *
 * Enforcing the clinician restriction is a separate, larger job (#2042): SPS has `isClinician`, but
 * a second hard axis needs its own gate, badge, floor and relax control for 0.7% of the corpus.
 */
const NON_STAGE_ROLES: ReadonlySet<string> = new Set(["clinician"]);

/**
 * Turn an opportunity's stored eligibility into the axes the rail should render.
 *
 * The RESTRICTION SIGNAL is the structured map's `career_stages` being non-empty — the same test
 * `deriveEligibilityFlagsFromMap` uses (`etl/dynamodb/grant-opportunity-mapper.ts`), where an empty
 * array explicitly means "no person-level restriction". The ALLOWED SET then comes from the derived
 * flags, which are what SPS already reads. Deriving the axis from the flags alone would render it on
 * ~88% of opportunities and bury the officer in a filter that mostly restricts nothing.
 */
export function requirementsFrom(
  eligibilityFlags: unknown,
  eligibility: unknown,
  eligibilityRaw?: unknown,
): EligibilityRequirements {
  const flags = stringArray(eligibilityFlags);
  const map = asMap(eligibility);
  // Only STAGE values restrict — a role in this array says who may apply, not at what stage.
  const restricts = stringArray(map.career_stages).some((s) => !NON_STAGE_ROLES.has(s));

  const allowed: CareerStage[] = [];
  if (flags.includes("student_only")) allowed.push("grad");
  if (flags.includes("faculty_eligible")) allowed.push(...FACULTY_STAGES);
  if (flags.includes("postdoc_eligible")) allowed.push("postdoc");

  // The sponsor's own eligibility wording, so the rail can cite what the stage list came from.
  // Usually a short semicolon list ("Faculty Member; Postdoctoral | United States"); the rail
  // clamps it, so no length cap here. Blank when the column is empty — never a fabricated source.
  const source = typeof eligibilityRaw === "string" ? eligibilityRaw.trim() : "";

  return {
    // An empty allowed set would hide EVERYONE off malformed data, so it degrades to "no axis"
    // rather than to an empty page — a filter that can only filter everything is worse than none.
    careerStages: restricts && allowed.length > 0 ? allowed : null,
    stageSource: source || null,
    esiTargeted: map.esi_targeted === true,
    usRequired: map.us_citizen_or_permanent_resident_required === true,
  };
}

/**
 * 🔴 #1919's topic-agnostic detector was REMOVED here, measured against staging 2026-07-27.
 * Neither half of the proposed signal survives the data:
 *
 * - "no MeSH anchor" carries ZERO information — `mesh_descriptor_ui` is a JSON-scalar null on
 *   every row of the corpus (0 of 333 clickable rows hold a real array), so the test is true
 *   everywhere. See the JSON-null trap: `JSON_TYPE(col)='ARRAY'` is the only honest populated test.
 * - `primary_topic_id = 'research_infrastructure_workforce'` alone hits 83 of 333 rows (24.9%),
 *   and reading them shows it is not the "no science to rank on" class at all: Sloan Research
 *   Fellowships, ACS Mentored Research Grants, AHA institutional awards, K-bridge career
 *   development. Those rank fine.
 *
 * Telling an officer a quarter of the corpus has no science in it — and suppressing the ask on all
 * of it — is a worse failure than the blank page #1919 reported. A real detector needs a signal
 * that separates the NIGMS RM1 from a Sloan Fellowship; the topic taxonomy does not carry one.
 */
