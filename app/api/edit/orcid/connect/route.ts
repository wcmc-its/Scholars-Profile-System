/**
 * GET /api/edit/orcid/connect — start "Connect your ORCID iD" (#3115). Sets a
 * random `state` in a short-lived httpOnly cookie and 302s to ORCID's authorize
 * page (`/authenticate` scope). See `lib/edit/orcid-connect.ts`.
 *
 * Genuine self only: ORCID sign-in proves the PERSON owns the iD, so a proxy,
 * an administrator or a "View as" overlay can't start it (403). 404 when
 * `ORCID_CONNECT` is off; 500 when it is on but the client config is missing (never 503: the edge swaps that for the outage page).
 */
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import {
  authorizeUrl,
  isOrcidConnectEnabled,
  newState,
  orcidConnectConfig,
  STATE_COOKIE,
  STATE_MAX_AGE_S,
} from "@/lib/edit/orcid-connect";
import { editError, resolveEditIdentityForWrite } from "@/lib/edit/request";

export async function GET(): Promise<NextResponse> {
  if (!isOrcidConnectEnabled()) return editError(404, "not_found");
  const cfg = orcidConnectConfig();
  if (!cfg) return editError(500, "orcid_connect_unconfigured");

  const resolved = await resolveEditIdentityForWrite();
  if (!resolved.ok) return resolved.response;
  const { realCwid, impersonatedCwid } = resolved.id;
  if (impersonatedCwid !== null) return editError(403, "not_self");
  const scholar = await db.read.scholar.findUnique({ where: { cwid: realCwid }, select: { cwid: true } });
  if (!scholar) return editError(403, "not_self");

  const state = newState();
  const res = NextResponse.redirect(authorizeUrl(cfg, state), 302);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    // Lax, not Strict: the callback is a top-level navigation back from orcid.org.
    sameSite: "lax",
    path: "/api/edit/orcid",
    maxAge: STATE_MAX_AGE_S,
  });
  return res;
}
