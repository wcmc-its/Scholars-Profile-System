/**
 * Surface-agnostic data layer for per-member "method chips" on a roster row.
 *
 * Originally lived in `lib/api/centers.ts` (#962, the center roster); hoisted
 * here (#974) so the DEPARTMENT and DIVISION rosters reuse the SAME loader. It is
 * not center-specific: callers pass the page's member CWIDs plus their own
 * surface flag (`{ enabled }`) and get back the PUBLIC method families for each.
 *
 * PUBLIC families ONLY — every row is run through the shared #800/#801 overlay
 * gate (`loadFamilyOverlayGate` / `isFamilyPubliclyVisible`), so suppressed and
 * sensitive families are dropped BEFORE they enter any member's list. One batched
 * `scholarFamily.findMany` + one overlay-gate load per call, both viewer-
 * independent, so the CloudFront-cacheable roster pages stay cacheable.
 *
 * Server-only (Prisma + the server-only flag/overlay helpers); never import into
 * a client component.
 */
import { prisma } from "@/lib/db";
import {
  familyOverlayKey,
  isFamilyPubliclyVisible,
  loadFamilyOverlayGate,
} from "@/lib/api/methods-overlay";

/**
 * A PUBLIC (overlay-gated) method family attached to a roster member, for the
 * "Methods & tools" facet (centers) + per-row chips (centers + org units).
 * `value` is the stable `supercategory::familyLabel` overlay key (the facet's
 * stable value, aligned 1:1 with the #800/#801 overlay gate); `familyLabel` is
 * the display label; `pmidCount` drives top-N ordering; `exemplarTools` feed the
 * chip tooltip.
 */
export type MemberMethodFamily = {
  value: string;
  supercategory: string;
  familyLabel: string;
  pmidCount: number;
  exemplarTools: string[];
};

/** Per-row chip cap; the center facet keeps all public families in `methodFamilies`. */
export const ROSTER_ROW_METHODS_CAP = 3;

/**
 * PUBLIC method families for every roster member, in ONE `scholarFamily.findMany`
 * (+ ONE overlay-gate load). Mirrors `partitionScholarFamilies` /
 * `getScholarMethodFamilies`' gate (#800 suppression always; #801 sensitivity only
 * when METHODS_LENS_SENSITIVE_GATE is on) so the roster surfaces PUBLIC families
 * ONLY — suppressed/sensitive families are excluded entirely, keeping the
 * CloudFront-cacheable page free of any per-viewer call. Returns Map<cwid,
 * families[]> (pmidCount desc).
 *
 * The surface flag is supplied by the caller via `opts.enabled` (each surface has
 * its own flag — CENTER_METHODS_FACET, ORG_UNIT_METHODS_CHIPS), so this module
 * stays surface-agnostic: empty map AND no query when `!opts.enabled`, or when
 * there are no cwids.
 */
export async function loadPublicFamiliesForMembers(
  cwids: string[],
  opts: { enabled: boolean },
): Promise<Map<string, MemberMethodFamily[]>> {
  const out = new Map<string, MemberMethodFamily[]>();
  if (!opts.enabled || cwids.length === 0) return out;

  const gate = await loadFamilyOverlayGate();
  const rows = (await prisma.scholarFamily.findMany({
    // Mirror getScholarMethodFamilies (methods.ts): exclude soft-deleted/dormant
    // scholars at the query level too — defense-in-depth for this public surface,
    // even though callers today pass only active-filtered cwids.
    where: { cwid: { in: cwids }, scholar: { deletedAt: null, status: "active" } },
    orderBy: [{ pmidCount: "desc" }, { familyId: "asc" }],
    select: {
      cwid: true,
      supercategory: true,
      familyLabel: true,
      pmidCount: true,
      exemplarTools: true,
    },
  })) as Array<{
    cwid: string;
    supercategory: string;
    familyLabel: string;
    pmidCount: number;
    exemplarTools: unknown;
  }>;

  // Rows arrive pmidCount-desc, so each cwid's list is pre-sorted; drop a row
  // BEFORE it enters a member's list when it fails the SAME public gate.
  for (const r of rows) {
    if (!isFamilyPubliclyVisible(r.supercategory, r.familyLabel, gate)) continue;
    const fam: MemberMethodFamily = {
      value: familyOverlayKey(r.supercategory, r.familyLabel),
      supercategory: r.supercategory,
      familyLabel: r.familyLabel,
      pmidCount: r.pmidCount,
      exemplarTools: Array.isArray(r.exemplarTools) ? (r.exemplarTools as string[]) : [],
    };
    const list = out.get(r.cwid);
    if (list) list.push(fam);
    else out.set(r.cwid, [fam]);
  }
  return out;
}
