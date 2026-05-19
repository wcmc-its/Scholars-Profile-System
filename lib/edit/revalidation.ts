/**
 * Self-edit v1 — post-commit reflection (#356, `self-edit-spec.md` § Post-commit
 * reflection).
 *
 * After an `/api/edit/*` write commits, three caches are refreshed in the
 * request path:
 *
 *   - **Next.js ISR** — `revalidatePath()` busts the per-route cache so the
 *     origin regenerates the affected pages.
 *   - **CloudFront CDN** — a `CreateInvalidation` purges the edge copy, since
 *     `revalidatePath()` does not. A ≤24h edge-cache window on a suppressed
 *     page reintroduces exactly the staleness the urgency split exists to
 *     eliminate. Dormant pre-launch (no `SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID`).
 *   - **OpenSearch index** — `reflectSearchSuppression` (Phase 4b C5,
 *     `lib/edit/search-suppression.ts`) writes the synchronous fast-path —
 *     ADR-005 failure-model layer 1. Closes the ≤24h gap between a
 *     suppress / revoke and the nightly `etl/search-index` rebuild.
 *
 * All three are **best-effort**: failures are logged, never thrown, so they
 * cannot roll back the already-committed write. The durable retry / outbox
 * for a failed CloudFront invalidation is #353; the equivalent for a failed
 * OpenSearch write is #393 (the reconciler — ADR-005 failure-model layer 3).
 *
 * This file owns the ISR + CloudFront half (`reflectVisibilityChange` and
 * `resolveAffectedProfileSlugs`). The OpenSearch fast-path lives in its own
 * module (`search-suppression.ts`), called from the suppress / revoke
 * endpoints alongside `reflectVisibilityChange`.
 *
 * v1 reflects the profile page and the browse hub. The wider department /
 * division / center / topic listing fan-out (`self-edit-spec.md`) is a
 * follow-on: it needs each listing entity's page slug resolved, which the
 * Phase 3/4 read helpers provide. Those listing pages show a name in a list,
 * not the profile itself, and ride the nightly rebuild until then.
 */
import { randomUUID } from "node:crypto";

import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { isAllowedRevalidatePath } from "@/lib/revalidate-allowlist";

/** Bust the Next.js ISR cache for each allow-listed path. */
function revalidatePaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (!isAllowedRevalidatePath(path)) {
      // Off the shared allow-list — a write-path bug. Log and skip, exactly as
      // the `/api/revalidate` HTTP handler rejects an off-list path.
      console.warn(JSON.stringify({ event: "edit_revalidate_skipped", path }));
      continue;
    }
    revalidatePath(path);
  }
}

/**
 * Issue a CloudFront invalidation for the given paths. Dormant when
 * `SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID` is unset (local / pre-launch) — exactly
 * as the superuser check is dormant without its group cn. A failure is logged,
 * never thrown.
 */
async function invalidateCloudFront(paths: readonly string[]): Promise<void> {
  const distributionId = process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID;
  if (!distributionId || paths.length === 0) return;
  try {
    const client = new CloudFrontClient({});
    await client.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: randomUUID(),
          Paths: { Quantity: paths.length, Items: [...paths] },
        },
      }),
    );
  } catch (err) {
    // A failed invalidation leaves a suppressed page edge-cached up to 24h.
    // v1 logs it; the durable retry/outbox is #353.
    console.error(
      JSON.stringify({
        event: "edit_cdn_invalidation_failed",
        paths,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Reflect an `overview` edit: bust the profile page. CloudFront's ≤24h lag is
 * acceptable for a corrected bio. A `slug` edit reflects nothing at write time
 * — the URL changes only when `etl/ed` consumes the override — so it has no
 * reflection.
 */
export function reflectOverviewEdit(slug: string): void {
  revalidatePaths([`/scholars/${slug}`]);
}

/**
 * Reflect a suppression or its revoke (scholar or publication): revalidate AND
 * issue a CloudFront invalidation for the affected profile pages and the
 * browse hub. `profileSlugs` is the set of `/scholars/{slug}` pages the change
 * touches — the suppressed scholar, or the displayed authors of a suppressed
 * publication.
 */
export async function reflectVisibilityChange(
  profileSlugs: readonly string[],
): Promise<void> {
  const paths = ["/browse", ...profileSlugs.map((slug) => `/scholars/${slug}`)];
  revalidatePaths(paths);
  await invalidateCloudFront(paths);
}

/**
 * The `/scholars/{slug}` pages a suppression or revoke touches: the suppressed
 * scholar, the hidden contributor of a per-author publication hide, or every
 * confirmed WCM author of a whole-publication takedown.
 */
export async function resolveAffectedProfileSlugs(
  entityType: string,
  entityId: string,
  contributorCwid: string | null,
): Promise<string[]> {
  if (entityType === "scholar") {
    const scholar = await db.read.scholar.findUnique({
      where: { cwid: entityId },
      select: { slug: true },
    });
    return scholar ? [scholar.slug] : [];
  }
  if (contributorCwid) {
    const scholar = await db.read.scholar.findUnique({
      where: { cwid: contributorCwid },
      select: { slug: true },
    });
    return scholar ? [scholar.slug] : [];
  }
  // Whole-publication takedown — every confirmed WCM author's profile.
  const authors = await db.read.publicationAuthor.findMany({
    where: { pmid: entityId, cwid: { not: null }, isConfirmed: true },
    select: { scholar: { select: { slug: true } } },
  });
  return authors.flatMap((a) => (a.scholar ? [a.scholar.slug] : []));
}
