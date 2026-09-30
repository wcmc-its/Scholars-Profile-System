/**
 * GET /api/edit/scholar-card/[cwid] — the data behind the shared /edit scholar
 * hover card (`components/edit/scholar-hover-card.tsx`), fetched when a card
 * opens so any roster or report can show it given just a cwid.
 *
 * Gate: the people who see person rows in /edit — anyone with a Profiles
 * roster scope (superuser / comms_steward / cv_generator / a unit admin) or a
 * grant on any report. The email is released for an internal viewer
 * (`gateEmailForViewer` table A, internal = authenticated), so a `none`
 * release code is withheld here exactly as on the profile.
 */
import { NextResponse } from "next/server";

import { loadScholarCard } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { CWID_PATTERN } from "@/lib/cwid";
import { db } from "@/lib/db";
import { isEmptyScope, loadDataQualityScope } from "@/lib/edit/data-quality";
import { hasAnyReportAccess } from "@/lib/edit/report-access";
import { gateEmailForViewer } from "@/lib/profile/email-display-gate";
import { isEmailReleaseGateEnabled } from "@/lib/profile/email-visibility-flags";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ cwid: string }> }) {
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  const allowed =
    !isEmptyScope(await loadDataQualityScope(session, db.read)) || (await hasAnyReportAccess(session.cwid));
  if (!allowed) return new NextResponse("Forbidden", { status: 403 });

  const { cwid } = await params;
  if (!CWID_PATTERN.test(cwid)) return new NextResponse("Not found", { status: 404 });

  const gateOn = isEmailReleaseGateEnabled();
  const card = await loadScholarCard(cwid, db.read, (email, vis) => gateEmailForViewer(email, vis, true, gateOn));
  if (!card) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(card, { headers: { "cache-control": "private, no-store" } });
}
