/**
 * Locked training-exclusion rule for the PI facet (#233).
 *
 * Audit (2026-05-13, host MariaDB post-#78) showed InfoEd's `program_type`
 * tagging is inconsistent for K/F/T mechanisms — the same mechanism appears
 * under multiple `program_type` values. A naive `program_type IN
 * ('Training','Fellowship','Career')` rule would (a) wrongly include
 * `Grant`-tagged K23s, K99s, F31s, F32s and (b) wrongly exclude
 * `Training`-tagged T32 PIs (program directors, real PIs).
 *
 * Mechanism-based exclusion is therefore primary, with the program_type rule
 * kept as a fallback for non-NIH grants where mechanism is null (foundation
 * career awards, BWF, etc.).
 *
 * Deliberately NOT in the training set:
 *   - R00, K22 (independent phase of K99/R00 transition + K22 independent
 *     awards — exactly the new-faculty cohort users want surfaced)
 *   - K24, K76 (midcareer mentoring / emerging-leader; audit confirmed real PIs)
 *   - T32/T35/T37/T15/TL1 directors — wait, TL1 IS excluded (CTSA TL1
 *     predoc training is wholly a trainee award, no PI semantics). T32/T35/T37
 *     are NOT excluded because their PIs are program directors, not trainees.
 *
 * See `.planning/drafts/SPEC-pi-facet.md` "K-award / training exclusion"
 * section for the full audit and decision matrix.
 */

const TRAINING_MECHANISMS: ReadonlySet<string> = new Set([
  // NIH fellowships
  "F30",
  "F31",
  "F32",
  "F33",
  // Mentored career-development
  "K01",
  "K07",
  "K08",
  "K12",
  "K23",
  "K25",
  // Mentored phase of K99/R00 (independent R00 phase is NOT excluded — see file header)
  "K99",
  // Institutional career development
  "KL2",
  // CTSA TL1 predoctoral training
  "TL1",
]);

const TRAINING_PROGRAM_TYPES: ReadonlySet<string> = new Set([
  "Career",
  "Fellowship",
  "Training",
]);

export function isTrainingOnlyGrant(g: {
  mechanism: string | null;
  programType: string;
}): boolean {
  if (g.mechanism !== null && g.mechanism !== undefined) {
    return TRAINING_MECHANISMS.has(g.mechanism);
  }
  return TRAINING_PROGRAM_TYPES.has(g.programType);
}
