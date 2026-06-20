import { describe, expect, it } from "vitest";

import {
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

describe("biosketchCharCap", () => {
  it("uses the NIH ceilings per mode", () => {
    expect(biosketchCharCap("contributions")).toBe(2000);
    expect(biosketchCharCap("personal_statement")).toBe(3500);
  });
});
