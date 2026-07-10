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

  it("expands COE on the liaison eyebrow, without changing the visible label", () => {
    const { container } = render(<LeaderCard leader={base} role="COE Liaison" />);
    const abbr = container.querySelector("abbr");
    expect(abbr).not.toBeNull();
    expect(abbr!.textContent).toBe("COE");
    expect(abbr!.getAttribute("title")).toBe(COE_EXPANSION);
    // The eyebrow still reads "COE Liaison" to a sighted reader and to textContent —
    // splitting the abbreviation out must not change the rendered label.
    expect(container.textContent).toContain("COE Liaison");
  });

  it("does not wrap a non-COE role in an abbr", () => {
    const { container } = render(<LeaderCard leader={base} role="Interim Leader" />);
    expect(container.querySelector("abbr")).toBeNull();
    expect(screen.getByText("Interim Leader")).toBeTruthy();
  });
});
