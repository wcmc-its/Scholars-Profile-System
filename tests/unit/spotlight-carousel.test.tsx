/**
 * Topic-page Spotlight paging (`paged`): a pool of up to 9 cards shown 3 at a
 * time, "n of m" position (a polite live region) + Previous / Next round
 * buttons that wrap around. Hidden when the pool is 3 or fewer; the unit
 * variant and unpaged callers render exactly as before. Fake data only.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Spotlight } from "@/components/shared/spotlight";
import { PublicationModalProvider } from "@/components/publication/publication-modal";
import type { SpotlightData } from "@/lib/api/spotlight";

function data(n: number): SpotlightData {
  return {
    totalCount: 500,
    viewAllHref: "#publications",
    cards: Array.from({ length: n }, (_, i) => ({
      pmid: `9100${i}`,
      kicker: `Kicker ${i + 1}`,
      kickerHref: null,
      title: `Card title ${i + 1}`,
      journal: "Journal",
      year: 2025,
      pubmedUrl: null,
      doi: null,
      authors: [],
    })),
  };
}

function renderSpot(n: number, props: { paged?: boolean; variant?: "default" | "unit" } = {}) {
  return render(
    <PublicationModalProvider>
      <Spotlight data={data(n)} {...props} />
    </PublicationModalProvider>,
  );
}

const titles = () =>
  screen.getAllByRole("button", { name: /^Card title/ }).map((b) => b.textContent);

describe("Spotlight paging (topic)", () => {
  it("shows the first 3 of 9 with '1 of 3' and round Previous / Next buttons", () => {
    renderSpot(9, { paged: true });
    expect(titles()).toEqual(["Card title 1", "Card title 2", "Card title 3"]);
    const pos = screen.getByTestId("spotlight-position");
    expect(pos.textContent).toBe("Spotlight page 1 of 3");
    expect(pos.getAttribute("aria-live")).toBe("polite");
    const prev = screen.getByRole("button", { name: "Previous" });
    const next = screen.getByRole("button", { name: "Next" });
    for (const b of [prev, next]) {
      expect(b.className).toContain("rounded-full");
      expect(b.className).toContain("size-[34px]");
      // 44px target on a coarse (touch) pointer.
      expect(b.className).toContain("pointer-coarse:size-11");
    }
    // The (i) info button is still there, beside the title.
    const h2 = screen.getByRole("heading", { level: 2, name: /Spotlight/ });
    expect(within(h2).getByRole("button", { name: "About Spotlight" })).toBeTruthy();
  });

  it("Next pages forward and wraps from the last page to the first", () => {
    renderSpot(9, { paged: true });
    const next = screen.getByRole("button", { name: "Next" });
    fireEvent.click(next);
    expect(titles()).toEqual(["Card title 4", "Card title 5", "Card title 6"]);
    expect(screen.getByTestId("spotlight-position").textContent).toContain("2 of 3");
    fireEvent.click(next);
    fireEvent.click(next);
    expect(titles()).toEqual(["Card title 1", "Card title 2", "Card title 3"]);
    expect(screen.getByTestId("spotlight-position").textContent).toContain("1 of 3");
  });

  it("Previous from the first page wraps to the last (a partial page)", () => {
    renderSpot(7, { paged: true });
    expect(screen.getByTestId("spotlight-position").textContent).toContain("1 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(titles()).toEqual(["Card title 7"]);
    expect(screen.getByTestId("spotlight-position").textContent).toContain("3 of 3");
  });

  it("the buttons are keyboard-operable native buttons (Enter / Space activate them)", () => {
    renderSpot(6, { paged: true });
    const next = screen.getByRole("button", { name: "Next" });
    expect(next.tagName).toBe("BUTTON");
    expect(next.getAttribute("type")).toBe("button");
    next.focus();
    expect(document.activeElement).toBe(next);
  });

  it.each([1, 2, 3])("renders no pager with %i card(s)", (n) => {
    renderSpot(n, { paged: true });
    expect(screen.queryByTestId("spotlight-pager")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(titles()).toHaveLength(n);
  });

  it("unpaged callers are unchanged: no pager even with more than 3 cards", () => {
    renderSpot(5);
    expect(screen.queryByTestId("spotlight-pager")).toBeNull();
    expect(titles()).toHaveLength(5);
  });

  it("the unit variant ignores `paged` (no pager, all cards)", () => {
    renderSpot(6, { paged: true, variant: "unit" });
    expect(screen.queryByTestId("spotlight-pager")).toBeNull();
    expect(titles()).toHaveLength(6);
  });
});
