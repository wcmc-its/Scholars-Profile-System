/**
 * `GET /api/edit/orcid-queue/scholar?cwid=` — one scholar's card on the ORCID
 * queue (`/edit/orcid-queue`, v3): every candidate iD with the ETL's evidence,
 * the iD on file and where it came from, and the scholar's publication count.
 * The page lists every scholar as a summary and fetches the selected one here.
 *
 * Gates, in order, as the page: `ORCID_LIBRARIAN_QUEUE` (404 when off), a
 * session (401), `requireSuperuserGet` (403). A View-as session may read: the
 * page is read-only then, and the decide route refuses its writes. 404 when the
 * scholar has nothing in the queue (decided since the list loaded, or the ETL
 * dropped the pair). The cwid is not shape-checked: Cornell NetIDs come later.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { requireSuperuserGet } from "@/lib/edit/authz";
import { isOrcidLibrarianQueueEnabled } from "@/lib/edit/orcid-queue";
import { loadOrcidQueueCard } from "@/lib/edit/orcid-queue.server";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/orcid-queue/scholar";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isOrcidLibrarianQueueEnabled()) return new NextResponse(null, { status: 404 });
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse(null, { status: 401 });
  if (requireSuperuserGet({ session, path: PATH, targetId: "orcid-queue" }) !== null)
    return new NextResponse(null, { status: 403 });

  const cwid = request.nextUrl.searchParams.get("cwid") ?? "";
  if (cwid.length === 0 || cwid.length > 32) return new NextResponse(null, { status: 400 });

  const card = await loadOrcidQueueCard(db.read, cwid);
  if (!card) return new NextResponse(null, { status: 404 });
  return NextResponse.json(card, { headers: { "cache-control": "private, no-store" } });
}
