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

import { campusSwitch } from "@/app/edit/orcid-coverage/filter-bar";
import EditOrcidCoveragePage from "@/app/edit/orcid-coverage/page";
import {
  buildOrcidCoverage,
  openAuthorshipImpact,
  parseOrcidCoverageParams,
  type ScholarRow,
} from "@/lib/edit/orcid-coverage";

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
    expect(tiles).toContain("2 of 4 asserted (1 confirmed here, 1 unconfirmed, from Identity)");
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
      sources: { rpmStrong: 0, rpmWeak: 0, registryEmail: 0, registryWorks: 0, registryCrossref: 0, registryWeak: 0 },
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

describe("/edit/orcid-coverage — campus", () => {
  const row = (cwid: string, roleCategory: string, primaryDepartment: string, campus: string, held = false) => ({
    cwid,
    roleCategory,
    primaryDepartment,
    campus,
    orcid: held ? `0000-0000-0000-${cwid}` : null,
    orcidConfirmedAt: held ? new Date("2026-09-20T00:00:00Z") : null,
  });
  const WCM = [
    row("f1", "full_time_faculty", "Dept A", "wcm", true),
    row("f2", "full_time_faculty", "Dept A", "wcm"),
    row("p1", "postdoc", "Dept B", "wcm"),
  ];
  const ITHACA = [
    row("g1", "ithaca_student_grad", "Physics", "ithaca"),
    row("g2", "ithaca_student_grad", "Physics", "ithaca"),
    row("i1", "ithaca_faculty", "Physics", "ithaca", true),
    row("r1", "ithaca_rte_faculty", "Dept A", "ithaca"),
  ];
  const headerTexts = (page: ReturnType<typeof within>, testId: string) =>
    [...page.getByTestId(testId).querySelectorAll("thead th")].map((th) => th.textContent);
  const bodyRows = (page: ReturnType<typeof within>, testId: string) =>
    [...page.getByTestId(testId).querySelectorAll("tbody tr")].map((tr) =>
      [...tr.children].map((c) => c.textContent),
    );

  beforeEach(() => {
    // The loader's population rule, on the fixture.
    h.mockLoad.mockImplementation(
      async (_db: unknown, params: ReturnType<typeof parseOrcidCoverageParams>) =>
        buildOrcidCoverage(
          params.campus === "all" ? [...WCM, ...ITHACA] : params.campus === "ithaca" ? ITHACA : WCM,
          [{ cwid: "f2", latestEnd: new Date("2027-01-01T00:00:00Z"), pi: true }],
          [],
          params,
          TODAY,
        ),
    );
  });

  it("an unknown campus is the WCM page: same tiles, columns, facets and CSV link", async () => {
    const plain = render(await EditOrcidCoveragePage({ searchParams: sp({ nih: "all" }) }));
    const plainHtml = plain.getByTestId("orcid-coverage-page").innerHTML;
    plain.unmount();
    const { getByTestId } = render(
      await EditOrcidCoveragePage({ searchParams: sp({ nih: "all", campus: "mars" }) }),
    );
    expect(h.mockLoad).toHaveBeenLastCalledWith({}, { types: [], units: [], nih: "all" });
    expect(getByTestId("orcid-coverage-page").innerHTML).toBe(plainHtml);
    const page = within(getByTestId("orcid-coverage-page"));
    expect(page.getByTestId("orcid-coverage-download").getAttribute("href")).toBe(
      "/edit/orcid-coverage/export?nih=all",
    );
    expect(page.queryByTestId("orcid-coverage-tiles-ithaca")).toBeNull();
    expect(headerTexts(page, "orcid-coverage-by-dept")).not.toContain("Campus");
  });

  it("Cornell Ithaca: two tiles, the six-role order, no eRA / NIH columns or filters", async () => {
    const { getByTestId } = render(
      await EditOrcidCoveragePage({ searchParams: sp({ campus: "ithaca", nih: "ever" }) }),
    );
    // `nih` is a WCM concept: dropped, not applied.
    expect(h.mockLoad).toHaveBeenCalledWith({}, { types: [], units: [], nih: "all", campus: "ithaca" });
    const page = within(getByTestId("orcid-coverage-page"));
    const tiles = page.getByTestId("orcid-coverage-tiles").textContent!;
    expect(tiles).toContain("All Cornell Ithaca people");
    expect(tiles).toContain("Cornell Ithaca faculty");
    expect(tiles).not.toMatch(/NIH|Identity/);
    expect(tiles).toContain("1 of 4 asserted (1 confirmed here, 0 unconfirmed)");
    expect(bodyRows(page, "orcid-coverage-by-role").map((r) => r[0])).toEqual([
      "Cornell Ithaca faculty",
      "Cornell Ithaca RTE faculty",
      "Cornell Ithaca grad student",
    ]);
    expect(headerTexts(page, "orcid-coverage-by-dept")).toEqual([
      "Department",
      "People ↓",
      "Coverage",
      "Asserted",
    ]);
    expect(bodyRows(page, "orcid-coverage-by-dept").map((r) => r[0])).toEqual(["Physics", "Dept A"]);
    const all = page.getByTestId("orcid-coverage-columns-all");
    expect(all.textContent).toBe("All 6");
    fireEvent.click(all);
    expect(headerTexts(page, "orcid-coverage-by-role")).toEqual([
      "Person type",
      "People",
      "Asserted",
      "Confirmed",
      "Asserted %",
      "Inferred, strong",
      "Inferred, weak",
    ]);
    expect(
      page.getByTestId("orcid-coverage-by-dept").querySelector("caption")?.textContent,
    ).toBe("All person types, sorted by people.");
    // Only the campus and person-type facets; the campus chip removes back to WCM.
    for (const k of ["nih", "dept", "center", "inst"]) {
      expect(page.queryByTestId(`orcid-coverage-filter-${k}`)).toBeNull();
    }
    expect(page.getByTestId("orcid-coverage-filter-campus").textContent).toBe(
      "Campus:Cornell Ithaca",
    );
    expect(page.getByTestId("orcid-coverage-download").getAttribute("href")).toBe(
      "/edit/orcid-coverage/export?nih=all&campus=ithaca",
    );
    fireEvent.click(page.getByLabelText("Remove Campus: Cornell Ithaca"));
    expect(h.mockReplace).toHaveBeenLastCalledWith("/edit/orcid-coverage?nih=all", {
      scroll: false,
    });
  });

  it("both: tile groups side by side, person types under a campus heading with a subtotal, a Campus column", async () => {
    const { getByTestId } = render(
      await EditOrcidCoveragePage({
        searchParams: Promise.resolve({ campus: "all", type: ["full_time_faculty", "ithaca_faculty"] }),
      }),
    );
    expect(h.mockLoad).toHaveBeenCalledWith(
      {},
      { types: ["full_time_faculty", "ithaca_faculty"], units: [], nih: "all", campus: "all" },
    );
    const page = within(getByTestId("orcid-coverage-page"));
    const wcm = page.getByTestId("orcid-coverage-tiles-wcm").textContent!;
    const ithaca = page.getByTestId("orcid-coverage-tiles-ithaca").textContent!;
    expect(wcm).toMatch(/^Weill Cornell MedicineAll active people.*Full-time faculty.*NIH-funded full-time faculty/);
    expect(wcm).toContain("1 of 3 asserted (1 confirmed here, 0 unconfirmed, from Identity)");
    expect(ithaca).toMatch(/^Cornell IthacaAll Cornell Ithaca people.*Cornell Ithaca faculty/);
    expect(ithaca).not.toMatch(/NIH/);
    expect(ithaca).toContain("1 of 4 asserted (1 confirmed here, 0 unconfirmed)");
    // Stacks on a phone: one column until `md`.
    expect(page.getByTestId("orcid-coverage-tiles").className).toContain("md:grid-cols-2");

    // Summary columns: name, People, Coverage, Asserted, NIH-funded, NIH-funded no ORCID, NIH PI no eRA.
    expect(
      bodyRows(page, "orcid-coverage-by-role").map((r) => [r[0], r[1], r[4]].filter((c) => c !== undefined)),
    ).toEqual([
      ["Weill Cornell Medicine"],
      ["Full-time faculty", "2", "1"],
      ["Postdoc", "1", "0"],
      ["Weill Cornell Medicine subtotal", "3", "1"],
      ["Cornell Ithaca"],
      ["Cornell Ithaca faculty", "1", "—"],
      ["Cornell Ithaca RTE faculty", "1", "—"],
      ["Cornell Ithaca grad student", "2", "—"],
      ["Cornell Ithaca subtotal", "4", "—"],
    ]);
    // One row group per campus, headed by a row-group header (not a column header).
    const groups = [...page.getByTestId("orcid-coverage-by-role").querySelectorAll("tbody")];
    expect(groups.map((g) => g.querySelector("tr:first-child > th")?.textContent)).toEqual([
      "Weill Cornell Medicine",
      "Cornell Ithaca",
    ]);
    for (const g of groups) {
      expect(g.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(1);
      expect(g.querySelector("tr:last-child")?.textContent).toMatch(/ subtotal/);
    }
    expect(
      page.getByTestId("orcid-coverage-by-role").querySelector('th[scope="colgroup"]'),
    ).toBeNull();
    expect(page.getByTestId("orcid-coverage-by-dept").querySelectorAll("tbody")).toHaveLength(1);
    expect(headerTexts(page, "orcid-coverage-by-role")).not.toContain("Campus");
    expect(headerTexts(page, "orcid-coverage-by-dept").slice(0, 3)).toEqual([
      "Department",
      "Campus",
      "People ↓",
    ]);
    // `type` is literal on each campus: WCM full-time faculty + Ithaca faculty.
    expect(bodyRows(page, "orcid-coverage-by-dept").map((r) => r.slice(0, 3))).toEqual([
      ["Dept A", "Weill Cornell Medicine", "2"],
      ["Physics", "Cornell Ithaca", "1"],
    ]);
    fireEvent.click(within(page.getByTestId("orcid-coverage-by-dept")).getByText("Campus"));
    expect(bodyRows(page, "orcid-coverage-by-dept").map((r) => r[1])).toEqual([
      "Cornell Ithaca",
      "Weill Cornell Medicine",
    ]);
    expect(
      page.getByTestId("orcid-coverage-by-dept").querySelector("caption")?.textContent,
    ).toBe("Full-time faculty or Cornell Ithaca faculty, sorted by people.");
    expect(page.getByTestId("orcid-coverage-filter-campus").textContent).toBe("Campus:Both");
    expect(page.getByTestId("orcid-coverage-filter-nih")).toBeTruthy();
    expect(page.getByTestId("orcid-coverage-download").getAttribute("href")).toBe(
      "/edit/orcid-coverage/export?type=full_time_faculty&type=ithaca_faculty&nih=all&campus=all",
    );
    expect(getByTestId("orcid-coverage-page").textContent).not.toMatch(/\bf1\b|\bi1\b|0000-0000/);
  });

  it("Campus → Both from the bare landing page drops the default person type, so both campuses' departments list", async () => {
    const { getByTestId, baseElement } = render(
      await EditOrcidCoveragePage({ searchParams: sp() }),
    );
    // The bare visit: full-time faculty in the department table.
    expect(h.mockLoad).toHaveBeenLastCalledWith(
      {},
      { types: ["full_time_faculty"], units: [], nih: "all" },
    );
    fireEvent.click(
      within(getByTestId("orcid-coverage-page")).getByTestId("orcid-coverage-filter-campus"),
    );
    fireEvent.click(within(baseElement).getByRole("radio", { name: "Both" }));
    expect(h.mockReplace).toHaveBeenLastCalledWith("/edit/orcid-coverage?nih=all&campus=all", {
      scroll: false,
    });
    // That URL is what a hand-typed ?campus=all parses to, and it lists Ithaca departments.
    const viaBar = parseOrcidCoverageParams(new URLSearchParams("nih=all&campus=all"));
    expect(viaBar).toEqual(parseOrcidCoverageParams({ campus: "all" }));
    const depts = buildOrcidCoverage([...WCM, ...ITHACA], [], [], viaBar, TODAY).byDept;
    expect(new Set(depts.map((d) => d.campus))).toEqual(new Set(["wcm", "ithaca"]));
  });

  it("campusSwitch: Both starts with no person type; unit and NIH stay (WCM half); one campus keeps its own types", () => {
    const sel = {
      nih: "ever" as const,
      units: ["dept:AA1"],
      types: ["full_time_faculty", "ithaca_postdoc"],
    };
    expect(campusSwitch(sel, "all")).toEqual({ ...sel, types: [], campus: "all" });
    expect(campusSwitch({ ...sel, campus: "ithaca" }, "all").types).toEqual([]);
    // Already on Both: a deliberate selection there is kept.
    const onBoth = { ...sel, campus: "all" as const };
    expect(campusSwitch(onBoth, "all")).toBe(onBoth);
    expect(campusSwitch(onBoth, "ithaca")).toEqual({
      nih: "all",
      units: [],
      types: ["ithaca_postdoc"],
      campus: "ithaca",
    });
    expect(campusSwitch(onBoth, "wcm")).toEqual({
      ...sel,
      types: ["full_time_faculty"],
      campus: "wcm",
    });
  });

  it("both + a WCM-only filter: the captions say it narrows WCM only", async () => {
    const { getByTestId } = render(
      await EditOrcidCoveragePage({ searchParams: sp({ campus: "all", nih: "ever" }) }),
    );
    const page = within(getByTestId("orcid-coverage-page"));
    expect(page.getByTestId("orcid-coverage-by-role").querySelector("caption")?.textContent).toBe(
      "Every person type · NIH-funded (any award on file), by campus. Unit and NIH funding filters narrow Weill Cornell Medicine only.",
    );
    // f2 is the one NIH-funded WCM person; every Ithaca row stays.
    expect(
      bodyRows(page, "orcid-coverage-by-role")
        .filter((r) => /subtotal/.test(r[0] ?? ""))
        .map((r) => [r[0], r[1]]),
    ).toEqual([
      ["Weill Cornell Medicine subtotal", "1"],
      ["Cornell Ithaca subtotal", "4"],
    ]);
  });
});

/** Open authorship rows waiting on an ORCID confirmation: one tile, one column in
 *  each table, a definition; all absent when the fold has no fresh counts. */
describe("/edit/orcid-coverage — open authorship rows waiting", () => {
  const A = "0000-0002-1825-0097";
  const B = "0000-0001-0000-000X";
  const C = "0000-0001-0000-0003";
  const person = (
    cwid: string,
    roleCategory: string,
    primaryDepartment: string,
    orcid: string | null = null,
    confirmed = false,
    campus?: string,
  ): ScholarRow => ({
    cwid,
    roleCategory,
    primaryDepartment,
    orcid,
    orcidConfirmedAt: confirmed ? new Date("2026-09-20T00:00:00Z") : null,
    ...(campus ? { campus } : {}),
  });
  const WCM = [
    person("f1", "full_time_faculty", "Dept A", A, true), // confirmed: 0
    person("f2", "full_time_faculty", "Dept A", C), // unconfirmed: 12
    person("p1", "postdoc", "Dept B"), // candidate B: 1,300
  ];
  const ITHACA = [person("n1", "ithaca_faculty", "Physics", null, false, "ithaca")]; // candidate B too
  const cand = (cwid: string) => ({
    cwid,
    orcid: B,
    source: "orcid_email",
    articlesAccepted: 0,
    articlesRejected: 0,
  });
  const REFRESHED = new Date("2026-11-17T15:00:00Z");
  const NOW = new Date("2026-11-18T12:00:00Z");
  const withRows = (refreshedAt: Date | null) => {
    const impact =
      refreshedAt === null
        ? null
        : openAuthorshipImpact(
            [
              // f1 confirmed A: its rows wait on nobody.
              { orcid: A, openRows: 40, refreshedAt },
              { orcid: C, openRows: 12, refreshedAt },
              { orcid: B, openRows: 1300, refreshedAt },
            ],
            NOW,
          );
    h.mockLoad.mockImplementation(
      async (_db: unknown, params: ReturnType<typeof parseOrcidCoverageParams>) =>
        buildOrcidCoverage(
          params.campus === "all" ? [...WCM, ...ITHACA] : params.campus === "ithaca" ? ITHACA : WCM,
          [],
          [],
          params,
          TODAY,
          [cand("p1"), cand("n1")],
          [],
          null,
          impact,
        ),
    );
  };
  const headers = (page: ReturnType<typeof within>, testId: string) =>
    [...page.getByTestId(testId).querySelectorAll("thead th")].map((th) => th.textContent);
  const lastCells = (page: ReturnType<typeof within>, testId: string) =>
    [...page.getByTestId(testId).querySelectorAll("tbody tr")].map((tr) => [
      tr.firstElementChild?.textContent,
      tr.lastElementChild?.textContent,
    ]);

  it("with fresh counts: the tile, the definition, and a last column in both tables", async () => {
    withRows(REFRESHED);
    const { getByTestId } = render(
      await EditOrcidCoveragePage({ searchParams: sp({ nih: "all" }) }),
    );
    const page = within(getByTestId("orcid-coverage-page"));
    const tile = page.getByTestId("orcid-coverage-waiting").textContent;
    expect(tile).toContain("Open authorship rows waiting on an ORCID confirmation");
    expect(tile).toContain("1,312rows across 2 people");
    expect(tile).toContain("Every person type.");
    expect(tile).toContain("as of Nov 17, 2026");
    // Inside the tile grid, after the three WCM tiles.
    expect(page.getByTestId("orcid-coverage-tiles").lastElementChild).toBe(
      page.getByTestId("orcid-coverage-waiting"),
    );
    expect(headers(page, "orcid-coverage-by-role").at(-1)).toBe("Open rows waiting");
    expect(headers(page, "orcid-coverage-by-dept").at(-1)).toBe("Open rows waiting");
    expect(lastCells(page, "orcid-coverage-by-role")).toEqual([
      ["Full-time faculty", "12"],
      ["Postdoc", "1,300"],
    ]);
    // The loader's order (people desc here) until the column is clicked.
    expect(lastCells(page, "orcid-coverage-by-dept")).toEqual([
      ["Dept A", "12"],
      ["Dept B", "1,300"],
    ]);
    // The column is sortable like the others, and is in the full set too.
    fireEvent.click(
      within(page.getByTestId("orcid-coverage-by-dept")).getByText("Open rows waiting"),
    );
    expect(lastCells(page, "orcid-coverage-by-dept")[0]).toEqual(["Dept B", "1,300"]);
    const cell = page.getByTestId("orcid-coverage-by-dept").querySelector("tbody tr td:last-child");
    expect(cell?.getAttribute("title")).toBe("1,300 open rows across 1 person");
    fireEvent.click(page.getByTestId("orcid-coverage-columns-all"));
    expect(page.getByTestId("orcid-coverage-columns-all").textContent).toBe("All 15");
    expect(headers(page, "orcid-coverage-by-role").at(-1)).toBe("Open rows waiting");
    expect(getByTestId("orcid-coverage-page").textContent).toContain(
      "A person whose iD is already confirmed counts zero.",
    );
    expect(getByTestId("orcid-coverage-page").textContent).toContain(
      "Each row is counted once in a line and once in a total, even when two people hold its iD",
    );
  });

  it("empty or stale table: no tile, no column, no definition; the page is what it is without the feature", async () => {
    withRows(null);
    const none = render(await EditOrcidCoveragePage({ searchParams: sp({ nih: "all" }) }));
    const html = none.getByTestId("orcid-coverage-page").innerHTML;
    const page = within(none.getByTestId("orcid-coverage-page"));
    expect(page.queryByTestId("orcid-coverage-waiting")).toBeNull();
    expect(headers(page, "orcid-coverage-by-role")).not.toContain("Open rows waiting");
    expect(headers(page, "orcid-coverage-by-dept")).not.toContain("Open rows waiting");
    expect(html).not.toContain("Open authorship rows");
    expect(page.getByTestId("orcid-coverage-columns-all").textContent).toBe("All 14");
    none.unmount();

    // 49 hours old at NOW: `openAuthorshipImpact` gives the fold nothing.
    withRows(new Date("2026-11-16T11:00:00Z"));
    const stale = render(await EditOrcidCoveragePage({ searchParams: sp({ nih: "all" }) }));
    expect(stale.getByTestId("orcid-coverage-page").innerHTML).toBe(html);
  });

  it("follows the campus: Cornell Ithaca alone, and a tile per campus side by side", async () => {
    withRows(REFRESHED);
    const one = render(await EditOrcidCoveragePage({ searchParams: sp({ campus: "ithaca" }) }));
    const ithaca = within(one.getByTestId("orcid-coverage-page"));
    expect(ithaca.getByTestId("orcid-coverage-waiting").textContent).toContain(
      "1,300rows across 1 person",
    );
    expect(headers(ithaca, "orcid-coverage-by-dept")).toEqual([
      "Department",
      "People ↓",
      "Coverage",
      "Asserted",
      "Open rows waiting",
    ]);
    one.unmount();

    const { getByTestId } = render(
      await EditOrcidCoveragePage({ searchParams: sp({ campus: "all", nih: "all" }) }),
    );
    const page = within(getByTestId("orcid-coverage-page"));
    expect(page.queryByTestId("orcid-coverage-waiting")).toBeNull();
    expect(page.getByTestId("orcid-coverage-waiting-wcm").textContent).toContain(
      "1,312rows across 2 people",
    );
    expect(page.getByTestId("orcid-coverage-waiting-ithaca").textContent).toContain(
      "1,300rows across 1 person",
    );
    expect(
      within(page.getByTestId("orcid-coverage-tiles-ithaca")).getByTestId(
        "orcid-coverage-waiting-ithaca",
      ),
    ).toBeTruthy();
    expect(headers(page, "orcid-coverage-by-dept").slice(0, 2)).toEqual(["Department", "Campus"]);
    expect(headers(page, "orcid-coverage-by-dept").at(-1)).toBe("Open rows waiting");
    // The Cornell Ithaca row shows its count, not the "—" of a WCM-only column.
    const physics = lastCells(page, "orcid-coverage-by-dept").find(
      ([label]) => label === "Physics",
    );
    expect(physics).toEqual(["Physics", "1,300"]);
    // Subtotal rows carry each campus's total.
    expect(lastCells(page, "orcid-coverage-by-role")).toContainEqual([
      "Weill Cornell Medicine subtotal",
      "1,312",
    ]);
    expect(lastCells(page, "orcid-coverage-by-role")).toContainEqual([
      "Cornell Ithaca subtotal",
      "1,300",
    ]);
  });

  it("the tile's scope names the unit and NIH filters it follows", async () => {
    withRows(REFRESHED);
    const { getByTestId } = render(
      await EditOrcidCoveragePage({ searchParams: sp({ unit: "dept:AA1", nih: "none" }) }),
    );
    expect(
      within(getByTestId("orcid-coverage-page")).getByTestId("orcid-coverage-waiting").textContent,
    ).toContain("Every person type in Dept A · No NIH award on file.");
  });
});
