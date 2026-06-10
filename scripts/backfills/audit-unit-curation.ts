/**
 * #540 Phase 9 — audit queries C and E from `docs/unit-curation-spec.md`
 * § Audit queries, expressed through Prisma so the launch backfill can print
 * them for operator verification.
 *
 *   C) Manually-created units — the unadopted-division watch. A manual division
 *      long stale with only a manual roster may carry a mistyped N-code
 *      (edge 24). After this cutover the 8 centers are also `source='manual'`.
 *
 *        SELECT 'division' AS unit, code, name, scholar_count, created_at
 *        FROM division WHERE source = 'manual'
 *        UNION ALL
 *        SELECT 'center' AS unit, code, name, scholar_count, created_at
 *        FROM center WHERE source = 'manual'
 *        ORDER BY scholar_count ASC, created_at;
 *
 *   E) Manual rosters — members added through the UI to a manually-owned unit
 *      (a center, or a manually-created division).
 *
 *        SELECT 'center' AS unit_kind, center_code AS code, cwid, source, ...
 *        FROM center_membership
 *        UNION ALL
 *        SELECT 'division' AS unit_kind, division_code AS code, cwid, source, ...
 *        FROM division_membership
 *        ORDER BY unit_kind, code;
 *
 * Read-only; safe to run any time. Kept in a separate module so the unit tests
 * can drive them with a mocked read client and the backfill can print them.
 */
import type { AuditRowC, AuditRowE } from "./2026-06-10-import-unit-curation";

/** Minimal read-client slice these audit queries touch. */
export type AuditDb = {
  division: {
    findMany(args: {
      where: { source: string };
      select: { code: true; name: true; scholarCount: true; createdAt?: true };
    }): Promise<Array<{ code: string; name: string; scholarCount: number; createdAt?: Date }>>;
  };
  center: {
    findMany(args: {
      where: { source: string };
      select: { code: true; name: true; scholarCount: true };
    }): Promise<Array<{ code: string; name: string; scholarCount: number }>>;
  };
  centerMembership: {
    findMany(args: {
      select: { centerCode: true; cwid: true; source: true };
    }): Promise<Array<{ centerCode: string; cwid: string; source: string }>>;
  };
  divisionMembership: {
    findMany(args: {
      select: { divisionCode: true; cwid: true; source: true };
    }): Promise<Array<{ divisionCode: string; cwid: string; source: string }>>;
  };
};

/** Audit query C — manually-created units (divisions + centers), stale-first. */
export async function runAuditQueryC(db: AuditDb): Promise<AuditRowC[]> {
  const [divisions, centers] = await Promise.all([
    db.division.findMany({
      where: { source: "manual" },
      select: { code: true, name: true, scholarCount: true },
    }),
    db.center.findMany({
      where: { source: "manual" },
      select: { code: true, name: true, scholarCount: true },
    }),
  ]);
  const rows: AuditRowC[] = [
    ...divisions.map((d) => ({ unit: "division" as const, code: d.code, name: d.name, scholarCount: d.scholarCount })),
    ...centers.map((c) => ({ unit: "center" as const, code: c.code, name: c.name, scholarCount: c.scholarCount })),
  ];
  // ORDER BY scholar_count ASC (stale/empty units first, per the spec).
  rows.sort((a, b) => a.scholarCount - b.scholarCount || a.code.localeCompare(b.code));
  return rows;
}

/** Audit query E — manual rosters across centers and manual divisions. */
export async function runAuditQueryE(db: AuditDb): Promise<AuditRowE[]> {
  const [centerRows, divisionRows] = await Promise.all([
    db.centerMembership.findMany({ select: { centerCode: true, cwid: true, source: true } }),
    db.divisionMembership.findMany({ select: { divisionCode: true, cwid: true, source: true } }),
  ]);
  const rows: AuditRowE[] = [
    ...centerRows.map((r) => ({ unitKind: "center" as const, code: r.centerCode, cwid: r.cwid, source: r.source })),
    ...divisionRows.map((r) => ({ unitKind: "division" as const, code: r.divisionCode, cwid: r.cwid, source: r.source })),
  ];
  // ORDER BY unit_kind, code.
  rows.sort((a, b) => a.unitKind.localeCompare(b.unitKind) || a.code.localeCompare(b.code));
  return rows;
}
