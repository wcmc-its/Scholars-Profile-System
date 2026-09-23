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
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: h.mockRedirect, notFound: vi.fn() }));
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
vi.mock("@/components/edit/auto-submit-form", () => ({
  AutoSubmitForm: ({ children, ...rest }: { children: React.ReactNode }) => (
    <form {...rest}>{children}</form>
  ),
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
    expect(page.getByTestId("orcid-coverage-tiles").textContent).toContain(
      "2 of 4 with an asserted ORCID iD",
    );
    expect(page.getByTestId("orcid-coverage-tiles").textContent).toContain(
      "+1 strong inference (75.0% incl.)",
    );
    // The asserted split: f1 confirmed its iD here, f3's came from Identity.
    expect(page.getByTestId("orcid-coverage-tiles").textContent).toContain(
      "1 confirmed here · 1 from Identity or RPM admin",
    );
    const byRole = within(page.getByTestId("orcid-coverage-by-role"));
    expect(byRole.getByText("Full-time faculty")).toBeTruthy();
    expect(byRole.queryByText("Postdoc")).toBeNull(); // nih=ever drops p1
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
    expect(cell("Asserted ORCID")).toBe("2");
    expect(cell("Confirmed")).toBe("1");
    expect(cell("Inferred, strong")).toBe("0");
    expect(page.getByTestId("orcid-coverage-download").getAttribute("href")).toBe(
      "/edit/orcid-coverage/export?nih=ever",
    );
    const form = page.getByTestId("orcid-coverage-filters") as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/edit/orcid-coverage");
    expect((form.elements.namedItem("nih") as HTMLSelectElement).value).toBe("ever");
    // The shared who-filter island sits inside the form; the old single selects are gone.
    expect(within(form).getByTestId("orcid-coverage-person-facets")).toBeTruthy();
    expect(form.elements.namedItem("role")).toBeNull();
    expect(form.elements.namedItem("dept")).toBeNull();
    // Never a per-person cell.
    expect(getByTestId("orcid-coverage-page").textContent).not.toMatch(/f1|0000-0002/);
    // The weak definition must match the fold: a second candidate demotes only when it is
    // itself strong-eligible (orcidTiers r6), so the copy must not say "several candidates".
    expect(getByTestId("orcid-coverage-page").textContent).toContain(
      "weak = no single strong candidate (a name-only registry match, thin support, a contradiction, or two or more strong candidate ORCIDs)",
    );
    expect(getByTestId("orcid-coverage-page").textContent).not.toContain("several candidate");
  });

  it("type + unit selection: hidden inputs, captions name the selection, CSV link carries it", async () => {
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
    const form = page.getByTestId("orcid-coverage-filters") as HTMLFormElement;
    const hidden = (name: string) =>
      [...form.querySelectorAll<HTMLInputElement>(`input[type=hidden][name=${name}]`)].map(
        (i) => i.value,
      );
    expect(hidden("type")).toEqual(["postdoc"]);
    expect(hidden("unit")).toEqual(["dept:AA1", "center:CC1"]);
    expect(
      page.getByTestId("orcid-coverage-by-role").querySelector("caption")?.textContent,
    ).toBe("Every person type in Dept A or Center Q.");
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
    expect(page.queryByTestId("orcid-coverage-filters-sheet-trigger")).toBeNull();
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
      "A department filter from an older link was ignored — pick it under Department / division.",
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

  it("phone sheet: trigger counts the active filters; the sheet copy is a second GET form, no shared ids", async () => {
    const { getByTestId, getByRole } = render(
      await EditOrcidCoveragePage({
        searchParams: Promise.resolve({
          type: "postdoc",
          unit: ["dept:AA1", "center:CC1"],
          nih: "ever",
        }),
      }),
    );
    const root = getByTestId("orcid-coverage-page");
    const page = within(root);
    const trigger = page.getByTestId("orcid-coverage-filters-sheet-trigger");
    expect(trigger.textContent).toBe("Filters (4)");
    expect(trigger.className).toContain("lg:hidden");
    expect(page.getByTestId("orcid-coverage-rail").className).toContain("hidden lg:block");
    // Report 8's "people, not articles" caption is not ORCID's — people ARE the unit here.
    expect(root.textContent).not.toContain("Counts are active people");

    fireEvent.click(trigger);
    const dialog = getByRole("dialog");
    const sheetForm = within(dialog).getByTestId("orcid-coverage-filters") as HTMLFormElement;
    const railForm = within(page.getByTestId("orcid-coverage-rail")).getByTestId(
      "orcid-coverage-filters",
    ) as HTMLFormElement;
    expect(sheetForm).not.toBe(railForm);
    expect(sheetForm.getAttribute("action")).toBe("/edit/orcid-coverage");
    expect((sheetForm.elements.namedItem("nih") as HTMLSelectElement).value).toBe("ever");
    const hidden = [
      ...sheetForm.querySelectorAll<HTMLInputElement>("input[type=hidden][name=unit]"),
    ];
    expect(hidden.map((i) => i.value)).toEqual(["dept:AA1", "center:CC1"]);
    const ids = [...root.querySelectorAll("[id]"), ...dialog.querySelectorAll("[id]")].map(
      (e) => e.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('phone sheet trigger reads plain "Filters" when nothing is filtered', async () => {
    const { getByTestId } = render(
      await EditOrcidCoveragePage({ searchParams: sp({ nih: "all" }) }),
    );
    expect(
      within(getByTestId("orcid-coverage-page")).getByTestId("orcid-coverage-filters-sheet-trigger")
        .textContent,
    ).toBe("Filters");
  });
});
