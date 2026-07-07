/**
 * `lib/search.ts` — interactive fail-fast timeout on the shared OpenSearch
 * client singleton.
 *
 * The `.search()` wrapper injects `requestTimeout`/`maxRetries` transport
 * options ONLY inside a `runWithOsRoundTripCounter` request scope (the
 * /api/search path). ETL / index-build traffic flows through the SAME
 * singleton with no scope, so it must pass through untouched — a low timeout
 * there would abort legitimate long-running index work. Explicit per-call
 * options must win over the injected defaults.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchSpy } = vi.hoisted(() => ({
  searchSpy: vi.fn(async (...call: unknown[]) => ({ body: {}, argCount: call.length })),
}));

vi.mock("@opensearch-project/opensearch", () => {
  class Client {
    search = searchSpy;
  }
  return { Client };
});

import { searchClient } from "@/lib/search";
import { runWithOsRoundTripCounter } from "@/lib/api/os-round-trips";

beforeEach(() => {
  searchSpy.mockClear();
});

describe("searchClient() request-path timeout injection", () => {
  it("passes ETL/out-of-scope calls through with no injected options", async () => {
    await searchClient().search({ index: "scholars-people" } as never);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    // Exactly the caller's single argument — no transport options appended.
    expect(searchSpy.mock.calls[0]).toHaveLength(1);
  });

  it("injects the fail-fast timeout + single retry inside a request scope", async () => {
    await runWithOsRoundTripCounter(() =>
      searchClient().search({ index: "scholars-people" } as never),
    );
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0][1]).toEqual({ requestTimeout: 5_000, maxRetries: 1 });
  });

  it("lets explicit per-call options win over the injected defaults", async () => {
    await runWithOsRoundTripCounter(() =>
      searchClient().search({ index: "scholars-people" } as never, {
        requestTimeout: 9_999,
      } as never),
    );
    expect(searchSpy.mock.calls[0][1]).toEqual({ requestTimeout: 9_999, maxRetries: 1 });
  });
});
