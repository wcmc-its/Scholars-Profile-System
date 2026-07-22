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
    // Active-only is the default toggle state → ?activeOnly=1.
    expect(link.getAttribute("href")).toBe(
      "/edit/center/meyer_cancer_center/export?activeOnly=1",
    );
  });

  it("drops ?activeOnly=1 once the show-active-only toggle is turned off", () => {
    render(<CenterRosterCard {...base} members={[member({})]} programs={[]} exportEnabled />);
    fireEvent.click(screen.getByTestId("roster-show-active-only"));
    expect(
      screen.getByTestId("center-roster-export-link").getAttribute("href"),
    ).toBe("/edit/center/meyer_cancer_center/export");
  });
});

describe("CenterRosterCard — status + show-active-only", () => {
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

    fireEvent.click(screen.getByTestId("roster-show-active-only"));
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
    const confirmButtons = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.queryByTestId("center-roster-row-m1")).toBeNull());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ cwid: "m1", action: "remove" });
  });
});
