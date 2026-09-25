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

const {
  mockGetDepartment,
  mockGetDepartmentFaculty,
  mockGetSpotlight,
  mockGetDivisionCounts,
  mockFacultyClient,
} = vi.hoisted(() => ({
  mockGetDepartment: vi.fn(),
  mockGetDepartmentFaculty: vi.fn(),
  mockGetSpotlight: vi.fn(),
  mockGetDivisionCounts: vi.fn(),
  mockFacultyClient: vi.fn(),
}));

vi.mock("@/lib/api/departments", () => ({
  getDepartment: mockGetDepartment,
  getDepartmentFaculty: mockGetDepartmentFaculty,
}));
vi.mock("@/lib/api/spotlight", () => ({
  getSpotlightCardsForDepartment: mockGetSpotlight,
}));
vi.mock("@/lib/api/unit-members", () => ({
  getDepartmentDivisionMemberCounts: mockGetDivisionCounts,
}));
vi.mock("@/lib/api/dept-lists", () => ({
  getDeptPublicationsList: vi.fn(),
  getDeptGrantsList: vi.fn(),
}));
// Heavy client component with its own dropdown/pagination state — irrelevant
// to the leader card under test, so it's stubbed exactly as
// `tests/unit/slug-requests-page.test.tsx` stubs its own chrome components.
vi.mock("@/components/department/department-faculty-client", () => ({
  DepartmentFacultyClient: (props: unknown) => {
    mockFacultyClient(props);
    return <div data-testid="mock-faculty-client" />;
  },
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
  mockGetDivisionCounts.mockResolvedValue(new Map());
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

describe("DepartmentPage — Unit Page v2 hero", () => {
  it("breadcrumb is Home › Departments & Centers › {name} (no separate Browse crumb)", async () => {
    mockGetDepartment.mockResolvedValue(baseDetail());
    render(await DepartmentPage({ deptSlug: "medicine", page: 1 }));
    const crumb = screen.getByRole("link", { name: "Departments & Centers" });
    expect(crumb.getAttribute("href")).toBe("/browse#departments");
    expect(screen.queryByRole("link", { name: "Browse" })).toBeNull();
  });

  it("stats are links into the page; zero stats are dropped", async () => {
    mockGetDepartment.mockResolvedValue(baseDetail());
    render(await DepartmentPage({ deptSlug: "medicine", page: 1 }));
    expect(screen.getByRole("link", { name: "10 scholars" }).getAttribute("href")).toBe(
      "/departments/medicine#people",
    );
    expect(screen.getByRole("link", { name: "5 publications" }).getAttribute("href")).toBe(
      "/departments/medicine?tab=publications#people",
    );
    expect(screen.getByRole("link", { name: "2 active grants" }).getAttribute("href")).toBe(
      "/departments/medicine?tab=grants#people",
    );
    // stats.divisions === 0 → no divisions stat.
    expect(screen.queryByRole("link", { name: /divisions/ })).toBeNull();
  });

  it("renders division chips with PUBLIC member counts (not the ETL scholarCount), linking to the division pages", async () => {
    mockGetDepartment.mockResolvedValue({
      ...baseDetail(),
      divisions: [{ code: "D1", name: "Cardiology", slug: "cardiology", scholarCount: 241 }],
      stats: { scholars: 10, divisions: 1, publications: 5, activeGrants: 2 },
    });
    mockGetDivisionCounts.mockResolvedValue(new Map([["D1", 198]]));
    const { container } = render(await DepartmentPage({ deptSlug: "medicine", page: 1 }));
    expect(mockGetDivisionCounts).toHaveBeenCalledWith("MED");
    expect(container.querySelector("#subunits")?.textContent).toBe("1 division");
    const chip = screen.getByRole("link", { name: /Cardiology/ });
    expect(chip.getAttribute("href")).toBe("/departments/medicine/divisions/cardiology");
    expect(chip.textContent).toContain("198");
    expect(chip.textContent).not.toContain("241");
    // The roster's Division facet gets the same public counts.
    const facultyProps = mockFacultyClient.mock.calls[0][0] as {
      divisionFacet: Array<{ value: string; count: number }>;
    };
    expect(facultyProps.divisionFacet).toEqual([
      {
        value: "D1",
        label: "Cardiology",
        count: 198,
        href: "/departments/medicine/divisions/cardiology",
      },
    ]);
    expect(screen.getByRole("link", { name: "1 division" }).getAttribute("href")).toBe(
      "#subunits",
    );
  });

  // Page-level contract: a division chip filters in place EXACTLY when the
  // roster offers the Division facet. `DepartmentFacultyClient` shows that facet
  // only while `methodFacet !== undefined`, which the real `getDepartmentFaculty`
  // sets iff `isOrgUnitMethodsFacetEnabled()` — the mock below mirrors that
  // gating, so a page that decided the chip's mode from any other signal fails.
  it.each([
    ["on", "/departments/medicine?div=D1#people"],
    ["off", "/departments/medicine/divisions/cardiology"],
  ])(
    "ORG_UNIT_METHODS_FACET=%s: chip filters in place iff the roster gets a methodFacet",
    async (flag, href) => {
      vi.stubEnv("METHODS_LENS_ENABLED", "on");
      vi.stubEnv("ORG_UNIT_METHODS_FACET", flag);
      try {
        mockGetDepartmentFaculty.mockImplementation(async () => ({
          ...FACULTY,
          methodFacet: process.env.ORG_UNIT_METHODS_FACET === "on" ? [] : undefined,
        }));
        mockGetDepartment.mockResolvedValue({
          ...baseDetail(),
          divisions: [{ code: "D1", name: "Cardiology", slug: "cardiology", scholarCount: 241 }],
          stats: { scholars: 10, divisions: 1, publications: 5, activeGrants: 2 },
        });
        mockGetDivisionCounts.mockResolvedValue(new Map([["D1", 198]]));
        render(await DepartmentPage({ deptSlug: "medicine", page: 1 }));
        const chipHref = screen.getByRole("link", { name: /Cardiology/ }).getAttribute("href");
        expect(chipHref).toBe(href);
        const { methodFacet } = mockFacultyClient.mock.calls[0][0] as {
          methodFacet?: unknown[];
        };
        expect(chipHref!.includes("?div=")).toBe(methodFacet !== undefined);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("shows the curated website as a text link and keeps #people + #tab-content anchors", async () => {
    mockGetDepartment.mockResolvedValue({
      ...baseDetail(),
      dept: { ...DEPT, url: "https://medicine.example.test" },
    });
    const { container } = render(await DepartmentPage({ deptSlug: "medicine", page: 1 }));
    expect(
      screen.getByRole("link", { name: "Department website" }).getAttribute("href"),
    ).toBe("https://medicine.example.test");
    expect(container.querySelector("#people #tab-content")).not.toBeNull();
  });
});

