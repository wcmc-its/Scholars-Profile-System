/**
 * Unit tests for GET /api/topic-rebuild-window (#118 / B19) — the endpoint the
 * profile Topics section polls to decide whether to show the placeholder.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/etl-state", () => ({
  isTopicRebuildWindowOpen: vi.fn(),
}));

import { isTopicRebuildWindowOpen } from "@/lib/etl-state";
import { GET } from "@/app/api/topic-rebuild-window/route";

const windowOpen = isTopicRebuildWindowOpen as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/topic-rebuild-window", () => {
  it("returns { open: true } when the window is open", async () => {
    windowOpen.mockResolvedValueOnce(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ open: true });
  });

  it("returns { open: false } when the window is closed", async () => {
    windowOpen.mockResolvedValueOnce(false);
    const res = await GET();
    expect(await res.json()).toEqual({ open: false });
  });

  it("sets a short shared-cache header", async () => {
    windowOpen.mockResolvedValueOnce(false);
    const res = await GET();
    expect(res.headers.get("cache-control")).toContain("s-maxage=60");
  });
});
