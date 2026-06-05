import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { BetaBadge, isBetaBadgeEnabled } from "@/components/site/beta-badge";

describe("isBetaBadgeEnabled — default-on gate (#760)", () => {
  it("is ON when SHOW_BETA_BADGE is unset", () => {
    expect(isBetaBadgeEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is ON when SHOW_BETA_BADGE="on"', () => {
    expect(
      isBetaBadgeEnabled({ SHOW_BETA_BADGE: "on" } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('is OFF only when SHOW_BETA_BADGE is exactly "off"', () => {
    expect(
      isBetaBadgeEnabled({ SHOW_BETA_BADGE: "off" } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('treats any non-"off" value as ON (no accidental disable)', () => {
    expect(
      isBetaBadgeEnabled({ SHOW_BETA_BADGE: "OFF" } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isBetaBadgeEnabled({ SHOW_BETA_BADGE: "true" } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isBetaBadgeEnabled({ SHOW_BETA_BADGE: "" } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("BetaBadge — presentation", () => {
  it('renders the visible "Beta" text (screen-reader meaning) + a tooltip title', () => {
    render(<BetaBadge />);
    const pill = screen.getByText("Beta");
    expect(pill).toBeTruthy();
    expect(pill.getAttribute("title")).toBe("Scholars is in beta");
  });

  it("is a translucent white outline pill (white text, white border)", () => {
    render(<BetaBadge />);
    const pill = screen.getByText("Beta");
    expect(pill.className).toContain("border-white/40");
    expect(pill.className).toContain("text-white/90");
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("uppercase");
  });

  it("merges a caller className (used by the header for vertical nudge)", () => {
    render(<BetaBadge className="mt-[3px]" />);
    expect(screen.getByText("Beta").className).toContain("mt-[3px]");
  });
});
