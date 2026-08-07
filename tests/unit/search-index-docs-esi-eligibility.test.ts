/**
 * #2300 — `loadEsiEligibilityByCwid` (`lib/search-index-docs.ts`).
 *
 * Bulk-loads "Early Stage Investigator" eligibility for the people-index
 * `esiEligible` field, reusing `deriveGrantSignals`
 * (`lib/api/match-researchers.ts`) UNCHANGED. The critical correctness
 * contract under test: this loader's `grants` sub-select carries NO `where`
 * clause — unlike `PEOPLE_INDEX_SELECT`'s `grants` relation, which is
 * filtered to `source: { not: "RePORTER" }` for the WCM-administered-only
 * grant signals (grantCount / hasActiveGrants / activePiGrantCount). Feeding
 * ESI derivation the FILTERED relation would silently drop prior-institution
 * RePORTER-sourced major-PI-award history and mislabel scholars as eligible.
 */
import { describe, expect, it, vi } from "vitest";

import { loadEsiEligibilityByCwid } from "@/lib/search-index-docs";

type GrantRow = { endDate: Date | null; role: string | null; mechanism: string | null };
type EducationRow = { year: number | null; degree?: string | null };

function mockClient(
  rows: ReadonlyArray<{ cwid: string; grants: GrantRow[]; educations: EducationRow[] }>,
) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { client: { scholar: { findMany } } as unknown as Parameters<
    typeof loadEsiEligibilityByCwid
  >[0], findMany };
}

describe("loadEsiEligibilityByCwid (#2300)", () => {
  // Loader stamps its own `now` internally (`new Date()`), so degree years
  // are expressed relative to the REAL current year to match it.
  const nowYear = new Date().getFullYear();

  it("does not filter grants by source — a RePORTER-only prior major-PI award still forfeits eligibility (the trap case)", async () => {
    // This grant carries no `source` field at all (the loader's select never
    // asks for it) — simulating a RePORTER-sourced prior-institution record
    // that PEOPLE_INDEX_SELECT's filtered `grants` relation would have
    // dropped. Held as PI on an R01-equivalent mechanism: disqualifying.
    const { client, findMany } = mockClient([
      {
        cwid: "trap1",
        grants: [{ endDate: new Date("2015-01-01"), role: "PI", mechanism: "R01" }],
        educations: [{ year: nowYear - 3, degree: "PhD" }],
      },
    ]);

    const result = await loadEsiEligibilityByCwid(client);

    expect(result.get("trap1")).toBe(false);
    // Assert the query is genuinely unfiltered: no `where` on the `grants`
    // sub-select (the CRITICAL data-correctness contract — a regression here
    // would silently reintroduce the RePORTER-filtered relation).
    const callArgs = findMany.mock.calls[0][0];
    expect(callArgs.select.grants.where).toBeUndefined();
  });

  it("is eligible within 10 years of the terminal degree with no major PI history", async () => {
    const { client } = mockClient([
      {
        cwid: "eligible1",
        grants: [{ endDate: new Date("2027-01-01"), role: "Co-I", mechanism: "K08" }],
        educations: [{ year: nowYear - 5, degree: "MD" }],
      },
    ]);

    const result = await loadEsiEligibilityByCwid(client);

    expect(result.get("eligible1")).toBe(true);
  });

  it("is not eligible when the terminal degree year is missing / unparseable", async () => {
    const { client } = mockClient([
      { cwid: "nodegree1", grants: [], educations: [] },
      // Present but non-numeric — filtered out by the same guard
      // `yearsSinceTerminalDegree` applies (typeof year === "number").
      {
        cwid: "nodegree2",
        grants: [],
        educations: [{ year: null as unknown as number, degree: "PhD" }],
      },
    ]);

    const result = await loadEsiEligibilityByCwid(client);

    expect(result.get("nodegree1")).toBe(false);
    expect(result.get("nodegree2")).toBe(false);
  });
});
