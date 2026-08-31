/**
 * `components/department/department-page.tsx` — the render-layer half of
 * #2542 Phase D. `lib/api/departments.ts` already resolves the right label
 * and the right `isInterim` value; the bug this file guards against is
 * narrower and lived one layer up, in the JSX: the page built a `LeaderCard`
 * without ever forwarding `detail.chair.isInterim`, so an interim chair
 * rendered identically to a permanent one no matter what the data layer said
 * (mirrors the gap Phase B already closed for centers).
 *
 * `getDepartment` is mocked here — the data-layer precedence itself
 * (override / assignment / column, label resolution) is covered by
 * `tests/unit/api-dept-unit-curation.test.ts` and
 * `tests/unit/unit-leader.test.ts`. This file only has to prove the page
 * forwards what the data layer already produces.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockGetDepartment, mockGetDepartmentFaculty, mockGetSpotlight } = vi.hoisted(() => ({
  mockGetDepartment: vi.fn(),
  mockGetDepartmentFaculty: vi.fn(),
  mockGetSpotlight: vi.fn(),
}));

vi.mock("@/lib/api/departments", () => ({
  getDepartment: mockGetDepartment,
  getDepartmentFaculty: mockGetDepartmentFaculty,
}));
vi.mock("@/lib/api/spotlight", () => ({
  getSpotlightCardsForDepartment: mockGetSpotlight,
}));
vi.mock("@/lib/api/dept-lists", () => ({
  getDeptPublicationsList: vi.fn(),
  getDeptGrantsList: vi.fn(),
}));
// Heavy client component with its own dropdown/pagination state — irrelevant
// to the leader card under test, so it's stubbed exactly as
// `tests/unit/slug-requests-page.test.tsx` stubs its own chrome components.
vi.mock("@/components/department/department-faculty-client", () => ({
  DepartmentFacultyClient: () => <div data-testid="mock-faculty-client" />,
}));

import { DepartmentPage } from "@/components/department/department-page";

const DEPT = {
  code: "MED",
  name: "Department of Medicine",
  officialName: null,
  compactName: null,
  slug: "medicine",
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
  const role = overrides.role ?? "Chair";
  return {
    dept: DEPT,
    chair: {
      cwid: "chr001",
      preferredName: "Dr. Chair Person",
      slug: "dr-chair-person",
      chairTitle: role,
      primaryTitle: "Professor of Medicine",
      identityImageEndpoint: "https://example.test/chr001.png",
      role,
      isInterim: overrides.isInterim ?? false,
    },
    topResearchAreas: [],
    divisions: [],
    stats: { scholars: 10, divisions: 0, publications: 5, activeGrants: 2 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDepartmentFaculty.mockResolvedValue(FACULTY);
  mockGetSpotlight.mockResolvedValue([]);
});

describe("DepartmentPage — leader card render (#2542 Phase D)", () => {
  it("passes isInterim through to LeaderCard: an interim chair reads 'Interim Chair'", async () => {
    mockGetDepartment.mockResolvedValue(baseDetail({ isInterim: true }));
    render(await DepartmentPage({ deptSlug: "medicine", page: 1 }));
    expect(screen.getByText("Interim Chair")).toBeTruthy();
    expect(screen.queryByText(/^Chair$/)).toBeNull();
  });

  it("a non-interim chair reads plain 'Chair', not 'Interim Chair'", async () => {
    mockGetDepartment.mockResolvedValue(baseDetail({ isInterim: false }));
    render(await DepartmentPage({ deptSlug: "medicine", page: 1 }));
    expect(screen.getByText("Chair")).toBeTruthy();
    expect(screen.queryByText("Interim Chair")).toBeNull();
  });

  it("renders the vocabulary-resolved label, not a hardcoded 'Chair'/'Director' literal", async () => {
    // A steward rename via /edit/roles — the page must show whatever
    // `getDepartment` resolved, not re-derive it from `category`.
    mockGetDepartment.mockResolvedValue(baseDetail({ role: "Department Head" }));
    render(await DepartmentPage({ deptSlug: "medicine", page: 1 }));
    expect(screen.getByText("Department Head")).toBeTruthy();
  });
});
