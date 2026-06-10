import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopicsSection } from "@/components/profile/topics-section";

function makeKeywords(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    descriptorUi: `D${String(i + 1).padStart(4, "0")}`,
    displayLabel: `Topic ${i + 1}`,
    pubCount: 100 - i,
  }));
}

const noop = () => {};

describe("TopicsSection", () => {
  it("renders top 10 by default and the show-next link when there are more", () => {
    const keywords = makeKeywords(15);
    render(
      <TopicsSection
        keywords={keywords}
        totalAcceptedPubs={500}
        selectedUis={[]}
        onToggle={noop}
        onClearAll={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /Topic 1\s*100/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Topic 10\s*91/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Topic 11\s*90/ })).toBeNull();
    // 15 - 10 = 5 remaining, but the page-step caps at the smaller of (20, remaining)
    expect(screen.getByRole("button", { name: /Show next 5 topics/ })).toBeTruthy();
  });

  it("Show next adds 20 topics per click and Show fewer collapses back to 10", () => {
    const keywords = makeKeywords(40);
    render(
      <TopicsSection
        keywords={keywords}
        totalAcceptedPubs={500}
        selectedUis={[]}
        onToggle={noop}
        onClearAll={noop}
      />,
    );
    // First reveal step shows the next 20
    expect(screen.getByRole("button", { name: /Show next 20 topics/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show next 20 topics/ }));
    expect(screen.getByRole("button", { name: /Topic 30\s*71/ })).toBeTruthy();
    // 40 - 30 = 10 remaining, so the next link offers 10 more
    expect(screen.getByRole("button", { name: /Show next 10 topics/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show fewer/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show fewer/ }));
    expect(screen.queryByRole("button", { name: /Topic 11\s*90/ })).toBeNull();
  });

  it("pins a selected pill into the visible row when it would otherwise be hidden", () => {
    const keywords = makeKeywords(15);
    const offRowUi = keywords[12].descriptorUi as string; // Topic 13, count 88
    render(
      <TopicsSection
        keywords={keywords}
        totalAcceptedPubs={500}
        selectedUis={[offRowUi]}
        onToggle={noop}
        onClearAll={noop}
      />,
    );
    // Selected pill is visible…
    expect(screen.getByRole("button", { name: /Topic 13\s*88/ })).toBeTruthy();
    // …and the bottom of the top-10 was bumped to make room.
    expect(screen.queryByRole("button", { name: /Topic 10\s*91/ })).toBeNull();
  });

  it("calls onToggle with the descriptorUi when an unselected pill is clicked", () => {
    const onToggle = vi.fn();
    const keywords = makeKeywords(3);
    render(
      <TopicsSection
        keywords={keywords}
        totalAcceptedPubs={10}
        selectedUis={[]}
        onToggle={onToggle}
        onClearAll={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Topic 2\s*99/ }));
    expect(onToggle).toHaveBeenCalledWith(keywords[1].descriptorUi);
  });

  it("does not show a Show-all link when there are 10 or fewer keywords", () => {
    render(
      <TopicsSection
        keywords={makeKeywords(7)}
        totalAcceptedPubs={50}
        selectedUis={[]}
        onToggle={noop}
        onClearAll={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

describe("TopicsSection — PROFILE_FACET_REDESIGN (flag on)", () => {
  it("renders contextual '{in} of {total}' counts when topicCounts is supplied", () => {
    const keywords = makeKeywords(3); // counts 100, 99, 98
    const topicCounts = new Map<string, number>([
      [keywords[0].descriptorUi as string, 6],
      [keywords[1].descriptorUi as string, 4],
    ]);
    render(
      <TopicsSection
        keywords={keywords}
        totalAcceptedPubs={500}
        selectedUis={[]}
        onToggle={noop}
        onClearAll={noop}
        facetRedesignEnabled
        topicCounts={topicCounts}
      />,
    );
    expect(screen.getByText("Counts shown within current filter")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Topic 1\s*6 of 100/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Topic 2\s*4 of 99/ })).toBeTruthy();
  });

  it("shows the select-to-filter helper (no filter) and plain counts when topicCounts is null", () => {
    render(
      <TopicsSection
        keywords={makeKeywords(2)}
        totalAcceptedPubs={434}
        selectedUis={[]}
        onToggle={noop}
        onClearAll={noop}
        facetRedesignEnabled
        topicCounts={null}
      />,
    );
    expect(screen.getByText("From 434 accepted publications · select to filter")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Topic 1\s*100/ })).toBeTruthy();
  });

  it("gives a selected chip the blue facet state with a leading Check and trailing X", () => {
    const keywords = makeKeywords(3);
    const selectedUi = keywords[0].descriptorUi as string;
    const topicCounts = new Map<string, number>([[selectedUi, 6]]);
    render(
      <TopicsSection
        keywords={keywords}
        totalAcceptedPubs={500}
        selectedUis={[selectedUi]}
        onToggle={noop}
        onClearAll={noop}
        facetRedesignEnabled
        topicCounts={topicCounts}
      />,
    );
    const btn = screen.getByRole("button", { name: /Topic 1\s*6 of 100/ });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    // Blue facet-topic token fill (not the accent-slate flag-off pill).
    expect(btn.className).toContain("bg-[var(--color-facet-topic-fill)]");
    expect(btn.className).toContain("border-[var(--color-facet-topic-border)]");
    // Leading Check + trailing X icons (both lucide <svg>).
    expect(btn.querySelectorAll("svg").length).toBe(2);
  });

  it("dims a zero-count chip and makes it non-interactive", () => {
    const onToggle = vi.fn();
    const keywords = makeKeywords(3);
    const zeroUi = keywords[2].descriptorUi as string; // Topic 3, pubCount 98
    const topicCounts = new Map<string, number>([
      [keywords[0].descriptorUi as string, 6],
      [zeroUi, 0],
    ]);
    render(
      <TopicsSection
        keywords={keywords}
        totalAcceptedPubs={500}
        selectedUis={[]}
        onToggle={onToggle}
        onClearAll={noop}
        facetRedesignEnabled
        topicCounts={topicCounts}
      />,
    );
    const zeroBtn = screen.getByRole("button", { name: /Topic 3\s*0 of 98/ });
    expect(zeroBtn).toHaveProperty("disabled", true);
    expect(zeroBtn.className).toContain("opacity-45");
    fireEvent.click(zeroBtn);
    expect(onToggle).not.toHaveBeenCalled();
  });

  // #17 — redesign chips carry the chip-fill transition; flag-off chips do not.
  it("redesign chips carry facet-chip-transition (and flag-off chips do not)", () => {
    const keywords = makeKeywords(2);
    const selectedUi = keywords[0].descriptorUi as string;
    const { rerender } = render(
      <TopicsSection
        keywords={keywords}
        totalAcceptedPubs={500}
        selectedUis={[selectedUi]}
        onToggle={noop}
        onClearAll={noop}
        facetRedesignEnabled
        topicCounts={new Map([[selectedUi, 6]])}
      />,
    );
    expect(screen.getByRole("button", { name: /Topic 1/ }).className).toContain(
      "facet-chip-transition",
    );
    expect(screen.getByRole("button", { name: /Topic 2/ }).className).toContain(
      "facet-chip-transition",
    );

    // Flag-off path stays byte-identical (no transition class).
    rerender(
      <TopicsSection
        keywords={keywords}
        totalAcceptedPubs={500}
        selectedUis={[selectedUi]}
        onToggle={noop}
        onClearAll={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /Topic 2/ }).className).not.toContain(
      "facet-chip-transition",
    );
  });
});
