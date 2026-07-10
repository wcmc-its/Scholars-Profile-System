/**
 * `buildScholarNameClauses` — the tokenized Prisma name/CWID filter shared by the
 * Profiles roster, the Data Quality dashboard, and the impersonation picker. Pure
 * `where`-shape construction, so no DB. The regression it guards: an admin unable
 * to find a scholar by "First Last" when the stored `fullName` carries a middle
 * name, and a single-word search silently changing shape.
 */
import { describe, expect, it } from "vitest";

import { buildScholarNameClauses } from "@/lib/api/scholar-name-search";

const or = (t: string) => ({
  OR: [
    { preferredName: { contains: t } },
    { fullName: { contains: t } },
    { cwid: { contains: t } },
  ],
});

describe("buildScholarNameClauses", () => {
  it("splits a multi-word query into one AND-ed clause per token", () => {
    expect(buildScholarNameClauses("Jane Smith")).toEqual([or("Jane"), or("Smith")]);
  });

  it("is a single clause for a one-token query — identical to the old OR group", () => {
    expect(buildScholarNameClauses("smith")).toEqual([or("smith")]);
  });

  it("collapses repeated / leading / trailing whitespace", () => {
    expect(buildScholarNameClauses("  Jane   Smith  ")).toEqual(buildScholarNameClauses("Jane Smith"));
  });

  it("returns [] for a blank query so nothing is AND-ed", () => {
    expect(buildScholarNameClauses("")).toEqual([]);
    expect(buildScholarNameClauses("   ")).toEqual([]);
  });
});
