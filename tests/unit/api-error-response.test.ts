import { describe, it, expect } from "vitest";
import { apiError, API_NO_STORE } from "@/lib/api/error-response";

describe("apiError (#668 §5)", () => {
  it("returns the flat { error: code } body that clients parse as a string", async () => {
    const res = apiError("unauthorized", 401);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
    // Flat string — NOT a nested { error: { code, message } } envelope, which
    // would break mapErrorToMessage / humanizeError on the existing clients.
    expect(typeof body.error).toBe("string");
  });

  it("always sets Cache-Control: no-store (errors must never be cached/replayed)", () => {
    const res = apiError("missing path", 400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("merges caller headers on top of no-store without dropping it", () => {
    const res = apiError("invalid body", 400, { headers: { "X-Trace": "abc" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-trace")).toBe("abc");
  });

  it("preserves the given status code", async () => {
    for (const status of [400, 401, 403, 404, 500]) {
      const res = apiError("e", status);
      expect(res.status).toBe(status);
    }
  });

  it("exposes the no-store header constant", () => {
    expect(API_NO_STORE).toEqual({ "Cache-Control": "no-store" });
  });
});
