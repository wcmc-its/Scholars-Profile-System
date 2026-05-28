/**
 * `components/edit/unit-leader-card.tsx` — the three-state leader override
 * (curated / explicit vacancy / detect), the interim toggle, the combined-write
 * sequence, and Clear (#540 Phase 7 § 2). The directory typeahead is mocked to
 * a deterministic stub so the test drives selection directly.
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
      <div>
        <span data-testid="picked">{value.name}</span>
        <button type="button" data-testid="typeahead-clear" onClick={() => onChange(null)}>
          clear
        </button>
      </div>
    ) : (
      <button
        type="button"
        data-testid="typeahead-pick"
        onClick={() => onChange({ cwid: "pick9", name: "Picked Person", title: "MD" })}
      >
        pick
      </button>
    ),
}));

import { UnitLeaderCard } from "@/components/edit/unit-leader-card";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubOk() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

const detect = { cwid: null, explicitVacancy: false, interim: false, name: null, title: null };
const base = { entityType: "department" as const, entityId: "N1280", canClear: true, hasOverride: false };

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe("UnitLeaderCard", () => {
  it("the interim label tracks the unit type", () => {
    const { rerender } = render(<UnitLeaderCard {...base} leader={detect} />);
    expect(screen.getByText("Interim chair")).toBeTruthy();
    rerender(<UnitLeaderCard {...base} entityType="division" leader={detect} />);
    expect(screen.getByText("Interim chief")).toBeTruthy();
    rerender(<UnitLeaderCard {...base} entityType="center" canClear={false} leader={detect} />);
    expect(screen.getByText("Interim director")).toBeTruthy();
  });

  it("starts pristine in detect mode (Save disabled, shows the detection hint)", () => {
    render(<UnitLeaderCard {...base} leader={detect} />);
    expect(screen.getByTestId("unit-leader-save").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/using directory detection/i)).toBeTruthy();
  });

  it("picking a person Saves leaderCwid:set with the cwid", async () => {
    const fetchMock = stubOk();
    render(<UnitLeaderCard {...base} leader={detect} />);
    fireEvent.click(screen.getByTestId("typeahead-pick"));
    fireEvent.click(screen.getByTestId("unit-leader-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      op: "set",
      fieldName: "leaderCwid",
      value: "pick9",
    });
  });

  it("Mark vacant shows the pill and Saves leaderCwid:set with an empty string", async () => {
    const fetchMock = stubOk();
    render(<UnitLeaderCard {...base} leader={detect} />);
    fireEvent.click(screen.getByTestId("unit-leader-mark-vacant"));
    expect(screen.getByTestId("unit-leader-vacant-pill")).toBeTruthy();
    fireEvent.click(screen.getByTestId("unit-leader-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ op: "set", fieldName: "leaderCwid", value: "" });
  });

  it("toggling interim on a curated leader writes both fields in sequence", async () => {
    const fetchMock = stubOk();
    render(
      <UnitLeaderCard
        {...base}
        hasOverride
        leader={{ cwid: "chr1", explicitVacancy: false, interim: false, name: "Chair One", title: "MD" }}
      />,
    );
    // Already curated; flip interim only → one POST (leaderInterim).
    fireEvent.click(screen.getByTestId("unit-leader-interim"));
    fireEvent.click(screen.getByTestId("unit-leader-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      op: "set",
      fieldName: "leaderInterim",
      value: "true",
    });
  });

  it("Clear override POSTs op:clear for both leader fields", async () => {
    const fetchMock = stubOk();
    render(
      <UnitLeaderCard
        {...base}
        hasOverride
        leader={{ cwid: "chr1", explicitVacancy: false, interim: true, name: "Chair One", title: "MD" }}
      />,
    );
    fireEvent.click(screen.getByTestId("unit-leader-clear"));
    const confirmButtons = screen.getAllByRole("button", { name: "Clear override" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const fields = fetchMock.mock.calls.map((c) => bodyOf(c).fieldName);
    expect(fields).toContain("leaderCwid");
    expect(fields).toContain("leaderInterim");
    expect(fetchMock.mock.calls.every((c) => bodyOf(c).op === "clear")).toBe(true);
  });
});

describe("UnitLeaderCard — center arm", () => {
  const centerBase = {
    entityType: "center" as const,
    entityId: "man-x",
    canClear: false,
    hasOverride: false,
  };

  it("a center with no director starts vacant (no detect hint, no Clear button)", () => {
    render(<UnitLeaderCard {...centerBase} leader={detect} />);
    expect(screen.queryByText(/using directory detection/i)).toBeNull();
    expect(screen.getByTestId("unit-leader-vacant-pill").textContent).toMatch(/no director set/i);
    expect(screen.queryByTestId("unit-leader-clear")).toBeNull();
  });

  it("picking a director Saves directorCwid via /api/edit/unit op:update", async () => {
    const fetchMock = stubOk();
    render(<UnitLeaderCard {...centerBase} leader={detect} />);
    fireEvent.click(screen.getByTestId("typeahead-pick"));
    fireEvent.click(screen.getByTestId("unit-leader-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/unit");
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      op: "update",
      entityType: "center",
      fieldName: "directorCwid",
      value: "pick9",
    });
  });

  it("clearing a curated director Saves directorCwid:'' (vacant) via /api/edit/unit", async () => {
    const fetchMock = stubOk();
    render(
      <UnitLeaderCard
        {...centerBase}
        leader={{ cwid: "dir1", explicitVacancy: false, interim: false, name: "Dir One", title: "MD" }}
      />,
    );
    fireEvent.click(screen.getByTestId("typeahead-clear"));
    fireEvent.click(screen.getByTestId("unit-leader-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      op: "update",
      fieldName: "directorCwid",
      value: "",
    });
  });
});
