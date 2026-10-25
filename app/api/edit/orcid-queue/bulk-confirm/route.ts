/**
 * `POST /api/edit/orcid-queue/bulk-confirm` — "Confirm remaining N" on the
 * ORCID queue's Strong or Shared papers tab. Body `{ band, sampleId, filter? }`.
 *
 * v2: `filter` is the page's `{ types, units, sources }`. The sample must have
 * been drawn under the SAME filter (409 `filter_mismatch` otherwise), and only
 * the band's rows inside it are confirmed. The one-row-per-scholar and
 * best-band rules read each scholar's full candidate set, never the filtered
 * one (`loadQualifying`).
 *
 * Refused (409) unless `sampleId` is the band's LATEST sample and it is passed
 * (every row decided, none "Not this person"): a stale sample, an open one and
 * a locked one all say so. A passed sample is also stale once a later ETL run
 * re-scored the band (any of its evidence rows `computed_at` after the sample
 * started): it measured a population that is gone. Then every remaining row of the band is re-read on
 * the writer and confirmed only if it STILL qualifies — band unchanged, no iD
 * on file, no dismissal, one row for the scholar — so a row that changed since
 * the page loaded is skipped, not overwritten. Each confirm re-checks
 * `orcid IS NULL` in its own write.
 *
 * Writes go in batches of BATCH, one transaction each (TX_OPTIONS: a batch is
 * ~8 round trips per row, past Prisma's 5s default), every confirm with its
 * own `orcid_librarian_confirm` audit row (method `librarian`, the real
 * librarian as `orcid_confirmed_by`). One `orcid_bulk_confirm` row with the
 * counts and the sample id follows the batches; when a later batch fails after
 * earlier ones committed, that row is still written with `partial: true` and
 * the count that did commit, before the 500. Returns `{ confirmed, skipped }`.
 *
 * Same gates as the decide route: flag (404), preamble, View as (403),
 * `isSuperuser` (403).
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { runAfterResponse } from "@/lib/edit/after-response";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import {
  isOrcidLibrarianQueueEnabled,
  isOrcidSampleBand,
  orcidQueueFilterKey,
  sanitizeOrcidQueueFilter,
} from "@/lib/edit/orcid-queue";
import {
  confirmPair,
  isSampleStale,
  loadLatestSample,
  loadQualifying,
  OrcidQueueRefused,
} from "@/lib/edit/orcid-queue.server";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange } from "@/lib/edit/revalidation";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/orcid-queue/bulk-confirm";
const BATCH = 50;
const TX_OPTIONS = { maxWait: 5000, timeout: 30000 };

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isOrcidLibrarianQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (impersonatedCwid !== null) return editError(403, "impersonation_refused");
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "orcid-queue",
      path: PATH,
      reason: "not_superuser",
    });
    return editError(403, "not_superuser");
  }
  if (!isOrcidSampleBand(body.band)) return editError(400, "invalid_body", "band");
  const band = body.band;
  const sampleId = body.sampleId;
  if (typeof sampleId !== "string" || sampleId.length === 0 || sampleId.length > 64) {
    return editError(400, "invalid_body", "sampleId");
  }
  const filter = sanitizeOrcidQueueFilter(body.filter);
  if (!filter) return editError(400, "invalid_body", "filter");

  const ts = new Date();
  let confirmed: string[] = [];
  let skipped = 0;
  try {
    const latest = await loadLatestSample(db.write, band);
    if (!latest || latest.id !== sampleId) return editError(409, "stale_sample");
    if (latest.filterKey !== orcidQueueFilterKey(filter)) return editError(409, "filter_mismatch");
    if (latest.status === "locked") return editError(409, "sample_locked");
    if (latest.status !== "passed") return editError(409, "sample_not_passed");
    if (await isSampleStale(db.write, band, new Date(latest.startedAt)))
      return editError(409, "stale_sample");

    const inSample = new Set(latest.pairs.map((p) => `${p.cwid}|${p.orcid}`));
    const { qualifying, total } = await loadQualifying(db.write, band, filter);
    const todo = qualifying.filter((q) => !inSample.has(`${q.cwid}|${q.orcid}`));
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const done = await db.write.$transaction(async (tx) => {
        const ok: string[] = [];
        for (const p of batch) {
          // Re-read on the writer: the band must still be this one.
          const now = await tx.orcidCandidateEvidence.findUnique({
            where: { cwid_orcid: { cwid: p.cwid, orcid: p.orcid } },
            select: { band: true },
          });
          const dismissed = await tx.orcidDismissal.findUnique({
            where: { cwid_orcid: { cwid: p.cwid, orcid: p.orcid } },
          });
          if (now?.band !== band || dismissed) continue;
          try {
            await confirmPair(tx, p, {
              actor: realCwid,
              impersonatedCwid,
              requestId,
              ts,
              sampleId,
              bulk: true,
            });
            ok.push(p.cwid);
          } catch (err) {
            // An iD landed on file since the read: skip it, keep the batch.
            if (err instanceof OrcidQueueRefused && err.status === 409) continue;
            throw err;
          }
        }
        return ok;
      }, TX_OPTIONS);
      confirmed = confirmed.concat(done);
    }
    skipped = total - latest.pairs.length - confirmed.length;
    if (skipped < 0) skipped = 0;

    await writeBulkAudit({
      band,
      confirmed: confirmed.length,
      skipped,
      ...(latest.filterKey ? { filter: latest.filterKey } : {}),
    });
  } catch (err) {
    logEditFailure(PATH, err);
    // Earlier batches committed: audit what did land, and reflect those profiles.
    if (confirmed.length > 0) {
      try {
        await writeBulkAudit({ band, confirmed: confirmed.length, partial: true });
      } catch (auditErr) {
        logEditFailure(`${PATH}#partial-audit`, auditErr);
      }
      reflect(confirmed);
    }
    return editError(500, "write_failed");
  }

  reflect(confirmed);
  return editOk({ confirmed: confirmed.length, skipped });

  async function writeBulkAudit(afterValues: Record<string, unknown>) {
    await db.write.$transaction(async (tx) => {
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "orcid_queue_sample",
        targetEntityId: sampleId as string,
        action: "orcid_bulk_confirm",
        fieldsChanged: null,
        beforeValues: null,
        afterValues,
        ts,
        requestId,
      });
    });
  }
}

/** The confirmed iDs feed the profiles' JSON-LD sameAs: reflect them after the response. */
function reflect(cwids: string[]) {
  if (cwids.length === 0) return;
  runAfterResponse(async () => {
    const slugs = (
      await db.read.scholar.findMany({ where: { cwid: { in: cwids } }, select: { slug: true } })
    ).map((s) => s.slug);
    await reflectVisibilityChange(slugs);
  });
}
