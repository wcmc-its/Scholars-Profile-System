import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

import { DocsMobileNav, type NavGroup } from "@/components/docs/docs-toc";

/**
 * #571 — the mobile / tablet "On this page" section nav for /about. Below the
 * lg breakpoint the desktop sidebar is hidden, so this sticky bar is the only
 * way to jump between sections and see where you are.
 */

const NAV: NavGroup[] = [
  {
    group: "Start",
    items: [
      { id: "start", label: "The one thing first" },
      { id: "who", label: "Which of these are you?" },
    ],
  },
  { group: "Reference", items: [{ id: "impact", label: "The Impact score" }] },
  { group: "", items: [{ id: "glossary", label: "Glossary" }] },
];

const TRIGGER = { name: "Jump to section" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocsMobileNav — collapsed state", () => {
  it("renders an 'On this page' trigger, collapsed, naming the first section by default", () => {
    // jsdom has no IntersectionObserver, so the scroll-spy reports no active
    // section and the bar falls back to the first section's label.
    render(<DocsMobileNav nav={NAV} />);

    const trigger = screen.getByRole("button", TRIGGER);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("On this page")).toBeTruthy();
    expect(trigger.textContent).toContain("The one thing first");

    // Section links are not mounted while collapsed.
    expect(screen.queryByRole("link", { name: "The Impact score" })).toBeNull();
  });
});

describe("DocsMobileNav — expanded state", () => {
  it("on open, surfaces every section as an anchor link to its #id", () => {
    render(<DocsMobileNav nav={NAV} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));

    expect(screen.getByRole("button", TRIGGER).getAttribute("aria-expanded")).toBe("true");

    const expected: Array<[string, string]> = [
      ["The one thing first", "#start"],
      ["Which of these are you?", "#who"],
      ["The Impact score", "#impact"],
      ["Glossary", "#glossary"],
    ];
    for (const [label, href] of expected) {
      expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(href);
    }
  });

  it("closes when a section link is chosen", () => {
    render(<DocsMobileNav nav={NAV} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));

    fireEvent.click(screen.getByRole("link", { name: "The Impact score" }));

    expect(screen.getByRole("button", TRIGGER).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "The Impact score" })).toBeNull();
  });
});

describe("DocsMobileNav — scroll-spy", () => {
  it("names the in-view section and marks its link aria-current", () => {
    // Stub IntersectionObserver so we can drive which section is "in view".
    let fire: ((id: string) => void) | null = null;
    class MockIO {
      private observed: Element[] = [];
      constructor(private cb: IntersectionObserverCallback) {
        fire = (id: string) => {
          const target = this.observed.find((e) => (e as HTMLElement).id === id);
          if (!target) return;
          this.cb(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        };
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", MockIO);

    render(
      <>
        {/* Section targets the observer resolves via getElementById. */}
        <div id="start" />
        <div id="who" />
        <div id="impact" />
        <div id="glossary" />
        <DocsMobileNav nav={NAV} />
      </>,
    );

    act(() => fire?.("impact"));

    // The bar's collapsed label tracks the in-view section.
    expect(screen.getByRole("button", TRIGGER).textContent).toContain("The Impact score");

    // And inside the expanded menu, that section's link is the current one.
    fireEvent.click(screen.getByRole("button", TRIGGER));
    expect(
      screen.getByRole("link", { name: "The Impact score" }).getAttribute("aria-current"),
    ).toBe("location");
    expect(screen.getByRole("link", { name: "Glossary" }).getAttribute("aria-current")).toBeNull();
  });
});
