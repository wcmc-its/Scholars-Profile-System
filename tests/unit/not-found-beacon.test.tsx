/**
 * NotFoundBeacon — the client-side 404 telemetry that replaced the
 * `await headers()` read in the not-found files (which forced every route
 * dynamic). Also covers the root-404 VIVO copy, now decided client-side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";
import { NotFoundBeacon, notFoundPattern } from "@/components/site/not-found-beacon";
import { RootNotFoundBody } from "@/components/site/root-not-found-body";

async function readBeacon(call: unknown[]): Promise<Record<string, unknown>> {
  expect(call[0]).toBe("/api/analytics");
  const blob = call[1] as Blob;
  // jsdom's Blob has no .text(); read it the old way.
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsText(blob);
  });
  return JSON.parse(text) as Record<string, unknown>;
}

describe("NotFoundBeacon", () => {
  let sendBeacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("sends exactly one not_found beacon with the path (no query/hash) + pattern on mount", async () => {
    window.history.replaceState(null, "", "/display/cwid-abc123?utm=x#frag");
    const { container } = render(<NotFoundBeacon variant="root" />);
    expect(container.innerHTML).toBe(""); // renders nothing
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = await readBeacon(sendBeacon.mock.calls[0]);
    expect(body).toEqual({
      event: "not_found",
      variant: "root",
      path: "/display/cwid-abc123",
      pattern: "vivo",
    });
  });

  it("public variant classifies a bare slug as a profile miss", async () => {
    window.history.replaceState(null, "", "/jane-doe");
    render(<NotFoundBeacon variant="public" />);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = await readBeacon(sendBeacon.mock.calls[0]);
    expect(body).toMatchObject({ variant: "public", path: "/jane-doe", pattern: "profile" });
  });
});

describe("notFoundPattern (same rules the server-side not-found files used)", () => {
  it("root: vivo for /display/cwid-…, else other", () => {
    expect(notFoundPattern("root", "/display/cwid-abc123")).toBe("vivo");
    expect(notFoundPattern("root", "/nope/deeper")).toBe("other");
    expect(notFoundPattern("root", "/jane-doe")).toBe("other");
  });

  it("public: /scholars/* or a single segment → profile, else other", () => {
    expect(notFoundPattern("public", "/scholars/jane-doe")).toBe("profile");
    expect(notFoundPattern("public", "/jane-doe")).toBe("profile");
    expect(notFoundPattern("public", "/topics/foo")).toBe("other");
    expect(notFoundPattern("public", "/")).toBe("other");
  });
});

describe("RootNotFoundBody VIVO copy", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows the moved-profile copy and focuses search for a VIVO path", () => {
    window.history.replaceState(null, "", "/display/cwid-abc123");
    const { container } = render(<RootNotFoundBody />);
    const c = within(container);
    expect(c.getByRole("heading", { level: 1 }).textContent).toBe("This profile may have moved");
    expect(document.activeElement).toBe(c.getByRole("searchbox"));
  });

  it("shows the generic copy for other paths", () => {
    window.history.replaceState(null, "", "/nope/deeper");
    const { container } = render(<RootNotFoundBody />);
    expect(within(container).getByRole("heading", { level: 1 }).textContent).toBe("Page not found");
  });
});
