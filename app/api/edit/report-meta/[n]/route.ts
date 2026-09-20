/**
 * PUT /api/edit/report-meta/[n] — a superuser edits one report's slug, name,
 * one-line summary and rich-text description (`report_meta`,
 * `lib/edit/report-meta.ts`) from the pencil on `/edit/reports/[n]`
 * (`components/edit/report-meta-editor.tsx`).
 *
 * Body: `{ slug, name, summary, descriptionHtml }` — `slug` per
 * `isValidReportSlug` (a taken slug ⇒ 409 `slug_taken`, the unique index);
 * `name` 1..`REPORT_NAME_MAX` and `summary` 1..`REPORT_SUMMARY_MAX` after
 * trimming; `descriptionHtml` a
 * string (`""` = no description), run through the `overview` sanitizer
 * (`sanitizeOverview`, `lib/edit/validators.ts` — the security boundary; the
 * Tiptap schema on the client is only a UX convenience). The SANITIZED output
 * is what is stored; a structurally-empty result stores `NULL`.
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

  let meta: ReportMeta;
  try {
    const row = await db.write.reportMeta.upsert({
      where: { reportKey: n },
      create: { reportKey: n, slug, name, summary, descriptionHtml, updatedBy: realCwid },
      update: { slug, name, summary, descriptionHtml, updatedBy: realCwid },
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
