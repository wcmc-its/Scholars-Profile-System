/**
 * Who a partner (Cornell Ithaca, `ITHACA_LOGIN`) sign-in becomes. Node-only.
 *
 * 1. Joint appointment: a `known` identity link (Cornell's directory lists the
 *    CWID on the NetID as `cornellEduCWID`, or WCM ED lists the NetID on the
 *    scholar) maps the NetID to exactly one CWID → a plain WCM session for that
 *    CWID, with that CWID's roles. Cornell's word alone is enough (plan,
 *    2026-11-19). ponytail: trusts the weekly `scholar_identity_link` snapshot;
 *    a wrong Cornell mapping signs the person in as that WCM CWID. Each such
 *    login logs both IDs.
 * 2. Otherwise a live Ithaca roster row, or a report grant to the eppn → the
 *    partner session (`netid@cornell.edu`).
 * 3. Otherwise null: refused.
 *
 * Throws on a DB error; the caller fails closed.
 */
import type { EditSession } from "@/lib/auth/superuser";
import { getPartnerNetid } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import { PARTNER_REPORT_KEYS } from "@/lib/edit/report-access";

/** Where a partner session lands after sign-in (on the proxy's PARTNER_PATHS). */
export const PARTNER_HOME = "/edit/cornell";

/**
 * The session a report surface on the proxy's partner allowlist uses for a
 * Cornell Ithaca sign-in: the full eppn as `cwid`, every role false. It sees
 * only what a `report_access` / Reporting grant to that eppn names; each
 * caller also checks `PARTNER_REPORT_KEYS`. Null for anyone else.
 */
export async function getPartnerReportSession(): Promise<EditSession | null> {
  const netid = await getPartnerNetid();
  return netid ? { cwid: `${netid}@cornell.edu`, isSuperuser: false, isCommsSteward: false } : null;
}

/** Whether a partner eppn holds a grant on any partner-grantable report. */
async function hasPartnerReportGrant(eppn: string): Promise<boolean> {
  const row = await db.read.reportAccess.findFirst({
    where: { cwid: eppn, reportKey: { in: [...PARTNER_REPORT_KEYS] } },
    select: { cwid: true },
  });
  return row !== null;
}

/** The live Ithaca roster row a partner NetID signs in to, or null. */
export async function ithacaScholar(netid: string) {
  return db.read.scholar.findFirst({
    where: { cwid: netid, campus: "ithaca", deletedAt: null },
    select: { cwid: true, slug: true, preferredName: true, orcid: true, orcidConfirmMethod: true },
  });
}

export async function resolvePartnerLogin(eppn: string): Promise<string | null> {
  const netid = eppn.slice(0, eppn.indexOf("@"));

  const links = await db.read.scholarIdentityLink.findMany({
    where: { netid, band: "known" },
    select: { cwid: true },
  });
  const cwids = [...new Set(links.map((l) => l.cwid))];
  if (cwids.length === 1) {
    console.info(JSON.stringify({ event: "partner_login_joint", netid, cwid: cwids[0] }));
    return cwids[0];
  }
  if (cwids.length > 1) {
    // Two WCM people claim one NetID: never guess. Fall through to the
    // Ithaca-only session, which carries no WCM roles.
    console.warn(JSON.stringify({ event: "partner_login_ambiguous", netid, cwids }));
  }

  const ithaca = await db.read.scholar.count({
    where: { cwid: netid, campus: "ithaca", deletedAt: null },
  });
  // A report grant also admits (report viewers include Ithaca staff, who
  // have no roster row).
  return ithaca > 0 || (await hasPartnerReportGrant(eppn)) ? eppn : null;
}
