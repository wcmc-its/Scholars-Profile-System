/**
 * `components/edit/slug-request-card.tsx` — the scholar-facing "Profile URL"
 * request card (#497 PR-3 surfaces U1+U2, `slug-personalization-ui-spec.md` § 6
 * test matrix).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { SlugRequestCard, type SlugRequestSummary } from "@/components/edit/slug-request-card";

const CWID = "jqs2001";

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
  const input = screen.getByTestId("slug-request-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

function pendingRequest(over: Partial<SlugRequestSummary> = {}): SlugRequestSummary {
  return {
    id: "req-1",
    status: "pending",
    requestedSlug: "jane-smith",
    reason: null,
    decisionNote: null,
    createdAt: "2026-05-27T12:00:00.000Z",
    ...over,
  };
}

describe("SlugRequestCard — Idle / live validation", () => {
  it("enables Request for a valid, non-current slug", () => {
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    typeInto("jane-smith");
    expect(screen.getByTestId("slug-request-submit").hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("slug-request-format-error")).toBeNull();
  });

  it("disables Request and shows an inline error for a format-invalid value", () => {
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    typeInto("Jane Smith");
    expect(screen.getByTestId("slug-request-format-error").textContent).toMatch(
      /lowercase letters, numbers, and hyphens/i,
    );
    expect(screen.getByTestId("slug-request-submit").hasAttribute("disabled")).toBe(true);
  });

  it("disables Request for a reserved word", () => {
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    typeInto("by-cwid");
    expect(screen.getByTestId("slug-request-format-error").textContent).toMatch(/reserved/i);
    expect(screen.getByTestId("slug-request-submit").hasAttribute("disabled")).toBe(true);
  });

  it("disables Request when the value equals the current slug", () => {
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    typeInto("jane");
    expect(screen.queryByTestId("slug-request-format-error")).toBeNull();
    expect(screen.getByTestId("slug-request-submit").hasAttribute("disabled")).toBe(true);
  });

  it("starts Idle with no status tag when there is no prior request", () => {
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    expect(screen.queryByTestId("slug-request-status-tag")).toBeNull();
    expect(screen.getByTestId("slug-request-input")).toBeTruthy();
  });
});

describe("SlugRequestCard — submit flow", () => {
  it("POSTs the normalized slug and transitions to Pending (no input, Withdraw shown)", async () => {
    const f = stubFetch({
      body: { ok: true, id: "req-9", status: "pending", requestedSlug: "jane-smith" },
    });
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    typeInto("jane-smith");
    fireEvent.click(screen.getByTestId("slug-request-submit"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/slug-request");
    expect(JSON.parse(opts.body as string)).toEqual({ requestedSlug: "jane-smith" });
    // → Pending: status tag + pending alert + Withdraw, no input.
    await waitFor(() => expect(screen.getByTestId("slug-request-pending")).toBeTruthy());
    expect(screen.getByTestId("slug-request-status-tag").textContent).toMatch(/pending review/i);
    expect(screen.getByTestId("slug-request-withdraw")).toBeTruthy();
    expect(screen.queryByTestId("slug-request-input")).toBeNull();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("includes the reason when the note disclosure is filled", async () => {
    const f = stubFetch({
      body: { ok: true, id: "req-9", status: "pending", requestedSlug: "jane-smith" },
    });
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    typeInto("jane-smith");
    fireEvent.click(screen.getByTestId("slug-request-reason-toggle"));
    fireEvent.change(screen.getByTestId("slug-request-reason"), {
      target: { value: "This is how I'm known." },
    });
    fireEvent.click(screen.getByTestId("slug-request-submit"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({
      requestedSlug: "jane-smith",
      reason: "This is how I'm known.",
    });
  });

  it("keeps the note disclosure collapsed by default", () => {
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    expect(screen.getByTestId("slug-request-reason-toggle")).toBeTruthy();
    expect(screen.queryByTestId("slug-request-reason")).toBeNull();
  });

  it("on 429 shows the rate-limit copy and stays Idle", async () => {
    stubFetch({ status: 429, body: { ok: false, error: "rate_limited" } });
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    typeInto("jane-smith");
    fireEvent.click(screen.getByTestId("slug-request-submit"));
    await waitFor(() => expect(screen.getByTestId("slug-request-error")).toBeTruthy());
    expect(screen.getByTestId("slug-request-error").textContent).toMatch(
      /several requests recently/i,
    );
    // Still Idle — the input is present and Pending did not render.
    expect(screen.getByTestId("slug-request-input")).toBeTruthy();
    expect(screen.queryByTestId("slug-request-pending")).toBeNull();
  });

  it("on 400 collision shows the inline 'already taken' error", async () => {
    stubFetch({ status: 400, body: { ok: false, error: "collision", field: "requestedSlug" } });
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    typeInto("taken-name");
    fireEvent.click(screen.getByTestId("slug-request-submit"));
    await waitFor(() => expect(screen.getByTestId("slug-request-error")).toBeTruthy());
    expect(screen.getByTestId("slug-request-error").textContent).toMatch(/already taken/i);
    expect((screen.getByTestId("slug-request-input") as HTMLInputElement).value).toBe("taken-name");
  });

  it("clears the inline error on the next edit", async () => {
    stubFetch({ status: 400, body: { ok: false, error: "collision" } });
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={null} />);
    typeInto("taken-name");
    fireEvent.click(screen.getByTestId("slug-request-submit"));
    await waitFor(() => expect(screen.getByTestId("slug-request-error")).toBeTruthy());
    typeInto("other-name");
    expect(screen.queryByTestId("slug-request-error")).toBeNull();
  });
});

describe("SlugRequestCard — Pending", () => {
  it("renders the pending notice + requested slug and no input", () => {
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={pendingRequest()} />);
    expect(screen.getByTestId("slug-request-pending").textContent).toContain(
      "scholars.weill.cornell.edu/jane-smith",
    );
    expect(screen.queryByTestId("slug-request-input")).toBeNull();
    expect(screen.getByTestId("slug-request-status-tag").textContent).toMatch(/pending review/i);
  });

  it("Withdraw POSTs the withdraw endpoint and returns to Idle", async () => {
    const f = stubFetch({ body: { ok: true, id: "req-1", status: "withdrawn" } });
    render(<SlugRequestCard cwid={CWID} currentSlug="jane" latestRequest={pendingRequest()} />);
    fireEvent.click(screen.getByTestId("slug-request-withdraw"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/slug-request/req-1/withdraw");
    // → Idle: input reappears, pending notice gone.
    await waitFor(() => expect(screen.getByTestId("slug-request-input")).toBeTruthy());
    expect(screen.queryByTestId("slug-request-pending")).toBeNull();
    expect(mockRefresh).toHaveBeenCalled();
  });
});

describe("SlugRequestCard — Rejected", () => {
  it("shows the reviewer note and re-enables a re-request prefilled with the rejected value", () => {
    render(
      <SlugRequestCard
        cwid={CWID}
        currentSlug="jane"
        latestRequest={{
          ...pendingRequest(),
          status: "rejected",
          requestedSlug: "jane-old",
          decisionNote: "Too close to another scholar.",
        }}
      />,
    );
    expect(screen.getByTestId("slug-request-rejected").textContent).toContain(
      "Too close to another scholar.",
    );
    expect(screen.getByTestId("slug-request-status-tag").textContent).toMatch(/not approved/i);
    // Re-request input prefilled and enabled (valid, != current).
    expect((screen.getByTestId("slug-request-input") as HTMLInputElement).value).toBe("jane-old");
    expect(screen.getByTestId("slug-request-submit").hasAttribute("disabled")).toBe(false);
  });
});

describe("SlugRequestCard — Just-approved", () => {
  it("shows the approved banner with the new current URL alongside the Idle input", () => {
    render(
      <SlugRequestCard
        cwid={CWID}
        currentSlug="jane-new"
        latestRequest={{ ...pendingRequest(), status: "approved", requestedSlug: "jane-new" }}
      />,
    );
    expect(screen.getByTestId("slug-request-approved").textContent).toContain(
      "scholars.weill.cornell.edu/jane-new",
    );
    expect(screen.getByTestId("slug-request-status-tag").textContent).toMatch(/approved/i);
    expect(screen.getByTestId("slug-request-input")).toBeTruthy();
  });
});

describe("SlugRequestCard — withdrawn/superseded render as Idle", () => {
  it("treats a withdrawn latest request as Idle (no status tag)", () => {
    render(
      <SlugRequestCard
        cwid={CWID}
        currentSlug="jane"
        latestRequest={{ ...pendingRequest(), status: "withdrawn" }}
      />,
    );
    expect(screen.queryByTestId("slug-request-status-tag")).toBeNull();
    expect(screen.getByTestId("slug-request-input")).toBeTruthy();
  });
});

describe("SlugRequestCard — dirty propagation", () => {
  it("fires onDirtyChange(true) once the scholar types in Idle", () => {
    const onDirty = vi.fn();
    render(
      <SlugRequestCard
        cwid={CWID}
        currentSlug="jane"
        latestRequest={null}
        onDirtyChange={onDirty}
      />,
    );
    expect(onDirty).toHaveBeenLastCalledWith(false);
    typeInto("jane-smith");
    expect(onDirty).toHaveBeenLastCalledWith(true);
  });
});
