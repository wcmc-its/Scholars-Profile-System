/**
 * `components/edit/org-unit-role-roster.tsx` — the Role Vocabulary redesign's
 * in-place rename (inline blast radius, Save / Enter / Escape, status bar),
 * ▲ / ▼ reordering (`moveWrites`), and the Add role dialog opening on the
 * current unit-kind tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { moveWrites, OrgUnitRoleRoster } from "@/components/edit/org-unit-role-roster";
import type { OrgUnitRoleRosterRow } from "@/lib/api/org-unit-roles-admin";

const row = (over: Partial<OrgUnitRoleRosterRow>): OrgUnitRoleRosterRow => ({
  key: "director",
  entityType: "center",
  label: "Director",
  roleGroup: "leadership",
  scope: "unit",
  singleHolder: true,
  sortOrder: 10,
  profileTitle: true,
  source: "seed",
  holderCount: 0,
  unitCount: 0,
  scopeRowCount: 0,
  ...over,
});

let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
  vi.restoreAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
});
afterEach(cleanup);

const patches = () =>
  fetchSpy.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
  );

describe("OrgUnitRoleRoster — rename in place", () => {
  it("states the blast radius while editing, PATCHes on Save, and confirms", async () => {
    render(<OrgUnitRoleRoster roles={[row({ holderCount: 4, unitCount: 4 })]} />);
    fireEvent.click(screen.getByTestId("roles-label-view-center:director"));
    expect(screen.getByTestId("roles-rename-impact-center:director").textContent).toBe(
      "This changes the label shown for 4 centers.",
    );
    fireEvent.change(screen.getByTestId("roles-label-center:director"), {
      target: { value: " Lead Director " },
    });
    fireEvent.click(screen.getByTestId("roles-label-save-center:director"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(patches()).toEqual([{ entityType: "center", key: "director", label: "Lead Director" }]);
    await waitFor(() =>
      expect(screen.getByTestId("roles-toast").textContent).toContain(
        "Renamed to “Lead Director”. 4 holders now show this label.",
      ),
    );
    expect(screen.getByTestId("roles-label-view-center:director").textContent).toBe(
      "Lead Director",
    );
  });

  it("Escape cancels and an unchanged Enter sends nothing", () => {
    render(<OrgUnitRoleRoster roles={[row({})]} />);
    fireEvent.click(screen.getByTestId("roles-label-view-center:director"));
    fireEvent.keyDown(screen.getByTestId("roles-label-center:director"), { key: "Escape" });
    expect(screen.queryByTestId("roles-label-center:director")).toBeNull();
    fireEvent.click(screen.getByTestId("roles-label-view-center:director"));
    fireEvent.keyDown(screen.getByTestId("roles-label-center:director"), { key: "Enter" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("OrgUnitRoleRoster — reorder", () => {
  it("▼ swaps the two rows' sort orders", async () => {
    render(
      <OrgUnitRoleRoster
        roles={[
          row({}),
          row({ key: "co_director", label: "Co-Director", sortOrder: 20, singleHolder: false }),
        ]}
      />,
    );
    expect(screen.getByTestId("roles-move-up-center:director").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("roles-move-down-center:director"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(patches()).toEqual([
      { entityType: "center", key: "director", sortOrder: 20 },
      { entityType: "center", key: "co_director", sortOrder: 10 },
    ]);
    await waitFor(() =>
      expect(
        screen.getAllByTestId(/^roles-row-/).map((el) => el.getAttribute("data-testid")),
      ).toEqual(["roles-row-center:co_director", "roles-row-center:director"]),
    );
  });
});

describe("moveWrites", () => {
  it("renumbers the group when sort orders tie, writing only rows that change", () => {
    const peers = [
      row({ key: "a", sortOrder: 10 }),
      row({ key: "b", sortOrder: 10 }),
      row({ key: "c", sortOrder: 30 }),
    ];
    // New order b, a, c → 10, 20, 30: b and c already hold theirs.
    expect(moveWrites(peers, 0, 1).map((w) => [w.row.key, w.sortOrder])).toEqual([["a", 20]]);
  });

  it("returns nothing past either end", () => {
    const peers = [row({ key: "a" }), row({ key: "b", sortOrder: 20 })];
    expect(moveWrites(peers, 0, -1)).toEqual([]);
    expect(moveWrites(peers, 1, 1)).toEqual([]);
  });
});

describe("OrgUnitRoleRoster — Add role", () => {
  it("opens the dialog on the current unit-kind tab", async () => {
    render(
      <OrgUnitRoleRoster
        roles={[row({}), row({ entityType: "department", key: "chair", label: "Chair" })]}
      />,
    );
    fireEvent.click(screen.getByTestId("roles-tab-department"));
    fireEvent.click(screen.getByTestId("roles-add-trigger"));
    const select = (await screen.findByTestId("roles-add-entity-type")) as HTMLSelectElement;
    expect(select.value).toBe("department");
  });
});
