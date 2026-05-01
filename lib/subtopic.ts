/**
 * Convert a subtopic slug (e.g. "breast_screening_risk_prediction") into a
 * human-readable title-case label (e.g. "Breast Screening Risk Prediction").
 *
 * The transform is deterministic and lossy on acronyms (e.g. "hiv_aids" →
 * "Hiv Aids" not "HIV/AIDS"). This is acceptable per Phase 3 design spec
 * v1.7.1 editorial-copy strategy: top ~300 hand-curated descriptions land
 * post-launch; the long tail uses the deterministic transform.
 *
 * Source: 03-RESEARCH.md Pattern 5; 02-SCHEMA-DECISION.md confirms no
 * canonical label exists in DynamoDB or in PublicationTopic JSON fields.
 */
export function subtopicLabel(slug: string): string {
  if (!slug) return "";
  return slug
    .split("_")
    .map((w) => (w.length === 0 ? "" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
