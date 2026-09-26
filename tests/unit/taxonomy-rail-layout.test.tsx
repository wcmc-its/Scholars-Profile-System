/**
 * The shared `RailLayout` via the topic adapter (`TopicRailLayout`): the "All"
 * row and "Clear ×" both clear the selection, the selection is written to
 * `?subtopic=` with replaceState (and removed on clear), a `?subtopic=` deep
 * link preselects, and below lg the trigger bar opens a sheet whose pick
 * closes it and moves focus to the results region.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const mockGet = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
}));
vi.mock("@/components/taxonomy/publication-feed", () => ({
  TopicPublicationFeed: ({ activeSubtopic }: { activeSubtopic: string | null }) => (
    <div data-testid="feed">{activeSubtopic ?? "all"}</div>
  ),
}));
vi.mock("@/components/topic/subtopic-scholars-row", () => ({
  SubtopicScholarsRow: () => null,
}));

import { TopicRailLayout } from "@/components/topic/topic-rail-layout";

const subtopics = [
  { id: "s1", label: "Cardiac Surgery", displayName: "Cardiac Surgery", description: null, shortDescription: "Procedures on the heart", pubCount: 234 },
  { id: "s2", label: "Oncology", displayName: "Oncology", description: null, shortDescription: null, pubCount: 50 },
];

function desktopRail() {
  // The desktop rail and the (closed) sheet trigger both render in jsdom;
  // the desktop copy is the first "Subareas" landmark.
  return screen.getAllByRole("complementary", { name: "Subareas" })[0];
}

describe("RailLayout (topic)", () => {
  let replaceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGet.mockReset();
    window.history.replaceState(null, "", "/topics/cardio");
    replaceSpy = vi.spyOn(window.history, "replaceState");
    replaceSpy.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("preselects from a ?subtopic= deep link and scrolls to #publications once", async () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s2" : null));
    const target = document.createElement("div");
    target.id = "publications";
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    expect(screen.getByTestId("feed").textContent).toBe("s2");
    expect(screen.getByRole("heading", { level: 2, name: "Oncology" })).toBeTruthy();
    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalledTimes(1));
    target.remove();
  });

  it("subhead: red 'Subarea' eyebrow, serif regular title + Clear pill, muted description", () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    const head = screen.getByTestId("rail-subhead");
    const [eyebrow, row, desc] = Array.from(head.children) as HTMLElement[];
    expect(eyebrow.textContent).toBe("Subarea");
    expect(eyebrow.className).toContain("uppercase");
    expect(eyebrow.className).toContain("text-[var(--color-primary-cornell-red)]");
    expect(eyebrow.className).toContain("tracking-[0.1em]");
    // Mockup weight 600; `font-semibold` is remapped to 500 in globals.css.
    expect(eyebrow.className).toContain("font-[600]");
    expect(eyebrow.className).not.toContain("font-semibold");
    const h2 = within(row).getByRole("heading", { level: 2, name: "Cardiac Surgery" });
    expect(h2.className).toContain("font-serif");
    expect(h2.className).toContain("text-[28px]");
    expect(h2.className).toContain("font-normal");
    // The pill sits on the title row, beside the title.
    expect(within(row).getByRole("button", { name: /Clear Cardiac Surgery/ })).toBeTruthy();
    expect(desc.textContent).toBe("Procedures on the heart");
    expect(desc.className).toContain("text-muted-foreground");
  });

  it("no divider above the rail and no red rule on the results panel", () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    const { container } = render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    expect(container.querySelector("hr")).toBeNull();
    const results = document.getElementById("publications-results")!;
    expect(results.className).not.toMatch(/border-l|primary-cornell-red/);
  });

  it("ignores an unknown ?subtopic= value", () => {
    mockGet.mockReturnValue("nope");
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    expect(screen.getByTestId("feed").textContent).toBe("all");
  });

  it("writes ?subtopic= on select (keeping the hash) and removes it on clear", () => {
    mockGet.mockReturnValue(null);
    window.history.replaceState(null, "", "/topics/cardio#publications");
    replaceSpy.mockClear();
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    fireEvent.click(within(desktopRail()).getByText("Oncology"));
    expect(screen.getByTestId("feed").textContent).toBe("s2");
    expect(replaceSpy).toHaveBeenLastCalledWith(null, "", "/topics/cardio?subtopic=s2#publications");
    expect(window.location.search).toBe("?subtopic=s2");

    fireEvent.click(within(desktopRail()).getByText("All subareas"));
    expect(screen.getByTestId("feed").textContent).toBe("all");
    expect(replaceSpy).toHaveBeenLastCalledWith(null, "", "/topics/cardio#publications");
  });

  it("the 'All subareas' row shows the summed total and clears the selection", () => {
    mockGet.mockReturnValue("s1");
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    const all = within(desktopRail()).getByText("All subareas").closest("button")!;
    expect(all.textContent).toContain("284");
    expect(all.getAttribute("aria-current")).toBeNull();
    fireEvent.click(all);
    expect(screen.getByTestId("feed").textContent).toBe("all");
    expect(all.getAttribute("aria-current")).toBe("true");
  });

  it("Clear × in the subhead clears the selection and the URL", () => {
    mockGet.mockReturnValue("s1");
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    expect(screen.getByText("Procedures on the heart")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Clear Cardiac Surgery/ }));
    expect(screen.getByTestId("feed").textContent).toBe("all");
    expect(screen.queryByRole("heading", { level: 2, name: "Cardiac Surgery" })).toBeNull();
    expect(replaceSpy).toHaveBeenLastCalledWith(null, "", "/topics/cardio");
  });

  it("Clear × moves focus to the named results region and announces, not to <body>", () => {
    mockGet.mockReturnValue("s1");
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    const clear = screen.getByRole("button", { name: /^Clear Cardiac Surgery/ });
    clear.focus();
    fireEvent.click(clear);
    const results = screen.getByRole("region", { name: "Results: All subareas" });
    expect(results.id).toBe("publications-results");
    expect(document.activeElement).toBe(results);
    expect(screen.getByRole("status").textContent).toBe("Showing all subareas");
  });

  it("mobile: opening the sheet focuses the current row, not the filter input", async () => {
    mockGet.mockReturnValue("s2");
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    fireEvent.click(screen.getByTestId("taxonomy-rail-trigger"));
    const dialog = screen.getByRole("dialog");
    const current = within(dialog).getByText("Oncology").closest("button")!;
    await waitFor(() => expect(document.activeElement).toBe(current));
  });

  it("mobile: the sheet closes when the viewport grows past lg", async () => {
    mockGet.mockReturnValue(null);
    let listener: (() => void) | null = null;
    const mq = {
      matches: false,
      addEventListener: (_: string, cb: () => void) => {
        listener = cb;
      },
      removeEventListener: () => {
        listener = null;
      },
    };
    const orig = window.matchMedia;
    window.matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia;
    try {
      render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
      fireEvent.click(screen.getByTestId("taxonomy-rail-trigger"));
      expect(screen.getByRole("dialog")).toBeTruthy();
      mq.matches = true;
      act(() => listener?.());
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      window.matchMedia = orig;
    }
  });

  it("mobile: the trigger count carries a screen-reader unit", () => {
    mockGet.mockReturnValue(null);
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    expect(screen.getByTestId("taxonomy-rail-trigger").textContent).toContain("284 publications");
  });

  it("does not scroll when the selection comes from a rail click", async () => {
    mockGet.mockReturnValue(null);
    // Drain deep-link scroll frames still queued by earlier tests' mounts.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const target = document.createElement("div");
    target.id = "publications";
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    const { rerender } = render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    fireEvent.click(within(desktopRail()).getByText("Oncology"));
    // Next syncs useSearchParams from replaceState; simulate that re-render.
    mockGet.mockReturnValue("s2");
    rerender(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    target.remove();
  });

  it("mobile: the trigger names the state, opens the sheet, and a pick closes it and focuses results", async () => {
    mockGet.mockReturnValue(null);
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    const trigger = screen.getByTestId("taxonomy-rail-trigger");
    expect(trigger.textContent).toContain("Subarea");
    expect(trigger.textContent).toContain("All subareas");
    expect(trigger.textContent).toContain("284");
    expect(trigger.textContent).toContain("Change");

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    // The sheet copy uses suffixed ids.
    expect(dialog.querySelector("#taxonomy-rail-filter-sheet")).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Oncology"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("feed").textContent).toBe("s2");
    const results = document.getElementById("publications-results")!;
    await waitFor(() => expect(document.activeElement).toBe(results));
    expect(screen.getByRole("status").textContent).toBe("Showing Oncology");
    expect(screen.getByTestId("taxonomy-rail-trigger").textContent).toContain("Oncology");
    expect(screen.getByTestId("taxonomy-rail-trigger").textContent).toContain("50");
  });

  it("mobile: the sheet and desktop rail share one filter", () => {
    mockGet.mockReturnValue(null);
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    fireEvent.change(within(desktopRail()).getByPlaceholderText("Filter subareas…"), {
      target: { value: "onc" },
    });
    fireEvent.click(screen.getByTestId("taxonomy-rail-trigger"));
    const dialog = screen.getByRole("dialog");
    expect((dialog.querySelector("#taxonomy-rail-filter-sheet") as HTMLInputElement).value).toBe(
      "onc",
    );
    expect(within(dialog).queryByText("Cardiac Surgery")).toBeNull();
  });

  it("renders the feed full-width with no rail or trigger when there are no subtopics", () => {
    mockGet.mockReturnValue(null);
    render(<TopicRailLayout topicSlug="cardio" subtopics={[]} />);
    expect(screen.queryByTestId("taxonomy-rail-trigger")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByTestId("feed")).toBeTruthy();
  });
});
