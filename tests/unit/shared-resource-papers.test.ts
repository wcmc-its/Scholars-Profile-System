/**
 * Report 20, view 7 (`lib/edit/shared-resource-papers.ts`): the WBS -> grant ->
 * paper chain, the award tie-break, the published-after-charge filter and the
 * tiers. Synthetic fixtures only (the repo is public): made-up labs, PIs,
 * accounts, awards and PMIDs.
 */
import { describe, expect, it } from "vitest";

import {
  computeSrPaperCandidates,
  grantsForDate,
  publishedAfter,
  type PaperCharge,
  type PaperGrant,
  type PaperLink,
} from "@/lib/edit/shared-resource-papers";
import {
  fiscalQuarter,
  type SharedResource,
  type UsageMembership,
} from "@/lib/edit/shared-resource-usage";

const Q = fiscalQuarter(2027, 1); // 2026-07-01 .. 2026-10-01
const RESOURCES: SharedResource[] = [
  { name: "Imaging", cores: ["Citigroup Biomedical Imaging Center", "Optical Microscopy Core"] },
  { name: "Flow Cytometry", cores: ["Flow Cytometry Core Facility"] },
];
const MEMBERS: UsageMembership[] = [
  { cwid: "zzz1001", programCode: "P1", startDate: null, endDate: null, membershipRoleKey: null },
  { cwid: "zzz1002", programCode: "P2", startDate: null, endDate: null, membershipRoleKey: null },
];

const charge = (o: Partial<PaperCharge> = {}): PaperCharge => ({
  coreName: "Flow Cytometry Core Facility",
  customerLab: "Lab One",
  piCwid: "zzz1001",
  paymentNumber: "1111111101",
  totalPrice: 100,
  erpDate: "2026-08-15",
  chargeDate: "2026-08-01",
  ...o,
});
const grant = (o: Partial<PaperGrant> = {}): PaperGrant => ({
  id: "g1",
  accountNumber: "ACCT-1",
  awardNumber: "R01 XX000001",
  startDate: "2025-01-01",
  endDate: "2029-12-31",
  ...o,
});
const link = (o: Partial<PaperLink> = {}): PaperLink => ({
  grantId: "g1",
  pmid: "90000001",
  title: "A synthetic paper",
  year: 2026,
  pubDate: "2026-09-01",
  ...o,
});

function run(o: {
  charges?: PaperCharge[];
  finAccounts?: Array<{ finAccount: string; accountNumber: string }>;
  grants?: PaperGrant[];
  links?: PaperLink[];
  cores?: Array<{ pmid: string; coreId: string; status: string }>;
}) {
  return computeSrPaperCandidates({
    charges: o.charges ?? [charge()],
    finAccounts: o.finAccounts ?? [{ finAccount: "11111111", accountNumber: "ACCT-1" }],
    grants: o.grants ?? [grant()],
    links: o.links ?? [link()],
    cores: o.cores ?? [],
    memberships: MEMBERS,
    resources: RESOURCES,
    quarter: Q,
  });
}

describe("publishedAfter", () => {
  it("compares the Entrez date strictly after the charge date", () => {
    expect(publishedAfter({ pubDate: "2026-08-02", year: 2026 }, "2026-08-01")).toBe(true);
    expect(publishedAfter({ pubDate: "2026-08-01", year: 2026 }, "2026-08-01")).toBe(false);
    expect(publishedAfter({ pubDate: "2026-07-31", year: 2026 }, "2026-08-01")).toBe(false);
  });

  it("falls back to a later year when there is no Entrez date", () => {
    expect(publishedAfter({ pubDate: null, year: 2027 }, "2026-08-01")).toBe(true);
    expect(publishedAfter({ pubDate: null, year: 2026 }, "2026-08-01")).toBe(false);
    expect(publishedAfter({ pubDate: null, year: null }, "2026-08-01")).toBe(false);
  });
});

describe("grantsForDate", () => {
  const old = grant({ id: "old", startDate: "2020-01-01", endDate: "2024-12-31" });
  const cur = grant({ id: "cur", startDate: "2025-01-01", endDate: "2029-12-31" });
  it("keeps only awards covering the charge date, ends inclusive", () => {
    expect(grantsForDate([old, cur], "2026-08-01").map((g) => g.id)).toEqual(["cur"]);
    expect(grantsForDate([old, cur], "2024-12-31").map((g) => g.id)).toEqual(["old"]);
  });
  it("keeps every award when none covers the date", () => {
    expect(grantsForDate([old, cur], "2030-06-01").map((g) => g.id)).toEqual(["old", "cur"]);
  });
});

describe("computeSrPaperCandidates", () => {
  it("follows WBS[:8] -> account -> grant -> paper, tier B without a core attribution", () => {
    const { rows, summary } = run({});
    expect(rows).toEqual([
      {
        customerLab: "Lab One",
        group: "P1",
        sr: "Flow Cytometry",
        coreName: "Flow Cytometry Core Facility",
        awards: ["R01 XX000001"],
        pmid: "90000001",
        title: "A synthetic paper",
        year: 2026,
        tier: "B",
        coreStatus: null,
      },
    ]);
    expect(summary).toEqual([
      { sr: "Imaging", tierA: 0, tierB: 0 },
      { sr: "Flow Cytometry", tierA: 0, tierB: 1 },
    ]);
  });

  it("is tier A when the cores engine attributes the paper to the billed core", () => {
    const confirmed = run({ cores: [{ pmid: "90000001", coreId: "4", status: "confirmed" }] });
    expect(confirmed.rows[0]).toMatchObject({ tier: "A", coreStatus: "confirmed" });
    expect(confirmed.summary[1]).toEqual({ sr: "Flow Cytometry", tierA: 1, tierB: 0 });

    const candidate = run({ cores: [{ pmid: "90000001", coreId: "4", status: "candidate" }] });
    expect(candidate.rows[0]).toMatchObject({ tier: "A", coreStatus: "candidate" });
  });

  it("stays tier B for another core's attribution or a below-threshold row", () => {
    const other = run({ cores: [{ pmid: "90000001", coreId: "2", status: "confirmed" }] });
    expect(other.rows[0].tier).toBe("B");
    const below = run({ cores: [{ pmid: "90000001", coreId: "4", status: "below_threshold" }] });
    expect(below.rows[0].tier).toBe("B");
  });

  it("is only tier B at a core with no core id, even with an attribution", () => {
    const { rows } = run({
      charges: [charge({ coreName: "Optical Microscopy Core" })],
      cores: [{ pmid: "90000001", coreId: "2", status: "confirmed" }],
    });
    expect(rows[0]).toMatchObject({ sr: "Imaging", tier: "B", coreStatus: null });
  });

  it("drops papers published on or before the charge date", () => {
    const { rows } = run({
      links: [
        link({ pmid: "90000001", pubDate: "2026-07-31" }),
        link({ pmid: "90000002", pubDate: "2026-08-01" }),
        link({ pmid: "90000003", pubDate: "2026-08-02" }),
        link({ pmid: "90000004", pubDate: null, year: 2026 }),
        link({ pmid: "90000005", pubDate: null, year: 2027 }),
      ],
    });
    expect(rows.map((r) => r.pmid)).toEqual(["90000003", "90000005"]);
  });

  it("counts a paper after any charge, measured from that charge's date", () => {
    const { rows } = run({
      charges: [charge({ chargeDate: "2026-09-10" }), charge({ chargeDate: "2026-07-05" })],
      links: [link({ pubDate: "2026-08-01" })],
    });
    expect(rows).toHaveLength(1);
  });

  it("prefers the award active on the charge date when one fin account reaches several", () => {
    const { rows } = run({
      finAccounts: [
        { finAccount: "11111111", accountNumber: "ACCT-1" },
        { finAccount: "11111111", accountNumber: "ACCT-2" },
      ],
      grants: [
        grant({ id: "g1", accountNumber: "ACCT-1", awardNumber: "R01 XX000001" }),
        grant({
          id: "g2",
          accountNumber: "ACCT-2",
          awardNumber: "R01 XX000002",
          startDate: "2018-01-01",
          endDate: "2022-12-31",
        }),
      ],
      links: [link({ grantId: "g1", pmid: "90000001" }), link({ grantId: "g2", pmid: "90000002" })],
    });
    expect(rows.map((r) => [r.pmid, r.awards])).toEqual([["90000001", ["R01 XX000001"]]]);
  });

  it("merges the awards of co-investigator rows that reach the same paper", () => {
    const { rows } = run({
      grants: [grant({ id: "g1" }), grant({ id: "g1b", awardNumber: null })],
      links: [link({ grantId: "g1" }), link({ grantId: "g1b" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].awards).toEqual(["ACCT-1", "R01 XX000001"]);
  });

  it("skips non-members, non-SR cores, 8-digit funds and charges outside the quarter", () => {
    const { rows } = run({
      charges: [
        charge({ piCwid: "zzz9999" }),
        charge({ piCwid: null }),
        charge({ coreName: "Some Other Core" }),
        charge({ paymentNumber: "11111111" }),
        charge({ paymentNumber: null }),
        charge({ erpDate: "2026-10-01" }),
        charge({ erpDate: "2026-06-30" }),
      ],
    });
    expect(rows).toEqual([]);
  });

  it("skips refund and zero-dollar lines, and a lab's WBS that nets to $0 or less", () => {
    expect(run({ charges: [charge({ totalPrice: -100 })] }).rows).toEqual([]);
    expect(run({ charges: [charge({ totalPrice: 0 })] }).rows).toEqual([]);
    expect(
      run({ charges: [charge({ totalPrice: 100 }), charge({ totalPrice: -100 })] }).rows,
    ).toEqual([]);
    expect(
      run({ charges: [charge({ totalPrice: 100 }), charge({ totalPrice: -40 })] }).rows,
    ).toHaveLength(1);
  });

  it("counts distinct papers per SR, tier A winning when one core of the SR agrees", () => {
    const { rows, summary } = run({
      charges: [
        charge({ coreName: "Citigroup Biomedical Imaging Center" }),
        charge({ coreName: "Optical Microscopy Core" }),
        charge({ customerLab: "Lab Two", piCwid: "zzz1002" }),
      ],
      cores: [{ pmid: "90000001", coreId: "2", status: "candidate" }],
    });
    expect(rows.map((r) => [r.customerLab, r.group, r.coreName, r.tier])).toEqual([
      ["Lab One", "P1", "Citigroup Biomedical Imaging Center", "A"],
      ["Lab Two", "P2", "Flow Cytometry Core Facility", "B"],
      ["Lab One", "P1", "Optical Microscopy Core", "B"],
    ]);
    expect(summary).toEqual([
      { sr: "Imaging", tierA: 1, tierB: 0 },
      { sr: "Flow Cytometry", tierA: 0, tierB: 1 },
    ]);
  });
});
