/**
 * `components/edit/center-roster-card.tsx` — the rich #552 §6.1 roster table.
 * Covers the program-gated columns, derived status, the show-active-only
 * toggle, inline set PATCHes, the date-range block, and add/remove.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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

describe("CenterRosterCard — columns", () => {
  it("shows Type + Program columns when the center has a program taxonomy", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={PROGRAMS} />);
    expect(screen.getByTestId("roster-type-m1")).toBeTruthy();
    expect(screen.getByTestId("roster-program-m1")).toBeTruthy();
  });

  it("hides Type + Program for a center with no programs (the Cancer-Center-only gate)", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    expect(screen.queryByTestId("roster-type-m1")).toBeNull();
    expect(screen.queryByTestId("roster-program-m1")).toBeNull();
    // dates + status still present
    expect(screen.getByTestId("roster-start-m1")).toBeTruthy();
    expect(screen.getByTestId("roster-status-m1")).toBeTruthy();
  });

  it("empty roster shows the empty state", () => {
    render(<CenterRosterCard {...base} members={[]} programs={PROGRAMS} />);
    expect(screen.getByTestId("center-roster-empty")).toBeTruthy();
  });
});

describe("CenterRosterCard — Export CSV affordance (#1102)", () => {
  it("hides the export link when exportEnabled is false (flag off / default)", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    expect(screen.queryByTestId("center-roster-export-link")).toBeNull();
  });

  it("renders an Export CSV link to the per-center export route when enabled", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} exportEnabled />);
    const link = screen.getByTestId("center-roster-export-link") as HTMLAnchorElement;
    expect(link.textContent).toMatch(/export csv/i);
    // Inactive are hidden by default → the export stays active-only.
    expect(link.getAttribute("href")).toBe(
      "/edit/center/meyer_cancer_center/export?activeOnly=1",
    );
  });

  it("drops ?activeOnly=1 once \"show inactive members\" is turned on", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} exportEnabled />);
    fireEvent.click(screen.getByTestId("roster-show-inactive"));
    expect(
      screen.getByTestId("center-roster-export-link").getAttribute("href"),
    ).toBe("/edit/center/meyer_cancer_center/export");
  });
});

describe("CenterRosterCard — status + show-inactive", () => {
  const members = [
    member({ cwid: "act", name: "Active" }), // null dates → active
    member({ cwid: "pen", name: "Pending", startDate: "2027-01-01" }),
    member({ cwid: "ina", name: "Inactive", endDate: "2024-01-01" }),
  ];

  it("hides pending + inactive by default; toggling reveals them with status badges", () => {
    render(<CenterRosterCard {...base} members={members} programs={[]} />);
    expect(screen.getByTestId("center-roster-row-act")).toBeTruthy();
    expect(screen.queryByTestId("center-roster-row-pen")).toBeNull();
    expect(screen.queryByTestId("center-roster-row-ina")).toBeNull();

    fireEvent.click(screen.getByTestId("roster-show-inactive"));
    expect(screen.getByTestId("center-roster-row-pen")).toBeTruthy();
    expect(screen.getByTestId("roster-status-pen").textContent).toMatch(/pending/i);
    expect(screen.getByTestId("roster-status-ina").textContent).toMatch(/inactive/i);
    expect(screen.getByTestId("roster-status-act").textContent).toMatch(/active/i);
  });
});

describe("CenterRosterCard — inline edits", () => {
  it("changing Type POSTs set with membershipType", async () => {
    const fetchMock = stubOk();
    render(<CenterRosterCard {...base} members={[member({})]} programs={PROGRAMS} />);
    fireEvent.change(screen.getByTestId("roster-type-m1"), { target: { value: "research" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      unitType: "center",
      unitCode: "meyer_cancer_center",
      cwid: "m1",
      action: "set",
      membershipType: "research",
    });
  });

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
    fireEvent.change(screen.getByTestId("roster-start-m1"), { target: { value: "2024-07-01" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ action: "set", startDate: "2024-07-01" });
  });

  it("blocks an end date before the start date (no POST, shows an error)", async () => {
    const fetchMock = stubOk();
    render(
      <CenterRosterCard {...base} members={[member({ startDate: "2025-01-01" })]} programs={[]} />,
    );
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
  it("hides departed members by default and says how many are hidden", () => {
    render(
      <CenterRosterCard
        {...base}
        members={[member({}), member({ cwid: "gone1", name: "Gone One", scholarState: "departed" })]}
        programs={[]}
      />,
    );
    expect(screen.queryByTestId("center-roster-row-gone1")).toBeNull();
    expect(screen.getByTestId("roster-departed-hidden").textContent).toMatch(
      /1 member has left WCM and is hidden/i,
    );
  });

  it("the Show departed toggle reveals them with a Left WCM badge", () => {
    render(
      <CenterRosterCard
        {...base}
        members={[member({ cwid: "gone1", name: "Gone One", scholarState: "departed" })]}
        programs={[]}
      />,
    );
    fireEvent.click(screen.getByTestId("roster-show-departed"));
    expect(screen.getByTestId("center-roster-row-gone1")).toBeTruthy();
    expect(screen.getByTestId("roster-scholar-state-gone1").textContent).toBe("Left WCM");
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
    expect(screen.queryByTestId("roster-departed-hidden")).toBeNull();
  });

  it("a departed member with a CURRENT membership is still hidden by default — the two axes are independent", () => {
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
    expect(screen.queryByTestId("center-roster-row-gone2")).toBeNull();
    expect(screen.getByTestId("roster-departed-hidden")).toBeTruthy();
  });

  it("no hint when nothing is hidden", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} />);
    expect(screen.queryByTestId("roster-departed-hidden")).toBeNull();
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

  it("tints the row and outlines the End field when the membership is still open", () => {
    render(<CenterRosterCard {...base} members={[openMembership]} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-show-departed"));

    const row = screen.getByTestId("center-roster-row-open1");
    expect(row.getAttribute("data-needs-close-out")).toBe("true");
    expect(row.className).toMatch(/bg-amber/);
    expect(screen.getByTestId("roster-end-open1").className).toMatch(/border-amber/);
  });

  it("does NOT flag a departed member whose membership was already closed out", () => {
    render(<CenterRosterCard {...base} members={[closedOut]} programs={[]} />);
    fireEvent.click(screen.getByTestId("roster-show-inactive"));
    fireEvent.click(screen.getByTestId("roster-show-departed"));

    const row = screen.getByTestId("center-roster-row-shut1");
    expect(row.getAttribute("data-needs-close-out")).toBeNull();
    expect(row.className).not.toMatch(/bg-amber/);
    expect(screen.getByTestId("roster-end-shut1").className).not.toMatch(/border-amber/);
  });

  it("does NOT flag a still-employed member with an open membership", () => {
    render(<CenterRosterCard {...base} members={[member({ cwid: "here1" })]} programs={[]} />);
    const row = screen.getByTestId("center-roster-row-here1");
    expect(row.getAttribute("data-needs-close-out")).toBeNull();
    expect(row.className).not.toMatch(/bg-amber/);
  });
});
