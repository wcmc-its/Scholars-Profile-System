/**
 * `primaryOrganizationCode` — the ED primary-organization attribute is
 * option-tagged per SOR (`;faculty`, `;employee`, `;affiliate`, `;cornell-ithaca`);
 * ldapts surfaces each tag as its own key. Faculty first, then employee,
 * affiliate, then whatever tag is left; null when no tag carries a value.
 */
import { describe, expect, it } from "vitest";

import { primaryOrganizationCode } from "@/lib/sources/ldap";

describe("primaryOrganizationCode", () => {
  it("prefers the faculty SOR's code, then employee, then affiliate, then any other tag", () => {
    expect(
      primaryOrganizationCode({
        "weillCornellEduPrimaryOrganization;employee": ["WCMC"],
        "weillCornellEduPrimaryOrganization;faculty": ["HSS"],
      }),
    ).toBe("HSS");
    expect(primaryOrganizationCode({ "weillCornellEduPrimaryOrganization;employee": "WCMC" })).toBe("WCMC");
    expect(
      primaryOrganizationCode({
        "weillCornellEduPrimaryOrganization;affiliate": ["NYP"],
        "weillCornellEduPrimaryOrganization;cornell-ithaca": ["CU"],
      }),
    ).toBe("NYP");
    expect(primaryOrganizationCode({ "weillCornellEduPrimaryOrganization;cornell-ithaca": ["CU"] })).toBe("CU");
    expect(primaryOrganizationCode({ weillCornellEduPrimaryOrganization: ["WCMC"] })).toBe("WCMC");
  });

  it("null when the entry carries no code (an empty tagged value counts as none)", () => {
    expect(primaryOrganizationCode({ givenName: ["Pat"], "weillCornellEduPrimaryOrganization;employee": [] })).toBeNull();
    expect(primaryOrganizationCode({})).toBeNull();
  });
});
