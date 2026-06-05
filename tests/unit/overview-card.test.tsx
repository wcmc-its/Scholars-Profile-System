/**
 * `components/edit/overview-card.tsx` — Save button, dirty/over-limit/saving
 * disabled states, server response handling, error rendering (#356 Phase 6 C5).
 *
 * The OverviewEditor is mocked with a plain <textarea> so we can drive its
 * onChange directly; the real Tiptap integration is covered by
 * overview-editor.test.tsx.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The card mounts UnsavedChangesGuard, which now calls useRouter() (the guard
// routes confirmed navigations via router.push). Stub next/navigation so the
// guard mounts under jsdom.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

// Mock the editor BEFORE importing the card.
vi.mock("@/components/edit/overview-editor", () => ({
  OverviewEditor: ({
    initialHtml,
    onChange,
  }: {
    initialHtml: string;
    onChange: (html: string) => void;
  }) => (
    <textarea
      data-testid="mock-editor"
      defaultValue={initialHtml}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { OverviewCard } from "@/components/edit/overview-card";

const CWID = "self01";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubFetchOk(value: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, fieldName: "overview", value }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function stubFetchError(status: number, error: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("OverviewCard — Save disabled states", () => {
  it("Save is disabled while pristine (currentHtml === initialHtml)", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>seed</p>" />);
    const save = screen.getByTestId("overview-save");
    expect(save.hasAttribute("disabled")).toBe(true);
  });

  it("Save enables when the editor emits a different value", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>seed</p>" />);
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(false);
  });

  it("Save disables when the editor's value exceeds 20,000 characters", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    const over = "x".repeat(20_001);
    fireEvent.change(screen.getByTestId("mock-editor"), { target: { value: over } });
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
  });

  it("counter turns destructive at the over-limit threshold", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    const over = "y".repeat(20_001);
    fireEvent.change(screen.getByTestId("mock-editor"), { target: { value: over } });
    const counter = screen.getByText("20,001/20,000");
    expect(counter.className).toContain("text-destructive");
  });
});

describe("OverviewCard — successful save", () => {
  it("POSTs to /api/edit/field with the editor's current value", async () => {
    const f = stubFetchOk("<p>edited</p>");
    render(<OverviewCard cwid={CWID} initialHtml="<p>seed</p>" />);
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/field");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({
      entityType: "scholar",
      entityId: CWID,
      fieldName: "overview",
      value: "<p>edited</p>",
      // #742 — no draft was loaded, so the link is null (saves as authored).
      sourceGenerationId: null,
    });
  });

  it("on success, renders 'Saved' and re-disables Save (back to pristine)", async () => {
    stubFetchOk("<p>edited</p>");
    render(<OverviewCard cwid={CWID} initialHtml="<p>seed</p>" />);
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() => expect(screen.getByText(/Saved — live/)).toBeTruthy());
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
  });

  it("updates savedHtml from the server's response.value (sanitize-time normalization)", async () => {
    // Server returns a normalized value different from what we sent — the dirty
    // baseline must track the server's value, otherwise re-editing back to the
    // server's value would falsely show as dirty.
    stubFetchOk("<p>normalized</p>");
    render(<OverviewCard cwid={CWID} initialHtml="<p>seed</p>" />);
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() => expect(screen.getByText(/Saved — live/)).toBeTruthy());
    // Now if the editor emits the server-normalized value, the card should be pristine again.
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>normalized</p>" },
    });
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
  });
});

describe("OverviewCard — error handling", () => {
  it("on a 400 with an unknown error code, renders the generic destructive Alert", async () => {
    stubFetchError(400, "invalid_value");
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() =>
      expect(
        screen.getByText(
          "We couldn't save that bio. Try removing unusual formatting and saving again.",
        ),
      ).toBeTruthy(),
    );
  });

  it("on a network failure, renders the fallback message and re-enables Save", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Something went wrong — your changes weren't saved. Please try again.",
        ),
      ).toBeTruthy(),
    );
    // The editor content is preserved (still dirty vs. the original saved value),
    // so Save re-enables.
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(false);
  });

  it("editing after a failure clears the inline error", async () => {
    stubFetchError(500, "write_failed");
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Something went wrong — your changes weren't saved. Please try again.",
        ),
      ).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited again</p>" },
    });
    expect(
      screen.queryByText(
        "Something went wrong — your changes weren't saved. Please try again.",
      ),
    ).toBeNull();
  });
});

describe("OverviewCard — Discard", () => {
  it("Discard appears once dirty and reverts to the saved value (pristine again)", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>seed</p>" />);
    expect(screen.queryByTestId("overview-discard")).toBeNull();
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    expect(screen.getByTestId("overview-discard")).toBeTruthy();
    fireEvent.click(screen.getByTestId("overview-discard"));
    // currentHtml is back to the saved baseline → Save re-disables, Discard hides.
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("overview-discard")).toBeNull();
  });
});

describe("OverviewCard — live preview link", () => {
  it("renders a same-tab 'View it' link in the success confirmation when previewHref is set", async () => {
    stubFetchOk("<p>edited</p>");
    render(
      <OverviewCard cwid={CWID} initialHtml="<p>seed</p>" previewHref="/scholars/jane-doe" />,
    );
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    fireEvent.click(screen.getByTestId("overview-save"));
    const link = await screen.findByRole("link", { name: /view it/i });
    expect(link.getAttribute("href")).toBe("/scholars/jane-doe");
  });
});

// ---------------------------------------------------------------------------
// #742 — the overview-statement generator affordance (SELF arm, behind a flag)
// ---------------------------------------------------------------------------

const GENERATE_BANNER =
  "Draft generated from your Scholars data. Review and edit it before saving — nothing is published until you save.";
const GENERATE_SPARSE =
  "We don't have enough of your work indexed to draft an overview yet. You can write your own, or review My Publications first.";
const GENERATE_RATE_LIMITED =
  "You've generated several drafts recently — please try again in a little while.";
const GENERATE_FAILED = "We couldn't generate a draft just now. Please try again.";

/** A JSON Response with the given body + status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The GET /api/edit/overview/generations payload (`generateEnabled` mounts a
 *  fetch). Tests that don't care about history get an empty list + no provenance;
 *  pass `generations`/`provenance` to drive the Versions panel + provenance line. */
function generationsResponse(
  generations: Array<{
    id: string;
    model: string;
    params: unknown;
    createdAt: string;
    text: string;
  }> = [],
  provenance: { origin: string; model: string | null; updatedAt: string } | null = null,
) {
  return jsonResponse({ generations, provenance });
}

/** Is this a GET to the generations history endpoint? */
function isGenerationsGet(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  return url === "/api/edit/overview/generations" && method === "GET";
}

/**
 * Mock fetch that routes the mount GET (generations) to a history payload and
 * any other call (the generate POST or the field POST) to `other`. Returns the
 * spy so callers can inspect the POST call.
 */
function stubFetchRouted(
  other: () => Response,
  history: {
    generations?: Array<{
      id: string;
      model: string;
      params: unknown;
      createdAt: string;
      text: string;
    }>;
    provenance?: { origin: string; model: string | null; updatedAt: string } | null;
  } = {},
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isGenerationsGet(input, init)) {
        return generationsResponse(history.generations ?? [], history.provenance ?? null);
      }
      return other();
    });
}

function stubGenerateOk(
  draft: string,
  generationId: string | null = "gen-new",
  history: Parameters<typeof stubFetchRouted>[1] = {},
) {
  return stubFetchRouted(() => jsonResponse({ ok: true, draft, model: "openai/gpt", generationId }), history);
}

function stubGenerateError(status: number, error: string) {
  return stubFetchRouted(() => jsonResponse({ ok: false, error }, status));
}

/** A fetch spy, narrowed to the only surface these helpers touch (`mock.calls`).
 *  Avoids the overloaded `vi.spyOn` return type that won't unify across signatures. */
type FetchSpy = { mock: { calls: unknown[][] } };

/** The first non-history (POST) call recorded on the routed fetch spy — skips the
 *  mount GET so assertions target the generate/field POST regardless of order. */
function postCall(f: FetchSpy): [string, RequestInit] {
  const call = f.mock.calls.find((c) => {
    const url = typeof c[0] === "string" ? c[0] : String(c[0]);
    const method = ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    return !(url === "/api/edit/overview/generations" && method === "GET");
  });
  if (!call) throw new Error("no POST call recorded on fetch");
  return call as unknown as [string, RequestInit];
}

describe("OverviewCard — generator affordance", () => {
  it("hides Generate/Regenerate entirely when generateEnabled is false", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    expect(screen.queryByTestId("overview-generate")).toBeNull();
    expect(screen.queryByTestId("overview-regenerate")).toBeNull();
  });

  it("shows Generate (not Regenerate) when enabled and the bio is empty", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expect(screen.getByTestId("overview-generate")).toBeTruthy();
    expect(screen.queryByTestId("overview-regenerate")).toBeNull();
  });

  it("shows only Regenerate (G9) when the scholar already has a rich bio", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>An existing bio.</p>" generateEnabled />);
    expect(screen.queryByTestId("overview-generate")).toBeNull();
    expect(screen.getByTestId("overview-regenerate")).toBeTruthy();
  });

  it("POSTs to /api/edit/overview/generate with { entityId, params }", async () => {
    const f = stubGenerateOk("<p>A drafted overview.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_BANNER)).toBeTruthy());
    const [url, opts] = postCall(f);
    expect(url).toBe("/api/edit/overview/generate");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string) as {
      entityId: string;
      params: { voice: string };
    };
    expect(body.entityId).toBe(CWID);
    // The default params ride along unless the scholar changed them.
    expect(body.params.voice).toBe("third");
  });

  it("on 200 injects the draft, marks the card dirty (Save enabled), and shows the banner", async () => {
    stubGenerateOk("<p>A drafted overview.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    // Pristine empty bio → Save disabled before generating.
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_BANNER)).toBeTruthy());
    // The draft differs from the empty saved value ⇒ dirty ⇒ Save enabled.
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(false);
    // Generate flips to Regenerate after a draft is seeded.
    expect(screen.getByTestId("overview-regenerate")).toBeTruthy();
    expect(screen.queryByTestId("overview-generate")).toBeNull();
  });

  it("on 422 insufficient_facts shows the sparse-data message and leaves the editor unchanged", async () => {
    stubGenerateError(422, "insufficient_facts");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_SPARSE)).toBeTruthy());
    // Editor untouched ⇒ still pristine ⇒ Save disabled, Generate still shown.
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("overview-generate")).toBeTruthy();
  });

  it("on 429 rate_limited shows the rate-limit message", async () => {
    stubGenerateError(429, "rate_limited");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_RATE_LIMITED)).toBeTruthy());
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
  });

  it("on a 502 shows the inline generation error and leaves the editor unchanged (G8)", async () => {
    stubGenerateError(502, "generation_failed");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_FAILED)).toBeTruthy());
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("overview-generate")).toBeTruthy();
  });

  it("on a network failure shows the inline generation error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_FAILED)).toBeTruthy());
  });

  it("the read-only (superuser) arm never renders a Generate button", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" readOnly generateEnabled />);
    expect(screen.queryByTestId("overview-generate")).toBeNull();
    expect(screen.queryByTestId("overview-regenerate")).toBeNull();
  });
});

describe("OverviewCard — generation options (params)", () => {
  it("renders the controls with defaults when generateEnabled", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expect(screen.getByTestId("overview-generate-options")).toBeTruthy();
    // Default voice is third person; the radio reflects the default value.
    expect(screen.getByTestId("overview-voice-third").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("overview-voice-first").getAttribute("aria-checked")).toBe("false");
  });

  it("does NOT render the controls when generateEnabled is false", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    expect(screen.queryByTestId("overview-generate-options")).toBeNull();
  });

  it("after changing voice to First, Generate sends params.voice === 'first'", async () => {
    const f = stubGenerateOk("<p>A drafted overview.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(screen.getByTestId("overview-voice-first"));
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_BANNER)).toBeTruthy());
    const [, opts] = postCall(f);
    const body = JSON.parse(opts.body as string) as { params: { voice: string } };
    expect(body.params.voice).toBe("first");
  });

  it("typing instructions is reflected in the sent params", async () => {
    const f = stubGenerateOk("<p>A drafted overview.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.change(screen.getByTestId("overview-instructions"), {
      target: { value: "keep it accessible" },
    });
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_BANNER)).toBeTruthy());
    const [, opts] = postCall(f);
    const body = JSON.parse(opts.body as string) as { params: { instructions: string } };
    expect(body.params.instructions).toBe("keep it accessible");
  });
});

// ---------------------------------------------------------------------------
// #742 Phase B — version history + provenance (the Versions panel, the
// provenance line, and the sourceGenerationId carried by Save)
// ---------------------------------------------------------------------------

describe("OverviewCard — version history (Phase B)", () => {
  const HISTORY = [
    {
      id: "gen-1",
      model: "openai/gpt",
      params: {
        voice: "third",
        tone: "formal",
        length: "standard",
        elements: ["research_focus"],
        instructions: "",
      },
      createdAt: "2026-06-01T12:00:00.000Z",
      text: "<p>An earlier draft.</p>",
    },
  ];

  it("fetches GET /api/edit/overview/generations on mount when generateEnabled", async () => {
    const f = stubFetchRouted(() => jsonResponse({ ok: true }), { generations: HISTORY });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    await waitFor(() =>
      expect(
        f.mock.calls.some(
          (c) => isGenerationsGet(c[0] as RequestInfo | URL, c[1] as RequestInit | undefined),
        ),
      ).toBe(true),
    );
    // The fetched draft surfaces in the Versions panel.
    expect(await screen.findByTestId("overview-versions-panel")).toBeTruthy();
    expect(screen.getByTestId("overview-version-load-gen-1")).toBeTruthy();
  });

  it("does NOT fetch generations when generateEnabled is false", () => {
    const f = stubFetchRouted(() => jsonResponse({ ok: true }));
    render(<OverviewCard cwid={CWID} initialHtml="<p>seed</p>" />);
    expect(
      f.mock.calls.some((c) =>
        isGenerationsGet(c[0] as RequestInfo | URL, c[1] as RequestInit | undefined),
      ),
    ).toBe(false);
  });

  it("renders the provenance line from the mount fetch", async () => {
    stubFetchRouted(() => jsonResponse({ ok: true }), {
      provenance: { origin: "generated", model: "openai/gpt", updatedAt: "2026-06-01T12:00:00.000Z" },
    });
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" generateEnabled />);
    expect(await screen.findByTestId("overview-provenance-note")).toBeTruthy();
    expect(screen.getByText("Current bio: generated with openai/gpt.")).toBeTruthy();
  });

  it("loading a version seeds the editor and shows the review banner", async () => {
    stubFetchRouted(() => jsonResponse({ ok: true }), { generations: HISTORY });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(await screen.findByTestId("overview-version-load-gen-1"));
    // The mock editor re-seeds with the loaded draft's text (defaultValue).
    await waitFor(() =>
      expect((screen.getByTestId("mock-editor") as HTMLTextAreaElement).value).toBe(
        "<p>An earlier draft.</p>",
      ),
    );
    expect(screen.getByText(GENERATE_BANNER)).toBeTruthy();
    // The loaded draft differs from the empty saved value ⇒ dirty ⇒ Save enabled.
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(false);
  });

  it("Save sends sourceGenerationId from the just-generated draft", async () => {
    const f = stubGenerateOk("<p>A drafted overview.</p>", "gen-new");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_BANNER)).toBeTruthy());
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() => {
      const fieldCall = f.mock.calls.find((c) => c[0] === "/api/edit/field");
      expect(fieldCall).toBeTruthy();
    });
    const fieldCall = f.mock.calls.find((c) => c[0] === "/api/edit/field") as [string, RequestInit];
    const body = JSON.parse(fieldCall[1].body as string) as { sourceGenerationId: string | null };
    expect(body.sourceGenerationId).toBe("gen-new");
  });

  it("Save sends sourceGenerationId from a loaded version", async () => {
    const f = stubFetchRouted(
      () => jsonResponse({ ok: true, fieldName: "overview", value: "<p>An earlier draft.</p>" }),
      { generations: HISTORY },
    );
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(await screen.findByTestId("overview-version-load-gen-1"));
    await waitFor(() =>
      expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() => {
      const fieldCall = f.mock.calls.find((c) => c[0] === "/api/edit/field");
      expect(fieldCall).toBeTruthy();
    });
    const fieldCall = f.mock.calls.find((c) => c[0] === "/api/edit/field") as [string, RequestInit];
    const body = JSON.parse(fieldCall[1].body as string) as { sourceGenerationId: string | null };
    expect(body.sourceGenerationId).toBe("gen-1");
  });

  it("Use these settings copies the version's params into the controls", async () => {
    stubFetchRouted(() => jsonResponse({ ok: true }), {
      generations: [
        { ...HISTORY[0], params: { ...HISTORY[0].params, voice: "first" } },
      ],
    });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    // Default voice is third; applying the version (voice: first) flips the radio.
    expect(screen.getByTestId("overview-voice-third").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(await screen.findByTestId("overview-version-use-settings-gen-1"));
    await waitFor(() =>
      expect(screen.getByTestId("overview-voice-first").getAttribute("aria-checked")).toBe("true"),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — readOnly arm (the superuser surface render of another scholar's bio)
// ---------------------------------------------------------------------------

describe("OverviewCard — readOnly arm (Phase 7)", () => {
  it("renders the bio as sanitized HTML in a prose container", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>Hi I am Alex.</p>" readOnly />);
    const readonly = document.querySelector('[data-slot="overview-readonly"]');
    expect(readonly).not.toBeNull();
    expect((readonly as HTMLElement).innerHTML).toBe("<p>Hi I am Alex.</p>");
    expect((readonly as HTMLElement).className).toContain("prose");
  });

  it("renders 'No bio yet.' when initialHtml is empty", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" readOnly />);
    const empty = document.querySelector('[data-slot="overview-readonly-empty"]');
    expect(empty).not.toBeNull();
    expect((empty as HTMLElement).textContent).toBe("No bio yet.");
  });

  it("renders the read-only CardDescription explaining why the bio is uneditable", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" readOnly />);
    expect(screen.getByText("Only the profile owner can edit the bio.")).toBeTruthy();
  });

  it("does NOT mount the editor, toolbar, Save button, or counter in readOnly mode", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" readOnly />);
    expect(screen.queryByTestId("mock-editor")).toBeNull();
    expect(screen.queryByTestId("overview-save")).toBeNull();
    expect(screen.queryByText(/\/20,000$/)).toBeNull();
  });

  it("treats a whitespace-only initialHtml as empty (renders the placeholder)", () => {
    render(<OverviewCard cwid={CWID} initialHtml={"   \n\t  "} readOnly />);
    const container = document.querySelectorAll('[data-slot="overview-card"]');
    const lastCard = container[container.length - 1] as HTMLElement;
    expect(lastCard.querySelector('[data-slot="overview-readonly-empty"]')).not.toBeNull();
    expect(lastCard.querySelector('[data-slot="overview-readonly"]')).toBeNull();
  });

  it("readOnly=false renders the Phase 6 editor surface unchanged", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" readOnly={false} />);
    expect(screen.getByTestId("mock-editor")).toBeTruthy();
    expect(screen.getByTestId("overview-save")).toBeTruthy();
  });
});
