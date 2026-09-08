/**
 * The "Known clients" MODAL (components/edit/core-clients-panel).
 * Controlled by CoreClaimQueue: coreId/open/clients/onClose come in as props, so
 * this file renders the dialog already-open. The roster it lists is the
 * `clients` PROP — there is no local list here and, since round 4, no cached
 * copy in the parent either (see the last describe, which renders the REAL
 * parent because that is the only place the cache could hide). Every write ends
 * in `router.refresh()`, so a test that wants to watch the roster MOVE
 * re-renders with the props a refresh would deliver. fetch is mocked — no
 * DB/network. The toolbar toggle button + count badge live in CoreClaimQueue
 * and are covered by tests/unit/core-claim-queue.test.tsx.
 *
 * The paste path is ONE step: the "Add clients" button beside the textarea
 * resolves AND writes in a single POST with no `mode`, so every add test here is
 * one click and one request. It was two steps until HANDOFF-11 #2 — a "Look up
 * CWIDs" preview plus a footer commit button reviewers never scrolled to — which
 * is why one test asserts that only ONE "Add clients" button exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

import { CoreClaimQueue } from "@/components/edit/core-claim-queue";
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
  return render(<CoreClientsDialog coreId="2" open clients={[]} onClose={vi.fn()} {...props} />);
}

/** The footer's dismiss button. The dialog SHELL renders its own close X with an
 *  sr-only "Close" label, so now that the footer button says "Close" too a bare
 *  byRole("button", { name: "Close" }) matches both. */
function footerClose(): HTMLElement {
  return document.querySelector('[data-slot="dialog-footer"] button') as HTMLElement;
}

/** The band holding the textarea, the "Add clients" button and that add's
 *  outcome — an add that writes nothing must still report INSIDE it. */
function pasteBand(): HTMLElement {
  return screen.getByLabelText("Paste CWIDs").parentElement as HTMLElement;
}

/** "On the roster now" — the server's active list, and the ONLY thing that
 *  answers "is this person a client of this core?". Scoped: the add receipt
 *  above it prints the same names, so a document-wide text query cannot tell a
 *  roster row from a receipt line. */
function rosterText(): string {
  const roster = document.querySelector('[data-slot="core-clients-roster"]');
  // No <ul> at all is the empty state — return what it says instead of throwing,
  // so a test can assert on either shape.
  return (roster ?? document.querySelector('[data-slot="core-clients-dialog"]'))!.textContent ?? "";
}

/** The one response the route returns for a POST with no `mode`: it resolved
 *  and wrote in the same call. */
function addResponse(added: Array<Record<string, unknown>>, alreadyPresent: string[] = []) {
  return vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ added, alreadyPresent, invalid: [] }) });
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

  it("'Add clients' POSTs the parsed block with NO mode, and reports what was written", async () => {
    const fetchMock = addResponse([
      {
        id: "row-9",
        cwid: "jx2001",
        name: "Jenny Xiang",
        slug: "jenny-xiang",
        affiliation: "Pathology",
        source: "scholars",
      },
      { id: "row-10", cwid: "ab1234", name: null, slug: null, affiliation: null, source: null },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), {
      target: { value: "JX2001, ab1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/edit/core-client");
    expect(init.method).toBe("POST");
    // The ABSENCE of `mode` is what makes the route resolve AND write in one call.
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", cwids: ["jx2001", "ab1234"] });
    expect(await screen.findByText("Jenny Xiang")).toBeTruthy();
    // A CWID Scholars does not hold is written anyway, and says so in past tense.
    expect(screen.getByText("added — not found, recorded anyway")).toBeTruthy();
  });

  it("offers exactly ONE 'Add clients' button, gated only on the paste", () => {
    vi.stubGlobal("fetch", vi.fn());
    open();
    // A second one would be the footer commit button — i.e. the two-step flow back.
    const buttons = screen.getAllByRole("button", { name: "Add clients" }) as HTMLButtonElement[];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    // Nothing else to confirm: the paste alone enables the write.
    expect(buttons[0].disabled).toBe(false);
  });

  it("an add where everything is already listed says so and writes no roster row", async () => {
    const fetchMock = addResponse([], ["djb2001"]);
    vi.stubGlobal("fetch", fetchMock);
    open({ clients: [client()] });
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "djb2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Already listed: djb2001/);
    // The roster is the prop, unchanged: one row, the one that came in.
    expect(document.querySelectorAll('[data-slot="core-clients-roster"] li')).toHaveLength(1);
    expect(rosterText()).toContain("Doug Ballon");
    // Nothing was written, so there is no receipt list at all — which is exactly
    // why the status line has to be somewhere the reviewer is already looking.
    expect(document.querySelector('[data-slot="core-clients-added"]')).toBeNull();
    expect(pasteBand().contains(status)).toBe(true);
    expect(document.querySelector('[data-slot="dialog-footer"]')!.textContent).not.toMatch(
      /Already listed/,
    );
  });

  it("a failed add POST reports under the button too, and clears no state", async () => {
    // The footer this used to report in sits below the name-only band and the
    // whole roster inside a 85vh scroller: a reviewer never sees it.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Could not save/);
    expect(pasteBand().contains(status)).toBe(true);
    // The paste survives a failure — it is what the retry needs.
    expect((screen.getByLabelText("Paste CWIDs") as HTMLTextAreaElement).value).toBe("jx2001");
  });

  it("sends the WHOLE parsed block and leaves the roster to the refreshed payload", async () => {
    // The client no longer filters already-listed CWIDs out of the request: the
    // route holds the active list and reports them back in `alreadyPresent`.
    const fetchMock = addResponse(
      [
        {
          id: "row-9",
          cwid: "jx2001",
          name: "Jenny Xiang",
          slug: "jenny-xiang",
          affiliation: "Pathology",
        },
      ],
      ["djb2001"],
    );
    vi.stubGlobal("fetch", fetchMock);
    open({ clients: [client()] });
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), {
      target: { value: "jx2001 djb2001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)).toEqual({
      coreId: "2",
      cwids: ["jx2001", "djb2001"],
    });
    // The receipt names who was written…
    expect(await screen.findByText("Jenny Xiang")).toBeTruthy();
    // …and the refresh is what puts them on the roster: this dialog never
    // appends a row of its own making, so until the payload lands the roster is
    // still the one row it was handed.
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll('[data-slot="core-clients-roster"] li')).toHaveLength(1);
    expect(rosterText()).not.toContain("Jenny Xiang");
  });

  it("an add response with NO row id still lists the person, and fabricates no roster row", async () => {
    // The id used to fall back to the cwid so the folded-back row had a key —
    // and Remove, which always sends `id`, then 404'd forever against a row
    // whose real id was something else. There is no folded-back row now: the
    // receipt says what was written, and every roster row comes from the server
    // with the id the server wrote.
    const fetchMock = addResponse([{ cwid: "jx2001", name: null }]);
    vi.stubGlobal("fetch", fetchMock);
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="core-clients-added"] li')).toBeTruthy(),
    );
    expect(document.querySelector('[data-slot="core-clients-roster"]')).toBeNull();
    expect(rosterText()).toContain("No known clients yet.");
  });

  it("reports an unparseable token as 'No valid CWIDs found' without calling fetch", () => {
    vi.stubGlobal("fetch", vi.fn());
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "not-a-cwid" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    expect(screen.getByText(/No valid CWIDs found/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("editing the paste clears the previous add's receipt — it describes a paste that is gone", async () => {
    const fetchMock = addResponse([
      { id: "row-9", cwid: "jx2001", name: "Jenny Xiang", slug: null, affiliation: null },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    open();
    const paste = screen.getByLabelText("Paste CWIDs");
    fireEvent.change(paste, { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    expect(await screen.findByText("Jenny Xiang")).toBeTruthy();
    fireEvent.change(paste, { target: { value: "ab1234" } });
    expect(screen.queryByText("Jenny Xiang")).toBeNull();
  });

  it("'Add by name' POSTs mode:name and refreshes to pick the written row up", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        added: [{ id: "row-7", name: "Ada Lovelace", affiliation: "Analytical Engines" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    open();
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
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Added Ada Lovelace/);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it("a name-only add the server rejects as a duplicate reports it and adds nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ added: [], alreadyPresent: ["Ada Lovelace"] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    open();
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: "Add by name" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Already on the roster: Ada Lovelace/);
    // Under the name button, not under the CWID paste it says nothing about.
    expect(pasteBand().contains(status)).toBe(false);
    // Nothing was written and nothing about the server changed.
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("Remove DELETEs by row id (never the cwid), then says 'Removed' until the payload drops it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ removed: true }) });
    vi.stubGlobal("fetch", fetchMock);
    open({ clients: [client()] });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/edit/core-client");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", id: "row-1" });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    // The row is the server's to drop, and it is still in the prop until the
    // refreshed payload arrives — so the button reports what it did and stays
    // disabled. A second click would only earn a 404 and a false
    // "Could not remove" against a row that is already gone.
    const button = (await screen.findByRole("button", {
      name: "Removed",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
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

  it("shows a row-level error, re-arms the button and refreshes nothing when Remove fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    open({ clients: [client()] });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText(/Could not remove/)).toBeTruthy());
    expect(screen.getByRole("link", { name: "Doug Ballon" })).toBeTruthy();
    // Nothing was removed, so the retry the message asks for has to be possible
    // — and there is no server change to go and fetch.
    const button = screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("Close calls onClose — the footer confirms nothing now, it only dismisses", () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.click(footerClose());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("CoreClientsDialog — gaps found in adversarial review", () => {
  it("labels each written row by the store that named them, or as unnamed", async () => {
    // Scoped per row: a document-wide getByText passes even if the labels are
    // swapped, since every string is on screen either way. The middle row is the
    // one the collapsed two-step flow got wrong — an enterprise-directory hit
    // reported as "not found, recorded anyway".
    const fetchMock = addResponse([
      {
        id: "row-9",
        cwid: "jx2001",
        name: "Jenny Xiang",
        slug: null,
        affiliation: null,
        source: "scholars",
      },
      {
        id: "row-11",
        cwid: "ab1234",
        name: "Al Best",
        slug: null,
        affiliation: "Research Computing",
        source: "directory",
      },
      { id: "row-10", cwid: "zz9999", name: null, slug: null, affiliation: null, source: null },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), {
      target: { value: "jx2001 ab1234 zz9999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    await screen.findByText("Jenny Xiang");
    const rows = document.querySelector('[data-slot="core-clients-added"]')!.querySelectorAll("li");
    expect(rows[0].textContent).toContain("Jenny Xiang");
    expect(rows[0].textContent).toContain("added from Scholars");
    expect(rows[0].textContent).not.toContain("recorded anyway");
    expect(rows[1].textContent).toContain("Al Best");
    expect(rows[1].textContent).toContain("added from the directory");
    expect(rows[1].textContent).not.toContain("not found");
    expect(rows[2].textContent).toContain("zz9999");
    expect(rows[2].textContent).toContain("added — not found, recorded anyway");
  });

  it("does NOT print a directory OUTAGE as 'not found' — that is a claim about the person", async () => {
    // `source: "unavailable"` means the directory never answered, so nothing is
    // known about ab1234 either way. It used to arrive as `source: null` and be
    // printed as "not found, recorded anyway" about someone the directory knows
    // perfectly well — the sentence the panel's own docblock reserves for the
    // case where BOTH stores answered and neither held the CWID.
    const fetchMock = addResponse([
      {
        id: "row-12",
        cwid: "ab1234",
        name: null,
        slug: null,
        affiliation: null,
        source: "unavailable",
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "ab1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    // Scoped to the receipt list: a document-wide text query also matches the
    // paste textarea itself.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="core-clients-added"] li')).toBeTruthy(),
    );
    const row = document.querySelector('[data-slot="core-clients-added"] li') as HTMLElement;
    expect(row.textContent).toContain("added — directory unavailable, name unknown");
    expect(row.textContent).not.toContain("not found");
  });

  it("still says 'not found' for a CWID both stores ANSWERED about — the label is not just gone", async () => {
    const fetchMock = addResponse([
      { id: "row-13", cwid: "zz9999", name: null, slug: null, affiliation: null, source: null },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "zz9999" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="core-clients-added"] li')).toBeTruthy(),
    );
    const row = document.querySelector('[data-slot="core-clients-added"] li') as HTMLElement;
    expect(row.textContent).toContain("added — not found, recorded anyway");
    expect(row.textContent).not.toContain("directory unavailable");
  });

  it("does not refresh when the add wrote nothing and the server listed nothing either", async () => {
    // An all-invalid paste never reaches the route; a route that reports neither
    // an add nor an already-listed row has told us nothing new about the server.
    const fetchMock = addResponse([], []);
    vi.stubGlobal("fetch", fetchMock);
    open();
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    await screen.findByRole("status");
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("a removed row stops being named as added — the receipt is past tense, not stale", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          added: [
            {
              id: "row-9",
              cwid: "jx2001",
              name: "Jenny Xiang",
              slug: null,
              affiliation: null,
              source: "scholars",
            },
          ],
          alreadyPresent: [],
          invalid: [],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ removed: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const props = { coreId: "2", clients: [] as CoreClientRow[], onClose: vi.fn() };
    const { rerender } = render(<CoreClientsDialog {...props} open />);
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    expect(await screen.findByText("Jenny Xiang")).toBeTruthy();
    // The SERVER owns the list, so feed the written row in as the prop the
    // refreshed payload would carry — that is what puts a Remove button on screen.
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    rerender(
      <CoreClientsDialog
        {...props}
        clients={[client({ id: "row-9", cwid: "jx2001", name: "Jenny Xiang", slug: null })]}
        open
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="core-clients-added"]')).toBeNull(),
    );
  });

  it("re-arms Remove on a client who was removed and then ADDED BACK in the same session", async () => {
    // The route upserts on (coreId, cwid) and clears `removedAt`, so re-adding
    // revives the SAME row id — the id the remove above parked as "done". Left
    // there, the revived row comes back wearing a dead "Removed" button that
    // nothing but a page reload can undo.
    const fetchMock = vi
      .fn()
      // the DELETE…
      .mockResolvedValueOnce({ ok: true, json: async () => ({ removed: true }) })
      // …then the add that brings row-1 back, id and all.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          added: [
            {
              id: "row-1",
              cwid: "djb2001",
              name: "Doug Ballon",
              slug: "doug-ballon",
              affiliation: "Radiology",
              source: "scholars",
            },
          ],
          alreadyPresent: [],
          invalid: [],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    open({ clients: [client()] });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("button", { name: "Removed" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "djb2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const button = (await screen.findByRole("button", { name: "Remove" })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Removed" })).toBeNull();
  });

  it("prints the date a roster row was added", async () => {
    open({ clients: [client({ addedAt: new Date("2026-08-12T12:00:00Z") })] });
    const roster = document.querySelector('[data-slot="core-clients-roster"]')!;
    expect(roster.textContent).toContain("Aug 12, 2026");
  });

  it("closing clears the NAME-ONLY fields too, not just the paste", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <CoreClientsDialog coreId="2" open clients={[]} onClose={onClose} />,
    );
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Affiliation (optional)"), { target: { value: "MIT" } });
    fireEvent.click(footerClose());
    // The Dialog stays MOUNTED while closed, so unreset state survives a close.
    rerender(<CoreClientsDialog coreId="2" open clients={[]} onClose={onClose} />);
    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Affiliation (optional)") as HTMLInputElement).value).toBe("");
  });

  it("closing clears a stale row-level error, which would otherwise accuse a row that is gone", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const props = { coreId: "2", clients: [client()], onClose };
    const { rerender } = render(<CoreClientsDialog {...props} open />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText(/Could not remove/)).toBeTruthy());
    fireEvent.click(footerClose());
    rerender(<CoreClientsDialog {...props} open />);
    expect(screen.queryByText(/Could not remove/)).toBeNull();
  });

  it("closing clears the add receipt too — the dialog stays mounted and would reopen with it", async () => {
    const fetchMock = addResponse([
      { id: "row-9", cwid: "jx2001", name: "Jenny Xiang", slug: null, affiliation: null },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const props = { coreId: "2", clients: [] as CoreClientRow[], onClose: vi.fn() };
    const { rerender } = render(<CoreClientsDialog {...props} open />);
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    expect(await screen.findByText("Jenny Xiang")).toBeTruthy();
    fireEvent.click(footerClose());
    rerender(<CoreClientsDialog {...props} open />);
    expect(screen.queryByText("Jenny Xiang")).toBeNull();
  });
});

/**
 * The roster is the SERVER's list, and these are the only tests that can prove
 * it: they render the REAL parent, because the copy that used to swallow the
 * refresh lived there, not in the dialog. `CoreClaimQueue` held `clients` in
 * `useState` — seeded once, never re-seeded, the only prop in that file kept
 * that way — so `router.refresh()` re-rendered the Server Component, delivered
 * a fresh `clients`, and the component threw it away. A dialog-level test
 * cannot see that: pass the dialog a new `clients` prop and it renders it.
 *
 * `router.refresh()` is mocked here (it is in every test in this file), so what
 * a refresh DOES — hand this client component a new payload — is played back as
 * a `rerender` with the props the server would have sent.
 */
describe("CoreClaimQueue — the roster follows the refreshed payload, not a cached copy", () => {
  const CORE = {
    id: "2",
    name: "Biomedical Imaging",
    staffCount: null as number | null,
    staffTrackedCount: null as number | null,
  };

  /** The open modal. Scoped: the toolbar button prints the same count and the
   *  add receipt prints the same names as the roster. */
  function dialog(): HTMLElement {
    return document.querySelector('[data-slot="core-clients-dialog"]') as HTMLElement;
  }

  /** The toolbar's own "Known clients (N)" button. Found through the DOM rather
   *  than by role because Radix marks the rest of the page `aria-hidden` while
   *  the modal is open, and getByRole skips hidden subtrees — the count has to
   *  be readable WITH the roster on screen, since agreeing with it is the point. */
  function toolbarButton(): HTMLElement {
    const toolbar = document.querySelector('[data-slot="core-queue-toolbar"]') as HTMLElement;
    return Array.from(toolbar.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").startsWith("Known clients"),
    ) as HTMLElement;
  }

  function openModal() {
    fireEvent.click(toolbarButton());
  }

  function toolbarCount(): string {
    return (toolbarButton().textContent ?? "").replace(/\s+/g, " ").trim();
  }

  it("lists a client SOMEONE ELSE added, once the refresh that add fires delivers them", async () => {
    // Two tabs on the same core, both adding jx2001. Tab B's POST wrote nothing
    // — `alreadyPresent: ["jx2001"]` — so there is no row for the dialog to fold
    // back, and the ONLY thing that can move this roster is the refresh it
    // fires. Before round 4 that refresh was inert: the reviewer sat looking at
    // "Already listed: jx2001" above a roster reading "No known clients yet."
    const fetchMock = addResponse([], ["jx2001"]);
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} clients={[]} />,
    );
    openModal();
    expect(dialog().textContent).toContain("No known clients yet.");
    expect(toolbarCount()).toBe("Known clients (0)");

    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add clients" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Already listed: jx2001/);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));

    // What `router.refresh()` delivers: the server's list, with the row the
    // other tab wrote — real id, real actor, real date, none of it invented here.
    rerender(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[]}
        clients={[
          client({
            id: "row-9",
            cwid: "jx2001",
            name: "Jenny Xiang",
            slug: "jenny-xiang",
            affiliation: "Pathology",
            addedBy: "aaa1001",
            addedByName: "Alex Testerson",
          }),
        ]}
      />,
    );

    const roster = dialog().querySelector('[data-slot="core-clients-roster"]') as HTMLElement;
    expect(roster).toBeTruthy();
    expect(roster.textContent).toContain("Jenny Xiang");
    expect(roster.textContent).toContain("jx2001");
    // The co-owner who actually added them, not this session pretending it did.
    expect(roster.textContent).toContain("added by Alex Testerson (aaa1001)");
    expect(dialog().textContent).not.toContain("No known clients yet.");
    // The toolbar count reads the same list, so the two cannot disagree.
    expect(toolbarCount()).toBe("Known clients (1)");
  });

  it("drops a client someone else removed, on that same channel", () => {
    const { rerender } = render(
      <CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} clients={[client()]} />,
    );
    openModal();
    expect(dialog().textContent).toContain("Doug Ballon");
    expect(toolbarCount()).toBe("Known clients (1)");

    // The same channel, arriving for the opposite reason — a co-owner removed
    // the row. A cached list cannot learn this either, and the stale copy is
    // also what decides which bylines get flagged as client co-authors.
    rerender(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} clients={[]} />);
    expect(dialog().textContent).toContain("No known clients yet.");
    expect(dialog().textContent).not.toContain("Doug Ballon");
    expect(toolbarCount()).toBe("Known clients (0)");
  });
});
