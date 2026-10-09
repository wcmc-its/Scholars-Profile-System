/**
 * #2180 — InfoEd central office (`prop_u.P_SIN_18`) and intake type
 * (`prop_u.p_sin_5`) reach the Grant row. `intake_type` used to be selected in
 * the `infoed_all` CTE and then dropped by the outer SELECT, `GrantRow`, and the
 * insert mapper; these pin each hop.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { read: {}, write: {} },
  disconnect: vi.fn(),
  prisma: {},
}));
vi.mock("@/lib/edit/search-suppression", () => ({
  reflectGrantSuppressions: vi.fn(),
}));

import { type Prepared, toGrantInsert } from "@/etl/infoed";

const SRC = readFileSync(join(process.cwd(), "etl/infoed/index.ts"), "utf8");

const prepared = (over: Partial<Prepared["row"]> = {}, datesSource: Prepared["datesSource"] = "infoed"): Prepared => ({
  datesSource,
  row: {
    CWID: "abc1234",
    Account_Number: "55555",
    Award_Number: "R01AG012345",
    begin_date: new Date("2024-01-01"),
    end_date: new Date("2027-12-31"),
    proj_title: "A study",
    unit_name: "Medicine",
    int_unit_code: "MED",
    program_type: "Grant",
    Orig_Sponsor: "National Institutes of Health",
    Subward_Sponsor: null,
    spon_code: "NIH",
    Role: "PrincipalInvestigatorRole",
    Project_Status: "Active Award",
    central_office: "OSRA",
    intake_type: "Grant",
    ...over,
  },
});

describe("toGrantInsert — #2180 central office + intake type", () => {
  it("carries both fields through to the Grant row", () => {
    const g = toGrantInsert(prepared({ central_office: "JCTO", intake_type: "Clinical Trial Agreement" }));
    expect(g.centralOffice).toBe("JCTO");
    expect(g.intakeType).toBe("Clinical Trial Agreement");
    expect(g.externalId).toBe("INFOED-55555-abc1234");
    expect(g.source).toBe("InfoEd");
  });

  it("trims InfoEd's padded values", () => {
    const g = toGrantInsert(prepared({ central_office: " OSRA  ", intake_type: " Grant " }));
    expect(g.centralOffice).toBe("OSRA");
    expect(g.intakeType).toBe("Grant");
  });

  it("stores NULL for missing or blank values — never a synthetic default", () => {
    for (const v of [null, "", "   "]) {
      const g = toGrantInsert(prepared({ central_office: v, intake_type: v }));
      expect(g.centralOffice).toBeNull();
      expect(g.intakeType).toBeNull();
    }
  });

  it("is independent per field (an intake type with no office keeps the intake type)", () => {
    const g = toGrantInsert(prepared({ central_office: null, intake_type: "Clinical Trial Agreement" }));
    expect(g.centralOffice).toBeNull();
    expect(g.intakeType).toBe("Clinical Trial Agreement");
  });

  it("keeps datesSource as prepared", () => {
    expect(toGrantInsert(prepared({}, "reporter")).datesSource).toBe("reporter");
  });
});

describe("CONSOLIDATED_QUERY — #2180 fields are selected, rolled up, and compared", () => {
  it("selects P_SIN_18 as central_office in the CTE", () => {
    expect(SRC).toMatch(/p_udf\.P_SIN_18\s+AS central_office/);
    expect(SRC).toMatch(/p_udf\.p_sin_5\s+AS intake_type/);
  });

  it("aggregates both per account over non-blank values only", () => {
    expect(SRC).toContain("MAX(NULLIF(LTRIM(RTRIM(central_office)), '')) AS central_office");
    expect(SRC).toContain("MAX(NULLIF(LTRIM(RTRIM(intake_type)), '')) AS intake_type");
  });

  it("projects both in the outer SELECT", () => {
    expect(SRC).toContain("z.central_office, z.intake_type,");
  });

  it("includes both in the refresh comparison, so a change re-writes the row", () => {
    expect(SRC).toContain("centralOffice: true, intakeType: true");
    expect(SRC).toContain("g.centralOffice, g.intakeType,");
  });
});
