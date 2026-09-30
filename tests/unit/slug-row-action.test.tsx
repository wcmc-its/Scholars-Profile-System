/**
 * `components/edit/slug-row-action.tsx` — the Profile URLs registry's row
 * actions: one-click Pin / Unpin through the existing field write / clear-field
 * routes, and Remove behind a confirmation that states the consequence. On
 * success the page refreshes; on failure the error shows under the button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

import { SlugRowAction, slugActionErrorMessage } from "@/components/edit/slug-row-action";

const fetchMock = vi.fn();

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function sentBody(): unknown {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe("SlugRowAction — Pin", () => {
  it("one click pins the current URL via the field write, then refreshes", async () => {
    respond(200, { ok: true, fieldName: "slug", value: "jane-doe" });
    render(<SlugRowAction kind="pin" cwid="sch001" slug="jane-doe" />);
    fireEvent.click(screen.getByTestId("slug-pin-sch001"));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/field");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(sentBody()).toEqual({
      entityType: "scholar",
      entityId: "sch001",
      fieldName: "slug",
      value: "jane-doe",
    });
    // No confirmation step for a pin.
    expect(screen.queryByRole("dialog")).toBeNull();
    // Disabled after success so a second click can't re-send before the refresh lands.
    expect((screen.getByTestId("slug-pin-sch001") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the error under the button and does not refresh on failure", async () => {
    respond(400, { ok: false, error: "collision", field: "value" });
    render(<SlugRowAction kind="pin" cwid="sch001" slug="jane-doe" />);
    fireEvent.click(screen.getByTestId("slug-pin-sch001"));
    const err = await screen.findByTestId("slug-action-error-sch001");
    expect(err.textContent).toBe("/jane-doe is held by another scholar, so it can’t be pinned here.");
    expect(err.getAttribute("role")).toBe("alert");
    expect(mockRefresh).not.toHaveBeenCalled();
    // Still clickable for a retry.
    expect((screen.getByTestId("slug-pin-sch001") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("SlugRowAction — Unpin", () => {
  it("one click clears the slug override, then refreshes", async () => {
    respond(200, { ok: true, fieldName: "slug", cleared: true });
    render(<SlugRowAction kind="unpin" cwid="sch002" slug="dr-doe" />);
    fireEvent.click(screen.getByTestId("slug-unpin-sch002"));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/clear-field");
    expect(sentBody()).toEqual({ entityType: "scholar", entityId: "sch002", fieldName: "slug" });
  });

  it("a 403 reads as a permissions message", async () => {
    respond(403, { ok: false, error: "not_superuser" });
    render(<SlugRowAction kind="unpin" cwid="sch002" slug="dr-doe" />);
    fireEvent.click(screen.getByTestId("slug-unpin-sch002"));
    expect((await screen.findByTestId("slug-action-error-sch002")).textContent).toBe(
      "Only superusers can change profile URLs.",
    );
  });

  it("a network failure reads as a retryable error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<SlugRowAction kind="unpin" cwid="sch002" slug="dr-doe" />);
    fireEvent.click(screen.getByTestId("slug-unpin-sch002"));
    expect((await screen.findByTestId("slug-action-error-sch002")).textContent).toBe(
      "Couldn’t unpin /dr-doe. Try again.",
    );
  });
});

describe("SlugRowAction — Remove", () => {
  it("asks first, stating the consequence; Cancel sends nothing", async () => {
    render(<SlugRowAction kind="remove" slug="j-doe" />);
    fireEvent.click(screen.getByTestId("slug-remove-j-doe"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Remove the redirect from /j-doe?");
    expect(dialog.textContent).toContain("Old links to /j-doe will stop working.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirming removes the redirect, closes the dialog and refreshes", async () => {
    respond(200, { ok: true, oldSlug: "j-doe", removed: true });
    render(<SlugRowAction kind="remove" slug="j-doe" />);
    fireEvent.click(screen.getByTestId("slug-remove-j-doe"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove redirect" }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/slug-redirect");
    expect(sentBody()).toEqual({ oldSlug: "j-doe" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a 404 says the redirect is already gone, in the row", async () => {
    respond(404, { ok: false, error: "not_found", field: "oldSlug" });
    render(<SlugRowAction kind="remove" slug="j-doe" />);
    fireEvent.click(screen.getByTestId("slug-remove-j-doe"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove redirect" }));
    expect((await screen.findByTestId("slug-action-error-j-doe")).textContent).toBe(
      "/j-doe no longer redirects. Refresh to see the current list.",
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("slugActionErrorMessage", () => {
  it("maps a bodiless 401 to a sign-in prompt", () => {
    expect(slugActionErrorMessage("pin", "x", 401, undefined)).toBe(
      "Your session has expired. Sign in again.",
    );
  });
  it("falls back to a generic retry line", () => {
    expect(slugActionErrorMessage("remove", "x", 500, "write_failed")).toBe(
      "Couldn’t remove /x. Try again.",
    );
  });
});
