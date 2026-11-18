/**
 * GET /api/edit/can-edit-unit?kind=department|division|center&code=<code>
 *
 * The probe behind `<EditUnitLink>`, the "Edit this department / division /
 * center" link on the public unit pages. Those pages are ISR-rendered and
 * served through CloudFront's cacheable behavior, which strips the Cookie
 * header, so the page itself can never know who is looking (the same reason
 * `<EditMyProfileButton>` is a client island). `/api/edit*` is a cookie-
 * forwarding, CachingDisabled behavior (cdk/lib/edge-stack.ts), so this route
 * can read the session.
 *
 * Answers `{ ok: true, canEdit }` with the same predicate the `/edit/<kind>/
 * <code>` pages use: `canEditUnit` over `getEffectiveUnitRole` (Owner or
 * Curator, including the department→division cascade), which also admits a
 * superuser, comms steward or content editor. Resolved against the EFFECTIVE
 * session, so "View as" shows what the viewed person would see. An observer's
 * read-only steward view is stripped: the link is for people who can edit.
 *
 * Never an error for the public: no session, a bad query, or a failed lookup
 * all answer `canEdit: false` with 200, so anonymous page views do not log a
 * failed request in the browser console. Always `no-store`.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { stripObserverView } from "@/lib/auth/observer-view";
import { db } from "@/lib/db";
import {
  canEditUnit,
  getEffectiveUnitRole,
  type UnitAdminLookup,
  type UnitKind,
  type UnitRef,
} from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

const KINDS: ReadonlySet<string> = new Set<UnitKind>(["department", "division", "center"]);

function answer(canEdit: boolean): NextResponse {
  return NextResponse.json({ ok: true, canEdit }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const kind = request.nextUrl.searchParams.get("kind") ?? "";
  const code = request.nextUrl.searchParams.get("code") ?? "";
  if (!KINDS.has(kind) || code.length === 0 || code.length > 128) return answer(false);

  const effective = await getEffectiveEditSession().catch(() => null);
  if (!effective) return answer(false);
  const session = stripObserverView(effective);

  try {
    let unit: UnitRef;
    if (kind === "division") {
      const row = await db.read.division.findUnique({
        where: { code },
        select: { deptCode: true },
      });
      if (!row) return answer(false);
      unit = { kind: "division", code, parentDeptCode: row.deptCode };
    } else {
      unit = { kind: kind as "department" | "center", code };
    }
    const role = await getEffectiveUnitRole(session, unit, db.read as unknown as UnitAdminLookup);
    return answer(canEditUnit(session, role).ok);
  } catch {
    return answer(false);
  }
}
