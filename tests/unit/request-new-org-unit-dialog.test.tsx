/**
 * components/edit/request-new-org-unit-dialog.tsx — the thin "Request a new org
 * unit" client (#728 Phase D § 4.6 / § 4.6.1). Verifies it POSTs the existing
 * `/api/edit/request-change` endpoint with `attribute: "org-unit"`, the proposed
 * unit in `itemId` + the justification in `detail`, and — crucially — OMITS
 * `targetCwid`; the server-success confirmation; and the Phase-1 `mailto:`
 * fallback when the mailer is dark (non-2xx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { RequestNewOrgUnitDialog } from "@/components/edit/request-new-org-unit-dialog";

function open() {
  fireEvent.click(screen.getByTestId("request-new-org-unit-trigger"));
}

function mockFetch(response: { ok: boolean; status?: number }) {
  const fn = vi.fn().mockResolvedValue({ ok: response.ok, status: response.status ?? 200 });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// jsdom can't navigate; replace `window.location` so the mailto fallback's
// `window.location.href = …` is observable, not an error.
let originalLocation: Location;
beforeEach(() => {
  originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "" },
  });
});
afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
});

describe("RequestNewOrgUnitDialog", () => {
  it("opens a named dialog from its trigger", () => {
    render(<RequestNewOrgUnitDialog />);
    expect(screen.getByTestId("request-new-org-unit-trigger")).toBeTruthy();
    open();
    expect(screen.getByRole("dialog", { name: /request a new org unit/i })).toBeTruthy();
  });

  it("disables submit until a unit name is entered", () => {
    render(<RequestNewOrgUnitDialog />);
    open();
    expect(screen.getByTestId("rnou-submit").hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("rnou-name"), { target: { value: "Division of Foo" } });
    expect(screen.getByTestId("rnou-submit").hasAttribute("disabled")).toBe(false);
  });

  it("POSTs org-unit with the proposed unit, OMITS targetCwid, then confirms 'Request sent.'", async () => {
    const fetchMock = mockFetch({ ok: true });
    render(<RequestNewOrgUnitDialog />);
    open();
    fireEvent.change(screen.getByTestId("rnou-name"), {
      target: { value: "Division of Foo" },
    });
    fireEvent.change(screen.getByTestId("rnou-type"), { target: { value: "division" } });
    fireEvent.change(screen.getByTestId("rnou-parent"), { target: { value: "MED" } });
    fireEvent.change(screen.getByTestId("rnou-detail"), {
      target: { value: "Needed for the new program." },
    });
    fireEvent.click(screen.getByTestId("rnou-submit"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/request-change");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      attribute: "org-unit",
      issueId: "request-new-org-unit",
      itemId: "Division of Foo (division, parent: MED)",
      detail: "Needed for the new program.",
    });
    expect("targetCwid" in body).toBe(false);

    expect(await screen.findByText("Request sent.")).toBeTruthy();
  });

  it("falls back to a mailto: on a non-2xx (mailer dark) — support@ + structured body", async () => {
    mockFetch({ ok: false, status: 503 });
    render(<RequestNewOrgUnitDialog />);
    open();
    fireEvent.change(screen.getByTestId("rnou-name"), { target: { value: "Center of Bar" } });
    fireEvent.click(screen.getByTestId("rnou-submit"));

    await screen.findByText(/here's what happens next/i);
    expect(window.location.href).toContain("mailto:support@med.cornell.edu");
    expect(decodeURIComponent(window.location.href)).toContain("Center of Bar (center)");
    expect(decodeURIComponent(window.location.href)).toContain(
      "Scholars profile correction — Org Unit",
    );
  });

  it("strips CR/LF from the justification before the mailto (injection guard)", async () => {
    mockFetch({ ok: false, status: 503 });
    render(<RequestNewOrgUnitDialog />);
    open();
    fireEvent.change(screen.getByTestId("rnou-name"), { target: { value: "Center of Bar" } });
    // The detail box is a <textarea>, which preserves newlines — the real
    // injection surface. `sanitize` must collapse CR/LF to a single space.
    fireEvent.change(screen.getByTestId("rnou-detail"), {
      target: { value: "line1\r\nBcc: evil@example.com" },
    });
    fireEvent.click(screen.getByTestId("rnou-submit"));
    await screen.findByText(/here's what happens next/i);
    const decoded = decodeURIComponent(window.location.href);
    expect(decoded).not.toContain("\r");
    expect(decoded).toContain("line1 Bcc: evil@example.com");
  });
});
