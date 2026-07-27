/**
 * #1992 — the per-row Delete on the /edit "Earlier biosketches" history panel.
 *
 * The server hard-deletes the run, so the two things worth pinning client-side are the guard and
 * the cleanup: one click must NOT fire the request (the button arms itself first — there is no
 * undo behind it), and once the row is gone nothing on screen may still be showing it. A failed
 * delete keeps the row and says so, rather than optimistically dropping a run that still exists.
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
/** Whether the DELETE endpoint answers ok — flipped by the failure case. */
let deleteOk = true;

/** Every DELETE the component sent, in order. */
let deletes: Array<Record<string, unknown>>;

beforeEach(() => {
  deleteOk = true;
  deletes = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/edit/biosketch/generations")) {
      if (init?.method === "DELETE") {
        deletes.push(JSON.parse(String(init.body)));
        return deleteOk
          ? new Response(JSON.stringify({ ok: true, deleted: "gen-1" }), { status: 200 })
          : new Response(JSON.stringify({ ok: false, error: "write_failed" }), { status: 500 });
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

describe("BiosketchTool — delete a history row (#1992)", () => {
  it("arms on the first click and only sends the DELETE on the second", async () => {
    renderTool();
    const button = await screen.findByTestId("biosketch-version-delete-gen-1");
    // The row's visible text is a version/model line and a date, so the accessible name is what
    // says which artifact is about to go.
    expect(button.getAttribute("aria-label")).toBe(
      "Delete the contributions draft generated Jul 20, 2026",
    );

    fireEvent.click(button);
    expect(button.textContent).toContain("Confirm");
    expect(button.getAttribute("aria-label")).toBe(
      "Confirm deleting the contributions draft generated Jul 20, 2026",
    );
    expect(deletes).toHaveLength(0);
    expect(screen.queryByTestId("biosketch-version-gen-1")).not.toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toEqual({ generationId: "gen-1" });
    // The row leaves local state; its sibling is untouched.
    await waitFor(() => expect(screen.queryByTestId("biosketch-version-gen-1")).toBeNull());
    expect(screen.queryByTestId("biosketch-version-gen-2")).not.toBeNull();
  });

  it("arming a second row disarms the first, so a stray click never deletes", async () => {
    renderTool();
    const first = await screen.findByTestId("biosketch-version-delete-gen-1");
    const second = await screen.findByTestId("biosketch-version-delete-gen-2");

    fireEvent.click(first);
    expect(first.textContent).toContain("Confirm");
    fireEvent.click(second);
    expect(second.textContent).toContain("Confirm");
    expect(first.textContent).toContain("Delete");

    // The now-disarmed first row re-arms instead of firing.
    fireEvent.click(first);
    expect(deletes).toHaveLength(0);
  });

  it("clears the result card when the deleted run is the one on screen", async () => {
    renderTool();
    fireEvent.click(await screen.findByTestId("biosketch-version-view-gen-1"));
    expect(await screen.findByTestId("biosketch-result")).not.toBeNull();

    const button = screen.getByTestId("biosketch-version-delete-gen-1");
    fireEvent.click(button);
    fireEvent.click(button);

    // A draft that no longer exists must not stay on screen above a Copy button.
    await waitFor(() => expect(screen.queryByTestId("biosketch-result")).toBeNull());
  });

  it("leaves a DIFFERENT run's result card alone", async () => {
    renderTool();
    fireEvent.click(await screen.findByTestId("biosketch-version-view-gen-2"));
    expect(await screen.findByTestId("biosketch-result")).not.toBeNull();

    const button = screen.getByTestId("biosketch-version-delete-gen-1");
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByTestId("biosketch-version-gen-1")).toBeNull());
    expect(screen.queryByTestId("biosketch-result")).not.toBeNull();
  });

  it("surfaces a failed delete in the shared error alert and keeps the row", async () => {
    deleteOk = false;
    renderTool();
    const button = await screen.findByTestId("biosketch-version-delete-gen-1");
    fireEvent.click(button);
    fireEvent.click(button);

    const alert = await screen.findByTestId("biosketch-error");
    expect(alert.textContent).toContain("We couldn't delete that draft just now.");
    expect(screen.queryByTestId("biosketch-version-gen-1")).not.toBeNull();
    // Disarmed again — a retry costs two clicks, exactly like the first attempt.
    expect(button.textContent).toContain("Delete");
  });
});
