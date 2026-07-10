/**
 * #1117 — CenterProgramCard: the per-program leader + description editor.
 *
 *  - excludes the ZY catch-all (no page);
 *  - renders each program's leaders;
 *  - toggling interim POSTs set_leader; removing POSTs remove_leader;
 *  - adding a picked person POSTs add_leader; Save POSTs set_description.
 *
 * #1570 — leadership type (`role`) is a per-row dropdown:
 *  - leaders render before COE liaisons, matching the public program page;
 *  - changing the dropdown POSTs set_leader with the new `role`;
 *  - reordering is confined to one leadership type (the boundary buttons are
 *    disabled), since the rendered order is (role, sortOrder) and a cross-type
 *    swap would write twice and change nothing.
 *
 * The directory typeahead is stubbed (its own tests cover it); fetch is mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockTypeahead } = vi.hoisted(() => ({ mockTypeahead: vi.fn() }));

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    onChange,
    idPrefix,
  }: {
    onChange: (v: { cwid: string; name: string; title: string | null } | null) => void;
    idPrefix?: string;
  }) => {
    mockTypeahead({ idPrefix });
    return (
      <button
        type="button"
        data-testid={`pick-${idPrefix}`}
        onClick={() => onChange({ cwid: "new001", name: "New Leader", title: "Professor" })}
      >
        pick
      </button>
    );
  },
}));

import { CenterProgramCard } from "@/components/edit/center-program-card";

const PROGRAMS = [
  {
    code: "CB",
    label: "Cancer Biology",
    sortOrder: 10,
    description: "Bio.",
    leaders: [
      // Deliberately supplied liaison-first to prove the component re-sorts by
      // role rank ("coe_liaison" sorts BEFORE "leader" lexically — the wrong order).
      { cwid: "liai001", name: "Dana Liaison", title: null, interim: false, role: "coe_liaison" as const, sortOrder: 0 },
      { cwid: "lead001", name: "Dana One", title: "Prof", interim: false, role: "leader" as const, sortOrder: 0 },
      { cwid: "lead002", name: "Dana Two", title: null, interim: true, role: "leader" as const, sortOrder: 1 },
    ],
  },
  // ZY must be filtered out (no page).
  { code: "ZY", label: "Non-aligned Clinical", sortOrder: 50, description: null, leaders: [] },
];

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, changed: true }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CenterProgramCard (#1117)", () => {
  it("renders editable programs and excludes ZY", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    expect(screen.getByTestId("program-editor-CB")).toBeTruthy();
    expect(screen.queryByTestId("program-editor-ZY")).toBeNull();
    expect(screen.getByTestId("leader-CB-lead001")).toBeTruthy();
    expect(screen.getByTestId("leader-CB-lead002")).toBeTruthy();
  });

  it("toggling interim POSTs set_leader", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    fireEvent.click(screen.getByTestId("leader-interim-CB-lead001"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      centerCode: "meyer_cancer_center",
      programCode: "CB",
      action: "set_leader",
      cwid: "lead001",
      interim: true,
    });
  });

  it("removing a leader POSTs remove_leader", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    fireEvent.click(screen.getByTestId("leader-remove-CB-lead002"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "remove_leader", cwid: "lead002" });
  });

  it("adding a picked person POSTs add_leader (appended sortOrder)", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    fireEvent.click(screen.getByTestId("pick-program-leader-CB")); // selects new001
    fireEvent.click(screen.getByTestId("leader-add-CB"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "add_leader", cwid: "new001", interim: false, sortOrder: 2 });
  });

  it("Save POSTs set_description after an edit", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    fireEvent.change(screen.getByTestId("program-description-CB"), {
      target: { value: "Updated blurb." },
    });
    fireEvent.click(screen.getByTestId("program-description-save-CB"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "set_description", description: "Updated blurb." });
  });

  // ---------------------------------------------------------------- #1570 role

  it("orders leaders before COE liaisons, whatever order the props arrive in", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    const rendered = Array.from(
      screen.getByTestId("leaders-CB").querySelectorAll("[data-testid^='leader-CB-']"),
    ).map((el) => el.getAttribute("data-testid"));
    expect(rendered).toEqual(["leader-CB-lead001", "leader-CB-lead002", "leader-CB-liai001"]);
  });

  it("each row exposes a leadership-type dropdown reflecting its role", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    expect((screen.getByTestId("leader-role-CB-lead001") as HTMLSelectElement).value).toBe("leader");
    expect((screen.getByTestId("leader-role-CB-liai001") as HTMLSelectElement).value).toBe(
      "coe_liaison",
    );
  });

  it("changing the dropdown POSTs set_leader with the new role", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    fireEvent.change(screen.getByTestId("leader-role-CB-lead002"), {
      target: { value: "coe_liaison" },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "set_leader", cwid: "lead002", role: "coe_liaison" });
  });

  it("promoting a leader to liaison re-sorts it below the remaining leaders", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    fireEvent.change(screen.getByTestId("leader-role-CB-lead002"), {
      target: { value: "coe_liaison" },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => {
      const rendered = Array.from(
        screen.getByTestId("leaders-CB").querySelectorAll("[data-testid^='leader-CB-']"),
      ).map((el) => el.getAttribute("data-testid"));
      // lead002 became a liaison; sortOrder 1 keeps it after liai001 (sortOrder 0).
      expect(rendered).toEqual(["leader-CB-lead001", "leader-CB-liai001", "leader-CB-lead002"]);
    });
  });

  it("new leaders are added as role=leader, sorted after the existing leaders only", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    fireEvent.click(screen.getByTestId("pick-program-leader-CB"));
    fireEvent.click(screen.getByTestId("leader-add-CB"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // sortOrder 2 = max(0,1) + 1 over the LEADER rows; the liaison's 0 is ignored.
    expect(body).toMatchObject({ action: "add_leader", role: "leader", sortOrder: 2 });
  });

  it("reorder buttons stop at the leadership-type boundary", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    // Rendered: lead001, lead002, liai001.
    const down = (cwid: string) =>
      (screen.getByTestId(`leader-down-CB-${cwid}`) as HTMLButtonElement).disabled;
    const up = (cwid: string) =>
      (screen.getByTestId(`leader-up-CB-${cwid}`) as HTMLButtonElement).disabled;
    expect(up("lead001")).toBe(true); // first overall
    expect(down("lead001")).toBe(false); // swaps with lead002 (same type)
    expect(down("lead002")).toBe(true); // next row is a liaison — boundary
    expect(up("liai001")).toBe(true); // previous row is a leader — boundary
    expect(down("liai001")).toBe(true); // last overall
  });

  it("a cross-type swap writes nothing even if move() is reached", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CenterProgramCard centerCode="meyer_cancer_center" programs={PROGRAMS} />);
    fireEvent.click(screen.getByTestId("leader-down-CB-lead002")); // disabled + guarded
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
