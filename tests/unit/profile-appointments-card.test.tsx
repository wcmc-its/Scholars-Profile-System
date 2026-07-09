/**
 * #1568 — the self-service `ProfileAppointmentsCard` editor under the
 * Appointments tab. Covers the fetch-on-mount list render (including the Hidden
 * marker for `showOnProfile === false`), the add flow (POST create + optimistic
 * append), and the remove flow (POST delete + list prune). The category grouping
 * / showOnProfile *display* rule lives on the public profile and is covered by
 * `profile-appointments-group.test.ts`.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { ProfileAppointmentsCard } from "@/components/edit/profile-appointments-card";

type Row = {
  id: string;
  category: "WCM_LEADERSHIP" | "EXTERNAL";
  title: string;
  organization: string;
  unit: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  sortOrder: number;
  showOnProfile: boolean;
  source: string;
  enteredByCwid: string;
  createdAt: string;
  updatedAt: string;
};

function row(overrides: Partial<Row>): Row {
  return {
    id: "row-1",
    category: "WCM_LEADERSHIP",
    title: "Program Director",
    organization: "Weill Cornell Medicine",
    unit: "Hematology and Medical Oncology",
    location: null,
    startDate: "2020-01-01",
    endDate: null,
    sortOrder: 0,
    showOnProfile: true,
    source: "SELF",
    enteredByCwid: "aog2001",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

const json = (body: unknown, ok = true) =>
  ({ ok, json: async () => body }) as unknown as Response;

/**
 * Route the GET (list) and POST (create/update/delete) off one mock. The POST
 * echoes the posted fields back as a stored row so the optimistic list update
 * has something to render.
 */
function routedFetch(initial: Row[]) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (!init || init.method !== "POST") {
      return Promise.resolve(json({ ok: true, appointments: initial }));
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (body.action === "delete") {
      return Promise.resolve(json({ ok: true, action: "delete", id: body.id, changed: true }));
    }
    const appointment = row({
      id: typeof body.id === "string" ? body.id : "row-new",
      category: body.category as Row["category"],
      title: String(body.title),
      organization: String(body.organization),
      unit: (body.unit as string | null) ?? null,
      location: (body.location as string | null) ?? null,
      startDate: (body.startDate as string | null) ?? null,
      endDate: (body.endDate as string | null) ?? null,
      showOnProfile: body.showOnProfile !== false,
    });
    return Promise.resolve(json({ ok: true, action: body.action, appointment }));
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("ProfileAppointmentsCard — list render", () => {
  it("fetches on mount and renders rows with a meta line and the Hidden marker", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        row({ id: "a", title: "Program Director", showOnProfile: true }),
        row({ id: "b", title: "Head of Section", showOnProfile: false }),
      ]),
    );
    render(<ProfileAppointmentsCard cwid="aog2001" mode="self" scholarName="Ann Gable" />);

    expect(await screen.findByText("Program Director")).toBeTruthy();
    expect(screen.getByText("Head of Section")).toBeTruthy();
    // organization / unit / year range join into the muted meta line
    expect(screen.getAllByText(/Weill Cornell Medicine · Hematology and Medical Oncology · 2020–/)[0]).toBeTruthy();
    // the hidden row carries a Hidden marker; the shown one does not
    expect(screen.getByText(/Hidden/)).toBeTruthy();
  });

  it("shows an empty state when the scholar has no self-asserted appointments", async () => {
    vi.stubGlobal("fetch", routedFetch([]));
    render(<ProfileAppointmentsCard cwid="nobody" mode="self" scholarName="No One" />);
    expect(await screen.findByText(/No additional appointments added yet/i)).toBeTruthy();
  });

  it("surfaces a load error when the GET fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, false)));
    render(<ProfileAppointmentsCard cwid="aog2001" mode="self" scholarName="Ann Gable" />);
    expect(await screen.findByText(/couldn.t load these appointments/i)).toBeTruthy();
  });
});

describe("ProfileAppointmentsCard — mutations", () => {
  it("creates a row: POSTs action=create with the owner cwid, then appends it", async () => {
    const fetchMock = routedFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    render(<ProfileAppointmentsCard cwid="aog2001" mode="self" scholarName="Ann Gable" />);
    await screen.findByText(/No additional appointments added yet/i);

    fireEvent.click(screen.getByTestId("profile-appointment-add"));
    fireEvent.change(screen.getByTestId("profile-appointment-title-add"), {
      target: { value: "Committee Chair" },
    });
    fireEvent.change(screen.getByTestId("profile-appointment-organization-add"), {
      target: { value: "Weill Cornell Medicine" },
    });
    fireEvent.click(screen.getByTestId("profile-appointment-submit-add"));

    expect(await screen.findByText("Committee Chair")).toBeTruthy();
    const createCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String((createCall![1] as RequestInit).body));
    expect(body).toMatchObject({
      cwid: "aog2001",
      action: "create",
      title: "Committee Chair",
      organization: "Weill Cornell Medicine",
      category: "WCM_LEADERSHIP",
    });
  });

  it("blocks submit until title and organization are both filled", async () => {
    vi.stubGlobal("fetch", routedFetch([]));
    render(<ProfileAppointmentsCard cwid="aog2001" mode="self" scholarName="Ann Gable" />);
    await screen.findByText(/No additional appointments added yet/i);

    fireEvent.click(screen.getByTestId("profile-appointment-add"));
    const submit = screen.getByTestId("profile-appointment-submit-add") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("profile-appointment-title-add"), {
      target: { value: "Committee Chair" },
    });
    expect(submit.disabled).toBe(true); // organization still empty

    fireEvent.change(screen.getByTestId("profile-appointment-organization-add"), {
      target: { value: "WCM" },
    });
    expect(submit.disabled).toBe(false);
  });

  it("removes a row: POSTs action=delete and prunes the list", async () => {
    const fetchMock = routedFetch([row({ id: "a", title: "Program Director" })]);
    vi.stubGlobal("fetch", fetchMock);
    render(<ProfileAppointmentsCard cwid="aog2001" mode="self" scholarName="Ann Gable" />);
    await screen.findByText("Program Director");

    fireEvent.click(screen.getByTestId("profile-appointment-remove-a"));

    await waitFor(() => expect(screen.queryByText("Program Director")).toBeNull());
    const deleteCall = fetchMock.mock.calls.find(([, init]) => {
      const i = init as RequestInit | undefined;
      return i?.method === "POST" && JSON.parse(String(i.body)).action === "delete";
    });
    expect(deleteCall).toBeTruthy();
  });
});
