/**
 * POST /api/export/scholars/{method-family|supercategory|topic|subtopic}
 *
 * Internal-only CSV export of a scope's ranked top-50 scholars (#847). Mirrors
 * the publications export route (force-dynamic, defensive body parse, `apiError`,
 * `toCsv`, Content-Disposition attachment) plus an auth gate: any authenticated
 * WCM session may download; anonymous => 401. NO role required, NO contact column
 * ever emitted.
 *
 * Gate order:
 *   (a) feature flag off                         => 404 (whole feature dark)
 *   (b) no session                               => 401
 *   (c) scope not in the allowlist               => 404
 *   (d) method scopes + METHODS_LENS_PAGES off   => 404
 *   (e) JSON body parsed defensively             => 400 on structural failure
 *   (f) scope target resolves to nothing         => 404
 *   (g) text/csv attachment response
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getSession } from "@/lib/auth/session-server";
import { isScholarListExportEnabled } from "@/lib/export/scholar-export-flags";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import {
  buildScholarExport,
  type ScholarExportScope,
} from "@/lib/api/export-scholars";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SCOPE_ALLOWLIST: ReadonlySet<ScholarExportScope> = new Set([
  "method-family",
  "supercategory",
  "topic",
  "subtopic",
]);

const METHOD_SCOPES: ReadonlySet<ScholarExportScope> = new Set([
  "method-family",
  "supercategory",
]);

/** Defensively coerce an untrusted JSON body into a flat string param map.
 *  Non-string values are dropped silently rather than echoed back; the builder
 *  validates the per-scope keys it needs. */
function parseParams(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ scope: string }> },
) {
  // (a) feature flag — the WHOLE feature is dark when off.
  if (!isScholarListExportEnabled()) {
    return apiError("not_found", 404);
  }

  // (b) internal-only: any authenticated WCM session may download.
  const session = await getSession();
  if (!session) {
    return apiError("unauthorized", 401);
  }

  // (c) scope allowlist.
  const { scope: raw } = await ctx.params;
  if (!SCOPE_ALLOWLIST.has(raw as ScholarExportScope)) {
    return apiError("not_found", 404);
  }
  const scope = raw as ScholarExportScope;

  // (d) method scopes are additionally gated by the Method-pages flag.
  if (METHOD_SCOPES.has(scope) && !isMethodPagesEnabled()) {
    return apiError("not_found", 404);
  }

  // (e) defensive body parse.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid body", 400);
  }
  const params = parseParams(body);
  if (!params) {
    return apiError("invalid body", 400);
  }

  // (f) build — null when the scope target does not resolve.
  const result = await buildScholarExport(scope, params);
  if (!result) {
    return apiError("not_found", 404);
  }

  // Structured access log mirrors the publications export shape for analytics.
  console.log(
    JSON.stringify({
      event: "export_scholars",
      scope,
      cwid: session.cwid,
      ts: new Date().toISOString(),
    }),
  );

  // (g) text/csv attachment.
  return new NextResponse(result.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
