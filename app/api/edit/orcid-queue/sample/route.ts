/**
 * `POST /api/edit/orcid-queue/sample` — "Review a sample of 50" on the ORCID
 * queue's Strong or Shared papers tab. Body `{ band, restart?, filter? }`.
 * `filter` (v2) is the page's `{ types, units, sources }`: the sample is drawn
 * from the rows inside it and stores its key, so it authorizes bulk confirm
 * for that same filter only.
 *
 * Returns the band's open sample (undecided rows, no dismissal), or starts one:
 * up to 50 random rows of the band that qualify now (no iD on file, not
 * dismissed), fewer when the band is smaller. One open sample per band: a
 * passed or locked sample is not open, so "Review another sample" after a
 * lock starts a fresh one, which supersedes it for bulk confirm. Writes only
 * `orcid_queue_sample` rows (no scholar data changes, so no audit row).
 * `restart: true` abandons an open sample and starts a fresh one ("Start a new
 * sample"): a sampled pair that left the queue before it was decided must not
 * hold the band's gate shut for good.
 *
 * Same gates as the decide route: flag (404), preamble, View as (403),
 * `isSuperuser` (403).
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import {
  isOrcidLibrarianQueueEnabled,
  isOrcidSampleBand,
  sanitizeOrcidQueueFilter,
} from "@/lib/edit/orcid-queue";
import { openOrStartSample } from "@/lib/edit/orcid-queue.server";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/orcid-queue/sample";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isOrcidLibrarianQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body } = req.ctx;

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
  const restart = body.restart === true;
  const filter = sanitizeOrcidQueueFilter(body.filter);
  if (!filter) return editError(400, "invalid_body", "filter");

  try {
    const { sample, created } = await db.write.$transaction((tx) =>
      openOrStartSample(tx, band, realCwid, new Date(), { restart, filter }),
    );
    return editOk({ sample, created });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
}
