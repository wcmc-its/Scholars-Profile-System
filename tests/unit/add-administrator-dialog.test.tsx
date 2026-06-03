/**
 * `components/edit/add-administrator-dialog.tsx` — the page-level "Add
 * administrator" dialog (#728 Phase C, hoisted from the per-card forms). It
 * POSTs the existing `/api/edit/grant` with the picked grantee, the chosen unit,
 * and the role, then calls `onGranted` so the roster upserts.
 *
 * The directory typeahead is mocked to a one-click picker so the test drives the
 * dialog's submit logic directly (the typeahead has its own suite).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AddAdministratorDialog, type AddAdminUnit } from "@/components/edit/add-administrator-dialog";

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    onChange,
  }: {
    onChange: (v: { cwid: string; name: string; title: string | null }) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-pick-grantee"
      onClick={() => onChange({ cwid: "new001", name: "New Person", title: "Manager" })}
    >
      pick grantee
    </button>
  ),
}));

beforeEach(() => {
  vi.restoreAllMocks();
});

const UNITS: AddAdminUnit[] = [
  {
    value: "department:N1140",
    entityType: "department",
    entityId: "N1140",
    unitName: "Anesthesiology",
    label: "Anesthesiology · Department",
  },
];

function stubGrant(result: { ok: boolean; error?: string; status?: number } = { ok: true }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const { status, ...body } = result;
    return new Response(JSON.stringify(body), {
      status: status ?? (result.ok ? 200 : 403),
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("AddAdministratorDialog", () => {
  it("opens from a single page-level trigger", () => {
    render(<AddAdministratorDialog units={UNITS} onGranted={() => {}} />);
    expect(screen.getByTestId("administrators-add-trigger")).toBeTruthy();
    fireEvent.click(screen.getByTestId("administrators-add-trigger"));
    expect(screen.getByTestId("administrators-add-dialog")).toBeTruthy();
  });

  it("grants the picked grantee on the chosen unit + role, then calls onGranted", async () => {
    const fetchMock = stubGrant({ ok: true });
    const onGranted = vi.fn();
    render(<AddAdministratorDialog units={UNITS} onGranted={onGranted} />);

    fireEvent.click(screen.getByTestId("administrators-add-trigger"));
    fireEvent.click(screen.getByTestId("mock-pick-grantee"));
    fireEvent.change(screen.getByTestId("administrators-add-unit"), {
      target: { value: "department:N1140" },
    });
    fireEvent.click(screen.getByTestId("administrators-add-role-owner"));
    fireEvent.click(screen.getByTestId("administrators-add-submit"));

    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    const grantCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/edit/grant"));
    expect(grantCall).toBeTruthy();
    const body = JSON.parse(String((grantCall![1] as RequestInit).body));
    expect(body).toMatchObject({
      entityType: "department",
      entityId: "N1140",
      cwid: "new001",
      role: "owner",
      action: "grant",
    });
    const [grantee, grant] = onGranted.mock.calls[0];
    expect(grantee.cwid).toBe("new001");
    expect(grant).toMatchObject({
      entityType: "department",
      entityId: "N1140",
      unitName: "Anesthesiology",
      role: "owner",
      source: "manual",
    });
  });

  it("surfaces a server error and does not call onGranted", async () => {
    stubGrant({ ok: false, error: "scope_violation", status: 403 });
    const onGranted = vi.fn();
    render(<AddAdministratorDialog units={UNITS} onGranted={onGranted} />);

    fireEvent.click(screen.getByTestId("administrators-add-trigger"));
    fireEvent.click(screen.getByTestId("mock-pick-grantee"));
    fireEvent.change(screen.getByTestId("administrators-add-unit"), {
      target: { value: "department:N1140" },
    });
    fireEvent.click(screen.getByTestId("administrators-add-submit"));

    await waitFor(() => expect(screen.getByTestId("administrators-add-error")).toBeTruthy());
    expect(onGranted).not.toHaveBeenCalled();
  });

  it("shows a no-units note and keeps submit disabled when there are no units", () => {
    render(<AddAdministratorDialog units={[]} onGranted={() => {}} />);
    fireEvent.click(screen.getByTestId("administrators-add-trigger"));
    expect(screen.getByTestId("administrators-add-no-units")).toBeTruthy();
    expect((screen.getByTestId("administrators-add-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
