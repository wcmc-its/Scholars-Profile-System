import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActiveFilterBanner } from "@/components/profile/active-filter-banner";

const k = (descriptorUi: string, displayLabel: string) => ({
  descriptorUi,
  displayLabel,
  pubCount: 0,
});

describe("ActiveFilterBanner", () => {
  it("renders nothing when no keywords selected", () => {
    const { container } = render(
      <ActiveFilterBanner count={0} selected={[]} onClearAll={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("single-keyword copy uses 'using <label>' and 'Clear filter' button", () => {
    render(
      <ActiveFilterBanner
        count={140}
        selected={[k("D015316", "Genetic Therapy")]}
        onClearAll={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent ?? "").toMatch(
      /Filtered to\s*140\s*publications\s*using\s*Genetic Therapy/,
    );
    expect(screen.getByRole("button", { name: "Clear filter" })).toBeTruthy();
  });

  it("two-keyword copy uses 'A or B' and 'Clear all'", () => {
    render(
      <ActiveFilterBanner
        count={252}
        selected={[k("D015316", "Genetic Therapy"), k("D008168", "Lung")]}
        onClearAll={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent ?? "").toMatch(
      /Genetic Therapy\s*or\s*Lung/,
    );
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });

  it("three+ keyword copy uses 'any of: A, B, C'", () => {
    render(
      <ActiveFilterBanner
        count={300}
        selected={[
          k("D1", "Alpha"),
          k("D2", "Beta"),
          k("D3", "Gamma"),
        ]}
        onClearAll={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent ?? "").toMatch(
      /any of:\s*Alpha,\s*Beta,\s*Gamma/,
    );
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });

  it("invokes onClearAll when the button is clicked", () => {
    const onClearAll = vi.fn();
    render(
      <ActiveFilterBanner
        count={140}
        selected={[k("D015316", "Genetic Therapy")]}
        onClearAll={onClearAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it("uses 'publication' (singular) when count is 1", () => {
    render(
      <ActiveFilterBanner
        count={1}
        selected={[k("D1", "Alpha")]}
        onClearAll={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent ?? "").toMatch(/1\s*publication\b/);
  });

  it("renders position-only filter without a topic segment", () => {
    render(
      <ActiveFilterBanner
        count={138}
        selected={[]}
        positions={["senior"]}
        onClearAll={() => {}}
      />,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/Filtered to\s*138\s*publications/);
    expect(text).toMatch(/·\s*Senior author/);
    expect(text).not.toMatch(/using/);
    expect(screen.getByRole("button", { name: "Clear filter" })).toBeTruthy();
  });

  it("composes one topic + position into 'using <kw> · <pos>'", () => {
    render(
      <ActiveFilterBanner
        count={119}
        selected={[k("D015316", "Genetic Therapy")]}
        positions={["senior"]}
        onClearAll={() => {}}
      />,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/using\s*Genetic Therapy\s*·\s*Senior author/);
    // Two filter chips active → 'Clear all', not 'Clear filter'
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });

  it("composes two topics + position", () => {
    render(
      <ActiveFilterBanner
        count={50}
        selected={[k("D1", "Alpha"), k("D2", "Beta")]}
        positions={["first"]}
        onClearAll={() => {}}
      />,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/Alpha\s*or\s*Beta\s*·\s*First author/);
  });

  it("renders nothing when neither topic nor position filter is active", () => {
    const { container } = render(
      <ActiveFilterBanner count={140} selected={[]} positions={[]} onClearAll={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
