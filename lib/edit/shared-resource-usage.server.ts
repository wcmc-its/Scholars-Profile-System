/**
 * Report 20 loader: the quarters with iLab charges, one quarter's `core_charge`
 * rows, and the center's programs and research memberships, handed to
 * `computeSharedResourceUsage`, plus view 7's grant and paper links, handed to
 * `computeSrPaperCandidates`. The caller has passed the unit gate.
 * Server-only (reads `@/lib/db`).
 */
import { wbsFinAccount } from "@/etl/ilab/parse";
import { db } from "@/lib/db";
import { parseExternalId } from "@/lib/funding-projection";
import {
  computeSrPaperCandidates,
  TIER_A_STATUSES,
  type SrPaperCandidates,
} from "@/lib/edit/shared-resource-papers";
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
  /** View 7; null when `usage` is, or when not asked for. */
  papers: SrPaperCandidates | null;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function loadSharedResourceUsage(
  centerCode: string,
  p: SharedResourceParams,
  { papers: withPapers = true }: { papers?: boolean } = {},
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
    return { resources, quarters, quarter, programs, usage: null, papers: null };

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
        paymentNumber: true,
        purchaseDate: true,
        billingDate: true,
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
  if (charges.length === 0)
    return { resources, quarters, quarter, programs, usage: null, papers: null };
  const members = memberships.map((m) => ({ ...m, cwid: m.cwid.toLowerCase() }));
  const usage = computeSharedResourceUsage({
    charges: charges.map((c) => ({
      ...c,
      totalPrice: Number(c.totalPrice),
      erpDate: day(c.erpDate),
    })),
    memberships: members,
    programs: programs.map((x) => x.code),
    resources,
    quarter,
  });
  const srCharges = charges.map((c) => ({
    coreName: c.coreName,
    customerLab: c.customerLab,
    piCwid: c.piCwid,
    paymentNumber: c.paymentNumber,
    erpDate: day(c.erpDate),
    chargeDate: day(c.purchaseDate ?? c.billingDate ?? c.erpDate),
  }));
  const papers = withPapers
    ? computeSrPaperCandidates({
        ...(await loadPaperLinks(srCharges, resources)),
        charges: srCharges,
        memberships: members,
        resources,
        quarter,
      })
    : null;
  return { resources, quarters, quarter, programs, usage, papers };
}

/**
 * View 7's DB half: the SR charges' WBS fin accounts -> InfoEd accounts ->
 * InfoEd grant rows -> their papers, plus the cores engine's attributions of
 * those papers.
 */
async function loadPaperLinks(
  charges: ReadonlyArray<{ coreName: string; paymentNumber: string | null }>,
  resources: readonly SharedResource[],
) {
  const srCores = new Set(resources.flatMap((r) => r.cores));
  const fins = [
    ...new Set(
      charges
        .filter((c) => srCores.has(c.coreName))
        .map((c) => wbsFinAccount(c.paymentNumber))
        .filter((f): f is string => f !== null),
    ),
  ];
  const finAccounts = fins.length
    ? await db.read.infoedFinAccount.findMany({ where: { finAccount: { in: fins } } })
    : [];
  const accounts = [...new Set(finAccounts.map((f) => f.accountNumber))];
  const grantRows = accounts.length
    ? await db.read.grant.findMany({
        where: { OR: accounts.map((a) => ({ externalId: { startsWith: `INFOED-${a}-` } })) },
        select: { id: true, externalId: true, awardNumber: true, startDate: true, endDate: true },
      })
    : [];
  const grants = grantRows.map((g) => ({
    id: g.id,
    accountNumber: parseExternalId(g.externalId)?.accountNumber ?? "",
    awardNumber: g.awardNumber,
    startDate: day(g.startDate),
    endDate: day(g.endDate),
  }));
  const linkRows = grants.length
    ? await db.read.grantPublication.findMany({
        where: { grantId: { in: grants.map((g) => g.id) } },
        select: {
          grantId: true,
          pmid: true,
          publication: { select: { title: true, year: true, dateAddedToEntrez: true } },
        },
      })
    : [];
  const links = linkRows.map((l) => ({
    grantId: l.grantId,
    pmid: l.pmid,
    title: l.publication.title,
    year: l.publication.year,
    pubDate: l.publication.dateAddedToEntrez ? day(l.publication.dateAddedToEntrez) : null,
  }));
  const pmids = [...new Set(links.map((l) => l.pmid))];
  const cores = pmids.length
    ? await db.read.publicationCore.findMany({
        where: { pmid: { in: pmids }, status: { in: [...TIER_A_STATUSES] } },
        select: { pmid: true, coreId: true, status: true },
      })
    : [];
  return { finAccounts, grants, links, cores };
}
