/**
 * `components/division/division-page.tsx` — the render-layer half of #2542
 * Phase D. Mirrors `tests/unit/department-page-leader-render.test.tsx`, but
 * covers TWO fixes at once: `role="Chief"` was hardcoded in the JSX (MUST
 * fix #4 — a steward rename of "Chief" via the vocabulary editor never
 * reached this page), and `interim` was never forwarded to `LeaderCard` at
 * all (the same gap department pages had — MUST fix #5).
 *
 * `getDivision` is mocked here — the data-layer precedence itself is
 * covered by `tests/unit/api-div-unit-curation.test.ts` and
 * `tests/unit/unit-leader.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const {
  mockGetDivision,
  mockGetDivisionFaculty,
  mockGetDivisionPublicationsList,
  mockGetDivisionGrantsList,
  mockGetSpotlight,
} = vi.hoisted(() => ({
  mockGetDivision: vi.fn(),
  mockGetDivisionFaculty: vi.fn(),
  mockGetDivisionPublicationsList: vi.fn(),
  mockGetDivisionGrantsList: vi.fn(),
  mockGetSpotlight: vi.fn(),
}));

vi.mock("@/lib/api/divisions", () => ({
  getDivision: mockGetDivision,
  getDivisionFaculty: mockGetDivisionFaculty,
  getDivisionPublicationsList: mockGetDivisionPublicationsList,
  getDivisionGrantsList: mockGetDivisionGrantsList,
}));
vi.mock("@/lib/api/spotlight", () => ({
  getSpotlightCardsForDivision: mockGetSpotlight,
}));
// Heavy client component with its own dropdown/pagination state — irrelevant
// to the leader card under test, stubbed exactly as
// `tests/unit/department-page-leader-render.test.tsx` stubs it.
vi.mock("@/components/department/department-faculty-client", () => ({
  DepartmentFacultyClient: () => <div data-testid="mock-faculty-client" />,
}));

import { DivisionPage } from "@/components/division/division-page";

const PARENT_DEPT = { code: "MED", name: "Department of Medicine", slug: "medicine" };

const DIVISION = {
  code: "CARDIO",
  name: "Cardiology",
  slug: "cardiology",
  description: null,
  url: null,
};

const FACULTY = {
  hits: [],
  total: 0,
  roleCategoryCounts: {},
  page: 0,
  pageSize: 20,
  methodFacet: [],
};

function baseDetail(overrides: Partial<{ role: string; isInterim: boolean }> = {}) {
  const role = overrides.role ?? "Chief";
  return {
    division: DIVISION,
    parentDept: PARENT_DEPT,
    chief: {
      cwid: "chf001",
      preferredName: "Dr. Division Chief",
      slug: "dr-division-chief",
      chiefTitle: role,
      primaryTitle: "Professor of Medicine",
      identityImageEndpoint: "https://example.test/chf001.png",
      role,
      isInterim: overrides.isInterim ?? false,
    },
    topResearchAreas: [],
    siblingDivisions: [{ code: "CARDIO", name: "Cardiology", slug: "cardiology" }],
    stats: { scholars: 10, publications: 5, activeGrants: 2 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDivisionFaculty.mockResolvedValue(FACULTY);
  mockGetSpotlight.mockResolvedValue([]);
});

describe("DivisionPage — leader card render (#2542 Phase D)", () => {
  it("passes isInterim through to LeaderCard: an interim chief reads 'Interim Chief'", async () => {
    mockGetDivision.mockResolvedValue(baseDetail({ isInterim: true }));
    render(await DivisionPage({ deptSlug: "medicine", divSlug: "cardiology", page: 1 }));
    expect(screen.getByText("Interim Chief")).toBeTruthy();
    expect(screen.queryByText(/^Chief$/)).toBeNull();
  });

  it("a non-interim chief reads plain 'Chief', not 'Interim Chief'", async () => {
    mockGetDivision.mockResolvedValue(baseDetail({ isInterim: false }));
    render(await DivisionPage({ deptSlug: "medicine", divSlug: "cardiology", page: 1 }));
    expect(screen.getByText("Chief")).toBeTruthy();
    expect(screen.queryByText("Interim Chief")).toBeNull();
  });

  it("renders the vocabulary-resolved label, not the hardcoded 'Chief' literal that used to sit in the JSX", async () => {
    // A steward rename via /edit/roles — the page must show whatever
    // `getDivision` resolved, not the `role="Chief"` literal this phase removed.
    mockGetDivision.mockResolvedValue(baseDetail({ role: "Division Head" }));
    render(await DivisionPage({ deptSlug: "medicine", divSlug: "cardiology", page: 1 }));
    expect(screen.getByText("Division Head")).toBeTruthy();
    expect(screen.queryByText(/^Chief$/)).toBeNull();
  });
});
