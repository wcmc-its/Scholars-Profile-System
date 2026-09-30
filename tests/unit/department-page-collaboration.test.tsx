/**
 * DepartmentPage — the Collaboration tab wiring: flag + ≥2 populated divisions
 * gate the tab; `?tab=collaboration` renders the (client) network; a deep link
 * on an ineligible department falls back to the Scholars roster. The data
 * layer and the client network are mocked; assertions stay in the container.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";

const {
  mockGetDepartment,
  mockGetDepartmentFaculty,
  mockGetDivisionCounts,
  mockFlag,
  mockCollabTab,
} = vi.hoisted(() => ({
  mockGetDepartment: vi.fn(),
  mockGetDepartmentFaculty: vi.fn(),
  mockGetDivisionCounts: vi.fn(),
  mockFlag: vi.fn(),
  mockCollabTab: vi.fn(),
}));

vi.mock("@/lib/api/departments", () => ({
  getDepartment: mockGetDepartment,
  getDepartmentFaculty: mockGetDepartmentFaculty,
}));
vi.mock("@/lib/api/spotlight", () => ({
  getSpotlightCardsForDepartment: vi.fn(async () => []),
}));
vi.mock("@/lib/api/unit-members", () => ({
  getDepartmentDivisionMemberCounts: mockGetDivisionCounts,
}));
vi.mock("@/lib/api/dept-lists", () => ({
  getDeptPublicationsList: vi.fn(),
  getDeptGrantsList: vi.fn(),
}));
vi.mock("@/lib/center-collaboration/flags", () => ({
  isCenterCollaborationNetworkEnabled: mockFlag,
  isCenterCollaborationGrantAxisEnabled: () => false,
}));
vi.mock("@/components/department/department-faculty-client", () => ({
  DepartmentFacultyClient: () => <div data-testid="mock-faculty-client" />,
}));
vi.mock("@/components/department/department-collaboration-tab", () => ({
  DepartmentCollaborationTab: (props: unknown) => {
    mockCollabTab(props);
    return <div data-testid="mock-collab-tab" />;
  },
}));

import { DepartmentPage } from "@/components/department/department-page";

const DETAIL = {
  dept: {
    code: "TSTDEPT",
    name: "Department of Testing",
    officialName: null,
    compactName: null,
    slug: "test-dept",
    description: null,
    url: null,
  },
  chair: null,
  topResearchAreas: [],
  divisions: [
    { code: "DIV_A", name: "Alpha Division", slug: "alpha", scholarCount: 4 },
    { code: "DIV_B", name: "Beta Division", slug: "beta", scholarCount: 2 },
  ],
  stats: { scholars: 6, divisions: 2, publications: 5, activeGrants: 1 },
};

const FACULTY = {
  hits: [],
  total: 0,
  roleCategoryCounts: {},
  page: 0,
  pageSize: 20,
  methodFacet: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDepartment.mockResolvedValue(DETAIL);
  mockGetDepartmentFaculty.mockResolvedValue(FACULTY);
  mockFlag.mockReturnValue(true);
  mockGetDivisionCounts.mockResolvedValue(
    new Map([
      ["DIV_A", 4],
      ["DIV_B", 2],
    ]),
  );
});

describe("DepartmentPage — Collaboration tab", () => {
  it("?tab=collaboration on an eligible department renders the network, tab selected", async () => {
    const { container } = render(
      await DepartmentPage({ deptSlug: "test-dept", page: 1, tab: "collaboration" }),
    );
    const view = within(container);
    expect(view.getByTestId("mock-collab-tab")).toBeTruthy();
    expect(mockCollabTab).toHaveBeenCalledWith({
      deptSlug: "test-dept",
      deptName: "Department of Testing",
    });
    expect(view.getByRole("tab", { name: "Collaboration" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(view.queryByTestId("mock-faculty-client")).toBeNull();
    expect(mockGetDepartmentFaculty).not.toHaveBeenCalled();
  });

  it("an eligible department on the Scholars tab shows the Collaboration tab link", async () => {
    const { container } = render(await DepartmentPage({ deptSlug: "test-dept", page: 1 }));
    const tab = within(container).getByRole("tab", { name: "Collaboration" });
    expect(tab.getAttribute("href")).toBe("/departments/test-dept?tab=collaboration#tab-content");
    expect(within(container).queryByTestId("mock-collab-tab")).toBeNull();
  });

  it("an ineligible department (<2 populated divisions) falls back to the Scholars roster", async () => {
    mockGetDivisionCounts.mockResolvedValue(
      new Map([
        ["DIV_A", 4],
        ["DIV_B", 0],
      ]),
    );
    const { container } = render(
      await DepartmentPage({ deptSlug: "test-dept", page: 1, tab: "collaboration" }),
    );
    const view = within(container);
    expect(view.getByTestId("mock-faculty-client")).toBeTruthy();
    expect(view.queryByTestId("mock-collab-tab")).toBeNull();
    expect(view.queryByRole("tab", { name: "Collaboration" })).toBeNull();
    expect(view.getByRole("tab", { name: /Scholars/ }).getAttribute("aria-selected")).toBe("true");
    expect(mockGetDepartmentFaculty).toHaveBeenCalledWith("TSTDEPT", { page: 0, sort: "last" });
  });

  it("with the flag off the tab is absent", async () => {
    mockFlag.mockReturnValue(false);
    const { container } = render(
      await DepartmentPage({ deptSlug: "test-dept", page: 1, tab: "collaboration" }),
    );
    const view = within(container);
    expect(view.queryByRole("tab", { name: "Collaboration" })).toBeNull();
    expect(view.queryByTestId("mock-collab-tab")).toBeNull();
    expect(view.getByTestId("mock-faculty-client")).toBeTruthy();
  });
});
