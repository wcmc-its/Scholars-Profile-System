/**
 * `components/edit/reports/rail-checklist.tsx` — the long checkbox list in a
 * report rail's GET form (report 7's Publication year and Mentor). Native
 * `name=value` checkboxes (so the form submits them); the cap hides options
 * with `hidden` but never a CHECKED one; the search box narrows without
 * submitting (its change never reaches the form); counts under the column
 * label. Queries are scoped to the render container.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";

import { RailChecklist } from "@/components/edit/reports/rail-checklist";

const OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: `men${String(i).padStart(4, "0")}`,
  label: `Mentor ${String.fromCharCode(65 + i)}`,
  count: 12 - i,
}));

function renderList(selected: string[] = [], onFormChange = vi.fn()) {
  const utils = render(
    <form onChange={onFormChange} data-testid="host">
      <RailChecklist
        name="mentor"
        options={OPTIONS}
        selected={selected}
        countLabel="Learners"
        collapseAfter={8}
        searchPlaceholder="Search mentors…"
        testId="list"
      />
    </form>,
  );
  const list = utils.getByTestId("list");
  const shown = () =>
    [...list.querySelectorAll("li")].filter((li) => !li.hidden).map((li) => li.querySelector("input")!.value);
  return { ...utils, list, shown, onFormChange };
}

describe("RailChecklist", () => {
  it("native name=value checkboxes, checked from `selected`; the first 8, plus any checked one past the cap", () => {
    const { list, shown } = renderList(["men0010"]);
    const boxes = [...list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(12);
    expect(boxes.every((b) => b.name === "mentor")).toBe(true);
    expect(boxes.filter((b) => b.checked).map((b) => b.value)).toEqual(["men0010"]);
    expect(shown()).toEqual([...OPTIONS.slice(0, 8).map((o) => o.value), "men0010"]);
    expect(list.textContent).toContain("Learners");
    expect(within(list).getByText("Mentor A").closest("label")!.textContent).toBe("Mentor A12");
  });

  it("an option with a title is a short name: dotted underline, the full name on hover or focus, still one labelled checkbox", () => {
    const { container } = render(
      <RailChecklist
        name="body"
        options={[
          { value: "EXA", label: "EXA", title: "Example Agency (US)", count: 7 },
          { value: "plain", label: "Plain option", count: 1 },
        ]}
        selected={[]}
      />,
    );
    const q = within(container);
    const abbr = container.querySelector("abbr")!;
    expect(container.querySelectorAll("abbr")).toHaveLength(1);
    expect(abbr.textContent).toBe("EXA");
    expect(abbr.getAttribute("title")).toBe("Example Agency (US)");
    expect(abbr.className).toContain("border-dotted");
    expect(q.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(abbr);
    expect(q.getByRole("tooltip").textContent).toBe("Example Agency (US)");
    // The rail is narrow and clips: the tooltip wraps from the label's left edge.
    expect(q.getByRole("tooltip").className).toContain("whitespace-normal");
    expect(q.getByRole("tooltip").className).not.toContain("-translate-x-1/2");
    expect(abbr.closest("label")!.textContent).toBe("EXAExample Agency (US)7");
    fireEvent.blur(abbr);
    expect(abbr.closest("label")!.textContent).toBe("EXA7");
    expect(abbr.closest("label")!.querySelector("input")!.value).toBe("EXA");
  });

  it("Show all / Show fewer toggles the cap", () => {
    const { list, shown } = renderList();
    fireEvent.click(within(list).getByRole("button", { name: "Show all 12" }));
    expect(shown()).toHaveLength(12);
    fireEvent.click(within(list).getByRole("button", { name: "Show fewer" }));
    expect(shown()).toHaveLength(8);
  });

  it("the search narrows by label without submitting the form; a checked option stays visible", () => {
    const { list, shown, onFormChange } = renderList(["men0000"]);
    fireEvent.change(within(list).getByRole("searchbox", { name: "Search mentors…" }), { target: { value: "mentor k" } });
    expect(shown()).toEqual(["men0000", "men0010"]);
    expect(onFormChange).not.toHaveBeenCalled();
    fireEvent.change(within(list).getByRole("searchbox"), { target: { value: "zzz" } });
    expect(shown()).toEqual(["men0000"]);
    // A tick DOES reach the form (that is what auto-submits it).
    fireEvent.click(list.querySelector<HTMLInputElement>('input[value="men0000"]')!);
    expect(onFormChange).toHaveBeenCalledTimes(1);
  });

  it("a search matching nothing (and nothing checked) says so", () => {
    const { list } = renderList();
    fireEvent.change(within(list).getByRole("searchbox"), { target: { value: "zzz" } });
    expect(list.textContent).toContain("No matches.");
  });

  it("options without a count and no countLabel → no count column", () => {
    const { getByTestId } = render(
      <RailChecklist name="journal" options={[{ value: "cell", label: "Cell" }]} selected={[]} testId="list" />,
    );
    expect(getByTestId("list").textContent).toBe("Cell");
  });

  it("no options → a short note, no list", () => {
    const { getByTestId } = render(
      <div data-testid="host">
        <RailChecklist name="pubyear" options={[]} selected={[]} countLabel="Publications" />
      </div>,
    );
    expect(getByTestId("host").textContent).toBe("None in this selection.");
  });
});
