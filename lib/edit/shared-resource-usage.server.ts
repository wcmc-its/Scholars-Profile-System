/**
 * Report 20 loader: the quarters with iLab charges, one quarter's `core_charge`
 * rows, and the center's programs and research memberships, handed to
 * `computeSharedResourceUsage`. The caller has passed the unit gate.
 * Server-only (reads `@/lib/db`).
 */
import { db } from "@/lib/db";
import {
  computeSharedResourceUsage,
  fiscalQuarterOf,
  parseFiscalQuarterKey,
  SHARED_RESOURCES,
  type FiscalQuarter,
  type SharedResource,
  type SharedResourceParams,
  type SharedResourceUsage,
} from "@/lib/edit/shared-resource-usage";

export type SharedResourceReport = {
  resources: readonly SharedResource[];
  /** Quarters with at least one charge, newest first. */
  quarters: FiscalQuarter[];
  /** The quarter shown; null when there are no charges at all. */
  quarter: FiscalQuarter | null;
  programs: Array<{ code: string; label: string }>;
  usage: SharedResourceUsage | null;
};

export async function loadSharedResourceUsage(
  centerCode: string,
  p: SharedResourceParams,
): Promise<SharedResourceReport> {
  const resources = SHARED_RESOURCES[centerCode] ?? [];
  const [dates, programs] = await Promise.all([
    db.read.coreCharge.findMany({ distinct: ["erpDate"], select: { erpDate: true } }),
    db.read.centerProgram.findMany({
      where: { centerCode },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { code: true, label: true },
    }),
  ]);
  const byKey = new Map(
    dates.map((d) => fiscalQuarterOf(d.erpDate.toISOString().slice(0, 10))).map((q) => [q.key, q]),
  );
  const quarters = [...byKey.values()].sort((a, b) => b.start.localeCompare(a.start));
  const quarter = (p.quarter ? parseFiscalQuarterKey(p.quarter) : null) ?? quarters[0] ?? null;
  if (!quarter || resources.length === 0)
    return { resources, quarters, quarter, programs, usage: null };

  const [charges, memberships] = await Promise.all([
    db.read.coreCharge.findMany({
      where: { erpDate: { gte: new Date(quarter.start), lt: new Date(quarter.end) } },
      select: {
        coreName: true,
        customerLab: true,
        piCwid: true,
        ilabMcc: true,
        totalPrice: true,
        isSubsidy: true,
        erpDate: true,
      },
    }),
    db.read.centerMembership.findMany({
      where: { centerCode, membershipType: "research" },
      select: {
        cwid: true,
        programCode: true,
        startDate: true,
        endDate: true,
        membershipRoleKey: true,
      },
    }),
  ]);
  const usage = charges.length
    ? computeSharedResourceUsage({
        charges: charges.map((c) => ({
          ...c,
          totalPrice: Number(c.totalPrice),
          erpDate: c.erpDate.toISOString().slice(0, 10),
        })),
        memberships: memberships.map((m) => ({ ...m, cwid: m.cwid.toLowerCase() })),
        programs: programs.map((x) => x.code),
        resources,
        quarter,
      })
    : null;
  return { resources, quarters, quarter, programs, usage };
}
