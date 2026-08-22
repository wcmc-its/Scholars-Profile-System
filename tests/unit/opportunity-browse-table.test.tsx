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

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
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
    // `getAttribute("onclick")` cannot pin this — React attaches handlers as props, never
    // as a DOM attribute, so it reads null even on a card that HAS one. Clicking the card
    // OFF the anchor is the assertion that can actually fail: a card wired to
    // `router.push` would navigate here, and cmd-click / copy-link would be dead.
    routerPush.mockClear();
    fireEvent.click(card!);
    expect(routerPush).not.toHaveBeenCalled();
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

  /**
   * 🔴 BLOCKER-1 TRIPWIRE. `Browse Redesign.dc.html` draws "Not extracted" in this cell, and a
   * build following the artboard shipped exactly that — a provenance claim the data does not
   * carry (see `DeadlineCell`'s own note). Every `deadlineLabel` pin stayed green throughout,
   * because the pure helper never changed and only the DOM moved; so pin the DOM instead: the
   * visible glyph, the screen-reader replacement for it, and the ABSENCE of the artboard string.
   */
  it("an undated open row renders the em dash + sr-only text, never “Not extracted”", async () => {
    await renderBrowse([
      {
        ...OPPS[0],
        opportunityId: "wcm_curated:undated",
        title: "Undated Open Award",
        dueDate: null,
        status: "open",
      },
    ]);
    const card = screen.getByRole("link", { name: "Undated Open Award" }).closest("li")!;
    // A bare em dash reaches a screen reader as nothing, hence the paired sr-only sentence.
    expect(within(card).getByText("—").getAttribute("aria-hidden")).toBe("true");
    expect(within(card).getByText("No deadline recorded").className).toContain("sr-only");
    expect(card.textContent).not.toContain("Not extracted");
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

/**
 * Browse data-wiring 2026-08 — the Concepts/Eligibility tag rows on a card. Both are
 * SERVER-DERIVED (`concepts` is already label-resolved, sorted, floor-dropped and capped at 3
 * by the route — pinned in opportunities-routes.test.ts); the card's job is chrome: the
 * raw-score opacity ramp + centrality tooltip on concept chips, full-opacity tooltip-free
 * eligibility chips, and rendering NO row at all when a row has no data.
 */
describe("BrowseList — concepts and eligibility tag rows", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  const TAGGED = [
    {
      ...OPPS[0],
      opportunityId: "wcm_curated:tagged",
      title: "Tagged Award",
      concepts: [
        { label: "Cancer Genomics", score: 0.9 },
        { label: "Implementation science", score: 0.2 },
      ],
      eligibilityLabels: ["Faculty", "Early Stage Investigators"],
    },
    {
      // The 70-row empty-vector case AND the ~88% no-restriction case: empty arrays.
      ...OPPS[0],
      opportunityId: "wcm_curated:bare",
      title: "Bare Award",
      concepts: [],
      eligibilityLabels: [],
    },
    {
      // An older payload with the fields entirely absent must render the same as empty.
      ...OPPS[0],
      opportunityId: "wcm_curated:legacy",
      title: "Legacy Award",
    },
  ];

  it("renders concept chips with the raw-score opacity ramp and a centrality tooltip", async () => {
    await renderBrowse(TAGGED);
    const card = screen.getByRole("link", { name: "Tagged Award" }).closest("li")!;
    expect(within(card).getByText("Concepts:")).toBeTruthy();
    const strong = within(card).getByText("Cancer Genomics");
    const weak = within(card).getByText("Implementation science");
    // opacity = 0.55 + score × 0.45 off the RAW score — no per-card normalization, so a
    // card of weak tags reads uniformly faint instead of promoting its own best to full ink.
    expect(parseFloat(strong.style.opacity)).toBeCloseTo(0.955, 5);
    expect(parseFloat(weak.style.opacity)).toBeCloseTo(0.64, 5);
    expect(strong.getAttribute("title")).toBe(
      "Centrality 0.90 — how central this is to the opportunity text",
    );
  });

  it("renders eligibility chips at full opacity with no tooltip", async () => {
    await renderBrowse(TAGGED);
    const card = screen.getByRole("link", { name: "Tagged Award" }).closest("li")!;
    expect(within(card).getByText("Eligibility:")).toBeTruthy();
    const chip = within(card).getByText("Early Stage Investigators");
    expect(chip.style.opacity).toBe("");
    expect(chip.getAttribute("title")).toBeNull();
  });

  it("renders neither row on a card without tag data — empty OR absent fields", async () => {
    await renderBrowse(TAGGED);
    for (const title of ["Bare Award", "Legacy Award"]) {
      const card = screen.getByRole("link", { name: title }).closest("li")!;
      expect(within(card).queryByText("Concepts:")).toBeNull();
      expect(within(card).queryByText("Eligibility:")).toBeNull();
    }
  });
});

/** The Research-area rail facet's fixture: two areas (one shared by two rows), one row the
 *  producer never assigned (`researchArea: null`) — enough to pin label display, id-keyed
 *  counts, filtering, and the chip + both reset paths. */
const RA_OPPS = [
  {
    ...OPPS[0],
    opportunityId: "wcm_curated:ra-genomics",
    title: "Genomics Award",
    researchArea: { id: "cancer_genomics", label: "Cancer Genomics" },
  },
  {
    ...OPPS[0],
    opportunityId: "wcm_curated:ra-workforce-1",
    title: "Workforce Award",
    researchArea: {
      id: "research_infrastructure_workforce",
      label: "Research infrastructure workforce",
    },
  },
  {
    ...OPPS[0],
    opportunityId: "wcm_curated:ra-workforce-2",
    title: "Second Workforce Award",
    researchArea: {
      id: "research_infrastructure_workforce",
      label: "Research infrastructure workforce",
    },
  },
  {
    ...OPPS[0],
    opportunityId: "wcm_curated:ra-none",
    title: "Unassigned Award",
    researchArea: null,
  },
];

describe("BrowseList — Research area rail facet", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  const railEl = () => screen.getByRole("complementary", { name: "Filter opportunities" });
  const cardsEl = () =>
    within(screen.getByRole("list", { name: "Funding opportunities" })).getAllByRole("listitem");

  it("sits between Sponsor and Mechanism, shows labels with counts, and filters on the id", async () => {
    await renderBrowse(RA_OPPS);
    const groups = within(railEl())
      .getAllByRole("group")
      .map((g) => (g.querySelector("legend")?.textContent ?? "").trim());
    expect(groups.join("|")).toContain("Sponsor|Research area|Mechanism");

    const ra = within(railEl()).getByRole("group", { name: "Research area" });
    // Labels, never slugs; count is per-id over the loaded rows.
    expect(
      within(ra).getByRole("checkbox", { name: /^Research infrastructure workforce/ }).closest(
        "label",
      )!.textContent,
    ).toMatch(/^Research infrastructure workforce\s*2$/);
    expect(
      within(ra).getByRole("checkbox", { name: /^Cancer Genomics/ }).closest("label")!.textContent,
    ).toMatch(/^Cancer Genomics\s*1$/);
    expect(within(ra).queryByText(/research_infrastructure_workforce/)).toBeNull();

    fireEvent.click(within(ra).getByRole("checkbox", { name: /^Research infrastructure workforce/ }));
    await waitFor(() => expect(cardsEl()).toHaveLength(2));
    expect(screen.getByRole("link", { name: "Workforce Award" })).toBeTruthy();
    // The unassigned row is out too — null researchArea matches no selection.
    expect(screen.queryByRole("link", { name: "Unassigned Award" })).toBeNull();
  });

  it("chips a checked research area by label, and BOTH reset paths clear it", async () => {
    await renderBrowse(RA_OPPS);
    const ra = () => within(railEl()).getByRole("group", { name: "Research area" });

    // Path 1 — the chip row's "Clear all".
    fireEvent.click(within(ra()).getByRole("checkbox", { name: /^Cancer Genomics/ }));
    await waitFor(() => expect(cardsEl()).toHaveLength(1));
    // The chip reads the resolved label (group-prefixed), never the slug id.
    expect(screen.getByText("Research area: Cancer Genomics")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(cardsEl()).toHaveLength(4));
    expect(screen.queryByText("Filtering by:")).toBeNull();
    expect(
      (within(ra()).getByRole("checkbox", { name: /^Cancer Genomics/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);

    // Path 2 — the rail's "reset all", which must also dismiss itself afterwards.
    fireEvent.click(within(ra()).getByRole("checkbox", { name: /^Cancer Genomics/ }));
    await waitFor(() => expect(cardsEl()).toHaveLength(1));
    fireEvent.click(within(railEl()).getByRole("button", { name: "reset all" }));
    await waitFor(() => expect(cardsEl()).toHaveLength(4));
    expect(within(railEl()).queryByRole("button", { name: "reset all" })).toBeNull();
  });

  it("keeps the chip's resolved label when the checked area drops out of the loaded rows", async () => {
    // Regression: the id→label map is a session cache, not a per-render rebuild — a reload
    // whose rows no longer carry the area (e.g. a source toggle) must not degrade the active
    // chip to the raw slug.
    let payload: unknown[] = RA_OPPS;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ count: payload.length, opportunities: payload }),
      })),
    );
    render(<BrowseList hrefFor={hrefFor} />);
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Funding opportunities" })).toBeTruthy(),
    );

    const ra = within(railEl()).getByRole("group", { name: "Research area" });
    fireEvent.click(within(ra).getByRole("checkbox", { name: /^Cancer Genomics/ }));
    await screen.findByText("Research area: Cancer Genomics");

    payload = [RA_OPPS[3]]; // the next load carries no cancer_genomics row at all
    fireEvent.click(screen.getByRole("checkbox", { name: /Include Grants\.gov/ }));
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Genomics Award" })).toBeNull(),
    );
    expect(screen.getByText("Research area: Cancer Genomics")).toBeTruthy();
    expect(screen.queryByText(/cancer_genomics/)).toBeNull();
  });
});

/**
 * Redesign 2026-08 — the rail's facet groups, the active-filter chip row, and the two
 * reset controls ("Clear all" and the rail's "reset all", which must agree about the
 * faculty-PI gate). Its own fixture rather than `OPPS`: two sponsors, two mechanisms
 * and one award no WCM faculty PI can hold is the minimum shape that renders the
 * Sponsor facet, the Mechanism facet, a chip and the faculty-PI counterfactual
 * all at once, and it leaves the card tests above untouched.
 */
const FILTER_OPPS = [
  {
    opportunityId: "wcm_curated:alpha",
    title: "Alpha Investigator Award",
    sponsor: "Hartwell Foundation",
    mechanism: "R01",
    dueDate: null,
    source: "wcm_curated",
    status: "open",
    awardFloor: null,
    awardCeiling: null,
    facultyPiEligible: true,
  },
  {
    opportunityId: "wcm_curated:beta",
    title: "Beta Early Career Award",
    sponsor: "Beta Trust",
    mechanism: "K99",
    dueDate: null,
    source: "wcm_curated",
    status: "open",
    awardFloor: null,
    awardCeiling: null,
    facultyPiEligible: true,
  },
  {
    opportunityId: "wcm_curated:delta",
    title: "Delta Program Award",
    sponsor: "Beta Trust",
    mechanism: "R01",
    dueDate: null,
    source: "wcm_curated",
    status: "open",
    awardFloor: null,
    awardCeiling: null,
    facultyPiEligible: true,
  },
  {
    // The one the faculty-PI gate holds back, so the counterfactual sentence renders.
    opportunityId: "wcm_curated:gamma",
    title: "Gamma Trainee Prize",
    sponsor: "Hartwell Foundation",
    mechanism: "R01",
    dueDate: null,
    source: "wcm_curated",
    status: "open",
    awardFloor: null,
    awardCeiling: null,
    facultyPiEligible: false,
  },
];

const rail = () => screen.getByRole("complementary", { name: "Filter opportunities" });
const cards = () =>
  within(screen.getByRole("list", { name: "Funding opportunities" })).getAllByRole("listitem");

describe("BrowseList — rail facets, filter chips and Clear all", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  /**
   * 🔴 MECHANISM REGRESSION GUARD. Deleting the entire `<FacetGroup title="Mechanism">`
   * block from `FilterRail` left every other test in the repo green — the artboard does
   * not draw the group, so a future session following it could drop the only way to
   * filter by activity code and never learn. This test is the tripwire: it pins the
   * group's presence, its option counts, and that toggling one actually narrows the list.
   */
  it("pins the Mechanism facet in the rail, with counts, and filters by it", async () => {
    await renderBrowse(FILTER_OPPS);
    const mech = within(rail()).getByRole("group", { name: "Mechanism" });
    // Counts are computed with this group's own selections skipped, over the rows the
    // faculty-PI gate lets through: R01 = alpha + delta, K99 = beta (gamma is gated out).
    expect(
      within(mech).getByRole("checkbox", { name: /^R01/ }).closest("label")!.textContent,
    ).toMatch(/^R01\s*2$/);
    expect(
      within(mech).getByRole("checkbox", { name: /^K99/ }).closest("label")!.textContent,
    ).toMatch(/^K99\s*1$/);

    fireEvent.click(within(mech).getByRole("checkbox", { name: /^K99/ }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(screen.getByRole("link", { name: "Beta Early Career Award" })).toBeTruthy();
  });

  /**
   * Long facet labels stay on ONE line (`Browse Redesign.dc.html`) — staging showed
   * "Pharmaceutical Research & Manufacturers of America (PhRMA) Foundation" wrapped
   * across four Sponsor-facet lines. The span truncates; the row's `title` carries
   * the full name so hover still reveals it.
   */
  it("truncates option labels to one line and titles the row with the full name", async () => {
    await renderBrowse(FILTER_OPPS);
    const sponsors = within(rail()).getByRole("group", { name: "Sponsor" });
    const row = within(sponsors)
      .getByRole("checkbox", { name: /^Hartwell Foundation/ })
      .closest("label")!;
    expect(row.getAttribute("title")).toBe("Hartwell Foundation");
    const span = within(row as HTMLElement).getByText("Hartwell Foundation");
    expect(span.className).toContain("truncate");
    expect(span.className).toContain("min-w-0");
    expect(span.className).toContain("flex-1");
  });

  it("titles a labelFor facet row with the resolved label, never the raw id", async () => {
    // The labelFor branch (Research area) — a regression to title={value} would show the
    // slug on hover and this suite would stay green if only the Sponsor path were pinned.
    await renderBrowse(RA_OPPS);
    const ra = within(rail()).getByRole("group", { name: "Research area" });
    const row = within(ra)
      .getByRole("checkbox", { name: /^Cancer Genomics/ })
      .closest("label")!;
    expect(row.getAttribute("title")).toBe("Cancer Genomics");
    expect(within(rail()).queryByTitle("cancer_genomics")).toBeNull();
  });

  it("chips an active facet and removes it again from the chip's own button", async () => {
    await renderBrowse(FILTER_OPPS);
    expect(cards()).toHaveLength(3);
    expect(screen.queryByText("Filtering by:")).toBeNull();

    const sponsors = within(rail()).getByRole("group", { name: "Sponsor" });
    fireEvent.click(within(sponsors).getByRole("checkbox", { name: /^Hartwell Foundation/ }));
    await waitFor(() => expect(cards()).toHaveLength(1));

    // Group-prefixed: a bare "Hartwell Foundation" would be indistinguishable from a
    // Mechanism chip carrying the same string, on screen and read aloud.
    const remove = screen.getByRole("button", {
      name: "Remove filter: Sponsor: Hartwell Foundation",
    });
    fireEvent.click(remove);

    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(screen.queryByRole("button", { name: /^Remove filter:/ })).toBeNull();
    expect(
      (within(sponsors).getByRole("checkbox", { name: /^Hartwell Foundation/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  /**
   * 🔴 CLEAR-ALL GUARD. `EMPTY_BROWSE_FILTERS.facultyPiOnly` is `true`, so spreading it
   * blind on Clear all silently RE-APPLIES a gate that no chip ever represented and that
   * hides ~13.2% of the corpus — the list gets SHORTER after a control named "Clear all".
   * The honest observable is the counterfactual sentence's own control: while the gate is
   * relaxed the line offers "hide awards no faculty PI can hold", and while it is on the
   * line offers "show".
   */
  it("Clear all drops the chips but carries the relaxed faculty-PI gate through", async () => {
    await renderBrowse(FILTER_OPPS);
    expect(cards()).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "show" }));
    await waitFor(() => expect(cards()).toHaveLength(4));
    expect(screen.getByRole("button", { name: "hide awards no faculty PI can hold" })).toBeTruthy();

    const sponsors = within(rail()).getByRole("group", { name: "Sponsor" });
    fireEvent.click(within(sponsors).getByRole("checkbox", { name: /^Hartwell Foundation/ }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.getByText("Filtering by:")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    // The chips go; the gate stays exactly where the user left it.
    await waitFor(() => expect(screen.queryByText("Filtering by:")).toBeNull());
    expect(cards()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "hide awards no faculty PI can hold" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "show" })).toBeNull();
  });

  /**
   * 🔴 AVAILABILITY-CHIP GUARD. Deleting the whole `if (filters.openOnly)` push from
   * `ActiveFilterChips` left every test in the repo green — Sponsor and Mechanism are pinned
   * above, this one was not. It is also the only chip fed by a radio rather than a checkbox,
   * so it is the only one whose removal has to put a sibling control back.
   */
  it("chips the availability filter and clears it back to Open and past", async () => {
    await renderBrowse(FILTER_OPPS);
    expect(screen.queryByText("Filtering by:")).toBeNull();

    fireEvent.click(within(rail()).getByRole("radio", { name: "Only open" }));
    await waitFor(() => expect(screen.getByText("Filtering by:")).toBeTruthy());
    expect(screen.getByText("Availability: Only open")).toBeTruthy();
    // `active` and the chip row's render test must stay the SAME condition, in both
    // directions. Dropping `openOnly` from `active` alone kept every other test green
    // while leaving "Clear all" on screen with no "reset all" beside it.
    expect(within(rail()).getByRole("button", { name: "reset all" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Availability: Only open" }));
    await waitFor(() => expect(screen.queryByText("Filtering by:")).toBeNull());
    expect(
      (within(rail()).getByRole("radio", { name: "Open and past" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  /**
   * 🔴 The rail's "reset all" and the chip row's "Clear all" are ALWAYS on screen together —
   * `FilterRail`'s `active` test is EXACTLY the chip row's render test — so they cannot be
   * allowed to disagree about `facultyPiOnly`. Blind-spreading `EMPTY_BROWSE_FILTERS` in
   * either one re-applies a gate no chip ever represented and makes the list SHORTER after a
   * control named "reset". This pins the rail control specifically, with the gate relaxed,
   * INCLUDING that it dismisses itself afterwards — which is what separates a live control
   * from one whose only remaining term it is forbidden to touch.
   */
  it("the rail's reset all carries the relaxed faculty-PI gate through, like Clear all", async () => {
    await renderBrowse(FILTER_OPPS);

    fireEvent.click(screen.getByRole("button", { name: "show" }));
    await waitFor(() => expect(cards()).toHaveLength(4));

    const sponsors = within(rail()).getByRole("group", { name: "Sponsor" });
    fireEvent.click(within(sponsors).getByRole("checkbox", { name: /^Hartwell Foundation/ }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(within(rail()).getByRole("button", { name: "reset all" })).toBeTruthy();

    fireEvent.click(within(rail()).getByRole("button", { name: "reset all" }));

    // The facets go; the gate stays exactly where the user left it.
    await waitFor(() => expect(cards()).toHaveLength(4));
    expect(screen.queryByText("Filtering by:")).toBeNull();
    expect(screen.getByRole("button", { name: "hide awards no faculty PI can hold" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "show" })).toBeNull();
    // …and the button itself is gone. Without this line the test passes against a "reset all"
    // that is a permanent no-op — still on screen, one click from a resting Browse view.
    expect(within(rail()).queryByRole("button", { name: "reset all" })).toBeNull();
  });

  /**
   * 🔴 The other half of the same invariant, and the one that regressed: with the gate
   * relaxed and NOTHING else set, "reset all" must not render at all. It carries
   * `facultyPiOnly` through, so in that state it has nothing left to change — it would
   * render, click to an identical state, and never dismiss itself. Re-applying the gate is
   * the counterfactual line's own control, which is on screen the whole time.
   */
  it("offers no reset all when the relaxed faculty-PI gate is the only thing set", async () => {
    await renderBrowse(FILTER_OPPS);
    expect(within(rail()).queryByRole("button", { name: "reset all" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "show" }));
    await waitFor(() => expect(cards()).toHaveLength(4));

    expect(within(rail()).queryByRole("button", { name: "reset all" })).toBeNull();
    // The chip row, whose render test this now EQUALS, is absent in the same state.
    expect(screen.queryByText("Filtering by:")).toBeNull();
    expect(screen.getByRole("button", { name: "hide awards no faculty PI can hold" })).toBeTruthy();
  });
});
