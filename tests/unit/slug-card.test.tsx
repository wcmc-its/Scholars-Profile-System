/**
 * `components/edit/slug-card.tsx` — the superuser slug-override card
 * (#356 Phase 7 C5, UI-SPEC § /edit/scholar/[cwid] Card 3).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { SlugCard } from "@/components/edit/slug-card";

const CWID = "sch5";

beforeEach(() => {
  vi.restoreAllMocks();
  mockRefresh.mockReset();
});

function stubFetch(opts: { status?: number; body: object }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(opts.body), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function typeInto(value: string) {
  const input = screen.getByTestId("slug-card-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("SlugCard — live format validation", () => {
  it("Save is disabled while pristine (no override + empty input)", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    expect(screen.getByTestId("slug-card-save").hasAttribute("disabled")).toBe(true);
    // No format error rendered for an empty input — empty is the pristine state.
    expect(screen.queryByTestId("slug-card-format-error")).toBeNull();
  });

  it("renders an inline format error for an uppercase / space-laden value, disabling Save", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    typeInto("Foo Bar");
    expect(screen.getByTestId("slug-card-format-error").textContent).toMatch(
      /lowercase letters, numbers, and hyphens/i,
    );
    expect(screen.getByTestId("slug-card-save").hasAttribute("disabled")).toBe(true);
  });

  it("clears the format error when the input becomes valid", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    typeInto("Foo Bar");
    expect(screen.getByTestId("slug-card-format-error")).toBeTruthy();
    typeInto("foo-bar");
    expect(screen.queryByTestId("slug-card-format-error")).toBeNull();
    expect(screen.getByTestId("slug-card-save").hasAttribute("disabled")).toBe(false);
  });

  it("rejects a reserved segment live", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    typeInto("by-cwid");
    expect(screen.getByTestId("slug-card-format-error").textContent).toMatch(/reserved/i);
    expect(screen.getByTestId("slug-card-save").hasAttribute("disabled")).toBe(true);
  });

  it("rejects an over-length slug (> 64 chars)", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    typeInto("a".repeat(65));
    expect(screen.getByTestId("slug-card-format-error").textContent).toMatch(/64/);
    expect(screen.getByTestId("slug-card-save").hasAttribute("disabled")).toBe(true);
  });
});

describe("SlugCard — Save flow", () => {
  it("POSTs the validated value to /api/edit/field, persists override, shows the success Alert", async () => {
    const f = stubFetch({
      body: { ok: true, fieldName: "slug", value: "new-handle" },
    });
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    typeInto("new-handle");
    fireEvent.click(screen.getByTestId("slug-card-save"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/field");
    expect(JSON.parse(opts.body as string)).toEqual({
      entityType: "scholar",
      entityId: CWID,
      fieldName: "slug",
      value: "new-handle",
    });
    // Success Alert renders with the new override.
    await waitFor(() => expect(screen.getByTestId("slug-card-set-success")).toBeTruthy());
    // After save, Clear-override is visible (override exists now).
    expect(screen.getByTestId("slug-card-clear")).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("on 400 collision: shows 'That URL is already in use.' and keeps the input value", async () => {
    stubFetch({ status: 400, body: { ok: false, error: "collision" } });
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    typeInto("taken");
    fireEvent.click(screen.getByTestId("slug-card-save"));
    await waitFor(() => expect(screen.getByTestId("slug-card-collision")).toBeTruthy());
    expect(
      (screen.getByTestId("slug-card-input") as HTMLInputElement).value,
    ).toBe("taken");
  });

  it("on a 5xx / network failure: shows the generic error and re-enables Save", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    typeInto("foo-bar");
    fireEvent.click(screen.getByTestId("slug-card-save"));
    await waitFor(() => expect(screen.getByTestId("slug-card-unknown-error")).toBeTruthy());
    expect(screen.getByTestId("slug-card-save").hasAttribute("disabled")).toBe(false);
  });

  it("editing after an error clears the inline error", async () => {
    stubFetch({ status: 400, body: { ok: false, error: "collision" } });
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    typeInto("taken");
    fireEvent.click(screen.getByTestId("slug-card-save"));
    await waitFor(() => expect(screen.getByTestId("slug-card-collision")).toBeTruthy());
    typeInto("untaken");
    expect(screen.queryByTestId("slug-card-collision")).toBeNull();
  });
});

describe("SlugCard — Clear override", () => {
  it("Clear-override button is only rendered when an override exists", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    expect(screen.queryByTestId("slug-card-clear")).toBeNull();
  });

  it("Clear-override opens the confirm dialog with Cancel focused", async () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride="custom-handle" />);
    fireEvent.click(screen.getByTestId("slug-card-clear"));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(cancel).toBeTruthy();
    expect(document.activeElement).toBe(cancel);
  });

  it("Confirm in the dialog POSTs /api/edit/clear-field; shows the cleared-success Alert", async () => {
    const f = stubFetch({ body: { ok: true, fieldName: "slug", cleared: true } });
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride="custom-handle" />);
    fireEvent.click(screen.getByTestId("slug-card-clear"));
    fireEvent.click(await screen.findByRole("button", { name: "Clear override" }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/clear-field");
    expect(JSON.parse(opts.body as string)).toEqual({
      entityType: "scholar",
      entityId: CWID,
      fieldName: "slug",
    });
    await waitFor(() => expect(screen.getByTestId("slug-card-cleared-success")).toBeTruthy());
    // Clear-override button gone (no override now).
    expect(screen.queryByTestId("slug-card-clear")).toBeNull();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("Clear-override failure surfaces the generic error and keeps the override", async () => {
    stubFetch({ status: 500, body: { ok: false, error: "write_failed" } });
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride="custom-handle" />);
    fireEvent.click(screen.getByTestId("slug-card-clear"));
    fireEvent.click(await screen.findByRole("button", { name: "Clear override" }));
    await waitFor(() => expect(screen.getByTestId("slug-card-unknown-error")).toBeTruthy());
    // Clear-override button still rendered.
    expect(screen.getByTestId("slug-card-clear")).toBeTruthy();
  });
});

describe("SlugCard — panel copy", () => {
  it("notes both the short root form and the /scholars/ form lead to the same page", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    const desc = screen.getByText(/Override the directory-derived URL segment/);
    expect(desc.textContent).toMatch(/scholars\.weill\.cornell\.edu\/<segment>/);
    expect(desc.textContent).toMatch(/\/scholars\/<segment>/);
    expect(desc.textContent).toMatch(/same page/i);
  });
});

describe("SlugCard — initial-override rendering", () => {
  it("displays the override in the URL preview when initialOverride is set", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride="custom" />);
    // Current URL line shows /scholars/custom not /scholars/alex
    const preview = screen.getByText(/Current URL:/).parentElement;
    expect(preview?.textContent).toContain("/scholars/custom");
  });

  it("pre-fills the input with the override value", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride="custom" />);
    expect((screen.getByTestId("slug-card-input") as HTMLInputElement).value).toBe("custom");
  });

  it("displays the live slug in the URL preview when no override exists", () => {
    render(<SlugCard cwid={CWID} liveSlug="alex" initialOverride={null} />);
    const preview = screen.getByText(/Current URL:/).parentElement;
    expect(preview?.textContent).toContain("/scholars/alex");
  });
});
