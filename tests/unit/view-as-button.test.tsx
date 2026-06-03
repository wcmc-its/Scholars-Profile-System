/**
 * `components/edit/view-as-button.tsx` — the per-row "View as" launch shortcut
 * (#729). Confirm → POST /api/impersonation { targetCwid } → on 204 run
 * `onStarted` (reload in prod). A non-2xx surfaces a friendly error and does NOT
 * start. The button re-uses the gated/audited #637 route; this suite covers the
 * thin client contract only.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViewAsButton } from "@/components/edit/view-as-button";

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Stub POST /api/impersonation with a status + optional error reason. */
function stubImpersonation(opts: { status: number; error?: string }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(opts.error ? JSON.stringify({ ok: false, error: opts.error }) : null, {
      status: opts.status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("ViewAsButton", () => {
  it("confirms, POSTs the target, and runs onStarted on 204", async () => {
    const fetchMock = stubImpersonation({ status: 204 });
    const onStarted = vi.fn();
    render(<ViewAsButton targetCwid="schol001" targetName="Jane Scholar" onStarted={onStarted} />);

    fireEvent.click(screen.getByTestId("view-as-schol001"));
    // Confirm dialog (mirrors the switcher's "logged to you" confirm).
    fireEvent.click(await screen.findByRole("button", { name: "View as Jane Scholar" }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/impersonation"));
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ targetCwid: "schol001" });
  });

  it("shows a friendly error and does NOT start when the target is a superuser (403)", async () => {
    stubImpersonation({ status: 403, error: "target_is_superuser" });
    const onStarted = vi.fn();
    render(<ViewAsButton targetCwid="admin002" targetName="Otto Admin" onStarted={onStarted} />);

    fireEvent.click(screen.getByTestId("view-as-admin002"));
    fireEvent.click(await screen.findByRole("button", { name: "View as Otto Admin" }));

    await waitFor(() => expect(screen.getByTestId("view-as-error-admin002")).toBeTruthy());
    expect(screen.getByTestId("view-as-error-admin002").textContent).toMatch(/superuser/i);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("does not POST until the user confirms", () => {
    const fetchMock = stubImpersonation({ status: 204 });
    render(<ViewAsButton targetCwid="schol001" targetName="Jane Scholar" onStarted={() => {}} />);
    fireEvent.click(screen.getByTestId("view-as-schol001"));
    // Dialog open, but no confirm click yet → no network call.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
