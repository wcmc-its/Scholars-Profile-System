/**
 * Unit hero research-area pill + hover preview (Unit Page v2). Assertions are
 * scoped to the rendered container (the card is not portaled, so it renders
 * inside it). Fixtures are fake (public repo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, within } from "@testing-library/react";
import {
  AREA_PREVIEW_CLOSE_DELAY,
  AREA_PREVIEW_OPEN_DELAY,
  AreaPreviewPill,
} from "@/components/shared/area-preview-pill";
import type { UnitAreaPreview } from "@/lib/api/unit-area-previews";

const AREA = { topicId: "topic_x", topicLabel: "Example Area", topicSlug: "topic_x", pubCount: 1234 };

const PREVIEW: UnitAreaPreview = {
  total: 1234,
  papers: [
    {
      pmid: "100001",
      title: "Fake paper <i>one</i>",
      venue: "Journal of Examples",
      year: 2023,
      href: "https://doi.org/10.0000/fake.1",
      unitAuthorCount: 3,
    },
    {
      pmid: "100002",
      title: "Fake paper two",
      venue: null,
      year: 2021,
      href: "https://pubmed.ncbi.nlm.nih.gov/100002/",
      unitAuthorCount: 1,
    },
    {
      pmid: "100003",
      title: "Fake paper three",
      venue: "Example Letters",
      year: null,
      href: null,
      unitAuthorCount: 2,
    },
  ],
};

function renderPill(preview: UnitAreaPreview | null = PREVIEW) {
  const utils = render(
    <div>
      <AreaPreviewPill
        area={AREA}
        preview={preview}
        basePath="/departments/example"
        unitShort="Example"
        membersNoun="faculty"
      />
      <a href="/elsewhere">elsewhere</a>
    </div>,
  );
  const view = within(utils.container);
  const trigger = view.getByRole("link", { name: /Example Area/ });
  return { ...utils, view, trigger };
}

/** A touch on `el` that travels `dy` px vertically between start and end. */
function tap(el: HTMLElement, dy = 0) {
  fireEvent.touchStart(el, { touches: [{ clientX: 20, clientY: 20 }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 20, clientY: 20 + dy }] });
}

const card = (container: HTMLElement) => container.querySelector('[role="group"]');

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AreaPreviewPill", () => {
  it("is a link to /topics/{slug} with the count", () => {
    const { trigger } = renderPill();
    expect(trigger.tagName).toBe("A");
    expect(trigger.getAttribute("href")).toBe("/topics/topic_x");
    expect(trigger.textContent).toContain("1,234");
  });

  it("opens on focus after the 250ms delay with 3 papers, author counts and See all", async () => {
    const { container, trigger } = renderPill();
    act(() => trigger.focus());
    await advance(AREA_PREVIEW_OPEN_DELAY - 10);
    expect(card(container)).toBeNull();
    await advance(20);
    const c = card(container) as HTMLElement;
    expect(c).not.toBeNull();
    const inCard = within(c);
    expect(inCard.getByText("1,234 publications by Example faculty · most cited")).toBeTruthy();
    expect(c.querySelectorAll("li")).toHaveLength(3);
    expect(inCard.getByText("3 Example authors")).toBeTruthy();
    expect(inCard.getByText("1 Example author")).toBeTruthy();
    // Title markup is rendered, not escaped.
    expect(c.querySelector("li i")?.textContent).toBe("one");
    // Paper rows open the DOI / PubMed link in a new tab; no link → no anchor.
    const paperLinks = c.querySelectorAll('li a[target="_blank"]');
    expect(Array.from(paperLinks).map((a) => a.getAttribute("href"))).toEqual([
      "https://doi.org/10.0000/fake.1",
      "https://pubmed.ncbi.nlm.nih.gov/100002/",
    ]);
    const seeAll = inCard.getByRole("link", { name: /See all 1,234/ });
    expect(seeAll.getAttribute("href")).toBe(
      "/departments/example/areas/topic_x?sort=most_cited#people",
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the card's links in the tab order (Radix sets tabindex=-1)", async () => {
    const { container, trigger } = renderPill();
    act(() => trigger.focus());
    await advance(AREA_PREVIEW_OPEN_DELAY + 10);
    await act(async () => {
      await Promise.resolve();
    });
    const links = (card(container) as HTMLElement).querySelectorAll("a");
    expect(links.length).toBeGreaterThan(0);
    links.forEach((a) => expect(a.getAttribute("tabindex")).toBeNull());
  });

  it("closes 120ms after blur, but stays open while keyboard focus is inside the card", async () => {
    const { container, trigger, view } = renderPill();
    act(() => trigger.focus());
    await advance(AREA_PREVIEW_OPEN_DELAY + 10);
    const seeAll = within(card(container) as HTMLElement).getByRole("link", { name: /See all/ });

    // Keyboard Tab from the pill into the card.
    fireEvent.keyDown(trigger, { key: "Tab" });
    act(() => seeAll.focus());
    await advance(AREA_PREVIEW_CLOSE_DELAY + 50);
    expect(card(container)).not.toBeNull();

    // Focus leaves the card → it closes.
    act(() => view.getByRole("link", { name: "elsewhere" }).focus());
    await advance(AREA_PREVIEW_CLOSE_DELAY + 50);
    expect(card(container)).toBeNull();
  });

  it("closes after blur when focus goes elsewhere from the pill", async () => {
    const { container, trigger, view } = renderPill();
    act(() => trigger.focus());
    await advance(AREA_PREVIEW_OPEN_DELAY + 10);
    expect(card(container)).not.toBeNull();
    act(() => view.getByRole("link", { name: "elsewhere" }).focus());
    await advance(AREA_PREVIEW_CLOSE_DELAY - 20);
    expect(card(container)).not.toBeNull();
    await advance(40);
    expect(card(container)).toBeNull();
  });

  it("touch: first tap opens without navigating, second tap clicks the pill link", async () => {
    const { container, trigger } = renderPill();
    const clicks = vi.fn((e: MouseEvent) => e.preventDefault());
    trigger.addEventListener("click", clicks);

    tap(trigger);
    expect(card(container)).not.toBeNull();
    expect(clicks).not.toHaveBeenCalled();

    tap(trigger);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("touch: a scroll starting on the pill neither opens the card nor navigates", async () => {
    const { container, trigger } = renderPill();
    const clicks = vi.fn((e: MouseEvent) => e.preventDefault());
    trigger.addEventListener("click", clicks);

    tap(trigger, 30);
    expect(card(container)).toBeNull();

    // Even with the card already open, a swipe must not click through.
    tap(trigger);
    expect(card(container)).not.toBeNull();
    tap(trigger, 30);
    expect(clicks).not.toHaveBeenCalled();
    expect(card(container)).not.toBeNull();
  });

  it("touch: a cancelled touch does nothing", async () => {
    const { container, trigger } = renderPill();
    fireEvent.touchStart(trigger, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchCancel(trigger);
    fireEvent.touchEnd(trigger, { changedTouches: [{ clientX: 10, clientY: 10 }] });
    expect(card(container)).toBeNull();
  });

  it("Esc with focus inside the card returns focus to the pill and keeps the card closed", async () => {
    const { container, trigger } = renderPill();
    act(() => trigger.focus());
    await advance(AREA_PREVIEW_OPEN_DELAY + 10);
    const seeAll = within(card(container) as HTMLElement).getByRole("link", { name: /See all/ });
    fireEvent.keyDown(trigger, { key: "Tab" });
    act(() => seeAll.focus());
    fireEvent.keyDown(seeAll, { key: "Escape" });
    await advance(10);
    expect(card(container)).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // The pill's onFocus scheduled a Radix open; it must not re-show the card.
    await advance(AREA_PREVIEW_OPEN_DELAY + 50);
    expect(card(container)).toBeNull();
  });

  it("Esc closes the card", async () => {
    const { container, trigger } = renderPill();
    act(() => trigger.focus());
    await advance(AREA_PREVIEW_OPEN_DELAY + 10);
    expect(card(container)).not.toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await advance(10);
    expect(card(container)).toBeNull();
  });

  it("total 0 hides See all", async () => {
    const { container, trigger } = renderPill({ total: 0, papers: [] });
    act(() => trigger.focus());
    await advance(AREA_PREVIEW_OPEN_DELAY + 10);
    const c = card(container) as HTMLElement;
    expect(within(c).queryByRole("link", { name: /See all/ })).toBeNull();
  });

  it("without a preview renders the plain pill link and no card", async () => {
    const { container, trigger } = renderPill(null);
    expect(trigger.getAttribute("href")).toBe("/topics/topic_x");
    expect(trigger.hasAttribute("aria-expanded")).toBe(false);
    act(() => trigger.focus());
    await advance(AREA_PREVIEW_OPEN_DELAY + 10);
    expect(card(container)).toBeNull();
  });
});
