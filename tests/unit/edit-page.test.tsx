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
    primaryTitle: "Professor of Medicine",
    postnominal: "MD, MPH",
    primaryDepartment: "Medicine",
    email: "self01@med.cornell.edu",
    orcid: null,
    roleCategory: "full_time_faculty",
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
  coiDisclosures: [
    { entity: "Acme Therapeutics", activityGroup: "Ownership" },
    { entity: "Globex Pharma", activityGroup: "Leadership Roles" },
  ],
  mentees: [
    {
      externalId: "self01:mentee9",
      name: "Jordan Mentee",
      subtitle: "Immunology (PhD)",
      state: "shown",
      suppressionId: null,
    },
  ],
  // SELF_EDIT_COI_GAP_HINT — empty by default (loader returns [] unless the
  // flag is on AND the viewer is genuine self); a dedicated describe block below
  // exercises the populated case.
  unmatchedPubmedCoi: [],
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

/**
 * Stub the global `Image` so both the HomePanel headshot probe (onload/onerror)
 * and Radix's AvatarImage (addEventListener) resolve deterministically off one
 * fake — jsdom fires neither, so the present/missing branches are otherwise
 * unreachable. Caller restores via `vi.unstubAllGlobals()`.
 */
function stubImage(outcome: "load" | "error") {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    listeners: Record<string, Array<() => void>> = {};
    addEventListener(type: string, cb: () => void) {
      (this.listeners[type] ||= []).push(cb);
    }
    removeEventListener(type: string, cb: () => void) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== cb);
    }
    set src(value: string) {
      if (!value) return;
      if (outcome === "load") this.onload?.();
      else this.onerror?.();
      for (const cb of this.listeners[outcome] || []) cb();
    }
  }
  vi.stubGlobal("Image", FakeImage);
}

describe("EditPage router — the Apollo shell + rail", () => {
  it("renders the rail with the self attribute set (Publications yes, Profile URL locked when flag off)", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.getByTestId("rail-overview")).toBeTruthy();
    expect(screen.getByTestId("rail-appointments")).toBeTruthy();
    expect(screen.getByTestId("rail-publications")).toBeTruthy();
    // Profile URL is now present-but-locked when the flag is off (T3.6), not dropped.
    const profileUrl = screen.getByTestId("rail-profile-url");
    expect(profileUrl.textContent).toMatch(/read-only, from WCM systems/i);
  });

  it("uses a single app-level h1 (no repeated '{Attribute} for {Name}' heading)", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Scholars Profile Console");
  });

  it("defaults to the task-first Home panel for self", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(document.querySelector('[data-slot="home-panel"]')).not.toBeNull();
    expect(screen.getByTestId("home-card-overview")).toBeTruthy();
  });

  it("Home: a written bio shows the overview checklist item as done", () => {
    // ctx.scholar.overview = "<p>Hi.</p>" → hasBio.
    render(<EditPage ctx={ctx} mode="self" />);
    const overview = screen.getByTestId("home-item-overview");
    expect(overview.textContent).toContain("Overview written");
    const link = screen.getByTestId("home-card-overview");
    expect(link.getAttribute("href")).toBe("/edit?attr=overview");
    expect(link.textContent).toContain("Edit");
  });

  it("Home: no bio shows 'Write your overview' as the actionable task", () => {
    const noBio: EditContext = { ...ctx, scholar: { ...ctx.scholar, overview: "   " } };
    render(<EditPage ctx={noBio} mode="self" />);
    const overview = screen.getByTestId("home-item-overview");
    expect(overview.textContent).toContain("Write your overview");
    const cta = screen.getByTestId("home-card-overview");
    expect(cta.getAttribute("href")).toBe("/edit?attr=overview");
    expect(cta.textContent).toContain("Write");
  });

  it("Home: pins the completeness numerator, never a percentage", () => {
    // bio ✓ + 1 pub ✓ + visibility ✓; the headshot probe stays "loading" in
    // jsdom (no Image load) so it doesn't count → exactly 3 of 4.
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.getByText("3 of 4 done")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("Home: each essential is load-bearing — no bio + no pubs counts only visibility (1 of 4)", () => {
    const sparse: EditContext = {
      ...ctx,
      scholar: { ...ctx.scholar, overview: "" },
      publications: [],
    };
    render(<EditPage ctx={sparse} mode="self" />);
    expect(screen.getByText("1 of 4 done")).toBeTruthy();
    // Publications-empty row state.
    expect(screen.getByTestId("home-item-publications").textContent).toContain("None shown yet");
  });

  it("Home: the headshot item hands off to the Web Directory in a new tab", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    const link = screen.getByTestId("home-card-headshot");
    expect(link.getAttribute("href")).toContain("directory.weill.cornell.edu");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("Home: a hidden profile renders the visibility row as 'Profile hidden'", () => {
    const hidden: EditContext = {
      ...ctx,
      scholar: {
        ...ctx.scholar,
        suppression: { ownRow: { id: "s1", reason: "test" }, adminRow: null },
      },
    };
    render(<EditPage ctx={hidden} mode="self" />);
    expect(screen.getByTestId("home-item-visibility").textContent).toContain("Profile hidden");
  });

  // The headshot's presence is a client-side image probe (no server signal); the
  // present branch also mounts Radix AvatarImage — stubImage drives both.
  it("Home: a loadable headshot resolves to 'Headshot added' and completes the profile (4 of 4)", async () => {
    stubImage("load");
    try {
      render(<EditPage ctx={ctx} mode="self" />);
      expect(await screen.findByText("Headshot added")).toBeTruthy();
      expect(screen.getByText("4 of 4 done")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Home: a 404 headshot resolves to the 'Add a headshot' to-do", async () => {
    stubImage("error");
    try {
      render(<EditPage ctx={ctx} mode="self" />);
      expect(await screen.findByText("Add a headshot")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an unknown ?attr falls back to the default (Home)", () => {
    render(<EditPage ctx={ctx} mode="self" attr="does-not-exist" />);
    expect(document.querySelector('[data-slot="home-panel"]')).not.toBeNull();
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

  it("shows the Mentees and Conflicts of Interest rail items in self mode", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.getByTestId("rail-mentees")).toBeTruthy();
    const coi = screen.getByTestId("rail-coi");
    expect(coi).toBeTruthy();
    // COI is read-only → its rail item carries the read-only / sourced cue.
    expect(coi.textContent).toMatch(/read-only, from WCM systems/i);
  });

  it("?attr=mentees renders the suppressible Mentees panel with a row", () => {
    render(<EditPage ctx={ctx} mode="self" attr="mentees" />);
    expect(document.querySelector('[data-slot="mentees-panel"]')).not.toBeNull();
    expect(screen.getByTestId("mentee-row-self01:mentee9")).toBeTruthy();
    expect(screen.getByText("Jordan Mentee")).toBeTruthy();
    // Suppressible → a Hide control is present (not a read-only panel).
    expect(screen.getByTestId("mentee-row-self01:mentee9-hide")).toBeTruthy();
  });

  it("?attr=coi renders the read-only Conflicts of Interest panel, grouped + not editable", () => {
    render(<EditPage ctx={ctx} mode="self" attr="coi" />);
    expect(document.querySelector('[data-slot="coi-panel"]')).not.toBeNull();
    expect(screen.getByText("This section is not editable.")).toBeTruthy();
    expect(screen.getByTestId("request-a-change-toggle")).toBeTruthy();
    // Disclosures render grouped by activityGroup.
    expect(screen.getByText("Acme Therapeutics")).toBeTruthy();
    expect(screen.getByText("Globex Pharma")).toBeTruthy();
  });
});

describe("EditPage router — coi-gap rail visibility (SELF_EDIT_COI_GAP_HINT)", () => {
  const gapCtx: EditContext = {
    ...ctx,
    unmatchedPubmedCoi: [
      {
        id: "gap-1",
        pmid: "31508198",
        entity: "Procept BioRobotics",
        tier: "High",
        sourceSentence:
          "Clinical Research investigator for Procept Aquablation and Neotract Urolift.",
      },
    ],
  };

  it("does NOT show the coi-gap rail item when there are no candidates (default)", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.queryByTestId("rail-coi-gap")).toBeNull();
  });

  it("an ?attr=coi-gap with zero candidates canonicalizes away (no panel rendered)", () => {
    // With no candidates the key is not in the visible set, so EditPage falls
    // back to the default (Home) panel rather than rendering an empty surface.
    render(<EditPage ctx={ctx} mode="self" attr="coi-gap" />);
    expect(document.querySelector('[data-slot="coi-gap-panel"]')).toBeNull();
    expect(document.querySelector('[data-slot="home-panel"]')).not.toBeNull();
  });

  it("shows the coi-gap rail item ONLY when there are candidates", () => {
    render(<EditPage ctx={gapCtx} mode="self" />);
    expect(screen.getByTestId("rail-coi-gap")).toBeTruthy();
  });

  it("?attr=coi-gap renders the panel with the verbatim source sentence + tier chip", () => {
    render(<EditPage ctx={gapCtx} mode="self" attr="coi-gap" />);
    expect(document.querySelector('[data-slot="coi-gap-panel"]')).not.toBeNull();
    expect(screen.getByTestId("coi-gap-source-gap-1").textContent).toContain(
      "Clinical Research investigator for Procept Aquablation and Neotract Urolift.",
    );
    expect(screen.getByTestId("coi-gap-tier-High")).toBeTruthy();
  });

  it("never surfaces coi-gap in superuser mode, even with candidates present", () => {
    const suCtx: EditContext = { ...superuserCtx, unmatchedPubmedCoi: gapCtx.unmatchedPubmedCoi };
    render(<EditPage ctx={suCtx} mode="superuser" />);
    expect(screen.queryByTestId("rail-coi-gap")).toBeNull();
  });
});

describe("EditPage router — self Profile URL request card (#497 PR-3, flag-gated)", () => {
  it("shows a locked Profile URL rail item when the slug-request flag is off (default)", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    const profileUrl = screen.getByTestId("rail-profile-url");
    expect(profileUrl).toBeTruthy();
    expect(profileUrl.textContent).toMatch(/read-only, from WCM systems/i);
  });

  it("renders the read-only Profile URL panel (current URL, no request form) when the flag is off", () => {
    render(<EditPage ctx={ctx} mode="self" attr="profile-url" />);
    expect(document.querySelector('[data-slot="profile-url-readonly"]')).not.toBeNull();
    // Shows the scholar's current URL, no input / request form.
    expect(screen.getByTestId("profile-url-readonly-value").textContent).toContain(
      "scholars.weill.cornell.edu/self-slug",
    );
    expect(screen.queryByTestId("slug-request-input")).toBeNull();
    expect(screen.queryByTestId("slug-card-input")).toBeNull();
  });

  it("shows the Profile URL rail item (owned, not locked) when slugRequestEnabled", () => {
    render(<EditPage ctx={ctx} mode="self" slugRequestEnabled />);
    const profileUrl = screen.getByTestId("rail-profile-url");
    expect(profileUrl).toBeTruthy();
    expect(profileUrl.textContent).not.toMatch(/read-only, from WCM systems/i);
  });

  it("?attr=profile-url renders the scholar request card (not the superuser direct-set card)", () => {
    render(<EditPage ctx={ctx} mode="self" attr="profile-url" slugRequestEnabled />);
    // The self request card, in Idle (no latest request) → input present.
    expect(screen.getByTestId("slug-request-input")).toBeTruthy();
    // The superuser direct-set card must NOT be the one rendered.
    expect(screen.queryByTestId("slug-card-input")).toBeNull();
  });

  it("seeds the request card from latestSlugRequest (Pending state)", () => {
    render(
      <EditPage
        ctx={ctx}
        mode="self"
        attr="profile-url"
        slugRequestEnabled
        latestSlugRequest={{
          id: "req-1",
          status: "pending",
          requestedSlug: "alex-self",
          reason: null,
          decisionNote: null,
          createdAt: "2026-05-27T12:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByTestId("slug-request-pending")).toBeTruthy();
    expect(screen.getByTestId("slug-request-withdraw")).toBeTruthy();
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
