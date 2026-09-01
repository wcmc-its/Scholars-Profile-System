/**
 * `components/scholar/leader-card.tsx` — the embedded Chair/Chief/Director card
 * shown on department / division / center pages. Covers the external-leader
 * carve-out: a leader with `slug: null` (not a WCM scholar, e.g. Joel Stein for
 * Rehabilitation Medicine) renders the name as plain text with NO profile link,
 * while a normal scholar-backed leader links to the profile.
 *
 * #1570 — the "COE Liaison" eyebrow expands "COE" on hover/focus via <abbr>;
 * every other role stays plain text.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LeaderCard, type Leader } from "@/components/scholar/leader-card";
import { COE_EXPANSION } from "@/lib/center-program-roles";

const base: Leader = {
  cwid: "abc1001",
  preferredName: "Test Leader",
  slug: "test-leader",
  primaryTitle: "Professor of Medicine",
  identityImageEndpoint: "https://example.test/abc1001.png",
};

describe("LeaderCard (display)", () => {
  it("links the name to the profile when a slug is present", () => {
    render(<LeaderCard leader={base} role="Chair" />);
    const link = screen.getByRole("link", { name: "Test Leader" });
    expect(link.getAttribute("href")).toContain("test-leader");
  });

  it("renders the name as plain text (no link) for an external leader (slug null)", () => {
    render(<LeaderCard leader={{ ...base, slug: null }} role="Chair" />);
    expect(screen.queryByRole("link", { name: "Test Leader" })).toBeNull();
    // Name still shown, and the role eyebrow still renders.
    expect(screen.getByText("Test Leader")).toBeTruthy();
    expect(screen.getByText("Chair")).toBeTruthy();
  });

  it("expands COE on the liaison eyebrow (via the expansion prop), without changing the visible label", () => {
    // #2558 — the expansion is a prop now, sourced from the vocabulary by the
    // caller (`getCenterProgram`), not a constant `LeaderCard` imports itself.
    const { container } = render(
      <LeaderCard leader={base} role="COE Liaison" expansion={COE_EXPANSION} />,
    );
    const abbr = container.querySelector("abbr");
    expect(abbr).not.toBeNull();
    expect(abbr!.textContent).toBe("COE");
    expect(abbr!.getAttribute("title")).toBe(COE_EXPANSION);
    // The eyebrow still reads "COE Liaison" to a sighted reader and to textContent —
    // splitting the abbreviation out must not change the rendered label.
    expect(container.textContent).toContain("COE Liaison");
  });

  it("does not wrap a role in an abbr when no expansion is given", () => {
    const { container } = render(<LeaderCard leader={base} role="Interim Leader" />);
    expect(container.querySelector("abbr")).toBeNull();
    expect(screen.getByText("Interim Leader")).toBeTruthy();
  });

  it("does not wrap 'COE Liaison' in an abbr when no expansion is given", () => {
    // Passing the literal role string is no longer sufficient by itself —
    // without `expansion`, the caller gets plain text, matching every other role.
    const { container } = render(<LeaderCard leader={base} role="COE Liaison" />);
    expect(container.querySelector("abbr")).toBeNull();
    expect(screen.getByText("COE Liaison")).toBeTruthy();
  });

  it("keeps the default mt-6/max-w-[460px] wrapper classes when no className is given", () => {
    // Every pre-existing caller (scholar/department/division pages) omits
    // `className` — their output must stay byte-identical.
    const { container } = render(<LeaderCard leader={base} role="Chair" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("mt-6");
    expect(wrapper.className).toContain("max-w-[460px]");
  });

  it("replaces mt-6/max-w-[460px] with an overriding className (tailwind-merge conflict resolution)", () => {
    // The center-page leadership grid passes `className="mt-0 max-w-none"` so
    // cards sit flush in a grid cell instead of stacking with their own margin.
    const { container } = render(
      <LeaderCard leader={base} role="Chair" className="mt-0 max-w-none" />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("mt-0");
    expect(wrapper.className).toContain("max-w-none");
    expect(wrapper.className).not.toContain("mt-6");
    expect(wrapper.className).not.toContain("max-w-[460px]");
  });
});
