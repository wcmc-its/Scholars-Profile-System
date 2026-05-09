/**
 * GET /api/nih-portfolio?cwid={cwid} — click-through proxy that mints a
 * RePORTER search token for the scholar's preferred NIH profile_id and
 * 302-redirects to https://reporter.nih.gov/search/<token>/projects.
 *
 * Why a proxy: RePORTER's SPA does not accept query-string deep-links
 * to a PI portfolio. The only working URL form is
 * `/search/<server-minted-token>/projects`, and the token comes from a
 * POST to `/services/Projects/search/`. We mint at click time so the
 * "View NIH portfolio" link works without RePORTER frontend changes
 * breaking the integration.
 *
 * Also accepts `?profile_id={id}` for a direct lookup that bypasses the
 * cwid → profile_id map (handy for testing / for callers that already
 * know the profile_id).
 *
 * Failure modes:
 *   - cwid not in person_nih_profile (or scholar suppressed) → 404
 *   - RePORTER unreachable / token mint failed → 302 to RePORTER home
 *     with a notice. Better a useful fallback than a hard error page.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildNihReporterPiSearchUrl } from "@/lib/nih-reporter";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const cwid = url.searchParams.get("cwid");
  const profileIdParam = url.searchParams.get("profile_id");

  let profileId: number | null = null;
  if (profileIdParam) {
    const parsed = Number.parseInt(profileIdParam, 10);
    if (Number.isFinite(parsed) && parsed > 0) profileId = parsed;
  } else if (cwid && /^[A-Za-z0-9]{1,32}$/.test(cwid)) {
    const row = await prisma.personNihProfile.findFirst({
      where: { cwid, isPreferred: true, scholar: { deletedAt: null, status: "active" } },
      select: { nihProfileId: true },
    });
    profileId = row?.nihProfileId ?? null;
  }

  if (profileId === null) {
    return NextResponse.json({ error: "no preferred NIH profile mapping for this scholar" }, { status: 404 });
  }

  try {
    const searchUrl = await buildNihReporterPiSearchUrl(profileId);
    return NextResponse.redirect(searchUrl, { status: 302 });
  } catch (err) {
    console.error("NIH portfolio proxy failed:", err);
    // Graceful fallback: send the user to RePORTER's homepage rather
    // than a hard error. They lose the pre-filtered view but the
    // affordance still feels like it "did something".
    return NextResponse.redirect("https://reporter.nih.gov/", { status: 302 });
  }
}
