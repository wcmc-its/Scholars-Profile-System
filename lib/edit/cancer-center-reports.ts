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
 * a literal — `?center=` addresses a second center once one exists; absent
 * that, the sole center today is the default (first by name, matching
 * `loadAllUnitsForFinder`'s sort). `notFound()` — never a silent fallback —
 * when there are no centers at all, or the requested code doesn't resolve to
 * one.
 */
export async function resolveReportsCenterCode(
  db: UnitEditContextClient,
  requested: string | undefined,
): Promise<string> {
  const centers = (await loadAllUnitsForFinder(db)).filter((u) => u.kind === "center");
  const code = requested ? centers.find((c) => c.code === requested)?.code : centers[0]?.code;
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
