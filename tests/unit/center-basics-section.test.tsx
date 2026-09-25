/**
 * CenterBasicsSection — the combined Basics form of the single-scroll center
 * editor (Edit Center mockup, 2026-09-25): Name, Description, Website, Profile
 * URL and Center type in one form with ONE floating save bar.
 *
 *  - the save bar appears only while something is dirty; Discard restores;
 *  - Save POSTs `/api/edit/unit` op:"update" once per CHANGED field only;
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

import { CenterBasicsSection } from "@/components/edit/center-basics-section";

const BASE = {
  code: "TEST_CENTER",
  name: "Test Center",
  description: "A test blurb.",
  url: "https://example.org",
  slug: "test-center",
  centerType: "center" as const,
};

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, fieldName: body.fieldName, value: body.value }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function bodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
}

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockClear();
});

describe("CenterBasicsSection", () => {
  it("shows no save bar until a field changes; Discard restores the saved values", () => {
    render(<CenterBasicsSection {...BASE} canEditSuperuserFields={false} />);
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
    render(<CenterBasicsSection {...BASE} canEditSuperuserFields />);
    fireEvent.change(screen.getByTestId("basics-description"), { target: { value: "New blurb." } });
    fireEvent.change(screen.getByTestId("basics-slug"), { target: { value: "new-slug" } });
    fireEvent.click(screen.getByTestId("basics-save"));
    await waitFor(() => expect(screen.queryByTestId("basics-save-bar")).toBeNull());
    expect(bodies(fetchMock)).toEqual([
      { op: "update", entityType: "center", entityId: "TEST_CENTER", fieldName: "description", value: "New blurb." },
      { op: "update", entityType: "center", entityId: "TEST_CENTER", fieldName: "slug", value: "new-slug" },
    ]);
    expect(screen.getByTestId("basics-saved")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("a Superuser can change the center type", async () => {
    const fetchMock = okFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<CenterBasicsSection {...BASE} canEditSuperuserFields />);
    fireEvent.change(screen.getByTestId("basics-center-type"), { target: { value: "institute" } });
    fireEvent.click(screen.getByTestId("basics-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodies(fetchMock)[0]).toMatchObject({ fieldName: "centerType", value: "institute" });
  });

  it("a non-Superuser sees Profile URL and Center type locked (read-only)", () => {
    render(<CenterBasicsSection {...BASE} canEditSuperuserFields={false} />);
    expect(screen.queryByTestId("basics-slug")).toBeNull();
    expect(screen.queryByTestId("basics-center-type")).toBeNull();
    expect(screen.getByTestId("basics-slug-locked").textContent).toBe("/centers/test-center");
    expect(screen.getByTestId("basics-center-type-locked").textContent).toBe("Center");
  });

  it("an invalid slug blocks Save client-side", () => {
    render(<CenterBasicsSection {...BASE} canEditSuperuserFields />);
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
    render(<CenterBasicsSection {...BASE} canEditSuperuserFields />);
    fireEvent.change(screen.getByTestId("basics-name"), { target: { value: "Renamed Center" } });
    fireEvent.change(screen.getByTestId("basics-slug"), { target: { value: "taken-slug" } });
    fireEvent.click(screen.getByTestId("basics-save"));
    await waitFor(() => expect(screen.getByTestId("basics-error")).toBeTruthy());
    expect(screen.getByText(/another center already uses that url/i)).toBeTruthy();
    // Only the slug is still unsaved — the bar stays up for it.
    expect(screen.getByTestId("basics-save-bar")).toBeTruthy();
    fireEvent.click(screen.getByTestId("basics-discard"));
    expect((screen.getByTestId("basics-name") as HTMLInputElement).value).toBe("Renamed Center");
    expect((screen.getByTestId("basics-slug") as HTMLInputElement).value).toBe("test-center");
  });
});
