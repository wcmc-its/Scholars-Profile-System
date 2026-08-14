/**
 * cores-as-org-units P3 — CoreLeaderCard: the `CoreLeader` list editor.
 *
 *  - renders each leader (name/title, open-string role, interim);
 *  - adding a picked person POSTs add_leader with the default role
 *    ("director") and an appended sortOrder;
 *  - removing POSTs remove_leader;
 *  - toggling interim POSTs set_leader;
 *  - editing the role text field commits on blur (set_leader), and only
 *    when the value actually changed;
 *  - reorder buttons swap sortOrder and are disabled at the list boundaries.
 *
 * The directory typeahead is stubbed (its own tests cover it); fetch is mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    onChange,
    idPrefix,
  }: {
    onChange: (v: { cwid: string; name: string; title: string | null } | null) => void;
    idPrefix?: string;
  }) => (
    <button
      type="button"
      data-testid={`pick-${idPrefix}`}
      onClick={() => onChange({ cwid: "new001", name: "New Leader", title: "Professor" })}
    >
      pick
    </button>
  ),
}));

import { CoreLeaderCard, type CoreLeaderState } from "@/components/edit/core-leader-card";

const LEADERS: CoreLeaderState[] = [
  { cwid: "lead001", name: "Dana One", title: "Professor", role: "director", interim: false, sortOrder: 0 },
  { cwid: "lead002", name: "Dana Two", title: null, role: "co-director", interim: true, sortOrder: 1 },
];

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, changed: true }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CoreLeaderCard", () => {
  it("renders each leader", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CoreLeaderCard coreId="2" leaders={LEADERS} />);
    expect(screen.getByTestId("core-leader-lead001")).toBeTruthy();
    expect(screen.getByTestId("core-leader-lead002")).toBeTruthy();
    expect((screen.getByTestId("core-leader-role-lead002") as HTMLInputElement).value).toBe(
      "co-director",
    );
  });

  it("shows an empty state with no leaders", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CoreLeaderCard coreId="2" leaders={[]} />);
    expect(screen.getByText("No leaders set.")).toBeTruthy();
  });

  it("adding a picked person POSTs add_leader with the default role + appended sortOrder", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreLeaderCard coreId="2" leaders={LEADERS} />);
    fireEvent.click(screen.getByTestId("pick-core-leader"));
    fireEvent.click(screen.getByTestId("core-leader-add"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      coreId: "2",
      action: "add_leader",
      cwid: "new001",
      role: "director",
      interim: false,
      sortOrder: 2,
    });
  });

  it("removing a leader POSTs remove_leader", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreLeaderCard coreId="2" leaders={LEADERS} />);
    fireEvent.click(screen.getByTestId("core-leader-remove-lead002"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "remove_leader", cwid: "lead002" });
  });

  it("toggling interim POSTs set_leader", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreLeaderCard coreId="2" leaders={LEADERS} />);
    fireEvent.click(screen.getByTestId("core-leader-interim-lead001"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "set_leader", cwid: "lead001", interim: true });
  });

  it("editing the role field commits on blur (set_leader)", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreLeaderCard coreId="2" leaders={LEADERS} />);
    const input = screen.getByTestId("core-leader-role-lead001");
    fireEvent.change(input, { target: { value: "associate director" } });
    fireEvent.blur(input);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "set_leader", cwid: "lead001", role: "associate director" });
  });

  it("blurring the role field with no change does not POST", () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreLeaderCard coreId="2" leaders={LEADERS} />);
    const input = screen.getByTestId("core-leader-role-lead001");
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an empty role on blur shows an error and does not POST", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreLeaderCard coreId="2" leaders={LEADERS} />);
    const input = screen.getByTestId("core-leader-role-lead001");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByText(/Role must be/)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reorder buttons swap sortOrder and are disabled at the boundaries", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreLeaderCard coreId="2" leaders={LEADERS} />);
    expect((screen.getByTestId("core-leader-up-lead001") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("core-leader-down-lead002") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("core-leader-down-lead001"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      action: "set_leader",
      cwid: "lead001",
      sortOrder: 1,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject({
      action: "set_leader",
      cwid: "lead002",
      sortOrder: 0,
    });
  });
});
