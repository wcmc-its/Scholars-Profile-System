/**
 * DepartmentFacultyClient — two review fixes (2026-07-07):
 *  (1) the URL-reflect effect must not strip a legitimate unfiltered `?page=N`
 *      on mount, and must reflect the SSR `page` prop (not a stale filtered
 *      page) when no method filter is active.
 *  (2) a failed method-filter fetch must surface a retryable error, NOT the
 *      "No scholars match these filters." empty state (a network failure and an
 *      empty result are different facts).
 *
 * Mirrors the render/stub idiom of department-faculty-client-facet.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/department/person-row", () => ({
  PersonRow: ({ hit }: { hit: { cwid: string; preferredName: string } }) => (
    <div data-testid="person" data-cwid={hit.cwid}>
      {hit.preferredName}
    </div>
  ),
}));
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
const FACET = [{ value: "imaging_x::Deep learning", label: "Deep learning", count: 12 }];

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

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/departments/medicine");
});

describe("DepartmentFacultyClient — unfiltered ?page= preservation (#review-0707)", () => {
  it("keeps a legitimate unfiltered ?page= in the URL on mount (facet present, no selection)", () => {
    // The facet sidebar is present (hasFacet), but the user arrived unfiltered
    // on page 3. The reflect effect used to unconditionally delete `page`.
    window.history.replaceState(null, "", "/departments/medicine?page=3");
    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140", page: 3 });
    expect(window.location.search).toContain("page=3");
  });

  it("does NOT invent a ?page= when the unfiltered SSR page is 1", () => {
    window.history.replaceState(null, "", "/departments/medicine");
    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140", page: 1 });
    expect(window.location.search).not.toContain("page=");
  });
});

describe("DepartmentFacultyClient — filter fetch failure is not an empty result (#review-0707)", () => {
  it("shows a retryable error, not 'No scholars match', when the members fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("500"));
    vi.stubGlobal("fetch", fetchMock);

    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140" });
    fireEvent.click(screen.getByText("Deep learning"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
    expect(screen.queryByText("No scholars match these filters.")).toBeNull();
  });

  it("retry re-issues the members fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ hits: [hit("flt00001")], total: 1 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140" });
    fireEvent.click(screen.getByText("Deep learning"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("FLT00001")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
