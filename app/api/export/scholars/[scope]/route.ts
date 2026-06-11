/**
 * POST /api/export/scholars/{method-family|supercategory|topic|subtopic}
 *
 * Internal-only CSV export of a scope's ranked scholar cohort (#847), offered
 * only when the displayable cohort is <= 50 (SPEC §B.3 HARD cap; > 50 is refused
 * server-side via the builder returning null => 404, no partial top-50). Mirrors
 * the publications export route (force-dynamic, defensive body parse, `apiError`,
 * `toCsv`, Content-Disposition attachment) plus an internal-viewer gate: any
 * authenticated WCM session OR an allowlisted on-network viewer (#866) may
 * download; an external viewer => 401. NO role required.
 *
 * By default NO contact column is emitted. When `SCHOLAR_LIST_EXPORT_EMAIL` is on
 * (#866 UC-B), an internal viewer additionally receives an `email` column; that
 * download is audited (one structured record capturing the downloader CWID — or,
 * for an anonymous on-network viewer, the source IP — the scope, and row count).
 *
 * Gate order:
 *   (a) feature flag off                         => 404 (whole feature dark)
 *   (b) external viewer (no session, off-net)    => 401
 *   (c) scope not in the allowlist               => 404
 *   (d) method scopes + METHODS_LENS_PAGES off   => 404
 *   (e) JSON body parsed defensively             => 400 on structural failure
 *   (f) scope target resolves to nothing         => 404
 *   (g) text/csv attachment response (+ email column + audit when UC-B on)
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import {
  resolveViewerContext,
  extractIpv4FromViewerAddress,
} from "@/lib/auth/viewer-context";
import {
  isScholarListExportEnabled,
  isScholarListExportEmailEnabled,
} from "@/lib/export/scholar-export-flags";
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

  // (b) internal-only: an authenticated WCM session OR an allowlisted on-network
  // viewer (#866) may download; everyone else => 401. Resolving here (not the
  // bare session check) lets an anonymous on-WCM-network viewer through.
  const vc = await resolveViewerContext(request);
  if (!vc.internal) {
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

  // (f) build — null when the scope target does not resolve OR the displayable
  // cohort exceeds the HARD <=50 cap (SPEC §B.3): both refuse with the same
  // dark-feature 404 — never a partial top-50. The email column (#866 UC-B)
  // rides on top of the master export flag; the internal-viewer gate above
  // already ran, so it is only ever passed for an internal viewer.
  const includeEmail = isScholarListExportEmailEnabled();
  const result = await buildScholarExport(scope, params, undefined, { includeEmail });
  if (!result) {
    return apiError("not_found", 404);
  }

  // Structured access log mirrors the publications export shape for analytics.
  console.log(
    JSON.stringify({
      event: "export_scholars",
      scope,
      cwid: vc.cwid ?? null,
      ts: new Date().toISOString(),
    }),
  );

  // Contact-data audit (#866 UC-B): emit ONE structured record whenever the
  // email column is included. For an anonymous on-network viewer the source IP
  // is the only identifier, so capture it (parsed from the CloudFront viewer
  // address header). `row_count` = data rows = total CSV lines minus the header.
  if (includeEmail) {
    const csvLines = result.csv.trim().length === 0 ? 0 : result.csv.trim().split("\r\n").length;
    console.info(
      JSON.stringify({
        event: "scholar_export_email",
        downloader_cwid: vc.cwid ?? null,
        source_ip: extractIpv4FromViewerAddress(
          request.headers.get("cloudfront-viewer-address"),
        ),
        scope,
        row_count: Math.max(0, csvLines - 1),
        ts: new Date().toISOString(),
      }),
    );
  }

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
