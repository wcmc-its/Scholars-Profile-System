/**
 * `components/edit/overview-draft-review-card.tsx` (#875 §4.3) — the coral draft
 * safety net. A pure presentational component: it renders the draft + the three
 * actions and fires the parent callbacks. The parent owns the draft, the history
 * paging, and the editor seed; this never touches the editor itself.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  OverviewDraftReviewCard,
  type OverviewReviewDraft,
} from "@/components/edit/overview-draft-review-card";

const DRAFT: OverviewReviewDraft = {
  text: "<p>A generated draft.</p>",
  generationId: "gen-1",
  createdAt: new Date().toISOString(),
};

function renderCard(over: Partial<React.ComponentProps<typeof OverviewDraftReviewCard>> = {}) {
  const props = {
    draft: DRAFT,
    index: 1,
    total: 1,
    onReplace: vi.fn(),
    onInsert: vi.fn(),
    onDiscard: vi.fn(),
    ...over,
  };
  render(<OverviewDraftReviewCard {...props} />);
  return props;
}

describe("OverviewDraftReviewCard — render", () => {
  it("renders the draft body and the three actions", () => {
    renderCard();
    expect(screen.getByTestId("overview-draft-review-card")).toBeTruthy();
    expect(screen.getByTestId("overview-draft-body").innerHTML).toBe("<p>A generated draft.</p>");
    expect(screen.getByTestId("overview-draft-replace")).toBeTruthy();
    expect(screen.getByTestId("overview-draft-insert")).toBeTruthy();
    expect(screen.getByTestId("overview-draft-discard")).toBeTruthy();
  });

  it("reads as coral-tinted ('AI output, not yet yours')", () => {
    renderCard();
    const card = screen.getByTestId("overview-draft-review-card");
    expect(card.className).toContain("bg-apollo-coral-tint");
    expect(card.className).toContain("text-apollo-coral-foreground");
  });

  it("hides the pager when there is only one draft", () => {
    renderCard({ index: 1, total: 1 });
    expect(screen.queryByTestId("overview-draft-pager")).toBeNull();
  });

  it("shows 'Draft N of M · view previous' when multiple drafts exist", () => {
    renderCard({ index: 2, total: 3, onPrev: vi.fn(), onNext: vi.fn() });
    expect(screen.getByText("Draft 2 of 3 · view previous")).toBeTruthy();
  });
});

describe("OverviewDraftReviewCard — actions", () => {
  it("Replace fires onReplace", () => {
    const { onReplace } = renderCard();
    fireEvent.click(screen.getByTestId("overview-draft-replace"));
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it("Insert below fires onInsert", () => {
    const { onInsert } = renderCard();
    fireEvent.click(screen.getByTestId("overview-draft-insert"));
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it("Discard fires onDiscard", () => {
    const { onDiscard } = renderCard();
    fireEvent.click(screen.getByTestId("overview-draft-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("Prev/Next step through the history and disable at the ends", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    // Middle of three → both arrows active.
    const { unmount } = render(
      <OverviewDraftReviewCard
        draft={DRAFT}
        index={2}
        total={3}
        onPrev={onPrev}
        onNext={onNext}
        onReplace={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByTestId("overview-draft-prev").hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("overview-draft-next").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("overview-draft-prev"));
    expect(onPrev).toHaveBeenCalledTimes(1);
    unmount();

    // Newest draft (index 1) → prev disabled.
    render(
      <OverviewDraftReviewCard
        draft={DRAFT}
        index={1}
        total={3}
        onPrev={onPrev}
        onNext={onNext}
        onReplace={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByTestId("overview-draft-prev").hasAttribute("disabled")).toBe(true);
  });

  it("disables every action when disabled", () => {
    renderCard({ disabled: true });
    expect(screen.getByTestId("overview-draft-replace").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("overview-draft-insert").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("overview-draft-discard").hasAttribute("disabled")).toBe(true);
  });
});
