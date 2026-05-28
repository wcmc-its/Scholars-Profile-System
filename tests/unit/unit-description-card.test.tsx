/**
 * `components/edit/unit-description-card.tsx` — Save/Clear flows, dirty + limit
 * disabled states, error rendering (#540 Phase 7 § 1).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { UnitDescriptionCard } from "@/components/edit/unit-description-card";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubOk(value: string) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true, value }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

function stubErr(status: number, error: string) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

const base = { entityType: "department" as const, entityId: "N1280" };

describe("UnitDescriptionCard", () => {
  it("Save is disabled while pristine and enables on edit", () => {
    render(<UnitDescriptionCard {...base} description="seed" canClear hasOverride={false} />);
    expect(screen.getByTestId("unit-description-save").hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("unit-description-textarea"), { target: { value: "new" } });
    expect(screen.getByTestId("unit-description-save").hasAttribute("disabled")).toBe(false);
  });

  it("Save POSTs op:set with the field and shows Saved", async () => {
    const fetchMock = stubOk("edited");
    render(<UnitDescriptionCard {...base} description="seed" canClear hasOverride={false} />);
    fireEvent.change(screen.getByTestId("unit-description-textarea"), { target: { value: "edited" } });
    fireEvent.click(screen.getByTestId("unit-description-save"));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ op: "set", entityType: "department", entityId: "N1280", fieldName: "description", value: "edited" });
  });

  it("renders a 403 as a permission message", async () => {
    stubErr(403, "not_curator");
    render(<UnitDescriptionCard {...base} description="seed" canClear hasOverride={false} />);
    fireEvent.change(screen.getByTestId("unit-description-textarea"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("unit-description-save"));
    await waitFor(() => expect(screen.getByText(/no longer have access/i)).toBeTruthy());
  });

  it("the Clear button appears only with an existing override and POSTs op:clear", async () => {
    const fetchMock = stubOk("");
    render(<UnitDescriptionCard {...base} description="seed" canClear hasOverride />);
    fireEvent.click(screen.getByTestId("unit-description-clear"));
    // The ConfirmDialog renders its own "Clear override" button; confirm via it.
    const confirmButtons = screen.getAllByRole("button", { name: "Clear override" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => {
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toMatchObject({ op: "clear", fieldName: "description" });
    });
  });

  it("hides the Clear button for a center (canClear=false)", () => {
    render(
      <UnitDescriptionCard entityType="center" entityId="man-x" description="seed" canClear={false} hasOverride />,
    );
    expect(screen.queryByTestId("unit-description-clear")).toBeNull();
  });

  it("a center Saves in-row via /api/edit/unit op:update", async () => {
    const fetchMock = stubOk("edited");
    render(
      <UnitDescriptionCard entityType="center" entityId="man-x" description="seed" canClear={false} hasOverride={false} />,
    );
    fireEvent.change(screen.getByTestId("unit-description-textarea"), { target: { value: "edited" } });
    fireEvent.click(screen.getByTestId("unit-description-save"));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/unit");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ op: "update", entityType: "center", entityId: "man-x", fieldName: "description", value: "edited" });
  });
});
