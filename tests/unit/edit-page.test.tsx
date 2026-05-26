/**
 * `components/edit/edit-page.tsx` — the `/edit/*` detail router inside the
 * Apollo shell (#160 UI follow-up). The rail selects one attribute; the router
 * renders that attribute's panel for the active `?attr=`. Panel internals are
 * tested elsewhere; this is the rail + routing + role-parity wiring.
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
  appointments: [
    {
      externalId: "appt-1",
      title: "Professor of Medicine",
      organization: "Weill Cornell Medicine",
      startDate: "2015-01-01",
      endDate: null,
      isPrimary: true,
      state: "shown",
      suppressionId: null,
    },
  ],
  educations: [
    {
      externalId: "edu-1",
      degree: "MD",
      institution: "Cornell",
      field: null,
      year: 2005,
      state: "shown",
      suppressionId: null,
    },
  ],
  grants: [
    {
      externalId: "grant-1",
      title: "R01 Investigating Things",
      role: "PI",
      funderLabel: "NCI",
      startYear: 2024,
      endYear: 2027,
      isActive: true,
      state: "shown",
      suppressionId: null,
    },
  ],
};

const superuserCtx: EditContext = {
  ...ctx,
  scholar: {
    ...ctx.scholar,
    cwid: "other7",
    slug: "alex-other",
    preferredName: "Alex Other",
    fullName: "Alex Other, MD",
    slugOverride: "custom-handle",
  },
  publications: [],
};

describe("EditPage router — the Apollo shell + rail", () => {
  it("renders the rail with the self attribute set (Publications yes, Profile URL no)", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.getByTestId("rail-overview")).toBeTruthy();
    expect(screen.getByTestId("rail-appointments")).toBeTruthy();
    expect(screen.getByTestId("rail-publications")).toBeTruthy();
    expect(screen.queryByTestId("rail-profile-url")).toBeNull();
  });

  it("uses a single app-level h1 (no repeated '{Attribute} for {Name}' heading)", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Scholars Profile Console");
  });

  it("defaults to the Overview panel for self", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.getByTestId("mock-editor")).toBeTruthy();
  });

  it("an unknown ?attr falls back to the default (Overview)", () => {
    render(<EditPage ctx={ctx} mode="self" attr="does-not-exist" />);
    expect(screen.getByTestId("mock-editor")).toBeTruthy();
  });

  it("?attr=appointments renders the Appointments panel + a row", () => {
    render(<EditPage ctx={ctx} mode="self" attr="appointments" />);
    expect(document.querySelector('[data-slot="appointments-panel"]')).not.toBeNull();
    expect(screen.getByTestId("appointment-row-appt-1")).toBeTruthy();
    expect(screen.getByText("Professor of Medicine")).toBeTruthy();
  });

  it("?attr=funding renders the Funding panel with a filter + a grant row", () => {
    render(<EditPage ctx={ctx} mode="self" attr="funding" />);
    expect(document.querySelector('[data-slot="funding-panel"]')).not.toBeNull();
    expect(screen.getByTestId("funding-panel-filter")).toBeTruthy();
    expect(screen.getByText("R01 Investigating Things")).toBeTruthy();
  });

  it("?attr=education renders the Education panel", () => {
    render(<EditPage ctx={ctx} mode="self" attr="education" />);
    expect(document.querySelector('[data-slot="education-panel"]')).not.toBeNull();
    expect(screen.getByTestId("education-row-edu-1")).toBeTruthy();
  });

  it("?attr=name-title renders the read-only panel with Request a Change", () => {
    render(<EditPage ctx={ctx} mode="self" attr="name-title" />);
    expect(screen.getByText("This section is not editable.")).toBeTruthy();
    expect(screen.getByTestId("request-a-change-toggle")).toBeTruthy();
  });
});

describe("EditPage router — superuser mode", () => {
  it("defaults to Visibility, shows the admin banner, and the superuser rail (Profile URL yes, Publications no)", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    expect(screen.getByText("Profile visibility")).toBeTruthy();
    expect(document.querySelector('[data-slot="superuser-banner"]')).not.toBeNull();
    expect(screen.getByTestId("rail-profile-url")).toBeTruthy();
    expect(screen.queryByTestId("rail-publications")).toBeNull();
  });

  it("?attr=overview renders Overview read-only (no editor)", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" attr="overview" />);
    expect(screen.queryByTestId("mock-editor")).toBeNull();
    expect(document.querySelector('[data-slot="overview-readonly"]')).not.toBeNull();
  });

  it("?attr=profile-url renders the SlugCard pre-filled with the override", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" attr="profile-url" />);
    expect((screen.getByTestId("slug-card-input") as HTMLInputElement).value).toBe("custom-handle");
  });

  it("rail links hang off the superuser base path (/edit/scholar/[cwid])", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    const link = screen.getByTestId("rail-appointments") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/edit/scholar/other7?attr=appointments");
  });
});
