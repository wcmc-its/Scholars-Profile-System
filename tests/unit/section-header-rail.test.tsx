/**
 * The section-header rail contract.
 *
 * The rail carries AT MOST one scalar and AT MOST one action. `count` is typed
 * `{ value: number; unit: string }` — not a ReactNode — so a compound fact like
 * "92 total · 20 active" cannot be expressed there at all. TypeScript enforces
 * that half; these tests pin the two runtime properties a type cannot:
 *
 *   1. The scalar renders BARE ("923") but still carries its noun for assistive
 *      tech. A naked numeral is announced as a naked numeral.
 *   2. The count lives OUTSIDE the <h2>, so headings stop announcing themselves
 *      as "Mentoring 26 mentees".
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Section } from "@/components/profile/profile-view";

describe("Section header rail", () => {
  it("renders the scalar bare, but names its unit for screen readers", () => {
    render(
      <Section title="Publications" headingLg count={{ value: 923, unit: "publications" }}>
        <div />
      </Section>,
    );
    // Visually a bare numeral...
    const scalar = screen.getByText("923");
    expect(scalar).toBeTruthy();
    // ...but the accessible text still carries the noun.
    expect(scalar.textContent).toContain("publications");
    expect(scalar.querySelector(".sr-only")?.textContent?.trim()).toBe("publications");
  });

  it("keeps the count OUT of the heading, so the h2 announces only its name", () => {
    render(
      <Section title="Mentoring" headingLg count={{ value: 26, unit: "mentees" }}>
        <div />
      </Section>,
    );
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2.textContent).toBe("Mentoring");
    expect(within(h2).queryByText("26")).toBeNull();
  });

  it("thousands-separates the scalar", () => {
    render(
      <Section title="Publications" headingLg count={{ value: 1234, unit: "publications" }}>
        <div />
      </Section>,
    );
    expect(screen.getByText("1,234")).toBeTruthy();
  });

  it("renders the rail with a scalar alone, an action alone, or neither", () => {
    const { rerender, container } = render(
      <Section title="Clinical trials" headingLg count={{ value: 1, unit: "clinical trial" }}>
        <div />
      </Section>,
    );
    expect(screen.getByText("1")).toBeTruthy();

    rerender(
      <Section title="Methods" headingLg headerAction={<a href="/m">Browse all</a>}>
        <div />
      </Section>,
    );
    expect(screen.getByRole("link", { name: "Browse all" })).toBeTruthy();

    // Neither: no empty rail container is emitted.
    rerender(
      <Section title="External relationships" headingLg>
        <div />
      </Section>,
    );
    expect(container.textContent).toBe("External relationships");
  });
});
