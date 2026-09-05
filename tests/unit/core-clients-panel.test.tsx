/**
 * The "Known clients" panel BODY (components/edit/core-clients-panel).
 * Controlled by CoreClaimQueue: coreId/clients/onClientsChange/onClose come
 * in as props, so this file renders the panel already-open and asserts on
 * onClientsChange rather than internal list state. fetch is mocked — no
 * DB/network. The toolbar toggle button + count badge live in CoreClaimQueue
 * now and are covered by tests/unit/core-claim-queue.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

import { CoreClientsPanel } from "@/components/edit/core-clients-panel";
import type { CoreClientRow } from "@/lib/api/core-clients";

function client(over: Partial<CoreClientRow> = {}): CoreClientRow {
  return {
    cwid: "djb2001",
    name: "Doug Ballon",
    slug: "doug-ballon",
    addedAt: new Date("2026-09-01T00:00:00Z"),
    addedBy: "rev01",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoreClientsPanel", () => {
  it("shows the current active list — resolved name+link, and a 'not in Scholars' note for an unresolved CWID", () => {
    render(
      <CoreClientsPanel
        coreId="2"
        clients={[client(), client({ cwid: "xy9999", name: null, slug: null })]}
        onClientsChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "Doug Ballon" })).toBeTruthy();
    expect(screen.getByText("xy9999")).toBeTruthy();
    expect(screen.getByText(/not in Scholars/)).toBeTruthy();
  });

  it("parses a pasted block and POSTs the well-formed CWIDs to /api/edit/core-client", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        added: [{ cwid: "jx2001", name: "Jenny Xiang", slug: "jenny-xiang" }],
        alreadyPresent: [],
        invalid: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClientsPanel coreId="2" clients={[]} onClientsChange={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("CWIDs"), { target: { value: "JX2001, jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/edit/core-client");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", cwids: ["jx2001"] });
  });

  it("renders the result summary and calls onClientsChange with the added row, slug included", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        added: [{ cwid: "jx2001", name: "Jenny Xiang", slug: "jenny-xiang" }],
        alreadyPresent: ["djb2001"],
        invalid: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    render(
      <CoreClientsPanel coreId="2" clients={[client()]} onClientsChange={onClientsChange} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("CWIDs"), { target: { value: "jx2001 djb2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Added 1\..*Already listed: djb2001\./),
    );
    expect(onClientsChange).toHaveBeenCalledTimes(1);
    const next = onClientsChange.mock.calls[0][0] as CoreClientRow[];
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ cwid: "jx2001", name: "Jenny Xiang", slug: "jenny-xiang" });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("falls back to slug: null when the response omits it (an added client not yet on Scholars)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ added: [{ cwid: "jx2001", name: null }], alreadyPresent: [], invalid: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    render(<CoreClientsPanel coreId="2" clients={[]} onClientsChange={onClientsChange} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("CWIDs"), { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onClientsChange).toHaveBeenCalled());
    expect(onClientsChange.mock.calls[0][0][0].slug).toBeNull();
  });

  it("reports an unparseable token as 'Not a CWID' without calling fetch for it", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CoreClientsPanel coreId="2" clients={[]} onClientsChange={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("CWIDs"), { target: { value: "not-a-cwid" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText(/No valid CWIDs found/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Remove calls DELETE with the coreId/cwid and calls onClientsChange without the removed row on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ removed: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    render(
      <CoreClientsPanel coreId="2" clients={[client()]} onClientsChange={onClientsChange} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/edit/core-client");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", cwid: "djb2001" });
    await waitFor(() => expect(onClientsChange).toHaveBeenCalledWith([]));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows a row-level error and does not call onClientsChange when Remove fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const onClientsChange = vi.fn();
    render(
      <CoreClientsPanel coreId="2" clients={[client()]} onClientsChange={onClientsChange} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText(/Could not remove/)).toBeTruthy());
    expect(screen.getByRole("link", { name: "Doug Ballon" })).toBeTruthy();
    expect(onClientsChange).not.toHaveBeenCalled();
  });

  it("Cancel calls onClose", () => {
    const onClose = vi.fn();
    render(<CoreClientsPanel coreId="2" clients={[]} onClientsChange={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
