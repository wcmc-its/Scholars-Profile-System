/**
 * `components/edit/unit-access-card.tsx` — table render, self-revoke guard,
 * cascade hint, grant + revoke flows (#540 Phase 7 § 4). The directory
 * typeahead is mocked so the "Add admin" picker is deterministic.
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
      <span data-testid="grant-picked">{value.name}</span>
    ) : (
      <button
        type="button"
        data-testid="grant-pick"
        onClick={() => onChange({ cwid: "new9", name: "New Admin", title: null })}
      >
        pick
      </button>
    ),
}));

import { UnitAccessCard } from "@/components/edit/unit-access-card";

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

const ACTOR = "own001";
const rows = [
  { cwid: "own001", name: "Olivia Owner", title: "MD", role: "owner" as const, grantedBy: null, grantedAt: new Date("2026-05-01") },
  { cwid: "cur001", name: "Casey Curator", title: null, role: "curator" as const, grantedBy: "own001", grantedAt: new Date("2026-05-02") },
];
const base = { entityType: "department" as const, entityId: "N1280", actorCwid: ACTOR };

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe("UnitAccessCard", () => {
  it("renders a row per admin and the department cascade hint", () => {
    render(<UnitAccessCard {...base} access={rows} />);
    expect(screen.getByTestId("unit-access-row-own001")).toBeTruthy();
    expect(screen.getByTestId("unit-access-row-cur001")).toBeTruthy();
    expect(screen.getByText(/covers this department and its divisions/i)).toBeTruthy();
  });

  it("disables Remove on the acting user's own row (self-revoke guard)", () => {
    render(<UnitAccessCard {...base} access={rows} />);
    expect(screen.getByTestId("unit-access-remove-own001").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("unit-access-remove-cur001").hasAttribute("disabled")).toBe(false);
  });

  it("a center shows no cascade hint", () => {
    render(<UnitAccessCard {...base} entityType="center" entityId="man-x" access={[]} />);
    expect(screen.queryByText(/covers/i)).toBeNull();
  });

  it("grant POSTs action:grant with the picked cwid + default curator role", async () => {
    const fetchMock = stubOk();
    render(<UnitAccessCard {...base} access={[]} />);
    fireEvent.click(screen.getByTestId("grant-pick"));
    fireEvent.click(screen.getByTestId("unit-access-grant"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      entityType: "department",
      entityId: "N1280",
      cwid: "new9",
      role: "curator",
      action: "grant",
    });
  });

  it("revoke confirms then POSTs action:revoke and drops the row", async () => {
    const fetchMock = stubOk();
    render(<UnitAccessCard {...base} access={rows} />);
    fireEvent.click(screen.getByTestId("unit-access-remove-cur001"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ cwid: "cur001", action: "revoke" });
    await waitFor(() => expect(screen.queryByTestId("unit-access-row-cur001")).toBeNull());
  });

  it("returns null when access is null (defensive — rail shouldn't mount it)", () => {
    const { container } = render(<UnitAccessCard {...base} access={null} />);
    expect(container.querySelector('[data-slot="unit-access-card"]')).toBeNull();
  });
});
