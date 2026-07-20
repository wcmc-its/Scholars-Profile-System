/**
 * `components/edit/find-researchers.tsx` — the browse list renders as a TABLE.
 *
 * 200 opportunities all carry the same four attributes, so they are rows, not
 * cards (R5). The load-bearing detail is R7: the row is clickable because the
 * title is a REAL anchor with a stretched pseudo-element, NOT because the `<tr>`
 * has an onClick. These tests pin the anchor — an onClick row would still "work"
 * in a click test while silently breaking cmd-click, middle-click, copy-link and
 * screen-reader link announcement, so asserting `href` is the point.
 *
 * next/link renders a plain <a> under jsdom (see browse-by-method-section.test).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/edit/find-researchers",
  useSearchParams: () => new URLSearchParams(""),
}));

import { FindResearchers } from "@/components/edit/find-researchers";

const OPPS = [
  {
    opportunityId: "wcm_curated:ones-abc123",
    // The sponsor is restated inside the title — the row must not print it twice.
    title:
      "National Institutes of Health (NIH) - NIH Outstanding New Environmental Scientist (ONES) Award (R01)",
    sponsor: "National Institutes of Health (NIH)",
    mechanism: "R01",
    dueDate: "2027-03-15T00:00:00.000Z",
    source: "wcm_curated",
    status: "open",
    awardFloor: null,
    awardCeiling: 500000,
  },
  {
    opportunityId: "grants_gov:rolling-xyz789",
    title: "Patient Safety Learning Laboratories",
    sponsor: "AHRQ",
    mechanism: null,
    dueDate: null,
    source: "grants_gov",
    status: "continuous",
    awardFloor: null,
    awardCeiling: null,
  },
];

function mockFetch(opportunities: unknown[] = OPPS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ count: opportunities.length, opportunities }),
    })),
  );
}

async function renderBrowse(opportunities: unknown[] = OPPS) {
  mockFetch(opportunities);
  render(<FindResearchers />);
  await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
}

describe("FindResearchers browse — table", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("renders one row per opportunity under the four+ named column headers", async () => {
    await renderBrowse();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Opportunity", "Sponsor", "Activity code", "Award", "Deadline"]);
    // Two body rows (getAllByRole("row") also counts the header row).
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("2 opportunities")).toBeTruthy();
  });

  it("R7 — the title is a real link carrying the row's href, not a click handler", async () => {
    await renderBrowse();
    const link = screen.getByRole("link", {
      name: /NIH Outstanding New Environmental Scientist/,
    });
    expect(link.getAttribute("href")).toBe(
      "/edit/find-researchers?opp=wcm_curated%3Aones-abc123",
    );
    // The stretched pseudo-element is what makes the whole row clickable.
    expect(link.className).toContain("after:absolute");
    expect(link.className).toContain("after:inset-0");

    // The row positions that pseudo-element and shows focus, but is NOT itself
    // a control: no role="button", no tabindex, no click/keydown handler.
    const row = link.closest("tr");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("relative");
    expect(row!.className).toContain("focus-within:outline");
    expect(row!.getAttribute("role")).toBeNull();
    expect(row!.getAttribute("tabindex")).toBeNull();
    expect(row!.getAttribute("onclick")).toBeNull();
  });

  it("defect 1 — the sponsor prints once: its own column, stripped off the title", async () => {
    await renderBrowse();
    const row = screen.getByRole("link", { name: /ONES/ }).closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    // Title no longer restates the sponsor…
    expect(cells[0].textContent).toContain("NIH Outstanding New Environmental Scientist");
    expect(cells[0].textContent).not.toContain("National Institutes of Health");
    // …which now lives in exactly one place.
    expect(cells[1].textContent).toBe("National Institutes of Health (NIH)");
  });

  it("defect 2 — the deadline is visible, and only a continuous status reads Rolling", async () => {
    await renderBrowse();
    const dated = screen.getByRole("link", { name: /ONES/ }).closest("tr")!;
    expect(within(dated).getAllByRole("cell")[4].textContent).toBe("Mar 15, 2027");

    const undated = screen.getByRole("link", { name: "Patient Safety Learning Laboratories" })
      .closest("tr")!;
    expect(within(undated).getAllByRole("cell")[4].textContent).toBe("Rolling");
  });

  it("defect 3 — the curated badge sits inline with the title it modifies", async () => {
    await renderBrowse();
    const row = screen.getByRole("link", { name: /ONES/ }).closest("tr")!;
    // Same cell as the title, not a detached top-right corner of a card.
    expect(within(row).getAllByRole("cell")[0].textContent).toContain("WCM curated");
  });

  it("shows an em dash for the columns an opportunity genuinely lacks", async () => {
    await renderBrowse();
    const row = screen.getByRole("link", { name: "Patient Safety Learning Laboratories" })
      .closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    expect(cells[2].textContent).toBe("—"); // no activity code
    expect(cells[3].textContent).toBe("—"); // no award range
  });

  it("keeps the empty state (and no table) when nothing matches", async () => {
    mockFetch([]);
    render(<FindResearchers />);
    await waitFor(() =>
      expect(screen.getByText("No opportunities match the current filters.")).toBeTruthy(),
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps the search box, the Sort control and the sidebar filters", async () => {
    await renderBrowse();
    expect(screen.getByLabelText("Search funding opportunities")).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Filter opportunities" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Include Grants.gov/ })).toBeTruthy();
  });
});
