/**
 * Sponsor-match panel client behaviors (iteration pass):
 *  - facets (department / matched topic / CTL-IP) narrow the rendered rows
 *    client-side, and each row keeps its ORIGINAL rank number;
 *  - a successful search lands in localStorage history — browser-only by
 *    design, since the server never persists descriptions (route contract);
 *  - per-row evidence renders: PubMed-linked top papers with the relevance
 *    percentage, and matched-topic chips.
 * fetch is stubbed — no route/engine involvement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SponsorMatchPanel } from "@/components/edit/sponsor-match-panel";

function researcher(over: Record<string, unknown>) {
  return {
    cwid: "x",
    slug: "slug-x",
    preferredName: "X",
    title: "Professor",
    department: "Medicine",
    topicContributions: [
      { topicId: "__sponsor_match__", contribution: 1, pubCount: 2, minYear: 2021 },
    ],
    defaultScore: 1,
    technologyCount: 0,
    topPapers: [],
    matchedTopics: [],
    ...over,
  };
}

const THREE = [
  researcher({
    cwid: "a",
    slug: "slug-a",
    preferredName: "Alice Alpha",
    topPapers: [
      { pmid: "111", title: "CAR T persistence", year: 2024, journal: "Blood", relevance: 0.9 },
    ],
    matchedTopics: [{ topicId: "immuno", label: "Immuno-oncology", pubCount: 3 }],
  }),
  researcher({
    cwid: "b",
    slug: "slug-b",
    preferredName: "Bob Beta",
    technologyCount: 2,
    matchedTopics: [{ topicId: "immuno", label: "Immuno-oncology", pubCount: 1 }],
  }),
  researcher({
    cwid: "c",
    slug: "slug-c",
    preferredName: "Cara Gamma",
    department: "Surgery",
    matchedTopics: [{ topicId: "metab", label: "Cancer Metabolism", pubCount: 2 }],
  }),
];

async function renderAndSearch() {
  render(<SponsorMatchPanel />);
  fireEvent.change(screen.getByLabelText(/description/i), {
    target: { value: "CAR T collaborators" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
  await screen.findByText("Alice Alpha");
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, researchers: THREE }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SponsorMatchPanel", () => {
  it("department facet narrows rows and keeps the ORIGINAL rank number", async () => {
    await renderAndSearch();
    fireEvent.click(screen.getByRole("button", { name: /Surgery · 1/ }));

    expect(screen.queryByText("Alice Alpha")).toBeNull();
    expect(screen.queryByText("Bob Beta")).toBeNull();
    const row = screen.getByText("Cara Gamma").closest("li")!;
    expect(row.textContent).toMatch(/^3/); // still #3 overall, not #1-of-filtered
    expect(screen.getByText(/1 of 3/)).toBeTruthy();
  });

  it("CTL-IP facet keeps only technology holders; Clear filters restores all", async () => {
    await renderAndSearch();
    fireEvent.click(screen.getByRole("button", { name: /Holds CTL technology · 1/ }));
    expect(screen.queryByText("Alice Alpha")).toBeNull();
    expect(screen.getByText("Bob Beta")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Alice Alpha")).toBeTruthy();
    expect(screen.getByText("Cara Gamma")).toBeTruthy();
  });

  it("topic facet matches rows carrying the selected topic", async () => {
    await renderAndSearch();
    // Facet chips are buttons; per-row topic chips are plain spans — no clash.
    fireEvent.click(screen.getByRole("button", { name: /Cancer Metabolism · 1/ }));
    expect(screen.queryByText("Alice Alpha")).toBeNull();
    expect(screen.getByText("Cara Gamma")).toBeTruthy();
  });

  it("saves the search to localStorage history and renders it", async () => {
    await renderAndSearch();
    const saved = JSON.parse(window.localStorage.getItem("sponsor-match-history")!) as Array<{
      d: string;
    }>;
    expect(saved[0].d).toBe("CAR T collaborators");
    expect(screen.getByText(/Recent searches \(1\)/)).toBeTruthy();
    // Clearing wipes storage too.
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(window.localStorage.getItem("sponsor-match-history")).toBeNull();
  });

  it("renders per-row paper evidence: PubMed link + relevance percentage", async () => {
    await renderAndSearch();
    const link = screen.getByRole("link", { name: "CAR T persistence" });
    expect(link.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/111/");
    expect(screen.getByText(/90% match/)).toBeTruthy();
  });
});
