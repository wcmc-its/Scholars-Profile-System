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
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/components/department/person-row", () => ({
  PersonRow: ({
    hit,
    meshChips,
  }: {
    hit: { cwid: string; preferredName: string };
    meshChips?: Array<{ label: string }>;
  }) => (
    <div
      data-testid="person"
      data-cwid={hit.cwid}
      data-mesh={(meshChips ?? []).map((c) => c.label).join("|")}
    >
      {hit.preferredName}
    </div>
  ),
}));
// shadcn Select uses Radix portals/pointer APIs jsdom lacks; stub to a
// passthrough whose items are buttons that fire the Select's onValueChange.
vi.mock("@/components/ui/select", () => {
  let onChange: ((v: string) => void) | undefined;
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (v: string) => void;
    }) => {
      onChange = onValueChange;
      return <div data-testid="select" data-value={value}>{children}</div>;
    },
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
      <button type="button" data-select-item={value} onClick={() => onChange?.(value)}>
        {children}
      </button>
    ),
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: () => <span />,
  };
});

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

describe("DepartmentFacultyClient — Division facet (Unit Page v2)", () => {
  const DIVS = [
    { value: "D1", label: "Cardiology", count: 40 },
    { value: "D2", label: "Nephrology", count: 12 },
  ];

  it("is absent when the filter route is dark (methodFacet undefined)", () => {
    renderClient({ divisionFacet: DIVS, unitKind: "department", unitCode: "N1140" });
    expect(screen.queryByRole("heading", { name: "Division" })).toBeNull();
  });

  it("renders above Methods & tools and fetches ?div= on select", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hits: [hit("div00001")], total: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderClient({
      methodFacet: FACET,
      divisionFacet: DIVS,
      unitKind: "department",
      unitCode: "N1140",
    });
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings.indexOf("Division")).toBeLessThan(headings.indexOf("Methods & tools"));

    fireEvent.click(screen.getByRole("checkbox", { name: /^Cardiology/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain("div=D1");
    await waitFor(() => expect(screen.getByText("DIV00001")).toBeTruthy());
    expect(window.location.search).toContain("div=D1");
    vi.unstubAllGlobals();
  });

  it("offers the division facet with an empty methods list when the flag is on", () => {
    renderClient({
      methodFacet: [],
      divisionFacet: DIVS,
      unitKind: "department",
      unitCode: "N1140",
    });
    expect(screen.getByRole("heading", { name: "Division" })).toBeTruthy();
    expect(facetHeading()).toBeNull();
  });

  it("with methodFacet=[] the aside holds ONLY the Division facet", () => {
    const { container } = renderClient({
      methodFacet: [],
      divisionFacet: DIVS,
      unitKind: "department",
      unitCode: "N1140",
    });
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    const asideHeadings = within(aside as HTMLElement)
      .getAllByRole("heading")
      .map((h) => h.textContent);
    expect(asideHeadings).toEqual(["Division"]);
    expect(within(aside as HTMLElement).getAllByRole("checkbox")).toHaveLength(DIVS.length);
  });

  it("empty result shows 'Clear filters', which restores the SSR roster", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hits: [], total: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderClient({
      methodFacet: FACET,
      divisionFacet: DIVS,
      unitKind: "department",
      unitCode: "N1140",
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /^Nephrology/ }));
    await waitFor(() =>
      expect(screen.getByText(/No scholars match these filters\./)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getByText("SSR00001")).toBeTruthy());
    vi.unstubAllGlobals();
  });
});

describe("DepartmentFacultyClient — roster toolbar (Unit Page v2)", () => {
  const okFetch = (hits = [hit("srt00001")], total = 1) =>
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hits, total, page: 0, pageSize: 20 }),
    });
  const unit = { unitKind: "department" as const, unitCode: "N1140" };

  afterEach(() => vi.unstubAllGlobals());

  it("renders the mock's filter input and sort options, no request by default", () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderClient(unit);
    const box = within(container);
    const input = box.getByRole("searchbox", { name: "Filter scholars by name or title" });
    expect(input.getAttribute("placeholder")).toBe("Filter by name or title");
    expect(
      box.getAllByRole("button").filter((b) => b.hasAttribute("data-select-item")).map((b) => b.textContent),
    ).toEqual(["Last name A–Z", "Most publications", "Most grants"]);
    expect(box.getByTestId("select").getAttribute("data-value")).toBe("last");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("works without the facet flag: 'Most grants' fetches ?sort=grants from page 1", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderClient({ ...unit, page: 3, total: 90 });
    fireEvent.click(within(container).getByRole("button", { name: "Most grants" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/units/department/N1140/members?");
    expect(url).toContain("sort=grants");
    expect(url).toContain("page=0");
    await waitFor(() => expect(within(container).getByText("SRT00001")).toBeTruthy());
    expect(window.location.search).toContain("sort=grants");
  });

  it("debounces typing into ?q= and reflects it in the URL", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderClient(unit);
    const input = within(container).getByRole("searchbox");
    fireEvent.change(input, { target: { value: "  Ann " } });
    // Nothing fires synchronously — the query waits out the debounce.
    expect(fetchMock).not.toHaveBeenCalled();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain("q=Ann");
    expect(fetchMock.mock.calls[0][0]).not.toContain("sort=");
    await waitFor(() => expect(window.location.search).toContain("q=Ann"));
  });

  it("seeds ?q= from the URL on mount (sort arrives as initialSort)", async () => {
    window.history.replaceState(null, "", "/departments/medicine?sort=pubs&q=lee");
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderClient({ ...unit, initialSort: "pubs" });
    expect((within(container).getByRole("searchbox") as HTMLInputElement).value).toBe("lee");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("q=lee");
    expect(url).toContain("sort=pubs");
  });

  it("an SSR page already ranked by ?sort= renders without a fetch; pagination hrefs carry sort", () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderClient({ ...unit, initialSort: "pubs", total: 45 });
    expect(fetchMock).not.toHaveBeenCalled();
    const pageLinks = Array.from(container.querySelectorAll("a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(pageLinks).toContain("/departments/medicine?page=2&sort=pubs");
  });

  it("'Clear filters' in the empty state also clears the name filter", async () => {
    const fetchMock = okFetch([], 0);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderClient(unit);
    const input = within(container).getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzz" } });
    await waitFor(() =>
      expect(within(container).getByText(/No scholars match these filters\./)).toBeTruthy(),
    );
    fireEvent.click(within(container).getByRole("button", { name: "Clear filters" }));
    expect(input.value).toBe("");
    await waitFor(() => expect(within(container).getByText("SSR00001")).toBeTruthy());
    expect(window.location.search).not.toContain("q=");
  });
});

describe("DepartmentFacultyClient — TOPICS (MeSH) chips, Unit Page v2", () => {
  const meshAttr = (container: HTMLElement, cwid: string) =>
    within(container)
      .getAllByTestId("person")
      .find((el) => el.getAttribute("data-cwid") === cwid)
      ?.getAttribute("data-mesh");

  it("passes SSR `topMesh` to the row, and the filtered fetch's `topMesh` after a facet select", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: [{ ...hit("flt00001"), topMesh: [{ ui: "D000002", label: "Beta" }] }],
          total: 1,
          page: 0,
          pageSize: 20,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderClient({
      faculty: [{ ...hit("ssr00001"), topMesh: [{ ui: "D000001", label: "Alpha" }] }],
      total: 1,
      methodFacet: FACET,
      unitKind: "department",
      unitCode: "N1140",
    });
    expect(meshAttr(container, "ssr00001")).toBe("Alpha");

    fireEvent.click(within(container).getByText("Deep learning"));
    await waitFor(() => expect(meshAttr(container, "flt00001")).toBe("Beta"));
  });
});
