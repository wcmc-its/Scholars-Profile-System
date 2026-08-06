/**
 * #718 — `deriveRoleCategory` recognition of the `affiliate-alumni` ED person-
 * type code as the distinct `affiliate_alumni` hidden identity class.
 *
 * Pure-logic test: `deriveRoleCategory` reads only ou / degreeCode /
 * primaryPersonTypeCode / personTypeCodes. The ED ETL's `main()` is guarded by
 * `!process.env.VITEST`, so importing it here runs no sync.
 */
import { describe, expect, it } from "vitest";

import { deriveRoleCategory } from "@/etl/ed/index";
import type { EdFacultyEntry } from "@/lib/sources/ldap";

/** Minimal entry — only the four fields the classifier reads. */
function entry(over: Partial<EdFacultyEntry>): EdFacultyEntry {
  return {
    ou: "people",
    degreeCode: null,
    primaryPersonTypeCode: null,
    personTypeCodes: [],
    ...over,
  } as unknown as EdFacultyEntry;
}

describe("deriveRoleCategory — affiliate-alumni (#718)", () => {
  it("classifies a pure alumnus (primary scalar code) as affiliate_alumni", () => {
    expect(
      deriveRoleCategory(entry({ primaryPersonTypeCode: "affiliate-alumni" })),
    ).toBe("affiliate_alumni");
  });

  it("classifies a pure alumnus (multi-valued array code) as affiliate_alumni", () => {
    expect(
      deriveRoleCategory(
        entry({ personTypeCodes: ["academic", "affiliate-alumni"] }),
      ),
    ).toBe("affiliate_alumni");
  });

  it("a current full-time appointment wins over an alumnus code", () => {
    expect(
      deriveRoleCategory(
        entry({
          primaryPersonTypeCode: "employee-faculty-new-york-fulltime",
          personTypeCodes: ["affiliate-alumni"],
        }),
      ),
    ).toBe("full_time_faculty");
  });

  it("a current voluntary-faculty appointment wins over an alumnus code", () => {
    expect(
      deriveRoleCategory(
        entry({ personTypeCodes: ["academic-faculty-voluntary", "affiliate-alumni"] }),
      ),
    ).toBe("affiliated_faculty");
  });

  it("an entry with no alumnus code is unaffected (catch-all stays affiliated_faculty)", () => {
    expect(
      deriveRoleCategory(entry({ primaryPersonTypeCode: "academic-prestart" })),
    ).toBe("affiliated_faculty");
  });
});

/**
 * #2211 — `role_category='emeritus'` had ZERO rows in prod because the
 * `academic-faculty-emeritus` leaf was folded into the affiliated bucket, so no
 * consumer could segment emeritus faculty. The ordering assertions are the
 * point: emeritus must beat the affiliated codes it co-occurs with (or the
 * branch is unreachable again) but must LOSE to an active full-time / postdoc /
 * fellow appointment (or the eligibility carve moves).
 */
describe("deriveRoleCategory — emeritus (#2211)", () => {
  it("classifies the emeritus leaf as emeritus, not affiliated_faculty", () => {
    expect(
      deriveRoleCategory(
        entry({ personTypeCodes: ["academic", "academic-faculty", "academic-faculty-emeritus"] }),
      ),
    ).toBe("emeritus");
  });

  it("wins over the faculty-affiliated-non-employee primary code", () => {
    expect(
      deriveRoleCategory(
        entry({
          primaryPersonTypeCode: "faculty-affiliated-non-employee",
          personTypeCodes: ["academic-faculty-emeritus"],
        }),
      ),
    ).toBe("emeritus");
  });

  it("wins over voluntary / courtesy co-occurring codes", () => {
    expect(
      deriveRoleCategory(
        entry({
          personTypeCodes: ["academic-faculty-voluntary", "academic-faculty-emeritus"],
        }),
      ),
    ).toBe("emeritus");
    expect(
      deriveRoleCategory(
        entry({
          personTypeCodes: ["academic-faculty-courtesy", "academic-faculty-emeritus"],
        }),
      ),
    ).toBe("emeritus");
  });

  it("LOSES to an active full-time appointment (eligibility carve unchanged)", () => {
    expect(
      deriveRoleCategory(
        entry({
          primaryPersonTypeCode: "employee-faculty-new-york-fulltime",
          personTypeCodes: ["academic-faculty-emeritus"],
        }),
      ),
    ).toBe("full_time_faculty");
    expect(
      deriveRoleCategory(
        entry({ personTypeCodes: ["academic-faculty-weillfulltime", "academic-faculty-emeritus"] }),
      ),
    ).toBe("full_time_faculty");
  });

  it("LOSES to an active postdoc / fellow appointment", () => {
    expect(
      deriveRoleCategory(
        entry({
          primaryPersonTypeCode: "employee-postdoc-new-york",
          personTypeCodes: ["academic-faculty-emeritus"],
        }),
      ),
    ).toBe("postdoc");
    expect(
      deriveRoleCategory(
        entry({
          personTypeCodes: ["academic-nonfaculty-postdoc-fellow", "academic-faculty-emeritus"],
        }),
      ),
    ).toBe("fellow");
  });

  it("affiliated codes without the emeritus leaf still bucket as affiliated_faculty", () => {
    expect(deriveRoleCategory(entry({ personTypeCodes: ["academic-faculty-visiting"] }))).toBe(
      "affiliated_faculty",
    );
    expect(deriveRoleCategory(entry({ personTypeCodes: ["academic-faculty-weillparttime"] }))).toBe(
      "affiliated_faculty",
    );
  });
});
