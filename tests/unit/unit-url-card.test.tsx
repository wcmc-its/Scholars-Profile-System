/**
 * `components/edit/unit-url-card.tsx` — Save/Clear flows, dirty disabled state,
 * error rendering, and the center in-row path (#1021). Mirrors
 * `unit-description-card.test.tsx`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { UnitUrlCard } from "@/components/edit/unit-url-card";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubOk(value: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, value }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function stubErr(status: number, error: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const base = { entityType: "department" as const, entityId: "N1280" };

describe("UnitUrlCard", () => {
  it("Save is disabled while pristine and enables on edit", () => {
    render(<UnitUrlCard {...base} url={null} canClear hasOverride={false} />);
    expect(screen.getByTestId("unit-url-save").hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("unit-url-input"), {
      target: { value: "https://example.org" },
    });
    expect(screen.getByTestId("unit-url-save").hasAttribute("disabled")).toBe(false);
  });

  it("Save POSTs op:set with the url field and shows Saved", async () => {
    const fetchMock = stubOk("https://medicine.weill.cornell.edu");
    render(<UnitUrlCard {...base} url={null} canClear hasOverride={false} />);
    fireEvent.change(screen.getByTestId("unit-url-input"), {
      target: { value: "https://medicine.weill.cornell.edu" },
    });
    fireEvent.click(screen.getByTestId("unit-url-save"));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      op: "set",
      entityType: "department",
      entityId: "N1280",
      fieldName: "url",
      value: "https://medicine.weill.cornell.edu",
    });
  });

  it("renders an invalid_url error as a friendly message", async () => {
    stubErr(400, "invalid_url");
    render(<UnitUrlCard {...base} url={null} canClear hasOverride={false} />);
    fireEvent.change(screen.getByTestId("unit-url-input"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByTestId("unit-url-save"));
    await waitFor(() => expect(screen.getByText(/valid https/i)).toBeTruthy());
  });

  it("the Clear button appears only with an existing override and POSTs op:clear", async () => {
    const fetchMock = stubOk("");
    render(<UnitUrlCard {...base} url="https://x.org" canClear hasOverride />);
    fireEvent.click(screen.getByTestId("unit-url-clear"));
    // The ConfirmDialog renders its own "Clear override" button; confirm via it.
    const confirmButtons = screen.getAllByRole("button", { name: "Clear override" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => {
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toMatchObject({ op: "clear", fieldName: "url" });
    });
  });

  it("hides the Clear button for a center (canClear=false)", () => {
    render(
      <UnitUrlCard
        entityType="center"
        entityId="man-x"
        url="https://x.org"
        canClear={false}
        hasOverride
      />,
    );
    expect(screen.queryByTestId("unit-url-clear")).toBeNull();
  });

  it("a center Saves in-row via /api/edit/unit op:update", async () => {
    const fetchMock = stubOk("https://meyer.org");
    render(
      <UnitUrlCard
        entityType="center"
        entityId="man-x"
        url={null}
        canClear={false}
        hasOverride={false}
      />,
    );
    fireEvent.change(screen.getByTestId("unit-url-input"), {
      target: { value: "https://meyer.org" },
    });
    fireEvent.click(screen.getByTestId("unit-url-save"));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/unit");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      op: "update",
      entityType: "center",
      entityId: "man-x",
      fieldName: "url",
      value: "https://meyer.org",
    });
  });
});
