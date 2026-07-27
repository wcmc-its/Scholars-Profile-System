/**
 * #1990 — the NIH AI-content warning is rendered in exactly ONE place at a time.
 *
 * #1569 put the warning in two deliberate spots: at the generate action, so the caution is read
 * before any content exists, and at the top of `BiosketchResultCard`, directly above the
 * Copy / Download actions where the text actually leaves the app. They were never meant to be
 * co-visible — but they are adjacent siblings in the generate column, so the instant a draft
 * landed BOTH were on screen and the doubled alert read as boilerplate.
 *
 * The invariant these tests pin is the handoff, in both directions of the only state that drives
 * it (`result`): no draft ⇒ one warning, at the generate action and outside the result card;
 * draft present ⇒ still one warning, and it is the one INSIDE the result card.
 *
 * The model call is stubbed at `readBiosketchStream` — this is a render-gating test, not a
 * generate-flow test, so the fetch only has to get as far as a 200.
 *
 * Native DOM assertions (no jest-dom in `tests/setup.ts`): counts + toBeNull() + `contains`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The generate POST returns an NDJSON stream the component reads through this helper; stub it
// with a finished draft so a click lands a `result` without any streaming machinery in jsdom.
vi.mock("@/lib/edit/biosketch-stream", () => ({
  readBiosketchStream: vi.fn(async () => ({
    ok: true as const,
    mode: "contributions" as const,
    entries: [{ title: "CAR-T resistance", body: "We studied resistance." }],
    model: "us.anthropic.claude-opus-4-8",
    overflow: [],
    removedCount: 0,
    products: null,
    sources: null,
    generationId: "gen-1",
  })),
}));

import { BiosketchTool } from "@/components/edit/biosketch-tool";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Two endpoints are touched on this path: the mount-time history refresh (empty, so no
  // "Earlier …" panel competes for the assertions) and the generate POST (a bare 200 — the
  // stubbed stream reader supplies the payload).
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/edit/biosketch/generations")) {
      return new Response(JSON.stringify({ ok: true, generations: [] }), { status: 200 });
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

describe("BiosketchTool — AI-content warning placement (#1990)", () => {
  it("shows exactly one warning, at the generate action, while there is no draft", async () => {
    renderTool();

    const warnings = await screen.findAllByTestId("biosketch-ai-warning");
    expect(warnings).toHaveLength(1);
    // No result card yet, so the one on screen is necessarily the generate-action placement.
    expect(screen.queryByTestId("biosketch-result")).toBeNull();
  });

  it("hands the warning off to the result card once a draft lands — still exactly one", async () => {
    renderTool();

    fireEvent.click(await screen.findByTestId("biosketch-generate"));

    const card = await screen.findByTestId("biosketch-result");
    await waitFor(() => {
      expect(screen.getAllByTestId("biosketch-ai-warning")).toHaveLength(1);
    });
    // ...and it is the result-card copy — the one above Copy / Download — not the generate one.
    expect(card.contains(screen.getByTestId("biosketch-ai-warning"))).toBe(true);
  });
});
