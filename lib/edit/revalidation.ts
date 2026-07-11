/**
 * Self-edit v1 — post-commit reflection (#356, `self-edit-spec.md` § Post-commit
 * reflection).
 *
 * After an `/api/edit/*` write commits, three caches are refreshed:
 *
 *   - **Next.js ISR** — `revalidatePath()` busts the per-route cache so the
 *     origin regenerates the affected pages. In-process and cheap, so it stays
 *     in the request path.
 *   - **CloudFront CDN** — a `CreateInvalidation` purges the edge copy, since
 *     `revalidatePath()` does not. A ≤24h edge-cache window on a suppressed
 *     page reintroduces exactly the staleness the urgency split exists to
 *     eliminate. The durable outbox row is enqueued in the request path, but
 *     the slow AWS `CreateInvalidation` round-trip runs AFTER the response
 *     (#955 #6 — `runAfterResponse`). Dormant pre-launch (no
 *     `SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID`).
 *   - **OpenSearch index** — `reflectSearchSuppression` (Phase 4b C5,
 *     `lib/edit/search-suppression.ts`) writes the fast-path — ADR-005
 *     failure-model layer 1. The suppress / revoke / reject routes now schedule
 *     it AFTER the response too (#955 #6); it closes the ≤24h gap to the nightly
 *     `etl/search-index` rebuild.
 *
 * All three are **best-effort**: failures are logged, never thrown, so they
 * cannot roll back the already-committed write. Because the slow reflections run
 * off the request path, the durable backstops carry them home: a failed (or
 * lost) CloudFront invalidation is retried from the #353 outbox row enqueued
 * in-path; a failed OpenSearch write is retried by #393 from the suppression
 * row's NULL `searchReflectedAt` sentinel (both ADR-005 failure-model layer 3).
 *
 * This file owns the ISR + CloudFront half. Every content-edit reflector
 * (`reflectVisibilityChange`, `reflectOverviewEdit`, `reflectUnitChange`)
 * busts the ISR cache and purges the edge copy through the shared
 * `invalidateCloudFront` outbox. The OpenSearch fast-path lives in its own
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

import { bust } from "@/lib/api/swr-cache";
import { db } from "@/lib/db";
import { runAfterResponse } from "@/lib/edit/after-response";
import { isAllowedRevalidatePath } from "@/lib/revalidate-allowlist";
import { canonicalProfilePath } from "@/lib/profile-url";

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
 * Send one `CreateInvalidation` for the given paths against a distribution.
 * The single low-level CloudFront call, factored out so the synchronous
 * write-path enqueue (`invalidateCloudFront`) and the durable reconciler
 * (`lib/edit/cdn-reconcile.ts`) drive the exact same client + command — no
 * duplicated SDK shape that could drift between the two. Throws on SDK error;
 * the callers decide how to record the failure (enqueue row vs. retry row).
 */
export async function sendCloudFrontInvalidation(
  distributionId: string,
  paths: readonly string[],
): Promise<void> {
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
}

/**
 * Issue a CloudFront invalidation for the given paths and durably record it in
 * the `cdn_invalidation` outbox (#353 — ADR-005 failure-model layer 3).
 *
 * Dormant when `SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID` is unset (local /
 * pre-launch) — exactly as the superuser check is dormant without its group cn:
 * no enqueue, no send. Otherwise the flow is enqueue-then-attempt:
 *
 *   1. INSERT a pending row remembering the EXACT paths (JSON). Critically,
 *      these are NOT recomputable later — a slug flip, a `PROFILE_CANONICAL`
 *      change, or a mutated author set makes the originally-cached path
 *      underivable — so the outbox persists them verbatim. This is the
 *      deliberate point of difference from #393's recompute-from-DB sentinel.
 *   2. Attempt the `CreateInvalidation`. On success, stamp `invalidatedAt`. On
 *      failure, record `attempts = 1` + `lastError` and leave `invalidatedAt`
 *      NULL so the reconciler retries it on its ≤5 min cadence.
 *
 * Entirely best-effort: a CloudFront error, AND even a DB enqueue failure, is
 * logged — never thrown — so it cannot roll back the already-committed write.
 * If the enqueue itself fails we still attempt a one-shot send (the original
 * pre-outbox behavior) so the common case still purges the edge.
 */
async function invalidateCloudFront(paths: readonly string[]): Promise<void> {
  const distributionId = process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID;
  if (!distributionId || paths.length === 0) return;

  // 1. Enqueue a pending outbox row IN the request path, remembering the exact
  //    (non-recomputable) paths. This durable row is the #353 backstop, so it
  //    must be written synchronously: if the deferred send below never completes
  //    (process death) or fails, the reconciler still has the row to retry.
  //    Best-effort — if the INSERT itself fails we log and still schedule a
  //    best-effort one-shot send without a row to mark.
  let rowId: string | null = null;
  try {
    const row = await db.write.cdnInvalidation.create({
      data: { paths: JSON.stringify([...paths]), attempts: 0 },
      select: { id: true },
    });
    rowId = row.id;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "edit_cdn_invalidation_enqueue_failed",
        paths,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // 2. Defer the slow CloudFront `CreateInvalidation` (an AWS API round-trip)
  //    off the request path (#955 #6). The edit POST returns as soon as the
  //    durable row above is enqueued; the purge lands right after the response,
  //    and the #353 reconciler retries on its ≤5 min cadence if the deferred
  //    send is lost or fails.
  runAfterResponse(() => sendAndRecordCloudFront(distributionId, paths, rowId));
}

/**
 * Send one CloudFront invalidation and record the outcome on its outbox row —
 * stamp `invalidatedAt` on success, or `attempts`/`lastError` on failure (left
 * pending for the #353 reconciler). Split out of `invalidateCloudFront` so it
 * can run AFTER the response (#955 #6). Entirely best-effort: every failure is
 * logged, never thrown, so it cannot disturb the already-committed write.
 */
async function sendAndRecordCloudFront(
  distributionId: string,
  paths: readonly string[],
  rowId: string | null,
): Promise<void> {
  try {
    await sendCloudFrontInvalidation(distributionId, paths);
    if (rowId) {
      await db.write.cdnInvalidation
        .update({ where: { id: rowId }, data: { invalidatedAt: new Date() } })
        .catch((err) => {
          // The purge landed; only the bookkeeping stamp failed. The reconciler
          // will harmlessly re-send and re-stamp this still-pending row.
          console.error(
            JSON.stringify({
              event: "edit_cdn_invalidation_mark_failed",
              id: rowId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
    }
  } catch (err) {
    // A failed invalidation leaves a suppressed page edge-cached up to 24h.
    // The row stays pending (invalidatedAt NULL) so the #353 reconciler retries.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "edit_cdn_invalidation_failed",
        paths,
        error: message,
      }),
    );
    if (rowId) {
      await db.write.cdnInvalidation
        .update({ where: { id: rowId }, data: { attempts: 1, lastError: message } })
        .catch(() => {});
    }
  }
}

/**
 * Reflect an `overview` edit: bust the profile page. A corrected bio is a
 * content edit, so the edge copy is purged alongside the ISR cache — the same
 * ≤24h-staleness argument that makes `reflectVisibilityChange` invalidate
 * CloudFront applies here. A `slug` edit reflects nothing at write time — the
 * URL changes only when `etl/ed` consumes the override — so it has no
 * reflection.
 */
export async function reflectOverviewEdit(slug: string): Promise<void> {
  // #671 — revalidate the current canonical profile form per PROFILE_CANONICAL
  // (`/scholars/{slug}` by default, root `/{slug}` after the flip).
  const paths = [canonicalProfilePath(slug)];
  revalidatePaths(paths);
  await invalidateCloudFront(paths);
}

/**
 * Reflect a dept/div/center field edit or retire: revalidate the unit page
 * (and, for a division, the parent department whose divisions list shows
 * the chief) and `/browse` (the unit facet). #540 SPEC § Write-path behavior.
 * These are content edits, so the edge copy is purged alongside the ISR cache,
 * matching `reflectVisibilityChange`.
 *
 * `slug` field edits on dept/div have no immediate URL flip — that rides the
 * next `etl/ed` run; the route therefore skips this helper for `slug`.
 * Centers update slug in-row, so the route passes both the old and new slug
 * here.
 */
export async function reflectUnitChange(params: {
  unitKind: "department" | "division" | "center";
  /** For dept/center: the dept/center slug. For division: the division slug. */
  unitSlug: string;
  /** For division: the parent department slug (its page lists the chief). */
  parentDeptSlug?: string;
  /** For a center slug change: the previous slug whose URL flips. */
  previousSlug?: string | null;
  /** #1117 — for a center program edit (leaders/description), the program code
   *  whose dedicated page `/centers/{slug}/programs/{code}` must also flush. */
  programCode?: string;
}): Promise<void> {
  const paths: string[] = ["/browse"];
  if (params.unitKind === "department") {
    paths.push(`/departments/${params.unitSlug}`);
  } else if (params.unitKind === "division") {
    if (params.parentDeptSlug) {
      paths.push(`/departments/${params.parentDeptSlug}`);
      paths.push(
        `/departments/${params.parentDeptSlug}/divisions/${params.unitSlug}`,
      );
    }
  } else {
    paths.push(`/centers/${params.unitSlug}`);
    if (params.previousSlug && params.previousSlug !== params.unitSlug) {
      paths.push(`/centers/${params.previousSlug}`);
    }
    // #1117 — the program's own ISR page renders the leaders/description.
    if (params.programCode) {
      paths.push(`/centers/${params.unitSlug}/programs/${params.programCode}`);
    }
  }
  revalidatePaths(paths);
  // #1537 — the ISR/CDN busts above don't touch the in-process swr-cache Map
  // that getCenter/getDepartment/getDivision (+ their members/pubs/spotlight
  // reads) serve through, so the origin task would re-serve the pre-edit rollup
  // for up to MAX_STALE_MS. A division edit also mutates the parent department
  // page (it lists the chief), so bust that prefix too.
  const bustPrefixes =
    params.unitKind === "division"
      ? ["division:", "department:"]
      : [`${params.unitKind}:`];
  for (const prefix of bustPrefixes) bust(prefix);
  await invalidateCloudFront(paths);
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
  // #671 — the current canonical profile form per slug (PROFILE_CANONICAL).
  const paths = ["/browse", ...profileSlugs.map((slug) => canonicalProfilePath(slug))];
  revalidatePaths(paths);
  // #1537 — the cached methods rollup filters its pmid union through the
  // suppression layer, so a publication/scholar suppression must evict it or
  // the /methods pages re-serve the suppressed work for up to MAX_STALE_MS.
  bust("methods:");
  await invalidateCloudFront(paths);
}

/** The slug + cwid pair for one profile a suppression or revoke touches. */
export type AffectedProfile = {
  readonly slug: string;
  readonly cwid: string;
};

/**
 * The profiles a suppression or revoke touches — the suppressed scholar, the
 * hidden contributor of a per-author publication hide, or every confirmed WCM
 * author of a whole-publication takedown.
 *
 * Returns `{ slug, cwid }` rather than slugs only so both reflections walk an
 * identical author set from a single Prisma query: `reflectVisibilityChange`
 * (ISR + CloudFront) reads `.slug`, `reflectSearchSuppression` (OpenSearch
 * fast-path) reads `.cwid`. Sibling resolvers would risk drift the next time
 * someone adds (e.g.) a `scholar: { deletedAt: null }` filter to one and
 * forgets the other (Phase 4b plan §3 tightening C7).
 */
export async function resolveAffectedProfiles(
  entityType: string,
  entityId: string,
  contributorCwid: string | null,
): Promise<AffectedProfile[]> {
  if (entityType === "scholar") {
    const scholar = await db.read.scholar.findUnique({
      where: { cwid: entityId },
      select: { slug: true, cwid: true },
    });
    return scholar ? [{ slug: scholar.slug, cwid: scholar.cwid }] : [];
  }
  // Whole-entity types (#160): the one owning scholar's profile. `entityId` is
  // the stable `externalId`; the scholar relation gives slug (ISR) + cwid.
  if (entityType === "education") {
    const row = await db.read.education.findUnique({
      where: { externalId: entityId },
      select: { scholar: { select: { slug: true, cwid: true } } },
    });
    return row?.scholar ? [{ slug: row.scholar.slug, cwid: row.scholar.cwid }] : [];
  }
  if (entityType === "appointment") {
    const row = await db.read.appointment.findUnique({
      where: { externalId: entityId },
      select: { scholar: { select: { slug: true, cwid: true } } },
    });
    return row?.scholar ? [{ slug: row.scholar.slug, cwid: row.scholar.cwid }] : [];
  }
  if (entityType === "grant") {
    const row = await db.read.grant.findUnique({
      where: { externalId: entityId },
      select: { scholar: { select: { slug: true, cwid: true } } },
    });
    return row?.scholar ? [{ slug: row.scholar.slug, cwid: row.scholar.cwid }] : [];
  }
  if (entityType === "mentee") {
    // A mentee hide/show touches the MENTOR's profile (where the mentee chip
    // renders). `entityId` is `{mentorCwid}:{menteeCwid}`; the owner is the
    // mentor segment. Resolve their slug for the ISR bust + CDN invalidation.
    const mentorCwid = entityId.split(":")[0];
    if (!mentorCwid) return [];
    const scholar = await db.read.scholar.findUnique({
      where: { cwid: mentorCwid },
      select: { slug: true, cwid: true },
    });
    return scholar ? [{ slug: scholar.slug, cwid: scholar.cwid }] : [];
  }
  if (contributorCwid) {
    const scholar = await db.read.scholar.findUnique({
      where: { cwid: contributorCwid },
      select: { slug: true, cwid: true },
    });
    return scholar ? [{ slug: scholar.slug, cwid: scholar.cwid }] : [];
  }
  // Whole-publication takedown — every confirmed WCM author's profile.
  const authors = await db.read.publicationAuthor.findMany({
    where: { pmid: entityId, cwid: { not: null }, isConfirmed: true },
    select: { cwid: true, scholar: { select: { slug: true } } },
  });
  return authors.flatMap((a) =>
    a.scholar && a.cwid ? [{ slug: a.scholar.slug, cwid: a.cwid }] : [],
  );
}
