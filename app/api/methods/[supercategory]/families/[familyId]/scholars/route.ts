/**
 * GET /api/methods/[supercategory]/families/[familyId]/scholars
 *
 * CSR endpoint for the family-scoped researcher row on the supercategory page's
 * right panel — the family-grain analog of
 * /api/topics/[slug]/subtopics/[subtopicId]/scholars. Returns up to 10 researcher
 * rows (FT-faculty carve, active-only) for the family identified by the URL's
 * `familyId` under the supercategory, each carrying the in-family vs. total pub
 * counts the popover renders.
 *
 * Security: same allowlist regex posture as the publications endpoint
 * (T-03-05-04 path traversal). Silent rejection with static error strings; no
 * request URL / param logging.
 *
 * The overlay gate (#800/#801) + master lens gate live in the loader
 * (`getFamily` / `getFamilyScholarRows`) — a suppressed/sensitive/unknown family
 * resolves to null and yields an empty `scholars` array, never a public reveal.
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getFamily, getFamilyScholarRows } from "@/lib/api/methods";
import { isMethodsFamilyRosterFallbackOn } from "@/lib/profile/methods-lens-flags";

export const dynamic = "force-dynamic";

const SUPERCATEGORY_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// The family id is the opaque A2 `fam_NNNN` token; allow lowercase alnum +
// underscore (a bare family id, not a full label slug).
const FAMILY_ID_RE = /^[a-z0-9_]+$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ supercategory: string; familyId: string }> },
): Promise<NextResponse> {
  const { supercategory, familyId } = await params;
  if (!SUPERCATEGORY_SLUG_RE.test(supercategory)) {
    return apiError("invalid supercategory", 400);
  }
  if (!FAMILY_ID_RE.test(familyId)) {
    return apiError("invalid family", 400);
  }

  // Resolve the (supercategory, familyLabel) identity from the URL's family id.
  // `getFamily` matches by re-derived slug, breaking ties on the trailing
  // `fam_NNNN`; a bare family id resolves through the same id tie-break path.
  const resolved = await getFamily(supercategory, familyId);
  if (!resolved) {
    return NextResponse.json({ scholars: [] });
  }

  const scholars = await getFamilyScholarRows(resolved.supercategory, resolved.familyLabel);
  // #862 — the row's tooltip copy tracks the roster-fallback flag (env-only flip):
  // on ⇒ the roster may include attributed non-faculty; off ⇒ FT-faculty-only.
  return NextResponse.json({
    scholars: scholars ?? [],
    includesNonFaculty: isMethodsFamilyRosterFallbackOn(),
  });
}
