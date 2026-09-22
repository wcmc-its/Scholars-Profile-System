/**
 * #1990 — the NIH AI-content caution is on screen exactly once at a time, at the weight its
 * moment calls for.
 *
 * Before a draft exists, a one-line amber note (`biosketch-ai-note`) sits at the Generate action
 * and sets the expectation. The full destructive warning (`biosketch-ai-warning`) appears only
 * with a draft, at the top of `BiosketchResultCard`, directly above Copy / Download where the
 * text leaves the app. The setup form (and its note) steps aside while a draft is on screen, so
 * the two are never co-visible.
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

describe("BiosketchTool — AI-content caution placement (#1990)", () => {
  it("shows only the amber note at the generate action while there is no draft", async () => {
    renderTool();

    expect(await screen.findAllByTestId("biosketch-ai-note")).toHaveLength(1);
    expect(screen.queryByTestId("biosketch-ai-warning")).toBeNull();
    expect(screen.queryByTestId("biosketch-result")).toBeNull();
  });

  it("hands off to the destructive warning in the result card once a draft lands", async () => {
    renderTool();

    fireEvent.click(await screen.findByTestId("biosketch-generate"));

    const card = await screen.findByTestId("biosketch-result");
    await waitFor(() => {
      expect(screen.getAllByTestId("biosketch-ai-warning")).toHaveLength(1);
    });
    expect(card.contains(screen.getByTestId("biosketch-ai-warning"))).toBe(true);
    expect(screen.queryByTestId("biosketch-ai-note")).toBeNull();
  });
});

describe("BiosketchTool — mode cards", () => {
  it("one radio group swaps between the two drafts and the publication finder", async () => {
    renderTool();
    const radio = (v: string) =>
      screen.getByTestId(`biosketch-mode-${v}`).querySelector("input") as HTMLInputElement;

    await screen.findByTestId("biosketch-generate");
    expect(radio("contributions").checked).toBe(true);
    expect(screen.queryByTestId("biosketch-project-title")).toBeNull();

    fireEvent.click(radio("personal_statement"));
    expect(radio("personal_statement").checked).toBe(true);
    expect(screen.getByTestId("biosketch-project-title")).not.toBeNull();

    fireEvent.click(radio("suggest"));
    expect(screen.getByTestId("biosketch-statement")).not.toBeNull();
    expect(screen.queryByTestId("biosketch-generate")).toBeNull();

    // Back to a draft mode: the Personal Statement choice was kept.
    fireEvent.click(radio("personal_statement"));
    expect(screen.getByTestId("biosketch-generate").textContent).toContain(
      "Generate personal statement",
    );
  });
});
