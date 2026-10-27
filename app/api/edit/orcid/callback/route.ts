/**
 * GET /api/edit/orcid/callback — ORCID's redirect back after "Connect your
 * ORCID iD" (#3115). The path is registered with ORCID; never rename it.
 *
 * Checks the `state` cookie set by `/connect`, exchanges the code, and in one
 * `db.write` transaction:
 *  - `scholar.orcid` = the authenticated iD, method `authenticated` (the
 *    identity ETL never overrides it; see `decideIdentityRow`);
 *  - any `orcid_dismissal` for that iD is deleted, and every OTHER iD on file or
 *    suggested for this scholar is dismissed: the person proved which iD is theirs;
 *  - `orcid_authentication` is replaced (name, iD, encrypted token, scope, expiry);
 *  - the B03 audit row, `orcid_set` with `authenticated: true`.
 *
 * Always ends in a 302 to the scholar's Identifiers & Profiles tab with
 * `orcid=connected|denied|failed`; nothing is written unless the exchange works.
 * Genuine self only, same as `/connect`.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { normalizeOrcid } from "@/lib/edit/orcid";
import {
  encryptToken,
  exchangeCode,
  isOrcidConnectEnabled,
  orcidConnectConfig,
  RETURN_PATH,
  STATE_COOKIE,
  stateMatches,
} from "@/lib/edit/orcid-connect";
import { editError, logEditFailure, resolveEditIdentityForWrite } from "@/lib/edit/request";
import { reflectOverviewEdit } from "@/lib/edit/revalidation";

const PATH = "/api/edit/orcid/callback";

function back(outcome: "connected" | "denied" | "failed", request: NextRequest): NextResponse {
  const origin = process.env.SITE_URL?.replace(/\/+$/, "") ?? request.nextUrl.origin;
  const res = NextResponse.redirect(`${origin}${RETURN_PATH}&orcid=${outcome}`, 302);
  res.cookies.set(STATE_COOKIE, "", { path: "/api/edit/orcid", maxAge: 0 });
  return res;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isOrcidConnectEnabled()) return editError(404, "not_found");
  const cfg = orcidConnectConfig();
  if (!cfg) return editError(500, "orcid_connect_unconfigured");

  const resolved = await resolveEditIdentityForWrite();
  if (!resolved.ok) return resolved.response;
  const { realCwid, impersonatedCwid } = resolved.id;
  if (impersonatedCwid !== null) return back("failed", request);

  const q = request.nextUrl.searchParams;
  if (!stateMatches(request.cookies.get(STATE_COOKIE)?.value, q.get("state"))) {
    return back("failed", request);
  }
  // The person clicked Deny on ORCID's page.
  if (q.get("error")) return back("denied", request);
  const code = q.get("code");
  if (!code) return back("failed", request);

  const scholar = await db.read.scholar.findUnique({
    where: { cwid: realCwid },
    select: { cwid: true, slug: true },
  });
  if (!scholar) return back("failed", request);

  try {
    const tok = await exchangeCode(cfg, code);
    const orcid = normalizeOrcid(tok.orcid);
    if (!orcid) throw new Error("ORCID returned an invalid iD");
    await db.write.$transaction(async (tx) => {
      const held =
        (await tx.scholar.findUnique({ where: { cwid: scholar.cwid }, select: { orcid: true } }))
          ?.orcid ?? null;
      await tx.scholar.update({
        where: { cwid: scholar.cwid },
        data: {
          orcid,
          orcidConfirmedAt: new Date(),
          orcidConfirmMethod: "authenticated",
          orcidConfirmedBy: scholar.cwid,
        },
      });
      await tx.orcidDismissal.deleteMany({ where: { cwid: scholar.cwid, orcid } });
      const others = new Set(
        (
          await tx.orcidCandidate.findMany({
            where: { cwid: scholar.cwid, orcid: { not: orcid } },
            select: { orcid: true },
          })
        ).map((c) => c.orcid),
      );
      if (held !== null && held !== orcid) others.add(held);
      for (const d of others) {
        await tx.orcidDismissal.upsert({
          where: { cwid_orcid: { cwid: scholar.cwid, orcid: d } },
          create: { cwid: scholar.cwid, orcid: d },
          update: {},
        });
      }
      const auth = {
        orcid,
        name: tok.name,
        accessTokenEnc: encryptToken(tok.accessToken, cfg.tokenKey),
        scope: tok.scope,
        expiresAt: tok.expiresInS ? new Date(Date.now() + tok.expiresInS * 1000) : null,
        sandbox: cfg.sandbox,
        authenticatedAt: new Date(),
      };
      await tx.orcidAuthentication.upsert({
        where: { cwid: scholar.cwid },
        create: { cwid: scholar.cwid, ...auth },
        update: auth,
      });
      // ponytail: audits as `orcid_set` + `authenticated: true` rather than a new
      // action, same call as the Remove path in ../route.ts.
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid: null,
        targetEntityType: "scholar",
        targetEntityId: scholar.cwid,
        action: "orcid_set",
        fieldsChanged: ["orcid"],
        beforeValues: { orcid: held },
        afterValues: {
          orcid,
          authenticated: true,
          ...(cfg.sandbox ? { sandbox: true } : {}),
          ...(others.size > 0 ? { dismissed: [...others] } : {}),
        },
        ts: new Date(),
        requestId: randomUUID(),
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return back("failed", request);
  }

  await reflectOverviewEdit(scholar.slug);
  return back("connected", request);
}
