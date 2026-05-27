/**
 * `components/edit/slug-request-row.tsx` — one pending request in the superuser
 * queue (#497 PR-3c, `slug-personalization-ui-spec.md` § 3.3-3.5).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { SlugRequestRow } from "@/components/edit/slug-request-row";
import type { SlugRequestQueueRow } from "@/lib/edit/slug-request";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(opts: { status?: number; body: object }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(opts.body), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function row(over: Partial<SlugRequestQueueRow> = {}): SlugRequestQueueRow {
  return {
    id: "r1",
    cwid: "jqs2001",
    requestedSlug: "jane-smith",
    reason: "This is how I'm known.",
    createdAt: "2026-05-27T12:00:00.000Z",
    currentSlug: "jane-q-smith",
    name: "Jane Q. Smith",
    department: "Medicine",
    warning: null,
    collidesWith: null,
    ...over,
  };
}

describe("SlugRequestRow — anatomy", () => {
  it("renders identity, change line, reason, and meta date", () => {
    render(<SlugRequestRow request={row()} onDecided={vi.fn()} />);
    expect(screen.getByText(/Jane Q\. Smith/)).toBeTruthy();
    expect(screen.getByText(/jqs2001/)).toBeTruthy();
    expect(screen.getByText(/Medicine/)).toBeTruthy();
    const change = screen.getByTestId("slug-request-change-line");
    expect(change.textContent).toContain("jane-q-smith");
    expect(change.textContent).toContain("jane-smith");
    expect(screen.getByTestId("slug-request-reason").textContent).toContain("This is how I'm known.");
    expect(screen.getByTestId("slug-request-meta").textContent).toMatch(/Requested .*2026/);
  });

  it("shows (no note) when the reason is empty", () => {
    render(<SlugRequestRow request={row({ reason: null })} onDecided={vi.fn()} />);
    expect(screen.getByTestId("slug-request-reason").textContent).toContain("(no note)");
  });
});

describe("SlugRequestRow — approve", () => {
  it("a clean row enables Approve; success reports the id up", async () => {
    const onDecided = vi.fn();
    const f = stubFetch({ body: { ok: true, id: "r1", status: "approved", slug: "jane-smith" } });
    render(<SlugRequestRow request={row()} onDecided={onDecided} />);
    const approve = screen.getByTestId("slug-request-approve");
    expect(approve.hasAttribute("disabled")).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith("r1"));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/slug-request/r1/decision");
    expect(JSON.parse(opts.body as string)).toEqual({ decision: "approve" });
  });

  it("on 409 collision: keeps the row, surfaces the warning, disables Approve", async () => {
    const onDecided = vi.fn();
    stubFetch({ status: 409, body: { ok: false, error: "collision" } });
    render(<SlugRequestRow request={row()} onDecided={onDecided} />);
    fireEvent.click(screen.getByTestId("slug-request-approve"));
    await waitFor(() => expect(screen.getByTestId("slug-request-collision-warning")).toBeTruthy());
    expect(onDecided).not.toHaveBeenCalled();
    expect(screen.getByTestId("slug-request-approve").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("slug-request-collision-warning").textContent).toMatch(/taken since/i);
  });

  it("on a generic failure: shows the error and re-enables Approve", async () => {
    stubFetch({ status: 500, body: { ok: false, error: "write_failed" } });
    render(<SlugRequestRow request={row()} onDecided={vi.fn()} />);
    fireEvent.click(screen.getByTestId("slug-request-approve"));
    await waitFor(() => expect(screen.getByTestId("slug-request-error")).toBeTruthy());
    expect(screen.getByTestId("slug-request-approve").hasAttribute("disabled")).toBe(false);
  });
});

describe("SlugRequestRow — warnings disable approve", () => {
  it("collision warning disables Approve and names the holder", () => {
    render(
      <SlugRequestRow request={row({ warning: "collision", collidesWith: "abc9" })} onDecided={vi.fn()} />,
    );
    expect(screen.getByTestId("slug-request-approve").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("slug-request-collision-warning").textContent).toContain("(abc9)");
  });

  it("reserved warning disables Approve", () => {
    render(<SlugRequestRow request={row({ warning: "reserved" })} onDecided={vi.fn()} />);
    expect(screen.getByTestId("slug-request-approve").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("slug-request-reserved-warning").textContent).toMatch(/reserved word/i);
  });
});

describe("SlugRequestRow — decline", () => {
  it("requires a note; sends the rejection with the note and reports the id up", async () => {
    const onDecided = vi.fn();
    const f = stubFetch({ body: { ok: true, id: "r1", status: "rejected" } });
    render(<SlugRequestRow request={row()} onDecided={onDecided} />);
    fireEvent.click(screen.getByTestId("slug-request-decline-open"));
    const send = screen.getByTestId("slug-request-decline-send");
    // Note required — Send disabled until non-empty.
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("slug-request-decline-note"), {
      target: { value: "Too close to another scholar's URL." },
    });
    expect(send.hasAttribute("disabled")).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith("r1"));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/slug-request/r1/decision");
    expect(JSON.parse(opts.body as string)).toEqual({
      decision: "reject",
      note: "Too close to another scholar's URL.",
    });
  });

  it("on a decline failure: shows the error, keeps the row", async () => {
    const onDecided = vi.fn();
    stubFetch({ status: 500, body: { ok: false, error: "write_failed" } });
    render(<SlugRequestRow request={row()} onDecided={onDecided} />);
    fireEvent.click(screen.getByTestId("slug-request-decline-open"));
    fireEvent.change(screen.getByTestId("slug-request-decline-note"), {
      target: { value: "No." },
    });
    fireEvent.click(screen.getByTestId("slug-request-decline-send"));
    await waitFor(() => expect(screen.getByTestId("slug-request-error")).toBeTruthy());
    expect(onDecided).not.toHaveBeenCalled();
  });
});
