/**
 * `components/edit/org-unit-role-roster.tsx` — the delete follow-up (#2542
 * Phase 3): a per-row Delete control, disabled with an inline reason for a
 * seeded default or any live holder, enabled only for a manual, zero-holder
 * role; confirm → DELETE → the row leaves local state on success. Also locks
 * down the unit-kind section order (`center` above `center_program` above
 * `core`, per owner request).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OrgUnitRoleRoster } from "@/components/edit/org-unit-role-roster";
import type { OrgUnitRoleRosterRow } from "@/lib/api/org-unit-roles-admin";

const row = (over: Partial<OrgUnitRoleRosterRow>): OrgUnitRoleRosterRow => ({
  key: "deputy_director",
  entityType: "center",
  label: "Deputy Director",
  roleGroup: "leadership",
  scope: "unit",
  singleHolder: false,
  sortOrder: 100,
  profileTitle: true,
  source: "manual",
  holderCount: 0,
  unitCount: 0,
  scopeRowCount: 0,
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("OrgUnitRoleRoster — delete button disabled reasons", () => {
  it("is ENABLED for a manual role with zero holders", () => {
    render(<OrgUnitRoleRoster roles={[row({})]} />);
    const btn = screen.getByTestId("roles-delete-center:deputy_director");
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("is DISABLED with a holder-count reason when holderCount > 0", () => {
    render(<OrgUnitRoleRoster roles={[row({ holderCount: 3 })]} />);
    const btn = screen.getByTestId("roles-delete-center:deputy_director");
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("title")).toBe("3 holders");
    const describedBy = btn.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("3 holders");
  });

  it("is DISABLED with a seeded-default reason when source !== 'manual'", () => {
    render(<OrgUnitRoleRoster roles={[row({ source: "seed", holderCount: 0 })]} />);
    const btn = screen.getByTestId("roles-delete-center:deputy_director");
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("title")).toBe("Seeded default — cannot be deleted here.");
  });

  it("a seeded role WITH holders shows the seeded reason, not the holder-count one", () => {
    render(<OrgUnitRoleRoster roles={[row({ source: "seed", holderCount: 5 })]} />);
    const btn = screen.getByTestId("roles-delete-center:deputy_director");
    expect(btn.getAttribute("title")).toBe("Seeded default — cannot be deleted here.");
  });
});

describe("OrgUnitRoleRoster — delete flow", () => {
  it("confirm → DELETE request with {entityType, key} → row removed from the table on 200", async () => {
    const fetchSpy = stubFetch({ ok: true, entityType: "center", key: "deputy_director" });
    render(<OrgUnitRoleRoster roles={[row({})]} />);

    fireEvent.click(screen.getByTestId("roles-delete-center:deputy_director"));
    expect(await screen.findByText('Delete role "Deputy Director" (Center)?')).toBeTruthy();
    expect(screen.getByText(/No one holds it; 0 allowlist rows will be removed too\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/roles");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ entityType: "center", key: "deputy_director" });

    await waitFor(() =>
      expect(screen.queryByTestId("roles-row-center:deputy_director")).toBeNull(),
    );
  });

  it("singular 'allowlist row' when scopeRowCount is 1", async () => {
    render(<OrgUnitRoleRoster roles={[row({ scopeRowCount: 1 })]} />);
    fireEvent.click(screen.getByTestId("roles-delete-center:deputy_director"));
    expect(await screen.findByText(/No one holds it; 1 allowlist row will be removed too\./)).toBeTruthy();
  });

  it("a 409 (role gained a holder after page load) surfaces the server reason inline and keeps the row", async () => {
    stubFetch({ ok: false, error: "role_has_holders", holderCount: 2 }, 409);
    render(<OrgUnitRoleRoster roles={[row({})]} />);

    fireEvent.click(screen.getByTestId("roles-delete-center:deputy_director"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByTestId("roles-row-error-center:deputy_director").textContent).toBe(
        "This role now has 2 holders — reload the page.",
      ),
    );
    // The row stays — a rejected delete must not vanish it.
    expect(screen.getByTestId("roles-row-center:deputy_director")).toBeTruthy();
  });

  it("a 409 seeded_default surfaces the server's exact reason text", async () => {
    stubFetch(
      {
        ok: false,
        error: "seeded_default",
        reason:
          "seeded default — every write path re-seeds DEFAULT_ORG_UNIT_ROLES, so it would come back; remove it from the seed instead",
      },
      409,
    );
    // `source: "manual"` here only to get the button clickable in this test —
    // the disabled-reason coverage above already locks the seeded case out
    // client-side; this exercises the server-message mapping in isolation.
    render(<OrgUnitRoleRoster roles={[row({})]} />);
    fireEvent.click(screen.getByTestId("roles-delete-center:deputy_director"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByTestId("roles-row-error-center:deputy_director").textContent).toMatch(
        /re-seeds DEFAULT_ORG_UNIT_ROLES/,
      ),
    );
  });

  it("Cancel on the confirm dialog sends no request", async () => {
    const fetchSpy = stubFetch({ ok: true });
    render(<OrgUnitRoleRoster roles={[row({})]} />);
    fireEvent.click(screen.getByTestId("roles-delete-center:deputy_director"));
    await screen.findByText('Delete role "Deputy Director" (Center)?');
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("roles-row-center:deputy_director")).toBeTruthy();
  });
});

describe("OrgUnitRoleRoster — unit-kind section order", () => {
  it("renders center_program directly under center, and above core", () => {
    render(
      <OrgUnitRoleRoster
        roles={[
          row({ entityType: "core", key: "member", roleGroup: "membership" }),
          row({ entityType: "department", key: "chair" }),
          row({ entityType: "center_program", key: "leader" }),
          row({ entityType: "center", key: "director" }),
          row({ entityType: "division", key: "chief" }),
        ]}
      />,
    );
    const sectionIds = screen
      .getAllByTestId(/^roles-section-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(sectionIds).toEqual([
      "roles-section-center",
      "roles-section-center_program",
      "roles-section-department",
      "roles-section-division",
      "roles-section-core",
    ]);
  });
});
