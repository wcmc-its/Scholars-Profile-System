/**
 * The "Known clients" MODAL (components/edit/core-clients-panel).
 * Controlled by CoreClaimQueue: coreId/open/clients/onClientsChange/onClose come
 * in as props, so this file renders the dialog already-open and asserts on
 * onClientsChange rather than internal list state. fetch is mocked — no
 * DB/network. The toolbar toggle button + count badge live in CoreClaimQueue
 * now and are covered by tests/unit/core-claim-queue.test.tsx.
 *
 * The paste path is TWO steps here: "Look up CWIDs" resolves against the server
 * and only then does "Add clients" enable. Every add test walks both, because
 * skipping the lookup is precisely what the disabled footer button prevents.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

import { CoreClientsDialog } from "@/components/edit/core-clients-panel";
import type { CoreClientRow } from "@/lib/api/core-clients";

function client(over: Partial<CoreClientRow> = {}): CoreClientRow {
  return {
    id: "row-1",
    cwid: "djb2001",
    name: "Doug Ballon",
    slug: "doug-ballon",
    affiliation: "Radiology",
    addedAt: new Date("2026-09-01T00:00:00Z"),
    addedBy: "djb2001",
    addedByName: "Doug Ballon",
    ...over,
  };
}

function open(props: Partial<React.ComponentProps<typeof CoreClientsDialog>> = {}) {
  return render(
    <CoreClientsDialog
      coreId="2"
      open
      clients={[]}
      onClientsChange={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

/** A resolved lookup response for `cwid`, then the add response. */
function lookupThenAdd(
  resolved: Array<Record<string, unknown>>,
  added: Array<Record<string, unknown>>,
  alreadyPresent: string[] = [],
) {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ resolved, invalid: [] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ added, alreadyPresent, invalid: [] }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mockRefresh.mockClear();
});

describe("CoreClientsDialog", () => {
  it("shows the current roster — resolved name+link, and a 'not in Scholars' note for an unresolved CWID", () => {
    open({ clients: [client(), client({ id: "row-2", cwid: "xy9999", name: null, slug: null })] });
    expect(screen.getByRole("link", { name: "Doug Ballon" })).toBeTruthy();
    expect(screen.getByText("xy9999")).toBeTruthy();
    expect(screen.getByText(/not in Scholars/)).toBeTruthy();
  });

  it("names who added a row and when — 'added by Doug Ballon (djb2001) · Aug 31, 2026'", () => {
    open({ clients: [client()] });
    expect(screen.getByText(/added by Doug Ballon \(djb2001\)/)).toBeTruthy();
    expect(screen.getByText(/Radiology/)).toBeTruthy();
  });

  it("falls back to the bare cwid when the actor has no Scholar row", () => {
    open({ clients: [client({ addedByName: null })] });
    expect(screen.getByText(/added by djb2001/)).toBeTruthy();
  });

  it("marks a NAME-ONLY row as unable to flag a byline", () => {
    open({
      clients: [
        client({ id: "row-3", cwid: null, name: "Ada Lovelace", slug: null, affiliation: "MIT" }),
      ],
    });
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText(/name only — no byline match/)).toBeTruthy();
  });

  it("'Look up CWIDs' POSTs mode:lookup, writes nothing, and reports where each name came from", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resolved: [
          { cwid: "jx2001", name: "Jenny Xiang", dept: "Pathology", slug: "jenny-xiang", source: "scholars", alreadyPresent: false },
          { cwid: "ab1234", name: "Al Best", dept: "ITS", slug: null, source: "directory", alreadyPresent: false },
        ],
        invalid: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), {
      target: { value: "JX2001, ab1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up CWIDs" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/edit/core-client");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      coreId: "2",
      cwids: ["jx2001", "ab1234"],
      mode: "lookup",
    });
    expect(await screen.findByText("Jenny Xiang")).toBeTruthy();
    expect(screen.getByText("enterprise directory")).toBeTruthy();
  });

  it("keeps 'Add clients' disabled until a lookup has resolved something addable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resolved: [
          { cwid: "jx2001", name: "Jenny Xiang", dept: null, slug: null, source: "scholars", alreadyPresent: false },
        ],
        invalid: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    open();
    const addBtn = screen.getByRole("button", { name: "Add clients" }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    // Still disabled on a paste alone — the lookup is the gate, not the text.
    expect(addBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Look up CWIDs" }));
    await waitFor(() => expect(addBtn.disabled).toBe(false));
  });

  it("a lookup that resolves ONLY already-listed people leaves 'Add clients' disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resolved: [
          { cwid: "djb2001", name: "Doug Ballon", dept: null, slug: null, source: "scholars", alreadyPresent: true },
        ],
        invalid: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    open({ clients: [client()] });
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "djb2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up CWIDs" }));
    expect(await screen.findByText("already listed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add clients" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("'Add clients' POSTs only the addable CWIDs and folds the added row back with its id", async () => {
    const fetchMock = lookupThenAdd(
      [
        { cwid: "jx2001", name: "Jenny Xiang", dept: null, slug: null, source: "scholars", alreadyPresent: false },
        { cwid: "djb2001", name: "Doug Ballon", dept: null, slug: null, source: "scholars", alreadyPresent: true },
      ],
      [{ id: "row-9", cwid: "jx2001", name: "Jenny Xiang", slug: "jenny-xiang", affiliation: "Pathology" }],
      ["djb2001"],
    );
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    open({ clients: [client()], onClientsChange });
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), {
      target: { value: "jx2001 djb2001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up CWIDs" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Add clients" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The already-listed CWID is NOT re-sent.
    expect(JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body)).toEqual({
      coreId: "2",
      cwids: ["jx2001"],
    });
    await waitFor(() => expect(onClientsChange).toHaveBeenCalledTimes(1));
    const next = onClientsChange.mock.calls[0][0] as CoreClientRow[];
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ id: "row-9", cwid: "jx2001", name: "Jenny Xiang" });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("falls back to the cwid as the row key when the add response carries no id", async () => {
    const fetchMock = lookupThenAdd(
      [{ cwid: "jx2001", name: null, dept: null, slug: null, source: null, alreadyPresent: false }],
      [{ cwid: "jx2001", name: null }],
    );
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    open({ onClientsChange });
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up CWIDs" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Add clients" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    await waitFor(() => expect(onClientsChange).toHaveBeenCalled());
    expect(onClientsChange.mock.calls[0][0][0]).toMatchObject({ id: "jx2001", slug: null });
  });

  it("reports an unparseable token as 'No valid CWIDs found' without calling fetch", () => {
    vi.stubGlobal("fetch", vi.fn());
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "not-a-cwid" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up CWIDs" }));
    expect(screen.getByText(/No valid CWIDs found/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("editing the paste after a lookup re-disables 'Add clients' — the resolution is stale", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resolved: [
          { cwid: "jx2001", name: "Jenny Xiang", dept: null, slug: null, source: "scholars", alreadyPresent: false },
        ],
        invalid: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    open();
    const paste = screen.getByLabelText("Paste CWIDs");
    fireEvent.change(paste, { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up CWIDs" }));
    const addBtn = screen.getByRole("button", { name: "Add clients" }) as HTMLButtonElement;
    await waitFor(() => expect(addBtn.disabled).toBe(false));
    fireEvent.change(paste, { target: { value: "jx2001 ab1234" } });
    expect(addBtn.disabled).toBe(true);
  });

  it("'Add by name' POSTs mode:name and folds a cwid-less row into the roster", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        added: [{ id: "row-7", name: "Ada Lovelace", affiliation: "Analytical Engines" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    open({ onClientsChange });
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Affiliation (optional)"), {
      target: { value: "Analytical Engines" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add by name" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)).toEqual({
      coreId: "2",
      mode: "name",
      displayName: "Ada Lovelace",
      affiliation: "Analytical Engines",
    });
    await waitFor(() => expect(onClientsChange).toHaveBeenCalledTimes(1));
    expect(onClientsChange.mock.calls[0][0][0]).toMatchObject({
      id: "row-7",
      cwid: null,
      name: "Ada Lovelace",
      affiliation: "Analytical Engines",
    });
  });

  it("a name-only add the server rejects as a duplicate reports it and adds nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ added: [], alreadyPresent: ["Ada Lovelace"] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    open({ onClientsChange });
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: "Add by name" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Already on the roster: Ada Lovelace/),
    );
    expect(onClientsChange).not.toHaveBeenCalled();
  });

  it("Remove DELETEs by row id (never the cwid) and drops the row on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ removed: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    open({ clients: [client()], onClientsChange });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/edit/core-client");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", id: "row-1" });
    await waitFor(() => expect(onClientsChange).toHaveBeenCalledWith([]));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("removes a NAME-ONLY row by its id — the path a cwid key could not reach", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ removed: true }) });
    vi.stubGlobal("fetch", fetchMock);
    open({ clients: [client({ id: "row-3", cwid: null, name: "Ada Lovelace", slug: null })] });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)).toEqual({
      coreId: "2",
      id: "row-3",
    });
  });

  it("shows a row-level error and does not call onClientsChange when Remove fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    open({ clients: [client()], onClientsChange });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText(/Could not remove/)).toBeTruthy());
    expect(screen.getByRole("link", { name: "Doug Ballon" })).toBeTruthy();
    expect(onClientsChange).not.toHaveBeenCalled();
  });

  it("Cancel calls onClose", () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("CoreClientsDialog — gaps found in adversarial review", () => {
  it("labels each resolved person with the store they came from, row by row", async () => {
    // Scoped per row: a document-wide getByText passes even if the two labels
    // are swapped, since both strings are on screen either way.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resolved: [
          { cwid: "jx2001", name: "Jenny Xiang", dept: null, slug: null, source: "scholars", alreadyPresent: false },
          { cwid: "ab1234", name: "Al Best", dept: null, slug: null, source: "directory", alreadyPresent: false },
        ],
        invalid: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001 ab1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up CWIDs" }));
    await screen.findByText("Jenny Xiang");
    const rows = document
      .querySelector('[data-slot="core-clients-resolved"]')!
      .querySelectorAll("li");
    expect(rows[0].textContent).toContain("Jenny Xiang");
    expect(rows[0].textContent).toContain("Scholars");
    expect(rows[0].textContent).not.toContain("enterprise directory");
    expect(rows[1].textContent).toContain("Al Best");
    expect(rows[1].textContent).toContain("enterprise directory");
  });

  it("prints the date a roster row was added", async () => {
    open({ clients: [client({ addedAt: new Date("2026-08-12T12:00:00Z") })] });
    const roster = document.querySelector('[data-slot="core-clients-roster"]')!;
    expect(roster.textContent).toContain("Aug 12, 2026");
  });

  it("closing clears the NAME-ONLY fields too, not just the paste", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <CoreClientsDialog
        coreId="2"
        open
        clients={[]}
        onClientsChange={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Affiliation (optional)"), { target: { value: "MIT" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The Dialog stays MOUNTED while closed, so unreset state survives a close.
    rerender(
      <CoreClientsDialog
        coreId="2"
        open
        clients={[]}
        onClientsChange={vi.fn()}
        onClose={onClose}
      />,
    );
    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Affiliation (optional)") as HTMLInputElement).value).toBe("");
  });

  it("closing clears a stale row-level error, which would otherwise accuse a row that is gone", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const props = { coreId: "2", clients: [client()], onClientsChange: vi.fn(), onClose };
    const { rerender } = render(<CoreClientsDialog {...props} open />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText(/Could not remove/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rerender(<CoreClientsDialog {...props} open />);
    expect(screen.queryByText(/Could not remove/)).toBeNull();
  });
});
