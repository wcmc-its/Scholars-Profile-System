import { afterEach, describe, expect, it } from "vitest";
import { isrBuildFallback } from "@/lib/isr-build-fallback";

describe("isrBuildFallback", () => {
  const prev = process.env.NEXT_PHASE;
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = prev;
  });

  it("returns the fallback during next build (no DB in the image build)", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    await expect(Promise.reject(new Error("db down")).catch(isrBuildFallback(null))).resolves.toBeNull();
  });

  it("rethrows at runtime so ISR keeps the last good page instead of caching a degraded one", async () => {
    delete process.env.NEXT_PHASE;
    await expect(Promise.reject(new Error("db down")).catch(isrBuildFallback(null))).rejects.toThrow("db down");
  });
});
