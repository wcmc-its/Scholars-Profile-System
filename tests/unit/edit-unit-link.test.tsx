import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { EditUnitLink } from "@/components/shared/edit-unit-link";

/** Stub fetch: `/api/auth/session` returns `session`, the unit probe returns `unit`. */
function stubProbes(
  session: { authenticated: boolean } | null,
  unit: { canEdit: boolean } | null = null,
) {
  const fetchMock = vi.fn(async (url: string) => {
    const body = url.startsWith("/api/auth/session") ? session : unit;
    return { ok: body !== null, json: () => Promise.resolve(body) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EditUnitLink", () => {
  it("renders 'Edit this department' → /edit/department/<code> when the probe allows", async () => {
    const fetchMock = stubProbes({ authenticated: true }, { canEdit: true });
    render(<EditUnitLink kind="department" code="D100" />);

    const link = (await screen.findByTestId("edit-unit-link")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/edit/department/D100");
    expect(link.textContent).toBe("Edit this department");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/edit/can-edit-unit?kind=department&code=D100",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("names the division and center, and encodes the code", async () => {
    stubProbes({ authenticated: true }, { canEdit: true });
    const { unmount } = render(<EditUnitLink kind="division" code="a b/c" />);
    const div = (await screen.findByTestId("edit-unit-link")) as HTMLAnchorElement;
    expect(div.getAttribute("href")).toBe(`/edit/division/${encodeURIComponent("a b/c")}`);
    expect(div.textContent).toBe("Edit this division");
    unmount();

    render(<EditUnitLink kind="center" code="C100" />);
    const ctr = (await screen.findByTestId("edit-unit-link")) as HTMLAnchorElement;
    expect(ctr.getAttribute("href")).toBe("/edit/center/C100");
    expect(ctr.textContent).toBe("Edit this center");
  });

  it("anonymous viewer: no link, and the unit probe is never called", async () => {
    const fetchMock = stubProbes({ authenticated: false });
    render(<EditUnitLink kind="department" code="D100" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/session");
    expect(screen.queryByTestId("edit-unit-link")).toBeNull();
  });

  it("signed in without edit rights: no link", async () => {
    const fetchMock = stubProbes({ authenticated: true }, { canEdit: false });
    render(<EditUnitLink kind="department" code="D100" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("edit-unit-link")).toBeNull();
  });

  it("probe errors leave the link hidden", async () => {
    const fetchMock = stubProbes({ authenticated: true }, null);
    render(<EditUnitLink kind="center" code="C100" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("edit-unit-link")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<EditUnitLink kind="center" code="C100" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("edit-unit-link")).toBeNull();
  });
});
