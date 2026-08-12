/**
 * Shared server-side plumbing for the `/edit/reports/*` console — the
 * top-level home for what used to be the `?attr=reports` / `?attr=nci-2a`
 * tabs buried inside `/edit/center/[code]` (unit-curation-edit-ui-spec.md).
 * Both the center-code resolution and the authorization gate live here so
 * the index page and its five numbered report pages can't drift from each
 * other, or from the per-unit editor surface they're replacing.
 */
import { notFound } from "next/navigation";

import {
  loadUnitEditContext,
  type UnitEditContext,
  type UnitEditContextClient,
} from "@/lib/api/unit-edit-context";
import type { EditSession } from "@/lib/auth/superuser";
import { logEditDenial } from "@/lib/edit/authz";
import { loadAllUnitsForFinder } from "@/lib/edit/manageable-units";

/**
 * Resolve "the" Cancer Center's unit `code` server-side instead of hardcoding
 * a literal — `?center=` addresses a second center once one exists.
 *
 * `Center` is not synonymous with "Cancer Center": the org chart carries
 * ~8-11 `kind: "center"` units (`loadAllUnitsForFinder`'s own doc comment),
 * most of them unrelated to this report suite. Filtering to `kind ===
 * "center"` alone and defaulting to the alphabetically-first one (a real bug,
 * caught 2026-08-12) picked whichever center's NAME sorted first — almost
 * never the actual Cancer Center — which then 404'd/empty-stated every report
 * that reads Cancer-Center-only data (NCI Table 2A's "No import cycle found
 * yet", the collab-report's empty roster, etc.).
 *
 * The correct scope is the SAME one every report's underlying data already
 * requires and the old per-center "Reports"/"NCI Table 2A" rail tabs were
 * always gated on: a center with a `CenterProgram` taxonomy (#552) — data-
 * driven, not a hardcoded center check, matching the posture documented
 * throughout `lib/edit/cancer-center-funding-generator.ts` and
 * `lib/center-collaboration/*`. `notFound()` — never a silent fallback — when
 * no center has a program taxonomy at all, or the requested code doesn't
 * resolve to one that does.
 */
export async function resolveReportsCenterCode(
  db: UnitEditContextClient,
  requested: string | undefined,
): Promise<string> {
  const [centers, programRows] = await Promise.all([
    loadAllUnitsForFinder(db).then((units) => units.filter((u) => u.kind === "center")),
    db.centerProgram.findMany({ select: { centerCode: true }, distinct: ["centerCode"] }),
  ]);
  const codesWithPrograms = new Set(programRows.map((p) => p.centerCode));
  const reportableCenters = centers.filter((c) => codesWithPrograms.has(c.code));
  const code = requested
    ? reportableCenters.find((c) => c.code === requested)?.code
    : reportableCenters[0]?.code;
  if (!code) notFound();
  return code;
}

/**
 * The SAME role gate `/edit/center/[code]` enforces — superuser, comms_steward
 * (global content-editor parity, comms-steward-profile-editing-spec.md §3b),
 * or a unit Owner/Curator of this center — reused wholesale via
 * `loadUnitEditContext` rather than re-derived, so the Reports console can
 * never drift from the per-unit editor's authz. `null` = denied (and logged);
 * the caller renders the same visible 403 the old `?attr=reports` /
 * `?attr=nci-2a` tabs sat behind.
 */
export async function loadReportsContext(
  code: string,
  session: EditSession,
  db: UnitEditContextClient,
): Promise<UnitEditContext | null> {
  const ctx = await loadUnitEditContext("center", code, session, db);
  if (ctx === null) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: code,
      path: "/edit/reports",
      reason: "not_curator",
      targetEntityType: "center",
      targetEntityId: code,
    });
  }
  return ctx;
}
