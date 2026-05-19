import { describe, expect, it } from "vitest";
import {
  grantRoleLabel,
  grantRolePillLabel,
  grantRoleTone,
} from "@/components/scholar/person-card-grant-role-pill";

describe("grantRoleLabel (#257 grant role pill)", () => {
  it("maps the five live Grant.role values", () => {
    expect(grantRoleLabel("PI")).toBe("Principal Investigator");
    expect(grantRoleLabel("Co-PI")).toBe("Co-Principal Investigator");
    expect(grantRoleLabel("PI-Subaward")).toBe("PI (subaward)");
    expect(grantRoleLabel("Co-I")).toBe("Co-Investigator");
    expect(grantRoleLabel("Key Personnel")).toBe("Key Personnel");
  });

  it("falls back to the raw value for unknown roles", () => {
    expect(grantRoleLabel("Consultant")).toBe("Consultant");
  });
});

describe("grantRoleTone (#257 grant role pill)", () => {
  it("PI is the lead tone", () => {
    expect(grantRoleTone("PI")).toBe("lead");
  });

  it("Co-PI and PI-Subaward are the co-lead tone", () => {
    expect(grantRoleTone("Co-PI")).toBe("co-lead");
    expect(grantRoleTone("PI-Subaward")).toBe("co-lead");
  });

  it("Co-I and Key Personnel are neutral", () => {
    expect(grantRoleTone("Co-I")).toBe("neutral");
    expect(grantRoleTone("Key Personnel")).toBe("neutral");
  });

  it("unknown roles are neutral", () => {
    expect(grantRoleTone("Consultant")).toBe("neutral");
  });
});

describe("grantRolePillLabel — Multi-PI relabel (#257)", () => {
  it("a PI on a multi-PI grant reads Multi-PI", () => {
    expect(grantRolePillLabel("PI", true)).toBe("Multi-PI");
  });

  it("a sole PI reads Principal Investigator", () => {
    expect(grantRolePillLabel("PI", false)).toBe("Principal Investigator");
    expect(grantRolePillLabel("PI")).toBe("Principal Investigator");
  });

  it("isMultiPi does not relabel a non-PI role", () => {
    expect(grantRolePillLabel("Co-I", true)).toBe("Co-Investigator");
    expect(grantRolePillLabel("Co-PI", true)).toBe("Co-Principal Investigator");
  });
});
