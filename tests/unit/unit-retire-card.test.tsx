/**
 * `components/edit/unit-retire-card.tsx` — the whole-unit retire flow (#540
 * Phase 7 § 7): type-to-confirm + required reason → /api/edit/suppress; restore
 * → /api/edit/revoke; the 409 chair-appointment guard copy; date-only success
 * (the retiring actor is not shown in the UI).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { UnitRetireCard } from "@/components/edit/unit-retire-card";

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

const base = {
  entityType: "department" as const,
  entityId: "N1280",
  unitName: "Medicine",
  suppression: null,
};

describe("UnitRetireCard — retire", () => {
  it("Confirm stays disabled until the name matches AND a reason is given", () => {
    render(<UnitRetireCard {...base} />);
    fireEvent.click(screen.getByTestId("unit-retire-start"));
    expect(screen.getByTestId("unit-retire-confirm").hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("unit-retire-name-input"), { target: { value: "Medicine" } });
    // name matches but no reason yet
    expect(screen.getByTestId("unit-retire-confirm").hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("unit-retire-reason"), { target: { value: "Merged into another unit" } });
    expect(screen.getByTestId("unit-retire-confirm").hasAttribute("disabled")).toBe(false);
  });

  it("a wrong name keeps Confirm disabled", () => {
    render(<UnitRetireCard {...base} />);
    fireEvent.click(screen.getByTestId("unit-retire-start"));
    fireEvent.change(screen.getByTestId("unit-retire-name-input"), { target: { value: "Medicin" } });
    fireEvent.change(screen.getByTestId("unit-retire-reason"), { target: { value: "x" } });
    expect(screen.getByTestId("unit-retire-confirm").hasAttribute("disabled")).toBe(true);
  });

  it("POSTs /api/edit/suppress and flips to the retired state", async () => {
    const fetchMock = stubFetch({ body: { ok: true, suppressionId: "sup1" } });
    render(<UnitRetireCard {...base} />);
    fireEvent.click(screen.getByTestId("unit-retire-start"));
    fireEvent.change(screen.getByTestId("unit-retire-name-input"), { target: { value: "Medicine" } });
    fireEvent.change(screen.getByTestId("unit-retire-reason"), { target: { value: "Merged" } });
    fireEvent.click(screen.getByTestId("unit-retire-confirm"));
    await waitFor(() => expect(screen.getByTestId("unit-retire-retired-state")).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/suppress");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ entityType: "department", entityId: "N1280", reason: "Merged" });
    // no actor shown
    expect(screen.queryByText(/by /i)).toBeNull();
  });

  it("surfaces the 409 chair-appointment guard with a specific explanation", async () => {
    stubFetch({ status: 409, body: { ok: false, error: "leadership_appointment_not_suppressible" } });
    render(<UnitRetireCard {...base} />);
    fireEvent.click(screen.getByTestId("unit-retire-start"));
    fireEvent.change(screen.getByTestId("unit-retire-name-input"), { target: { value: "Medicine" } });
    fireEvent.change(screen.getByTestId("unit-retire-reason"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("unit-retire-confirm"));
    await waitFor(() => expect(screen.getByText(/active chair appointment/i)).toBeTruthy());
  });
});

describe("UnitRetireCard — restore", () => {
  it("starts in the retired state and Restore POSTs /api/edit/revoke", async () => {
    const fetchMock = stubFetch({ body: { ok: true, suppressionId: "sup1" } });
    render(
      <UnitRetireCard
        {...base}
        suppression={{ id: "sup1", suppressedAt: new Date("2026-05-01") }}
      />,
    );
    expect(screen.getByTestId("unit-retire-retired-state")).toBeTruthy();
    fireEvent.click(screen.getByTestId("unit-retire-restore"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/revoke");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ suppressionId: "sup1" });
    await waitFor(() => expect(screen.getByTestId("unit-retire-start")).toBeTruthy());
  });
});
