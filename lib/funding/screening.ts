/**
 * Opportunity screening signals — `docs/2026-07-24-grant-opportunity-screening-spec.md`.
 *
 * Both signals here are properties of the OPPORTUNITY alone (never of a scholar), so they are
 * known before any ask runs and are cheap enough to compute per browse row.
 */

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
 * Spec §4 / #1919 — the award names a funding MECHANISM rather than a research area, so concept
 * fan-out has nothing to match on and returns an empty page that reads as "WCM has no suitable
 * researchers". NIGMS RM1 is the type case: real, fundable, $1.5M/yr, and topically empty.
 *
 * The signal is the opportunity's own classification, not its prose — an earlier boilerplate-share
 * metric UNDER-detects this, because mechanism prose ("the scope of some scientific problems…")
 * counts as scientific to a sentence classifier.
 */
export function isTopicAgnostic(opportunity: {
  primaryTopicId?: string | null;
  meshDescriptorUi?: unknown;
}): boolean {
  const mesh = opportunity.meshDescriptorUi;
  const hasAnchor = Array.isArray(mesh) ? mesh.length > 0 : mesh != null;
  return !hasAnchor && opportunity.primaryTopicId === "research_infrastructure_workforce";
}
