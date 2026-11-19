/**
 * `POST /api/edit/orcid-queue/bulk-confirm` — confirm many queue pairs at once
 * (`/edit/orcid-queue`, Bulk review).
 *
 * Body `{ pairs: [{ cwid, orcid }], rule: { minShared, maxOnlyOrcid,
 * minSources } }`, at most `ORCID_BULK_MAX` pairs. The librarian picks the pairs
 * in the browser under an adjustable rule (`bulkEligible`); the rule is
 * recorded on each confirm's audit row. The server does not trust the
 * selection: each pair must also pass `assertBulkConfirmable` (Strong, no
 * competitor, name agrees, nothing on file, the scholar's only open candidate,
 * WCM campus) and then goes through `confirmPair`, the same write as a single
 * Confirm, in its own transaction. A refused pair is skipped with its code; it
 * stays in the one-at-a-time queue.
 *
 * Gates as `decide`: the queue flag (404), the shared preamble, View as (403),
 * `isSuperuser` (403).
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { normalizeOrcid } from "@/lib/edit/orcid";
import { isOrcidLibrarianQueueEnabled, ORCID_BULK_MAX } from "@/lib/edit/orcid-queue";
import {
  assertBulkConfirmable,
  confirmPair,
  OrcidQueueRefused,
} from "@/lib/edit/orcid-queue.server";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectOverviewEdit } from "@/lib/edit/revalidation";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/orcid-queue/bulk-confirm";
const RULE_KEYS = ["minShared", "maxOnlyOrcid", "minSources"] as const;

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

  const raw = body.pairs;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ORCID_BULK_MAX)
    return editError(400, "invalid_body", "pairs");
  const pairs: Array<{ cwid: string; orcid: string }> = [];
  const seen = new Set<string>();
  for (const p of raw) {
    const cwid = (p as { cwid?: unknown })?.cwid;
    const orcidRaw = (p as { orcid?: unknown })?.orcid;
    if (typeof cwid !== "string" || cwid.length === 0 || cwid.length > 32)
      return editError(400, "invalid_cwid", "pairs");
    const orcid = typeof orcidRaw === "string" ? normalizeOrcid(orcidRaw) : null;
    if (!orcid) return editError(400, "invalid_orcid", "pairs");
    // One iD per scholar per request.
    if (seen.has(cwid)) return editError(400, "invalid_body", "pairs");
    seen.add(cwid);
    pairs.push({ cwid, orcid });
  }
  const ruleRaw = (body.rule ?? {}) as Record<string, unknown>;
  const rule: Record<string, number> = {};
  for (const k of RULE_KEYS) {
    const v = ruleRaw[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_000)
      return editError(400, "invalid_body", "rule");
    rule[k] = v;
  }

  const ts = new Date();
  const meta = { actor: realCwid, impersonatedCwid, requestId, ts, bulkRule: rule };
  const results: Array<{ cwid: string; orcid: string; ok: boolean; code?: string }> = [];
  for (const pair of pairs) {
    try {
      await db.write.$transaction(async (tx) => {
        await assertBulkConfirmable(tx, pair);
        await confirmPair(tx, pair, meta);
      });
      results.push({ ...pair, ok: true });
    } catch (err) {
      if (err instanceof OrcidQueueRefused) {
        results.push({ ...pair, ok: false, code: err.code });
        continue;
      }
      logEditFailure(PATH, err);
      results.push({ ...pair, ok: false, code: "write_failed" });
    }
  }

  // The iD feeds each profile's JSON-LD sameAs.
  for (const r of results) {
    if (!r.ok) continue;
    try {
      const s = await db.read.scholar.findUnique({
        where: { cwid: r.cwid },
        select: { slug: true },
      });
      if (s) await reflectOverviewEdit(s.slug);
    } catch (err) {
      logEditFailure(`${PATH}#reflect`, err);
    }
  }

  return editOk({ results });
}
