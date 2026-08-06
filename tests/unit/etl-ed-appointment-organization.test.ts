/**
 * #2226 — `appointmentOrganization` keeps `Appointment.organization` in step
 * with the scholar's resolved unit line.
 *
 * ED LDAP nests the WCM Library as a level2 unit under level1
 * "Information Technologies and Services". `resolveOrgUnit` (etl/ed/index.ts
 * main()) promotes that level2 to dept status, so the profile affiliation and
 * the department page both say Library — but the appointment write path used
 * the raw level1 name, so the Appointments card directly beneath the
 * affiliation said ITS. This helper applies the same promotion on the write
 * path.
 *
 * Pure-logic test: the ED ETL's `main()` is guarded by `!process.env.VITEST`,
 * so importing the module here runs no sync.
 */
import { describe, expect, it } from "vitest";

import { appointmentOrganization } from "@/etl/ed/index";

describe("appointmentOrganization (#2226)", () => {
  it("promotes a Library level2 over its non-academic ITS level1", () => {
    expect(
      appointmentOrganization({
        organization: "Information Technologies and Services",
        divName: "Library",
      }),
    ).toBe("Library");
  });

  it("leaves an ordinary dept/division pair on the level1 dept name", () => {
    // A real division must NOT be promoted — the appointment belongs to the
    // department, and the division is rendered separately on the unit line.
    expect(
      appointmentOrganization({
        organization: "Medicine",
        divName: "General Internal Medicine",
      }),
    ).toBe("Medicine");
  });

  it("leaves a dept-level appointment (no level2) untouched", () => {
    expect(
      appointmentOrganization({ organization: "Population Health Sciences", divName: null }),
    ).toBe("Population Health Sciences");
  });

  it("still promotes when the level1 name is absent", () => {
    // Guards the ordering: the promotion must be checked BEFORE the
    // "Weill Cornell Medicine" fallback, or a Library row with a missing
    // level1 would land on the generic institution label.
    expect(appointmentOrganization({ organization: null, divName: "Library" })).toBe("Library");
  });

  it("falls back to the institution label when ED carries no org unit at all", () => {
    // Pre-existing behaviour of the two call sites, preserved.
    expect(appointmentOrganization({ organization: null, divName: null })).toBe(
      "Weill Cornell Medicine",
    );
  });

  it("matches the promotion set exactly — no substring or case widening", () => {
    // `PROMOTE_LEVEL2_TO_DEPT` is a name-equality Set. A near-miss must fall
    // through to level1 rather than silently relabelling an unrelated unit.
    expect(appointmentOrganization({ organization: "Medicine", divName: "Library Sciences" })).toBe(
      "Medicine",
    );
    expect(appointmentOrganization({ organization: "Medicine", divName: "library" })).toBe(
      "Medicine",
    );
  });
});
