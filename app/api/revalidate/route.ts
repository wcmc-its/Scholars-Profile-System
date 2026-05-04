import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

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
 *
 * Auth: header `x-revalidate-token` must equal `process.env.SCHOLARS_REVALIDATE_TOKEN`.
 * Per the project credential policy the token lives in `~/.zshenv`, never in code.
 *
 * Threat register (PLAN 02-09):
 *   - T-02-09-01 Spoofing       — env-var token gate
 *   - T-02-09-02 Tampering      — strict whitelist + slug regex (no `.`, no `/`)
 *   - T-02-09-03 Info disclosure — 401 body never echoes the received token
 */

const ALLOWED_EXACT = new Set<string>([
  "/",
  "/about",
  "/about/methodology",
  "/browse", // Phase 4 — Browse hub ISR revalidation
]);

// Slug = alnum start, alnum end, hyphens only in interior. No dots, no
// slashes, no whitespace, no trailing hyphens.
// Anchored to prevent prefix-match attacks. Matches Next.js dynamic-segment
// shape used by `/scholars/[slug]` and `/topics/[slug]`.
const SLUG_RE_SOURCE = "[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?";
const ALLOWED_PATTERNS: RegExp[] = [
  new RegExp(`^/scholars/${SLUG_RE_SOURCE}$`),
  new RegExp(`^/topics/${SLUG_RE_SOURCE}$`),
  // Phase 3 — D-01 / D-11: department and nested division paths
  new RegExp(`^/departments/${SLUG_RE_SOURCE}$`),
  new RegExp(`^/departments/${SLUG_RE_SOURCE}/divisions/${SLUG_RE_SOURCE}$`),
];

function isAllowedPath(p: string): boolean {
  if (ALLOWED_EXACT.has(p)) return true;
  return ALLOWED_PATTERNS.some((re) => re.test(p));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expectedToken = process.env.SCHOLARS_REVALIDATE_TOKEN;
  if (!expectedToken) {
    // Server misconfigured — treat as 500 rather than silently approving any
    // request. Surfaces the operational issue to ETL logs immediately.
    return NextResponse.json(
      { error: "server misconfigured: SCHOLARS_REVALIDATE_TOKEN not set" },
      { status: 500 },
    );
  }

  const token = request.headers.get("x-revalidate-token");
  if (!token || token !== expectedToken) {
    // Do NOT echo the received token. T-02-09-03.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "missing path" }, { status: 400 });
  }

  if (!isAllowedPath(path)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 400 });
  }

  revalidatePath(path);
  return NextResponse.json({ revalidated: path });
}
