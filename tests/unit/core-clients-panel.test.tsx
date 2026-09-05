/**
 * The "Known clients" panel (components/edit/core-clients-panel). fetch is
 * mocked — no DB/network.
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
  it("renders the toggle button with the active count badge", () => {
    render(<CoreClientsPanel coreId="2" initial={[client(), client({ cwid: "jx2001", name: null, slug: null })]} />);
    const button = screen.getByRole("button", { name: /Known clients/ });
    expect(button).toBeTruthy();
    expect(button.textContent).toContain("2");
  });

  it("opens to show the current active list — resolved name+link, and a 'not in Scholars' note for an unresolved CWID", () => {
    render(
      <CoreClientsPanel
        coreId="2"
        initial={[client(), client({ cwid: "xy9999", name: null, slug: null })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Known clients/ }));
    expect(screen.getByRole("link", { name: "Doug Ballon" })).toBeTruthy();
    expect(screen.getByText("xy9999")).toBeTruthy();
    expect(screen.getByText(/not in Scholars/)).toBeTruthy();
  });

  it("parses a pasted block and POSTs the well-formed CWIDs to /api/edit/core-client", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ added: [{ cwid: "jx2001", name: "Jenny Xiang" }], alreadyPresent: [], invalid: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClientsPanel coreId="2" initial={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Known clients/ }));
    fireEvent.change(screen.getByLabelText("CWIDs"), { target: { value: "JX2001, jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/edit/core-client");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", cwids: ["jx2001"] });
  });

  it("renders the result summary (added / already present / invalid) and folds new rows into the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        added: [{ cwid: "jx2001", name: "Jenny Xiang" }],
        alreadyPresent: ["djb2001"],
        invalid: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClientsPanel coreId="2" initial={[client()]} />);
    fireEvent.click(screen.getByRole("button", { name: /Known clients/ }));
    fireEvent.change(screen.getByLabelText("CWIDs"), { target: { value: "jx2001 djb2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Added 1\..*Already listed: djb2001\./),
    );
    expect(screen.getByText("Jenny Xiang")).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("reports an unparseable token as 'Not a CWID' without calling fetch for it", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CoreClientsPanel coreId="2" initial={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Known clients/ }));
    fireEvent.change(screen.getByLabelText("CWIDs"), { target: { value: "not-a-cwid" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText(/No valid CWIDs found/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Remove calls DELETE with the coreId/cwid and drops the row from the list on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ removed: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClientsPanel coreId="2" initial={[client()]} />);
    fireEvent.click(screen.getByRole("button", { name: /Known clients/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/edit/core-client");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", cwid: "djb2001" });
    await waitFor(() => expect(screen.queryByRole("link", { name: "Doug Ballon" })).toBeNull());
  });

  it("shows a row-level error and keeps the row when Remove fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClientsPanel coreId="2" initial={[client()]} />);
    fireEvent.click(screen.getByRole("button", { name: /Known clients/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText(/Could not remove/)).toBeTruthy());
    expect(screen.getByRole("link", { name: "Doug Ballon" })).toBeTruthy();
  });
});
