/**
 * #2537 — `DepartmentFacultyClient`'s Appointment chip joins the existing
 * server-filtered fetch path (the #974 methods machinery), fixing the
 * "Showing 41–60 of 73 while 9 rows render" incoherence: the chip used to
 * filter only the already-loaded SSR page, so the header's total and the
 * pagination window disagreed with what actually rendered once a chip
 * narrowed the visible rows.
 *
 * Covered:
 *  - selecting a chip (facet present) fetches `?type=…&page=0` and the
 *    header/pagination reflect the FILTERED total, not the whole-scope one.
 *  - chip counts stay WHOLE-SCOPE while only the chip is filtering (no
 *    methods selected) — `roleCategoryCounts`/`totalCount` are NOT withheld.
 *  - `?type=X&page=2` deep link (facet present) lands on filtered page 2.
 *  - method + chip combined sends both `method=` and `type=` on one fetch.
 *  - `!hasFacet` (flag off / no method families) keeps the chip a pure
 *    client-side, page-only filter — no fetch, real-href pagination.
 * PersonRow is stubbed so the test targets the fetch/URL logic.
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
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

import { DepartmentFacultyClient } from "@/components/department/department-faculty-client";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

function hit(cwid: string, roleCategory = "Full-time faculty"): DepartmentFacultyHit {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    divisionName: null,
    departmentName: "Department of Medicine",
    identityImageEndpoint: "",
    roleCategory,
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

beforeEach(() => {
  window.history.replaceState(null, "", "/departments/medicine");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("DepartmentFacultyClient — chip joins the server-filtered fetch path (#2537)", () => {
  it("selecting a chip fetches ?type= and the header/pagination reflect the filtered total", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: Array.from({ length: 20 }, (_, i) => hit(`flt${i}`)),
          total: 26,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140", total: 73 });

    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      "/api/units/department/N1140/members?type=Full-time+faculty&page=0",
    );

    // Truthful total (26 matching rows), not the whole-scope 73 (#2537's fix).
    await waitFor(() =>
      expect(screen.getByText(/Showing 1–20 of 26 scholars/)).toBeTruthy(),
    );
    // 26 / 20 → 2 filtered pages, driven client-side (href="#").
    const page2 = screen.getByRole("link", { name: "2" });
    expect(page2.getAttribute("href")).toBe("#");
  });

  it("chip counts stay whole-scope while only the chip is filtering (no methods selected)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [hit("flt00001")], total: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderClient({
      methodFacet: FACET,
      unitKind: "department",
      unitCode: "N1140",
      total: 73,
      roleCategoryCounts: { "Full-time faculty": 41, "Doctoral students": 3 },
    });

    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Whole-scope count (41), not the 1-row filtered page.
    expect(screen.getByRole("button", { name: /Full-time faculty 41/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /All 73/ })).toBeTruthy();
  });

  it("?type=X&page=2 deep link (facet present) lands on filtered page 2", async () => {
    window.history.replaceState(
      null,
      "",
      "/departments/medicine?type=Full-time+faculty&page=2",
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [hit("p2hit01")], total: 25 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // fetchPage 2 → 0-indexed page=1 on the wire.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/units/department/N1140/members?type=Full-time+faculty&page=1",
    );
    await waitFor(() => expect(screen.getByText(/Showing 21–25 of 25 scholars/)).toBeTruthy());
  });

  it("method + chip combined sends both params on one fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [hit("combo1")], total: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderClient({ methodFacet: FACET, unitKind: "department", unitCode: "N1140" });

    fireEvent.click(screen.getByText("Deep learning"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const calledUrl = fetchMock.mock.calls[1][0] as string;
    expect(calledUrl).toContain("method=imaging_x%3A%3ADeep+learning");
    expect(calledUrl).toContain("type=Full-time+faculty");
    expect(calledUrl).toContain("page=0");
  });

  it("!hasFacet fallback: the chip stays a client-side page-only filter, no fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // No methodFacet/unitKind/unitCode → hasFacet is false.
    renderClient({ total: 2, page: 1 });
    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));

    expect(fetchMock).not.toHaveBeenCalled();
    // Pagination (when present) would still navigate via a real href, carrying
    // `type=` — covered by department-faculty-client-page-and-error.test.tsx's
    // #2528 case; this asserts the no-fetch half of the same fallback.
  });
});
