import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session-server";
import { isSuperuser } from "@/lib/auth/superuser";
import { loadSensitiveScholarFamilies } from "@/lib/api/profile";

/**
 * GET /api/edit/methods-sensitive/[cwid] — the #801 self/admin reveal of a
 * scholar's AUDIENCE-GATED method families.
 *
 * The family-primary Methods lens (#799) omits #801-sensitive families (e.g.
 * curated live-animal-model families) from the PUBLIC, CloudFront-cached
 * profile payload — anonymous viewers must never see them. The scholar
 * themselves and site admins, however, should see them (with a "hidden from
 * the public profile" marker). The public page is cached with the session
 * cookie stripped, so that reveal can't happen server-side on the page; the
 * MethodsSection island fetches THIS route instead, which lives under the
 * cookie-forwarding `/api/edit/*` behavior and so can read the session.
 *
 * Authorization (defence in depth — middleware already 401s an unauthenticated
 * `/api/edit/*` request, so anonymous viewers never reach here and get `[]`):
 *   - self  — `session.cwid === cwid`
 *   - admin — `isSuperuser(session.cwid)`
 * Any other authenticated viewer gets `[]` (no leak of one scholar's gated
 * families to another). Never cached.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  const { cwid } = await params;

  const session = await getSession().catch(() => null);
  if (!session) {
    return NextResponse.json({ families: [], viewer: "anonymous" }, { headers: NO_STORE });
  }

  const isSelf = session.cwid === cwid;
  const allowed = isSelf || (await isSuperuser(session.cwid).catch(() => false));
  if (!allowed) {
    return NextResponse.json({ families: [], viewer: "other" }, { headers: NO_STORE });
  }

  const families = await loadSensitiveScholarFamilies(cwid);
  return NextResponse.json({ families, viewer: isSelf ? "self" : "admin" }, { headers: NO_STORE });
}
