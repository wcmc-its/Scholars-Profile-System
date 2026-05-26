/**
 * `components/edit/edit-page.tsx` — the /edit shell composes the cards
 * (#356 Phase 6 C8 / Phase 7 C5). The card internals are tested elsewhere;
 * this is the shell wiring only.
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
    slugOverride: null,
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
  appointments: [],
  educations: [],
  grants: [],
};

describe("EditPage shell — self mode (default)", () => {
  it("renders the self page title and intro", () => {
    render(<EditPage ctx={ctx} />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Edit my profile");
    expect(screen.getByText("Changes appear on your public profile.")).toBeTruthy();
  });

  it("renders the three Phase 6 cards (Overview, Visibility, My publications)", () => {
    render(<EditPage ctx={ctx} />);
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Profile visibility")).toBeTruthy();
    expect(screen.getByText("My publications")).toBeTruthy();
    // No slug card, no superuser banner.
    expect(document.querySelector('[data-slot="slug-card"]')).toBeNull();
    expect(document.querySelector('[data-slot="superuser-banner"]')).toBeNull();
  });

  it("passes the cwid through to the cards (publications POSTs would use it)", () => {
    render(<EditPage ctx={ctx} />);
    expect(screen.getByTestId("pub-row-pmid-1")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — superuser shell
// ---------------------------------------------------------------------------

const superuserCtx: EditContext = {
  scholar: {
    cwid: "other7",
    slug: "alex-other",
    preferredName: "Alex Other",
    fullName: "Alex Other, MD",
    overview: "<p>Other's bio.</p>",
    slugOverride: "custom-handle",
    suppression: { ownRow: null, adminRow: null },
  },
  publications: [], // not surfaced in superuser mode
  appointments: [],
  educations: [],
  grants: [],
};

describe("EditPage shell — superuser mode (Phase 7)", () => {
  it("renders the superuser page title naming the target scholar", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Edit profile — Alex Other");
    expect(screen.getByText("Changes appear on this scholar's public profile.")).toBeTruthy();
  });

  it("renders the superuser banner above the cards", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    expect(document.querySelector('[data-slot="superuser-banner"]')).not.toBeNull();
  });

  it("renders Overview (read-only), Visibility, and Slug — and NOT 'My publications'", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Profile visibility")).toBeTruthy();
    // SlugCard wraps a "Profile URL" CardTitle.
    expect(screen.getByText("Profile URL")).toBeTruthy();
    expect(screen.queryByText("My publications")).toBeNull();
  });

  it("the Overview card is in readOnly mode (no editor, no Save button)", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    expect(screen.queryByTestId("mock-editor")).toBeNull();
    expect(screen.queryByTestId("overview-save")).toBeNull();
    expect(document.querySelector('[data-slot="overview-readonly"]')).not.toBeNull();
  });

  it("SlugCard receives the slugOverride from the context", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    // The input is pre-filled with the override value.
    expect(
      (screen.getByTestId("slug-card-input") as HTMLInputElement).value,
    ).toBe("custom-handle");
  });
});
