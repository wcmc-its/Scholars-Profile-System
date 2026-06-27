/**
 * `components/edit/edit-page.tsx` — the `/edit/*` detail router inside the
 * Apollo shell (#160 UI follow-up). The rail selects one attribute; the router
 * renders that attribute's panel for the active `?attr=`. Panel internals are
 * tested elsewhere; this is the rail + routing + role-parity wiring.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

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
    emailVisibility: "public",
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
      source: "InfoEd",
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
  // Medium-tier active (lower-confidence) and fully-reviewed (history) groups —
  // empty by default; populated only when the flag is on for a genuine viewer.
  unmatchedPubmedCoiLower: [],
  unmatchedPubmedCoiReviewed: [],
  // #1112 — flat mention set for the redesigned review surface; empty by default.
  unmatchedPubmedCoiMentions: [],
  // REPORTER_MATCH_V2 — empty by default (loader returns [] unless the flag is on
  // for a genuine self/superuser viewer); a dedicated case exercises the populated
  // state in the card's own test.
  reporterProfileCandidates: [],
  reporterProfileConfirmed: [],
  // #836 — null unless SELF_EDIT_MANUAL_HIGHLIGHTS is on AND the viewer is self.
  highlights: null,
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
    // Email moved to its own tab — the Name & Title panel no longer echoes it.
    expect(screen.queryByText("self01@med.cornell.edu")).toBeNull();
  });

  it("?attr=email renders the read-only Email tab: email, visibility label + explainer, Web Directory link", () => {
    render(<EditPage ctx={ctx} mode="self" attr="email" />);
    expect(document.querySelector('[data-slot="email-panel"]')).not.toBeNull();
    expect(screen.getByText("self01@med.cornell.edu")).toBeTruthy();
    // 'public' → "Public" label per SPEC table A.
    expect(screen.getByTestId("email-visibility-label").textContent).toBe("Public");
    expect(screen.getByTestId("email-visibility-explainer")).toBeTruthy();
    // #919 — usage line, first-person for self.
    expect(screen.getByTestId("email-usage-note").textContent).toBe(
      "This is the contact email shown on your public profile.",
    );
    // #919 — download / on-network policy note (general; no numeric cap surfaced).
    const policy = screen.getByTestId("email-download-policy");
    expect(policy.textContent).toMatch(/signed in or on the campus network/i);
    expect(policy.textContent).toMatch(/internal directory export/i);
    expect(policy.textContent).toMatch(/that access is logged/i);
    expect(policy.textContent).toMatch(/excluded from the export/i);
    expect(policy.textContent).toMatch(/bulk download of large groups is not supported/i);
    expect(policy.textContent).not.toMatch(/50/);
    expect(screen.getByText("This section is not editable.")).toBeTruthy();
    // Read-only: no control that writes the release code, just the SOR link.
    const link = screen.getByTestId("email-web-directory-link");
    expect(link.getAttribute("href")).toBe(
      "https://directory.weill.cornell.edu/update/profile/index",
    );
  });

  it("Email tab reframes the usage line + policy note to the scholar's name for a superuser (#919)", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" attr="email" />);
    // possessive → "{ScholarName}'s" (preferredName), matching the explainer's framing.
    expect(screen.getByTestId("email-usage-note").textContent).toBe(
      "This is the contact email shown on Alex Other's public profile.",
    );
    const policy = screen.getByTestId("email-download-policy");
    expect(policy.textContent).toMatch(/download Alex Other's email/i);
    expect(policy.textContent).not.toMatch(/\byour\b/i);
    expect(policy.textContent).toMatch(/bulk download of large groups is not supported/i);
  });

  it("Email tab labels 'institution' as Institution only", () => {
    const instCtx = { ...ctx, scholar: { ...ctx.scholar, emailVisibility: "institution" } };
    render(<EditPage ctx={instCtx} mode="self" attr="email" />);
    expect(screen.getByTestId("email-visibility-label").textContent).toBe("Institution only");
  });

  it("Email tab fails closed: NULL / unrecognized visibility → Not released", () => {
    const noneCtx = { ...ctx, scholar: { ...ctx.scholar, emailVisibility: null } };
    render(<EditPage ctx={noneCtx} mode="self" attr="email" />);
    expect(screen.getByTestId("email-visibility-label").textContent).toBe("Not released");
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
        key: "procept biorobotics",
        entity: "Procept BioRobotics",
        tier: "High",
        newestTs: Date.UTC(2019, 0, 1),
        sources: [
          {
            id: "gap-1",
            pmid: "31508198",
            sourceSentence:
              "Clinical Research investigator for Procept Aquablation and Neotract Urolift.",
            year: 2019,
          },
        ],
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

  it("renders a quiet count chip = number of relationships to review", () => {
    render(<EditPage ctx={gapCtx} mode="self" />);
    const item = screen.getByTestId("rail-coi-gap");
    // The count is exposed by an accessible "to review" label (a cue, not a
    // digit-only alert badge), and the visible text is the count.
    expect(item.querySelector('[aria-label="1 to review"]')?.textContent).toBe("1");
  });

  it("caps the count chip display at 9+ (keeping the true count in the a11y label)", () => {
    const many: EditContext = {
      ...ctx,
      unmatchedPubmedCoi: Array.from({ length: 12 }, (_, i) => ({
        key: `e${i}`,
        entity: `Entity ${i}`,
        tier: "High" as const,
        newestTs: 0,
        sources: [{ id: `s${i}`, pmid: `p${i}`, sourceSentence: "x", year: null }],
      })),
    };
    render(<EditPage ctx={many} mode="self" />);
    const item = screen.getByTestId("rail-coi-gap");
    expect(item.querySelector('[aria-label="12 to review"]')?.textContent).toBe("9+");
  });

  it("?attr=coi-gap renders the #1112 redesigned panel (Organization view) from the mention set", () => {
    // The rail badge still derives from `unmatchedPubmedCoi`, but the panel body
    // now consumes the flat `unmatchedPubmedCoiMentions` projection.
    const mentionCtx: EditContext = {
      ...gapCtx,
      unmatchedPubmedCoiMentions: [
        {
          candidateId: "gap-1",
          pmid: "31508198",
          year: 2019,
          organization: "procept biorobotics",
          organizationRaw: "Procept BioRobotics",
          subjectType: "self",
          subjectMention: "Smith",
          subjectId: "self",
          clause: "Smith is a clinical research investigator for Procept BioRobotics.",
          fullText: "Smith is a clinical research investigator for Procept BioRobotics.",
          relationshipKinds: [],
          confidence: "high",
          status: "current",
          reason: null,
          reviewedAt: null,
        },
      ],
    };
    render(<EditPage ctx={mentionCtx} mode="self" attr="coi-gap" />);
    expect(document.querySelector('[data-slot="coi-gap-panel"]')).not.toBeNull();
    // Default Organization view shows a card for the matched org with its clause.
    expect(screen.getByTestId("coi-gap-org-card-procept biorobotics").textContent).toContain(
      "clinical research investigator for Procept BioRobotics",
    );
  });

  it("surfaces coi-gap in superuser mode when candidates are present (operator decision), with reframed rail label", () => {
    const suCtx: EditContext = { ...superuserCtx, unmatchedPubmedCoi: gapCtx.unmatchedPubmedCoi };
    render(<EditPage ctx={suCtx} mode="superuser" />);
    const rail = screen.getByTestId("rail-coi-gap");
    expect(rail).toBeTruthy();
    // Reframed for the superuser — not the first-person "From your publications".
    expect(rail.textContent).toContain("From the scholar");
    // Nested UNDER Conflicts of Interest (like the self rail) — a sub-view, not a
    // flat sibling. The child marker is the indentation class.
    expect(rail.className).toContain("pl-7");
  });

  it("does NOT surface coi-gap in superuser mode when there are no candidates", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    expect(screen.queryByTestId("rail-coi-gap")).toBeNull();
  });

  it("?attr=coi-gap renders the advisory for a superuser with the privacy chip reframed (not 'only you')", () => {
    const suCtx: EditContext = { ...superuserCtx, unmatchedPubmedCoi: gapCtx.unmatchedPubmedCoi };
    render(<EditPage ctx={suCtx} mode="superuser" attr="coi-gap" />);
    expect(document.querySelector('[data-slot="coi-gap-panel"]')).not.toBeNull();
    // The privacy chip must stay truthful — admins can see these rows.
    expect(screen.getByText("Visible to administrators and the scholar")).toBeTruthy();
    expect(screen.queryByText("Visible only to you")).toBeNull();
    // The back-link returns to the superuser's own COI surface.
    expect(screen.getByTestId("coi-gap-back").getAttribute("href")).toBe(
      "/edit/scholar/other7?attr=coi",
    );
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

describe("EditPage — proxy / unit-admin third-person parity (#955 #10)", () => {
  // A proxy / unit-admin edits on the scholar's behalf, so copy-only cards render
  // in third person exactly like a superuser does (the page passes them the same
  // voice-derived mode). VisibilityCard is the exception — third-person COPY but
  // the self (ownRow) state machine, because a proxy is a self-surrogate.
  it.each(["proxy", "unit-admin"] as const)(
    "Email tab reads in third person for a %s editor (parity with superuser)",
    (mode) => {
      render(<EditPage ctx={superuserCtx} mode={mode} attr="email" />);
      expect(screen.getByTestId("email-usage-note").textContent).toBe(
        "This is the contact email shown on Alex Other's public profile.",
      );
      expect(screen.getByTestId("email-download-policy").textContent).not.toMatch(/\byour\b/i);
    },
  );

  it.each(["proxy", "unit-admin"] as const)(
    "Home board reads third-person ('Profile completeness', not 'Complete your profile') for a %s editor",
    (mode) => {
      render(<EditPage ctx={superuserCtx} mode={mode} attr="home" />);
      expect(screen.getByText("Profile completeness")).toBeTruthy();
      expect(screen.queryByText("Complete your profile")).toBeNull();
      expect(screen.queryByText("Yours to edit")).toBeNull();
    },
  );

  it.each(["proxy", "unit-admin"] as const)(
    "Visibility tab is third-person but keeps the self (ownRow) controls for a %s editor",
    (mode) => {
      render(<EditPage ctx={superuserCtx} mode={mode} attr="visibility" />);
      // Third-person copy…
      expect(screen.getByText(/Alex Other's profile is visible to the public/)).toBeTruthy();
      expect(screen.getByTestId("visibility-hide").textContent).toBe("Hide profile");
      // …but the SELF state machine (data-mode='self'): a proxy hides via the
      // scholar's own row, never an admin hold.
      expect(
        document.querySelector('[data-slot="visibility-card"]')?.getAttribute("data-mode"),
      ).toBe("self");
    },
  );
});

describe("EditPage router — superuser mode", () => {
  it("defaults to the Home completeness panel, shows the admin banner, and the superuser rail (Home + Profile URL at the top, Publications yes)", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    expect(document.querySelector('[data-slot="home-panel"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="superuser-banner"]')).not.toBeNull();
    expect(screen.getByTestId("rail-home")).toBeTruthy();
    expect(screen.getByTestId("rail-profile-url")).toBeTruthy();
    // Publications is now a superuser surface too (managed on the scholar's behalf).
    expect(screen.queryByTestId("rail-publications")).not.toBeNull();
    // Home leads as the landing; Profile URL sits at the top of the attributes
    // (just under Home), ahead of the WCM-sourced ones.
    const home = screen.getByTestId("rail-home");
    const profileUrl = screen.getByTestId("rail-profile-url");
    const nameTitle = screen.getByTestId("rail-name-title");
    expect(
      home.compareDocumentPosition(profileUrl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      profileUrl.compareDocumentPosition(nameTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Home (superuser): third-person header, Overview is editable (#844), Publications has a Review CTA, no units section", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" attr="home" />);
    // Reframed, third-person heading.
    expect(screen.getByText("Profile completeness")).toBeTruthy();
    // #844 — the Overview is now editable by a superuser → an "Edit" CTA (not the
    // pre-#844 read-only "View") that hangs off the superuser base path.
    const overviewCta = screen.getByTestId("home-card-overview");
    expect(overviewCta.textContent).toContain("Edit");
    expect(overviewCta.getAttribute("href")).toBe("/edit/scholar/other7?attr=overview");
    // Publications now deep-links for a superuser too (managed on the scholar's behalf).
    expect(screen.getByTestId("home-item-publications")).toBeTruthy();
    const pubsCta = screen.getByTestId("home-card-publications");
    expect(pubsCta.getAttribute("href")).toBe("/edit/scholar/other7?attr=publications");
    // "Units you manage" is the viewer's, omitted when editing someone else.
    expect(screen.queryByTestId("home-units")).toBeNull();
  });

  it("Home (superuser): no bio shows the actionable 'Write' CTA (#844 — admins author the bio)", () => {
    const noBio: EditContext = {
      ...superuserCtx,
      scholar: { ...superuserCtx.scholar, overview: "   " },
    };
    render(<EditPage ctx={noBio} mode="superuser" attr="home" />);
    const overview = screen.getByTestId("home-item-overview");
    expect(overview.textContent).toContain("No overview yet");
    const cta = screen.getByTestId("home-card-overview");
    expect(cta.textContent).toContain("Write");
    expect(cta.getAttribute("href")).toBe("/edit/scholar/other7?attr=overview");
  });

  it("?attr=overview renders the editable Overview editor for a superuser (#844)", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" attr="overview" />);
    // The manual editor mounts (no longer the read-only arm) and a Save button is
    // present; the previewHref points at the target scholar's public profile.
    expect(screen.getByTestId("mock-editor")).toBeTruthy();
    expect(screen.getByTestId("overview-save")).toBeTruthy();
    expect(document.querySelector('[data-slot="overview-readonly"]')).toBeNull();
  });

  // The Overview Generator (#742) is offered to a superuser editing another
  // scholar too — `authorizeOverviewWrite` + the generate route already authorize
  // a superuser, so the UI guard agrees (self OR superuser, gated by the flag).
  it("?attr=overview exposes the Generate affordance for a superuser when the flag is on", () => {
    // The flag is read at render time via isOverviewGenerateEnabled() (process.env
    // SELF_EDIT_OVERVIEW_GENERATE). Turn it on for this case and restore after.
    const prev = process.env.SELF_EDIT_OVERVIEW_GENERATE;
    process.env.SELF_EDIT_OVERVIEW_GENERATE = "on";
    // generateEnabled mounts history + source-options fetches — keep them inert.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, generations: [], provenance: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    // The real use case here: a superuser drafting a bio for an uncovered
    // scholar (empty overview).
    const noBio: EditContext = {
      ...superuserCtx,
      scholar: { ...superuserCtx.scholar, overview: "" },
    };
    try {
      render(<EditPage ctx={noBio} mode="superuser" attr="overview" />);
      // #1246 — the Draft-with-AI block now starts collapsed regardless of bio
      // state; expand it to reach the Generate button.
      expect(screen.getByTestId("overview-draft-block")).toBeTruthy();
      fireEvent.click(screen.getByTestId("overview-draft-block-toggle"));
      expect(screen.getByTestId("overview-generate")).toBeTruthy();
    } finally {
      fetchSpy.mockRestore();
      if (prev === undefined) delete process.env.SELF_EDIT_OVERVIEW_GENERATE;
      else process.env.SELF_EDIT_OVERVIEW_GENERATE = prev;
    }
  });

  // Flag gating still holds: with the flag off, the superuser surface shows the
  // plain manual editor (no Generate), exactly as before this widening.
  it("?attr=overview hides the Generate affordance for a superuser when the flag is off", () => {
    const prev = process.env.SELF_EDIT_OVERVIEW_GENERATE;
    delete process.env.SELF_EDIT_OVERVIEW_GENERATE;
    try {
      render(<EditPage ctx={superuserCtx} mode="superuser" attr="overview" />);
      expect(screen.getByTestId("mock-editor")).toBeTruthy();
      expect(screen.queryByTestId("overview-generate")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.SELF_EDIT_OVERVIEW_GENERATE;
      else process.env.SELF_EDIT_OVERVIEW_GENERATE = prev;
    }
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

  // #836 — a superuser may curate another scholar's Highlights (superuser is
  // unrestricted on the edit surface). The rail item + card appear only when the
  // loader populated `ctx.highlights`; the copy is reframed to the scholar's name.
  it("surfaces the Highlights rail item + card in superuser mode when the loader populated it, with reframed copy", () => {
    const withHighlights: EditContext = {
      ...superuserCtx,
      highlights: {
        manualEnabled: false,
        manualPmids: [],
        aiPmids: ["100"],
        pickable: [
          {
            pmid: "100",
            title: "A landmark study",
            journal: "Cell",
            year: 2024,
            impact: 90,
            publicationType: "Academic Article",
          },
          {
            pmid: "200",
            title: "A follow-up",
            journal: "Nature",
            year: 2025,
            impact: 70,
            publicationType: "Review",
          },
        ],
      },
    };
    render(<EditPage ctx={withHighlights} mode="superuser" attr="highlights" />);
    const rail = screen.getByTestId("rail-highlights") as HTMLAnchorElement;
    expect(rail.getAttribute("href")).toBe("/edit/scholar/other7?attr=highlights");
    // The mode-switch button is mode-neutral copy; the reframing to a third-person
    // action lives in the panel description (not the first-person self copy).
    expect(screen.getByTestId("highlights-opt-in").textContent).toBe("Choose manually");
    const panel = document.querySelector('[data-slot="highlights-card"]');
    expect(panel?.textContent).toContain("on their behalf");
    expect(panel?.textContent).not.toContain("yourself");
  });

  it("drops the Highlights rail item in superuser mode when the loader left it null (flag off / not loaded)", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" />);
    expect(screen.queryByTestId("rail-highlights")).toBeNull();
  });

  // A superuser manages another scholar's publications on their behalf — the card
  // renders with copy reframed to the scholar (not first-person "My publications").
  it("?attr=publications renders the publications card for a superuser with reframed copy", () => {
    const withPubs: EditContext = {
      ...superuserCtx,
      publications: [
        {
          pmid: "1",
          title: "A study",
          journal: "Cell",
          year: 2024,
          state: "shown",
          suppressionId: null,
          isSoleDisplayedAuthor: false,
        },
      ],
    };
    render(<EditPage ctx={withPubs} mode="superuser" attr="publications" />);
    expect(document.querySelector('[data-slot="publications-card"]')).not.toBeNull();
    expect(screen.getByTestId("publications-filter")).toBeTruthy();
    // Reframed heading — not the first-person "My publications".
    expect(screen.queryByText("My publications")).toBeNull();
  });
});

describe("EditPage rail — restructured layout (SELF_EDIT_RAIL_RESTRUCTURE)", () => {
  // Scope assertions to the attribute rail's <nav>; HomePanel renders its own
  // "Yours to edit" / "From WCM systems" section labels, so an unscoped getByText
  // would collide.
  const rail = () => within(screen.getByRole("navigation", { name: "Profile attributes" }));

  it("regroups the self rail when the flag is on: floating Home, Tools, Settings, WCM sub-headers", () => {
    render(
      <EditPage ctx={ctx} mode="self" railRestructureEnabled grantRecsEnabled biosketchEnabled />,
    );
    const q = rail();
    // Home floats at the top with a leading Home glyph (the "landing" tag was removed).
    expect(q.getByTestId("rail-home")).toBeTruthy();
    expect(q.queryByText("landing")).toBeNull();
    expect(q.getByTestId("rail-home-icon")).toBeTruthy();
    // "Yours to edit" narrows to authored content (header only now — its note was
    // dropped; the group is self-explanatory).
    expect(q.getByText("Yours to edit")).toBeTruthy();
    expect(q.queryByText("Your profile content.")).toBeNull();
    // "From WCM records" gathers the sourced data; the Identity / Records sub-headers
    // were removed, so its items now sit flush under the one header.
    expect(q.getByText("From WCM records")).toBeTruthy();
    expect(q.queryByText("Identity · read-only")).toBeNull();
    expect(q.queryByText("Records · hide, show, or flag")).toBeNull();
    // Generators move under "Tools".
    expect(q.getByText("Tools")).toBeTruthy();
    expect(q.getByTestId("rail-biosketch")).toBeTruthy();
    expect(q.getByTestId("rail-grant-recs")).toBeTruthy();
    // The admin controls gather under a dedicated "Settings" group. The three
    // described groups (WCM records / Tools / Settings) each tuck their note
    // behind an info button rather than rendering it as plain text.
    expect(q.getByText("Settings")).toBeTruthy();
    expect(q.queryByText("Profile administration.")).toBeNull();
    expect(q.getAllByRole("button", { name: "About this group" })).toHaveLength(3);
    expect(q.getByTestId("rail-visibility")).toBeTruthy();
    expect(q.getByTestId("rail-proxy-editors")).toBeTruthy();
    expect(q.getByTestId("rail-profile-url")).toBeTruthy();
    // Hairline rules separate the five sections (Home / Yours to edit / From WCM
    // records / Tools / Settings) — four dividers.
    expect(q.getAllByRole("separator")).toHaveLength(4);
    // The classic group labels are gone in the restructured rail.
    expect(q.queryByText("From WCM systems")).toBeNull();
    expect(q.queryByText("Services")).toBeNull();
  });

  it("leaves the classic two-group rail intact when the flag is off (default)", () => {
    render(<EditPage ctx={ctx} mode="self" grantRecsEnabled biosketchEnabled />);
    const q = rail();
    // Classic labels present; the restructured groups + the floating-Home tag are not.
    expect(q.getByText("From WCM systems")).toBeTruthy();
    expect(q.getByText("Services")).toBeTruthy();
    expect(q.queryByText("Settings")).toBeNull();
    expect(q.queryByText("From WCM records")).toBeNull();
    expect(q.queryByText("landing")).toBeNull();
    // No restructured chrome: no section dividers, no Home glyph.
    expect(q.queryAllByRole("separator")).toHaveLength(0);
    expect(q.queryByTestId("rail-home-icon")).toBeNull();
  });

  // The restructured rail unifies self and edit-for-others: a superuser editing
  // another scholar gets the SAME section groupings (not the flat superuser rail),
  // with "Yours to edit" reframed to the third-person "Profile content".
  it("applies the same restructured grouping to the superuser edit-for-others rail", () => {
    render(
      <EditPage
        ctx={ctx}
        mode="superuser"
        attr="home"
        railRestructureEnabled
        grantRecsEnabled
        biosketchEnabled
      />,
    );
    const q = rail();
    expect(q.getByText("From WCM records")).toBeTruthy();
    expect(q.getByText("Tools")).toBeTruthy();
    expect(q.getByText("Settings")).toBeTruthy();
    // Same three info buttons (WCM records / Tools / Settings) as the self rail.
    expect(q.getAllByRole("button", { name: "About this group" })).toHaveLength(3);
    // "Yours to edit" reframes to the third-person form for edit-for-others.
    expect(q.getByText("Profile content")).toBeTruthy();
    expect(q.queryByText("Yours to edit")).toBeNull();
    // Same Home glyph + section dividers as the self rail.
    expect(q.getByTestId("rail-home-icon")).toBeTruthy();
    expect(q.getAllByRole("separator").length).toBeGreaterThan(0);
    // Neither the classic self groups nor a flat (header-less) rail.
    expect(q.queryByText("From WCM systems")).toBeNull();
    expect(q.queryByText("Services")).toBeNull();
  });

  it("keeps the flat superuser rail (no section headers) when the flag is off", () => {
    render(<EditPage ctx={ctx} mode="superuser" attr="home" grantRecsEnabled biosketchEnabled />);
    const q = rail();
    expect(q.getByTestId("rail-home")).toBeTruthy();
    // The flat superuser rail carries no group headers at all.
    expect(q.queryByText("Profile content")).toBeNull();
    expect(q.queryByText("From WCM records")).toBeNull();
    expect(q.queryByText("Tools")).toBeNull();
    expect(q.queryByText("Settings")).toBeNull();
    expect(q.queryByText("landing")).toBeNull();
  });
});
