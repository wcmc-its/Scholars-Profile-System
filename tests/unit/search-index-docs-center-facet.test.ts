/**
 * #552 Phase 6 — `buildPeopleDoc` center facet keys are gated on the §3.3
 * active predicate. An inactive (lapsed) or pending membership emits NO facet
 * key — neither `center:<code>` nor `centerProgram:<code>` — matching the
 * public center page (PR-4). `centerProgram:<code>` is additionally gated on a
 * non-null program code. Date-only legacy rows (null dates) read as active.
 */
import { describe, expect, it, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import { buildPeopleDoc, type ScholarForIndex } from "@/lib/search-index-docs";

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

type ClientArg = Parameters<typeof buildPeopleDoc>[1];
type CenterRow = {
  centerCode: string;
  programCode: string | null;
  startDate: Date | null;
  endDate: Date | null;
};

const D = (iso: string) => new Date(iso);

function mockClient(centerRows: ReadonlyArray<CenterRow>): ClientArg {
  return {
    centerMembership: { findMany: vi.fn().mockResolvedValue(centerRows) },
    divisionMembership: { findMany: vi.fn().mockResolvedValue([]) },
    publicationAuthor: { findMany: vi.fn().mockResolvedValue([]) },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: vi.fn().mockResolvedValue([]) },
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

async function keysFor(centerRows: ReadonlyArray<CenterRow>): Promise<string[]> {
  const doc = await buildPeopleDoc(makeScholar(), mockClient(centerRows), NO_SUP);
  expect(doc).not.toBeNull();
  return (doc as { deptDivKey: string[] }).deptDivKey;
}

describe("buildPeopleDoc — center facet active gating (#552 Phase 6)", () => {
  it("active + programmed → emits both center: and centerProgram:", async () => {
    const keys = await keysFor([
      { centerCode: "meyer_cancer_center", programCode: "CT", startDate: null, endDate: null },
    ]);
    expect(keys).toContain("center:meyer_cancer_center");
    expect(keys).toContain("centerProgram:CT");
  });

  it("active + null program → emits center: only (no centerProgram:)", async () => {
    const keys = await keysFor([
      { centerCode: "meyer_cancer_center", programCode: null, startDate: null, endDate: null },
    ]);
    expect(keys).toContain("center:meyer_cancer_center");
    expect(keys.some((k) => k.startsWith("centerProgram:"))).toBe(false);
  });

  it("inactive (lapsed end date) → emits NO key (active-gated, matches the page)", async () => {
    const keys = await keysFor([
      { centerCode: "meyer_cancer_center", programCode: "CT", startDate: null, endDate: D("2000-01-01") },
    ]);
    expect(keys.some((k) => k.startsWith("center:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("centerProgram:"))).toBe(false);
  });

  it("pending (future start date) → emits NO key", async () => {
    const keys = await keysFor([
      { centerCode: "meyer_cancer_center", programCode: "CT", startDate: D("2999-01-01"), endDate: null },
    ]);
    expect(keys.some((k) => k.startsWith("center:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("centerProgram:"))).toBe(false);
  });

  it("legacy null-dated membership reads as active (baseline preserved)", async () => {
    const keys = await keysFor([
      { centerCode: "englander_ipm", programCode: null, startDate: null, endDate: null },
    ]);
    expect(keys).toContain("center:englander_ipm");
  });

  it("explicit range spanning today → active; both keys emitted", async () => {
    const keys = await keysFor([
      { centerCode: "meyer_cancer_center", programCode: "CB", startDate: D("2000-01-01"), endDate: D("2999-12-31") },
    ]);
    expect(keys).toContain("center:meyer_cancer_center");
    expect(keys).toContain("centerProgram:CB");
  });

  it("mixed memberships: only the active ones contribute keys", async () => {
    const keys = await keysFor([
      { centerCode: "active_ctr", programCode: "CT", startDate: null, endDate: null },
      { centerCode: "lapsed_ctr", programCode: "CB", startDate: null, endDate: D("2000-01-01") },
      { centerCode: "pending_ctr", programCode: "CB", startDate: D("2999-01-01"), endDate: null },
    ]);
    expect(keys).toContain("center:active_ctr");
    expect(keys).toContain("centerProgram:CT");
    expect(keys.some((k) => k.includes("lapsed_ctr"))).toBe(false);
    expect(keys.some((k) => k.includes("pending_ctr"))).toBe(false);
  });
});
