/**
 * Report 20, view 7: candidate papers supported by a shared resource (SR). The
 * pure half; the loader is `loadSharedResourceUsage`.
 *
 * A research member's charge at an SR core, paid on a 10-digit WBS, leads
 * WBS[:8] -> `infoed_fin_account` -> InfoEd account(s) -> `grant` rows
 * (`INFOED-{account}-{cwid}`) -> `grant_publication` -> papers. When the fin
 * account reaches several grants, the ones whose dates cover the charge date
 * win; if none covers it, all are kept. A paper counts only when it was
 * published after the charge date. Refund and zero-dollar lines lead nowhere,
 * nor does a lab's WBS at a core that nets to $0 or less for the quarter.
 *
 * Tier A: the cores engine (`publication_core`, candidate or confirmed) also
 * attributes the paper to the billed core. Tier B: the grant link only.
 */
import { wbsFinAccount } from "@/etl/ilab/parse";
import {
  memberGroupOn,
  NON_MEMBER,
  type FiscalQuarter,
  type SharedResource,
  type UsageMembership,
} from "@/lib/edit/shared-resource-usage";

/**
 * iLab core name -> Scholars core id (`etl/dynamodb/core-catalog.ts`). The
 * optical microscopy cores have no core id, so their papers can only be tier B.
 */
export const CORE_ID_BY_ILAB_CORE: Readonly<Record<string, string>> = {
  "Citigroup Biomedical Imaging Center": "2",
  "Epigenomics Core": "3",
  "Flow Cytometry Core Facility": "4",
  "Genomics Resources Core Facility": "5",
  "Proteomics and Metabolomics Core Facility": "13",
};

/** `publication_core` statuses that count for tier A. */
export const TIER_A_STATUSES = ["confirmed", "candidate"] as const;

export type PaperCharge = {
  coreName: string;
  customerLab: string | null;
  piCwid: string | null;
  paymentNumber: string | null;
  /** iLab Total Price; refunds are negative. */
  totalPrice: number;
  /** `YYYY-MM-DD`; places the charge in the quarter and the PI in a program (as views 1–6). */
  erpDate: string;
  /** `YYYY-MM-DD`: when the work was done (purchase date, else billing date, else ERP date). */
  chargeDate: string;
};

export type PaperGrant = {
  id: string;
  /** The InfoEd Account_Number from `INFOED-{account}-{cwid}`. */
  accountNumber: string;
  awardNumber: string | null;
  /** `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
};

export type PaperLink = {
  grantId: string;
  pmid: string;
  title: string;
  year: number | null;
  /** `YYYY-MM-DD` Entrez date, the most precise publication date held; null falls back to `year`. */
  pubDate: string | null;
};

export type PaperCoreRow = { pmid: string; coreId: string; status: string };

export type PaperRow = {
  customerLab: string;
  group: string;
  sr: string;
  coreName: string;
  /** Award numbers (else InfoEd accounts) of the grants that reach the paper. */
  awards: string[];
  pmid: string;
  title: string;
  year: number | null;
  tier: "A" | "B";
  /** The cores-engine status behind tier A; null for tier B. */
  coreStatus: string | null;
};

export type PaperSummaryRow = { sr: string; tierA: number; tierB: number };

export type SrPaperCandidates = { rows: PaperRow[]; summary: PaperSummaryRow[] };

/** Published strictly after `chargeDate`: by Entrez date when held, else by year alone. */
export function publishedAfter(
  link: Pick<PaperLink, "pubDate" | "year">,
  chargeDate: string,
): boolean {
  if (link.pubDate) return link.pubDate > chargeDate;
  return link.year !== null && link.year > Number(chargeDate.slice(0, 4));
}

/** The grants whose dates cover `date`, or all of them when none does. */
export function grantsForDate<T extends Pick<PaperGrant, "startDate" | "endDate">>(
  grants: readonly T[],
  date: string,
): T[] {
  const covering = grants.filter((g) => g.startDate <= date && date <= g.endDate);
  return covering.length ? covering : [...grants];
}

export function computeSrPaperCandidates(input: {
  charges: readonly PaperCharge[];
  finAccounts: ReadonlyArray<{ finAccount: string; accountNumber: string }>;
  grants: readonly PaperGrant[];
  links: readonly PaperLink[];
  cores: readonly PaperCoreRow[];
  memberships: readonly UsageMembership[];
  resources: readonly SharedResource[];
  quarter: FiscalQuarter;
}): SrPaperCandidates {
  const { quarter } = input;
  const srOf = new Map(input.resources.flatMap((r) => r.cores.map((c) => [c, r.name] as const)));
  const groupOn = memberGroupOn(input.memberships);
  const accountsOf = new Map<string, string[]>();
  for (const f of input.finAccounts)
    accountsOf.set(f.finAccount, [...(accountsOf.get(f.finAccount) ?? []), f.accountNumber]);
  const grantsOf = new Map<string, PaperGrant[]>();
  for (const g of input.grants)
    grantsOf.set(g.accountNumber, [...(grantsOf.get(g.accountNumber) ?? []), g]);
  const linksOf = new Map<string, PaperLink[]>();
  for (const l of input.links) linksOf.set(l.grantId, [...(linksOf.get(l.grantId) ?? []), l]);
  const statusOf = new Map(
    input.cores
      .filter((c) => (TIER_A_STATUSES as readonly string[]).includes(c.status))
      .map((c) => [`${c.pmid}|${c.coreId}`, c.status]),
  );

  const inQuarter = input.charges.filter(
    (c) => c.erpDate >= quarter.start && c.erpDate < quarter.end,
  );
  const netKey = (c: PaperCharge) => JSON.stringify([c.customerLab, c.coreName, c.paymentNumber]);
  const netCents = new Map<string, number>();
  for (const c of inQuarter)
    netCents.set(netKey(c), (netCents.get(netKey(c)) ?? 0) + Math.round(c.totalPrice * 100));

  const rows = new Map<string, PaperRow & { awardSet: Set<string> }>();
  for (const c of inQuarter) {
    if (c.totalPrice <= 0 || (netCents.get(netKey(c)) ?? 0) <= 0) continue;
    const sr = srOf.get(c.coreName);
    const fin = wbsFinAccount(c.paymentNumber);
    if (!sr || !fin) continue;
    const group = groupOn(c.piCwid, c.erpDate);
    if (group === NON_MEMBER) continue;
    const grants = grantsForDate(
      (accountsOf.get(fin) ?? []).flatMap((a) => grantsOf.get(a) ?? []),
      c.chargeDate,
    );
    const coreId = CORE_ID_BY_ILAB_CORE[c.coreName];
    const lab = c.customerLab ?? "(no lab)";
    for (const g of grants) {
      for (const l of linksOf.get(g.id) ?? []) {
        if (!publishedAfter(l, c.chargeDate)) continue;
        const key = JSON.stringify([lab, group, c.coreName, l.pmid]);
        const status = coreId ? (statusOf.get(`${l.pmid}|${coreId}`) ?? null) : null;
        const row = rows.get(key) ?? {
          customerLab: lab,
          group,
          sr,
          coreName: c.coreName,
          awards: [],
          awardSet: new Set<string>(),
          pmid: l.pmid,
          title: l.title,
          year: l.year,
          tier: status ? "A" : "B",
          coreStatus: status,
        };
        row.awardSet.add(g.awardNumber ?? g.accountNumber);
        rows.set(key, row);
      }
    }
  }

  const out = [...rows.values()]
    .map(({ awardSet, ...r }) => ({ ...r, awards: [...awardSet].sort() }))
    .sort(
      (a, b) =>
        a.tier.localeCompare(b.tier) ||
        a.sr.localeCompare(b.sr) ||
        a.customerLab.localeCompare(b.customerLab) ||
        a.pmid.localeCompare(b.pmid),
    );
  // Distinct papers per SR and tier; a paper tier A at one core of an SR counts as A there.
  const summary = input.resources.map((r) => {
    const tierOf = new Map<string, "A" | "B">();
    for (const x of out)
      if (x.sr === r.name && tierOf.get(x.pmid) !== "A") tierOf.set(x.pmid, x.tier);
    const tiers = [...tierOf.values()];
    return {
      sr: r.name,
      tierA: tiers.filter((t) => t === "A").length,
      tierB: tiers.filter((t) => t === "B").length,
    };
  });
  return { rows: out, summary };
}
