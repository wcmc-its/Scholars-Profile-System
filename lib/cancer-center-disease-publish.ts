/**
 * Whether a Cancer Center disease inference is published — the ONE predicate
 * the /edit roster (`components/edit/center-roster-card.tsx`, the review sheet,
 * `components/edit/center-roster-diseases.ts`) and the public center page read.
 *
 * A (cwid, diseaseCode) row is a generator suggestion
 * (`CancerCenterDiseaseAssignment`, `confidence` high | medium | low) and/or a
 * curator call (`CancerCenterDiseaseDecision`, confirmed | rejected). A manual
 * add is a confirmed decision with no assignment. A human decision always wins;
 * with no decision, the center's `Center.diseaseAutoPublish` switch publishes a
 * HIGH-confidence suggestion without review ("auto"). Everything else waits in
 * the review queue ("pending").
 *
 * Pure and client-safe: no `@/lib/db`, no prisma, and a minimal structural row
 * shape so a caller need not depend on the edit-context row type.
 */

/** The confidence tier that auto-publishes when a center's switch is on. */
export const AUTO_PUBLISH_CONFIDENCE = "high";

/** The fields the predicate reads. `RosterDiseaseRow` (edit context) satisfies
 *  it structurally; a public-page row only needs these two. */
export type DiseasePublishRow = {
  assignment: { confidence: string } | null;
  decision: { decision: string } | null;
};

/**
 * - `confirmed` — a curator confirmed it (manual adds included).
 * - `rejected` — a curator rejected it.
 * - `auto` — no decision; high confidence; the center auto-publishes.
 * - `pending` — no decision, and not auto-published: it waits for review.
 */
export type DiseaseRowStatus = "confirmed" | "auto" | "pending" | "rejected";

export function diseaseRowStatus(row: DiseasePublishRow, autoPublish: boolean): DiseaseRowStatus {
  const decision = row.decision?.decision;
  if (decision === "confirmed") return "confirmed";
  if (decision === "rejected") return "rejected";
  if (autoPublish && row.assignment?.confidence === AUTO_PUBLISH_CONFIDENCE) return "auto";
  return "pending";
}

/** Published = a curator confirmed it, or the center auto-publishes it. */
export function isDiseasePublished(row: DiseasePublishRow, autoPublish: boolean): boolean {
  const status = diseaseRowStatus(row, autoPublish);
  return status === "confirmed" || status === "auto";
}
