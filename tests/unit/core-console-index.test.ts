/**
 * `/edit/core` index loader (lib/api/core-console-index.ts): the pure row
 * builder and the DB wrapper over an injected reader. Fake cores and people only.
 */
import { describe, expect, it } from "vitest";

import {
  buildCoreConsoleRows,
  loadCoreConsoleIndex,
  type CoreConsoleInputs,
} from "@/lib/api/core-console-index";

const baseCore = {
  facility: null,
  visible: false,
  url: null,
  description: null,
  staffCount: null,
  staffTrackedCount: null,
};

function inputs(over: Partial<CoreConsoleInputs> = {}): CoreConsoleInputs {
  return {
    cores: [
      {
        ...baseCore,
        id: "10",
        name: "Zeta Core",
        visible: true,
        url: "https://x.test",
        description: " ",
      },
      { ...baseCore, id: "2", name: "Alpha Core", staffCount: 4, staffTrackedCount: 3 },
    ],
    leaders: [{ coreId: "2", cwid: "aaa0001", role: "director", interim: true }],
    roleLabels: new Map([["director", "Director"]]),
    admins: [
      { entityId: "2", cwid: "bbb0002", role: "owner", granteeName: "Fallback Name" },
      { entityId: "2", cwid: "ccc0003", role: "curator", granteeName: null },
    ],
    names: new Map([["aaa0001", "Test Leader"]]),
    candidateTotals: new Map([["2", 10]]),
    candidateHighs: new Map([["2", 4]]),
    claimedCandidates: [
      { coreId: "2", likelihood: 0.9 },
      { coreId: "2", likelihood: 0.5 },
    ],
    confirmedByCore: new Map([["2", ["1", "2", "3"]]]),
    clients: [
      { coreId: "2", cwid: "ddd0004" },
      { coreId: "2", cwid: null },
      { coreId: "10", cwid: null },
    ],
    ...over,
  };
}

describe("buildCoreConsoleRows", () => {
  it("orders by numeric core id and assembles each row", () => {
    const [alpha, zeta] = buildCoreConsoleRows(inputs());
    expect(alpha.id).toBe("2");
    expect(zeta.id).toBe("10");

    expect(alpha.leaders).toEqual([{ name: "Test Leader", role: "Director", interim: true }]);
    // Scholar name wins; else the stored grantee name; else the cwid.
    expect(alpha.owners).toEqual(["Fallback Name"]);
    expect(alpha.curators).toEqual(["ccc0003"]);
    expect(alpha.confirmed).toBe(3);
    expect(alpha.clientsWithCwid).toBe(1);
    expect(alpha.clientsNameOnly).toBe(1);
    expect(alpha.staffListed).toBe(4);
    expect(alpha.staffTracked).toBe(3);

    expect(zeta.hasUrl).toBe(true);
    expect(zeta.hasDescription).toBe(false); // whitespace-only is not written
    expect(zeta.staffListed).toBeNull(); // no feed stays null, never 0
    expect(zeta.reviewTotal).toBe(0);
  });

  it("subtracts claimed/rejected candidates from the open review counts", () => {
    const [alpha] = buildCoreConsoleRows(inputs());
    expect(alpha.reviewTotal).toBe(8);
    expect(alpha.reviewHigh).toBe(3);
  });

  it("never reports negative or high > total", () => {
    const [alpha] = buildCoreConsoleRows(
      inputs({
        candidateTotals: new Map([["2", 1]]),
        candidateHighs: new Map([["2", 5]]),
        claimedCandidates: [
          { coreId: "2", likelihood: 0.1 },
          { coreId: "2", likelihood: 0.1 },
        ],
      }),
    );
    expect(alpha.reviewTotal).toBe(0);
    expect(alpha.reviewHigh).toBe(0);
  });
});

describe("loadCoreConsoleIndex", () => {
  it("counts only candidates whose pair carries an active claim as decided", async () => {
    const reader = {
      core: { findMany: async () => [{ ...baseCore, id: "1", name: "Alpha Core" }] },
      coreLeader: { findMany: async () => [] },
      orgUnitRole: { findMany: async () => [] },
      unitAdmin: { findMany: async () => [] },
      scholar: { findMany: async () => [] },
      coreClient: { findMany: async () => [] },
      coreClaim: {
        findMany: async (args: { where: Record<string, unknown> }) =>
          "coreId" in args.where
            ? [] // loadConfirmedCorePmidsByCore
            : [{ coreId: "1", pmid: "100" }],
      },
      publicationCore: {
        groupBy: async (args: { where: { likelihood?: unknown } }) =>
          args.where.likelihood
            ? [{ coreId: "1", _count: { _all: 2 } }]
            : [{ coreId: "1", _count: { _all: 5 } }],
        findMany: async (args: { where: { status: string } }) =>
          args.where.status === "candidate"
            ? [
                // pmid 100 is claimed on core 1, but the same pmid on core 9 is not.
                { coreId: "1", pmid: "100", likelihood: "0.95" },
                { coreId: "9", pmid: "100", likelihood: "0.95" },
              ]
            : [{ coreId: "1", pmid: "7", status: "confirmed" }],
      },
    } as unknown as Parameters<typeof loadCoreConsoleIndex>[0];

    const [row] = await loadCoreConsoleIndex(reader);
    expect(row.reviewTotal).toBe(4);
    expect(row.reviewHigh).toBe(1);
    expect(row.confirmed).toBe(1);
  });
});
