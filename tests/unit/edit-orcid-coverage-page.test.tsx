/**
 * `app/edit/orcid-coverage/page.tsx` — gate (`canViewUsage`, like `/edit/usage`)
 * and a render scoped to the page root, not `document.body`.
 */
import { fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockCanViewUsage: vi.fn(),
  mockLoad: vi.fn(),
  mockFacets: vi.fn(),
  mockReplace: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: h.mockRedirect,
  notFound: vi.fn(),
  useRouter: () => ({ replace: h.mockReplace }),
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.mockGetEditSession }));
vi.mock("@/lib/edit/usage-access", () => ({ canViewUsage: h.mockCanViewUsage }));
vi.mock("@/lib/edit/orcid-coverage", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/edit/orcid-coverage")>()),
  loadOrcidCoverage: h.mockLoad,
}));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({
  ForbiddenEditPage: () => <div data-testid="forbidden" />,
}));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn(),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn(),
}));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/lib/api/data-quality", () => ({ loadDataQualityFacets: h.mockFacets }));

import EditOrcidCoveragePage from "@/app/edit/orcid-coverage/page";
import { buildOrcidCoverage, parseOrcidCoverageParams } from "@/lib/edit/orcid-coverage";

const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const TODAY = new Date("2026-09-18T00:00:00Z");

const FACETS = {
  roleCategories: [
    { value: "full_time_faculty", label: "Full-time faculty", count: 3 },
    { value: "postdoc", label: "Postdoc", count: 1 },
  ],
  departments: [
    {
      value: "dept:AA1",
      label: "Dept A",
      count: 3,
      divisions: [{ value: "div:AA2", label: "Div X (Dept A)", count: 1 }],
    },
  ],
  centers: [{ value: "center:CC1", label: "Center Q", count: 2 }],
  institutions: [{ value: "inst:II1", label: "Inst Z", count: 4 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.mockFacets.mockResolvedValue(FACETS);
  h.mockGetEditSession.mockResolvedValue(ADMIN);
  h.mockCanViewUsage.mockResolvedValue(true);
  h.mockLoad.mockImplementation(
    async (_db: unknown, params: ReturnType<typeof parseOrcidCoverageParams>) =>
      buildOrcidCoverage(
        [
          {
            cwid: "f1",
            roleCategory: "full_time_faculty",
            primaryDepartment: "Dept A",
            orcid: "0000-0002-1825-0097",
            orcidConfirmedAt: new Date("2026-09-20T00:00:00Z"),
          },
          {
            cwid: "f2",
            roleCategory: "full_time_faculty",
            primaryDepartment: "Dept A",
            orcid: null,
            orcidConfirmedAt: null,
          },
          {
            // An iD from Identity / RPM admin: asserted, NOT confirmed here.
            cwid: "f3",
            roleCategory: "full_time_faculty",
            primaryDepartment: "Dept A",
            orcid: "0000-0000-0000-001X",
            orcidConfirmedAt: null,
          },
          {
            cwid: "p1",
            roleCategory: "postdoc",
            primaryDepartment: "Dept B",
            orcid: null,
            orcidConfirmedAt: null,
          },
        ],
        [
          { cwid: "f1", latestEnd: new Date("2027-01-01T00:00:00Z"), pi: false },
          { cwid: "f2", latestEnd: new Date("2027-01-01T00:00:00Z"), pi: true },
          { cwid: "f3", latestEnd: new Date("2027-01-01T00:00:00Z"), pi: false },
        ],
        ["f2"],
        params,
        TODAY,
        [
          {
            cwid: "p1",
            orcid: "iD-a",
            source: "rpm_inferred",
            articlesAccepted: 5,
            articlesRejected: 0,
          },
        ],
      ),
  );
});

describe("/edit/orcid-coverage", () => {
  it("signed-out → SAML redirect", async () => {
    h.mockGetEditSession.mockResolvedValue(null);
    await expect(EditOrcidCoveragePage({ searchParams: sp() })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/orcid-coverage",
    );
    expect(h.mockLoad).not.toHaveBeenCalled();
  });

  it("not canViewUsage → forbidden page, no data read", async () => {
    h.mockCanViewUsage.mockResolvedValue(false);
    const { getByTestId } = render(await EditOrcidCoveragePage({ searchParams: sp() }));
    expect(getByTestId("forbidden")).toBeTruthy();
    expect(h.mockLoad).not.toHaveBeenCalled();
  });

  it("renders tiles, both tables and the filtered CSV link inside the page root", async () => {
    const { getByTestId } = render(
      await EditOrcidCoveragePage({ searchParams: sp({ nih: "ever" }) }),
    );
    const page = within(getByTestId("orcid-coverage-page"));
    expect(h.mockLoad).toHaveBeenCalledWith({}, { types: [], units: [], nih: "ever" });
    const tiles = page.getByTestId("orcid-coverage-tiles").textContent;
    expect(tiles).toContain("50.0%asserted · 75.0% with strong inference");
    // The asserted split: f1 confirmed its iD here, f3's came from Identity.
    expect(tiles).toContain("2 of 4 asserted (1 confirmed here, 1 from Identity or RPM admin)");
    expect(tiles).toContain("+1 more by strong inference");
    const byRole = within(page.getByTestId("orcid-coverage-by-role"));
    expect(byRole.getByText("Full-time faculty")).toBeTruthy();
    expect(byRole.queryByText("Postdoc")).toBeNull(); // nih=ever drops p1
    // Summary columns by default; the full set is one click away and applies
    // to BOTH tables.
    const headerTexts = (testId: string) =>
      [...page.getByTestId(testId).querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headerTexts("orcid-coverage-by-dept")).toEqual([
      "Department",
      "People",
      "Coverage",
      "Asserted",
      "NIH-funded",
      "NIH-funded, no ORCID ↓",
      "NIH PI, no eRA",
    ]);
    fireEvent.click(page.getByTestId("orcid-coverage-columns-all"));
    expect(headerTexts("orcid-coverage-by-role")).toHaveLength(15);
    const byDept = within(page.getByTestId("orcid-coverage-by-dept"));
    // Dept A under nih=ever: f1 (confirmed), f2 (none), f3 (Identity) → People 3,
    // Asserted 2, Confirmed 1, strong 0 — every column distinct, so a swapped cell shows.
    const deptA = byDept.getByText("Dept A").closest("tr")!;
    const cells = [...deptA.querySelectorAll("td")].map((td) => td.textContent);
    const headers = [
      ...page.getByTestId("orcid-coverage-by-dept").querySelectorAll("thead th"),
    ].map((th) => th.textContent);
    const cell = (h: string) => cells[headers.indexOf(h)];
    expect(cell("People")).toBe("3");
    expect(cell("Asserted")).toBe("2");
    expect(cell("Confirmed")).toBe("1");
    expect(cell("Inferred, strong")).toBe("0");
    expect(page.getByTestId("orcid-coverage-download").getAttribute("href")).toBe(
      "/edit/orcid-coverage/export?nih=ever",
    );
    const bar = page.getByTestId("orcid-coverage-filters");
    expect(within(bar).getByTestId("orcid-coverage-filter-nih").textContent).toBe(
      "NIH funding:NIH-funded (any award on file)",
    );
    // Never a per-person cell.
    expect(getByTestId("orcid-coverage-page").textContent).not.toMatch(/f1|0000-0002/);
    // The weak definition must match the fold: a second candidate demotes only when it is
    // itself strong-eligible (orcidTiers r6), so the copy must not say "several candidates".
    // The definitions sit behind "How we count", closed by default but in the DOM.
    const defs = page.getByTestId("orcid-coverage-definitions");
    expect(defs.hasAttribute("hidden")).toBe(true);
    fireEvent.click(page.getByTestId("orcid-coverage-how-we-count"));
    expect(defs.hasAttribute("hidden")).toBe(false);
    expect(defs.textContent).toContain(
      "No single strong candidate: a name-only registry match, thin support, a contradiction, or two or more strong candidate iDs.",
    );
    expect(getByTestId("orcid-coverage-page").textContent).not.toContain("several candidate");
  });

  it("names where inferences come from, with people per rule", async () => {
    const { getByTestId } = render(await EditOrcidCoveragePage({ searchParams: sp() }));
    const sources = within(getByTestId("orcid-coverage-page")).getByTestId(
      "orcid-coverage-sources",
    );
    const cards = within(sources).getAllByTestId("orcid-coverage-source");
    expect(cards).toHaveLength(2);
    // The fixture's one candidate: p1, rpm_inferred with 5 accepted, 0 rejected → strong.
    const rpmRows = [...cards[0].querySelectorAll(".grid")].map((r) => r.textContent);
    expect(rpmRows[0]).toMatch(/^rpm_inferred.*Strong1people$/);
    expect(rpmRows[1]).toMatch(/^rpm_inferred.*Weak0people$/);
  });

  it("pins full-time faculty first, and the department table filters, sorts and folds", async () => {
    const depts = Array.from({ length: 17 }, (_, i) => ({
      key: `D${i}`,
      label: `Dept ${String(i).padStart(2, "0")}`,
      people: 20 - i,
      orcid: 0,
      confirmed: 0,
      strong: 0,
      weak: 0,
      era: 0,
      both: 0,
      nihPeople: i,
      nihOrcid: 0,
      nihStrong: 0,
      nihPi: 0,
      nihPiEra: 0,
    }));
    const role = (key: string, label: string, people: number) => ({
      ...depts[0],
      key,
      label,
      people,
    });
    h.mockLoad.mockResolvedValue({
      params: { types: [], units: [], nih: "all" },
      tiles: { overall: depts[0], fullTime: depts[0], nihFullTime: depts[0] },
      byRole: [
        role("affiliated", "Affiliated faculty", 50),
        role("full_time_faculty", "Full-time faculty", 9),
      ],
      // Loader order: outreach (NIH-funded without ORCID) desc.
      byDept: [...depts].reverse(),
      sources: { rpmStrong: 0, rpmWeak: 0, registryEmail: 0, registryWorks: 0, registryWeak: 0 },
    });
    const { getByTestId } = render(await EditOrcidCoveragePage({ searchParams: sp() }));
    const page = within(getByTestId("orcid-coverage-page"));
    const firstCells = (testId: string) =>
      [...page.getByTestId(testId).querySelectorAll("tbody tr")].map(
        (tr) => tr.querySelector("td")?.textContent,
      );
    expect(firstCells("orcid-coverage-by-role")).toEqual([
      "Full-time faculty",
      "Affiliated faculty",
    ]);
    // Top 15 of 17 in the loader's order, then the fold.
    expect(firstCells("orcid-coverage-by-dept")).toHaveLength(15);
    expect(firstCells("orcid-coverage-by-dept")[0]).toBe("Dept 16");
    const more = page.getByTestId("orcid-coverage-dept-more");
    expect(more.textContent).toBe("Show all 17");
    fireEvent.click(more);
    expect(firstCells("orcid-coverage-by-dept")).toHaveLength(17);
    // Click a header to re-sort: Department ascending.
    fireEvent.click(within(page.getByTestId("orcid-coverage-by-dept")).getByText("Department"));
    expect(firstCells("orcid-coverage-by-dept")[0]).toBe("Dept 00");
    // The text filter narrows and bypasses the fold.
    fireEvent.change(page.getByTestId("orcid-coverage-dept-filter"), {
      target: { value: "dept 1" },
    });
    expect(firstCells("orcid-coverage-by-dept")).toEqual([
      "Dept 10",
      "Dept 11",
      "Dept 12",
      "Dept 13",
      "Dept 14",
      "Dept 15",
      "Dept 16",
    ]);
    fireEvent.change(page.getByTestId("orcid-coverage-dept-filter"), { target: { value: "zzz" } });
    expect(firstCells("orcid-coverage-by-dept")).toEqual(["No departments match."]);
  });

  it("type + unit selection: chips, captions name the selection, CSV link carries it", async () => {
    const { getByTestId } = render(
      await EditOrcidCoveragePage({
        searchParams: Promise.resolve({ type: "postdoc", unit: ["dept:AA1", "center:CC1"] }),
      }),
    );
    expect(h.mockLoad).toHaveBeenCalledWith(
      {},
      { types: ["postdoc"], units: ["dept:AA1", "center:CC1"], nih: "all" },
    );
    const page = within(getByTestId("orcid-coverage-page"));
    const chips = page.getByTestId("orcid-coverage-chips");
    expect([...chips.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove Person type: Postdoc",
      "Remove Department: Dept A",
      "Remove Center: Center Q",
    ]);
    expect(page.getByTestId("orcid-coverage-filter-dept").textContent).toBe("Department:Dept A");
    expect(page.getByTestId("orcid-coverage-by-role").querySelector("caption")?.textContent).toBe(
      "Every person type in Dept A or Center Q.",
    );
    expect(
      page.getByTestId("orcid-coverage-by-dept").querySelector("caption")?.textContent,
    ).toMatch(/^Postdoc in Dept A or Center Q, sorted by/);
    expect(page.getByTestId("orcid-coverage-download").getAttribute("href")).toBe(
      "/edit/orcid-coverage/export?type=postdoc&unit=dept%3AAA1&unit=center%3ACC1&nih=all",
    );
  });

  it("loader failure → unavailable notice, page root still renders", async () => {
    h.mockLoad.mockRejectedValue(new Error("boom"));
    const { getByTestId } = render(await EditOrcidCoveragePage({ searchParams: sp() }));
    const page = within(getByTestId("orcid-coverage-page"));
    expect(page.getByTestId("orcid-coverage-unavailable")).toBeTruthy();
    expect(page.queryByTestId("orcid-coverage-tiles")).toBeNull();
  });

  it("facet failure → numbers still render with the URL's filters; the panel becomes a notice", async () => {
    h.mockFacets.mockRejectedValue(new Error("facets down"));
    const { getByTestId } = render(
      await EditOrcidCoveragePage({
        searchParams: Promise.resolve({ type: "postdoc", unit: "dept:AA1", nih: "all" }),
      }),
    );
    const page = within(getByTestId("orcid-coverage-page"));
    // The selection is still applied: the loader got the URL's params.
    expect(h.mockLoad).toHaveBeenCalledWith(
      {},
      { types: ["postdoc"], units: ["dept:AA1"], nih: "all" },
    );
    expect(page.queryByTestId("orcid-coverage-unavailable")).toBeNull();
    expect(page.getByTestId("orcid-coverage-tiles")).toBeTruthy();
    expect(page.getByTestId("orcid-coverage-by-role")).toBeTruthy();
    expect(page.getByTestId("orcid-coverage-by-dept")).toBeTruthy();
    expect(page.getByTestId("orcid-coverage-filters-unavailable").textContent).toBe(
      "Filters are unavailable right now.",
    );
    expect(page.queryByTestId("orcid-coverage-filters")).toBeNull();
    // No labels without facets: captions fall back to the raw values.
    expect(
      page.getByTestId("orcid-coverage-by-dept").querySelector("caption")?.textContent,
    ).toMatch(/^Postdoc in dept:AA1, sorted by/);
    expect(page.getByTestId("orcid-coverage-download").getAttribute("href")).toBe(
      "/edit/orcid-coverage/export?type=postdoc&unit=dept%3AAA1&nih=all",
    );
  });

  it("legacy dept= → one muted notice above the tables; absent otherwise", async () => {
    const legacy = render(
      await EditOrcidCoveragePage({ searchParams: sp({ dept: "Dept A", nih: "ever" }) }),
    );
    const page = within(legacy.getByTestId("orcid-coverage-page"));
    expect(h.mockLoad).toHaveBeenCalledWith({}, { types: [], units: [], nih: "ever" });
    const note = page.getByTestId("orcid-coverage-legacy-dept");
    expect(note.textContent).toBe(
      "A department filter from an older link was ignored — pick it under Department.",
    );
    // Above the tables.
    expect(
      note.compareDocumentPosition(page.getByTestId("orcid-coverage-by-role")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    legacy.unmount();

    const plain = render(await EditOrcidCoveragePage({ searchParams: sp({ nih: "ever" }) }));
    expect(
      within(plain.getByTestId("orcid-coverage-page")).queryByTestId("orcid-coverage-legacy-dept"),
    ).toBeNull();
  });

  it("filter bar: removing a chip navigates with nih always set; Clear all resets to everyone", async () => {
    const { getByTestId } = render(
      await EditOrcidCoveragePage({
        searchParams: Promise.resolve({ type: "postdoc", unit: ["dept:AA1", "center:CC1"] }),
      }),
    );
    const page = within(getByTestId("orcid-coverage-page"));
    fireEvent.click(page.getByLabelText("Remove Person type: Postdoc"));
    // Empty type list + nih=all: "every type", not the bare-visit default.
    expect(h.mockReplace).toHaveBeenLastCalledWith(
      "/edit/orcid-coverage?unit=dept%3AAA1&unit=center%3ACC1&nih=all",
      { scroll: false },
    );
    fireEvent.click(page.getByTestId("orcid-coverage-clear-all"));
    expect(h.mockReplace).toHaveBeenLastCalledWith("/edit/orcid-coverage?nih=all", {
      scroll: false,
    });
    expect(page.queryByTestId("orcid-coverage-chips")).toBeNull();
  });

  it("the Publication Manager card carries the row-drop note", async () => {
    const { getByTestId } = render(await EditOrcidCoveragePage({ searchParams: sp() }));
    const [rpm, registry] = within(getByTestId("orcid-coverage-page")).getAllByTestId(
      "orcid-coverage-source",
    );
    expect(within(rpm).getByTestId("orcid-coverage-source-alert").textContent).toMatch(
      /^Sep 21Rows dropped from 12,553 to 7,303/,
    );
    expect(within(registry).queryByTestId("orcid-coverage-source-alert")).toBeNull();
  });
});
