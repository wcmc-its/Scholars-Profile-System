import { describe, expect, it } from "vitest";
import {
  grantRoleLabel,
  grantRolePillLabel,
  grantRoleTone,
} from "@/components/scholar/person-card-grant-role-pill";

describe("grantRoleLabel (#257 grant role pill)", () => {
  it("maps the five live Grant.role values", () => {
    expect(grantRoleLabel("PI")).toBe("Principal Investigator");
    // Co-PI is InfoEd's NON-CONTACT PD/PI, i.e. an NIH multiple-PI award. It is
    // not a co-principal-investigator — "co-PI" is NSF's term and NIH has no such
    // concept, so it must never render on an NIH award.
    expect(grantRoleLabel("Co-PI")).toBe("Multiple Principal Investigator (MPI)");
    expect(grantRoleLabel("PI-Subaward")).toBe("Principal Investigator (subaward)");
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

  it("Co-PI is the LEAD tone — an MPI holds PI standing equally", () => {
    // Was co-lead (amber). An MPI is not a lesser form of PI; which of the PD/PIs
    // NIH names as contact is a correspondence detail and carries no seniority.
    expect(grantRoleTone("Co-PI")).toBe("lead");
  });

  it("PI-Subaward is the co-lead tone", () => {
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

describe("grantRolePillLabel — MPI relabel (#257)", () => {
  it("the contact PI of a multi-PI grant reads MPI", () => {
    expect(grantRolePillLabel("PI", true)).toBe("MPI");
    expect(grantRolePillLabel("PI-Subaward", true)).toBe("MPI");
  });

  it("a Co-PI row reads MPI with or without isMultiPi", () => {
    // Unconditional by construction: InfoEd flags only the contact PI, so the
    // existence of a Co-PI row already means the award has ≥2 PD/PIs. No
    // `isMultiPi` plumbing is needed to label it.
    expect(grantRolePillLabel("Co-PI", true)).toBe("MPI");
    expect(grantRolePillLabel("Co-PI", false)).toBe("MPI");
    expect(grantRolePillLabel("Co-PI")).toBe("MPI");
  });

  it("a sole PI reads Principal Investigator", () => {
    expect(grantRolePillLabel("PI", false)).toBe("Principal Investigator");
    expect(grantRolePillLabel("PI")).toBe("Principal Investigator");
  });

  it("isMultiPi does not relabel a non-PI role", () => {
    expect(grantRolePillLabel("Co-I", true)).toBe("Co-Investigator");
    expect(grantRolePillLabel("Key Personnel", true)).toBe("Key Personnel");
  });
});
