/**
 * GET /api/edit/feedback/export?from=YYYY-MM-DD&to=YYYY-MM-DD&pageRoute=… — the raw
 * `feedback_submission` rows as RFC 4180 CSV, every column
 * (docs/feedback-badge-spec.md § CSV export endpoint). Default window: the
 * last 30 days.
 *
 * Mounted under `/api/edit/` (the spec says `/api/feedback/export`) on purpose:
 * that prefix is the one CloudFront forwards cookies + query string for,
 * uncached (`cdk/lib/edge-stack.ts` `/api/edit*`), and the proxy 401s it with
 * no session. A bare `/api/feedback/*` path would fall to the cacheable default
 * behavior, which strips the session cookie and `?from&to`.
 *
 * Gate: a signed-in session whose REAL cwid (never a "View as" target) is a
 * superuser AND on `FEEDBACK_EXPORT_ALLOWLIST`. Superuser alone is not enough:
 * the IRB protocol names who may read raw responses. 401 / 403 otherwise.
 *
 * Every successful export appends one B03 audit row (`feedback_export`) with
 * the filters and row count, BEFORE the file is returned: if the audit write
 * fails the export fails, so no raw-text download goes unlogged.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";

import { getEffectiveCwid } from "@/lib/auth/effective-identity";
import { getSession } from "@/lib/auth/session-server";
import { isSuperuser } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { editError } from "@/lib/edit/request";
import {
  FEEDBACK_EXPORT_LIMIT,
  feedbackToCsv,
  isFeedbackExportAllowlisted,
  parseFeedbackExportFilters,
} from "@/lib/feedback/export";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/feedback/export";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return editError(401, "unauthenticated");
  const realCwid = session.cwid;

  const allowed =
    isFeedbackExportAllowlisted(realCwid, process.env.FEEDBACK_EXPORT_ALLOWLIST) &&
    (await isSuperuser(realCwid));
  if (!allowed) {
    logEditDenial({ actorCwid: realCwid, targetCwid: "feedback", path: PATH, reason: "not_feedback_exporter" });
    return editError(403, "not_feedback_exporter");
  }

  const filters = parseFeedbackExportFilters(request.nextUrl.searchParams);
  if ("error" in filters) return editError(400, filters.error, filters.field);

  try {
    const rows = await db.read.feedbackSubmission.findMany({
      where: {
        submittedAt: { gte: filters.start, lt: filters.endExclusive },
        ...(filters.pageRoute ? { pageRoute: filters.pageRoute } : {}),
      },
      orderBy: { submittedAt: "asc" },
      take: FEEDBACK_EXPORT_LIMIT,
    });

    const effective = getEffectiveCwid(session);
    await appendAuditRow(db.write, {
      actorCwid: realCwid,
      targetEntityType: "feedback_submission",
      targetEntityId: "export",
      action: "feedback_export",
      fieldsChanged: null,
      beforeValues: null,
      afterValues: {
        from: filters.from,
        to: filters.to,
        pageRoute: filters.pageRoute,
        rows: rows.length,
      },
      ts: new Date(),
      requestId: randomUUID(),
      impersonatedCwid: effective !== realCwid ? effective : null,
    });

    const csv = feedbackToCsv(rows, rows.length >= FEEDBACK_EXPORT_LIMIT);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="feedback-${filters.from}-${filters.to}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "feedback_export_failed",
        path: PATH,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return editError(500, "export_unavailable");
  }
}
