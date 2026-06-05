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

function stubGenerateOk(draft: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, draft }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function stubGenerateError(status: number, error: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
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

  it("POSTs to /api/edit/overview/generate with { entityId }", async () => {
    const f = stubGenerateOk("<p>A drafted overview.</p>");
    render(<OverviewCard cwid={CWID} initialHtml="" generateEnabled />);
    fireEvent.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/overview/generate");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ entityId: CWID });
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
