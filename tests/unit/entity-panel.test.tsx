/**
 * `components/edit/entity-panel.tsx` — the shared hide/show panel for the
 * Education / Funding / Mentees attributes (#160 UI follow-up). Covers the
 * control-rendering rule (checkbox / Show / nothing), the selection bar and its
 * "Also select the N older" extend link, the bulk hide fan-out with its one
 * confirm per batch, optimistic show + revert-on-error, and the chair `locked`
 * row.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { EntityPanel, type EntityPanelProps, type EntityRow } from "@/components/edit/entity-panel";

type Row = EntityRow & { title: string };

const copy = {
  heading: "Appointments",
  description: "Hide an appointment.",
  empty: "Nothing on file.",
  one: "appointment",
  other: "appointments",
  lockedNote: "This is a department chair appointment and can't be hidden here.",
};

function renderPanel(
  entities: Row[],
  mode: "self" | "superuser" = "self",
  extra: Partial<EntityPanelProps<Row>> = {},
) {
  return render(
    <EntityPanel<Row>
      slot="appointments-panel"
      cwid="self01"
      mode={mode}
      scholarName="Alex Self"
      entityType="appointment"
      entities={entities}
      copy={copy}
      getTitle={(e) => e.title}
      renderMeta={(e) => <>{e.title} meta</>}
      {...extra}
    />,
  );
}

const shown = (externalId: string, title: string): Row => ({
  externalId,
  title,
  state: "shown",
  suppressionId: null,
});

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const errJson = () =>
  ({ ok: false, json: async () => ({ ok: false, error: "boom" }) }) as unknown as Response;

const row = (id: string) => within(screen.getByTestId(`appointment-row-${id}`));
const select = (id: string) => fireEvent.click(row(id).getByRole("checkbox"));

/** Open the bulk-hide confirm, type a reason when the superuser dialog asks for
 *  one, and confirm. */
async function bulkHide(reason?: string) {
  fireEvent.click(screen.getByRole("button", { name: "Hide from profile" }));
  const dialog = await screen.findByRole("dialog");
  if (reason !== undefined) {
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: reason } });
  }
  fireEvent.click(within(dialog).getByRole("button", { name: "Hide" }));
}

const bodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter(([u]) => u === "/api/edit/suppress")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("EntityPanel — control rendering", () => {
  it("shown → checkbox; hidden_by_self → Show; locked → no control + note", () => {
    renderPanel([
      shown("a1", "Shown One"),
      { externalId: "a2", title: "Hidden One", state: "hidden_by_self", suppressionId: "s2" },
      { externalId: "a3", title: "Chair One", state: "locked", suppressionId: null },
    ]);
    expect(
      row("a1").getByRole("checkbox", { name: "Select Shown One, Shown One meta" }),
    ).toBeTruthy();
    expect(screen.getByTestId("appointment-row-a2-show")).toBeTruthy();
    expect(row("a2").queryByRole("checkbox")).toBeNull();
    expect(row("a3").queryByRole("checkbox")).toBeNull();
    expect(screen.queryByTestId("appointment-row-a3-show")).toBeNull();
    expect(screen.getByText(copy.lockedNote)).toBeTruthy();
  });

  it("self + hidden_by_admin → no control + explanation", () => {
    renderPanel([{ externalId: "a1", title: "Admin Hid", state: "hidden_by_admin", suppressionId: "s1" }]);
    expect(screen.queryByTestId("appointment-row-a1-show")).toBeNull();
    expect(row("a1").queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("An administrator hid this entry.")).toBeTruthy();
  });

  it("superuser + hidden_by_admin → Show is offered", () => {
    renderPanel([{ externalId: "a1", title: "Admin Hid", state: "hidden_by_admin", suppressionId: "s1" }], "superuser");
    expect(screen.getByTestId("appointment-row-a1-show")).toBeTruthy();
  });

  it("counts shown + hidden, pluralizing correctly", () => {
    renderPanel([
      shown("a1", "A"),
      { externalId: "a2", title: "B", state: "hidden_by_self", suppressionId: "s2" },
    ]);
    expect(screen.getByText(/2/)).toBeTruthy();
    expect(screen.getByText(/appointments/)).toBeTruthy();
    expect(screen.getByText(/1/)).toBeTruthy();
    expect(screen.getByText(/hidden/)).toBeTruthy();
  });
});

describe("EntityPanel — selection", () => {
  it("counts the selection with the panel's own noun", () => {
    renderPanel([shown("a1", "A"), shown("a2", "B")], "self", {
      copy: { ...copy, one: "entry", other: "entries" },
    });
    expect(screen.queryByText(/selected$/)).toBeNull();

    select("a1");
    expect(screen.getByText("1 entry selected")).toBeTruthy();
    select("a2");
    expect(screen.getByText("2 entries selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("offers the rows below the topmost selection — only on a list with extendNoun", () => {
    const rows = [shown("a1", "A"), shown("a2", "B"), shown("a3", "C")];
    const { unmount } = renderPanel(rows, "self", { extendNoun: "older appointment" });
    select("a2");
    // Below the selection: a3 only — a1 sits above it.
    fireEvent.click(screen.getByRole("button", { name: "Also select the 1 older appointment" }));
    expect(screen.getByText("2 appointments selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Also select/ })).toBeNull();
    unmount();

    // No extendNoun (Mentees) → the link never renders.
    renderPanel(rows);
    select("a1");
    expect(screen.getByText("1 appointment selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Also select/ })).toBeNull();
  });

  it("a filter never drops a selected row from the batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true, suppressionId: "new-sup" }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel([shown("a1", "Alpha"), shown("a2", "Beta")], "self", { filterable: true });

    select("a1");
    fireEvent.change(screen.getByTestId("appointments-panel-filter"), {
      target: { value: "Beta" },
    });
    expect(screen.queryByTestId("appointment-row-a1")).toBeNull();
    // The bar counts the selection, not the visible rows.
    expect(screen.getByText("1 appointment selected")).toBeTruthy();

    await bulkHide();
    await waitFor(() =>
      expect(bodies(fetchMock)).toEqual([{ entityType: "appointment", entityId: "a1" }]),
    );
  });
});

describe("EntityPanel — bulk hide", () => {
  it("self: one confirm, then suppress once per selected row", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true, suppressionId: "new-sup" }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel([shown("a1", "A"), shown("a2", "B"), shown("a3", "C")]);

    select("a1");
    select("a3");
    await bulkHide();

    await waitFor(() => expect(screen.queryByText(/selected$/)).toBeNull());
    expect(bodies(fetchMock)).toEqual([
      { entityType: "appointment", entityId: "a1" },
      { entityType: "appointment", entityId: "a3" },
    ]);
    // Both rows now read hidden with a Show control; the untouched row doesn't.
    expect(screen.getByTestId("appointment-row-a1-show")).toBeTruthy();
    expect(screen.getByTestId("appointment-row-a3-show")).toBeTruthy();
    expect(row("a2").getByRole("checkbox")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("superuser: the dialog waits for a required reason, which rides every write", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true, suppressionId: "new-sup" }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel([shown("a1", "A"), shown("a2", "B")], "superuser");

    select("a1");
    select("a2");
    fireEvent.click(screen.getByRole("button", { name: "Hide from profile" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Hide 2 appointments?")).toBeTruthy();
    expect(
      within(dialog).getByText("This removes them from Alex Self's public profile."),
    ).toBeTruthy();
    // No reason typed yet → nothing has been written.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Ticket 42" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide" }));

    await waitFor(() => expect(screen.queryByText(/selected$/)).toBeNull());
    expect(bodies(fetchMock)).toEqual([
      { entityType: "appointment", entityId: "a1", reason: "Ticket 42" },
      { entityType: "appointment", entityId: "a2", reason: "Ticket 42" },
    ]);
    expect(row("a1").getByText("Hidden by an administrator")).toBeTruthy();
  });

  it("a partial failure leaves the failed rows selected under one inline alert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { entityId?: string };
        return Promise.resolve(
          body.entityId === "a1" ? errJson() : okJson({ ok: true, suppressionId: "new-sup" }),
        );
      }),
    );
    renderPanel([shown("a1", "A"), shown("a2", "B")]);

    select("a1");
    select("a2");
    await bulkHide();

    expect(
      await screen.findByText("We couldn't hide 1 of the selected appointments. Please try again."),
    ).toBeTruthy();
    expect(screen.getByText("1 appointment selected")).toBeTruthy();
    expect(row("a1").getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("appointment-row-a2-show")).toBeTruthy();
  });
});

describe("EntityPanel — show", () => {
  it("Show POSTs to /api/edit/revoke with the suppressionId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true, suppressionId: "s1" }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel([{ externalId: "a1", title: "Hidden", state: "hidden_by_self", suppressionId: "s1" }]);

    fireEvent.click(screen.getByTestId("appointment-row-a1-show"));

    await waitFor(() => expect(row("a1").getByRole("checkbox")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/revoke");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ suppressionId: "s1" });
  });

  it("a failed show reverts the row and shows an inline error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errJson()));
    renderPanel([{ externalId: "a1", title: "Hidden", state: "hidden_by_self", suppressionId: "s1" }]);

    fireEvent.click(screen.getByTestId("appointment-row-a1-show"));

    // The inline error AND the completed optimistic revert must both be observed
    // in the same poll. React 19's useOptimistic revert flushes on the
    // transition's async tail, which can land a tick after the setError re-render
    // that shows the error — asserting the revert synchronously raced that flush
    // (#652).
    await waitFor(() => {
      expect(screen.getByText(/We couldn't restore this appointment/)).toBeTruthy();
      // Reverted — still hidden, so Show is back and there is no checkbox.
      expect(screen.getByTestId("appointment-row-a1-show")).toBeTruthy();
      expect(row("a1").queryByRole("checkbox")).toBeNull();
    });
  });
});
