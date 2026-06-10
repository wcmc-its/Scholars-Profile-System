/**
 * Cross-scholar Method page URL shape (standalone Method pages plan §2).
 *
 * The Method taxonomy is two-level and NESTED in the route tree:
 *   - supercategory page  `/methods/{supercategorySlug}`
 *   - family page         `/methods/{supercategorySlug}/{familySlug}`
 *
 * Slugs are DETERMINISTIC — there is no DB slug column (same spirit as
 * `topic.id`-is-slug):
 *   - supercategory slug = `deriveSlug(supercategory.replace(/_/g, " "))`
 *     (`"animal_cell_models"` → `"animal-cell-models"`). The snake_case id is the
 *     stable identity; resolve back by re-deriving the slug for each known
 *     supercategory (closed ~14-set, cheap) and matching.
 *   - family slug = `${deriveSlug(familyLabel)}-${familyId}` — a readable label
 *     prefix plus the opaque `fam_NNNN` id suffix for collision-proofing. CRITICAL:
 *     `familyId` is re-minted on every A2 rebuild, so the family page's STABLE
 *     permalink identity is `(supercategory, familyLabel)`. The id suffix is only a
 *     within-manifest disambiguator; the loader resolves a page by re-deriving slugs
 *     and matching on `(supercategory, familyLabel)`, falling back to `familyId` only
 *     to break label-slug collisions.
 *
 * Pure module (no Prisma, no env) — safe in client components and on the server.
 */
import { deriveSlug } from "@/lib/slug";

/**
 * Slug for a supercategory id. `"animal_cell_models"` → `"animal-cell-models"`.
 * Replaces underscores with spaces first so `deriveSlug` collapses them to single
 * hyphens (it would otherwise drop a bare `_` as a non-slug char and glue words).
 */
export function supercategorySlug(supercategory: string): string {
  return deriveSlug(supercategory.replace(/_/g, " "));
}

/**
 * Slug for a family: `${deriveSlug(familyLabel)}-${familyId}`. When the label
 * derives to empty (non-romanizable), falls back to the bare `familyId` so the
 * segment is never just a leading hyphen. `("Regression modeling", "fam_0180")`
 * → `"regression-modeling-fam_0180"`.
 */
export function familySlug(familyLabel: string, familyId: string): string {
  const labelSlug = deriveSlug(familyLabel);
  return labelSlug ? `${labelSlug}-${familyId}` : familyId;
}

/** `/methods/{supercategorySlug}` — the supercategory page path. */
export function methodSupercategoryPath(supercategory: string): string {
  return `/methods/${supercategorySlug(supercategory)}`;
}

/** `/methods/{supercategorySlug}/{familySlug}` — the family page path. */
export function methodFamilyPath(
  supercategory: string,
  familyId: string,
  familyLabel: string,
): string {
  return `${methodSupercategoryPath(supercategory)}/${familySlug(familyLabel, familyId)}`;
}

/**
 * Extract the trailing A2 family id (`fam_NNNN`) from a family URL segment. The
 * loader uses this as the disambiguator when re-derived `(sc,label)` slug matching
 * finds more than one candidate. Returns null when the segment carries no
 * `fam_NNNN` suffix (a malformed or non-family slug). Matches the LAST `fam_NNNN`
 * occurrence so a family LABEL that itself contains `fam_…` can't shadow the id.
 *
 * `"regression-modeling-fam_0180"` → `"fam_0180"`; `"fam_0042"` → `"fam_0042"`.
 */
export function extractFamilyIdFromSlug(familySegment: string): string | null {
  const matches = familySegment.match(/fam_\d+/g);
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * Resolve a `{ supercategory, familyId, familyLabel }`-bearing row to the family
 * URL SEGMENT only (no `/methods/...` prefix) — the value compared against an
 * inbound `[family]` route param when matching by re-derived slug. Equivalent to
 * the last segment of {@link methodFamilyPath}.
 */
export function familySegmentFor(familyLabel: string, familyId: string): string {
  return familySlug(familyLabel, familyId);
}
