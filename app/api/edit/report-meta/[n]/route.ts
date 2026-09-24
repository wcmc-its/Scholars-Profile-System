/**
 * PUT /api/edit/report-meta/[n] — a superuser edits one report's slug, name,
 * one-line summary and rich-text description (`report_meta`,
 * `lib/edit/report-meta.ts`) from "Edit details" on `/edit/reports/[n]`
 * (`components/edit/report-details-sheet.tsx`).
 *
 * Body: `{ slug, name, summary, descriptionHtml, requestedBy?, requestedOn?,
 * requestMemo? }` — `slug` per
 * `isValidReportSlug` (a taken slug ⇒ 409 `slug_taken`, the unique index);
 * `name` 1..`REPORT_NAME_MAX` and `summary` 1..`REPORT_SUMMARY_MAX` after
 * trimming; `descriptionHtml` a
 * string (`""` = no description), run through the `overview` sanitizer
 * (`sanitizeOverview`, `lib/edit/validators.ts` — the security boundary; the
 * Tiptap schema on the client is only a UX convenience). The SANITIZED output
 * is what is stored; a structurally-empty result stores `NULL`. The request
 * record (`requestedBy` up to `REPORT_REQUESTED_BY_MAX`, `requestedOn` a
 * `YYYY-MM-DD` date, `requestMemo` up to `REPORT_REQUEST_MEMO_MAX`) is
 * optional per field: absent leaves the stored value, `""` or `null` clears it.
 *
 * Gate order (mirrors `/api/edit/report-access`): shared preamble
 * (`readEditRequest` — origin / content-type / session / body) → not
 * superuser ⇒ 403 `not_superuser` BEFORE the params or any field of the body
 * are read → unknown report key ⇒ 404 → field validation ⇒ 400 → the upsert
 * on the WRITER, `updatedBy` = `realCwid` (the accountable human, never the
 * "View as" target). Answers with the stored row so the header re-renders
 * from the server's truth after `router.refresh()`.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import {
  isReportKey,
  isValidReportSlug,
  REPORT_NAME_MAX,
  REPORT_REQUEST_MEMO_MAX,
  REPORT_REQUESTED_BY_MAX,
  REPORT_SUMMARY_MAX,
  type ReportMeta,
} from "@/lib/edit/report-meta";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { sanitizeOverview } from "@/lib/edit/validators";

const PATH = "/api/edit/report-meta/[n]";

/** A trimmed string field bounded to `1..max` characters, or `null` when the
 *  value is not a string or falls outside the bound. */
function boundedText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= max ? t : null;
}

/** An optional request-record field: `undefined` when absent (leave the stored
 *  value), `null` when `null` or blank (clear it), the parsed value when valid,
 *  or `"invalid"`. */
function optionalText(v: unknown, max: number): string | null | undefined | "invalid" {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return "invalid";
  const t = v.trim();
  if (t === "") return null;
  return t.length <= max ? t : "invalid";
}

/** `YYYY-MM-DD` → a UTC-midnight Date (the `@db.Date` column), with the same
 *  absent / clear / invalid contract as {@link optionalText}. */
function optionalDate(v: unknown): Date | null | undefined | "invalid" {
  const t = optionalText(v, 10);
  if (t === undefined || t === null || t === "invalid") return t;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return "invalid";
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? "invalid" : d;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ n: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, body } = req.ctx;

  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: "not_superuser",
    });
    return editError(403, "not_superuser");
  }

  const { n } = await params;
  if (!isReportKey(n)) return editError(404, "unknown_report");

  const slug = typeof body.slug === "string" ? body.slug.trim() : body.slug;
  if (!isValidReportSlug(slug)) return editError(400, "invalid_slug", "slug");
  const name = boundedText(body.name, REPORT_NAME_MAX);
  if (name === null) return editError(400, "invalid_name", "name");
  const summary = boundedText(body.summary, REPORT_SUMMARY_MAX);
  if (summary === null) return editError(400, "invalid_summary", "summary");
  if (typeof body.descriptionHtml !== "string") {
    return editError(400, "invalid_description", "descriptionHtml");
  }
  const sanitized = sanitizeOverview(body.descriptionHtml);
  if (!sanitized.ok) return editError(400, "description_too_long", "descriptionHtml");
  const descriptionHtml = sanitized.value === "" ? null : sanitized.value;
  const requestedBy = optionalText(body.requestedBy, REPORT_REQUESTED_BY_MAX);
  if (requestedBy === "invalid") return editError(400, "invalid_requested_by", "requestedBy");
  const requestedOn = optionalDate(body.requestedOn);
  if (requestedOn === "invalid") return editError(400, "invalid_requested_on", "requestedOn");
  const requestMemo = optionalText(body.requestMemo, REPORT_REQUEST_MEMO_MAX);
  if (requestMemo === "invalid") return editError(400, "invalid_request_memo", "requestMemo");
  // Only the fields the body carried; Prisma skips an `undefined` key.
  const requestRecord = { requestedBy, requestedOn, requestMemo };

  let meta: ReportMeta;
  try {
    const row = await db.write.reportMeta.upsert({
      where: { reportKey: n },
      create: { reportKey: n, slug, name, summary, descriptionHtml, ...requestRecord, updatedBy: realCwid },
      update: { slug, name, summary, descriptionHtml, ...requestRecord, updatedBy: realCwid },
      select: { reportKey: true, slug: true, name: true, summary: true, descriptionHtml: true },
    });
    meta = {
      key: n,
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      descriptionHtml: row.descriptionHtml,
    };
  } catch (err) {
    // The slug's unique index — another report already has it. Same P2002
    // shape check `/api/edit/roles` and `report-access.ts` use.
    if ((err as { code?: string } | null)?.code === "P2002") {
      return editError(409, "slug_taken", "slug");
    }
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ meta });
}
