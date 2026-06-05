/**
 * `components/edit/entity-panel.tsx` — the shared hide/show panel for the three
 * whole-entity attributes (#160 UI follow-up). Covers the control-rendering
 * rule, optimistic hide/show + revert-on-error, the chair `locked` row, and the
 * superuser reason-gating.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { EntityPanel, type EntityRow } from "@/components/edit/entity-panel";

type Row = EntityRow & { title: string };

const copy = {
  heading: "Appointments",
  description: "Hide an appointment.",
  empty: "Nothing on file.",
  one: "appointment",
  other: "appointments",
  lockedNote: "This is a department chair appointment and can't be hidden here.",
};

function renderPanel(entities: Row[], mode: "self" | "superuser" = "self") {
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
    />,
  );
}

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const errJson = () => ({ ok: false, json: async () => ({ ok: false, error: "boom" }) }) as unknown as Response;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("EntityPanel — control rendering", () => {
  it("shown → Hide; hidden_by_self → Show; locked → no control + note", () => {
    renderPanel([
      { externalId: "a1", title: "Shown One", state: "shown", suppressionId: null },
      { externalId: "a2", title: "Hidden One", state: "hidden_by_self", suppressionId: "s2" },
      { externalId: "a3", title: "Chair One", state: "locked", suppressionId: null },
    ]);
    expect(screen.getByTestId("appointment-row-a1-hide")).toBeTruthy();
    expect(screen.getByTestId("appointment-row-a2-show")).toBeTruthy();
    expect(screen.queryByTestId("appointment-row-a3-hide")).toBeNull();
    expect(screen.queryByTestId("appointment-row-a3-show")).toBeNull();
    expect(screen.getByText(copy.lockedNote)).toBeTruthy();
  });

  it("self + hidden_by_admin → no control + explanation", () => {
    renderPanel([{ externalId: "a1", title: "Admin Hid", state: "hidden_by_admin", suppressionId: "s1" }]);
    expect(screen.queryByTestId("appointment-row-a1-show")).toBeNull();
    expect(screen.getByText("An administrator hid this entry.")).toBeTruthy();
  });

  it("superuser + hidden_by_admin → Show is offered", () => {
    renderPanel([{ externalId: "a1", title: "Admin Hid", state: "hidden_by_admin", suppressionId: "s1" }], "superuser");
    expect(screen.getByTestId("appointment-row-a1-show")).toBeTruthy();
  });

  it("counts shown + hidden, pluralizing correctly", () => {
    renderPanel([
      { externalId: "a1", title: "A", state: "shown", suppressionId: null },
      { externalId: "a2", title: "B", state: "hidden_by_self", suppressionId: "s2" },
    ]);
    expect(screen.getByText(/2/)).toBeTruthy();
    expect(screen.getByText(/appointments/)).toBeTruthy();
    expect(screen.getByText(/1/)).toBeTruthy();
    expect(screen.getByText(/hidden/)).toBeTruthy();
  });
});

describe("EntityPanel — optimistic hide/show", () => {
  it("self Hide POSTs to /api/edit/suppress and flips the row to Show", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true, suppressionId: "new-sup" }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel([{ externalId: "a1", title: "Shown", state: "shown", suppressionId: null }]);

    fireEvent.click(screen.getByTestId("appointment-row-a1-hide"));
    // Self-mode hide routes through a lightweight no-reason confirm dialog (T2.6).
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hide" }));

    await waitFor(() => expect(screen.getByTestId("appointment-row-a1-show")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/suppress");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      entityType: "appointment",
      entityId: "a1",
    });
  });

  it("Show POSTs to /api/edit/revoke with the suppressionId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true, suppressionId: "s1" }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel([{ externalId: "a1", title: "Hidden", state: "hidden_by_self", suppressionId: "s1" }]);

    fireEvent.click(screen.getByTestId("appointment-row-a1-show"));

    await waitFor(() => expect(screen.getByTestId("appointment-row-a1-hide")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/revoke");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ suppressionId: "s1" });
  });

  it("a failed hide reverts the row and shows an inline error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errJson()));
    renderPanel([{ externalId: "a1", title: "Shown", state: "shown", suppressionId: null }]);

    fireEvent.click(screen.getByTestId("appointment-row-a1-hide"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hide" }));

    // The inline error AND the completed optimistic revert must both be observed
    // in the same poll. React 19's useOptimistic revert flushes on the
    // transition's async tail, which can land a tick after the setError re-render
    // that shows the error — asserting the revert synchronously raced that flush
    // (#652).
    await waitFor(() => {
      expect(screen.getByText(/We couldn't hide this appointment/)).toBeTruthy();
      // Reverted — the Hide control is back, no Show.
      expect(screen.getByTestId("appointment-row-a1-hide")).toBeTruthy();
      expect(screen.queryByTestId("appointment-row-a1-show")).toBeNull();
    });
  });
});

describe("EntityPanel — superuser gating", () => {
  it("superuser Hide opens the reason dialog instead of POSTing immediately", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderPanel([{ externalId: "a1", title: "Shown", state: "shown", suppressionId: null }], "superuser");

    fireEvent.click(screen.getByTestId("appointment-row-a1-hide"));

    // The dialog appears; no fetch yet (reason required first).
    await waitFor(() => expect(screen.getByText("Hide this appointment?")).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
