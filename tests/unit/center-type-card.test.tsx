/**
 * `components/edit/center-type-card.tsx` — the Superuser center/institute toggle
 * (#540 Phase 7 § 6). Saves via /api/edit/unit op:update fieldName:centerType.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { CenterTypeCard } from "@/components/edit/center-type-card";

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

describe("CenterTypeCard", () => {
  it("Save is disabled while pristine and enables on change", () => {
    render(<CenterTypeCard entityId="man-x" centerType="center" />);
    expect(screen.getByTestId("center-type-save").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("center-type-institute"));
    expect(screen.getByTestId("center-type-save").hasAttribute("disabled")).toBe(false);
  });

  it("Saves the new type via /api/edit/unit op:update and shows Saved", async () => {
    const fetchMock = stubFetch({ body: { ok: true, fieldName: "centerType", value: "institute" } });
    render(<CenterTypeCard entityId="man-x" centerType="center" />);
    fireEvent.click(screen.getByTestId("center-type-institute"));
    fireEvent.click(screen.getByTestId("center-type-save"));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/unit");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ op: "update", entityType: "center", entityId: "man-x", fieldName: "centerType", value: "institute" });
  });

  it("renders a permission error on 403", async () => {
    stubFetch({ status: 403, body: { ok: false, error: "not_superuser" } });
    render(<CenterTypeCard entityId="man-x" centerType="center" />);
    fireEvent.click(screen.getByTestId("center-type-institute"));
    fireEvent.click(screen.getByTestId("center-type-save"));
    await waitFor(() => expect(screen.getByText(/no longer have access/i)).toBeTruthy());
  });
});
