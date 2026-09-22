import { describe, expect, it } from "vitest";

import {
  ambiguousUnitNames,
  buildTitleOptions,
  formatUnitLeadershipTitle,
  resolveScholarTitle,
  TITLE_TIERS,
  type TitleInputs,
} from "@/lib/scholar-title";

/** Every tier absent — the base each case overrides one field of. */
const NONE: TitleInputs = {
  workingTitle: null,
  chiefTitle: null,
  centerHeadTitle: null,
  edPrimaryTitle: null,
};

describe("resolveScholarTitle — precedence", () => {
  it("working title beats every lower tier", () => {
    // The case the feature was asked for, from the 2026-09-22 ED probe: a
    // scholar whose ED entry carries a working title AND who holds a
    // department chair title. The working title is what should show.
    const result = resolveScholarTitle({
      override: null,
      workingTitle: "Senior Associate Dean, Example Programme",
      chiefTitle: "Chief, Nowhere",
      centerHeadTitle: "Director, Nowhere Center",
      edPrimaryTitle: "Chair of Example Sciences",
    });
    expect(result).toEqual({
      value: "Senior Associate Dean, Example Programme",
      tier: "working",
      overridden: false,
    });
  });

  it("falls to chief, then center head, then primary", () => {
    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        chiefTitle: "Chief, Sleep Neurology",
        centerHeadTitle: "Director, Example Cancer Center",
        edPrimaryTitle: "Professor of Clinical Medicine",
      }).tier,
    ).toBe("chief");

    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        centerHeadTitle: "Director, Example Cancer Center",
        edPrimaryTitle: "Professor of Clinical Medicine",
      }).tier,
    ).toBe("centerHead");

    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        edPrimaryTitle: "Professor of Clinical Medicine",
      }).tier,
    ).toBe("primary");
  });

  it("returns null when no tier applies", () => {
    expect(resolveScholarTitle({ ...NONE, override: null })).toEqual({
      value: null,
      tier: null,
      overridden: false,
    });
  });
});

describe("resolveScholarTitle — override", () => {
  it("an override beats the working title", () => {
    expect(
      resolveScholarTitle({
        ...NONE,
        override: "Chair of Example Sciences",
        workingTitle: "Senior Associate Dean, Example Programme",
      }),
    ).toEqual({
      value: "Chair of Example Sciences",
      tier: null,
      overridden: true,
    });
  });

  it("an EMPTY override falls through to the derived default", () => {
    // "" is the operator un-pinning, NOT an assertion that the scholar has no
    // title. Opposite of the `leaderCwid` convention two files away.
    const result = resolveScholarTitle({
      ...NONE,
      override: "",
      workingTitle: "Senior Associate Dean, Example Programme",
    });
    expect(result.overridden).toBe(false);
    expect(result.value).toBe("Senior Associate Dean, Example Programme");
  });

  it("a whitespace-only override falls through too", () => {
    expect(
      resolveScholarTitle({ ...NONE, override: "   ", edPrimaryTitle: "Professor" }).value,
    ).toBe("Professor");
  });
});

describe("blank handling", () => {
  it("a whitespace-only tier value does not win", () => {
    // A stray ED space must not beat the real title below it and render an
    // empty subtitle.
    const result = resolveScholarTitle({
      ...NONE,
      override: null,
      workingTitle: "  ",
      edPrimaryTitle: "Professor of Neuroscience",
    });
    expect(result.value).toBe("Professor of Neuroscience");
    expect(result.tier).toBe("primary");
  });

  it("trims a padded value rather than storing the padding", () => {
    expect(
      resolveScholarTitle({ ...NONE, override: null, workingTitle: "  Dean  " }).value,
    ).toBe("Dean");
  });
});

describe("buildTitleOptions", () => {
  it("always returns every tier, in precedence order", () => {
    const options = buildTitleOptions(NONE);
    expect(options.map((o) => o.tier)).toEqual([...TITLE_TIERS]);
  });

  it("marks an inapplicable tier null rather than dropping the row", () => {
    // The picker renders these disabled so an operator can see WHY a tier did
    // not win instead of wondering where it went.
    const options = buildTitleOptions({
      ...NONE,
      workingTitle: "Senior Associate Dean, Example Programme",
      edPrimaryTitle: "Chair of Example Sciences",
    });
    expect(options).toEqual([
      { tier: "working", label: "Working title", value: "Senior Associate Dean, Example Programme" },
      { tier: "chief", label: "Division chief", value: null },
      { tier: "centerHead", label: "Center head", value: null },
      { tier: "primary", label: "Primary title", value: "Chair of Example Sciences" },
    ]);
  });
});

describe("formatUnitLeadershipTitle", () => {
  it("omits the qualifier when the unit name is unique", () => {
    expect(
      formatUnitLeadershipTitle({
        roleLabel: "Chief",
        interim: false,
        unitName: "Sleep Neurology",
        parentName: "Medicine",
        ambiguous: false,
      }),
    ).toBe("Chief, Sleep Neurology");
  });

  it("qualifies with the department when the name is shared", () => {
    // Probed 2026-09-22: "Cardiology" is the ONLY shared division name; it
    // exists under both Medicine and Pediatrics.
    expect(
      formatUnitLeadershipTitle({
        roleLabel: "Chief",
        interim: false,
        unitName: "Cardiology",
        parentName: "Medicine",
        ambiguous: true,
      }),
    ).toBe("Chief, Cardiology (Medicine)");
    expect(
      formatUnitLeadershipTitle({
        roleLabel: "Chief",
        interim: false,
        unitName: "Cardiology",
        parentName: "Pediatrics",
        ambiguous: true,
      }),
    ).toBe("Chief, Cardiology (Pediatrics)");
  });

  it("does not emit an empty qualifier when the parent is unknown", () => {
    expect(
      formatUnitLeadershipTitle({
        roleLabel: "Chief",
        interim: false,
        unitName: "Cardiology",
        parentName: null,
        ambiguous: true,
      }),
    ).toBe("Chief, Cardiology");
  });

  it("carries the interim modifier", () => {
    expect(
      formatUnitLeadershipTitle({ roleLabel: "Director", interim: true, unitName: "Example Cancer Center" }),
    ).toBe("Interim Director, Example Cancer Center");
  });
});

describe("ambiguousUnitNames", () => {
  it("finds only names held by 2+ units, case-insensitively", () => {
    const dupes = ambiguousUnitNames([
      { name: "Cardiology" },
      { name: "cardiology" },
      { name: "Sleep Neurology" },
      { name: "Endocrinology" },
    ]);
    expect([...dupes]).toEqual(["cardiology"]);
  });

  it("is empty when every name is unique", () => {
    expect(ambiguousUnitNames([{ name: "A" }, { name: "B" }]).size).toBe(0);
  });

  it("ignores blank names", () => {
    expect(ambiguousUnitNames([{ name: "  " }, { name: "" }]).size).toBe(0);
  });
});
