/**
 * `components/edit/unit-slug-card.tsx` — the two unit slug write paths (#540
 * Phase 7 § 5): a center edits the column in-row (/api/edit/unit, "Live now");
 * a dept/div writes a field_override (/api/edit/field, "Pending — next ETL").
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { UnitSlugCard } from "@/components/edit/unit-slug-card";

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
  fireEvent.change(screen.getByTestId("unit-slug-card-input"), { target: { value } });
}

describe("UnitSlugCard — center", () => {
  it("Saves in-row via /api/edit/unit op:update and shows 'Live now'", async () => {
    const fetchMock = stubFetch({ body: { ok: true, fieldName: "slug", value: "new-center" } });
    render(<UnitSlugCard entityType="center" entityId="man-x" liveSlug="old-center" initialOverride={null} />);
    typeInto("new-center");
    fireEvent.click(screen.getByTestId("unit-slug-card-save"));
    await waitFor(() => expect(screen.getByTestId("unit-slug-card-live-success")).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/unit");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ op: "update", entityType: "center", fieldName: "slug", value: "new-center" });
  });

  it("surfaces a slug_taken collision", async () => {
    stubFetch({ status: 400, body: { ok: false, error: "slug_taken" } });
    render(<UnitSlugCard entityType="center" entityId="man-x" liveSlug="old-center" initialOverride={null} />);
    typeInto("taken");
    fireEvent.click(screen.getByTestId("unit-slug-card-save"));
    await waitFor(() => expect(screen.getByTestId("unit-slug-card-collision")).toBeTruthy());
  });

  it("has no Clear button (centers have no override)", () => {
    render(<UnitSlugCard entityType="center" entityId="man-x" liveSlug="old-center" initialOverride={null} />);
    expect(screen.queryByTestId("unit-slug-card-clear")).toBeNull();
  });
});

describe("UnitSlugCard — department", () => {
  it("Saves an override via /api/edit/field op:set and shows the pending-ETL notice", async () => {
    const fetchMock = stubFetch({ body: { ok: true, fieldName: "slug", op: "set", value: "internal-med" } });
    render(<UnitSlugCard entityType="department" entityId="N1280" liveSlug="medicine" initialOverride={null} />);
    typeInto("internal-med");
    fireEvent.click(screen.getByTestId("unit-slug-card-save"));
    await waitFor(() => expect(screen.getByTestId("unit-slug-card-pending-success")).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/field");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ op: "set", entityType: "department", fieldName: "slug", value: "internal-med" });
  });

  it("Clear override POSTs /api/edit/field op:clear when an override exists", async () => {
    const fetchMock = stubFetch({ body: { ok: true, fieldName: "slug", cleared: true } });
    render(<UnitSlugCard entityType="department" entityId="N1280" liveSlug="medicine" initialOverride="internal-med" />);
    fireEvent.click(screen.getByTestId("unit-slug-card-clear"));
    // ConfirmDialog confirm button
    const confirmButtons = screen.getAllByRole("button", { name: "Clear override" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/field");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ op: "clear", fieldName: "slug" });
  });

  it("rejects an invalid slug format client-side (Save stays disabled)", () => {
    render(<UnitSlugCard entityType="department" entityId="N1280" liveSlug="medicine" initialOverride={null} />);
    typeInto("Bad Slug!");
    expect(screen.getByTestId("unit-slug-card-format-error")).toBeTruthy();
    expect(screen.getByTestId("unit-slug-card-save").hasAttribute("disabled")).toBe(true);
  });
});
