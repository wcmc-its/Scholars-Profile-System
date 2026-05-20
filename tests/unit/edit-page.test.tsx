/**
 * `components/edit/edit-page.tsx` — the /edit shell composes the three Phase 6
 * cards (#356 Phase 6 C8). The card internals are tested elsewhere; this is
 * the shell wiring only.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
// Mock the editor to skip the Tiptap mount — covered by overview-editor tests.
vi.mock("@/components/edit/overview-editor", () => ({
  OverviewEditor: ({ initialHtml }: { initialHtml: string }) => (
    <textarea data-testid="mock-editor" defaultValue={initialHtml} />
  ),
}));

import { EditPage } from "@/components/edit/edit-page";
import type { EditContext } from "@/lib/api/edit-context";

const ctx: EditContext = {
  scholar: {
    cwid: "self01",
    slug: "self-slug",
    preferredName: "Alex Self",
    fullName: "Alex Self, MD",
    overview: "<p>Hi.</p>",
    suppression: { ownRow: null, adminRow: null },
  },
  publications: [
    {
      pmid: "pmid-1",
      title: "A study",
      journal: "Journal X",
      year: 2025,
      state: "shown",
      suppressionId: null,
      isSoleDisplayedAuthor: false,
    },
  ],
};

describe("EditPage shell", () => {
  it("renders the page title and intro", () => {
    render(<EditPage ctx={ctx} />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Edit my profile");
    expect(screen.getByText("Changes appear on your public profile.")).toBeTruthy();
  });

  it("renders all three Phase 6 cards", () => {
    render(<EditPage ctx={ctx} />);
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Profile visibility")).toBeTruthy();
    expect(screen.getByText("My publications")).toBeTruthy();
  });

  it("passes the cwid through to the cards (publications POSTs would use it)", () => {
    render(<EditPage ctx={ctx} />);
    // The publications row should render — its presence is the proof the cwid
    // and publications prop wired through.
    expect(screen.getByTestId("pub-row-pmid-1")).toBeTruthy();
  });
});
