/**
 * `lib/funding-roles.ts` — the single grant-role vocabulary.
 */
import { describe, expect, it } from "vitest";

import {
  FUNDING_ROLE_BUCKET_LABEL,
  fundingRoleLabel,
  grantRoleShortLabel,
  grantRoleTitle,
  grantRoleTone,
  isPiRole,
  PI_ROLES,
} from "@/lib/funding-roles";

describe("isPiRole", () => {
  it("is true for exactly the three principal-investigator roles", () => {
    expect(isPiRole("PI")).toBe(true);
    expect(isPiRole("PI-Subaward")).toBe(true);
    // InfoEd's non-contact PD/PI on an NIH multiple-PI award — a PI.
    expect(isPiRole("Co-PI")).toBe(true);
    expect(PI_ROLES).toEqual(["PI", "PI-Subaward", "Co-PI"]);
  });

  it("is false for the non-PI roles", () => {
    expect(isPiRole("Co-I")).toBe(false);
    expect(isPiRole("Key Personnel")).toBe(false);
  });

  it("uses exact membership, not a prefix match", () => {
    // The regexes this replaced were `/^(PI|Co-PI|MPI)/i`, which would admit
    // anything merely STARTING with PI.
    expect(isPiRole("PI Emeritus")).toBe(false);
    expect(isPiRole("pi")).toBe(false);
    expect(isPiRole("MPI")).toBe(false);
  });
});

describe("fundingRoleLabel", () => {
  it("spells out the five InfoEd role codes in the data", () => {
    expect(fundingRoleLabel("PI")).toBe("Principal Investigator");
    expect(fundingRoleLabel("Co-PI")).toBe("Multiple Principal Investigator (MPI)");
    expect(fundingRoleLabel("Co-I")).toBe("Co-Investigator");
    expect(fundingRoleLabel("PI-Subaward")).toBe("Principal Investigator (subaward)");
    expect(fundingRoleLabel("Key Personnel")).toBe("Key Personnel");
  });

  it("relabels the CONTACT PI when the award is multi-PI", () => {
    expect(fundingRoleLabel("PI", true)).toBe("Multiple Principal Investigator (MPI)");
    expect(fundingRoleLabel("PI-Subaward", true)).toBe(
      "Multiple Principal Investigator (MPI)",
    );
    expect(fundingRoleLabel("Co-I", true)).toBe("Co-Investigator");
  });

  it("passes through an unknown role unchanged (defensive)", () => {
    expect(fundingRoleLabel("Program Director")).toBe("Program Director");
  });
});

describe("grantRoleShortLabel", () => {
  it("is the pill vocabulary: PI, MPI, Co-I, Sub-PI, KP", () => {
    expect(grantRoleShortLabel("PI")).toBe("PI");
    // A Co-PI row is an MPI unconditionally — no isMultiPi needed.
    expect(grantRoleShortLabel("Co-PI")).toBe("MPI");
    expect(grantRoleShortLabel("Co-I")).toBe("Co-I");
    expect(grantRoleShortLabel("PI-Subaward")).toBe("Sub-PI");
    expect(grantRoleShortLabel("Key Personnel")).toBe("KP");
  });

  it("relabels the contact PI to MPI when the award is multi-PI", () => {
    expect(grantRoleShortLabel("PI", true)).toBe("MPI");
    expect(grantRoleShortLabel("PI-Subaward", true)).toBe("MPI");
    expect(grantRoleShortLabel("PI", false)).toBe("PI");
  });

  it("passes through an unknown role unchanged", () => {
    expect(grantRoleShortLabel("Consultant")).toBe("Consultant");
  });
});

describe("grantRoleTitle", () => {
  it("names the non-contact PD/PI behind the Co-PI code", () => {
    expect(grantRoleTitle("Co-PI")).toBe(
      "Multiple Principal Investigator (non-contact PD/PI)",
    );
  });

  it("names the contact PD/PI on a multi-PI award", () => {
    expect(grantRoleTitle("PI", true)).toBe(
      "Multiple Principal Investigator (contact PD/PI)",
    );
    expect(grantRoleTitle("PI")).toBe("Principal Investigator");
  });
});

describe("grantRoleTone", () => {
  it("Co-PI is lead, not co-lead — an MPI holds PI standing equally", () => {
    expect(grantRoleTone("Co-PI")).toBe("lead");
    expect(grantRoleTone("PI")).toBe("lead");
  });

  it("PI-Subaward is co-lead; Co-I / Key Personnel / unknown are neutral", () => {
    expect(grantRoleTone("PI-Subaward")).toBe("co-lead");
    expect(grantRoleTone("Co-I")).toBe("neutral");
    expect(grantRoleTone("Key Personnel")).toBe("neutral");
    expect(grantRoleTone("Consultant")).toBe("neutral");
  });
});

describe("FUNDING_ROLE_BUCKET_LABEL", () => {
  it("relabels the frozen index token Multi-PI as MPI without renaming it", () => {
    expect(FUNDING_ROLE_BUCKET_LABEL["Multi-PI"]).toBe("MPI");
    expect(FUNDING_ROLE_BUCKET_LABEL.PI).toBe("PI");
    expect(FUNDING_ROLE_BUCKET_LABEL["Co-I"]).toBe("Co-I");
    // The KEY is the OpenSearch/URL token and must not move — renaming it needs
    // a reindex. Only the value is display text.
    expect(Object.keys(FUNDING_ROLE_BUCKET_LABEL)).toContain("Multi-PI");
  });
});
