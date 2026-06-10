import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterBar } from "@/components/profile/filter-bar";

const topic = (ui: string, label: string) => ({ ui, label });
const family = (familyId: string, familyLabel: string) => ({ familyId, familyLabel });
const position = (bucket: "first" | "senior" | "co_author", label: string) => ({ bucket, label });

describe("FilterBar", () => {
  it("returns null when no topics, families, or positions are selected", () => {
    const { container } = render(
      <FilterBar
        topics={[]}
        families={[]}
        positions={[]}
        count={0}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a topic chip and a method chip with their labels", () => {
    render(
      <FilterBar
        topics={[topic("D010166", "Palliative Care")]}
        families={[family("fam_1", "Psychometric rating scales")]}
        positions={[]}
        count={6}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Palliative Care");
    expect(text).toContain("Psychometric rating scales");
  });

  it("renders the count and a Clear all action", () => {
    render(
      <FilterBar
        topics={[topic("D010166", "Palliative Care")]}
        families={[]}
        positions={[]}
        count={6}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent ?? "").toMatch(/6\s*publications/);
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });

  it("uses singular 'publication' when count is 1", () => {
    render(
      <FilterBar
        topics={[topic("D1", "Alpha")]}
        families={[]}
        positions={[]}
        count={1}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/1\s*publication(?!s)/);
  });

  it("fires onRemoveTopic with the topic ui from the per-chip remove button", () => {
    const onRemoveTopic = vi.fn();
    render(
      <FilterBar
        topics={[topic("D010166", "Palliative Care")]}
        families={[family("fam_1", "Psychometric rating scales")]}
        positions={[]}
        count={6}
        onRemoveTopic={onRemoveTopic}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Palliative Care filter" }));
    expect(onRemoveTopic).toHaveBeenCalledExactlyOnceWith("D010166");
  });

  it("fires onRemoveFamily with the familyId from the per-chip remove button", () => {
    const onRemoveFamily = vi.fn();
    render(
      <FilterBar
        topics={[topic("D010166", "Palliative Care")]}
        families={[family("fam_1", "Psychometric rating scales")]}
        positions={[]}
        count={6}
        onRemoveTopic={() => {}}
        onRemoveFamily={onRemoveFamily}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Psychometric rating scales filter" }),
    );
    expect(onRemoveFamily).toHaveBeenCalledExactlyOnceWith("fam_1");
  });

  it("fires onClearAll when Clear all is clicked", () => {
    const onClearAll = vi.fn();
    render(
      <FilterBar
        topics={[topic("D1", "Alpha")]}
        families={[]}
        positions={[]}
        count={3}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={onClearAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  // #12 — Position surfaced as a third-hue chip in the bar.
  it("renders a position chip with its label (the third facet)", () => {
    render(
      <FilterBar
        topics={[]}
        families={[]}
        positions={[position("senior", "Senior author")]}
        count={4}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent ?? "").toContain("Senior author");
  });

  it("renders the bar when ONLY a position chip is present (guard includes positions)", () => {
    const { container } = render(
      <FilterBar
        topics={[]}
        families={[]}
        positions={[position("first", "First author")]}
        count={2}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByRole("status").textContent ?? "").toContain("First author");
  });

  it("fires onRemovePosition with the bucket from the per-chip remove button", () => {
    const onRemovePosition = vi.fn();
    render(
      <FilterBar
        topics={[]}
        families={[]}
        positions={[position("co_author", "Co-author")]}
        count={5}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={onRemovePosition}
        onClearAll={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Co-author filter" }));
    expect(onRemovePosition).toHaveBeenCalledExactlyOnceWith("co_author");
  });

  // #17 — count-bump confirmation (no-latency, generation-keyed).
  it("bumps the count number when countGeneration > 0", () => {
    const { container } = render(
      <FilterBar
        topics={[topic("D1", "Alpha")]}
        families={[]}
        positions={[]}
        count={6}
        countGeneration={1}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    const bumped = container.querySelector(".facet-count-bump");
    expect(bumped).not.toBeNull();
    expect(bumped?.textContent).toBe("6");
  });

  it("does NOT bump on first paint (generation 0) or when countGeneration is omitted", () => {
    const { container, rerender } = render(
      <FilterBar
        topics={[topic("D1", "Alpha")]}
        families={[]}
        positions={[]}
        count={6}
        countGeneration={0}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    expect(container.querySelector(".facet-count-bump")).toBeNull();

    // Omitting countGeneration (existing callers) must not throw and must not bump.
    rerender(
      <FilterBar
        topics={[topic("D1", "Alpha")]}
        families={[]}
        positions={[]}
        count={6}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onRemovePosition={() => {}}
        onClearAll={() => {}}
      />,
    );
    expect(container.querySelector(".facet-count-bump")).toBeNull();
    expect(screen.getByRole("status").textContent ?? "").toMatch(/6\s*publications/);
  });
});
