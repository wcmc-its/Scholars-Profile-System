/**
 * #1992 — the per-row Delete on the /edit "Earlier biosketches" history panel.
 *
 * The server hard-deletes the run, so the two things worth pinning client-side are the guard and
 * the cleanup: the row's button opens the house `ConfirmDialog` and sends nothing until the
 * dialog's own destructive button is pressed, and once the row is gone nothing on screen may still
 * be showing it. A failed delete keeps the row and says so; a 404 does NOT, because "already gone"
 * is the outcome the actor asked for.
 *
 * Native DOM assertions (no jest-dom in `tests/setup.ts`): counts, textContent, toBeNull().
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { BiosketchTool } from "@/components/edit/biosketch-tool";

const GENERATIONS = [
  {
    id: "gen-1",
    mode: "contributions" as const,
    entries: [{ title: "CAR-T resistance", body: "We defined the resistance program." }],
    model: "us.anthropic.claude-opus-4-8",
    promptVersion: "v7",
    params: {},
    products: null,
    sources: null,
    createdByCwid: "scholar1",
    impersonatedCwid: null,
    createdAt: "2026-07-20T12:00:00.000Z",
  },
  {
    id: "gen-2",
    mode: "contributions" as const,
    entries: [{ title: "Trial design", body: "We ran the first-in-human study." }],
    model: "us.anthropic.claude-opus-4-8",
    promptVersion: "v7",
    params: {},
    products: null,
    sources: null,
    createdByCwid: "scholar1",
    impersonatedCwid: null,
    createdAt: "2026-07-18T12:00:00.000Z",
  },
];

const originalFetch = globalThis.fetch;
/** What the DELETE endpoint answers — flipped by the failure / already-gone cases. */
let deleteStatus = 200;

/** Every DELETE the component sent, in order. */
let deletes: Array<Record<string, unknown>>;

beforeEach(() => {
  deleteStatus = 200;
  deletes = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/edit/biosketch/generations")) {
      if (init?.method === "DELETE") {
        deletes.push(JSON.parse(String(init.body)));
        return deleteStatus === 200
          ? new Response(JSON.stringify({ ok: true, deleted: "gen-1" }), { status: 200 })
          : new Response(JSON.stringify({ ok: false, error: "write_failed" }), {
              status: deleteStatus,
            });
      }
      return new Response(JSON.stringify({ ok: true, generations: GENERATIONS }), { status: 200 });
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

function renderTool() {
  return render(<BiosketchTool entityId="scholar1" canSeeCost={false} model="model-id" />);
}

/** The dialog's own destructive button — never the row's. */
function confirmButton() {
  return screen.getByRole("button", { name: "Delete draft" });
}

/** Open the confirm dialog from a history row and wait for it to mount. */
async function openConfirm(id: string) {
  fireEvent.click(await screen.findByTestId(`biosketch-version-delete-${id}`));
  await screen.findByRole("button", { name: "Delete draft" });
}

describe("BiosketchTool — delete a history row (#1992)", () => {
  it("opens the confirm dialog and sends nothing until it is confirmed", async () => {
    renderTool();
    const row = await screen.findByTestId("biosketch-version-delete-gen-1");
    // The row's visible text is a version/model line and a date, so the accessible name is what
    // says which artifact is about to go.
    expect(row.getAttribute("aria-label")).toBe(
      "Delete the contributions draft generated Jul 20, 2026",
    );

    fireEvent.click(row);
    // The dialog names the same artifact, and no request has left yet.
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("contributions draft generated Jul 20, 2026");
    expect(deletes).toHaveLength(0);
    expect(screen.queryByTestId("biosketch-version-gen-1")).not.toBeNull();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toEqual({ generationId: "gen-1" });
    // The row leaves local state; its sibling is untouched.
    await waitFor(() => expect(screen.queryByTestId("biosketch-version-gen-1")).toBeNull());
    expect(screen.queryByTestId("biosketch-version-gen-2")).not.toBeNull();
  });

  it("Cancel closes the dialog, deletes nothing, and leaves the row", async () => {
    renderTool();
    await openConfirm("gen-1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes).toHaveLength(0);
    expect(screen.queryByTestId("biosketch-version-gen-1")).not.toBeNull();
  });

  it("confirms against the row the actor opened it from, not the first one", async () => {
    renderTool();
    await openConfirm("gen-2");
    expect(screen.getByRole("dialog").textContent).toContain(
      "contributions draft generated Jul 18, 2026",
    );

    fireEvent.click(confirmButton());
    await waitFor(() => expect(deletes).toEqual([{ generationId: "gen-2" }]));
    await waitFor(() => expect(screen.queryByTestId("biosketch-version-gen-2")).toBeNull());
    expect(screen.queryByTestId("biosketch-version-gen-1")).not.toBeNull();
  });

  it("clears the result card when the deleted run is the one on screen", async () => {
    renderTool();
    fireEvent.click(await screen.findByTestId("biosketch-version-view-gen-1"));
    expect(await screen.findByTestId("biosketch-result")).not.toBeNull();

    await openConfirm("gen-1");
    fireEvent.click(confirmButton());

    // A draft that no longer exists must not stay on screen above a Copy button.
    await waitFor(() => expect(screen.queryByTestId("biosketch-result")).toBeNull());
  });

  it("leaves a DIFFERENT run's result card alone", async () => {
    renderTool();
    fireEvent.click(await screen.findByTestId("biosketch-version-view-gen-2"));
    expect(await screen.findByTestId("biosketch-result")).not.toBeNull();

    await openConfirm("gen-1");
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.queryByTestId("biosketch-version-gen-1")).toBeNull());
    expect(screen.queryByTestId("biosketch-result")).not.toBeNull();
  });

  it("surfaces a failed delete in the shared error alert and keeps the row", async () => {
    deleteStatus = 500;
    renderTool();
    await openConfirm("gen-1");
    fireEvent.click(confirmButton());

    const alert = await screen.findByTestId("biosketch-error");
    expect(alert.textContent).toContain("We couldn't delete that draft just now.");
    expect(screen.queryByTestId("biosketch-version-gen-1")).not.toBeNull();
    // The dialog closes either way — it is modal, so leaving it open would cover the alert it
    // just caused.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("treats a 404 as the outcome asked for — the row goes, no error", async () => {
    // The route answers 404 when the run is already gone (a retry, or a second tab got there
    // first). Reporting that as a failure would keep rendering a run that no longer exists.
    deleteStatus = 404;
    renderTool();
    await openConfirm("gen-1");
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.queryByTestId("biosketch-version-gen-1")).toBeNull());
    expect(screen.queryByTestId("biosketch-error")).toBeNull();
  });
});
