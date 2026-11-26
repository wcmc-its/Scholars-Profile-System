/**
 * `POST /api/edit/orcid-queue/bulk-confirm` — confirm many queue pairs at once
 * (`/edit/orcid-queue`, Bulk review).
 *
 * Body `{ pairs: [{ cwid, orcid }], rule: { minShared, maxOnlyOrcid,
 * allowMultiple?, allowNameDiffers?, passesBy? } }`, at most `ORCID_BULK_MAX`
 * pairs. The librarian picks the pairs in the browser under an adjustable rule
 * (`bulkEligible`); the rule is recorded on each confirm's audit row. Two of its
 * flags loosen the floor for WCM pairs, and only when sent as `true`:
 * `allowMultiple` (the scholar's best iD of several) and `allowNameDiffers`.
 * Without them the floor is as strict as it gets. The server does not trust the
 * selection: each pair must also pass `assertBulkConfirmable` (the same
 * verified rule as `etl:bulk-confirm-strong`) and then goes through `confirmPair`, the same write as a single
 * Confirm, in its own transaction. A refused pair is skipped with its code; it
 * stays in the one-at-a-time queue.
 *
 * `dryRun: true` runs only `assertBulkConfirmable` and writes nothing: the Bulk
 * review list uses it so it shows only pairs the server will confirm, and its
 * "why not" counts from each refusal's `blocker`.
 *
 * Gates as `decide`: the queue flag (404), the shared preamble, View as (403),
 * `isSuperuser` (403).
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { normalizeOrcid } from "@/lib/edit/orcid";
import {
  isOrcidLibrarianQueueEnabled,
  ORCID_BULK_MAX,
  ORCID_BULK_ROUTES,
  type OrcidBulkBlocker,
} from "@/lib/edit/orcid-queue";
import {
  assertBulkConfirmable,
  bulkConfirmableMany,
  bulkPairFacts,
  confirmPair,
  OrcidQueueRefused,
} from "@/lib/edit/orcid-queue.server";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectOverviewEdit } from "@/lib/edit/revalidation";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/orcid-queue/bulk-confirm";
const RULE_KEYS = ["minShared", "maxOnlyOrcid"] as const;
const RULE_FLAGS = ["allowMultiple", "allowNameDiffers"] as const;

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
  const rule: Record<string, number | boolean | string> = {};
  for (const k of RULE_KEYS) {
    const v = ruleRaw[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_000)
      return editError(400, "invalid_body", "rule");
    rule[k] = v;
  }
  // Optional: absent = the strict floor.
  for (const k of RULE_FLAGS) {
    const v = ruleRaw[k];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return editError(400, "invalid_body", "rule");
    rule[k] = v;
  }
  if (ruleRaw.passesBy !== undefined) {
    if (!(ORCID_BULK_ROUTES as readonly unknown[]).includes(ruleRaw.passesBy))
      return editError(400, "invalid_body", "rule");
    rule.passesBy = ruleRaw.passesBy as string;
  }
  const floorRule = {
    allowMultiple: rule.allowMultiple === true,
    allowNameDiffers: rule.allowNameDiffers === true,
  };

  const dryRun = body.dryRun === true;
  const ts = new Date();
  const meta = { actor: realCwid, impersonatedCwid, requestId, ts, bulkRule: rule };
  const results: Array<{
    cwid: string;
    orcid: string;
    ok: boolean;
    code?: string;
    blocker?: OrcidBulkBlocker;
  }> = [];
  const refusedOrFailed = (pair: { cwid: string; orcid: string }, err: unknown) => {
    if (err instanceof OrcidQueueRefused)
      return {
        ...pair,
        ok: false,
        code: err.code,
        ...(err.blocker ? { blocker: err.blocker } : {}),
      };
    logEditFailure(PATH, err);
    return { ...pair, ok: false, code: "write_failed" };
  };
  if (dryRun) {
    // Read-only: the whole batch in a handful of queries (Bulk review checks ~3,000 pairs).
    const verdicts = await bulkConfirmableMany(db.write, pairs, floorRule);
    for (const pair of pairs) {
      const refused = verdicts.get(`${pair.cwid}|${pair.orcid}`);
      results.push(refused ? refusedOrFailed(pair, refused) : { ...pair, ok: true });
    }
  }
  for (const pair of dryRun ? [] : pairs) {
    try {
      await db.write.$transaction(async (tx) => {
        await assertBulkConfirmable(tx, pair, floorRule);
        await confirmPair(tx, pair, meta);
      });
      results.push({ ...pair, ok: true });
    } catch (err) {
      results.push(refusedOrFailed(pair, err));
    }
  }

  // The iD feeds each profile's JSON-LD sameAs.
  for (const r of results) {
    if (!r.ok || dryRun) continue;
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

  // Dry run: Bulk review's Name on ORCID and Verified email columns.
  if (dryRun) {
    const facts = await bulkPairFacts(
      db.read,
      results.filter((r) => r.ok),
    );
    return editOk({
      results: results.map((r) => ({ ...r, ...facts.get(`${r.cwid}|${r.orcid}`) })),
    });
  }

  return editOk({ results });
}
