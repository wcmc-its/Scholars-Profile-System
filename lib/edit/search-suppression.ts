/**
 * Self-edit v1 #356 Phase 4b — OpenSearch suppression fast-path.
 *
 * Reflects a suppress / revoke commit into the OpenSearch index
 * synchronously, alongside the ISR + CloudFront reflection in
 * `revalidation.ts`. Closes ADR-005 failure-model layer 1 — the
 * search-staleness gap between a suppress write and the nightly
 * `etl/search-index` rebuild (the D5.2 "Risk B" gap that ran ~24h until
 * Phase 4b).
 *
 * Best-effort by contract: failures are logged via
 * `edit_search_reflect_failed` and NEVER thrown. The suppress / revoke
 * endpoint must not roll back on a failed index write; the nightly
 * rebuild (layer 2) is the correctness backstop, and the durable
 * reconciler (layer 3 — #393) is the recovery for fast-path writes lost
 * to a crash or a `bulk` partial failure. **A failed fast-path is not
 * recoverable by user retry** — the suppress endpoint's idempotency
 * early-return (route.ts:92) means re-submitting no-ops before reaching
 * this module.
 *
 * Asymmetric fan-out (Phase 4b plan §3, D4b.1):
 *   - scholar suppress: delete the people doc for cwid.
 *   - scholar revoke:   re-index the people doc (or delete if the
 *                       scholar is no longer indexable per
 *                       PEOPLE_INDEX_WHERE).
 *   - publication per-author hide / its revoke:
 *       re-index the pub doc (delete if `buildPublicationDoc` returns
 *       null) PLUS re-index the contributor's people doc.
 *   - publication whole-pub takedown / its revoke:
 *       re-index the pub doc (delete if dark) PLUS re-index every
 *       confirmed WCM co-author's people doc.
 *   - grant suppress / revoke (#481(a)):
 *       re-project the affected funding project from its surviving rows
 *       (delete the funding doc if the project goes dark). Funding index
 *       only — no people-doc fan-out.
 *
 * The publication-side people-doc set is supplied by the caller as
 * `affectedCwids` — the cwid half of `resolveAffectedProfiles`'s result
 * (`revalidation.ts`): contributor on a per-author hide; every confirmed
 * WCM co-author on a takedown. Bounded by the publication's author count.
 *
 * All index operations for one `reflectSearchSuppression` call are sent
 * as a single `client.bulk` request — one round trip, not N.
 *
 * Latency budget: the common path (scholar suppress, per-author
 * self-hide) is <1s p95 — one or two Prisma reads + one OpenSearch bulk.
 * Takedown fan-out scales with the publication's confirmed-WCM-author
 * count; acceptable as a rare, superuser-only action. Missing the
 * common-path budget is the signal to move the fast-path async — which
 * is the reconciler.
 *
 * Dormant-safe: `searchClient()` targets `OPENSEARCH_NODE`. If the
 * cluster is unreachable (local dev without the docker container,
 * pre-launch), the `bulk` call throws and we log + swallow — exactly
 * as `invalidateCloudFront` is dormant without its distribution ID.
 */
import {
  loadAllGrantSuppressions,
  loadPublicationSuppressions,
} from "@/lib/api/manual-layer";
import {
  loadFamilyOverlayGate,
  type FamilyOverlayGate,
} from "@/lib/api/methods-overlay";
import { coreProjectNum } from "@/lib/award-number";
import { db } from "@/lib/db";
import {
  GRANT_INDEX_SELECT,
  GRANT_INDEX_WHERE,
  groupGrantsByProject,
  parseExternalId,
  projectFromRows,
} from "@/lib/funding-projection";
import {
  FUNDING_INDEX,
  PEOPLE_INDEX,
  PUBLICATIONS_INDEX,
  searchClient,
} from "@/lib/search";
import {
  PEOPLE_INDEX_SELECT,
  PEOPLE_INDEX_WHERE,
  PUBLICATION_INDEX_INCLUDE,
  PUBLICATION_INDEX_WHERE,
  buildPeopleDoc,
  buildPublicationDoc,
  isRequireDisplayableAuthorEnabled,
  loadMeshAncestorContext,
  type MeshAncestorContext,
} from "@/lib/search-index-docs";

/**
 * The descriptor the suppress / revoke endpoints already hold post-commit.
 *
 * `affectedCwids` is the cwid half of `resolveAffectedProfiles`'s result, passed
 * through so the fast-path and ISR/CloudFront reflection walk an identical
 * author set from one Prisma query (plan §3 tightening C7). For scholar
 * entityType it is `[entityId]`; for publication per-author hide it is
 * `[contributorCwid]`; for a publication takedown it is every confirmed WCM
 * co-author's cwid.
 */
export type ReflectSearchSuppressionArgs = {
  /**
   * The `suppression` row this reflection corresponds to. On full success the
   * reflector stamps `searchReflectedAt = now()` on this row so the #393
   * reconciler skips it; on failure it is left NULL for the reconciler to
   * retry. Both call sites (suppress / revoke routes) and the reconciler hold
   * this id.
   */
  suppressionId: string;
  entityType: string;
  entityId: string;
  contributorCwid: string | null;
  affectedCwids: readonly string[];
};

/**
 * The outcome of a reflection. The route call sites ignore it (best-effort
 * contract unchanged); the #393 reconciler reads `.ok` to log a retry-shaped
 * failure. Note the stamp-on-success lives inside the reflector itself, so
 * `{ ok: true }` already means the sentinel was advanced (best-effort).
 */
export type ReflectResult = { ok: true } | { ok: false; error: unknown };

type Op =
  | { type: "delete"; index: string; id: string }
  | { type: "index"; index: string; id: string; doc: Record<string, unknown> };

type BulkItem = {
  delete?: { error?: unknown; status?: number };
  index?: { error?: unknown };
};

export async function reflectSearchSuppression(
  args: ReflectSearchSuppressionArgs,
): Promise<ReflectResult> {
  try {
    const ops = await buildReflectionOps(args);
    if (ops.length === 0) {
      // Non-search entity type (education / appointment / grant): nothing to
      // reflect. We do NOT stamp — the reconciler excludes these by entity
      // type, so the sentinel staying NULL for them is inert.
      return { ok: true };
    }
    const client = searchClient();
    const body: Array<Record<string, unknown>> = [];
    for (const op of ops) {
      if (op.type === "delete") {
        body.push({ delete: { _index: op.index, _id: op.id } });
      } else {
        body.push({ index: { _index: op.index, _id: op.id } });
        body.push(op.doc);
      }
    }
    const resp = await client.bulk({ refresh: true, body });
    if (resp.body.errors) {
      // OpenSearch 404 on a `delete` is fine — the doc may already be
      // absent on a stale rebuild or a never-built index. Surface any
      // OTHER per-item error.
      const failed = (resp.body.items as BulkItem[]).filter((it) => {
        if (it.delete?.error && it.delete?.status !== 404) return true;
        if (it.index?.error) return true;
        return false;
      });
      if (failed.length > 0) {
        logReflectFailure(args, failed);
        return { ok: false, error: failed };
      }
    }
    // Full success — advance the reconciler sentinel so this row is not
    // re-processed. Best-effort: a stamp failure leaves the (already-correct)
    // index untouched and the reconciler re-reflects idempotently.
    await markSearchReflected(args.suppressionId);
    return { ok: true };
  } catch (err) {
    logReflectFailure(args, err);
    return { ok: false, error: err };
  }
}

/**
 * Stamp `searchReflectedAt = now()` on a suppression row after a successful
 * reflection. Never throws — the OpenSearch write already succeeded; only the
 * sentinel advance can fail here, and the reconciler is the backstop.
 */
async function markSearchReflected(suppressionId: string): Promise<void> {
  try {
    await db.write.suppression.update({
      where: { id: suppressionId },
      data: { searchReflectedAt: new Date() },
    });
  } catch {
    // Swallow — see the function contract above.
  }
}

async function buildReflectionOps(
  args: ReflectSearchSuppressionArgs,
): Promise<Op[]> {
  if (args.entityType === "scholar") {
    return buildScholarOps(args.entityId);
  }
  if (args.entityType === "publication") {
    return buildPublicationOps(args.entityId, args.affectedCwids);
  }
  if (args.entityType === "grant") {
    // #481(a) — synchronous funding-search fast-path. entityId is the grant's
    // stable externalId (#352). Suppressing a grant role does NOT touch the
    // people index: the people-doc grant facets (hasActiveGrants,
    // activePiGrantCount) are NOT suppression-filtered in the nightly build
    // either, so the fast-path stays consistent with a rebuild by emitting
    // funding ops only.
    return buildGrantOps(args.entityId);
  }
  // Education / appointment (#160) have no search index, so a suppression
  // reflects only through ISR (lib/edit/revalidation.ts) — no op here.
  return [];
}

/**
 * Funding-search fast-path for a grant suppress / revoke (#481(a)).
 *
 * A funding doc represents one project, keyed on the group key
 * `coreProjectNum(awardNumber) ?? accountNumber` — derived in app code, NOT a
 * queryable column. So we re-group the active grant set (a cheap two-column
 * scan) to compute this grant's project key and find the project's SURVIVING
 * sibling rows after the just-committed transition, then re-project ONLY that
 * project (or delete it when it goes dark). Never re-projects the whole index.
 *
 * This is the latency counterpart to the nightly rebuild, which already
 * excludes suppressed grant rows; on a best-effort failure it degrades to that
 * same rebuild (≤24h) and the #393 reconciler (≤5 min). Heavier than the
 * scholar / publication paths (one full-corpus key scan), but a grant suppress
 * is a rare curator / self action.
 */
async function buildGrantOps(externalId: string): Promise<Op[]> {
  const ext = parseExternalId(externalId);
  if (!ext) return []; // Not an InfoEd grant id — never indexed, nothing to do.

  const suppressed = await loadAllGrantSuppressions(db.read);
  // Cheap two-column scan: only externalId + awardNumber drive the group key,
  // so we avoid pulling the heavy GRANT_INDEX_SELECT (nested publications,
  // abstracts) across the whole corpus just to locate one project.
  const keyRows = await db.read.grant.findMany({
    where: GRANT_INDEX_WHERE,
    select: { externalId: true, awardNumber: true },
  });
  const byProject = groupGrantsByProject(keyRows, suppressed);

  // This grant's project key — the same derivation groupGrantsByProject uses,
  // so it matches the key its surviving siblings group under. The target row is
  // dropped from `byProject` when it is the suppressed role, but its
  // awardNumber is still present in the pre-drop scan.
  const targetAward =
    keyRows.find((r) => r.externalId === externalId)?.awardNumber ?? null;
  const projectKey = coreProjectNum(targetAward) ?? ext.accountNumber;

  const survivors = byProject.get(projectKey) ?? [];
  if (survivors.length === 0) {
    // No surviving role on any active scholar — the project goes dark.
    return [{ type: "delete", index: FUNDING_INDEX, id: projectKey }];
  }

  // Re-project from the surviving rows only: pull the full index select for
  // just this project (usually 1-5 rows) and run it through the SAME
  // projectFromRows the nightly build uses, so the fast-path doc is identical
  // to a rebuild's.
  const survivingIds = survivors
    .map((r) => r.externalId)
    .filter((id): id is string => id !== null);
  const projectRows = await db.read.grant.findMany({
    where: { externalId: { in: survivingIds }, ...GRANT_INDEX_WHERE },
    select: GRANT_INDEX_SELECT,
  });
  const doc = projectFromRows(projectRows);
  if (!doc) {
    return [{ type: "delete", index: FUNDING_INDEX, id: projectKey }];
  }
  // Pin the OpenSearch _id to the group key so it stays stable across
  // re-indexes even as merged Account_Numbers under one coreProjectNum change
  // (mirrors the ETL's projectId override).
  doc.projectId = projectKey;
  return [
    {
      type: "index",
      index: FUNDING_INDEX,
      id: projectKey,
      doc: doc as unknown as Record<string, unknown>,
    },
  ];
}

async function buildScholarOps(
  cwid: string,
  gate?: FamilyOverlayGate,
  meshAncestors?: MeshAncestorContext,
): Promise<Op[]> {
  // PEOPLE_INDEX_WHERE excludes suppressed / deleted scholars at the query
  // layer. A suppressed scholar's findFirst returns null → we issue a
  // delete; a revoked-to-active scholar returns the row → we re-index.
  const scholar = await db.read.scholar.findFirst({
    where: { cwid, ...PEOPLE_INDEX_WHERE },
    select: PEOPLE_INDEX_SELECT,
  });
  if (!scholar) {
    return [{ type: "delete", index: PEOPLE_INDEX, id: cwid }];
  }
  // Per-request, pmid-scoped — honors the manual-layer.ts contract.
  const sup = await loadPublicationSuppressions(
    scholar.authorships.map((a) => a.pmid),
    db.read,
  );
  // `buildPeopleDoc` issues the `centerMembership` and `mostRecentPubDate`
  // sidecar queries itself via the same client (lib/search-index-docs.ts —
  // D4b.3 sidecar model). Forward-compat null handling: with current
  // `PEOPLE_INDEX_WHERE`-filtered input the builder never returns null,
  // but the type permits it so a future builder-internal gate doesn't
  // require widening the fast-path's contract.
  //
  // #824 §4c — the public method-family overlay gate (loaded with
  // `forceSensitive: true`) makes `buildPeopleDoc` emit the `methodFamily`
  // rollup, so a single-doc fast-path update keeps it consistent with the
  // nightly public index (suppressed + sensitive families always excluded),
  // not just on the next full rebuild. The gate is scholar-INDEPENDENT, so the
  // `buildPublicationOps` fan-out loads it ONCE and passes it in; the lone
  // scholar entry path loads its own.
  const overlayGate =
    gate ?? (await loadFamilyOverlayGate({ forceSensitive: true }));
  // D-exact (search reason-from-doc) — keep `meshSubtreeCounts` on the
  // single-doc fast-path update so a per-scholar edit stays consistent with the
  // nightly index rather than dropping the field until the next full rebuild
  // (mirrors the overlay-gate threading above). Scholar-INDEPENDENT, so the
  // fan-out loads it ONCE and threads it; the lone-scholar entry loads its own.
  const ancestors =
    meshAncestors ?? (await loadMeshAncestorContext(db.read));
  const doc = await buildPeopleDoc(scholar, db.read, sup, overlayGate, ancestors);
  if (doc === null) {
    return [{ type: "delete", index: PEOPLE_INDEX, id: cwid }];
  }
  return [{ type: "index", index: PEOPLE_INDEX, id: cwid, doc }];
}

async function buildPublicationOps(
  pmid: string,
  affectedCwids: readonly string[],
): Promise<Op[]> {
  // `affectedCwids` is `resolveAffectedProfiles`'s cwid set, supplied by the
  // caller (plan §3 tightening C7): contributor on a per-author hide; every
  // confirmed WCM co-author on a takedown. One Prisma query upstream feeds
  // both this fast-path and the ISR/CloudFront slug reflection.
  const ops: Op[] = [];

  const pub = await db.read.publication.findFirst({
    where: { pmid, ...PUBLICATION_INDEX_WHERE },
    include: PUBLICATION_INDEX_INCLUDE,
  });
  if (!pub) {
    // Not in the index (filtered Retraction / Erratum, or row removed) —
    // issue a best-effort delete; a top-level 404 is swallowed.
    ops.push({ type: "delete", index: PUBLICATIONS_INDEX, id: pmid });
  } else {
    const supForPub = await loadPublicationSuppressions([pmid], db.read);
    // #718 — same gate as the ETL: when on, a pub left with no displayable WCM
    // author (e.g. its last visible author was just suppressed) is deleted from
    // the index rather than re-indexed author-less. Default off → unchanged.
    const doc = buildPublicationDoc(pub, supForPub, {
      requireDisplayableAuthor: isRequireDisplayableAuthorEnabled(),
    });
    if (doc === null) {
      ops.push({ type: "delete", index: PUBLICATIONS_INDEX, id: pmid });
    } else {
      ops.push({ type: "index", index: PUBLICATIONS_INDEX, id: pmid, doc });
    }
  }

  // Re-index the affected people docs in parallel (bounded by the pub's
  // co-author count). Each `buildScholarOps` opens its own per-scholar
  // queries; for a takedown of ~5-20 co-authors that's ≤80 reads, then
  // one bulk write.
  //
  // #824 §4c — the method-family overlay gate is scholar-INDEPENDENT, so load
  // it ONCE here and thread it into every `buildScholarOps` in the fan-out
  // (mirrors the nightly ETL's once-per-batch load) rather than re-scanning the
  // overlay tables per co-author.
  const gate = await loadFamilyOverlayGate({ forceSensitive: true });
  // D-exact — load the MeSH ancestor context ONCE here (scholar-independent,
  // like the gate) and thread it into every `buildScholarOps` in the fan-out so
  // each affected people doc keeps `meshSubtreeCounts` consistent with the nightly
  // index, without re-reading the descriptor table per co-author.
  const meshAncestors = await loadMeshAncestorContext(db.read);
  const scholarOpsArrays = await Promise.all(
    affectedCwids.map((c) => buildScholarOps(c, gate, meshAncestors)),
  );
  for (const arr of scholarOpsArrays) ops.push(...arr);
  return ops;
}

function logReflectFailure(
  args: ReflectSearchSuppressionArgs,
  error: unknown,
): void {
  console.error(
    JSON.stringify({
      event: "edit_search_reflect_failed",
      suppressionId: args.suppressionId,
      entityType: args.entityType,
      entityId: args.entityId,
      contributorCwid: args.contributorCwid,
      error: error instanceof Error ? error.message : error,
    }),
  );
}
