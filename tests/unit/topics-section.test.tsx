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
