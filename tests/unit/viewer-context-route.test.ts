/**
 * #866 — internal-viewer status probe for GET /api/profile/viewer/context.
 * Returns { internal, basis } ONLY (no cwid / no PII), so the #847 export button
 * can appear for the full internal-viewer audience (an authenticated session OR
 * an on-WCM-network viewer), not just logged-in viewers. Default-safe: an
 * external viewer gets { internal: false }.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/profile/viewer/context/route";
import { resolveViewerContext } from "@/lib/auth/viewer-context";

vi.mock("@/lib/auth/viewer-context", () => ({ resolveViewerContext: vi.fn() }));

function call() {
  return GET(new Request("http://localhost/api/profile/viewer/context") as never);
}

afterEach(() => {
  vi.mocked(resolveViewerContext).mockReset();
});

describe("GET /api/profile/viewer/context", () => {
  it("returns internal:false for an external viewer", async () => {
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: false, basis: null });
    const res = await call();
    const body = await res.json();
    expect(body).toEqual({ internal: false, basis: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns internal:true / session for an authenticated viewer — and NEVER leaks the cwid", async () => {
    vi.mocked(resolveViewerContext).mockResolvedValue({
      internal: true,
      basis: "session",
      cwid: "aog2001",
    });
    const body = await (await call()).json();
    expect(body).toEqual({ internal: true, basis: "session" });
    expect(body.cwid).toBeUndefined();
  });

  it("returns internal:true / network for an on-network (anonymous) viewer", async () => {
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "network" });
    const body = await (await call()).json();
    expect(body).toEqual({ internal: true, basis: "network" });
  });
});
