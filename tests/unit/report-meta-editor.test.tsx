/**
 * `components/edit/report-meta-editor.tsx` — the superuser pencil beside a
 * report page's `<h1>`. `OverviewEditor` (Tiptap) is mocked to a textarea
 * that forwards `onChange`, `next/navigation` to a `refresh` spy. Protects:
 * collapsed = the pencil alone (no form); click → the form prefilled from
 * `meta`; Save PUTs `/api/edit/report-meta/[n]` with `{ name, summary,
 * descriptionHtml }`, then closes and refreshes; a failed save shows the
 * `role="alert"` line mapped from the error code and stays open; Cancel
 * closes without a request; Save is disabled while name or summary is blank.
 * Assertions are scoped to the component's container, never `document.body`.
 */
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/edit/overview-editor", () => ({
  OverviewEditor: ({ initialHtml, onChange }: { initialHtml: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="overview-editor"
      defaultValue={initialHtml}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { ReportMetaEditor } from "@/components/edit/report-meta-editor";

const META = { name: "Publications", summary: "This unit's publications.", descriptionHtml: "<p>About.</p>" };

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(meta: { name: string; summary: string; descriptionHtml: string | null } = META) {
  const { container } = render(<ReportMetaEditor n="3" meta={meta} />);
  return within(container);
}

describe("ReportMetaEditor", () => {
  it("collapsed: only the pencil, labelled, no form", () => {
    const q = setup();
    const pencil = q.getByTestId("report-meta-edit");
    expect(pencil.getAttribute("aria-label")).toBe("Edit report name and description");
    expect(pencil.querySelector("svg")).not.toBeNull();
    expect(q.queryByTestId("report-meta-form")).toBeNull();
    expect(q.queryByTestId("report-meta-name")).toBeNull();
  });

  it("click → the form, prefilled from meta, pencil gone", () => {
    const q = setup();
    fireEvent.click(q.getByTestId("report-meta-edit"));
    expect(q.queryByTestId("report-meta-edit")).toBeNull();
    expect((q.getByTestId("report-meta-name") as HTMLInputElement).value).toBe("Publications");
    expect((q.getByTestId("report-meta-summary") as HTMLTextAreaElement).value).toBe(
      "This unit's publications.",
    );
    expect((q.getByTestId("overview-editor") as HTMLTextAreaElement).value).toBe("<p>About.</p>");
    expect((q.getByTestId("report-meta-name") as HTMLInputElement).maxLength).toBe(120);
    expect((q.getByTestId("report-meta-summary") as HTMLTextAreaElement).maxLength).toBe(500);
  });

  it("a null description opens the editor empty", () => {
    const q = setup({ ...META, descriptionHtml: null });
    fireEvent.click(q.getByTestId("report-meta-edit"));
    expect((q.getByTestId("overview-editor") as HTMLTextAreaElement).value).toBe("");
  });

  it("Save PUTs the right URL and body, then closes and refreshes", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, meta: { key: "3", name: "Papers", summary: "S", descriptionHtml: null } }),
    );
    const q = setup();
    fireEvent.click(q.getByTestId("report-meta-edit"));
    fireEvent.change(q.getByTestId("report-meta-name"), { target: { value: "  Papers " } });
    fireEvent.change(q.getByTestId("report-meta-summary"), { target: { value: "Renamed blurb." } });
    fireEvent.change(q.getByTestId("overview-editor"), { target: { value: "<p>New about.</p>" } });
    fireEvent.click(q.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/report-meta/3");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Papers",
      summary: "Renamed blurb.",
      descriptionHtml: "<p>New about.</p>",
    });
    await waitFor(() => expect(q.queryByTestId("report-meta-form")).toBeNull());
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(q.getByTestId("report-meta-edit")).toBeTruthy();
  });

  it("a failed save shows the alert mapped from the error code and stays open", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { ok: false, error: "invalid_summary", field: "summary" }));
    const q = setup();
    fireEvent.click(q.getByTestId("report-meta-edit"));
    fireEvent.click(q.getByRole("button", { name: "Save" }));
    const alert = await q.findByRole("alert");
    expect(alert.getAttribute("data-testid")).toBe("report-meta-error");
    expect(alert.textContent).toBe("Enter a one-line summary (up to 500 characters).");
    expect(q.getByTestId("report-meta-form")).toBeTruthy();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a 403 reads as the superuser-only line; a network failure as the generic one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { ok: false, error: "not_superuser" }));
    const q = setup();
    fireEvent.click(q.getByTestId("report-meta-edit"));
    fireEvent.click(q.getByRole("button", { name: "Save" }));
    expect((await q.findByRole("alert")).textContent).toBe(
      "Only a superuser can edit report names and descriptions.",
    );

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(q.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(q.getByRole("alert").textContent).toBe("That didn't save. Try again."));
  });

  it("Save is disabled while name or summary is blank", () => {
    const q = setup();
    fireEvent.click(q.getByTestId("report-meta-edit"));
    const save = q.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(q.getByTestId("report-meta-name"), { target: { value: "   " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(q.getByTestId("report-meta-name"), { target: { value: "X" } });
    fireEvent.change(q.getByTestId("report-meta-summary"), { target: { value: "" } });
    expect(save.disabled).toBe(true);
  });

  it("Cancel closes without a request and discards edits", () => {
    const q = setup();
    fireEvent.click(q.getByTestId("report-meta-edit"));
    fireEvent.change(q.getByTestId("report-meta-name"), { target: { value: "Changed" } });
    fireEvent.click(q.getByRole("button", { name: "Cancel" }));
    expect(q.queryByTestId("report-meta-form")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // Re-open: prefilled from `meta` again, not the discarded edit.
    fireEvent.click(q.getByTestId("report-meta-edit"));
    expect((q.getByTestId("report-meta-name") as HTMLInputElement).value).toBe("Publications");
  });
});
