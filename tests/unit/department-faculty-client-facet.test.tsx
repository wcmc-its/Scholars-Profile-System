/**
 * #974 Phase 2 — DepartmentFacultyClient facet sidebar + fetch-on-select.
 *
 * Covered:
 *  - methodFacet undefined/empty → NO sidebar, single-column layout (byte-identical
 *    to the pre-#974 client; no "Methods & tools" heading, no aside).
 *  - methodFacet present → sidebar renders the RosterFacet; selecting an option
 *    fetches /api/units/[kind]/[code]/members?method=…&page=0 and REPLACES the
 *    rendered rows + total; clearing restores the SSR roster (no fetch state).
 *  - deep-link: ?method= on window.location at mount seeds the selection + fetches.
 * PersonRow is stubbed so the test targets the facet/fetch logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/department/person-row", () => ({
  PersonRow: ({ hit }: { hit: { cwid: string; preferredName: string } }) => (
    <div data-testid="person" data-cwid={hit.cwid}>
      {hit.preferredName}
    </div>
  ),
}));
// shadcn Select uses Radix portals/pointer APIs jsdom lacks; stub to a passthrough.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

import { DepartmentFacultyClient } from "@/components/department/department-faculty-client";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

function hit(cwid: string): DepartmentFacultyHit {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    divisionName: null,
    departmentName: "Department of Medicine",
    identityImageEndpoint: "",
    roleCategory: "full_time_faculty",
    overview: null,
    pubCount: 0,
    grantCount: 0,
  };
}

const SSR_HITS = [hit("ssr00001"), hit("ssr00002")];
const FACET = [
  { value: "imaging_x::Deep learning", label: "Deep learning", count: 12 },
  { value: "imaging_x::Segmentation", label: "Segmentation", count: 5 },
];

function renderClient(props: Partial<React.ComponentProps<typeof DepartmentFacultyClient>> = {}) {
  return render(
    <DepartmentFacultyClient
      faculty={SSR_HITS}
      total={2}
      roleCategoryCounts={{ "Full-time faculty": 2 }}
      page={1}
      pageSize={20}
      deptSlug="medicine"
      divisionSlug={null}
      {...props}
    />,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/departments/medicine");
});
afterEach(() => {
  vi.restoreAllMocks();
});

const facetHeading = () =>
  screen.queryByRole("heading", { name: "Methods & tools" });

describe("DepartmentFacultyClient — facet off path", () => {
  it("renders no sidebar when methodFacet is undefined (single-column, SSR rows)", () => {
    renderClient();
    expect(facetHeading()).toBeNull();
    expect(screen.getByText("SSR00001")).toBeTruthy();
    expect(screen.getByText("SSR00002")).toBeTruthy();
  });

  it("renders no sidebar when methodFacet is empty", () => {
    renderClient({ methodFacet: [], unitKind: "department", unitCode: "N1140" });
    expect(facetHeading()).toBeNull();
  });
});

describe("DepartmentFacultyClient — facet on path", () => {
  it("renders the sidebar and selecting a method fetches + replaces the roster", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ hits: [hit("flt00001")], total: 1, page: 0, pageSize: 20 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140" });

    // Sidebar present; SSR rows shown until a selection is made.
    expect(facetHeading()).toBeTruthy();
    expect(screen.getByText("SSR00001")).toBeTruthy();

    fireEvent.click(screen.getByText("Deep learning"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/units/department/N1140/members");
    expect(calledUrl).toContain("method=imaging_x%3A%3ADeep+learning");
    expect(calledUrl).toContain("page=0");

    // The filtered roster replaces the SSR rows.
    await waitFor(() => expect(screen.getByText("FLT00001")).toBeTruthy());
    expect(screen.queryByText("SSR00001")).toBeNull();
  });

  it("clearing the selection restores the SSR roster (no filtered state)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ hits: [hit("flt00001")], total: 1, page: 0, pageSize: 20 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140" });
    fireEvent.click(screen.getByText("Deep learning"));
    await waitFor(() => expect(screen.getByText("FLT00001")).toBeTruthy());

    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(screen.getByText("SSR00001")).toBeTruthy());
    expect(screen.queryByText("FLT00001")).toBeNull();
  });

  it("seeds the selection from ?method= on mount and fetches (deep-link)", async () => {
    window.history.replaceState(
      null,
      "",
      "/departments/medicine?method=imaging_x%3A%3ASegmentation",
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ hits: [hit("seg00001")], total: 1, page: 0, pageSize: 20 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain("method=imaging_x%3A%3ASegmentation");
    await waitFor(() => expect(screen.getByText("SEG00001")).toBeTruthy());
  });
});
