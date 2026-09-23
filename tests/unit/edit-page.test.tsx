/**
 * `components/edit/edit-page.tsx` — the `/edit/*` detail router inside the
 * Apollo shell (#160 UI follow-up). The rail selects one attribute; the router
 * renders that attribute's panel for the active `?attr=`. Panel internals are
 * tested elsewhere; this is the rail + routing + role-parity wiring.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
// Mock the editor to skip the Tiptap mount — covered by overview-editor tests.
vi.mock("@/components/edit/overview-editor", () => ({
  OverviewEditor: ({ initialHtml }: { initialHtml: string }) => (
    <textarea data-testid="mock-editor" defaultValue={initialHtml} />
  ),
}));
// Mock the CV tool to skip its fetch-on-mount — its own internals are covered
// elsewhere; here we only care whether EditShell wraps it `inert` (#2482).
vi.mock("@/components/edit/cv-tool", () => ({
  CvTool: () => (
    <button type="button" data-testid="download-cv">
      Download CV (WCM format)
    </button>
  ),
}));
// EditShell's top bar now mounts the real, self-fetching AccountMenu
// (context="console" — dwd2001 nav fix), which probes /api/auth/session on
// every mount. Stub it out: this file isn't testing the account menu (that's
// account-menu.test.tsx / console-top-bar.test.tsx), and several cases here
// assert exact `fetch` call counts that a live probe would pollute.
vi.mock("@/components/site/account-menu", () => ({ AccountMenu: () => null }));

import { EditPage } from "@/components/edit/edit-page";
import type { EditContext } from "@/lib/api/edit-context";

const ctx: EditContext = {
  // #2719 — null is the flag-off shape: the Title row stays a plain read-only
  // value, which is what every assertion in this file expects.
  titlePicker: null,
  scholar: {
    cwid: "self01",
    slug: "self-slug",
    preferredName: "Alex Self",
    fullName: "Alex Self, MD",
    primaryTitle: "Professor of Medicine",
    postnominal: "MD, MPH",
    primaryDepartment: "Medicine",
    primaryOrgCode: "WCMC",
    email: "self01@med.cornell.edu",
    emailVisibility: "public",
    orcid: null,
    roleCategory: "full_time_faculty",
    overview: "<p>Hi.</p>",
    slugOverride: null,
    hiddenSections: [],
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
  historicalAppointments: [],
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
  // AVAILABLE_TECHNOLOGIES_SECTION — empty by default (loader returns [] unless
  // the flag is on AND the scholar has inventions); a dedicated describe block
  // below exercises the populated case.
  technologies: [],
  news: [],
  // DATA_SHARING_SECTION — empty by default (loader returns [] unless the flag
  // is on AND the scholar has deposits); a dedicated describe block below
  // exercises the populated case.
  datasets: [],
  mentees: [
    {
      externalId: "self01:mentee9",
      name: "Jordan Mentee",
      subtitle: "Immunology (PhD)",
      state: "shown",
      suppressionId: null,
    },
  ],
  // #2011 — no hand-entered mentees in the default fixture; the sourced roster
  // above is what the hide-only panel renders.
  manualMentees: [],
  profileLinks: {},
  manualMenteeUnresolvedCwids: [],
  // #2634 — empty by default (loader returns [] unless SELF_EDIT_MENTEE_SUGGESTIONS
  // is on for a genuine self/superuser viewer); a describe block below populates it.
  menteeSuggestions: [],
  orcidVerdict: null,
  orcidCandidates: [],
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
    // The h1 now wraps a brand Link (badge + wordmark) to /edit (dwd2001 nav
    // fix), so match by accessible name — not raw textContent, which also
    // includes the aria-hidden "WCM" badge glyph — for the console name.
    expect(
      screen.getByRole("heading", { level: 1, name: "Scholars Console" }),
    ).toBeTruthy();
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

  it("Home: no bio shows 'No overview yet' as an open item, in the self voice", () => {
    const noBio: EditContext = { ...ctx, scholar: { ...ctx.scholar, overview: "   " } };
    render(<EditPage ctx={noBio} mode="self" />);
    const overview = screen.getByTestId("home-item-overview");
    expect(overview.textContent).toContain("No overview yet");
    expect(overview.textContent).toContain("Two or three sentences on your research focus.");
    const cta = screen.getByTestId("home-card-overview");
    expect(cta.getAttribute("href")).toBe("/edit?attr=overview");
    expect(cta.textContent).toContain("Write");
  });

  it("Home: pins the heading as a word count of the open rows, never a percentage or fraction", () => {
    // bio ✓ + 1 pub ✓ + visibility ✓; the headshot probe stays "loading" in
    // jsdom (no Image load) so it is informational, not open; the fixture has
    // no ORCID → one open row.
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.getByRole("heading", { level: 2, name: "One item needs you" })).toBeTruthy();
    expect(screen.getByText("Everything else on this profile is either complete or maintained from WCM records.")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/\d of \d/)).toBeNull();
  });

  it("Home: the heading counts open rows — no bio + no ORCID are two; an empty publications feed is informational, not open", () => {
    const sparse: EditContext = {
      ...ctx,
      scholar: { ...ctx.scholar, overview: "" },
      publications: [],
    };
    render(<EditPage ctx={sparse} mode="self" />);
    expect(screen.getByRole("heading", { level: 2, name: "Two items need you" })).toBeTruthy();
    // Publications-empty row state sits under the disclosure, not among the open rows.
    const pubs = screen.getByTestId("home-item-publications");
    expect(pubs.textContent).toContain("None shown yet");
    expect(pubs.closest("ul")?.id).toBe("home-completed-items");
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
  it("Home: a loadable headshot resolves to 'Headshot added' and completes all but the ORCID row (one needs you)", async () => {
    stubImage("load");
    try {
      render(<EditPage ctx={ctx} mode="self" />);
      expect(await screen.findByText("Headshot added")).toBeTruthy();
      expect(screen.getByRole("heading", { level: 2, name: "One item needs you" })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Home: the ORCID row — not on file → to-do with the reason; CTA into the tab when the flag is on", () => {
    render(<EditPage ctx={ctx} mode="self" orcidTabEnabled />);
    const row = screen.getByTestId("home-item-orcid");
    expect(row.textContent).toContain("ORCID iD not on file");
    expect(row.textContent).toContain(
      "Needed for NIH SciENcv biosketches; also makes your publication matching more reliable.",
    );
    expect(row.textContent).not.toContain("has no ORCID iD on file");
    const cta = screen.getByTestId("home-card-orcid");
    expect(cta.textContent).toContain("Add");
    expect(cta.getAttribute("href")).toBe("/edit?attr=identifiers-profiles");
  });

  it("Home: the ORCID row — a strong inference asks 'Is this your ORCID iD?' with the evidence and a Review button; it does not count as done", () => {
    const withSuggestion: EditContext = {
      ...ctx,
      orcidVerdict: { tier: "strong", orcid: "0000-0002-9930-2193", accepted: 3 },
    };
    render(<EditPage ctx={withSuggestion} mode="self" orcidTabEnabled />);
    const row = screen.getByTestId("home-item-orcid");
    expect(row.textContent).toContain("Is this your ORCID iD?");
    expect(row.textContent).toContain("0000-0002-9930-2193 · on 3 of your accepted publications in ReCiter");
    expect(row.textContent).toContain("WCM records");
    expect(screen.getByTestId("home-card-orcid").textContent).toContain("Review");
    expect(screen.getByTestId("home-card-orcid").getAttribute("href")).toBe("/edit?attr=identifiers-profiles");
    expect(screen.getByTestId("home-item-orcid-why").textContent).toBe(
      "Needed for NIH SciENcv biosketches; also makes your publication matching more reliable.",
    );
    expect(screen.getByRole("heading", { level: 2, name: "One item needs you" })).toBeTruthy();
    // The iD in the row links to its orcid.org record; ReCiter links out to Publication Manager.
    expect(within(row).getByRole("link", { name: "ReCiter" }).getAttribute("href")).toBe("https://reciter.weill.cornell.edu/");
    expect(within(row).getByRole("link", { name: "0000-0002-9930-2193" }).getAttribute("href")).toBe(
      "https://orcid.org/0000-0002-9930-2193",
    );
  });

  it("Identifiers & Profiles: the candidate rows reach the card as per-source evidence — under the on-file iD, and as a 'different iD' block when the inferred rows disagree", () => {
    const onFileWithEvidence: EditContext = {
      ...ctx,
      scholar: { ...ctx.scholar, orcid: "0000-0002-1825-0097" },
      orcidVerdict: { tier: "asserted", orcid: "0000-0002-1825-0097", accepted: 0 },
      orcidCandidates: [
        { orcid: "0000-0002-1825-0097", source: "rpm_admin", accepted: 0, rejected: 0 },
        { orcid: "0000-0002-9930-2193", source: "rpm_inferred", accepted: 4, rejected: 0 },
        { orcid: "0000-0002-9930-2193", source: "orcid_email", accepted: 0, rejected: 0 },
      ],
    };
    render(<EditPage ctx={onFileWithEvidence} mode="self" attr="identifiers-profiles" orcidTabEnabled />);
    expect(screen.getByTestId("orcid-on-file-evidence").textContent).toContain("Entered in ReCiter Publication Manager");
    expect(screen.getByTestId("orcid-on-file-status").textContent).toBe("On file");
    const also = screen.getByTestId("orcid-also-suggested");
    expect(also.textContent).toContain("0000-0002-9930-2193");
    expect(screen.getByTestId("orcid-also-suggested-status").textContent).toBe("High confidence suggestion");
    expect(within(also).getByTestId("orcid-also-suggested-evidence").querySelectorAll("li")).toHaveLength(2);
  });

  it("Home: with the flag off the ORCID CTA hands off to ReCiter Manage Profile (external), and the tab is not in the rail", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    const cta = screen.getByTestId("home-card-orcid");
    expect(cta.textContent).toContain("Add in ReCiter");
    expect(cta.getAttribute("href")).toBe(`https://reciter.weill.cornell.edu/manageprofile/${ctx.scholar.cwid}`);
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("link", { name: "Identifiers & profiles" })).toBeNull();
  });

  it("?attr=identifiers-profiles renders the ORCID card when the flag is on", () => {
    const withSuggestion: EditContext = {
      ...ctx,
      orcidVerdict: { tier: "strong", orcid: "0000-0002-9930-2193", accepted: 3 },
    };
    render(<EditPage ctx={withSuggestion} mode="self" attr="identifiers-profiles" orcidTabEnabled />);
    expect(document.querySelector('[data-slot="orcid-card"]')).not.toBeNull();
    expect(screen.getByTestId("orcid-confirm")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Identifiers & profiles" })).toBeTruthy();
  });

  it("Home: the ORCID row — on file (WCM Identity or an RPM-admin iD) → done, nothing left open", () => {
    const onFile: EditContext = {
      ...ctx,
      orcidVerdict: { tier: "asserted", orcid: "0000-0002-1825-0097", accepted: 0 },
    };
    render(<EditPage ctx={onFile} mode="self" />);
    const row = screen.getByTestId("home-item-orcid");
    expect(row.textContent).toContain("ORCID iD on file");
    expect(row.textContent).toContain("0000-0002-1825-0097");
    expect(screen.queryByTestId("home-card-orcid")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Nothing needs you" })).toBeTruthy();
  });

  it("Home: the ORCID row in superuser voice names the scholar by first name — second person is the editor", () => {
    const withSuggestion: EditContext = {
      ...ctx,
      orcidVerdict: { tier: "strong", orcid: "0000-0002-9930-2193", accepted: 0 },
    };
    render(<EditPage ctx={withSuggestion} mode="superuser" />);
    const row = screen.getByTestId("home-item-orcid");
    expect(row.textContent).toContain("Is this Alex's ORCID iD?");
    expect(row.textContent).toContain("matches Alex's record in the ORCID registry");
    expect(row.textContent).toContain("makes Alex's publication matching more reliable");
    expect(row.textContent).not.toContain("their");
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

  it("Home: completed items are collapsed by default under a disclosure; open items sit outside it", () => {
    // bio ✓, visibility ✓, 1 pub ✓, headshot still probing (info) → 4 in the
    // completed group; the only open item is the ORCID iD (not on file).
    render(<EditPage ctx={ctx} mode="self" />);
    const toggle = screen.getByTestId("home-completed-toggle");
    expect(toggle.textContent).toContain("4 completed items");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const list = document.getElementById(toggle.getAttribute("aria-controls")!) as HTMLElement;
    expect(list.hidden).toBe(true);
    expect(within(list).getByTestId("home-item-overview")).toBeTruthy();
    expect(within(list).getByTestId("home-item-visibility")).toBeTruthy();
    expect(within(list).getByTestId("home-item-headshot")).toBeTruthy();
    expect(within(list).getByTestId("home-item-publications")).toBeTruthy();
    expect(within(list).queryByTestId("home-item-orcid")).toBeNull();
    expect(screen.getByTestId("home-item-orcid")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("Hide 4 completed items");
    expect(list.hidden).toBe(false);
  });

  it("Home: 'One item needs you' is singular, and the disclosure counts the rest", async () => {
    stubImage("load");
    try {
      const onFile: EditContext = {
        ...ctx,
        scholar: { ...ctx.scholar, overview: "" },
        orcidVerdict: { tier: "asserted", orcid: "0000-0002-1825-0097", accepted: 0 },
      };
      render(<EditPage ctx={onFile} mode="self" />);
      expect(await screen.findByText("Headshot added")).toBeTruthy();
      expect(screen.getByRole("heading", { level: 2, name: "One item needs you" })).toBeTruthy();
      expect(screen.getByTestId("home-completed-toggle").textContent).toContain("4 completed items");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Home: all five satisfied → 'Nothing needs you', no open rows, five completed items", async () => {
    stubImage("load");
    try {
      const complete: EditContext = {
        ...ctx,
        orcidVerdict: { tier: "asserted", orcid: "0000-0002-1825-0097", accepted: 0 },
      };
      render(<EditPage ctx={complete} mode="self" />);
      expect(await screen.findByText("Headshot added")).toBeTruthy();
      expect(screen.getByRole("heading", { level: 2, name: "Nothing needs you" })).toBeTruthy();
      expect(
        screen.getByText("Everything on this profile is either complete or maintained from WCM records."),
      ).toBeTruthy();
      const toggle = screen.getByTestId("home-completed-toggle");
      expect(toggle.textContent).toContain("5 completed items");
      const list = document.getElementById(toggle.getAttribute("aria-controls")!) as HTMLElement;
      expect(within(list).getAllByTestId(/^home-item-/)).toHaveLength(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an unknown ?attr falls back to the default (Home)", () => {
    render(<EditPage ctx={ctx} mode="self" attr="does-not-exist" />);
    expect(document.querySelector('[data-slot="home-panel"]')).not.toBeNull();
  });

  it("?attr=appointments renders the Positions panel + a row", () => {
    render(<EditPage ctx={ctx} mode="self" attr="appointments" />);
    expect(document.querySelector('[data-slot="appointments-panel"]')).not.toBeNull();
    expect(screen.getByTestId("appointment-row-appt-1")).toBeTruthy();
    expect(screen.getByText("Professor of Medicine")).toBeTruthy();
  });

  // #1557 — self-serve reveal. The scholar themselves (mode="self") sees the
  // Earlier ranks section, not just curators/stewards.
  it("?attr=appointments surfaces the Earlier ranks section to the SELF scholar (#1557)", () => {
    const withHistorical: EditContext = {
      ...ctx,
      historicalAppointments: [
        {
          externalId: "hist-1",
          title: "Assistant Professor",
          organization: "Prior University",
          startDate: "2008-01-01",
          endDate: "2014-12-31",
          showOnProfile: false,
        },
      ],
    };
    render(<EditPage ctx={withHistorical} mode="self" attr="appointments" />);
    expect(screen.getByText("Earlier ranks")).toBeTruthy();
    expect(screen.getByTestId("historical-appointment-row-hist-1")).toBeTruthy();
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

  // #1997 — the graduation-year switch is the ONLY writer of `hideEducationYears`.
  it("the Education panel's years switch POSTs the hideEducationYears override", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    try {
      render(<EditPage ctx={ctx} mode="self" attr="education" />);
      // The switch reads "Show graduation years", so clicking it OFF hides them.
      fireEvent.click(screen.getByTestId("education-years-toggle"));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const [url, opts] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/edit/field");
      expect(JSON.parse(opts.body as string)).toEqual({
        entityType: "scholar",
        entityId: "self01",
        fieldName: "hideEducationYears",
        value: "true",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("?attr=name-title renders the read-only panel with a Request a change link per row", () => {
    render(<EditPage ctx={ctx} mode="self" attr="name-title" />);
    expect(screen.queryByText("This section is not editable.")).toBeNull();
    // One link per row replaces the panel-level trigger.
    expect(screen.queryByTestId("request-a-change-toggle")).toBeNull();
    for (const row of ["name", "title", "degrees", "department", "institution"]) {
      expect(screen.getByTestId(`request-a-change-row-${row}`)).toBeTruthy();
    }
    // A row's link opens the router with that row's issue already selected.
    fireEvent.click(screen.getByTestId("request-a-change-row-degrees"));
    const radio = within(screen.getByTestId("rac-issue-degrees-wrong")).getByRole("radio");
    expect(radio.getAttribute("aria-checked")).toBe("true");
    // Email moved to its own tab — the Name & Title panel no longer echoes it.
    expect(screen.queryByText("self01@med.cornell.edu")).toBeNull();
    // Institution row: the home code is named, not echoed bare.
    expect(screen.getByText("Institution")).toBeTruthy();
    expect(screen.getByText("Weill Cornell Medicine")).toBeTruthy();
    expect(screen.queryByText("WCMC")).toBeNull();
  });

  it("name-title: an empty row reads None on record; the Photo tab is one row with its own link", () => {
    const noDeg = { ...ctx, scholar: { ...ctx.scholar, postnominal: null } };
    const { unmount } = render(<EditPage ctx={noDeg} mode="self" attr="name-title" />);
    expect(screen.getByText("None on record")).toBeTruthy();
    unmount();
    render(<EditPage ctx={ctx} mode="self" attr="photo" />);
    expect(screen.getByTestId("request-a-change-row-photo")).toBeTruthy();
    expect(screen.queryByTestId("request-a-change-toggle")).toBeNull();
    expect(screen.queryByText("This section is not editable.")).toBeNull();
  });

  it("name-title says choose only to a superuser / comms steward, and only when there is a choice", () => {
    const picker = {
      options: [
        { tier: "working", label: "Working title", value: "Associate Dean" },
        { tier: "chief", label: "Division chief", value: null },
        { tier: "centerHead", label: "Center head", value: null },
        { tier: "primary", label: "Primary title", value: "Professor of Medicine" },
      ],
      current: "Associate Dean",
      override: null,
      pending: null,
    };
    const withPicker = { ...ctx, titlePicker: picker } as typeof ctx;
    const { unmount } = render(<EditPage ctx={withPicker} mode="self" attr="name-title" />);
    // The scholar (and a proxy / unit admin) can't pick, so no "choose" sentence;
    // the read-only list carries the Request a change pointer instead.
    expect(screen.queryByText(/which recorded title is displayed/)).toBeNull();
    expect(screen.getByTestId("title-recourse")).toBeTruthy();
    unmount();
    const opCtx = { ...superuserCtx, titlePicker: picker } as typeof superuserCtx;
    const again = render(<EditPage ctx={opCtx} mode="superuser" attr="name-title" />);
    expect(screen.getByText(/You can choose which recorded title is displayed\./)).toBeTruthy();
    again.unmount();
    render(<EditPage ctx={ctx} mode="self" attr="name-title" />);
    expect(screen.queryByText(/which recorded title is displayed/)).toBeNull();
  });

  it("name-title names a non-WCM primary institution and blanks a null one", () => {
    const hss = { ...ctx, scholar: { ...ctx.scholar, primaryOrgCode: "HSS" } };
    const { unmount } = render(<EditPage ctx={hss} mode="self" attr="name-title" />);
    expect(screen.getByText("Hospital for Special Surgery")).toBeTruthy();
    unmount();
    const none = { ...ctx, scholar: { ...ctx.scholar, primaryOrgCode: null } };
    render(<EditPage ctx={none} mode="self" attr="name-title" />);
    expect(screen.getByText("Institution")).toBeTruthy();
    expect(screen.queryByText("Weill Cornell Medicine")).toBeNull();
  });

  it("?attr=email renders the read-only Email tab: email, visibility label + explainer, Web Directory link", () => {
    render(<EditPage ctx={ctx} mode="self" attr="email" />);
    expect(document.querySelector('[data-slot="email-panel"]')).not.toBeNull();
    expect(screen.getByText("self01@med.cornell.edu")).toBeTruthy();
    // 'public' → "Public" label per SPEC table A.
    expect(screen.getByTestId("email-visibility-label").textContent).toBe("Public");
    expect(screen.getByTestId("email-visibility-explainer").textContent).toBe(
      "Anyone on the web can see it on the public profile.",
    );
    // #919 — download / on-network policy note (general; no numeric cap surfaced).
    const policy = screen.getByTestId("email-download-policy");
    expect(policy.textContent).toMatch(/signed in or on the campus network/i);
    expect(policy.textContent).toMatch(/internal directory export/i);
    expect(policy.textContent).toMatch(/that access is logged/i);
    expect(policy.textContent).toMatch(/left out of the export/i);
    expect(policy.textContent).toMatch(/bulk downloads of large groups aren.t supported/i);
    expect(policy.textContent).not.toMatch(/50/);
    // Locked-panels canvas: provenance in the header pill, no "not editable" footer.
    expect(screen.getByText("Enterprise Directory")).toBeTruthy();
    expect(screen.queryByText("This section is not editable.")).toBeNull();
    // Read-only: no control that writes the release code, just the SOR link.
    const link = screen.getByTestId("email-web-directory-link");
    expect(link.getAttribute("href")).toBe(
      "https://directory.weill.cornell.edu/update/profile/index",
    );
  });

  it("Email tab copy is voice-neutral, so a superuser never reads 'your' (#919)", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" attr="email" />);
    const panel = document.querySelector('[data-slot="email-panel"]')!;
    expect(panel.textContent).not.toMatch(/\byour\b/i);
    expect(panel.textContent).toContain("The contact email on the public profile, and who can see it.");
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
    // Suppressible → the row carries a select checkbox for the bulk hide verb
    // (not a read-only panel).
    expect(
      within(screen.getByTestId("mentee-row-self01:mentee9")).getByRole("checkbox"),
    ).toBeTruthy();
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

  it("surfaces coi-gap in superuser mode when candidates are present (operator decision), with the viewer-neutral rail label", () => {
    const suCtx: EditContext = { ...superuserCtx, unmatchedPubmedCoi: gapCtx.unmatchedPubmedCoi };
    render(<EditPage ctx={suCtx} mode="superuser" />);
    const rail = screen.getByTestId("rail-coi-gap");
    expect(rail).toBeTruthy();
    // §7.4 — describes the thing, not the source/viewer; same label for self + superuser.
    expect(rail.textContent).toContain("Disclosed in publications");
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

describe("EditPage router — mentee-suggestions rail + Mentees pointer (#2634)", () => {
  const sugg = (id: number, over: Partial<EditContext["menteeSuggestions"][number]> = {}) => ({
    id,
    menteeCwid: `mnt${id}`,
    menteeName: `Mentee ${id}`,
    menteeTitle: null,
    menteeUnit: null,
    kind: "postdoc" as const,
    tier: "presumptive" as const,
    nCoPubs: 3,
    nMentorLastAuthor: 2,
    firstYear: 2024,
    lastYear: 2026,
    menteeFirstPublishedYear: 2022,
    strong: false,
    dismissedAt: null,
    dismissReason: null,
    evidence: [],
    ...over,
  });
  const withSugg: EditContext = {
    ...ctx,
    menteeSuggestions: [sugg(1), sugg(2), sugg(3, { dismissedAt: "2026-09-01T00:00:00.000Z", dismissReason: "colleague" })],
  };

  it("no rows → no rail item, and ?attr=mentee-suggestions canonicalizes away", () => {
    render(<EditPage ctx={ctx} mode="self" attr="mentee-suggestions" />);
    expect(screen.queryByTestId("rail-mentee-suggestions")).toBeNull();
    expect(document.querySelector('[data-slot="mentee-suggestions-panel"]')).toBeNull();
    expect(document.querySelector('[data-slot="home-panel"]')).not.toBeNull();
  });

  it("rows → nested child right after Mentees, badge = ACTIVE (non-dismissed) count", () => {
    render(<EditPage ctx={withSugg} mode="self" />);
    const item = screen.getByTestId("rail-mentee-suggestions");
    expect(item.textContent).toContain("From your publications");
    expect(item.className).toContain("pl-7");
    expect(item.querySelector('[aria-label="2 to review"]')?.textContent).toBe("2");
    // Immediately follows Mentees in the rail (it nests under the preceding item).
    const keys = Array.from(document.querySelectorAll('[data-testid^="rail-"]')).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(keys.indexOf("rail-mentee-suggestions")).toBe(keys.indexOf("rail-mentees") + 1);
    expect(keys.indexOf("rail-coi")).toBe(keys.indexOf("rail-mentee-suggestions") + 1);
  });

  it("a dismissed-only history still surfaces the item, without a badge or a Mentees pointer", () => {
    const goneOnly: EditContext = { ...ctx, menteeSuggestions: [withSugg.menteeSuggestions[2]] };
    render(<EditPage ctx={goneOnly} mode="self" attr="mentees" />);
    const item = screen.getByTestId("rail-mentee-suggestions");
    expect(item.querySelector('[aria-label$="to review"]')).toBeNull();
    expect(screen.queryByTestId("mentee-suggestions-pointer")).toBeNull();
  });

  it("Mentees tab shows one pointer line linking to the sub-view on the ACTIVE surface", () => {
    render(<EditPage ctx={withSugg} mode="self" attr="mentees" />);
    const p = screen.getByTestId("mentee-suggestions-pointer");
    expect(p.textContent).toContain("2 co-authors look like trainees");
    expect(p.querySelector("a")?.getAttribute("href")).toBe("/edit?attr=mentee-suggestions");
  });

  it("?attr=mentee-suggestions renders the card; superuser gets the scholar-named add button + superuser hrefs", () => {
    const suCtx: EditContext = { ...superuserCtx, menteeSuggestions: withSugg.menteeSuggestions };
    render(<EditPage ctx={suCtx} mode="superuser" attr="mentee-suggestions" />);
    expect(document.querySelector('[data-slot="mentee-suggestions-panel"]')).not.toBeNull();
    expect(screen.getByTestId("mentee-suggestion-add-1").textContent).toBe("Add for Alex Other");
    expect(screen.getByTestId("mentee-suggestions-back").getAttribute("href")).toBe(
      "/edit/scholar/other7?attr=mentees",
    );
  });

  it("is never offered to a proxy", () => {
    render(<EditPage ctx={withSugg} mode="proxy" attr="mentee-suggestions" />);
    expect(screen.queryByTestId("rail-mentee-suggestions")).toBeNull();
    expect(document.querySelector('[data-slot="mentee-suggestions-panel"]')).toBeNull();
  });
});

describe("EditPage router — Available technologies rail (AVAILABLE_TECHNOLOGIES_SECTION)", () => {
  const withTech: EditContext = {
    ...ctx,
    technologies: [
      {
        url: "https://innovation.weill.cornell.edu/technology-portfolio/widget",
        title: "A Licensable Widget",
        reference: "11166",
        patentStatus: "US Application Filed",
        pmids: ["31508198"],
        overview: "The Technology: a widget.",
        hasPocData: true,
      },
    ],
  };

  it("does NOT show the technologies rail item when the scholar has none (default)", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.queryByTestId("rail-technologies")).toBeNull();
  });

  it("an ?attr=technologies with no inventions canonicalizes away (Home renders instead)", () => {
    render(<EditPage ctx={ctx} mode="self" attr="technologies" />);
    expect(document.querySelector('[data-slot="technologies-panel"]')).toBeNull();
    expect(document.querySelector('[data-slot="home-panel"]')).not.toBeNull();
  });

  it("shows the technologies rail item ONLY when the scholar has ≥1 invention, read-only", () => {
    render(<EditPage ctx={withTech} mode="self" />);
    const item = screen.getByTestId("rail-technologies");
    expect(item).toBeTruthy();
    // CTL-owned → read-only rail cue (same kind as coi).
    expect(item.textContent).toMatch(/read-only, from WCM systems/i);
  });

  it("?attr=technologies renders the read-only card with a row + the CTL contact note", () => {
    render(<EditPage ctx={withTech} mode="self" attr="technologies" />);
    expect(document.querySelector('[data-slot="technologies-panel"]')).not.toBeNull();
    expect(screen.getByText("A Licensable Widget")).toBeTruthy();
    expect(screen.getByText("This section is not editable.")).toBeTruthy();
    // No write control anywhere in the panel.
    expect(screen.queryByRole("button", { name: /hide/i })).toBeNull();
    expect(screen.queryByTestId("request-a-change-toggle")).toBeNull();
  });

  it("surfaces the technologies rail item in superuser mode too when populated", () => {
    const suCtx: EditContext = { ...superuserCtx, technologies: withTech.technologies };
    render(<EditPage ctx={suCtx} mode="superuser" />);
    const item = screen.getByTestId("rail-technologies") as HTMLAnchorElement;
    expect(item.getAttribute("href")).toBe("/edit/scholar/other7?attr=technologies");
  });

  it("#1639 — threads availableTechnologies into the Visibility Sections panel (populated → toggle shows)", () => {
    render(<EditPage ctx={withTech} mode="self" attr="visibility" />);
    // ctx.technologies non-empty ⇒ the 8th (applicability-gated) hide toggle renders.
    expect(screen.getByTestId("section-toggle-hideTechnologies")).toBeTruthy();
  });

  it("#1639 — no technologies ⇒ the Visibility Sections panel omits the toggle", () => {
    render(<EditPage ctx={ctx} mode="self" attr="visibility" />);
    // The other section toggles still render; the technologies one is gated off.
    expect(screen.getByTestId("section-toggle-hideMethods")).toBeTruthy();
    expect(screen.queryByTestId("section-toggle-hideTechnologies")).toBeNull();
  });
});

describe("EditPage router — Datasets rail (DATA_SHARING_SECTION, #2348)", () => {
  const withDatasets: EditContext = {
    ...ctx,
    datasets: [
      {
        datasetId: "ds-1",
        repository: "GEO",
        accessionOrDoi: "GSE12345",
        resourceType: "Dataset",
        dataType: "RNA-seq",
        depositYear: 2023,
        accessModel: "open",
        confidence: "high",
        title: null,
        provenance: "fulltext-scan",
        pmids: ["12345678"],
        authorPosition: "first",
        state: "shown",
        suppressionId: null,
        hiddenAt: null,
      },
    ],
  };

  it("does NOT show the datasets rail item when the scholar has none (default)", () => {
    render(<EditPage ctx={ctx} mode="self" />);
    expect(screen.queryByTestId("rail-datasets")).toBeNull();
  });

  it("an ?attr=datasets with no deposits canonicalizes away (Home renders instead)", () => {
    render(<EditPage ctx={ctx} mode="self" attr="datasets" />);
    expect(document.querySelector('[data-slot="datasets-card"]')).toBeNull();
    expect(document.querySelector('[data-slot="home-panel"]')).not.toBeNull();
  });

  it("shows the datasets rail item ONLY when the scholar has ≥1 deposit", () => {
    render(<EditPage ctx={withDatasets} mode="self" />);
    expect(screen.getByTestId("rail-datasets")).toBeTruthy();
  });

  it("?attr=datasets renders the datasets card with a row", () => {
    render(<EditPage ctx={withDatasets} mode="self" attr="datasets" />);
    expect(document.querySelector('[data-slot="datasets-card"]')).not.toBeNull();
    const row = screen.getByTestId("dataset-row-ds-1");
    expect(row.textContent).toContain("GEO");
    expect(row.textContent).toContain("GSE12345");
  });

  it("surfaces the datasets rail item in superuser mode too when populated", () => {
    const suCtx: EditContext = { ...superuserCtx, datasets: withDatasets.datasets };
    render(<EditPage ctx={suCtx} mode="superuser" />);
    const item = screen.getByTestId("rail-datasets") as HTMLAnchorElement;
    expect(item.getAttribute("href")).toBe("/edit/scholar/other7?attr=datasets");
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
      const panel = document.querySelector('[data-slot="email-panel"]')!;
      expect(panel.textContent).not.toMatch(/\byour\b/i);
    },
  );

  it.each(["proxy", "unit-admin"] as const)(
    "Home board reads third-person (the scholar's name, never 'your') for a %s editor",
    (mode) => {
      render(<EditPage ctx={superuserCtx} mode={mode} attr="home" />);
      expect(screen.getByTestId("home-item-overview").textContent).toContain(
        "Showing at the top of Alex Other's public profile.",
      );
      expect(screen.getByTestId("home-item-orcid").textContent).toContain("makes Alex's publication matching");
      expect(document.querySelector('[data-slot="home-panel"]')?.textContent).not.toMatch(/\byour\b/);
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

describe("EditPage — unit-admin Profiles crumb (dwd2001 bug #7)", () => {
  it("forwards profilesNavVisible={true} to EditShell's navigable 'Profiles' crumb for a unit admin", () => {
    render(<EditPage ctx={superuserCtx} mode="unit-admin" profilesNavVisible={true} />);
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const link = within(crumb).getByTestId("edit-subnav-profiles");
    expect(link.getAttribute("href")).toBe("/edit/profiles");
  });

  it("defaults to the flat unit-admin label when profilesNavVisible is omitted", () => {
    render(<EditPage ctx={superuserCtx} mode="unit-admin" />);
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).queryByTestId("edit-subnav-profiles")).toBeNull();
    expect(within(crumb).getByTestId("edit-subnav-unit-admin")).toBeTruthy();
  });

  it("a proxy editor stays flat even when profilesNavVisible={true} — proxy mode never reads it", () => {
    render(<EditPage ctx={superuserCtx} mode="proxy" profilesNavVisible={true} />);
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).queryByTestId("edit-subnav-profiles")).toBeNull();
    expect(within(crumb).getByTestId("edit-subnav-proxy")).toBeTruthy();
  });
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

  it("Home (superuser): needs-you header, Overview is editable (#844), Publications has a Review CTA, no units section", () => {
    render(<EditPage ctx={superuserCtx} mode="superuser" attr="home" />);
    // Same count as self: only the ORCID row is open (no pubs / probing headshot are informational).
    expect(screen.getByRole("heading", { level: 2, name: "One item needs you" })).toBeTruthy();
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
      // The Draft-with-AI rail sits beside the editor, always open.
      expect(screen.getByTestId("overview-draft-block")).toBeTruthy();
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
  // Scope assertions to the attribute rail's <nav> so panel copy never collides
  // with rail group labels.
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

describe("EditPage router — cv_generator mode (#2482, read-only)", () => {
  it("?attr=overview is inert (write affordance blocked) and the banner reads read-only", () => {
    render(<EditPage ctx={superuserCtx} mode="cv-generator" attr="overview" />);
    expect(screen.getByRole("alert").textContent).toContain("read-only");
    expect(screen.getByRole("alert").textContent).not.toContain("as an administrator");
    // The overview editor mount (mock-editor) renders inside the inert wrapper.
    expect(screen.getByTestId("mock-editor").closest("[inert]")).not.toBeNull();
  });

  it("?attr=cv is the ONE exception — the Download CV button stays interactive", () => {
    render(<EditPage ctx={superuserCtx} mode="cv-generator" attr="cv" cvEnabled />);
    // Banner still tells the truth even on the exempted panel.
    expect(screen.getByRole("alert").textContent).toContain("read-only");
    // But the download control is NOT wrapped inert.
    expect(screen.getByTestId("download-cv").closest("[inert]")).toBeNull();
  });

  it("sees the CV rail item (superuser-parity content set) when cvEnabled", () => {
    render(<EditPage ctx={superuserCtx} mode="cv-generator" attr="home" cvEnabled />);
    expect(screen.getByText("CV (WCM format)")).toBeTruthy();
  });
});
