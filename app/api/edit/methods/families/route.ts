/**
 * GET /api/edit/methods/families — the comms-steward Method-Family roster
 * (`docs/comms-steward-methods-visibility-spec.md` §7).
 *
 * Returns every distinct `(supercategory, family_label)` in `scholar_family`
 * joined to both visibility overlays + the `family_review_flag` surfacing ledger,
 * each projected to `{ supercategory, familyLabel, tier, reason, isNew,
 * reviewedAt, scholarCount, pmidCount }` and ordered by the §6 review-queue
 * priority. `?filter=all|flagged|new|public|suppressed|sensitive` narrows the set
 * (default `all`; unknown values fall back to `all`).
 *
 * Gate order (§7/§9):
 *   (a) COMMS_STEWARD_ENABLED off  => 404 (whole surface dark — never reveal it)
 *   (b) no session                 => 401
 *   (c) not comms_steward/superuser => 403 (`not_comms_steward`, denial logged)
 *
 * A read has no CSRF surface and a cross-origin read cannot see the response, so
 * the session + role re-check is the whole gate (mirrors GET /api/edit/slugs).
 * Never cached: the overlays are a query-time merge a steward just mutated.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { isCommsStewardEnabled } from "@/lib/auth/comms-steward";
import { getEditSession } from "@/lib/auth/superuser";
import { authorizeCommsStewardAction, logEditDenial } from "@/lib/edit/authz";
import { apiError } from "@/lib/api/error-response";
import { editError, editOk } from "@/lib/edit/request";
import {
  buildFamilyRoster,
  applyRosterFilter,
  parseRosterFilter,
} from "@/lib/api/methods-families";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/methods/families";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // (a) master kill switch — the whole surface 404s when off (§9).
  if (!isCommsStewardEnabled()) return apiError("not_found", 404);

  // (b) authoritative session + live role verdicts.
  const session = await getEditSession();
  if (!session) return apiError("unauthorized", 401);

  // (c) comms_steward OR superuser (§3 superset). Denials logged like every
  // /edit predicate; a non-steward gets 403 here (§13 — 403 on the API).
  const authz = authorizeCommsStewardAction(session);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  const filter = parseRosterFilter(request.nextUrl.searchParams.get("filter"));
  const roster = applyRosterFilter(await buildFamilyRoster(), filter);
  return editOk({ filter, families: roster });
}
