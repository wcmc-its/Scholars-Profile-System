/**
 * `components/edit/reports/report-ui.tsx` and `report-show-more.ts` — the
 * shared pieces of the redesigned report bodies. Protects: a rail section is
 * a native <details> whose inputs stay in the DOM when collapsed (so a GET
 * form still submits them); the reset link is disabled with nothing to
 * reset; chips link to the URL without their filter, and a chip with no
 * removeHref has no remove control; the stats render value + label pairs;
 * useShowMore pages by `step` and resets when the rows change.
 */
import { act, cleanup, render, renderHook, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FilterChips, RailSection, ReportRail, ReportStats } from "@/components/edit/reports/report-ui";
import { useShowMore } from "@/components/edit/reports/report-show-more";

afterEach(cleanup);

describe("report-ui", () => {
  it("a collapsed rail section keeps its inputs in the form", () => {
    const { container } = render(
      <form data-testid="f">
        <ReportRail resetHref={null}>
          <RailSection label="Years" summary="2022–2026 · Calendar" testId="years">
            <input name="from" defaultValue="2022" />
          </RailSection>
        </ReportRail>
      </form>,
    );
    const q = within(container);
    const section = q.getByTestId("years");
    expect(section.tagName).toBe("DETAILS");
    expect(section.hasAttribute("open")).toBe(false);
    expect(new FormData(q.getByTestId("f") as HTMLFormElement).get("from")).toBe("2022");
    expect(section.querySelector("summary")?.textContent).toContain("2022–2026 · Calendar");
  });

  it("the reset link: disabled with nothing to reset, a link otherwise", () => {
    const { container, rerender } = render(<ReportRail resetHref={null}>x</ReportRail>);
    expect(within(container).queryByRole("link", { name: "Reset to defaults" })).toBeNull();
    rerender(<ReportRail resetHref="/edit/reports/article-count">x</ReportRail>);
    expect(within(container).getByRole("link", { name: "Reset to defaults" }).getAttribute("href")).toBe(
      "/edit/reports/article-count",
    );
  });

  it("chips link to the URL without their filter; a fixed chip has no remove", () => {
    const { container } = render(
      <FilterChips
        chips={[
          { group: "Years", value: "2026", removeHref: null },
          { group: "Author", value: "First or last author", removeHref: "/r?from=2026" },
        ]}
      />,
    );
    const q = within(container);
    expect(q.getByRole("link", { name: "Remove Author: First or last author" }).getAttribute("href")).toBe(
      "/r?from=2026",
    );
    expect(q.queryByRole("link", { name: "Remove Years: 2026" })).toBeNull();
    expect(render(<FilterChips chips={[]} />).container.innerHTML).toBe("");
  });

  it("stats render value + label pairs", () => {
    const { container } = render(<ReportStats stats={[{ value: "69", label: "scholars" }]} />);
    const dd = container.querySelector("dd");
    expect(dd?.textContent).toBe("69");
    expect(container.querySelector("dt")?.textContent).toBe("scholars");
  });

  it("useShowMore pages by step and resets when the rows change", () => {
    const rows = Array.from({ length: 60 }, (_, i) => i);
    const { result, rerender } = renderHook(({ r }) => useShowMore(r, 25), { initialProps: { r: rows } });
    expect(result.current.visible).toHaveLength(25);
    expect(result.current.rangeLabel).toBe("Showing 25 of 60");
    act(() => result.current.showMore());
    act(() => result.current.showMore());
    expect(result.current.visible).toHaveLength(60);
    expect(result.current.hasMore).toBe(false);
    rerender({ r: rows.slice(0, 40) });
    expect(result.current.visible).toHaveLength(25);
  });

  it("useShowMore with a resetKey keeps its page across new row arrays and resets on a new key", () => {
    const rows = Array.from({ length: 60 }, (_, i) => i);
    const { result, rerender } = renderHook(({ r, k }) => useShowMore(r, 25, k), {
      initialProps: { r: rows, k: "a" },
    });
    act(() => result.current.showMore());
    expect(result.current.visible).toHaveLength(50);
    rerender({ r: [...rows], k: "a" }); // a refresh: same filters, new array
    expect(result.current.visible).toHaveLength(50);
    rerender({ r: [...rows], k: "b" }); // a new filter
    expect(result.current.visible).toHaveLength(25);
  });
});
