/**
 * #2238 / #2239 — one definition of "a grant" for a scholar's own funding count:
 * a funding PROJECT (awards grouped by NIH core project number), counted over the
 * rows the profile Funding section lists. Covers the shared pure module and its
 * use by the people-index builder (`grantCount`), which must agree with the
 * profile header.
 */
import { describe, expect, it, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import {
  countGrantProjects,
  grantProjectKey,
  profileFundingRows,
} from "@/lib/grants/project-count";
import { buildPeopleDoc, type ScholarForIndex } from "@/lib/search-index-docs";

// Five award years of one R01 (renewals + supplements), one other NIH award, and
// one non-NIH award — the shape behind "9 grants" over five rows in #2238.
const AWARDS = [
  { externalId: "INFOED-1-self", awardNumber: "5R01 GM000001-24", source: "InfoEd" },
  { externalId: "INFOED-2-self", awardNumber: "3R01 GM000001-22S1", source: "InfoEd" },
  { externalId: "INFOED-3-self", awardNumber: "5R01 GM000001-20", source: "InfoEd" },
  { externalId: "INFOED-4-self", awardNumber: "3R01 GM000001-19S1", source: "InfoEd" },
  { externalId: "INFOED-5-self", awardNumber: "5R01 GM000001-16", source: "InfoEd" },
  { externalId: "INFOED-6-self", awardNumber: "K23 HL000002", source: "InfoEd" },
  { externalId: "INFOED-7-self", awardNumber: "FOUNDATION-2024-001", source: "InfoEd" },
];

describe("countGrantProjects", () => {
  it("collapses renewal years of one core project into one grant", () => {
    expect(countGrantProjects(AWARDS)).toBe(3);
  });

  it("counts every award without a core project number on its own", () => {
    expect(
      countGrantProjects([
        { awardNumber: null },
        { awardNumber: null },
        { awardNumber: "OCRA-2024-091" },
      ]),
    ).toBe(3);
  });

  it("keys on the NIH core project number", () => {
    expect(grantProjectKey({ awardNumber: "1R01CA245678-01A1" })).toBe("R01CA245678");
    expect(grantProjectKey({ awardNumber: "OCRA-2024-091" })).toBeNull();
  });
});

describe("profileFundingRows", () => {
  it("drops a suppressed grant role and keeps the rest", () => {
    const rows = profileFundingRows(AWARDS, {
      hideFunding: false,
      suppressedGrantIds: new Set(["INFOED-6-self"]),
    });
    expect(rows.map((r) => r.externalId)).not.toContain("INFOED-6-self");
    expect(rows).toHaveLength(6);
  });

  it("returns nothing when the scholar hid the Funding section", () => {
    expect(profileFundingRows(AWARDS, { hideFunding: true, suppressedGrantIds: new Set() })).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// People index `grantCount` (#2239).
// ---------------------------------------------------------------------------

const NO_SUP: PublicationSuppressions = { darkPmids: new Set(), hiddenAuthorsByPmid: new Map() };
type ClientArg = Parameters<typeof buildPeopleDoc>[1];

function mockClient(): ClientArg {
  const empty = { findMany: vi.fn().mockResolvedValue([]) };
  return {
    centerMembership: empty,
    divisionMembership: empty,
    publicationAuthor: empty,
    department: empty,
    division: empty,
    orgUnitRoleAssignment: empty,
  } as unknown as ClientArg;
}

const FAR_FUTURE = new Date("2999-12-31");

function scholarWith(grants: ReadonlyArray<Record<string, unknown>>): ScholarForIndex {
  return {
    cwid: "self",
    slug: "self",
    preferredName: "Self",
    fullName: "Self",
    postnominal: null,
    primaryTitle: null,
    primaryDepartment: null,
    overview: null,
    roleCategory: "faculty",
    deptCode: null,
    divCode: null,
    department: null,
    division: null,
    topicAssignments: [],
    grants: grants.map((g) => ({ role: "PI", endDate: FAR_FUTURE, mechanism: null, ...g })),
    authorships: [],
  } as unknown as ScholarForIndex;
}

type Visibility = Parameters<typeof buildPeopleDoc>[9];

async function grantCountOf(
  grants: ReadonlyArray<Record<string, unknown>>,
  visibility?: Visibility,
): Promise<number> {
  const doc = await buildPeopleDoc(
    scholarWith(grants),
    mockClient(),
    NO_SUP,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    visibility,
  );
  expect(doc).not.toBeNull();
  return (doc as { grantCount: number }).grantCount;
}

describe("buildPeopleDoc grantCount — same definition + population as the profile header", () => {
  it("counts funding projects, not award rows", async () => {
    expect(await grantCountOf(AWARDS)).toBe(3);
  });

  it("counts prior-institution RePORTER awards the profile lists", async () => {
    const reporter = {
      externalId: "reporter:self:R01AG000003",
      awardNumber: "R01AG000003",
      source: "RePORTER",
    };
    expect(await grantCountOf([...AWARDS, reporter])).toBe(4);
  });

  it("keeps the WCM-only scope for the active-grant signals", async () => {
    const doc = await buildPeopleDoc(
      scholarWith([
        { externalId: "reporter:self:R01AG000003", awardNumber: "R01AG000003", source: "RePORTER" },
      ]),
      mockClient(),
      NO_SUP,
    );
    expect(doc).toMatchObject({ grantCount: 1, hasActiveGrants: false, activePiGrantCount: 0 });
  });

  it("drops suppressed grant roles and honors hideFunding", async () => {
    expect(
      await grantCountOf(AWARDS, {
        hideFundingCwids: new Set(),
        suppressedGrantIds: new Set(["INFOED-6-self", "INFOED-7-self"]),
      }),
    ).toBe(1);
    expect(
      await grantCountOf(AWARDS, {
        hideFundingCwids: new Set(["self"]),
        suppressedGrantIds: new Set(),
      }),
    ).toBe(0);
  });
});
