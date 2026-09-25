/**
 * The Functional roles tab's Assign dialog (`AssignFunctionalRoleDialog`):
 * what it does with the route's answer. The directory typeahead is mocked to
 * a one-click picker so the test drives the submit path directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AssignFunctionalRoleDialog } from "@/components/edit/functional-roles-panel";
import type { FunctionalRoleScopeOptions } from "@/lib/edit/functional-roles";

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    onChange,
  }: {
    onChange: (v: { cwid: string; name: string; title: string | null }) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-pick-grantee"
      onClick={() => onChange({ cwid: "fake001", name: "Pat Example", title: null })}
    >
      pick grantee
    </button>
  ),
}));

const SCOPES: FunctionalRoleScopeOptions = {
  external_affairs: [
    { key: "communications", label: "Communications" },
    { key: "development", label: "Development" },
  ],
  reporting: [
    { key: "*", label: "All reports" },
    { key: "article-count", label: "Article counts" },
  ],
};

function stubRoute(status: number, payload: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function openPickSubmit() {
  fireEvent.click(screen.getByTestId("functional-roles-assign-trigger"));
  await screen.findByTestId("functional-roles-assign-dialog");
  fireEvent.click(screen.getByTestId("mock-pick-grantee"));
  fireEvent.click(screen.getByTestId("functional-roles-assign-submit"));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AssignFunctionalRoleDialog", () => {
  it("409 already_granted keeps the dialog open and points at Edit scope", async () => {
    stubRoute(409, { ok: false, error: "already_granted" });
    const onAssigned = vi.fn();
    render(<AssignFunctionalRoleDialog scopeOptions={SCOPES} onAssigned={onAssigned} />);
    await openPickSubmit();
    const alert = await screen.findByTestId("functional-roles-assign-error");
    expect(alert.textContent).toContain("already holds this role");
    expect(alert.textContent).toContain("Edit scope");
    expect(screen.getByTestId("functional-roles-assign-dialog")).toBeTruthy();
    expect(onAssigned).not.toHaveBeenCalled();
  });

  it("a successful grant hands back the rows and closes", async () => {
    const fetchSpy = stubRoute(200, { ok: true, op: "grant", changed: true, rows: [] });
    const onAssigned = vi.fn();
    render(<AssignFunctionalRoleDialog scopeOptions={SCOPES} onAssigned={onAssigned} />);
    await openPickSubmit();
    await waitFor(() => expect(onAssigned).toHaveBeenCalledWith([]));
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toMatchObject({
      op: "grant",
      role: "reporting",
      cwid: "fake001",
      scopes: ["*"],
    });
    await waitFor(() => expect(screen.queryByTestId("functional-roles-assign-dialog")).toBeNull());
  });

  it("External Affairs: one grant carrying the ticked functions; none ticked cannot submit", async () => {
    const fetchSpy = stubRoute(200, { ok: true, op: "grant", changed: true, rows: [] });
    const onAssigned = vi.fn();
    render(<AssignFunctionalRoleDialog scopeOptions={SCOPES} onAssigned={onAssigned} />);
    fireEvent.click(screen.getByTestId("functional-roles-assign-trigger"));
    await screen.findByTestId("functional-roles-assign-dialog");
    fireEvent.click(screen.getByTestId("mock-pick-grantee"));
    fireEvent.click(screen.getByTestId("functional-roles-assign-role-external_affairs"));
    const submit = screen.getByTestId("functional-roles-assign-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("functional-roles-assign-scope-communications"));
    fireEvent.click(screen.getByTestId("functional-roles-assign-scope-development"));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onAssigned).toHaveBeenCalledWith([]));
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toMatchObject({
      op: "grant",
      role: "external_affairs",
      cwid: "fake001",
      scopes: ["communications", "development"],
    });
  });
});
