/**
 * #1117 — CenterProgramCard: the per-program leader + description editor.
 *
 *  - excludes the ZY catch-all (no page);
 *  - renders each program's leaders;
 *  - toggling interim POSTs set_leader; removing POSTs remove_leader;
 *  - adding a picked person POSTs add_leader; Save POSTs set_description.
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
      { cwid: "lead001", name: "Dana One", title: "Prof", interim: false, sortOrder: 0 },
      { cwid: "lead002", name: "Dana Two", title: null, interim: true, sortOrder: 1 },
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
});
