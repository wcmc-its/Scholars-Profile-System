/**
 * #2720 — the ED ETL's title-resolution post-pass.
 *
 * The behaviour worth pinning is not "precedence works" (that is
 * `scholar-title.test.ts`, against the pure resolver) but the three things
 * only the post-pass can get wrong:
 *
 *   1. it writes ONLY where the resolved value differs, so a steady-state run
 *      is ~80 updates and not 8,769;
 *   2. it REVERTS a scholar who lost a tier — the property that removes the
 *      need for a backfill, and the reason the feature flag is safe to turn
 *      off;
 *   3. with the flag off it resolves from the override + ED primary title
 *      only, i.e. today's titles.
 */
import { describe, expect, it, vi } from "vitest";

import { resolveScholarTitles } from "@/etl/ed/title-resolution";

type ScholarRow = {
  cwid: string;
  primaryTitle: string | null;
  edPrimaryTitle: string | null;
  workingTitle: string | null;
};

/** Minimal stand-in for the Prisma surface the post-pass uses. */
function fakeClient(opts: {
  scholars: ScholarRow[];
  divisionAssignments?: { cwid: string; entityId: string; label: string; interim?: boolean }[];
  centerAssignments?: { cwid: string; entityId: string; label: string; interim?: boolean }[];
  divisions?: { code: string; name: string; department: { name: string } | null }[];
  centers?: { code: string; name: string; officialName: string | null }[];
  overrides?: { entityId: string; value: string }[];
}) {
  const updates: { cwid: string; primaryTitle: string | null }[] = [];
  const client = {
    scholar: {
      findMany: vi.fn(async () => opts.scholars),
      update: vi.fn(async (args: { where: { cwid: string }; data: { primaryTitle: string | null } }) => {
        updates.push({ cwid: args.where.cwid, primaryTitle: args.data.primaryTitle });
        return null;
      }),
    },
    orgUnitRoleAssignment: {
      findMany: vi.fn(async (args: { where: { entityType: string } }) => {
        const rows =
          args.where.entityType === "division"
            ? (opts.divisionAssignments ?? [])
            : (opts.centerAssignments ?? []);
        return rows.map((r) => ({
          cwid: r.cwid,
          entityId: r.entityId,
          interim: r.interim ?? false,
          role: { label: r.label },
        }));
      }),
    },
    division: { findMany: vi.fn(async () => opts.divisions ?? []) },
    center: { findMany: vi.fn(async () => opts.centers ?? []) },
    fieldOverride: { findMany: vi.fn(async () => opts.overrides ?? []) },
  };
  return { client, updates };
}

const DIVISIONS = [
  // Mirrors the one real collision found on 2026-09-22: a single division
  // name living under two different departments. Codes are synthetic.
  { code: "DIV-CARD-A", name: "Cardiology", department: { name: "Medicine" } },
  { code: "DIV-CARD-B", name: "Cardiology", department: { name: "Pediatrics" } },
  { code: "DIV-SLEEP", name: "Sleep Neurology", department: { name: "Neurology" } },
];

describe("resolveScholarTitles — writes", () => {
  it("does not write when the stored title already matches", async () => {
    const { client, updates } = fakeClient({
      scholars: [
        {
          cwid: "a",
          primaryTitle: "Senior Associate Dean, Example Programme",
          edPrimaryTitle: "Chair of Example Sciences",
          workingTitle: "Senior Associate Dean, Example Programme",
        },
      ],
    });
    const result = await resolveScholarTitles(client as never, { applyDerivedTiers: true });
    expect(updates).toEqual([]);
    expect(result).toMatchObject({ scanned: 1, updated: 0 });
  });

  it("writes the working title over the ED primary title", async () => {
    const { client, updates } = fakeClient({
      scholars: [
        {
          cwid: "sch0001",
          primaryTitle: "Chair of Example Sciences",
          edPrimaryTitle: "Chair of Example Sciences",
          workingTitle: "Senior Associate Dean, Example Programme",
        },
      ],
    });
    const result = await resolveScholarTitles(client as never, { applyDerivedTiers: true });
    expect(updates).toEqual([
      { cwid: "sch0001", primaryTitle: "Senior Associate Dean, Example Programme" },
    ]);
    expect(result.updated).toBe(1);
    expect(result.byTier).toMatchObject({ working: 1 });
  });

  it("REVERTS a scholar who lost their chief role — no backfill needed", async () => {
    // Stored title is last night's chief line; the assignment is gone this run.
    const { client, updates } = fakeClient({
      scholars: [
        {
          cwid: "expchief",
          primaryTitle: "Chief, Sleep Neurology",
          edPrimaryTitle: "Professor of Clinical Neurology",
          workingTitle: null,
        },
      ],
      divisionAssignments: [],
      divisions: DIVISIONS,
    });
    await resolveScholarTitles(client as never, { applyDerivedTiers: true });
    expect(updates).toEqual([
      { cwid: "expchief", primaryTitle: "Professor of Clinical Neurology" },
    ]);
  });
});

describe("resolveScholarTitles — derived tiers", () => {
  it("qualifies an ambiguous division but not a unique one", async () => {
    const { client, updates } = fakeClient({
      scholars: [
        { cwid: "sch0002", primaryTitle: null, edPrimaryTitle: "Professor", workingTitle: null },
        { cwid: "sch0003", primaryTitle: null, edPrimaryTitle: "Professor", workingTitle: null },
        { cwid: "sch0004", primaryTitle: null, edPrimaryTitle: "Professor", workingTitle: null },
      ],
      divisionAssignments: [
        { cwid: "sch0002", entityId: "DIV-CARD-A", label: "Chief" },
        { cwid: "sch0003", entityId: "DIV-CARD-B", label: "Chief" },
        { cwid: "sch0004", entityId: "DIV-SLEEP", label: "Chief" },
      ],
      divisions: DIVISIONS,
    });
    await resolveScholarTitles(client as never, { applyDerivedTiers: true });
    expect(updates).toEqual([
      { cwid: "sch0002", primaryTitle: "Chief, Cardiology (Medicine)" },
      { cwid: "sch0003", primaryTitle: "Chief, Cardiology (Pediatrics)" },
      // Unique name ⇒ no qualifier, so 23 of 25 chiefs stay unadorned.
      { cwid: "sch0004", primaryTitle: "Chief, Sleep Neurology" },
    ]);
  });

  it("falls to the center head when there is no chief role", async () => {
    const { client, updates } = fakeClient({
      scholars: [
        { cwid: "sch0005", primaryTitle: "Professor", edPrimaryTitle: "Professor", workingTitle: null },
      ],
      centerAssignments: [{ cwid: "sch0005", entityId: "CTR-CANCER", label: "Director" }],
      centers: [{ code: "CTR-CANCER", name: "Example Cancer Center", officialName: null }],
    });
    await resolveScholarTitles(client as never, { applyDerivedTiers: true });
    expect(updates).toEqual([
      { cwid: "sch0005", primaryTitle: "Director, Example Cancer Center" },
    ]);
  });

  it("contributes no title when the assignment's unit has vanished", async () => {
    // A half-rendered "Chief, undefined" is worse than falling through.
    const { client, updates } = fakeClient({
      scholars: [
        { cwid: "orphan", primaryTitle: "Professor", edPrimaryTitle: "Professor", workingTitle: null },
      ],
      divisionAssignments: [{ cwid: "orphan", entityId: "GONE", label: "Chief" }],
      divisions: DIVISIONS,
    });
    await resolveScholarTitles(client as never, { applyDerivedTiers: true });
    expect(updates).toEqual([]);
  });
});

describe("resolveScholarTitles — flag off", () => {
  it("ignores the working title and the derived tiers", async () => {
    const { client, updates } = fakeClient({
      scholars: [
        {
          cwid: "sch0001",
          primaryTitle: "Senior Associate Dean, Example Programme",
          edPrimaryTitle: "Chair of Example Sciences",
          workingTitle: "Senior Associate Dean, Example Programme",
        },
      ],
      divisionAssignments: [{ cwid: "sch0001", entityId: "DIV-SLEEP", label: "Chief" }],
      divisions: DIVISIONS,
    });
    await resolveScholarTitles(client as never, { applyDerivedTiers: false });
    // Reverts to the ED primary title — flipping the flag off self-heals rather
    // than stranding the scholar on a title nobody can reach.
    expect(updates).toEqual([
      { cwid: "sch0001", primaryTitle: "Chair of Example Sciences" },
    ]);
  });

  it("still honours an operator override", async () => {
    const { client, updates } = fakeClient({
      scholars: [
        { cwid: "pinned", primaryTitle: "Professor", edPrimaryTitle: "Professor", workingTitle: null },
      ],
      overrides: [{ entityId: "pinned", value: "Dean of Everything" }],
    });
    await resolveScholarTitles(client as never, { applyDerivedTiers: false });
    expect(updates).toEqual([{ cwid: "pinned", primaryTitle: "Dean of Everything" }]);
  });
});

describe("resolveScholarTitles — override", () => {
  it("an override beats a working title", async () => {
    const { client, updates } = fakeClient({
      scholars: [
        {
          cwid: "sch0006",
          primaryTitle: "Some Organization",
          edPrimaryTitle: "Associate Professor of Example Studies",
          workingTitle: "Some Organization",
        },
      ],
      // The escape hatch for the 7 regressions in the ED working-title census.
      overrides: [{ entityId: "sch0006", value: "Associate Professor of Example Studies" }],
    });
    const result = await resolveScholarTitles(client as never, { applyDerivedTiers: true });
    expect(updates).toEqual([
      { cwid: "sch0006", primaryTitle: "Associate Professor of Example Studies" },
    ]);
    expect(result.byTier).toMatchObject({ override: 1 });
  });

  it("an EMPTY override falls back to the derived default", async () => {
    const { client, updates } = fakeClient({
      scholars: [
        {
          cwid: "unpinned",
          primaryTitle: "Old Pin",
          edPrimaryTitle: "Professor of Medicine",
          workingTitle: null,
        },
      ],
      overrides: [{ entityId: "unpinned", value: "" }],
    });
    await resolveScholarTitles(client as never, { applyDerivedTiers: true });
    expect(updates).toEqual([{ cwid: "unpinned", primaryTitle: "Professor of Medicine" }]);
  });
});
