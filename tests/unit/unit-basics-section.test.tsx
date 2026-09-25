/**
 * UnitBasicsSection — the combined Basics form of the single-scroll unit
 * editor (Edit Center / Edit Org Unit mockups, 2026-09-25): Name, Description,
 * Website, Profile URL (and Center type for a center) in one form with ONE
 * floating save bar.
 *
 *  - the save bar appears only while something is dirty; Discard restores;
 *  - a center POSTs `/api/edit/unit` op:"update" once per CHANGED field only;
 *  - a department / division POSTs `/api/edit/field` op:"set" (a
 *    field_override) for description / url / slug, and keeps "Clear override";
 *  - a directory-owned name renders LOCKED; a manual division's name saves
 *    in-row via `/api/edit/unit`;
 *  - Profile URL / Center type are Superuser-only — read-only (locked) for
 *    anyone else, and never POSTed;
 *  - a per-field failure keeps that field dirty with its own error while the
 *    successful fields settle.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
// The guard's history/beforeunload plumbing is covered by its own tests.
vi.mock("@/components/edit/unsaved-changes-guard", () => ({
  UnsavedChangesGuard: () => null,
}));

import { UnitBasicsSection } from "@/components/edit/unit-basics-section";

const CENTER = {
  unitType: "center" as const,
  code: "TEST_CENTER",
  name: "Test Center",
  nameEditable: true,
  description: "A test blurb.",
  url: "https://example.org",
  slug: "test-center",
  urlPrefix: "/centers/",
  centerType: "center" as const,
};

const DEPT = {
  unitType: "department" as const,
  code: "N0001",
  name: "Test Department",
  nameEditable: false,
  description: "Dept blurb.",
  url: null,
  slug: "test-department",
  slugOverride: null,
  urlPrefix: "/departments/",
  overriddenFields: ["description"],
};

type Call = [string, RequestInit];

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, fieldName: body.fieldName, value: body.value }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function calls(fetchMock: ReturnType<typeof vi.fn>): Array<{ url: string; body: Record<string, unknown> }> {
  return (fetchMock.mock.calls as unknown as Call[]).map(([url, init]) => ({
    url,
    body: JSON.parse(String(init.body)),
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockClear();
});

describe("UnitBasicsSection — center", () => {
  it("shows no save bar until a field changes; Discard restores the saved values", () => {
    render(<UnitBasicsSection {...CENTER} canEditSuperuserFields={false} />);
    expect(screen.queryByTestId("basics-save-bar")).toBeNull();
    fireEvent.change(screen.getByTestId("basics-name"), { target: { value: "Renamed Center" } });
    expect(screen.getByTestId("basics-save-bar").textContent).toContain("Unsaved changes to Basics");
    fireEvent.click(screen.getByTestId("basics-discard"));
    expect(screen.queryByTestId("basics-save-bar")).toBeNull();
    expect((screen.getByTestId("basics-name") as HTMLInputElement).value).toBe("Test Center");
  });

  it("Save POSTs one in-row update per changed field, and only those", async () => {
    const fetchMock = okFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<UnitBasicsSection {...CENTER} canEditSuperuserFields />);
    fireEvent.change(screen.getByTestId("basics-description"), { target: { value: "New blurb." } });
    fireEvent.change(screen.getByTestId("basics-slug"), { target: { value: "new-slug" } });
    fireEvent.click(screen.getByTestId("basics-save"));
    await waitFor(() => expect(screen.queryByTestId("basics-save-bar")).toBeNull());
    expect(calls(fetchMock)).toEqual([
      {
        url: "/api/edit/unit",
        body: { op: "update", entityType: "center", entityId: "TEST_CENTER", fieldName: "description", value: "New blurb." },
      },
      {
        url: "/api/edit/unit",
        body: { op: "update", entityType: "center", entityId: "TEST_CENTER", fieldName: "slug", value: "new-slug" },
      },
    ]);
    expect(screen.getByTestId("basics-saved")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("a Superuser can change the center type", async () => {
    const fetchMock = okFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<UnitBasicsSection {...CENTER} canEditSuperuserFields />);
    fireEvent.change(screen.getByTestId("basics-center-type"), { target: { value: "institute" } });
    fireEvent.click(screen.getByTestId("basics-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(calls(fetchMock)[0].body).toMatchObject({ fieldName: "centerType", value: "institute" });
  });

  it("a non-Superuser sees Profile URL and Center type locked (read-only)", () => {
    render(<UnitBasicsSection {...CENTER} canEditSuperuserFields={false} />);
    expect(screen.queryByTestId("basics-slug")).toBeNull();
    expect(screen.queryByTestId("basics-center-type")).toBeNull();
    expect(screen.getByTestId("basics-slug-locked").textContent).toBe("/centers/test-center");
    expect(screen.getByTestId("basics-center-type-locked").textContent).toBe("Center");
  });

  it("an invalid slug blocks Save client-side", () => {
    render(<UnitBasicsSection {...CENTER} canEditSuperuserFields />);
    fireEvent.change(screen.getByTestId("basics-slug"), { target: { value: "Bad Slug!" } });
    expect(screen.getByTestId("basics-save").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/lowercase letters/i);
  });

  it("a failed field stays dirty with its own error while the others settle", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.fieldName === "slug") {
        return new Response(JSON.stringify({ ok: false, error: "slug_taken" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, fieldName: body.fieldName, value: body.value }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<UnitBasicsSection {...CENTER} canEditSuperuserFields />);
    fireEvent.change(screen.getByTestId("basics-name"), { target: { value: "Renamed Center" } });
    fireEvent.change(screen.getByTestId("basics-slug"), { target: { value: "taken-slug" } });
    fireEvent.click(screen.getByTestId("basics-save"));
    await waitFor(() => expect(screen.getByTestId("basics-error")).toBeTruthy());
    expect(screen.getByText(/another unit already uses that url/i)).toBeTruthy();
    // Only the slug is still unsaved — the bar stays up for it.
    expect(screen.getByTestId("basics-save-bar")).toBeTruthy();
    fireEvent.click(screen.getByTestId("basics-discard"));
    expect((screen.getByTestId("basics-name") as HTMLInputElement).value).toBe("Renamed Center");
    expect((screen.getByTestId("basics-slug") as HTMLInputElement).value).toBe("test-center");
  });
});

// Edit Org Unit mockup (2026-09-25).
describe("UnitBasicsSection — department / division", () => {
  it("a department's name is LOCKED to the Enterprise Directory", () => {
    render(<UnitBasicsSection {...DEPT} canEditSuperuserFields={false} />);
    expect(screen.queryByTestId("basics-name")).toBeNull();
    expect(screen.getByTestId("basics-name-locked").textContent).toBe("Test Department");
    expect(screen.getByText("From the Enterprise Directory. Change it there.")).toBeTruthy();
    expect(screen.queryByTestId("basics-center-type")).toBeNull();
    expect(screen.queryByTestId("basics-center-type-locked")).toBeNull();
  });

  it("description / website / slug save as field overrides via /api/edit/field", async () => {
    const fetchMock = okFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<UnitBasicsSection {...DEPT} canEditSuperuserFields />);
    fireEvent.change(screen.getByTestId("basics-url"), { target: { value: "https://dept.example.org" } });
    fireEvent.change(screen.getByTestId("basics-slug"), { target: { value: "renamed-dept" } });
    fireEvent.click(screen.getByTestId("basics-save"));
    await waitFor(() => expect(screen.queryByTestId("basics-save-bar")).toBeNull());
    expect(calls(fetchMock)).toEqual([
      {
        url: "/api/edit/field",
        body: { op: "set", entityType: "department", entityId: "N0001", fieldName: "url", value: "https://dept.example.org" },
      },
      {
        url: "/api/edit/field",
        body: { op: "set", entityType: "department", entityId: "N0001", fieldName: "slug", value: "renamed-dept" },
      },
    ]);
    // A slug override is pending the nightly ETL — the confirmation says so.
    expect(screen.getByTestId("basics-saved").textContent).toMatch(/next nightly ETL/i);
  });

  it("an overridden field offers 'Clear override', which POSTs op:clear after confirming", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<UnitBasicsSection {...DEPT} canEditSuperuserFields={false} />);
    // Only the description carries an override in this fixture.
    expect(screen.queryByTestId("basics-clear-url")).toBeNull();
    fireEvent.click(screen.getByTestId("basics-clear-description"));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear override" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(calls(fetchMock)[0]).toEqual({
      url: "/api/edit/field",
      body: { op: "clear", entityType: "department", entityId: "N0001", fieldName: "description" },
    });
    await waitFor(() => expect(screen.queryByTestId("basics-clear-description")).toBeNull());
  });

  it("a manual division's name is editable and saves in-row via /api/edit/unit", async () => {
    const fetchMock = okFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(
      <UnitBasicsSection
        {...DEPT}
        unitType="division"
        code="N0002"
        name="Test Division"
        nameEditable
        urlPrefix="/departments/test-department/divisions/"
        overriddenFields={[]}
        canEditSuperuserFields={false}
      />,
    );
    fireEvent.change(screen.getByTestId("basics-name"), { target: { value: "Renamed Division" } });
    fireEvent.click(screen.getByTestId("basics-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(calls(fetchMock)[0]).toEqual({
      url: "/api/edit/unit",
      body: { op: "update", entityType: "division", entityId: "N0002", fieldName: "name", value: "Renamed Division" },
    });
    expect(screen.getByTestId("basics-slug-locked").textContent).toBe(
      "/departments/test-department/divisions/test-department",
    );
  });
});
