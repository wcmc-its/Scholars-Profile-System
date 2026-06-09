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
