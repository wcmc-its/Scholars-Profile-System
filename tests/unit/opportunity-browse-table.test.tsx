/**
 * `components/edit/opportunity-browse.tsx` — `BrowseList` renders as a card list.
 *
 * Re-homed from the retired `/edit/find-researchers` suite (matcha-admin Phase
 * 3c); redesign 2026-08 (`Browse Redesign.dc.html`) moved rows to cards — Track
 * B is expected to give opportunities a variable amount of tag data
 * (concepts/methods/eligibility), which a fixed-column table can't hold
 * honestly, so cards were the right shape even before Track B lands. The
 * load-bearing detail is still R7: a card is clickable because the title is a
 * REAL anchor with a stretched pseudo-element, NOT because the card has an
 * onClick. These tests pin the anchor — an onClick card would still "work" in
 * a click test while silently breaking cmd-click, middle-click, copy-link and
 * screen-reader link announcement, so asserting `href` is the point.
 *
 * next/link renders a plain <a> under jsdom (see browse-by-method-section.test).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/edit/grant-matcha",
  useSearchParams: () => new URLSearchParams(""),
}));

import { BrowseList } from "@/components/edit/opportunity-browse";

const OPPS = [
  {
    opportunityId: "wcm_curated:ones-abc123",
    // The sponsor is restated inside the title — the card must not print it twice.
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

/** The grant-matcha picker's `hrefFor` — the selection lives in the URL (`?opp=`). */
const hrefFor = (id: string) => `/edit/grant-matcha?opp=${encodeURIComponent(id)}`;

async function renderBrowse(opportunities: unknown[] = OPPS) {
  mockFetch(opportunities);
  render(<BrowseList hrefFor={hrefFor} />);
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "Funding opportunities" })).toBeTruthy(),
  );
}

describe("BrowseList — cards", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("renders one card per opportunity", async () => {
    await renderBrowse();
    const list = screen.getByRole("list", { name: "Funding opportunities" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("2 opportunities")).toBeTruthy();
  });

  it("R7 — the title is a real link carrying the card's href, not a click handler", async () => {
    await renderBrowse();
    const link = screen.getByRole("link", {
      name: /NIH Outstanding New Environmental Scientist/,
    });
    expect(link.getAttribute("href")).toBe("/edit/grant-matcha?opp=wcm_curated%3Aones-abc123");
    // The stretched pseudo-element is what makes the whole card clickable.
    expect(link.className).toContain("after:absolute");
    expect(link.className).toContain("after:inset-0");

    // The card positions that pseudo-element and shows focus, but is NOT itself
    // a control: no role="button", no tabindex, no click/keydown handler.
    const card = link.closest("li");
    expect(card).not.toBeNull();
    expect(card!.className).toContain("relative");
    expect(card!.className).toContain("focus-within:outline");
    expect(card!.getAttribute("role")).toBeNull();
    expect(card!.getAttribute("tabindex")).toBeNull();
    expect(card!.getAttribute("onclick")).toBeNull();
  });

  it("defect 1 — the sponsor prints once: in the meta row, stripped off the title", async () => {
    await renderBrowse();
    const title = screen.getByRole("link", { name: /ONES/ });
    expect(title.textContent).toContain("NIH Outstanding New Environmental Scientist");
    expect(title.textContent).not.toContain("National Institutes of Health");
    // …which now lives in exactly one place: the card's meta row.
    expect(title.closest("li")!.textContent).toContain("National Institutes of Health (NIH)");
  });

  it("defect 2 — the deadline is visible, and only a continuous status reads Rolling", async () => {
    await renderBrowse();
    const dated = screen.getByRole("link", { name: /ONES/ }).closest("li")!;
    expect(dated.textContent).toContain("Mar 15, 2027");

    const undated = screen
      .getByRole("link", { name: "Patient Safety Learning Laboratories" })
      .closest("li")!;
    expect(undated.textContent).toContain("Rolling");
  });

  it("defect 3 — the curated badge sits with the card it modifies", async () => {
    await renderBrowse();
    const card = screen.getByRole("link", { name: /ONES/ }).closest("li")!;
    expect(card.textContent).toContain("WCM curated");
  });

  it("omits the meta line's activity-code/award tags rather than dashing them when absent", async () => {
    // Cards, unlike the old fixed-column table, don't carry a placeholder cell for every
    // field — Track B adds concepts/methods/eligibility tags of variable count per card, so
    // "just don't render the missing one" is the shape already, not new for this field pair.
    await renderBrowse();
    const card = screen
      .getByRole("link", { name: "Patient Safety Learning Laboratories" })
      .closest("li")!;
    expect(card.textContent).not.toMatch(/R01/);
    expect(card.textContent).not.toContain("—".repeat(2)); // no stray double-dash artifact
  });

  it("keeps the empty state (and no list) when nothing matches", async () => {
    mockFetch([]);
    render(<BrowseList hrefFor={hrefFor} />);
    await waitFor(() =>
      expect(screen.getByText("No opportunities match the current filters.")).toBeTruthy(),
    );
    expect(screen.queryByRole("list", { name: "Funding opportunities" })).toBeNull();
  });

  it("keeps the search box, the Sort control and the sidebar filters", async () => {
    await renderBrowse();
    expect(screen.getByLabelText("Search funding opportunities")).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Filter opportunities" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Include Grants.gov/ })).toBeTruthy();
  });

  it("shows no pagination controls under one page's worth of opportunities", async () => {
    await renderBrowse(); // 2 opportunities, well under PAGE_SIZE
    expect(screen.queryByText(/Page \d+ of \d+/)).toBeNull();
  });

  it("paginates for real once there's more than one page", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...OPPS[0],
      opportunityId: `wcm_curated:many-${i}`,
      title: `Opportunity number ${i}`,
    }));
    await renderBrowse(many);
    const list = () => screen.getByRole("list", { name: "Funding opportunities" });
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    expect(within(list()).getAllByRole("listitem")).toHaveLength(20);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 2")).toBeTruthy());
    expect(within(list()).getAllByRole("listitem")).toHaveLength(5);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
