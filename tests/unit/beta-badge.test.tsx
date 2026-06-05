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
  it('renders the visible "Beta" text as the full accessible meaning', () => {
    render(<BetaBadge />);
    const tag = screen.getByText("Beta");
    expect(tag).toBeTruthy();
    expect(tag.tagName).toBe("SPAN");
  });

  it("is non-interactive: a plain span, not focusable, no title/role", () => {
    render(<BetaBadge />);
    const tag = screen.getByText("Beta");
    expect(tag.getAttribute("tabindex")).toBeNull();
    expect(tag.getAttribute("role")).toBeNull();
    expect(tag.getAttribute("title")).toBeNull();
  });

  it("is a solid light chip with carnelian text (dark-on-light, inverting the header)", () => {
    render(<BetaBadge />);
    const tag = screen.getByText("Beta");
    expect(tag.className).toContain("bg-[#FBF1EE]"); // warm off-white fill
    expect(tag.className).toContain("text-[#A32D2D]"); // WCM carnelian text
    expect(tag.className).toContain("rounded-full");
    expect(tag.className).toContain("text-[11px]"); // 11px hard floor
    expect(tag.className).toContain("uppercase");
  });

  it("merges a caller className", () => {
    render(<BetaBadge className="ml-2.5" />);
    expect(screen.getByText("Beta").className).toContain("ml-2.5");
  });
});
