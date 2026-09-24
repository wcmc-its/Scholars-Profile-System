import { describe, expect, it } from "vitest";

import {
  ambiguousUnitNames,
  buildTitleOptions,
  formatUnitLeadershipTitle,
  rankTitleText,
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

  it("falls to center head (5), then chief (6), then primary", () => {
    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        chiefTitle: "Chief, Sleep Neurology",
        centerHeadTitle: "Director, Example Cancer Center",
        edPrimaryTitle: "Professor of Clinical Medicine",
      }).tier,
    ).toBe("centerHead");

    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        chiefTitle: "Chief, Sleep Neurology",
        edPrimaryTitle: "Professor of Clinical Medicine",
      }).tier,
    ).toBe("chief");

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

describe("rankTitleText — the EA ladder (2026-09-24)", () => {
  const cases: Array<[string | null, number]> = [
    ["Stephen and Suzanne Weiss Dean", 1],
    ["Provost", 1],
    ["Interim Dean", 1],
    ["Vice Provost for Research", 2],
    ["Vice Dean", 2],
    ["Senior Vice President and Chief Operating Officer", 2],
    ["Senior Associate Dean, Education", 3],
    ["Chair of Medicine", 4],
    ["Sanford I. Weill Chair of Medicine", 4],
    ["Chairman, Department of Surgery", 4],
    ["Vice Chair for Research", 8.5], // EA: "between 8 and 9"
    ["Vice Chairman of Radiology for Lower Manhattan", 8.5],
    ["Chief of Cardiology", 6],
    ["Chief, Sleep Neurology", 6],
    ["Associate Dean for Research", 7],
    ["Assistant Dean", 7],
    ["Associate Vice Provost", 8],
    ["Assistant Vice President", 8],
    ["Gale and Ira Drukier Professor of Children's Health", 9],
    ["The Foo Family Chair in Cardiology", 9],
    ["Director, Example Center for Health Policy", 10],
    ["Director of the Example Institute", 10],
    ["Associate Director, Example Center", 13], // #2735: associate directors never count
    ["Program Director, Internal Medicine Residency", 11],
    ["Director, Fellowship Program in Cardiology", 11],
    ["Professor of Medicine", 12],
    ["Associate Professor of Clinical Medicine", 12],
    ["Adjunct Assistant Professor", 12],
    ["Instructor in Medicine", 12],
    ["Postdoctoral Associate", 12],
    ["Director of Example Center and Professor of Medicine", 10], // not endowed
    ["Anne Example, M.D. Assistant Professor of Otolaryngology", 9], // comma in a name
    ["Vice Chair for Research and Professor of Medicine", 8.5], // an office, not a name
    ["Professor Emeritus of Medicine", 12],
    ["Dean Emeritus", 13],
    ["Attending Physician", 13],
    [null, 13],
    ["   ", 13],
  ];
  it.each(cases)("%s → %s", (title, rank) => {
    expect(rankTitleText(title)).toBe(rank);
  });
});

describe("resolveScholarTitle — rank, not source", () => {
  it("a division chief beats a working title that is only an academic rank", () => {
    // Before 2026-09-24 the working title won unconditionally.
    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        workingTitle: "Professor of Medicine",
        chiefTitle: "Chief, Sleep Neurology",
        edPrimaryTitle: "Professor of Clinical Medicine",
      }).tier,
    ).toBe("chief");
  });

  it("a division chief beats an Associate Dean working title (6 over 7)", () => {
    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        workingTitle: "Associate Dean for Research",
        chiefTitle: "Chief, Sleep Neurology",
      }).value,
    ).toBe("Chief, Sleep Neurology");
  });

  it("a center director (role, always school-wide) beats a chief", () => {
    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        chiefTitle: "Chief, Sleep Neurology",
        centerHeadTitle: "Director, Example Cancer Center",
      }).tier,
    ).toBe("centerHead");
  });

  it("a director title known only as TEXT is unit-based (10) and loses to a chief", () => {
    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        workingTitle: "Director of the Example Research Institute",
        chiefTitle: "Chief, Sleep Neurology",
      }).tier,
    ).toBe("chief");
  });

  it("a working title wording the SAME directorship keeps the person's wording", () => {
    const r = resolveScholarTitle({
      ...NONE,
      override: null,
      workingTitle: "Meyer Cancer Center Director",
      chiefTitle: "Chief, Sleep Neurology",
      centerHeadTitle: "Director, Sandra and Edward Meyer Cancer Center",
      edPrimaryTitle: "Professor",
    });
    expect(r).toMatchObject({ tier: "working", value: "Meyer Cancer Center Director" });
  });

  it("a working title naming a DIFFERENT center does not borrow the role's rank", () => {
    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        workingTitle: "Director, Example Aging Center",
        centerHeadTitle: "Director, Sandra and Edward Meyer Cancer Center",
      }).tier,
    ).toBe("centerHead");
  });

  it("a plain academic appointment never displaces the ED primary title", () => {
    // Only appointments ABOVE academic rank compete; otherwise a sibling
    // appointment's wording would churn "Professor of X" on every tie.
    const r = resolveScholarTitle({
      ...NONE,
      override: null,
      appointmentTitles: ["Professor of Biochemistry", "Leon Example Professor of Surgery"],
      edPrimaryTitle: "Professor of Surgery",
    });
    expect(r).toMatchObject({ tier: "appointment", value: "Leon Example Professor of Surgery" });
    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        appointmentTitles: ["Professor of Biochemistry"],
        edPrimaryTitle: "Professor of Surgery",
      }).tier,
    ).toBe("primary");
  });

  it("on a tie the working title still wins (source order breaks ties)", () => {
    expect(
      resolveScholarTitle({
        ...NONE,
        override: null,
        workingTitle: "Professor of Medicine",
        edPrimaryTitle: "Professor of Clinical Medicine",
      }).tier,
    ).toBe("working");
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
  it("always returns every tier; with nothing ranked, in tie-break order", () => {
    const options = buildTitleOptions(NONE);
    expect(options.map((o) => o.tier)).toEqual([...TITLE_TIERS]);
  });

  it("orders applicable rows by rank, highest first", () => {
    const options = buildTitleOptions({
      ...NONE,
      workingTitle: "Associate Dean for Research",
      chiefTitle: "Chief, Sleep Neurology",
      edPrimaryTitle: "Professor of Medicine",
    });
    expect(options.map((o) => [o.tier, o.rank])).toEqual([
      ["chief", 6],
      ["working", 7],
      ["primary", 12],
      ["appointment", 13],
      ["centerHead", 13],
    ]);
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
      {
        tier: "working",
        label: "Working title",
        value: "Senior Associate Dean, Example Programme",
        rank: 3,
      },
      { tier: "primary", label: "Primary title", value: "Chair of Example Sciences", rank: 4 },
      { tier: "appointment", label: "Appointment title", value: null, rank: 13 },
      { tier: "centerHead", label: "Center director", value: null, rank: 13 },
      { tier: "chief", label: "Division chief", value: null, rank: 13 },
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
