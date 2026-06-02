import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The root boundary's effect calls logGlobalError (telemetry). Stub it so the
// effect has no network side effect in jsdom; we only exercise the self-heal.
vi.mock("@/lib/analytics/errors", () => ({ logGlobalError: vi.fn() }));

import GlobalError from "@/app/global-error";

const RELOAD_KEY = "sps-chunk-reload-at";

/** A webpack/Next stale-chunk error (rotated-out hash 404s on a dynamic import). */
function chunkError(message = "Loading chunk 9347 failed."): Error & { digest?: string } {
  const e = new Error(message);
  e.name = "ChunkLoadError";
  return e;
}

describe("GlobalError stale-chunk self-heal", () => {
  let reload: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    window.sessionStorage.clear();
    reload = vi.fn();
    originalLocation = window.location;
    // jsdom's window.location.reload throws "Not implemented"; replace the
    // object with a minimal stub exposing a mockable reload.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "https://scholars-staging.weill.cornell.edu/about", reload },
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    vi.clearAllMocks();
  });

  it("reloads exactly once on a ChunkLoadError and records the throttle timestamp", () => {
    render(<GlobalError error={chunkError()} reset={vi.fn()} />);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Number(window.sessionStorage.getItem(RELOAD_KEY))).toBeGreaterThan(0);
  });

  it("detects the message-only variants (no ChunkLoadError name)", () => {
    const e = new Error("Loading CSS chunk 12 failed.");
    render(<GlobalError error={e} reset={vi.fn()} />);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload again within the 10s throttle window (no reload loop)", () => {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    render(<GlobalError error={chunkError()} reset={vi.fn()} />);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads again once the throttle window has elapsed (>10s ago)", () => {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now() - 11_000));
    render(<GlobalError error={chunkError()} reset={vi.fn()} />);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload on a non-chunk error (the manual recovery UI handles it)", () => {
    render(<GlobalError error={new Error("Some unrelated runtime error")} reset={vi.fn()} />);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not throw when sessionStorage is unavailable (private mode), and skips the reload", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("sessionStorage blocked");
      });
    expect(() =>
      render(<GlobalError error={chunkError()} reset={vi.fn()} />),
    ).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
