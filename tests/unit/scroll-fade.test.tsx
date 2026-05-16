import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ScrollFade } from "@/components/ui/scroll-fade";

// Issue #339 — ScrollFade overlays a bottom fade on a clipped sidebar. The
// fade shows only while the content overflows the viewport and hides once
// the user reaches the end.
//
// jsdom has no ResizeObserver and computes no layout, so we stub the observer
// and drive overflow state by mocking the viewport's scroll metrics directly.

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

/** Mock the layout metrics jsdom does not compute, then notify the component. */
function setMetrics(
  el: HTMLElement,
  m: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", {
    value: m.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: m.clientHeight,
    configurable: true,
  });
  Object.defineProperty(el, "scrollTop", {
    value: m.scrollTop,
    configurable: true,
  });
  fireEvent.scroll(el);
}

describe("ScrollFade — bottom fade on clipped sidebars (issue #339)", () => {
  it("renders its children inside the viewport", () => {
    const { getByText } = render(
      <ScrollFade>
        <p>rail content</p>
      </ScrollFade>,
    );
    expect(getByText("rail content")).toBeDefined();
  });

  it("applies viewportClassName to the scroll viewport", () => {
    const { container } = render(
      <ScrollFade viewportClassName="vp-test">
        <p>x</p>
      </ScrollFade>,
    );
    expect(container.querySelector(".vp-test")).not.toBeNull();
  });

  it("renders the fade as an inert, decorative ~40px gradient overlay", () => {
    const { container } = render(
      <ScrollFade>
        <p>x</p>
      </ScrollFade>,
    );
    const fade = container.querySelector('[aria-hidden="true"]');
    expect(fade).not.toBeNull();
    const cls = fade!.className;
    expect(cls).toContain("pointer-events-none");
    expect(cls).toContain("absolute");
    expect(cls).toContain("bottom-0");
    expect(cls).toContain("h-10"); // ~40px
    expect(cls).toContain("bg-gradient-to-t");
  });

  it("hides the fade when the content is not clipped", () => {
    const { container } = render(
      <ScrollFade>
        <p>x</p>
      </ScrollFade>,
    );
    // jsdom reports 0/0 metrics on mount → nothing overflows.
    const fade = container.querySelector('[aria-hidden="true"]')!;
    expect(fade.className).toContain("opacity-0");
    expect(fade.className).not.toContain("opacity-100");
  });

  it("shows the fade when content overflows and the user is not at the bottom", () => {
    const { container } = render(
      <ScrollFade viewportClassName="vp-test">
        <p>x</p>
      </ScrollFade>,
    );
    const viewport = container.querySelector(".vp-test") as HTMLElement;
    const fade = container.querySelector('[aria-hidden="true"]')!;
    setMetrics(viewport, { scrollHeight: 800, clientHeight: 300, scrollTop: 0 });
    expect(fade.className).toContain("opacity-100");
  });

  it("hides the fade once the user scrolls to the bottom", () => {
    const { container } = render(
      <ScrollFade viewportClassName="vp-test">
        <p>x</p>
      </ScrollFade>,
    );
    const viewport = container.querySelector(".vp-test") as HTMLElement;
    const fade = container.querySelector('[aria-hidden="true"]')!;
    setMetrics(viewport, { scrollHeight: 800, clientHeight: 300, scrollTop: 100 });
    expect(fade.className).toContain("opacity-100");
    // scrollTop + clientHeight === scrollHeight → the end of the list.
    setMetrics(viewport, { scrollHeight: 800, clientHeight: 300, scrollTop: 500 });
    expect(fade.className).toContain("opacity-0");
  });
});
