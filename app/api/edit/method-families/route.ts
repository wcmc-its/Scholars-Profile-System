/**
 * GET /api/edit/method-families?q=<text> — the family picker behind the Method
 * services editor section. Up to 10 publicly visible method families matching
 * `q` (by label, or by a member tool's name), most scholars first:
 * `{ ok: true, families: [{ supercategory, supercategoryLabel, familyLabel,
 * scholarCount }] }`.
 *
 * The source is `loadMethodFamilyCandidates`, the same loader site search
 * suggests families from, so a suppressed or sensitive family never appears
 * here either. The data is public; the gate only keeps the route to the people
 * who have an editor to use it in, and only a SUPERUSER manages method
 * services (`/api/edit/method-service`). Anyone else gets 403 `not_superuser`.
 * Resolved against the EFFECTIVE session (`session.isSuperuser`), as
 * `/api/edit/effective-flags` does: under "View as" it is the verdict of the
 * person being viewed. Read-only, so no audit row. 404 while
 * `isMethodServicesEnabled()` is false. Always `no-store`.
 */
import { NextResponse, type NextRequest } from "next/server";

import { loadMethodFamilyCandidates } from "@/lib/api/search";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { logEditDenial } from "@/lib/edit/authz";
import { isMethodServicesEnabled } from "@/lib/method-services/flags";
import type { MethodFamilyOption } from "@/lib/method-services/validation";
import { supercategoryLabel } from "@/lib/methods/supercategory-labels";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/method-families";
const NO_STORE = { "cache-control": "no-store" } as const;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;
const LIMIT = 10;

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isMethodServicesEnabled()) return jsonError(404, "not_found");

  const session = await getEffectiveEditSession();
  if (!session) return jsonError(401, "unauthenticated");
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: "not_superuser",
    });
    return jsonError(403, "not_superuser");
  }

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length > MAX_QUERY_LENGTH) return jsonError(400, "query_too_long");
  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ ok: true, families: [] }, { headers: NO_STORE });
  }

  const candidates = await loadMethodFamilyCandidates(q, LIMIT);
  const families: MethodFamilyOption[] = candidates.slice(0, LIMIT).map((c) => ({
    supercategory: c.supercategory,
    supercategoryLabel: supercategoryLabel(c.supercategory),
    familyLabel: c.familyLabel,
    scholarCount: c.scholarCount,
  }));
  return NextResponse.json({ ok: true, families }, { headers: NO_STORE });
}
