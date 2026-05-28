/**
 * Issue #532 — `buildPeopleDoc` leadership signal.
 *
 * `Department.chairCwid` / `Division.chiefCwid` already carry override-applied
 * leadership values from the ED ETL (ADR-002 Path B prediction + Path C manual
 * overrides). These tests assert the indexer surfaces them onto the people doc
 * correctly: lowercased names, OMIT-on-empty for non-leaders, and both
 * fields populated when a scholar is both a chair and a chief.
 */
import { describe, expect, it, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import { buildPeopleDoc, type ScholarForIndex } from "@/lib/search-index-docs";

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

function mockClient(opts: {
  chairedDepartments?: ReadonlyArray<{ name: string }>;
  chieffedDivisions?: ReadonlyArray<{ name: string }>;
} = {}): Parameters<typeof buildPeopleDoc>[1] {
  return {
    centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
    publicationAuthor: { findMany: vi.fn().mockResolvedValue([]) },
    department: {
      findMany: vi.fn().mockResolvedValue(opts.chairedDepartments ?? []),
    },
    division: {
      findMany: vi.fn().mockResolvedValue(opts.chieffedDivisions ?? []),
    },
  } as unknown as Parameters<typeof buildPeopleDoc>[1];
}

function makeScholar(overrides: Partial<ScholarForIndex> = {}): ScholarForIndex {
  const base: Partial<ScholarForIndex> = {
    cwid: "self",
    slug: "self",
    preferredName: "Self",
    fullName: "Self",
    postnominal: null,
    primaryTitle: null,
    primaryDepartment: null,
    overview: null,
    roleCategory: "faculty",
    deptCode: null,
    divCode: null,
    department: null,
    division: null,
    topicAssignments: [],
    grants: [],
    authorships: [],
    ...overrides,
  };
  return base as ScholarForIndex;
}

describe("buildPeopleDoc — leadership signal (#532)", () => {
  it("writes leadership.{isChair, chairOf} for a department chair", async () => {
    const doc = await buildPeopleDoc(
      makeScholar(),
      mockClient({ chairedDepartments: [{ name: "Pediatrics" }] }),
      NO_SUP,
    );
    expect(doc).not.toBeNull();
    const leadership = (doc as { leadership?: unknown }).leadership;
    expect(leadership).toEqual({
      isChair: true,
      chairOf: ["pediatrics"],
      isChief: false,
      chiefOf: [],
    });
  });

  it("writes leadership.{isChief, chiefOf} for a division chief", async () => {
    const doc = await buildPeopleDoc(
      makeScholar(),
      mockClient({ chieffedDivisions: [{ name: "Cardiology" }] }),
      NO_SUP,
    );
    expect((doc as { leadership: { isChief: boolean; chiefOf: string[] } })
      .leadership).toEqual({
      isChair: false,
      chairOf: [],
      isChief: true,
      chiefOf: ["cardiology"],
    });
  });

  it("populates both fields when the scholar is both a chair and a chief", async () => {
    // Rare but legal — e.g. someone who chairs one department and chiefs a
    // division of another, or holds a chief role concurrent with a chair
    // appointment. The DB has no exclusivity constraint; the index must not
    // either.
    const doc = await buildPeopleDoc(
      makeScholar(),
      mockClient({
        chairedDepartments: [{ name: "Medicine" }],
        chieffedDivisions: [{ name: "General Internal Medicine" }],
      }),
      NO_SUP,
    );
    expect((doc as { leadership: { isChair: boolean; isChief: boolean } })
      .leadership).toEqual({
      isChair: true,
      chairOf: ["medicine"],
      isChief: true,
      chiefOf: ["general internal medicine"],
    });
  });

  it("OMITs the leadership field entirely when the scholar is neither chair nor chief", async () => {
    // The omit-on-empty contract mirrors `publicationMeshUi` / `topicImpacts`:
    // _source consumers + `exists` filters distinguish "no signal" from a
    // zeroed-out object.
    const doc = await buildPeopleDoc(makeScholar(), mockClient(), NO_SUP);
    expect(doc).not.toBeNull();
    expect("leadership" in (doc as object)).toBe(false);
  });

  it("supports multiple dept chairs on one scholar (cross-dept appointments)", async () => {
    // Cross-dept chairs are rare but real; the field must remain a list, not
    // collapse to a single string.
    const doc = await buildPeopleDoc(
      makeScholar(),
      mockClient({
        chairedDepartments: [
          { name: "Medicine" },
          { name: "Population Health Sciences" },
        ],
      }),
      NO_SUP,
    );
    expect((doc as { leadership: { chairOf: string[] } }).leadership.chairOf)
      .toEqual(["medicine", "population health sciences"]);
  });
});
