import { NextResponse, type NextRequest } from "next/server";

import { resolveViewerContext } from "@/lib/auth/viewer-context";
import { isMethodsLensSensitiveGateOn } from "@/lib/profile/methods-lens-flags";
import { loadSensitiveScholarFamilies } from "@/lib/api/profile";

/**
 * GET /api/profile/[cwid]/sensitive-families — #866 UC-A, the INTERNAL-VIEWER
 * reveal of a scholar's AUDIENCE-GATED (#801) method families.
 *
 * The family-primary Methods lens (#799) omits #801-sensitive families (e.g.
 * curated live-animal-model families) from the PUBLIC, CloudFront-cached profile
 * payload — external viewers must never see them. #866 broadens the reveal from
 * the #801 {self, admin} audience (still served by /api/edit/methods-sensitive)
 * to ANY *internal viewer*: an authenticated session OR — when the network
 * signal flag is on — an on-WCM-network source IP (see lib/auth/viewer-context).
 *
 * This path lives OUTSIDE `/api/edit/*`, so the SSO middleware does NOT 401 it:
 * an anonymous on-network viewer must be able to reach it. The gate is therefore
 * entirely server-side here and default-safe — an external viewer gets `[]`:
 *   - sensitivity gate off  → `{ families: [], viewer: "off" }`
 *   - external viewer       → `{ families: [], viewer: "external" }`
 *   - internal viewer       → `{ families, viewer: basis }` for ANY cwid
 *     (no self/admin restriction — that is the #866 broadening).
 * Never cached.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  const { cwid } = await params;

  if (!isMethodsLensSensitiveGateOn()) {
    return NextResponse.json({ families: [], viewer: "off" }, { headers: NO_STORE });
  }

  const vc = await resolveViewerContext(request);
  if (!vc.internal) {
    return NextResponse.json({ families: [], viewer: "external" }, { headers: NO_STORE });
  }

  const families = await loadSensitiveScholarFamilies(cwid);
  return NextResponse.json({ families, viewer: vc.basis }, { headers: NO_STORE });
}
