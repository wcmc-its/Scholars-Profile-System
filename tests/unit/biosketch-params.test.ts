import { describe, expect, it } from "vitest";

import {
  BIOSKETCH_APPLICATION_ROLES,
  BIOSKETCH_CONTRIBUTION_LINE_MAX,
  BIOSKETCH_MAX_CONTRIBUTIONS,
  DEFAULT_BIOSKETCH_PARAMS,
  biosketchCharCap,
  missingPersonalStatementInputs,
  normalizeBiosketchParams,
} from "@/lib/edit/biosketch-params";

describe("normalizeBiosketchParams — trust boundary", () => {
  it("garbage input yields the default-shaped object, never throws", () => {
    expect(normalizeBiosketchParams(undefined)).toEqual(DEFAULT_BIOSKETCH_PARAMS);
    expect(normalizeBiosketchParams("nope")).toEqual(DEFAULT_BIOSKETCH_PARAMS);
    expect(normalizeBiosketchParams(42)).toEqual(DEFAULT_BIOSKETCH_PARAMS);
    expect(normalizeBiosketchParams([])).toEqual(DEFAULT_BIOSKETCH_PARAMS);
  });

  it("an unknown mode falls back to contributions", () => {
    expect(normalizeBiosketchParams({ mode: "bogus" }).mode).toBe("contributions");
  });

  it("clamps maxContributions to [1, 5]", () => {
    expect(normalizeBiosketchParams({ maxContributions: 0 }).maxContributions).toBe(1);
    expect(normalizeBiosketchParams({ maxContributions: 99 }).maxContributions).toBe(
      BIOSKETCH_MAX_CONTRIBUTIONS,
    );
    expect(normalizeBiosketchParams({ maxContributions: 3 }).maxContributions).toBe(3);
    expect(normalizeBiosketchParams({ maxContributions: 2.9 }).maxContributions).toBe(2);
    expect(normalizeBiosketchParams({ maxContributions: "x" }).maxContributions).toBe(
      BIOSKETCH_MAX_CONTRIBUTIONS,
    );
  });

  it("trims and clamps the free-text inputs", () => {
    const longAims = "a".repeat(5000);
    const p = normalizeBiosketchParams({
      mode: "personal_statement",
      projectTitle: "  My Project  ",
      aims: longAims,
      emphasis: "  clinical  ",
      instructions: "  steer  ",
    });
    expect(p.projectTitle).toBe("My Project");
    expect(p.aims.length).toBe(3000);
    expect(p.emphasis).toBe("clinical");
    expect(p.instructions).toBe("steer");
  });
});

describe("normalizeBiosketchParams — #2653 v8 role + contribution line", () => {
  it("defaults to no role and an empty contribution line", () => {
    expect(DEFAULT_BIOSKETCH_PARAMS.applicationRole).toBeNull();
    expect(DEFAULT_BIOSKETCH_PARAMS.contributionLine).toBe("");
  });

  it("accepts every registered role and rejects anything else to null", () => {
    expect(BIOSKETCH_APPLICATION_ROLES).toEqual([
      "pd_pi",
      "mpi",
      "co_investigator",
      "mentor_sponsor",
      "collaborator_consultant",
      "core_director",
      "other_significant_contributor",
      "candidate",
    ]);
    for (const r of BIOSKETCH_APPLICATION_ROLES) {
      expect(normalizeBiosketchParams({ applicationRole: r }).applicationRole).toBe(r);
    }
    expect(normalizeBiosketchParams({ applicationRole: "PI" }).applicationRole).toBeNull();
    expect(normalizeBiosketchParams({ applicationRole: 3 }).applicationRole).toBeNull();
    // a prototype key is not a role
    expect(normalizeBiosketchParams({ applicationRole: "toString" }).applicationRole).toBeNull();
  });

  it("trims and clamps the contribution line to 200 characters", () => {
    expect(BIOSKETCH_CONTRIBUTION_LINE_MAX).toBe(200);
    const p = normalizeBiosketchParams({ contributionLine: `  ${"x".repeat(500)}  ` });
    expect(p.contributionLine.length).toBe(200);
    expect(normalizeBiosketchParams({ contributionLine: 42 }).contributionLine).toBe("42");
  });
});

describe("missingPersonalStatementInputs — required-input enforcement", () => {
  it("contributions mode needs neither project title nor aims", () => {
    expect(missingPersonalStatementInputs(normalizeBiosketchParams({ mode: "contributions" }))).toEqual(
      [],
    );
  });

  it("personal statement without title/aims reports both missing", () => {
    expect(
      missingPersonalStatementInputs(normalizeBiosketchParams({ mode: "personal_statement" })),
    ).toEqual(["projectTitle", "aims"]);
  });

  it("personal statement with both present reports nothing missing", () => {
    expect(
      missingPersonalStatementInputs(
        normalizeBiosketchParams({
          mode: "personal_statement",
          projectTitle: "CNS gene therapy",
          aims: "Aim 1: dose-finding. Aim 2: safety.",
        }),
      ),
    ).toEqual([]);
  });
});

describe("missingPersonalStatementInputs — #2653 v8 role requirement", () => {
  const ps = { mode: "personal_statement", projectTitle: "T", aims: "A" };

  it("v8 requires the role on the application (listed FIRST, before title/aims)", () => {
    expect(missingPersonalStatementInputs(normalizeBiosketchParams({ ...ps, promptVersion: "v8" }))).toEqual([
      "applicationRole",
    ]);
    expect(
      missingPersonalStatementInputs(
        normalizeBiosketchParams({ mode: "personal_statement", promptVersion: "v8" }),
      ),
    ).toEqual(["applicationRole", "projectTitle", "aims"]);
    expect(
      missingPersonalStatementInputs(
        normalizeBiosketchParams({ ...ps, promptVersion: "v8", applicationRole: "co_investigator" }),
      ),
    ).toEqual([]);
  });

  it("v5–v7 ignore the role; Contributions under v8 needs nothing", () => {
    for (const v of ["v5", "v6", "v7"]) {
      expect(missingPersonalStatementInputs(normalizeBiosketchParams({ ...ps, promptVersion: v }))).toEqual([]);
    }
    expect(
      missingPersonalStatementInputs(normalizeBiosketchParams({ mode: "contributions", promptVersion: "v8" })),
    ).toEqual([]);
  });
});

describe("biosketchCharCap", () => {
  it("uses the NIH ceilings per mode", () => {
    expect(biosketchCharCap("contributions")).toBe(2000);
    expect(biosketchCharCap("personal_statement")).toBe(3500);
  });
});
