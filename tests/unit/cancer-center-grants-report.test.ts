/**
 * `loadCenterActiveGrants` (`lib/edit/cancer-center-grants-report.ts`), the
 * query behind `/edit/reports/4` ("Grants active as of a date").
 *
 * Membership resolution (`loadActiveCenterMemberCwids`) is mocked at the
 * module level — it is not parameterized (it owns its own `@/lib/db` import,
 * cached with React `cache()`), so mocking `@/lib/api/centers` is the way to
 * control it. The `grant` / `scholar` reads the function under test DOES take
 * as a parameter are exercised with a hand-built fake client, matching
 * `tests/unit/center-scholar-count-live.test.ts`'s convention for a
 * `Pick<PrismaClient, …>`-typed dependency.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadActiveCenterMemberCwidsMock } = vi.hoisted(() => ({
  loadActiveCenterMemberCwidsMock: vi.fn(),
}));

vi.mock("@/lib/api/centers", () => ({
  loadActiveCenterMemberCwids: loadActiveCenterMemberCwidsMock,
}));

import {
  loadCenterActiveGrants,
  type CenterActiveGrantsClient,
} from "@/lib/edit/cancer-center-grants-report";

type GrantRow = {
  cwid: string;
  title: string;
  role: string;
  funder: string;
  primeSponsor: string | null;
  primeSponsorRaw: string | null;
  startDate: Date;
  endDate: Date;
};

type ScholarRow = { cwid: string; preferredName: string };

/** Minimal stand-in for the two queries the function issues. */
function clientWith(grants: GrantRow[], scholars: ScholarRow[]): CenterActiveGrantsClient {
  return {
    grant: {
      findMany: async ({ where }: { where: { cwid: { in: string[] } } }) =>
        grants.filter((g) => where.cwid.in.includes(g.cwid)),
    },
    scholar: {
      findMany: async ({ where }: { where: { cwid: { in: string[] } } }) =>
        scholars.filter((s) => where.cwid.in.includes(s.cwid)),
    },
  } as unknown as CenterActiveGrantsClient;
}

const day = (iso: string) => new Date(iso);

function grant(overrides: Partial<GrantRow> & { cwid: string; title: string }): GrantRow {
  return {
    role: "PI",
    funder: "NIH",
    primeSponsor: null,
    primeSponsorRaw: null,
    startDate: day("2020-01-01"),
    endDate: day("2030-01-01"),
    ...overrides,
  };
}

beforeEach(() => {
  loadActiveCenterMemberCwidsMock.mockReset();
});

describe("loadCenterActiveGrants", () => {
  it("returns [] without querying grants when the center has no active members", async () => {
    loadActiveCenterMemberCwidsMock.mockResolvedValue([]);
    let queried = false;
    const client = {
      grant: { findMany: async () => { queried = true; return []; } },
      scholar: { findMany: async () => [] },
    } as unknown as CenterActiveGrantsClient;

    const rows = await loadCenterActiveGrants("meyer", day("2026-06-01"), client);
    expect(rows).toEqual([]);
    expect(queried).toBe(false);
  });

  it("keeps only grants active as of the chosen date", async () => {
    loadActiveCenterMemberCwidsMock.mockResolvedValue(["aaa1001", "bbb2002"]);
    const client = clientWith(
      [
        grant({ cwid: "aaa1001", title: "Active one" }),
        grant({
          cwid: "bbb2002",
          title: "Ended long ago",
          startDate: day("2010-01-01"),
          endDate: day("2015-01-01"),
        }),
      ],
      [
        { cwid: "aaa1001", preferredName: "Ada Faculty" },
        { cwid: "bbb2002", preferredName: "Bo Faculty" },
      ],
    );

    const rows = await loadCenterActiveGrants("meyer", day("2026-06-01"), client);
    expect(rows.map((r) => r.title)).toEqual(["Active one"]);
  });

  it("sorts rows by the row's member's last name", async () => {
    loadActiveCenterMemberCwidsMock.mockResolvedValue(["zzz9001", "aaa1001"]);
    const client = clientWith(
      [grant({ cwid: "zzz9001", title: "Z project" }), grant({ cwid: "aaa1001", title: "A project" })],
      [
        { cwid: "zzz9001", preferredName: "Zack Ainsworth" },
        { cwid: "aaa1001", preferredName: "Amy Bell" },
      ],
    );

    const rows = await loadCenterActiveGrants("meyer", day("2026-06-01"), client);
    // Sorted by extracted SURNAME — "Ainsworth" precedes "Bell" — not by the
    // preferredName's leading given-name token ("Amy" precedes "Zack").
    expect(rows.map((r) => r.piName)).toEqual(["Zack Ainsworth", "Amy Bell"]);
  });

  it("resolves sponsor as primeSponsor, else a canonicalized primeSponsorRaw, else the legacy funder", async () => {
    loadActiveCenterMemberCwidsMock.mockResolvedValue(["aaa1001", "bbb2002", "ccc3003"]);
    const client = clientWith(
      [
        grant({ cwid: "aaa1001", title: "P1", primeSponsor: "NCI", funder: "NIH" }),
        grant({
          cwid: "bbb2002",
          title: "P2",
          primeSponsorRaw: "National Science Foundation",
          funder: "Legacy Funder",
        }),
        grant({ cwid: "ccc3003", title: "P3", funder: "Legacy Funder Only" }),
      ],
      [
        { cwid: "aaa1001", preferredName: "Ada Faculty" },
        { cwid: "bbb2002", preferredName: "Bo Faculty" },
        { cwid: "ccc3003", preferredName: "Cy Faculty" },
      ],
    );

    const rows = await loadCenterActiveGrants("meyer", day("2026-06-01"), client);
    const sponsorByTitle = new Map(rows.map((r) => [r.title, r.sponsor]));
    expect(sponsorByTitle.get("P1")).toBe("NCI");
    expect(sponsorByTitle.get("P2")).toBe("NSF");
    expect(sponsorByTitle.get("P3")).toBe("Legacy Funder Only");
  });

  it("falls back to the cwid as the display name when no Scholar row resolves", async () => {
    loadActiveCenterMemberCwidsMock.mockResolvedValue(["aaa1001"]);
    const client = clientWith([grant({ cwid: "aaa1001", title: "Orphan grant" })], []);

    const rows = await loadCenterActiveGrants("meyer", day("2026-06-01"), client);
    expect(rows).toEqual([
      expect.objectContaining({ cwid: "aaa1001", piName: "aaa1001", title: "Orphan grant" }),
    ]);
  });
});
