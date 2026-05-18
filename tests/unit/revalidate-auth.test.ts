/**
 * Tests for lib/revalidate-auth.ts — the bearer-token auth for /api/revalidate
 * (issue #103 / B04): constant-time compare, env token parsing, the cold-start
 * token cache, and the `Authorization: Bearer` check including the rotation
 * (current + previous) window.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  getRevalidateTokens,
  isAuthorizedBearer,
  readRevalidateTokens,
  resetRevalidateTokenCache,
  timingSafeEqualStr,
} from "@/lib/revalidate-auth";

describe("timingSafeEqualStr", () => {
  it("is true for identical strings", () => {
    expect(timingSafeEqualStr("a-secret-token", "a-secret-token")).toBe(true);
  });

  it("is false for different strings of equal length", () => {
    expect(timingSafeEqualStr("token-aaaaaaa", "token-bbbbbbb")).toBe(false);
  });

  it("is false for strings of different lengths, without throwing", () => {
    expect(timingSafeEqualStr("short", "a-much-longer-token")).toBe(false);
  });

  it("is true for two empty strings", () => {
    expect(timingSafeEqualStr("", "")).toBe(true);
  });
});

describe("readRevalidateTokens", () => {
  it("returns the current token then the previous when both are set", () => {
    expect(
      readRevalidateTokens({
        SCHOLARS_REVALIDATE_TOKEN: "current",
        SCHOLARS_REVALIDATE_TOKEN_PREVIOUS: "previous",
      }),
    ).toEqual(["current", "previous"]);
  });

  it("returns just the current token when previous is unset", () => {
    expect(
      readRevalidateTokens({ SCHOLARS_REVALIDATE_TOKEN: "current" }),
    ).toEqual(["current"]);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(readRevalidateTokens({})).toEqual([]);
  });

  it("trims whitespace and drops blank values", () => {
    expect(
      readRevalidateTokens({
        SCHOLARS_REVALIDATE_TOKEN: "  current  ",
        SCHOLARS_REVALIDATE_TOKEN_PREVIOUS: "   ",
      }),
    ).toEqual(["current"]);
  });
});

describe("isAuthorizedBearer", () => {
  const tokens = ["current-token", "previous-token"];

  it("is false for a null, undefined, or empty header", () => {
    expect(isAuthorizedBearer(null, tokens)).toBe(false);
    expect(isAuthorizedBearer(undefined, tokens)).toBe(false);
    expect(isAuthorizedBearer("", tokens)).toBe(false);
  });

  it("accepts the current token", () => {
    expect(isAuthorizedBearer("Bearer current-token", tokens)).toBe(true);
  });

  it("accepts the previous token (rotation window)", () => {
    expect(isAuthorizedBearer("Bearer previous-token", tokens)).toBe(true);
  });

  it("matches the Bearer scheme case-insensitively", () => {
    expect(isAuthorizedBearer("bearer current-token", tokens)).toBe(true);
    expect(isAuthorizedBearer("BEARER current-token", tokens)).toBe(true);
  });

  it("rejects a token not in the accepted list", () => {
    expect(isAuthorizedBearer("Bearer stale-token", tokens)).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(isAuthorizedBearer("Basic current-token", tokens)).toBe(false);
  });

  it("rejects the raw token with no scheme", () => {
    expect(isAuthorizedBearer("current-token", tokens)).toBe(false);
  });

  it("rejects an empty bearer token", () => {
    expect(isAuthorizedBearer("Bearer ", tokens)).toBe(false);
  });

  it("rejects every token when the accepted list is empty", () => {
    expect(isAuthorizedBearer("Bearer current-token", [])).toBe(false);
  });
});

describe("getRevalidateTokens / resetRevalidateTokenCache", () => {
  beforeEach(() => {
    delete process.env.SCHOLARS_REVALIDATE_TOKEN;
    delete process.env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS;
    resetRevalidateTokenCache();
  });

  it("reads the tokens from the environment", () => {
    process.env.SCHOLARS_REVALIDATE_TOKEN = "env-token";
    resetRevalidateTokenCache();
    expect(getRevalidateTokens()).toEqual(["env-token"]);
  });

  it("caches the first read until the cache is reset", () => {
    process.env.SCHOLARS_REVALIDATE_TOKEN = "first";
    resetRevalidateTokenCache();
    expect(getRevalidateTokens()).toEqual(["first"]);

    // A later env change is not visible while the cache stands.
    process.env.SCHOLARS_REVALIDATE_TOKEN = "second";
    expect(getRevalidateTokens()).toEqual(["first"]);

    // ...until the cache is dropped — operationally, a cold start.
    resetRevalidateTokenCache();
    expect(getRevalidateTokens()).toEqual(["second"]);
  });
});
