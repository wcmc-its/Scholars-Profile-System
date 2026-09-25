/**
 * `loadLastSlugDecision` (`lib/edit/slug-request.ts`) — the Profile URLs
 * queue's "Last decided …" empty state: the newest `decidedAt`, null when
 * nothing has been decided, and null (not a throw) when the `slug_request`
 * table is absent (dev DB drift).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import { loadLastSlugDecision } from "@/lib/edit/slug-request";

type Client = Parameters<typeof loadLastSlugDecision>[0];
const client = (findFirst: ReturnType<typeof vi.fn>) =>
  ({ slugRequest: { findFirst } }) as unknown as Client;

describe("loadLastSlugDecision", () => {
  it("returns the newest decision time, reading decided rows newest first", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValue({ decidedAt: new Date("2026-06-03T15:00:00.000Z") });
    expect(await loadLastSlugDecision(client(findFirst))).toBe("2026-06-03T15:00:00.000Z");
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: { decidedAt: { not: null } },
      orderBy: { decidedAt: "desc" },
    });
  });

  it("null when nothing has been decided", async () => {
    expect(await loadLastSlugDecision(client(vi.fn().mockResolvedValue(null)))).toBeNull();
  });

  it("null when the table is unavailable", async () => {
    expect(
      await loadLastSlugDecision(client(vi.fn().mockRejectedValue(new Error("no table")))),
    ).toBeNull();
  });
});
