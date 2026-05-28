/**
 * `components/edit/unit-create-form.tsx` — the two-mode `/edit/unit/new` form
 * (#540 Phase 7d). Covers the center + division submits, the Superuser mode
 * toggle, the Owner-locked variant, slug format gating, and a collision error.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import { UnitCreateForm } from "@/components/edit/unit-create-form";

const DEPTS = [
  { code: "N1280", name: "Medicine" },
  { code: "N2000", name: "Surgery" },
];

beforeEach(() => {
  vi.restoreAllMocks();
  mockPush.mockReset();
});

function stubFetch(opts: { status?: number; body: object }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(opts.body), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function pickDept(code: string) {
  fireEvent.change(screen.getByTestId("create-dept-input"), { target: { value: code } });
  fireEvent.mouseDown(screen.getByTestId(`create-dept-option-${code}`));
}

const superuserCenter = {
  initialMode: "center" as const,
  canSwitchMode: true,
  isSuperuser: true,
  departments: DEPTS,
  fixedDept: null,
};

describe("UnitCreateForm — Superuser", () => {
  it("creates a center via /api/edit/unit op:create and redirects to its editor", async () => {
    const fetchMock = stubFetch({ body: { ok: true, code: "man-abc123", slug: "precision" } });
    render(<UnitCreateForm {...superuserCenter} />);
    fireEvent.change(screen.getByTestId("create-name"), { target: { value: "Precision Center" } });
    fireEvent.change(screen.getByTestId("create-slug"), { target: { value: "precision" } });
    pickDept("N1280");
    fireEvent.click(screen.getByTestId("create-submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      op: "create",
      unitType: "center",
      name: "Precision Center",
      slug: "precision",
      deptCode: "N1280",
      centerType: "center",
    });
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/edit/center/man-abc123?attr=description"),
    );
  });

  it("toggles to division mode and creates a coded division (code uppercased)", async () => {
    const fetchMock = stubFetch({ body: { ok: true, code: "N9999", slug: "new-div" } });
    render(<UnitCreateForm {...superuserCenter} />);
    fireEvent.click(screen.getByTestId("create-mode-division"));
    fireEvent.change(screen.getByTestId("create-code"), { target: { value: "n9999" } });
    fireEvent.change(screen.getByTestId("create-name"), { target: { value: "New Division" } });
    fireEvent.change(screen.getByTestId("create-slug"), { target: { value: "new-div" } });
    pickDept("N2000");
    fireEvent.click(screen.getByTestId("create-submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      op: "create",
      unitType: "division",
      code: "N9999",
      name: "New Division",
      slug: "new-div",
      deptCode: "N2000",
    });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/edit/division/N9999?attr=description"));
  });

  it("disables submit while the slug format is invalid", () => {
    render(<UnitCreateForm {...superuserCenter} />);
    fireEvent.change(screen.getByTestId("create-name"), { target: { value: "X Center" } });
    fireEvent.change(screen.getByTestId("create-slug"), { target: { value: "Bad Slug!" } });
    pickDept("N1280");
    expect(screen.getByTestId("create-slug-error")).toBeTruthy();
    expect(screen.getByTestId("create-submit").hasAttribute("disabled")).toBe(true);
  });

  it("surfaces a slug collision from the server", async () => {
    stubFetch({ status: 400, body: { ok: false, error: "slug_taken" } });
    render(<UnitCreateForm {...superuserCenter} />);
    fireEvent.change(screen.getByTestId("create-name"), { target: { value: "Dup Center" } });
    fireEvent.change(screen.getByTestId("create-slug"), { target: { value: "taken" } });
    pickDept("N1280");
    fireEvent.click(screen.getByTestId("create-submit"));
    await waitFor(() => expect(screen.getByTestId("create-error").textContent).toMatch(/already in use/i));
  });
});

describe("UnitCreateForm — Owner", () => {
  const ownerProps = {
    initialMode: "center" as const,
    canSwitchMode: false,
    isSuperuser: false,
    departments: [],
    fixedDept: { code: "N1280", name: "Medicine" },
  };

  it("hides the mode toggle, fixes the parent department, and disables institute", () => {
    render(<UnitCreateForm {...ownerProps} />);
    expect(screen.queryByTestId("create-mode-division")).toBeNull();
    expect(screen.getByTestId("create-dept-fixed").textContent).toMatch(/Medicine/);
    expect(screen.queryByTestId("create-dept-input")).toBeNull();
    expect(screen.getByTestId("create-type-institute").hasAttribute("disabled")).toBe(true);
  });

  it("creates a center under the fixed department", async () => {
    const fetchMock = stubFetch({ body: { ok: true, code: "man-xyz", slug: "lab" } });
    render(<UnitCreateForm {...ownerProps} />);
    fireEvent.change(screen.getByTestId("create-name"), { target: { value: "The Lab" } });
    fireEvent.change(screen.getByTestId("create-slug"), { target: { value: "lab" } });
    fireEvent.click(screen.getByTestId("create-submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ unitType: "center", deptCode: "N1280", centerType: "center" });
  });
});
