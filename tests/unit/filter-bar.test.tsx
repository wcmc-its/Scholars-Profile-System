import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterBar } from "@/components/profile/filter-bar";

const topic = (ui: string, label: string) => ({ ui, label });
const family = (familyId: string, familyLabel: string) => ({ familyId, familyLabel });

describe("FilterBar", () => {
  it("returns null when no topics and no families are selected", () => {
    const { container } = render(
      <FilterBar
        topics={[]}
        families={[]}
        count={0}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
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
        count={6}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
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
        count={6}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
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
        count={1}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
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
        count={6}
        onRemoveTopic={onRemoveTopic}
        onRemoveFamily={() => {}}
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
        count={6}
        onRemoveTopic={() => {}}
        onRemoveFamily={onRemoveFamily}
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
        count={3}
        onRemoveTopic={() => {}}
        onRemoveFamily={() => {}}
        onClearAll={onClearAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAll).toHaveBeenCalledOnce();
  });
});
