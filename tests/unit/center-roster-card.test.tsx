/**
 * `components/edit/center-roster-card.tsx` — the rich #552 §6.1 roster table.
 * Covers the program-gated columns, derived status, the segmented filter,
 * inline set PATCHes, the folded date-range popover, add/remove, and (the
 * 2026-08-12 mockup-fidelity pass) the disease chips/expand/confirm/reject/
 * undo/manual-add flow.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
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

describe("CenterRosterCard — Export CSV affordance (#1102)", () => {
  it("hides the export link when exportEnabled is false (flag off / default)", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    expect(screen.queryByTestId("center-roster-export-link")).toBeNull();
  });

  it("exports the WHOLE roster — no activeOnly param, in any filter", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} exportEnabled />);
    const link = screen.getByTestId("center-roster-export-link") as HTMLAnchorElement;
    expect(link.textContent).toMatch(/export csv/i);
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
      /1 member has left WCM with their membership still open/i,
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

describe("CenterRosterCard — disease chips + expanded panel", () => {
  it("renders a confidence-tinted chip and expands the panel on click", () => {
    const withDisease = member({ diseases: [diseaseRow({})] });
    render(<CenterRosterCard {...base} members={[withDisease]} programs={[]} />);
    expect(screen.getByTestId("roster-disease-chip-m1-BREAST").textContent).toMatch(/breast cancer/i);
    expect(screen.queryByTestId("disease-expand-m1")).toBeNull();

    fireEvent.click(screen.getByTestId("roster-disease-chip-m1-BREAST"));
    expect(screen.getByTestId("disease-expand-m1")).toBeTruthy();
    expect(screen.getByTestId("disease-card-m1-BREAST").textContent).toMatch(/rank 1/i);

    fireEvent.click(screen.getByTestId("disease-expand-collapse-m1"));
    expect(screen.queryByTestId("disease-expand-m1")).toBeNull();
  });

  it("shows an amber pending pill for an undecided assignment", () => {
    const withDisease = member({ diseases: [diseaseRow({})] });
    render(<CenterRosterCard {...base} members={[withDisease]} programs={[]} />);
    expect(screen.getByTestId("roster-disease-pending-m1").textContent).toMatch(/1 to review/i);
  });

  it("Confirm POSTs decision:confirmed and flips the card to the Confirmed state", async () => {
    const fetchMock = stubOk();
    const withDisease = member({ diseases: [diseaseRow({})] });
    render(<CenterRosterCard {...base} members={[withDisease]} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-disease-chip-m1-BREAST"));
    fireEvent.click(screen.getByTestId("disease-confirm-m1-BREAST"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/center/meyer_cancer_center/disease-assignments");
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      cwid: "m1",
      diseaseCode: "BREAST",
      decision: "confirmed",
    });
    expect(screen.getByText(/^✓ Confirmed$/)).toBeTruthy();
  });

  it("Undo on a confirmed row clears it back to Confirm/Reject", async () => {
    stubOk();
    const withDisease = member({
      diseases: [
        diseaseRow({
          decision: {
            decision: "confirmed",
            decidedBy: "abc123",
            decidedAt: new Date("2026-01-01"),
            scoreAtDecision: 10,
            confidenceAtDecision: "medium",
          },
        }),
      ],
    });
    render(<CenterRosterCard {...base} members={[withDisease]} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-disease-chip-m1-BREAST"));
    expect(screen.getByText(/^✓ Confirmed$/)).toBeTruthy();
    fireEvent.click(screen.getByText("Undo"));
    await waitFor(() => expect(screen.getByTestId("disease-confirm-m1-BREAST")).toBeTruthy());
  });

  it("Reject POSTs decision:rejected and de-emphasizes the card", async () => {
    const fetchMock = stubOk();
    const withDisease = member({ diseases: [diseaseRow({})] });
    render(<CenterRosterCard {...base} members={[withDisease]} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-disease-chip-m1-BREAST"));
    fireEvent.click(screen.getByTestId("disease-reject-m1-BREAST"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ decision: "rejected" });
    await waitFor(() =>
      expect(screen.getByTestId("disease-card-m1-BREAST").className).toMatch(/opacity-50/),
    );
  });
});

describe("CenterRosterCard — manual add (\"+ Add a disease\")", () => {
  it("offers only codes not already on the member, and POSTs confirmed with no prior assignment", async () => {
    const fetchMock = stubOk();
    const withDisease = member({ diseases: [diseaseRow({})] }); // already has BREAST
    render(
      <CenterRosterCard
        {...base}
        members={[withDisease]}
        programs={[]}
        diseaseOptions={DISEASE_OPTIONS}
      />,
    );
    fireEvent.click(screen.getByTestId("roster-disease-chip-m1-BREAST"));
    fireEvent.click(screen.getByTestId("disease-add-trigger-m1"));
    // BREAST is already on the member — only the other option should be offered.
    expect(screen.queryByTestId("disease-add-option-m1-BREAST")).toBeNull();
    fireEvent.click(screen.getByTestId("disease-add-option-m1-GI_COLORECTAL"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      cwid: "m1",
      diseaseCode: "GI_COLORECTAL",
      decision: "confirmed",
    });
    expect(screen.getByTestId("disease-card-m1-GI_COLORECTAL").textContent).toMatch(/manually added/i);
  });

  it("Undo on a manually-added disease removes the card entirely (nothing left to show)", async () => {
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
    const withManualAdd = member({ diseases: [manuallyAdded] });
    render(<CenterRosterCard {...base} members={[withManualAdd]} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-disease-chip-m1-GI_COLORECTAL"));
    expect(screen.getByTestId("disease-card-m1-GI_COLORECTAL")).toBeTruthy();
    fireEvent.click(screen.getByText("Undo"));
    await waitFor(() => expect(screen.queryByTestId("disease-card-m1-GI_COLORECTAL")).toBeNull());
  });
});
