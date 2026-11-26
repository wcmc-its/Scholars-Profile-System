/**
 * Who a page may offer the per-scholar Bibliometrics report for
 * (`EDIT_BIBLIOMETRICS`). Reports 24 and 25 are open to every unit
 * administrator; the Bibliometrics tab is not, so a row links to it only for
 * the people the viewer could open it for.
 *
 * One batched decision for a page of people (`cvExportAllowedAmong`, the set
 * form of the route's own `authorizeCvExport`), never one check per row. It
 * decides what to show and nothing else: the tab and
 * `GET /api/edit/bibliometrics` authorize the one scholar again.
 *
 * The link opens the scholar's editor, which 404s for everyone but a
 * superuser when the scholar is missing or of a hidden identity class
 * (doctoral student, #536). Those people are left out here too.
 */
import { db } from "@/lib/db";
import { isBibliometricsEnabled } from "@/lib/edit/bibliometrics";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { cvExportAllowedAmong, type CvExportBatchLookup } from "@/lib/edit/overview-authz";
import { resolveEditIdentity } from "@/lib/edit/request";

/** The Bibliometrics tab of a scholar's editor. */
export const bibliometricsHref = (cwid: string) =>
  `/edit/scholar/${encodeURIComponent(cwid)}?attr=bibliometrics`;

/** Those of `cwids` whose Bibliometrics report the viewer may open. Empty
 *  with the flag off, with no session, and when the check itself fails (the
 *  link is left out; the report still renders). */
export async function loadBibliometricsAccess(cwids: readonly string[]): Promise<ReadonlySet<string>> {
  if (!isBibliometricsEnabled() || cwids.length === 0) return new Set();
  try {
    const id = await resolveEditIdentity();
    if (!id) return new Set();
    const allowed = await cvExportAllowedAmong({
      ...id,
      entityIds: cwids,
      db: db.read as unknown as CvExportBatchLookup,
    });
    if (id.session.isSuperuser || allowed.size === 0) return allowed;
    const rows = await db.read.scholar.findMany({
      where: { cwid: { in: [...allowed] }, deletedAt: null },
      select: { cwid: true, roleCategory: true },
    });
    return new Set(rows.filter((r) => isPubliclyDisplayed(r.roleCategory)).map((r) => r.cwid));
  } catch (err) {
    console.error("[bibliometrics-access] check failed", err);
    return new Set();
  }
}
