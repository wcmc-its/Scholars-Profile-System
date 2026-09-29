/**
 * `FeedbackBadge` mobile footprint (#1902): below `sm` the badge is an
 * icon-only circle so it covers less body copy on phones. The visible
 * "Feedback" label is screen-reader-only at small widths and restored
 * at `sm`; the accessible name comes from aria-label and is unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const pathnameMock = vi.fn(() => "/about");
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
  useRouter: () => ({ push: vi.fn() }),
}));

import { FeedbackBadge } from "@/components/site/feedback-badge";
import { FeedbackBadgeProvider } from "@/components/site/feedback-badge-context";

function renderBadge() {
  return render(
    <FeedbackBadgeProvider>
      <FeedbackBadge />
    </FeedbackBadgeProvider>,
  );
}

describe("FeedbackBadge — mobile footprint (#1902)", () => {
  it("keeps the accessible name and hides the text label below sm", () => {
    pathnameMock.mockReturnValue("/about");
    const { container } = renderBadge();
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-label")).toBe("Open Scholars feedback form");

    const label = button!.querySelector('[data-testid="feedback-badge-label"]');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("Feedback");
    expect(label!.classList.contains("sr-only")).toBe(true);
    expect(label!.classList.contains("sm:not-sr-only")).toBe(true);

    // Compact circular padding on phones, pill padding from sm up.
    expect(button!.classList.contains("p-2.5")).toBe(true);
    expect(button!.classList.contains("sm:px-3.5")).toBe(true);
    expect(button!.classList.contains("px-3.5")).toBe(false);
  });

  it("renders nothing on the feedback form route", () => {
    pathnameMock.mockReturnValue("/about/feedback");
    const { container } = renderBadge();
    expect(container.querySelector("button")).toBeNull();
  });
});
