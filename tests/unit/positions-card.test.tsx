/**
 * `components/edit/positions-card.tsx` — the Positions & appointments tab:
 * current rows (primary / selectable / hidden / locked), earlier ranks grouped
 * by title, the selection bar with "Also select the N older", and the bulk
 * hide fan-out (suppress per current row, appointment-visibility per record).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

import { PositionsCard, type PositionsCardProps } from "@/components/edit/positions-card";
import type {
  EditContextAppointment,
  EditContextHistoricalAppointment,
} from "@/lib/api/edit-context";

const current: EditContextAppointment[] = [
  {
    externalId: "cur-primary",
    title: "Professor of Medicine",
    organization: "Medicine",
    startDate: "2025-01-01",
    endDate: null,
    isPrimary: true,
    state: "shown",
    suppressionId: null,
  },
  {
    externalId: "cur-sel",
    title: "Professor of Genetics",
    organization: "Genetics",
    startDate: "2020-07-01",
    endDate: "2027-06-30",
    isPrimary: false,
    state: "shown",
    suppressionId: null,
  },
  {
    externalId: "cur-hidden",
    title: "Professor",
    organization: "Graduate School",
    startDate: "2009-01-01",
    endDate: null,
    isPrimary: false,
    state: "hidden_by_self",
    suppressionId: "sup-1",
  },
  {
    externalId: "cur-chair",
    title: "Chair of Medicine",
    organization: "Medicine",
    startDate: "2018-01-01",
    endDate: null,
    isPrimary: false,
    state: "locked",
    suppressionId: null,
  },
];

const hist = (
  externalId: string,
  title: string,
  organization: string,
  startDate: string,
  endDate: string,
  showOnProfile = true,
): EditContextHistoricalAppointment => ({
  externalId,
  title,
  organization,
  startDate,
  endDate,
  showOnProfile,
});

// Four records → two ranks, each held in two departments.
const historical = [
  hist("h-assoc-a", "Associate Professor", "Dept A", "2014-01-01", "2017-12-31"),
  hist("h-assoc-b", "Associate Professor", "Dept B", "2015-01-01", "2019-12-31"),
  hist("h-asst-a", "Assistant Professor", "Dept A", "2009-01-01", "2014-12-31"),
  hist("h-asst-b", "Assistant Professor", "Dept B", "2010-01-01", "2014-12-31"),
];

function renderCard(overrides: Partial<PositionsCardProps> = {}) {
  return render(
    <PositionsCard
      cwid="self01"
      mode="self"
      scholarName="Alex Self"
      appointments={current}
      historicalAppointments={historical}
      showHistorical
      {...overrides}
    />,
  );
}

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const errJson = () =>
  ({ ok: false, json: async () => ({ ok: false, error: "boom" }) }) as unknown as Response;

/** Route each POST off one mock; `fail` names bodies that should 500. */
function routedFetch(fail: (body: Record<string, unknown>) => boolean = () => false) {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(fail(body) ? errJson() : okJson({ ok: true, suppressionId: "sup-new" }));
  });
}

const bodies = (fetchMock: ReturnType<typeof vi.fn>, url: string) =>
  fetchMock.mock.calls
    .filter(([u]) => u === url)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const row = (testId: string) => within(screen.getByTestId(testId));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("PositionsCard — rendering", () => {
  it("renders the heading, current rows with pills, and the grouped earlier ranks", () => {
    renderCard();
    expect(document.querySelector('[data-slot="appointments-panel"]')).not.toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).id).toBe("panel-heading");
    expect(screen.getByText("Managed at its source")).toBeTruthy();
    expect(screen.getByText("4 appointments")).toBeTruthy();

    // Primary / locked: pill, no checkbox. Selectable: checkbox.
    expect(row("appointment-row-cur-primary").getByText("Primary · Always shown")).toBeTruthy();
    expect(row("appointment-row-cur-primary").queryByRole("checkbox")).toBeNull();
    expect(row("appointment-row-cur-chair").getByText("Chair · Always shown")).toBeTruthy();
    expect(row("appointment-row-cur-chair").queryByRole("checkbox")).toBeNull();
    expect(row("appointment-row-cur-sel").getByRole("checkbox")).toBeTruthy();
    expect(row("appointment-row-cur-sel").getByText("2020–2027")).toBeTruthy();

    // Hidden: pill + Show, no checkbox.
    expect(row("appointment-row-cur-hidden").getByText("Hidden")).toBeTruthy();
    expect(screen.getByTestId("appointment-row-cur-hidden-show")).toBeTruthy();
    expect(row("appointment-row-cur-hidden").queryByRole("checkbox")).toBeNull();

    // Every current row offers Request a change; earlier ranks don't.
    expect(screen.getAllByRole("button", { name: "Request a change" })).toHaveLength(4);

    // Earlier ranks: two groups, departments joined, span across the group.
    expect(screen.getByText("Earlier ranks")).toBeTruthy();
    expect(screen.getByText("2 roles · 2009–2019")).toBeTruthy();
    expect(
      screen.getByText(
        "Four directory records, grouped by rank. Each row covers every department the rank was held in.",
      ),
    ).toBeTruthy();
    const assoc = row("historical-appointment-row-h-assoc-b");
    expect(assoc.getByText("Associate Professor")).toBeTruthy();
    expect(assoc.getByText("Dept B · Dept A")).toBeTruthy();
    expect(assoc.getByText("2014–2019")).toBeTruthy();
    expect(assoc.getByRole("checkbox")).toBeTruthy();
    expect(row("historical-appointment-row-h-asst-b").getByText("2009–2014")).toBeTruthy();
  });

  it("superuser: hidden-by-self reads 'Hidden by the scholar'; self can't Show an admin hide", () => {
    const { unmount } = renderCard({ mode: "superuser" });
    expect(row("appointment-row-cur-hidden").getByText("Hidden by the scholar")).toBeTruthy();
    unmount();

    renderCard({
      appointments: [{ ...current[2], state: "hidden_by_admin", suppressionId: "sup-a" }],
      historicalAppointments: [],
    });
    expect(screen.getByText("Hidden by an administrator")).toBeTruthy();
    expect(screen.queryByTestId("appointment-row-cur-hidden-show")).toBeNull();
  });

  it("empty states: no current rows → copy; showHistorical=false → no Earlier ranks", () => {
    renderCard({ appointments: [], showHistorical: false });
    expect(screen.getByText("You have no academic appointments on file.")).toBeTruthy();
    expect(screen.queryByText("Earlier ranks")).toBeNull();
  });
});

describe("PositionsCard — selection", () => {
  it("counts singular/plural and offers the older rows below the topmost selection", () => {
    renderCard();
    expect(screen.queryByText(/selected$/)).toBeNull();

    fireEvent.click(row("appointment-row-cur-sel").getByRole("checkbox"));
    expect(screen.getByText("1 appointment selected")).toBeTruthy();
    // Below the 2020 row: the two earlier-rank groups (hidden/primary/locked excluded).
    const also = screen.getByRole("button", { name: "Also select the 2 older appointments" });
    fireEvent.click(also);
    expect(screen.getByText("3 appointments selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Also select/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("selecting only the oldest group offers nothing older", () => {
    renderCard();
    fireEvent.click(row("historical-appointment-row-h-asst-b").getByRole("checkbox"));
    expect(screen.getByText("1 appointment selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Also select/ })).toBeNull();
  });
});

describe("PositionsCard — bulk hide", () => {
  it("self: suppress once per current row, appointment-visibility once per record, refresh once", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderCard();

    fireEvent.click(row("appointment-row-cur-sel").getByRole("checkbox"));
    fireEvent.click(row("historical-appointment-row-h-assoc-b").getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Hide from profile" }));

    await waitFor(() => expect(screen.queryByText(/selected$/)).toBeNull());
    expect(bodies(fetchMock, "/api/edit/suppress")).toEqual([
      { entityType: "appointment", entityId: "cur-sel" },
    ]);
    expect(bodies(fetchMock, "/api/edit/appointment-visibility")).toEqual(
      expect.arrayContaining([
        { appointmentExternalId: "h-assoc-a", showOnProfile: false },
        { appointmentExternalId: "h-assoc-b", showOnProfile: false },
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Both rows now read hidden with a Show button.
    expect(row("appointment-row-cur-sel").getByText("Hidden")).toBeTruthy();
    expect(screen.getByTestId("appointment-row-cur-sel-show")).toBeTruthy();
    expect(row("historical-appointment-row-h-assoc-b").getByText("Hidden")).toBeTruthy();
    expect(screen.getByTestId("historical-appointment-row-h-assoc-b-show")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("superuser: one required-reason dialog, the reason sent with every suppress", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderCard({ mode: "superuser", historicalAppointments: [] });

    fireEvent.click(row("appointment-row-cur-sel").getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Hide from profile" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Hide 1 appointment?")).toBeTruthy();
    expect(
      within(dialog).getByText("This removes it from Alex Self's public profile."),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Ticket 42" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide" }));

    await waitFor(() => expect(screen.queryByText(/selected$/)).toBeNull());
    expect(bodies(fetchMock, "/api/edit/suppress")).toEqual([
      { entityType: "appointment", entityId: "cur-sel", reason: "Ticket 42" },
    ]);
    expect(row("appointment-row-cur-sel").getByText("Hidden by an administrator")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a failed hide leaves that row selected and shows one inline alert", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch((body) => body.entityId === "cur-sel"),
    );
    renderCard();

    fireEvent.click(row("appointment-row-cur-sel").getByRole("checkbox"));
    fireEvent.click(row("historical-appointment-row-h-asst-b").getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Hide from profile" }));

    expect(
      await screen.findByText("We couldn't hide 1 of the selected appointments. Please try again."),
    ).toBeTruthy();
    expect(screen.getByText("1 appointment selected")).toBeTruthy();
    expect(row("appointment-row-cur-sel").getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(row("historical-appointment-row-h-asst-b").getByText("Hidden")).toBeTruthy();
  });
});

describe("PositionsCard — show", () => {
  it("Show on a hidden group flips every record back on", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderCard({
      historicalAppointments: historical.map((h) =>
        h.title === "Assistant Professor" ? { ...h, showOnProfile: false } : h,
      ),
    });
    const asst = row("historical-appointment-row-h-asst-b");
    expect(asst.getByText("Hidden")).toBeTruthy();
    expect(asst.queryByRole("checkbox")).toBeNull();

    fireEvent.click(screen.getByTestId("historical-appointment-row-h-asst-b-show"));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(bodies(fetchMock, "/api/edit/appointment-visibility")).toEqual(
      expect.arrayContaining([
        { appointmentExternalId: "h-asst-a", showOnProfile: true },
        { appointmentExternalId: "h-asst-b", showOnProfile: true },
      ]),
    );
    await waitFor(() => expect(asst.getByRole("checkbox")).toBeTruthy());
  });

  it("superuser Show of a scholar-hidden row confirms the override, then revokes", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderCard({ mode: "superuser", historicalAppointments: [] });

    fireEvent.click(screen.getByTestId("appointment-row-cur-hidden-show"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Show this appointment again?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Show it" }));

    await waitFor(() =>
      expect(row("appointment-row-cur-hidden").getByRole("checkbox")).toBeTruthy(),
    );
    expect(bodies(fetchMock, "/api/edit/revoke")).toEqual([{ suppressionId: "sup-1" }]);
  });
});
