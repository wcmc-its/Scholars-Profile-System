/**
 * `components/scholar/leader-card.tsx` — the embedded Chair/Chief/Director card
 * shown on department / division / center pages. Covers the external-leader
 * carve-out: a leader with `slug: null` (not a WCM scholar, e.g. Joel Stein for
 * Rehabilitation Medicine) renders the name as plain text with NO profile link,
 * while a normal scholar-backed leader links to the profile.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LeaderCard, type Leader } from "@/components/scholar/leader-card";

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
});
