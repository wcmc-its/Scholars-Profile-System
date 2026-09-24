/**
 * Home refinements (2026-09-24): the research-area filter, the "Find a method"
 * typeahead, and the spotlight title cleanup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { BrowseAllResearchAreasGrid } from "@/components/home/browse-all-research-areas-grid";
import { MethodFinder } from "@/components/home/method-finder";
import { stripTrailingPeriod } from "@/components/home/spotlight-section";

afterEach(() => vi.unstubAllGlobals());

describe("BrowseAllResearchAreasGrid filter", () => {
  const items = [
    { slug: "aging", name: "Aging & Geroscience", publicationCount: 869 },
    { slug: "cardio", name: "Cardiovascular Disease", publicationCount: 1434 },
    { slug: "sleep", name: "Sleep Medicine & Circadian Biology", publicationCount: 89 },
  ] as never;

  it("narrows the list as you type and shows an empty state on no match", () => {
    const { container } = render(<BrowseAllResearchAreasGrid items={items} />);
    const box = screen.getByRole("searchbox", { name: "Filter research areas" });
    fireEvent.change(box, { target: { value: "CARDIO" } });
    const names = [...container.querySelectorAll("li a")].map((a) => a.textContent);
    expect(names).toEqual(["Cardiovascular Disease"]);
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(container.querySelectorAll("li a")).toHaveLength(0);
    expect(container.textContent).toContain("No research areas match “zzz”.");
  });
});

describe("MethodFinder", () => {
  const suggestions = [
    { kind: "subtopic", title: "CRISPR Genome Editing", subtitle: "Genetics · 12 scholars", href: "/topics/g?subtopic=c" },
    { kind: "method", title: "CRISPR genome editing", subtitle: "Molecular · 36 scholars", href: "/methods/m/crispr" },
  ];

  it("fetches the finder endpoint, bolds the match, and Enter opens the active row", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ suggestions }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<MethodFinder />);
    const box = screen.getByRole("combobox", { name: "Find a method" });
    fireEvent.change(box, { target: { value: "crispr" } });
    await screen.findByText("Genetics · 12 scholars");
    expect(fetchMock).toHaveBeenCalledWith("/api/search/suggest-methods?q=crispr", expect.anything());
    expect(screen.getAllByText("CRISPR")[0].tagName).toBe("STRONG");

    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(assign).toHaveBeenCalledWith("/methods/m/crispr");
  });

  it("says so when nothing matches, and still offers the full search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ suggestions: [] }), { status: 200 })));
    render(<MethodFinder />);
    fireEvent.change(screen.getByRole("combobox", { name: "Find a method" }), { target: { value: "qqq" } });
    await waitFor(() => expect(screen.getByText("No method families match “qqq”.")).toBeTruthy());
    expect(screen.getByText("See all matches for “qqq” →").closest("a")?.getAttribute("href")).toBe("/search?q=qqq");
  });
});

describe("stripTrailingPeriod", () => {
  it("drops one trailing period and leaves case alone", () => {
    expect(stripTrailingPeriod("Telehealth Delivery Differs By Medicare Status. ")).toBe(
      "Telehealth Delivery Differs By Medicare Status",
    );
    expect(stripTrailingPeriod("Is it safe?")).toBe("Is it safe?");
  });
});
