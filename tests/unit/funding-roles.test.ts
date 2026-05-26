/**
 * `lib/funding-roles.ts` — spell-out labels for the self-edit Funding panel.
 */
import { describe, expect, it } from "vitest";

import { fundingRoleLabel } from "@/lib/funding-roles";

describe("fundingRoleLabel", () => {
  it("spells out the five InfoEd role codes in the data", () => {
    expect(fundingRoleLabel("PI")).toBe("Principal Investigator");
    expect(fundingRoleLabel("Co-PI")).toBe("Co-Principal Investigator");
    expect(fundingRoleLabel("Co-I")).toBe("Co-Investigator");
    expect(fundingRoleLabel("PI-Subaward")).toBe("Principal Investigator (subaward)");
    expect(fundingRoleLabel("Key Personnel")).toBe("Key Personnel");
  });

  it("passes through an unknown role unchanged (defensive)", () => {
    expect(fundingRoleLabel("Program Director")).toBe("Program Director");
  });
});
