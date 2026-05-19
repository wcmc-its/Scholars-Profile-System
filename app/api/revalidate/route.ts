import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getRevalidateTokens, isAuthorizedBearer } from "@/lib/revalidate-auth";
import { isAllowedRevalidatePath } from "@/lib/revalidate-allowlist";

/**
 * POST /api/revalidate?path={p}
 *
 * Webhook for ETL completion (etl/orchestrate.ts) and the self-edit pipeline
 * (Phase 7). Validates an env-var token, validates the path against a literal
 * whitelist, then calls Next.js `revalidatePath()` to bust the ISR cache.
 *
 * Whitelist (Phase 2 surfaces):
 *   - "/"                    home page
 *   - "/about"               about stub
 *   - "/about/methodology"   methodology page
 *   - "/scholars/{slug}"     profile page (slug = [a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)
 *   - "/topics/{slug}"       topic detail / placeholder
 *   - "/sitemap.xml"         dynamic sitemap (Phase 5)
 *
 * Auth (#103 / B04): `Authorization: Bearer <token>`, compared constant-time
 * against `SCHOLARS_REVALIDATE_TOKEN` and the optional rotation-window token
 * `SCHOLARS_REVALIDATE_TOKEN_PREVIOUS`. See lib/revalidate-auth.ts and
 * docs/revalidate-token-rotation.md. Per the credential policy the token lives
 * in the environment, never in code.
 *
 * Threat register (PLAN 02-09):
 *   - T-02-09-01 Spoofing       — constant-time Bearer token gate
 *   - T-02-09-02 Tampering      — strict whitelist + slug regex (no `.`, no `/`)
 *   - T-02-09-03 Info disclosure — 401 body never echoes the received token
 */

// The path allow-list lives in lib/revalidate-allowlist.ts — one constant
// shared with the self-edit write path (lib/edit/revalidation.ts, #356).

export async function POST(request: NextRequest): Promise<NextResponse> {
  const acceptedTokens = getRevalidateTokens();
  if (acceptedTokens.length === 0) {
    // Server misconfigured — treat as 500 rather than silently approving any
    // request. Surfaces the operational issue to ETL logs immediately.
    return NextResponse.json(
      { error: "server misconfigured: SCHOLARS_REVALIDATE_TOKEN not set" },
      { status: 500 },
    );
  }

  if (
    !isAuthorizedBearer(request.headers.get("authorization"), acceptedTokens)
  ) {
    // Do NOT echo the received token. T-02-09-03.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "missing path" }, { status: 400 });
  }

  if (!isAllowedRevalidatePath(path)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 400 });
  }

  revalidatePath(path);
  return NextResponse.json({ revalidated: path });
}
