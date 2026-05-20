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
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
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
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
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

describe("OverviewCard — onDirtyChange propagation", () => {
  it("fires onDirtyChange(true) after the first edit and (false) on successful save", async () => {
    const onDirty = vi.fn();
    stubFetchOk("<p>edited</p>");
    render(<OverviewCard cwid={CWID} initialHtml="<p>seed</p>" onDirtyChange={onDirty} />);
    // Initial render: dirty=false propagates once.
    expect(onDirty).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByTestId("mock-editor"), {
      target: { value: "<p>edited</p>" },
    });
    expect(onDirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId("overview-save"));
    await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
  });
});
