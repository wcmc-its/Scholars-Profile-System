/**
 * #540 Phase 8 — `buildPeopleDoc` emits division facet keys from
 * `DivisionMembership` so a manually-rostered scholar carries the division's
 * facet bucket in /people search even before LDAP adoption (SPEC line 162,
 * edge 13). When LDAP later adopts the division (edge 15), the LDAP-derived
 * `${deptCode}--${divCode}` key collides with this roster-derived key and
 * dedups via `Array.from(new Set(...))` at the assemble site.
 */
import { describe, expect, it, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import { buildPeopleDoc, type ScholarForIndex } from "@/lib/search-index-docs";

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

type ClientArg = Parameters<typeof buildPeopleDoc>[1];

function mockClient(opts: {
  divRosterRows?: ReadonlyArray<{ divisionCode: string }>;
  manualDivisions?: ReadonlyArray<{ code: string; deptCode: string }>;
} = {}): ClientArg {
  // `division.findMany` is consumed by both the Phase 8 manual-roster sidecar
  // (where.code.in + source='manual') and the issue #532 chief-leadership
  // sidecar (where.chiefCwid). Discriminate by where shape so each consumer
  // gets the row schema it expects (`code`/`deptCode` vs `name`).
  const divisionFindMany = vi.fn().mockImplementation((args?: {
    where?: { chiefCwid?: string; code?: { in?: string[] } };
  }) => {
    if (args?.where?.chiefCwid !== undefined) return Promise.resolve([]);
    if (args?.where?.code?.in) return Promise.resolve(opts.manualDivisions ?? []);
    return Promise.resolve([]);
  });
  return {
    centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
    divisionMembership: {
      findMany: vi.fn().mockResolvedValue(opts.divRosterRows ?? []),
    },
    publicationAuthor: { findMany: vi.fn().mockResolvedValue([]) },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: divisionFindMany },
  } as unknown as ClientArg;
}

function makeScholar(overrides: Partial<ScholarForIndex> = {}): ScholarForIndex {
  return {
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
  } as ScholarForIndex;
}

describe("buildPeopleDoc — manual-roster division facet keys (#540 Phase 8)", () => {
  it("contributes `${deptCode}--${divCode}` for each manual-roster row", async () => {
    const doc = await buildPeopleDoc(
      makeScholar({ deptCode: null, divCode: null }),
      mockClient({
        divRosterRows: [{ divisionCode: "N1234" }],
        manualDivisions: [{ code: "N1234", deptCode: "MED" }],
      }),
      NO_SUP,
    );
    expect(doc).not.toBeNull();
    const keys = (doc as { deptDivKey: string[] }).deptDivKey;
    expect(keys).toContain("MED--N1234");
  });

  it("dedups against the LDAP-derived key on an adopted division (edge 15)", async () => {
    // Scholar carries `divCode='N1234'` (LDAP has adopted) AND a
    // `DivisionMembership` row for the same code (still curated). The two
    // sources of `MED--N1234` collide and the assembled key array dedups.
    const doc = await buildPeopleDoc(
      makeScholar({ deptCode: "MED", divCode: "N1234" }),
      mockClient({
        divRosterRows: [{ divisionCode: "N1234" }],
        manualDivisions: [{ code: "N1234", deptCode: "MED" }],
      }),
      NO_SUP,
    );
    const keys = (doc as { deptDivKey: string[] }).deptDivKey;
    const occurrences = keys.filter((k) => k === "MED--N1234").length;
    expect(occurrences).toBe(1);
  });

  it("filters DivisionMembership rows to source='manual' divisions only", async () => {
    // A scholar's `DivisionMembership` lookup returns a row pointing at a
    // division code, but the corresponding `Division` is NOT `source='manual'`
    // (so the division.findMany — gated by `where.source = 'manual'` — would
    // return []). Verify no facet key is emitted in that case.
    const doc = await buildPeopleDoc(
      makeScholar({ deptCode: null, divCode: null }),
      mockClient({
        divRosterRows: [{ divisionCode: "EDDIV" }],
        manualDivisions: [], // simulating the source='manual' filter excluding the division
      }),
      NO_SUP,
    );
    const keys = (doc as { deptDivKey: string[] }).deptDivKey;
    expect(keys.some((k) => k.endsWith("--EDDIV"))).toBe(false);
  });

  it("emits nothing extra when the scholar has no DivisionMembership rows", async () => {
    // Baseline: pre-Phase-8 behavior must be preserved exactly for the LDAP
    // case. With `divCode='CARDIO'` set, the bucket key comes from the LDAP
    // path; no manual-roster contribution.
    const doc = await buildPeopleDoc(
      makeScholar({ deptCode: "MED", divCode: "CARDIO" }),
      mockClient({ divRosterRows: [] }),
      NO_SUP,
    );
    const keys = (doc as { deptDivKey: string[] }).deptDivKey;
    expect(keys.sort()).toEqual(["MED", "MED--CARDIO"]);
  });
});
