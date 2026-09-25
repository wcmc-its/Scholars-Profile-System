/**
 * `components/edit/center-roster-card.tsx` — the rich #552 §6.1 roster table.
 * Covers the program-gated columns, derived status, the segmented filter,
 * inline set PATCHes, the folded date-range popover, add/remove, and the
 * Edit Center redesign: status tabs with counts, the Program filter, paging,
 * the left-WCM banner, confirmed-only disease chips, and the disease review
 * sheet (confirm / reject / undo / bulk high-confidence / manual add / queue).
 *
 * The review sheet renders in a Radix portal, so its assertions are scoped to
 * the sheet's own element (`sheet()`), never `document.body`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { RosterDiseaseRow } from "@/lib/api/unit-edit-context";

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    value,
    onChange,
  }: {
    value: { cwid: string; name: string } | null;
    onChange: (v: { cwid: string; name: string; title: string | null } | null) => void;
  }) =>
    value ? (
      <span data-testid="picked">{value.name}</span>
    ) : (
      <button
        type="button"
        data-testid="typeahead-pick"
        onClick={() => onChange({ cwid: "new9", name: "New Person", title: "MD" })}
      >
        pick
      </button>
    ),
}));

import { CenterRosterCard, type RosterMember } from "@/components/edit/center-roster-card";

const PROGRAMS = [
  { code: "CT", label: "Cancer Therapeutics", sortOrder: 40 },
  { code: "CB", label: "Cancer Biology", sortOrder: 10 },
];

const TODAY = "2026-05-28";

function member(over: Partial<RosterMember>): RosterMember {
  return {
    cwid: "m1",
    name: "Member One",
    title: "PhD",
    membershipType: null,
    programCode: null,
    startDate: null,
    endDate: null,
    ...over,
  };
}

function diseaseRow(over: Partial<RosterDiseaseRow>): RosterDiseaseRow {
  return {
    diseaseCode: "BREAST",
    assignment: {
      rank: 1,
      focus: "primary",
      confidence: "medium",
      leadPubs: 2,
      secondPubs: 1,
      middlePubs: 2,
      grantsLed: 0,
      grantsSupport: 0,
      trialsLed: 1,
      trialsSupport: 0,
      pubScore: 10,
      score: 10,
      firstYear: 2018,
      lastYear: 2025,
      recentPubs: 3,
      specialtyStatus: "match",
    },
    decision: null,
    drifted: false,
    ...over,
  };
}

const DISEASE_OPTIONS = [
  { code: "BREAST", label: "Breast Cancer" },
  { code: "GI_COLORECTAL", label: "Colorectal & Anal Cancer" },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubOk() {
  // A fresh Response per call: a body can only be read once, and the bulk
  // confirm makes several calls.
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ ok: true, changed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
}

const base = { unitCode: "meyer_cancer_center", today: TODAY };

const MEMBERSHIP_ROLES = [
  { key: "core_faculty", label: "Core Faculty Fellow", sortOrder: 10 },
  { key: "affiliate_faculty", label: "Affiliate Faculty Fellow", sortOrder: 20 },
];

describe("CenterRosterCard — columns", () => {
  it("shows Role + Program columns when the center has a program taxonomy", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={PROGRAMS} />);
    expect(screen.getByTestId("roster-type-m1")).toBeTruthy();
    expect(screen.getByTestId("roster-program-m1")).toBeTruthy();
  });

  it("hides Program for a center with no programs, but Role always shows (the Cancer-Center-only gate)", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    expect(screen.getByTestId("roster-type-m1")).toBeTruthy();
    expect(screen.queryByTestId("roster-program-m1")).toBeNull();
    // dates (folded under Member with no Program column) + status still present
    expect(screen.getByTestId("roster-dates-trigger-m1")).toBeTruthy();
    expect(screen.getByTestId("roster-status-m1")).toBeTruthy();
  });

  it("empty roster shows the empty state", () => {
    render(<CenterRosterCard {...base} members={[]} programs={PROGRAMS} />);
    expect(screen.getByTestId("center-roster-empty")).toBeTruthy();
  });
});

describe("CenterRosterCard — Role column vocabulary (CHPC fellow roles)", () => {
  it("renders the role select with vocabulary labels even with no programs", () => {
    render(
      <CenterRosterCard {...base} members={[member({})]} programs={[]} membershipRoles={MEMBERSHIP_ROLES} />,
    );
    const select = screen.getByTestId("roster-type-m1") as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["Member", "Core Faculty Fellow", "Affiliate Faculty Fellow"]);
  });

  it("renders a Member option even when the vocabulary is empty", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    const select = screen.getByTestId("roster-type-m1") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["member"]);
  });

  it("changing the role POSTs set with membershipRoleKey only (not membershipType)", async () => {
    const fetchMock = stubOk();
    render(
      <CenterRosterCard
        {...base}
        members={[member({})]}
        programs={[]}
        membershipRoles={MEMBERSHIP_ROLES}
      />,
    );
    fireEvent.change(screen.getByTestId("roster-type-m1"), { target: { value: "core_faculty" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({
      unitType: "center",
      unitCode: "meyer_cancer_center",
      cwid: "m1",
      action: "set",
      membershipRoleKey: "core_faculty",
    });
    expect(body).not.toHaveProperty("membershipType");
  });
});

describe("CenterRosterCard — Export .xlsx affordance (#1102)", () => {
  it("hides the export link when exportEnabled is false (flag off / default)", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    expect(screen.queryByTestId("center-roster-export-link")).toBeNull();
  });

  it("exports the WHOLE roster — no activeOnly param, in any filter", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} exportEnabled />);
    const link = screen.getByTestId("center-roster-export-link") as HTMLAnchorElement;
    expect(link.textContent).toMatch(/export \.xlsx/i);
    // "Active only" stopped being one of the views, so the export carries every
    // row and its `status` column distinguishes them.
    expect(link.getAttribute("href")).toBe("/edit/center/meyer_cancer_center/export");

    fireEvent.click(screen.getByTestId("roster-filter-inactive"));
    expect(screen.getByTestId("center-roster-export-link").getAttribute("href")).toBe(
      "/edit/center/meyer_cancer_center/export",
    );
  });
});

describe("CenterRosterCard — the three mutually-exclusive filters", () => {
  const members = [
    member({ cwid: "act", name: "Active" }), // null dates → active
    member({ cwid: "pen", name: "Pending", startDate: "2027-01-01" }),
    member({ cwid: "ina", name: "Inactive", endDate: "2024-01-01" }),
  ];

  it("shows the WHOLE roster by default, with each status badged", () => {
    render(<CenterRosterCard {...base} members={members} programs={[]} />);
    expect(screen.getByTestId("center-roster-row-act")).toBeTruthy();
    expect(screen.getByTestId("center-roster-row-pen")).toBeTruthy();
    expect(screen.getByTestId("center-roster-row-ina")).toBeTruthy();
    expect(screen.getByTestId("roster-status-act").textContent).toMatch(/active/i);
    expect(screen.getByTestId("roster-status-pen").textContent).toMatch(/pending/i);
    expect(screen.getByTestId("roster-status-ina").textContent).toMatch(/inactive/i);
  });

  it("\"Inactive members only\" narrows to Inactive — Pending is NOT inactive", () => {
    render(<CenterRosterCard {...base} members={members} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-filter-inactive"));
    expect(screen.getByTestId("center-roster-row-ina")).toBeTruthy();
    expect(screen.queryByTestId("center-roster-row-act")).toBeNull();
    expect(screen.queryByTestId("center-roster-row-pen")).toBeNull();
  });

  it("the Active badge is green; the others are not", () => {
    render(<CenterRosterCard {...base} members={members} programs={[]} />);
    expect(screen.getByTestId("roster-status-act").className).toMatch(/apollo-green/);
    expect(screen.getByTestId("roster-status-ina").className).not.toMatch(/apollo-green/);
  });
});

describe("CenterRosterCard — inline edits", () => {
  // Role's own inline-edit contract (membershipRoleKey, not membershipType) is
  // covered by "CenterRosterCard — Role column vocabulary" above.

  it("changing Program POSTs set with programCode", async () => {
    const fetchMock = stubOk();
    render(<CenterRosterCard {...base} members={[member({})]} programs={PROGRAMS} />);
    fireEvent.change(screen.getByTestId("roster-program-m1"), { target: { value: "CT" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ action: "set", programCode: "CT" });
  });

  it("setting a start date POSTs set with startDate", async () => {
    const fetchMock = stubOk();
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-dates-trigger-m1"));
    fireEvent.change(screen.getByTestId("roster-start-m1"), { target: { value: "2024-07-01" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ action: "set", startDate: "2024-07-01" });
  });

  it("blocks an end date before the start date (no POST, shows an error)", async () => {
    const fetchMock = stubOk();
    render(
      <CenterRosterCard {...base} members={[member({ startDate: "2025-01-01" })]} programs={[]} />,
    );
    fireEvent.click(screen.getByTestId("roster-dates-trigger-m1"));
    fireEvent.change(screen.getByTestId("roster-end-m1"), { target: { value: "2024-01-01" } });
    expect(screen.getByText(/can't be before the start date/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Add POSTs action:add and inserts the row", async () => {
    const fetchMock = stubOk();
    render(<CenterRosterCard {...base} members={[]} programs={PROGRAMS} />);
    fireEvent.click(screen.getByTestId("typeahead-pick"));
    fireEvent.click(screen.getByTestId("center-roster-add"));
    await waitFor(() => expect(screen.getByTestId("center-roster-row-new9")).toBeTruthy());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ cwid: "new9", action: "add" });
  });

  it("rolls back the optimistic add and shows an error when the response has no JSON body (#1828)", async () => {
    // A bodyless 401 (e.g. from auth middleware): res.json() rejects. Before the
    // fix, post() threw past add()'s rollback and left a phantom row with no error.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    render(<CenterRosterCard {...base} members={[]} programs={PROGRAMS} />);
    fireEvent.click(screen.getByTestId("typeahead-pick"));
    fireEvent.click(screen.getByTestId("center-roster-add"));
    // the optimistic row is inserted, then rolled back once the failed POST settles
    await waitFor(() => expect(screen.queryByTestId("center-roster-row-new9")).toBeNull());
    expect(screen.getByText(/wasn't saved/i)).toBeTruthy();
  });

  it("Remove confirms then POSTs action:remove and drops the row", async () => {
    const fetchMock = stubOk();
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-remove-m1"));
    // The confirm is "Remove anyway" — the row trigger stays "Remove", so the
    // two are distinguishable and this can't accidentally click the trigger.
    fireEvent.click(screen.getByRole("button", { name: "Remove anyway" }));
    await waitFor(() => expect(screen.queryByTestId("center-roster-row-m1")).toBeNull());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ cwid: "m1", action: "remove" });
  });

  it("the remove dialog steers to an End date rather than framing removal as cheap", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-remove-m1"));
    expect(screen.getByText(/End date instead/i)).toBeTruthy();
    expect(screen.getByText(/added in error/i)).toBeTruthy();
    // The old copy invited removal as reversible; it must not come back.
    expect(screen.queryByText(/add them back at any time/i)).toBeNull();
  });

  it("a member who already has an end date gets the erases-the-end-date warning", () => {
    render(
      // Future end date: an end date IS recorded, but the row stays
      // membership-active so the default show-active-only filter keeps it visible.
      <CenterRosterCard {...base} members={[member({ endDate: "2999-01-01" })]} programs={[]} />,
    );
    fireEvent.click(screen.getByTestId("roster-remove-m1"));
    expect(screen.getByText(/including the end date already recorded/i)).toBeTruthy();
  });
});

describe("departed / unresolvable members (#2324)", () => {
  it("shows departed members by default now, badged Left WCM, and counts the OPEN ones", () => {
    render(
      <CenterRosterCard
        {...base}
        members={[member({}), member({ cwid: "gone1", name: "Gone One", scholarState: "departed" })]}
        programs={[]}
      />,
    );
    // Nothing is hidden any more — the nudge is about outstanding work.
    expect(screen.getByTestId("center-roster-row-gone1")).toBeTruthy();
    expect(screen.getByTestId("roster-scholar-state-gone1").textContent).toBe("Left WCM");
    expect(screen.getByTestId("roster-needs-close-out").textContent).toMatch(
      /1 member has left WCM but their center membership is still open/i,
    );
  });

  it("\"Departed members only\" narrows to them, and drops the nudge", () => {
    render(
      <CenterRosterCard
        {...base}
        members={[member({}), member({ cwid: "gone1", name: "Gone One", scholarState: "departed" })]}
        programs={[]}
      />,
    );
    fireEvent.click(screen.getByTestId("roster-needs-close-out-jump"));
    expect(screen.getByTestId("center-roster-row-gone1")).toBeTruthy();
    expect(screen.queryByTestId("center-roster-row-m1")).toBeNull();
    // Already looking at them — repeating the nudge would be noise.
    expect(screen.queryByTestId("roster-needs-close-out")).toBeNull();
  });

  it("an unresolvable cwid is labelled rather than left as a bare id, and is NOT hidden", () => {
    // "unknown" is a data gap, not a departure — hiding it would bury exactly the
    // rows a center needs to clean up.
    render(
      <CenterRosterCard
        {...base}
        members={[member({ cwid: "ghost1", name: "ghost1", scholarState: "unknown" })]}
        programs={[]}
      />,
    );
    expect(screen.getByTestId("center-roster-row-ghost1")).toBeTruthy();
    expect(screen.getByTestId("roster-scholar-state-ghost1").textContent).toBe("Not in directory");
    expect(screen.queryByTestId("roster-needs-close-out")).toBeNull();
  });

  it("a Cornell (Ithaca) external member renders its name + a Cornell University badge, never Not in directory (#2519)", () => {
    render(
      <CenterRosterCard
        {...base}
        members={[
          member({ cwid: "ab123", name: "Alice Big", title: "Research Associate", scholarState: "external" }),
        ]}
        programs={[]}
      />,
    );
    expect(screen.getByTestId("center-roster-row-ab123")).toBeTruthy();
    expect(screen.getByText("Alice Big")).toBeTruthy();
    const badge = screen.getByTestId("roster-scholar-state-ab123");
    expect(badge.textContent).toBe("Cornell University");
    expect(badge.getAttribute("title")).toBe(
      "Cornell University (Ithaca) directory member — no WCM profile",
    );
    expect(screen.queryByText("Not in directory")).toBeNull();
    // Never flagged as needing close-out — an external member never had a WCM
    // identity to have "left".
    expect(screen.queryByTestId("roster-needs-close-out")).toBeNull();
  });

  it("a departed member with a CURRENT membership is visible AND flagged — the two axes are independent", () => {
    // The dangerous state: person left WCM, nobody closed the membership. It is
    // membership-Active, so the status filter cannot catch it.
    render(
      <CenterRosterCard
        {...base}
        members={[
          member({ cwid: "gone2", name: "Gone Two", scholarState: "departed", startDate: "2020-01-01" }),
        ]}
        programs={[]}
      />,
    );
    const row = screen.getByTestId("center-roster-row-gone2");
    expect(row.getAttribute("data-needs-close-out")).toBe("true");
    expect(screen.getByTestId("roster-needs-close-out")).toBeTruthy();
  });

  it("no nudge when every departure has been closed out", () => {
    render(
      <CenterRosterCard
        {...base}
        members={[
          member({}),
          member({ cwid: "shut", scholarState: "departed", endDate: "2024-01-01" }),
        ]}
        programs={[]}
      />,
    );
    expect(screen.queryByTestId("roster-needs-close-out")).toBeNull();
  });
});

describe("CenterRosterCard — a departed person with an open membership needs closing out", () => {
  // The combination the card exists to surface: scholarState "departed" while the
  // membership dates still read Active, because nobody set an End date.
  const openMembership = member({
    cwid: "open1",
    name: "Open One",
    scholarState: "departed",
  });
  const closedOut = member({
    cwid: "shut1",
    name: "Shut One",
    scholarState: "departed",
    endDate: "2024-01-01",
  });

  it("tints the row and colors the date-range trigger when the membership is still open", () => {
    render(<CenterRosterCard {...base} members={[openMembership]} programs={[]} />);
    const row = screen.getByTestId("center-roster-row-open1");
    expect(row.getAttribute("data-needs-close-out")).toBe("true");
    expect(row.className).toMatch(/apollo-amber/);
    expect(screen.getByTestId("roster-dates-trigger-open1").className).toMatch(/apollo-amber/);
    fireEvent.click(screen.getByTestId("roster-dates-trigger-open1"));
    expect(screen.getByTestId("roster-end-open1").className).toMatch(/apollo-amber/);
  });

  it("does NOT flag a departed member whose membership was already closed out", () => {
    render(<CenterRosterCard {...base} members={[closedOut]} programs={[]} />);
    const row = screen.getByTestId("center-roster-row-shut1");
    expect(row.getAttribute("data-needs-close-out")).toBeNull();
    expect(row.className).not.toMatch(/apollo-amber/);
    expect(screen.getByTestId("roster-dates-trigger-shut1").className).not.toMatch(/apollo-amber/);
  });

  it("does NOT flag a still-employed member with an open membership", () => {
    render(<CenterRosterCard {...base} members={[member({ cwid: "here1" })]} programs={[]} />);
    const row = screen.getByTestId("center-roster-row-here1");
    expect(row.getAttribute("data-needs-close-out")).toBeNull();
    expect(row.className).not.toMatch(/apollo-amber/);
  });
});

describe("CenterRosterCard — status tabs with counts", () => {
  const members = [
    member({ cwid: "act", name: "Active" }),
    member({ cwid: "inv", name: "Invitee", membershipRoleKey: "invited" }),
    member({ cwid: "ina", name: "Inactive", endDate: "2024-01-01" }),
    member({ cwid: "gone", name: "Gone", scholarState: "departed" }),
  ];

  it("labels each tab with its count and marks the selected one", () => {
    const { container } = render(<CenterRosterCard {...base} members={members} programs={[]} />);
    const tabs = within(container).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "All members (4)",
      "Invited (1)",
      "Inactive (1)",
      "Left WCM (1)",
    ]);
    expect(within(container).getByTestId("roster-filter-all").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(container).getByTestId("roster-filter-invited"));
    expect(within(container).getByTestId("roster-filter-invited").getAttribute("aria-selected")).toBe("true");
    expect(within(container).getByTestId("roster-filter-all").getAttribute("aria-selected")).toBe("false");
  });

  it("Invited derives from the role (#2779): the tab lists the invitee and its badge says Invited", () => {
    const { container } = render(<CenterRosterCard {...base} members={members} programs={[]} />);
    fireEvent.click(within(container).getByTestId("roster-filter-invited"));
    expect(within(container).getByTestId("center-roster-row-inv")).toBeTruthy();
    expect(within(container).queryByTestId("center-roster-row-act")).toBeNull();
    expect(within(container).getByTestId("roster-status-inv").textContent).toBe("Invited");
  });

  it("the Left WCM tab lists departed people", () => {
    const { container } = render(<CenterRosterCard {...base} members={members} programs={[]} />);
    fireEvent.click(within(container).getByTestId("roster-filter-departed"));
    expect(within(container).getByTestId("center-roster-row-gone")).toBeTruthy();
    expect(within(container).queryByTestId("center-roster-row-act")).toBeNull();
  });
});

describe("CenterRosterCard — left-WCM banner", () => {
  it("counts the open memberships and 'Review and set end dates' opens the Left WCM tab", () => {
    const { container } = render(
      <CenterRosterCard
        {...base}
        members={[
          member({ cwid: "g1", scholarState: "departed" }),
          member({ cwid: "g2", scholarState: "departed" }),
          member({ cwid: "g3", scholarState: "departed", endDate: "2024-01-01" }), // closed out
          member({ cwid: "here" }),
        ]}
        programs={[]}
      />,
    );
    const banner = within(container).getByTestId("roster-needs-close-out");
    expect(banner.textContent).toMatch(/^2 members have left WCM but their center membership is still open\./);
    fireEvent.click(within(banner).getByRole("button", { name: "Review and set end dates" }));
    expect(within(container).getByTestId("roster-filter-departed").getAttribute("aria-selected")).toBe("true");
    expect(within(container).queryByTestId("center-roster-row-here")).toBeNull();
    expect(within(container).queryByTestId("roster-needs-close-out")).toBeNull();
  });
});

describe("CenterRosterCard — Program filter", () => {
  const members = [
    member({ cwid: "ct1", name: "Therapeutics One", programCode: "CT" }),
    member({ cwid: "cb1", name: "Biology One", programCode: "CB" }),
    member({ cwid: "none", name: "No Program" }),
  ];

  it("narrows to the chosen program, and Clear all filters resets it", () => {
    const { container } = render(<CenterRosterCard {...base} members={members} programs={PROGRAMS} />);
    const select = within(container).getByTestId("roster-program-filter") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Any program", "Cancer Therapeutics", "Cancer Biology"]);
    fireEvent.change(select, { target: { value: "CT" } });
    expect(within(container).getByTestId("center-roster-row-ct1")).toBeTruthy();
    expect(within(container).queryByTestId("center-roster-row-cb1")).toBeNull();
    expect(within(container).queryByTestId("center-roster-row-none")).toBeNull();
    expect(within(container).getByTestId("roster-filter-result-line").textContent).toBe("1 of 3 members match");

    fireEvent.click(within(container).getByTestId("roster-filter-clear-all"));
    expect(select.value).toBe("");
    expect(within(container).getByTestId("center-roster-row-cb1")).toBeTruthy();
  });

  it("is absent on a center with no program taxonomy (CTSC), as are the disease controls", () => {
    const { container } = render(
      <CenterRosterCard
        {...base}
        members={[member({ cwid: "ext1", scholarState: "external", source: "ctsc-feed" })]}
        programs={[]}
      />,
    );
    expect(within(container).queryByTestId("roster-program-filter")).toBeNull();
    expect(within(container).queryByTestId("roster-disease-filter-trigger")).toBeNull();
    expect(within(container).queryByTestId("roster-needs-review-toggle")).toBeNull();
    expect(within(container).queryByText("Diseases")).toBeNull();
    // Remove stays offered; the server refuses it for a feed row (mapped below).
    expect(within(container).getByTestId("roster-remove-ext1")).toBeTruthy();
  });

  it("a CTSC feed row's refused remove shows the nightly-sync message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "feed_owned_membership" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { container } = render(
      <CenterRosterCard
        {...base}
        members={[member({ cwid: "ext1", scholarState: "external", source: "ctsc-feed" })]}
        programs={[]}
      />,
    );
    fireEvent.click(within(container).getByTestId("roster-remove-ext1"));
    fireEvent.click(screen.getByRole("button", { name: "Remove anyway" }));
    await waitFor(() => expect(within(container).getByText(/nightly CTSC feed/)).toBeTruthy());
    expect(within(container).getByTestId("center-roster-row-ext1")).toBeTruthy();
  });
});

describe("CenterRosterCard — paging", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    member({ cwid: `p${String(i).padStart(2, "0")}`, name: `Person ${i}` }),
  );

  it("shows 25, then the rest on 'Show 5 more'", () => {
    const { container } = render(<CenterRosterCard {...base} members={many} programs={[]} />);
    expect(within(container).getAllByTestId(/^center-roster-row-/)).toHaveLength(25);
    expect(within(container).getByTestId("roster-range-label").textContent).toBe("Showing 25 of 30 members");
    fireEvent.click(within(container).getByTestId("roster-show-more"));
    expect(within(container).getAllByTestId(/^center-roster-row-/)).toHaveLength(30);
    expect(within(container).queryByTestId("roster-show-more")).toBeNull();
  });

  it("a disease decision does not collapse the page back to 25", async () => {
    stubOk();
    const withDiseases = many.map((m) => ({ ...m, diseases: [diseaseRow({})] }));
    const { container } = render(<CenterRosterCard {...base} members={withDiseases} programs={[]} />);
    fireEvent.click(within(container).getByTestId("roster-show-more"));
    fireEvent.click(within(container).getByTestId("roster-disease-pending-p29"));
    fireEvent.click(within(sheet()).getByTestId("disease-confirm-p29-BREAST"));
    await waitFor(() => expect(within(sheet()).getByTestId("disease-decision-p29-BREAST")).toBeTruthy());
    expect(within(container).getAllByTestId(/^center-roster-row-/)).toHaveLength(30);
  });
});

describe("CenterRosterCard — scholar hover card on names", () => {
  it("wraps a WCM member's name, but not an external member's", () => {
    const { container } = render(
      <CenterRosterCard
        {...base}
        members={[member({ cwid: "wcm1", name: "Wcm Person" }), member({ cwid: "ab12", name: "Ext Person", scholarState: "external" })]}
        programs={[]}
      />,
    );
    // Radix HoverCard's trigger marks the wrapped element with data-state.
    expect(within(container).getByTestId("roster-name-wcm1").getAttribute("data-state")).toBe("closed");
    expect(within(container).queryByTestId("roster-name-ab12")).toBeNull();
  });
});

const confirmed = (code: string, rank: number) =>
  diseaseRow({
    diseaseCode: code,
    assignment: { ...diseaseRow({}).assignment!, rank },
    decision: {
      decision: "confirmed",
      decidedBy: "abc123",
      decidedAt: new Date("2026-01-01"),
      scoreAtDecision: 10,
      confidenceAtDecision: "medium",
    },
  });

const rejected = (code: string) =>
  diseaseRow({
    diseaseCode: code,
    decision: {
      decision: "rejected",
      decidedBy: "abc123",
      decidedAt: new Date("2026-01-01"),
      scoreAtDecision: 10,
      confidenceAtDecision: "medium",
    },
  });

const pendingHigh = (code: string, rank: number) =>
  diseaseRow({ diseaseCode: code, assignment: { ...diseaseRow({}).assignment!, rank, confidence: "high" } });

/** The open review sheet (Radix portals it out of the card's container). */
function sheet(): HTMLElement {
  return screen.getByTestId("disease-review-sheet");
}

describe("CenterRosterCard — disease chips", () => {
  it("shows at most 2 CONFIRMED chips, a +N more count, and an 'N to review' pill — pending rows are not chips", () => {
    const m = member({
      diseases: [confirmed("BREAST", 1), confirmed("LUNG", 2), confirmed("SKIN", 3), diseaseRow({ diseaseCode: "GYN" })],
    });
    const { container } = render(<CenterRosterCard {...base} members={[m]} programs={[]} />);
    expect(within(container).getByTestId("roster-disease-chip-m1-BREAST").textContent).toBe("Breast Cancer");
    expect(within(container).getByTestId("roster-disease-chip-m1-LUNG")).toBeTruthy();
    expect(within(container).queryByTestId("roster-disease-chip-m1-SKIN")).toBeNull();
    expect(within(container).queryByTestId("roster-disease-chip-m1-GYN")).toBeNull();
    expect(within(container).getByTestId("roster-disease-chip-more-m1").textContent).toBe("+1 more");
    expect(within(container).getByTestId("roster-disease-pending-m1").textContent).toBe("1 to review →");
    expect(within(container).queryByTestId("roster-disease-manage-m1")).toBeNull();
  });

  it("'+ Add a disease' for a member with none, 'Manage' when nothing is left to review; both open the sheet", () => {
    const { container } = render(
      <CenterRosterCard
        {...base}
        members={[
          member({ cwid: "has", name: "Has Rows", diseases: [confirmed("BREAST", 1), rejected("LUNG")] }),
          member({ cwid: "none", name: "No Rows" }),
        ]}
        programs={[]}
      />,
    );
    expect(within(container).queryByTestId("roster-disease-pending-has")).toBeNull();
    fireEvent.click(within(container).getByTestId("roster-disease-manage-has"));
    expect(within(sheet()).getByText("Has Rows")).toBeTruthy();
    fireEvent.click(within(sheet()).getByTestId("disease-review-close"));
    expect(screen.queryByTestId("disease-review-sheet")).toBeNull();

    fireEvent.click(within(container).getByTestId("roster-disease-add-none"));
    expect(within(sheet()).getByText("No Rows")).toBeTruthy();
    expect(within(sheet()).getByText(/no disease assignments for this member yet/i)).toBeTruthy();
  });

  it("a chip opens the sheet too", () => {
    const { container } = render(
      <CenterRosterCard {...base} members={[member({ diseases: [confirmed("BREAST", 1)] })]} programs={[]} />,
    );
    fireEvent.click(within(container).getByTestId("roster-disease-chip-m1-BREAST"));
    expect(within(sheet()).getByTestId("disease-card-m1-BREAST")).toBeTruthy();
  });
});

describe("CenterRosterCard — disease review sheet", () => {
  it("heads with the member, program and counts; Details expands the evidence", () => {
    const m = member({
      title: "Professor of Medicine",
      programCode: "CT",
      diseases: [diseaseRow({}), confirmed("LUNG", 2), rejected("SKIN")],
    });
    const { container } = render(<CenterRosterCard {...base} members={[m]} programs={PROGRAMS} />);
    fireEvent.click(within(container).getByTestId("roster-disease-pending-m1"));
    const s = within(sheet());
    expect(s.getByText("Member One")).toBeTruthy();
    expect(s.getByText("Professor of Medicine · CWID m1 · Cancer Therapeutics")).toBeTruthy();
    expect(s.getByTestId("disease-review-summary").textContent).toBe("1 to review · 1 confirmed · 1 rejected");
    const card = within(s.getByTestId("disease-card-m1-BREAST"));
    expect(card.getByText("#1")).toBeTruthy();
    expect(card.getByText("Primary")).toBeTruthy();
    expect(s.getByTestId("disease-details-toggle-m1-BREAST").textContent).toMatch(
      /5 pubs \(2 lead\) · 1 trial led · 3 recent Details$/,
    );
    expect(card.queryByText("Publications")).toBeNull();
    fireEvent.click(s.getByTestId("disease-details-toggle-m1-BREAST"));
    expect(card.getByText("Publications")).toBeTruthy();
    expect(card.getByText("5 authored")).toBeTruthy();
    expect(card.getByText(/2 lead · 1 second · 2 middle\. 3 recent \(2018–2025\)\./)).toBeTruthy();
  });

  it("Confirm POSTs decision:confirmed to the existing route and flips the row", async () => {
    const fetchMock = stubOk();
    const { container } = render(
      <CenterRosterCard {...base} members={[member({ diseases: [diseaseRow({})] })]} programs={[]} />,
    );
    fireEvent.click(within(container).getByTestId("roster-disease-pending-m1"));
    fireEvent.click(within(sheet()).getByTestId("disease-confirm-m1-BREAST"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/center/meyer_cancer_center/disease-assignments");
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ cwid: "m1", diseaseCode: "BREAST", decision: "confirmed" });
    await waitFor(() =>
      expect(within(sheet()).getByTestId("disease-decision-m1-BREAST").textContent).toBe("Confirmed"),
    );
    expect(within(sheet()).getByTestId("disease-review-summary").textContent).toBe("0 to review · 1 confirmed");
    // The roster row now shows it as a confirmed chip and no pending pill.
    expect(within(container).getByTestId("roster-disease-chip-m1-BREAST")).toBeTruthy();
    expect(within(container).queryByTestId("roster-disease-pending-m1")).toBeNull();
  });

  it("Reject POSTs decision:rejected", async () => {
    const fetchMock = stubOk();
    const { container } = render(
      <CenterRosterCard {...base} members={[member({ diseases: [diseaseRow({})] })]} programs={[]} />,
    );
    fireEvent.click(within(container).getByTestId("roster-disease-pending-m1"));
    fireEvent.click(within(sheet()).getByTestId("disease-reject-m1-BREAST"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ decision: "rejected" });
    await waitFor(() =>
      expect(within(sheet()).getByTestId("disease-card-m1-BREAST").getAttribute("data-decision")).toBe("rejected"),
    );
  });

  it("Undo on a confirmed row POSTs clear and brings back Confirm / Reject", async () => {
    const fetchMock = stubOk();
    const { container } = render(
      <CenterRosterCard {...base} members={[member({ diseases: [confirmed("BREAST", 1)] })]} programs={[]} />,
    );
    fireEvent.click(within(container).getByTestId("roster-disease-manage-m1"));
    fireEvent.click(within(sheet()).getByTestId("disease-undo-m1-BREAST"));
    await waitFor(() => expect(within(sheet()).getByTestId("disease-confirm-m1-BREAST")).toBeTruthy());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ decision: "clear" });
  });

  it("'Confirm N high-confidence' confirms only the undecided high rows, one POST each", async () => {
    const fetchMock = stubOk();
    const m = member({
      diseases: [pendingHigh("BREAST", 1), pendingHigh("LUNG", 2), diseaseRow({ diseaseCode: "GYN" }), confirmed("SKIN", 4)],
    });
    const { container } = render(<CenterRosterCard {...base} members={[m]} programs={[]} />);
    fireEvent.click(within(container).getByTestId("roster-disease-pending-m1"));
    const button = within(sheet()).getByTestId("disease-confirm-high");
    expect(button.textContent).toBe("Confirm 2 high-confidence");
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((c) => bodyOf(c))).toEqual(
      expect.arrayContaining([
        { cwid: "m1", diseaseCode: "BREAST", decision: "confirmed" },
        { cwid: "m1", diseaseCode: "LUNG", decision: "confirmed" },
      ]),
    );
    await waitFor(() => expect(within(sheet()).queryByTestId("disease-confirm-high")).toBeNull());
    expect(within(sheet()).getByTestId("disease-confirm-m1-GYN")).toBeTruthy();
  });

  it("a failed decision reverts the row and shows an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "assignment_not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { container } = render(
      <CenterRosterCard {...base} members={[member({ diseases: [diseaseRow({})] })]} programs={[]} />,
    );
    fireEvent.click(within(container).getByTestId("roster-disease-pending-m1"));
    fireEvent.click(within(sheet()).getByTestId("disease-confirm-m1-BREAST"));
    await waitFor(() => expect(within(container).getByText(/no longer in the current assignment list/)).toBeTruthy());
    expect(within(sheet()).getByTestId("disease-confirm-m1-BREAST")).toBeTruthy();
  });
});

describe("CenterRosterCard — manual add (\"+ Add a disease\")", () => {
  it("offers only codes not already on the member, and POSTs confirmed with no prior assignment", async () => {
    const fetchMock = stubOk();
    const { container } = render(
      <CenterRosterCard
        {...base}
        members={[member({ diseases: [diseaseRow({})] })]}
        programs={[]}
        diseaseOptions={DISEASE_OPTIONS}
      />,
    );
    fireEvent.click(within(container).getByTestId("roster-disease-pending-m1"));
    fireEvent.click(within(sheet()).getByTestId("disease-add-trigger-m1"));
    const menu = within(screen.getByTestId("disease-add-menu-m1"));
    // BREAST is already on the member — only the other option should be offered.
    expect(menu.queryByTestId("disease-add-option-m1-BREAST")).toBeNull();
    fireEvent.click(menu.getByTestId("disease-add-option-m1-GI_COLORECTAL"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ cwid: "m1", diseaseCode: "GI_COLORECTAL", decision: "confirmed" });
    expect(within(sheet()).getByTestId("disease-card-m1-GI_COLORECTAL").textContent).toMatch(/manually added/i);
  });

  it("Undo on a manually-added disease removes the row entirely (nothing left to show)", async () => {
    stubOk();
    const manuallyAdded = diseaseRow({
      diseaseCode: "GI_COLORECTAL",
      assignment: null,
      decision: {
        decision: "confirmed",
        decidedBy: "abc123",
        decidedAt: new Date("2026-01-01"),
        scoreAtDecision: null,
        confidenceAtDecision: null,
      },
    });
    const { container } = render(
      <CenterRosterCard {...base} members={[member({ diseases: [manuallyAdded] })]} programs={[]} />,
    );
    fireEvent.click(within(container).getByTestId("roster-disease-chip-m1-GI_COLORECTAL"));
    fireEvent.click(within(sheet()).getByTestId("disease-undo-m1-GI_COLORECTAL"));
    await waitFor(() => expect(within(sheet()).queryByTestId("disease-card-m1-GI_COLORECTAL")).toBeNull());
  });
});

describe("CenterRosterCard — 'Has diseases to review' and the review queue", () => {
  const members = [
    member({ cwid: "a", name: "Alpha", diseases: [diseaseRow({}), diseaseRow({ diseaseCode: "LUNG" })] }),
    member({ cwid: "b", name: "Bravo", diseases: [confirmed("BREAST", 1)] }),
    member({ cwid: "c", name: "Charlie", diseases: [diseaseRow({})] }),
    member({ cwid: "d", name: "Delta", diseases: [diseaseRow({})] }),
  ];

  it("counts MEMBERS with something to review, and the toggle narrows to them", () => {
    const { container } = render(<CenterRosterCard {...base} members={members} programs={[]} />);
    expect(within(container).getByTestId("roster-needs-review-count").textContent).toBe("3");
    fireEvent.click(within(container).getByTestId("roster-needs-review-toggle"));
    expect(within(container).queryByTestId("center-roster-row-b")).toBeNull();
    expect(within(container).getAllByTestId(/^center-roster-row-/)).toHaveLength(3);
  });

  it("the count follows the other filters", () => {
    const { container } = render(<CenterRosterCard {...base} members={members} programs={[]} />);
    fireEvent.change(within(container).getByTestId("roster-search-input"), { target: { value: "alpha" } });
    expect(within(container).getByTestId("roster-needs-review-count").textContent).toBe("1");
    expect(within(container).getByTestId("roster-start-review-queue").textContent).toBe("Start review queue (1)");
  });

  it("walks the queue with 'Next', skipping anyone already finished, and Close ends it", async () => {
    const fetchMock = stubOk();
    const { container } = render(<CenterRosterCard {...base} members={members} programs={[]} />);
    fireEvent.click(within(container).getByTestId("roster-start-review-queue"));
    expect(within(sheet()).getByTestId("disease-review-queue-position").textContent).toBe("Review queue · 1 of 3");
    expect(within(sheet()).getByText("Alpha")).toBeTruthy();
    expect(within(sheet()).getByTestId("disease-review-next").textContent).toBe("Next: Charlie →");
    fireEvent.click(within(sheet()).getByTestId("disease-review-next"));
    expect(within(sheet()).getByText("Charlie")).toBeTruthy();
    expect(within(sheet()).getByTestId("disease-review-queue-position").textContent).toBe("Review queue · 2 of 3");

    fireEvent.click(within(sheet()).getByTestId("disease-confirm-c-BREAST"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(within(sheet()).getByTestId("disease-review-next").textContent).toBe("Next: Delta →");
    fireEvent.click(within(sheet()).getByTestId("disease-review-next"));
    expect(within(sheet()).getByTestId("disease-review-queue-position").textContent).toBe("Review queue · 3 of 3");
    expect(within(sheet()).queryByTestId("disease-review-next")).toBeNull();

    fireEvent.click(within(sheet()).getByTestId("disease-review-close"));
    expect(screen.queryByTestId("disease-review-sheet")).toBeNull();
    // Opening a single member afterwards is not a queue.
    fireEvent.click(within(container).getByTestId("roster-disease-pending-a"));
    expect(within(sheet()).queryByTestId("disease-review-queue-position")).toBeNull();
  });

  it("the queue holds only members who still have something to review", async () => {
    stubOk();
    const { container } = render(<CenterRosterCard {...base} members={members} programs={[]} />);
    // Finish Charlie outside the queue first.
    fireEvent.click(within(container).getByTestId("roster-disease-pending-c"));
    fireEvent.click(within(sheet()).getByTestId("disease-confirm-c-BREAST"));
    await waitFor(() => expect(within(sheet()).getByTestId("disease-decision-c-BREAST")).toBeTruthy());
    fireEvent.click(within(sheet()).getByTestId("disease-review-close"));
    // Charlie has nothing left, so the queue is Alpha then Delta.
    fireEvent.click(within(container).getByTestId("roster-start-review-queue"));
    expect(within(sheet()).getByTestId("disease-review-queue-position").textContent).toBe("Review queue · 1 of 2");
    expect(within(sheet()).getByTestId("disease-review-next").textContent).toBe("Next: Delta →");
  });
});
