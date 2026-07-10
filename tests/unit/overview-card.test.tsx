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

  it("Save disables when the editor's value exceeds the 2,500 editorial cap", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    const over = "x".repeat(2_501);
    fireEvent.change(screen.getByTestId("mock-editor"), { target: { value: over } });
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
  });

  it("counter turns destructive over the editorial cap", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    const over = "y".repeat(2_501);
    fireEvent.change(screen.getByTestId("mock-editor"), { target: { value: over } });
    const counter = screen.getByTestId("overview-counter");
    expect(counter.textContent).toBe("2,501/2,500");
    expect(counter.className).toContain("text-destructive");
  });

  it("counter shows the raw number only well under the cap", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    fireEvent.change(screen.getByTestId("mock-editor"), { target: { value: "a".repeat(120) } });
    const counter = screen.getByTestId("overview-counter");
    expect(counter.textContent).toBe("120");
    expect(counter.className).not.toContain("text-destructive");
    expect(counter.className).not.toContain("text-apollo-amber");
  });

  it("counter shows the denominator + amber warning in the 80–100% band", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    fireEvent.change(screen.getByTestId("mock-editor"), { target: { value: "a".repeat(2_100) } });
    const counter = screen.getByTestId("overview-counter");
    expect(counter.textContent).toBe("2,100/2,500");
    expect(counter.className).toContain("text-apollo-amber");
  });

  it("counter counts VISIBLE text, not the HTML markup", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    // 11 visible characters ("hello world"), but 18 characters of HTML.
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>hello world</p>" },
    });
    const counter = screen.getByTestId("overview-counter");
    expect(counter.textContent).toBe("11");
    expect(counter.className).not.toContain("text-destructive");
    expect(counter.className).not.toContain("text-apollo-amber");
  });

  it("editorial cap does NOT trip when HTML length is over 2,500 but visible text is under", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    // 400 visible characters, but 3,200 characters of HTML (well over 2,500).
    const html = "<b>x</b>".repeat(400);
    fireEvent.change(screen.getByTestId("mock-editor"), { target: { value: html } });
    const counter = screen.getByTestId("overview-counter");
    expect(counter.textContent).toBe("400");
    expect(counter.className).not.toContain("text-destructive");
    // Under the visible cap → Save stays enabled even though the HTML is > 2,500.
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(false);
  });

  it("editorial cap trips + Save disables on VISIBLE length over 2,500", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    // 2,501 visible characters (each wrapped in tags → far more HTML).
    const html = "<b>x</b>".repeat(2_501);
    fireEvent.change(screen.getByTestId("mock-editor"), { target: { value: html } });
    const counter = screen.getByTestId("overview-counter");
    expect(counter.textContent).toBe("2,501/2,500");
    expect(counter.className).toContain("text-destructive");
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
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
          "We couldn't save that overview. Try removing unusual formatting and saving again.",
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
  // #986 — the card now keys the read to the edited scholar (`?cwid=...`).
  return url.startsWith("/api/edit/overview/generations") && method === "GET";
}

/** Is this the #742 v3.1 Sources mount GET (source-options)? */
function isSourceOptionsGet(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  // #986 — the card now keys the read to the edited scholar (`?cwid=...`).
  return url.startsWith("/api/edit/overview/source-options") && method === "GET";
}

/** Is this the #742 §2.5 durable-deltas selection endpoint (GET on mount / PUT
 *  on Done)? Routed away from `other()` so it never perturbs generate counters. */
function isSelectionCall(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : input.toString();
  return url.startsWith("/api/edit/overview/selection");
}

const EMPTY_DELTAS = { pinned: {}, excluded: {}, publicationPositions: "led", fundingRoles: "led" };

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
      // The Generator tab also fetches its source-options on mount (v3.1); give it
      // an empty candidate set so tests that don't exercise the picker stay simple.
      if (isSourceOptionsGet(input, init)) {
        return jsonResponse({ ok: true, publications: [], funding: [], tools: [] });
      }
      if (isSelectionCall(input)) {
        return jsonResponse({ ok: true, deltas: EMPTY_DELTAS });
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

/** The first POST call recorded on the routed fetch spy — skips the mount GETs
 *  (generations + source-options) so assertions target the generate/field POST. */
function postCall(f: FetchSpy): [string, RequestInit] {
  const call = f.mock.calls.find((c) => {
    const method = ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    return method === "POST";
  });
  if (!call) throw new Error("no POST call recorded on fetch");
  return call as unknown as [string, RequestInit];
}

/** #875 — the Draft-with-AI block is inline (no tabs). #1246 — it is now
 *  collapsed by default regardless of saved-bio state; tests that drive
 *  generation or query the block body must expand it first. */
function expandBlock() {
  const toggle = screen.queryByTestId("overview-draft-block-toggle");
  if (toggle && toggle.getAttribute("aria-expanded") === "false") {
    fireEvent.click(toggle);
  }
}

describe("OverviewCard — generator affordance", () => {
  it("hides the Draft-with-AI block + Generate entirely when generateEnabled is false", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    expect(screen.queryByTestId("overview-draft-block")).toBeNull();
    expect(screen.queryByTestId("overview-generate")).toBeNull();
  });

  it("shows the fixed 'Generate a draft' button when enabled and the bio is empty", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    expect(screen.getByTestId("overview-generate")).toBeTruthy();
    expect(screen.getByTestId("overview-generate").textContent).toContain("Generate a draft");
  });

  it("shows the same 'Generate a draft' label even when a rich bio exists (no Regenerate)", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>An existing bio.</p>" generateEnabled />);
    expandBlock();
    expect(screen.getByTestId("overview-generate").textContent).toContain("Generate a draft");
    expect(screen.queryByTestId("overview-regenerate")).toBeNull();
  });

  it("POSTs to /api/edit/overview/generate with { entityId, params }", async () => {
    const f = stubGenerateOk("<p>A drafted overview.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
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

  it("on 200 lands the draft in the review card, NOT the editor — Save stays disabled (clobber-safety)", async () => {
    stubGenerateOk("<p>A drafted overview.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    // Pristine empty bio → Save disabled before generating.
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_BANNER)).toBeTruthy());
    // The draft is in the review card; the editor (and Save) is untouched.
    expect(screen.getByTestId("overview-draft-review-card")).toBeTruthy();
    expect(screen.getByTestId("overview-draft-body").innerHTML).toBe("<p>A drafted overview.</p>");
    expect((screen.getByTestId("mock-editor") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
    // The Generate button stays put (no Regenerate flip).
    expect(screen.getByTestId("overview-generate")).toBeTruthy();
  });

  it("Replace overwrites the editor with the draft and enables Save", async () => {
    stubGenerateOk("<p>A drafted overview.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await screen.findByTestId("overview-draft-replace");
    fireEvent.click(screen.getByTestId("overview-draft-replace"));
    await waitFor(() =>
      expect((screen.getByTestId("mock-editor") as HTMLTextAreaElement).value).toBe(
        "<p>A drafted overview.</p>",
      ),
    );
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(false);
    // The review card is dismissed once a choice is made.
    expect(screen.queryByTestId("overview-draft-review-card")).toBeNull();
  });

  it("Insert below appends the draft to the editor's current contents", async () => {
    stubGenerateOk("<p>drafted.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="<p>existing.</p>" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await screen.findByTestId("overview-draft-insert");
    fireEvent.click(screen.getByTestId("overview-draft-insert"));
    await waitFor(() =>
      expect((screen.getByTestId("mock-editor") as HTMLTextAreaElement).value).toBe(
        "<p>existing.</p><p>drafted.</p>",
      ),
    );
  });

  it("Discard clears only the review card; the editor stays pristine", async () => {
    stubGenerateOk("<p>drafted.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await screen.findByTestId("overview-draft-discard");
    fireEvent.click(screen.getByTestId("overview-draft-discard"));
    expect(screen.queryByTestId("overview-draft-review-card")).toBeNull();
    expect((screen.getByTestId("mock-editor") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
  });

  it("re-generating appends a new draft and keeps the prior one (Draft N of M)", async () => {
    let n = 0;
    stubFetchRouted(() => {
      n += 1;
      return jsonResponse({ ok: true, draft: `<p>draft ${n}</p>`, model: "openai/gpt", generationId: `gen-${n}` });
    });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await screen.findByTestId("overview-draft-review-card");
    fireEvent.click(screen.getByTestId("overview-generate"));
    // Two drafts → the pager appears, newest first.
    await waitFor(() => expect(screen.getByText("Draft 1 of 2 · view previous")).toBeTruthy());
    expect(screen.getByTestId("overview-draft-body").innerHTML).toBe("<p>draft 2</p>");
    // Step back to the first draft.
    fireEvent.click(screen.getByTestId("overview-draft-next"));
    expect(screen.getByText("Draft 2 of 2 · view previous")).toBeTruthy();
    expect(screen.getByTestId("overview-draft-body").innerHTML).toBe("<p>draft 1</p>");
  });

  it("never calls window.confirm when re-generating (no clobber prompt)", async () => {
    const confirmSpy = vi.fn(() => true);
    // jsdom has no confirm; install a spy and assert it stays untouched.
    vi.stubGlobal("confirm", confirmSpy);
    stubGenerateOk("<p>drafted.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="<p>edited bio.</p>" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await screen.findByTestId("overview-draft-review-card");
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText("Draft 1 of 2 · view previous")).toBeTruthy());
    expect(confirmSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("on 422 insufficient_facts shows the sparse-data message and leaves the editor unchanged", async () => {
    stubGenerateError(422, "insufficient_facts");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_SPARSE)).toBeTruthy());
    // No review card; editor untouched ⇒ still pristine ⇒ Save disabled.
    expect(screen.queryByTestId("overview-draft-review-card")).toBeNull();
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("overview-generate")).toBeTruthy();
  });

  it("on 429 rate_limited shows the rate-limit message", async () => {
    stubGenerateError(429, "rate_limited");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_RATE_LIMITED)).toBeTruthy());
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
  });

  it("on a 502 shows the inline generation error and leaves the editor unchanged (G8)", async () => {
    stubGenerateError(502, "generation_failed");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_FAILED)).toBeTruthy());
    expect(screen.queryByTestId("overview-draft-review-card")).toBeNull();
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("overview-generate")).toBeTruthy();
  });

  it("on a network failure shows the inline generation error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(screen.getByText(GENERATE_FAILED)).toBeTruthy());
  });

  it("the read-only (superuser) arm never renders a Generate button or block", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" readOnly generateEnabled />);
    expect(screen.queryByTestId("overview-generate")).toBeNull();
    expect(screen.queryByTestId("overview-draft-block")).toBeNull();
  });
});

describe("OverviewCard — generation options (params)", () => {
  it("renders the controls with defaults when generateEnabled", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    // Default voice is third person; the radio reflects the default value.
    expect(screen.getByTestId("overview-voice-third").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("overview-voice-first").getAttribute("aria-checked")).toBe("false");
  });

  it("does NOT render the controls when generateEnabled is false", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    expect(screen.queryByTestId("overview-voice-third")).toBeNull();
  });

  it("after changing voice to First, Generate sends params.voice === 'first'", async () => {
    const f = stubGenerateOk("<p>A drafted overview.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
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
    expandBlock();
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
    expandBlock();
    await waitFor(() =>
      expect(
        f.mock.calls.some(
          (c) => isGenerationsGet(c[0] as RequestInfo | URL, c[1] as RequestInit | undefined),
        ),
      ).toBe(true),
    );
    // The fetched draft surfaces in the in-block "Earlier drafts" affordance.
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
    const note = await screen.findByTestId("overview-provenance-note");
    // #1077 — provenance phrase + the appended "Last updated {date}" clause.
    expect(note.textContent).toContain("Current overview: generated with openai/gpt");
    expect(note.textContent).toContain("Last updated Jun 1, 2026");
  });

  it("imported-bio label when there's a saved overview but no provenance (#1077)", async () => {
    stubFetchRouted(() => jsonResponse({ ok: true }), { provenance: null });
    render(<OverviewCard cwid={CWID} initialHtml="<p>An imported bio.</p>" generateEnabled />);
    const note = await screen.findByTestId("overview-provenance-note");
    expect(note.textContent).toContain("Imported from the previous profile system");
    expect(note.textContent).not.toContain("Last updated");
  });

  it("superuser mode reframes 'written by you' to 'written manually' (#1077 follow-up)", async () => {
    stubFetchRouted(() => jsonResponse({ ok: true }), {
      provenance: { origin: "authored", model: null, updatedAt: "2026-06-01T12:00:00.000Z" },
    });
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" generateEnabled mode="superuser" />);
    const note = await screen.findByTestId("overview-provenance-note");
    expect(note.textContent).toContain("Current overview: written manually");
    expect(note.textContent).toContain("Last updated Jun 1, 2026");
    expect(note.textContent).not.toContain("by you");
  });

  it("viewing a version lands it in the review card (not the editor) with the banner", async () => {
    stubFetchRouted(() => jsonResponse({ ok: true }), { generations: HISTORY });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(await screen.findByTestId("overview-version-load-gen-1"));
    // The draft is proposed in the review card; the editor stays empty.
    expect(await screen.findByTestId("overview-draft-review-card")).toBeTruthy();
    expect(screen.getByTestId("overview-draft-body").innerHTML).toBe("<p>An earlier draft.</p>");
    expect((screen.getByTestId("mock-editor") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText(GENERATE_BANNER)).toBeTruthy();
    // Editor untouched ⇒ Save still disabled until a choice is made.
    expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(true);
  });

  it("Save sends sourceGenerationId after generate → Replace", async () => {
    const f = stubGenerateOk("<p>A drafted overview.</p>", "gen-new");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await screen.findByTestId("overview-draft-replace");
    fireEvent.click(screen.getByTestId("overview-draft-replace"));
    await waitFor(() =>
      expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() => {
      const fieldCall = f.mock.calls.find((c) => c[0] === "/api/edit/field");
      expect(fieldCall).toBeTruthy();
    });
    // Let the post-save updates (onSaved → refreshGenerations) settle in act()
    // so the trailing setState doesn't land after the test returns.
    await screen.findByText(/Saved — live/);
    const fieldCall = f.mock.calls.find((c) => c[0] === "/api/edit/field") as [string, RequestInit];
    const body = JSON.parse(fieldCall[1].body as string) as { sourceGenerationId: string | null };
    expect(body.sourceGenerationId).toBe("gen-new");
  });

  it("Save sends sourceGenerationId after load version → Replace", async () => {
    const f = stubFetchRouted(
      () => jsonResponse({ ok: true, fieldName: "overview", value: "<p>An earlier draft.</p>" }),
      { generations: HISTORY },
    );
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(await screen.findByTestId("overview-version-load-gen-1"));
    fireEvent.click(await screen.findByTestId("overview-draft-replace"));
    await waitFor(() =>
      expect(screen.getByTestId("overview-save").hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() => {
      const fieldCall = f.mock.calls.find((c) => c[0] === "/api/edit/field");
      expect(fieldCall).toBeTruthy();
    });
    // Let the post-save updates (onSaved → refreshGenerations) settle in act()
    // so the trailing setState doesn't land after the test returns.
    await screen.findByText(/Saved — live/);
    const fieldCall = f.mock.calls.find((c) => c[0] === "/api/edit/field") as [string, RequestInit];
    const body = JSON.parse(fieldCall[1].body as string) as { sourceGenerationId: string | null };
    expect(body.sourceGenerationId).toBe("gen-1");
  });

  it("hand-editing an accepted draft un-links provenance (saves as authored)", async () => {
    const f = stubGenerateOk("<p>A drafted overview.</p>", "gen-new");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    fireEvent.click(screen.getByTestId("overview-generate"));
    await screen.findByTestId("overview-draft-replace");
    fireEvent.click(screen.getByTestId("overview-draft-replace"));
    // Now hand-edit the editor — the generation link must drop to null.
    fireEvent.change(screen.getByTestId("mock-editor"), { target: { value: "<p>my own words</p>" } });
    fireEvent.click(screen.getByTestId("overview-save"));
    await screen.findByText(/Saved — live/);
    const fieldCall = f.mock.calls.find((c) => c[0] === "/api/edit/field") as [string, RequestInit];
    const body = JSON.parse(fieldCall[1].body as string) as { sourceGenerationId: string | null };
    expect(body.sourceGenerationId).toBeNull();
  });

  it("Use these settings copies the version's params into the controls", async () => {
    stubFetchRouted(() => jsonResponse({ ok: true }), {
      generations: [
        { ...HISTORY[0], params: { ...HISTORY[0].params, voice: "first" } },
      ],
    });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    // Default voice is third; applying the version (voice: first) flips the radio.
    expect(screen.getByTestId("overview-voice-third").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(await screen.findByTestId("overview-version-use-settings-gen-1"));
    await waitFor(() =>
      expect(screen.getByTestId("overview-voice-first").getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("Use these settings restores the source selection, clamped to the current pool (#765)", async () => {
    // Source pool: 3 pubs + 2 awards, all default-selected → default selection
    // is everything. The saved draft was generated from a NARROWER selection
    // (pmid 1 + award g1), and also references a stale pmid (999) that no longer
    // exists in the pool. Restoring must narrow the selection AND drop the stale id.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/edit/overview/source-options")) {
        return jsonResponse({
          ok: true,
          publications: [1, 2, 3].map((n) => ({
            pmid: String(n),
            title: `p${n}`,
            venue: null,
            year: null,
            impact: null,
            isFirstOrLast: true,
            authorPosition: "first",
            defaultSelected: true,
            featured: true,
          })),
          funding: [1, 2].map((n) => ({
            id: `g${n}`,
            role: "PI",
            funder: "NIH",
            title: `award ${n}`,
            award: null,
            endYear: 2027,
            defaultSelected: true,
          })),
          tools: [],
        });
      }
      if (url.startsWith("/api/edit/overview/generations")) {
        return generationsResponse(
          [
            {
              id: "gen-1",
              model: "openai/gpt",
              params: {
                voice: "third",
                tone: "formal",
                length: "standard",
                elements: ["research_focus"],
                instructions: "",
                // v3.1 persists the source selection inside params. "999" is stale.
                selection: { pmids: ["1", "999"], grantIds: ["g1"], toolNames: [] },
              },
              createdAt: "2026-06-01T12:00:00.000Z",
              text: "<p>An earlier draft.</p>",
            },
          ],
          null,
        );
      }
      return jsonResponse({ ok: true });
    });

    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    // Default selection (all default-selected) → 3 publications + 2 awards.
    expect(
      await screen.findByText(
        "No overview yet. Generate a draft from your 3 publications and 2 awards above, or start writing here.",
      ),
    ).toBeTruthy();

    fireEvent.click(await screen.findByTestId("overview-version-use-settings-gen-1"));

    // Restored = saved selection minus the stale pmid 999 and the un-saved
    // award g2 → 1 publication + 1 award.
    await waitFor(() =>
      expect(
        screen.getByText(
          "No overview yet. Generate a draft from your 1 publication and 1 award above, or start writing here.",
        ),
      ).toBeTruthy(),
    );
  });
});

// ---------------------------------------------------------------------------
// #875 — the Draft-with-AI collapsible block (default-open/collapsed, summary)
// ---------------------------------------------------------------------------

describe("OverviewCard — Draft-with-AI block", () => {
  it("is collapsed by default even when there is no saved bio (#1246)", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expect(screen.getByTestId("overview-draft-block-toggle").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.queryByTestId("overview-draft-block-body")).toBeNull();
  });

  it("is collapsed by default when a saved hand-written bio exists, showing a settings summary", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>An existing bio.</p>" generateEnabled />);
    expect(screen.getByTestId("overview-draft-block-toggle").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.queryByTestId("overview-draft-block-body")).toBeNull();
    // The collapsed summary is the compact form: voice/tone/length + emphasis COUNT.
    const summary = screen.getByTestId("overview-draft-block-summary").textContent ?? "";
    expect(summary).toContain("Third person");
    expect(summary).toContain("emphases");
  });

  it("toggling expands/collapses the block", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" generateEnabled />);
    fireEvent.click(screen.getByTestId("overview-draft-block-toggle"));
    expect(screen.getByTestId("overview-draft-block-body")).toBeTruthy();
    fireEvent.click(screen.getByTestId("overview-draft-block-toggle"));
    expect(screen.queryByTestId("overview-draft-block-body")).toBeNull();
  });

  it("renders the Generate button BELOW the settings + sources (button last)", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    const body = screen.getByTestId("overview-draft-block-body");
    const voice = screen.getByTestId("overview-voice-third");
    const sources = screen.getByTestId("overview-sources-trigger");
    const generate = screen.getByTestId("overview-generate");
    // DOM order: voice (settings) < sources < generate.
    expect(body.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      voice.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      sources.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// #875 §4.4 — the editor empty-state on-ramp (live selected counts)
// ---------------------------------------------------------------------------

describe("OverviewCard — editor empty-state", () => {
  it("quotes the live selected counts once source-options resolve", async () => {
    stubFetchRouted(() => jsonResponse({ ok: true }), {});
    // Override source-options with a populated default selection.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/edit/overview/source-options")) {
          return jsonResponse({
            ok: true,
            publications: [
              {
                pmid: "1",
                title: "p1",
                venue: null,
                year: null,
                impact: null,
                isFirstOrLast: true,
                authorPosition: "first",
                defaultSelected: true,
                featured: true,
              },
              {
                pmid: "2",
                title: "p2",
                venue: null,
                year: null,
                impact: null,
                isFirstOrLast: true,
                authorPosition: "last",
                defaultSelected: true,
                featured: true,
              },
            ],
            funding: [
              {
                id: "g1",
                role: "PI",
                funder: "NIH",
                title: "x",
                award: null,
                endYear: 2027,
                defaultSelected: true,
              },
            ],
            tools: [],
          });
        }
        if (url.startsWith("/api/edit/overview/generations")) return generationsResponse([], null);
        return jsonResponse({ ok: true });
      },
    );
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expect(
      await screen.findByText(
        "No overview yet. Generate a draft from your 2 publications and 1 award above, or start writing here.",
      ),
    ).toBeTruthy();
  });

  it("shows count-less fallback copy while source-options are still loading (no 0/0 flash)", () => {
    // No fetch stub installed → source-options never resolves synchronously.
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expect(
      screen.getByText("No overview yet. Generate a draft from your work above, or start writing here."),
    ).toBeTruthy();
    // Never flashes a "0 publications and 0 awards".
    expect(screen.queryByText(/0 publications and 0 awards/)).toBeNull();
  });

  it("shows count-less fallback on the manual (no-flag) surface", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" />);
    expect(
      screen.getByText("No overview yet. Generate a draft from your work above, or start writing here."),
    ).toBeTruthy();
  });

  it("hides the empty-state once the editor has content", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>hi</p>" />);
    expect(screen.queryByText(/No overview yet\./)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #875 §6 — pre-generation conditional hints (client-side, before Generate)
// ---------------------------------------------------------------------------

describe("OverviewCard — conditional hints", () => {
  /** Stub source-options with N awards default-selected so the conflict + sparse
   *  predicates can be exercised pre-generation. */
  function stubSourceOptions(opts: {
    pubs: number;
    awardsSelected: boolean;
  }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/edit/overview/source-options")) {
          return jsonResponse({
            ok: true,
            publications: Array.from({ length: opts.pubs }, (_, i) => ({
              pmid: `p${i}`,
              title: `p${i}`,
              venue: null,
              year: null,
              impact: null,
              isFirstOrLast: true,
              authorPosition: "first",
              defaultSelected: true,
              featured: true,
            })),
            funding: [
              {
                id: "g1",
                role: "PI",
                funder: "NIH",
                title: "x",
                award: null,
                endYear: 2027,
                defaultSelected: opts.awardsSelected,
              },
            ],
            tools: [],
          });
        }
        if (url.startsWith("/api/edit/overview/generations")) return generationsResponse([], null);
        return jsonResponse({ ok: true });
      },
    );
  }

  it("fires the emphasis-conflict hint when awards are selected but Grants & funding is off", async () => {
    stubSourceOptions({ pubs: 3, awardsSelected: true });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    const hint = await screen.findByTestId("overview-hint-emphasis-conflict");
    expect(hint.textContent).toContain(
      "awards are selected as sources but won't be mentioned directly — turn on Grants & funding to include them in the overview.",
    );
  });

  it("hides the conflict hint once Grants & funding is toggled on", async () => {
    stubSourceOptions({ pubs: 3, awardsSelected: true });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    await screen.findByTestId("overview-hint-emphasis-conflict");
    fireEvent.click(screen.getByTestId("overview-element-grants_funding"));
    await waitFor(() =>
      expect(screen.queryByTestId("overview-hint-emphasis-conflict")).toBeNull(),
    );
  });

  it("fires the sparse-sources hint when <=1 publication and 0 awards are selected", async () => {
    stubSourceOptions({ pubs: 1, awardsSelected: false });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    const hint = await screen.findByTestId("overview-hint-sparse-sources");
    expect(hint.textContent).toContain("Limited sources may produce a generic draft.");
    // Distinct from the post-422 server message.
    expect(hint.textContent).not.toContain("indexed to draft");
  });

  it("does NOT fire the sparse hint with multiple publications", async () => {
    stubSourceOptions({ pubs: 5, awardsSelected: false });
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    expandBlock();
    await screen.findByTestId("overview-generate");
    expect(screen.queryByTestId("overview-hint-sparse-sources")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readOnly arm — retained defensive render. #844 removed its only live caller
// (the superuser surface now mounts the editable manual editor), but the prop
// and component stay for any genuinely-read-only future caller, so its render
// stays covered.
// ---------------------------------------------------------------------------

describe("OverviewCard — readOnly arm", () => {
  it("renders the bio as sanitized HTML in a prose container", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>Hi I am Alex.</p>" readOnly />);
    const readonly = document.querySelector('[data-slot="overview-readonly"]');
    expect(readonly).not.toBeNull();
    expect((readonly as HTMLElement).innerHTML).toBe("<p>Hi I am Alex.</p>");
    expect((readonly as HTMLElement).className).toContain("prose");
  });

  it("renders 'No overview yet.' when initialHtml is empty", () => {
    render(<OverviewCard cwid={CWID} initialHtml="" readOnly />);
    const empty = document.querySelector('[data-slot="overview-readonly-empty"]');
    expect(empty).not.toBeNull();
    expect((empty as HTMLElement).textContent).toBe("No overview yet.");
  });

  it("renders a neutral read-only description (no longer claims only the owner can edit — #844)", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" readOnly />);
    expect(screen.getByText("This overview is shown read-only here.")).toBeTruthy();
    // The pre-#844 copy is gone — a superuser CAN now edit any bio.
    expect(screen.queryByText("Only the profile owner can edit the bio.")).toBeNull();
  });

  it("does NOT mount the editor, toolbar, Save button, or counter in readOnly mode", () => {
    render(<OverviewCard cwid={CWID} initialHtml="<p>x</p>" readOnly />);
    expect(screen.queryByTestId("mock-editor")).toBeNull();
    expect(screen.queryByTestId("overview-save")).toBeNull();
    expect(screen.queryByTestId("overview-counter")).toBeNull();
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
