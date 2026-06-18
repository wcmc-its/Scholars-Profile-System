/**
 * `lib/edit/after-response.ts` — `runAfterResponse` (#955 finding #6). Two
 * branches: in a request scope it hands the task to Next's `after()` and does
 * NOT run it inline; outside one (a direct test/script call) `after()` throws,
 * so it falls back to a detached best-effort run that swallows rejection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockAfter } = vi.hoisted(() => ({ mockAfter: vi.fn() }));
vi.mock("next/server", () => ({ after: mockAfter }));

import { runAfterResponse } from "@/lib/edit/after-response";

afterEach(() => {
  vi.clearAllMocks();
});

describe("runAfterResponse", () => {
  it("schedules the task on after() within a request scope, not inline", () => {
    const task = vi.fn(async () => {});
    runAfterResponse(task);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockAfter).toHaveBeenCalledWith(task);
    // after() owns the invocation — the task must not have run synchronously.
    expect(task).not.toHaveBeenCalled();
  });

  it("falls back to running the task when after() is unavailable (no request scope)", async () => {
    mockAfter.mockImplementation(() => {
      throw new Error("after() was called outside a request scope");
    });
    const task = vi.fn(async () => {});
    runAfterResponse(task);
    expect(task).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // let the detached promise settle
  });

  it("swallows a rejected task in the fallback — no throw, no unhandled rejection", async () => {
    mockAfter.mockImplementation(() => {
      throw new Error("no request scope");
    });
    const task = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(() => runAfterResponse(task)).not.toThrow();
    expect(task).toHaveBeenCalledTimes(1);
    // Two microtask ticks for the rejected promise's internal `.catch` to run.
    await Promise.resolve();
    await Promise.resolve();
  });
});
