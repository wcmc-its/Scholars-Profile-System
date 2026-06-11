/**
 * #866 — the internal-viewer predicate (lib/auth/viewer-context.ts).
 *
 * Truth table:
 *   - session present                                  → internal / "session" + cwid
 *   - no session, network signal OFF                   → external (IP ignored)
 *   - no session, signal ON, IP in CIDR                → internal / "network"
 *   - no session, signal ON, IP NOT in CIDR            → external
 *   - no session, signal ON, malformed/absent header   → external
 *   - no session, signal ON, empty INTERNAL_VIEWER_CIDRS → external
 *
 * A real `NextRequest` carrying a real sealed session cookie exercises the
 * session branch exactly as the route layer would (mirroring auth-middleware /
 * auth-session). Env is stubbed per-case and restored after each test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSessionCookie } from "@/lib/auth/session";
import {
  resolveViewerContext,
  extractIpv4FromViewerAddress,
} from "@/lib/auth/viewer-context";

const SECRET = "test-session-secret-0123456789-0123456789";
process.env.SESSION_COOKIE_SECRET = SECRET;

const ORIGIN = "https://scholars.weill.cornell.edu";

/** A NextRequest with an optional sealed session cookie and viewer-address. */
async function buildRequest(opts: {
  cwid?: string;
  viewerAddress?: string;
} = {}): Promise<NextRequest> {
  const headers: Record<string, string> = {};
  if (opts.cwid) {
    const cookie = await createSessionCookie(opts.cwid);
    headers.cookie = `${cookie.name}=${cookie.value}`;
  }
  if (opts.viewerAddress !== undefined) {
    headers["cloudfront-viewer-address"] = opts.viewerAddress;
  }
  return new NextRequest(`${ORIGIN}/methods/x/y`, { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveViewerContext — SESSION branch", () => {
  it("classifies a valid session as internal / session and carries the cwid", async () => {
    // Signal off + no allowlist: the session alone must make it internal.
    const ctx = await resolveViewerContext(await buildRequest({ cwid: "abc1234" }));
    expect(ctx).toEqual({ internal: true, basis: "session", cwid: "abc1234" });
  });

  it("session wins even when the network signal is on and the IP is allowlisted", async () => {
    vi.stubEnv("INTERNAL_VIEWER_NETWORK_SIGNAL", "on");
    vi.stubEnv("INTERNAL_VIEWER_CIDRS", "10.20.30.0/24");
    const ctx = await resolveViewerContext(
      await buildRequest({ cwid: "abc1234", viewerAddress: "10.20.30.5:51000" }),
    );
    expect(ctx.basis).toBe("session");
    expect(ctx.cwid).toBe("abc1234");
  });

  it("treats a garbage session cookie as no session (falls through to external)", async () => {
    const req = new NextRequest(`${ORIGIN}/methods/x/y`, {
      headers: { cookie: "__Secure-sps_session=not-a-valid-seal" },
    });
    const ctx = await resolveViewerContext(req);
    expect(ctx).toEqual({ internal: false, basis: null });
  });
});

describe("resolveViewerContext — NETWORK branch", () => {
  it("is external when the network signal is OFF, even with an allowlisted IP", async () => {
    // Flag off; CIDRs present but must be ignored.
    vi.stubEnv("INTERNAL_VIEWER_CIDRS", "10.20.30.0/24");
    const ctx = await resolveViewerContext(
      await buildRequest({ viewerAddress: "10.20.30.5:51000" }),
    );
    expect(ctx).toEqual({ internal: false, basis: null });
  });

  it("is internal / network when signal ON and the source IP is in a CIDR", async () => {
    vi.stubEnv("INTERNAL_VIEWER_NETWORK_SIGNAL", "on");
    vi.stubEnv("INTERNAL_VIEWER_CIDRS", "192.168.0.0/16,10.20.30.0/24");
    const ctx = await resolveViewerContext(
      await buildRequest({ viewerAddress: "10.20.30.5:51000" }),
    );
    expect(ctx).toEqual({ internal: true, basis: "network" });
    expect(ctx.cwid).toBeUndefined();
  });

  it("is external when signal ON but the source IP is NOT in any CIDR", async () => {
    vi.stubEnv("INTERNAL_VIEWER_NETWORK_SIGNAL", "on");
    vi.stubEnv("INTERNAL_VIEWER_CIDRS", "10.20.30.0/24");
    const ctx = await resolveViewerContext(
      await buildRequest({ viewerAddress: "172.16.0.1:51000" }),
    );
    expect(ctx).toEqual({ internal: false, basis: null });
  });

  it("is external when signal ON but INTERNAL_VIEWER_CIDRS is empty", async () => {
    vi.stubEnv("INTERNAL_VIEWER_NETWORK_SIGNAL", "on");
    vi.stubEnv("INTERNAL_VIEWER_CIDRS", "");
    const ctx = await resolveViewerContext(
      await buildRequest({ viewerAddress: "10.20.30.5:51000" }),
    );
    expect(ctx).toEqual({ internal: false, basis: null });
  });

  it("is external when the viewer-address header is absent (no CloudFront context)", async () => {
    vi.stubEnv("INTERNAL_VIEWER_NETWORK_SIGNAL", "on");
    vi.stubEnv("INTERNAL_VIEWER_CIDRS", "10.20.30.0/24");
    const ctx = await resolveViewerContext(await buildRequest({}));
    expect(ctx).toEqual({ internal: false, basis: null });
  });

  it("is external for a malformed viewer-address value", async () => {
    vi.stubEnv("INTERNAL_VIEWER_NETWORK_SIGNAL", "on");
    vi.stubEnv("INTERNAL_VIEWER_CIDRS", "10.20.30.0/24");
    const ctx = await resolveViewerContext(
      await buildRequest({ viewerAddress: "garbage-not-an-ip" }),
    );
    expect(ctx).toEqual({ internal: false, basis: null });
  });

  it("skips an IPv6 viewer-address (allowlist is IPv4-only, #461) → external", async () => {
    vi.stubEnv("INTERNAL_VIEWER_NETWORK_SIGNAL", "on");
    vi.stubEnv("INTERNAL_VIEWER_CIDRS", "10.20.30.0/24");
    const ctx = await resolveViewerContext(
      await buildRequest({ viewerAddress: "[2001:db8::1]:51000" }),
    );
    expect(ctx).toEqual({ internal: false, basis: null });
  });

  it("matches an IPv4 viewer-address that omits the trailing :port", async () => {
    vi.stubEnv("INTERNAL_VIEWER_NETWORK_SIGNAL", "on");
    vi.stubEnv("INTERNAL_VIEWER_CIDRS", "10.20.30.0/24");
    const ctx = await resolveViewerContext(
      await buildRequest({ viewerAddress: "10.20.30.5" }),
    );
    expect(ctx).toEqual({ internal: true, basis: "network" });
  });
});

describe("extractIpv4FromViewerAddress", () => {
  it("strips the trailing :port from an IPv4 value", () => {
    expect(extractIpv4FromViewerAddress("203.0.113.5:50000")).toBe("203.0.113.5");
  });

  it("returns the bare IPv4 when no port is present", () => {
    expect(extractIpv4FromViewerAddress("203.0.113.5")).toBe("203.0.113.5");
  });

  it("returns null for IPv6 (bracketed or multi-colon) and empty/absent input", () => {
    expect(extractIpv4FromViewerAddress("[2001:db8::1]:50000")).toBeNull();
    expect(extractIpv4FromViewerAddress("2001:db8::1")).toBeNull();
    expect(extractIpv4FromViewerAddress("")).toBeNull();
    expect(extractIpv4FromViewerAddress("   ")).toBeNull();
    expect(extractIpv4FromViewerAddress(null)).toBeNull();
    expect(extractIpv4FromViewerAddress(undefined)).toBeNull();
  });

  it("returns null for a value with the wrong number of dotted parts", () => {
    expect(extractIpv4FromViewerAddress("1.2.3:50000")).toBeNull();
  });
});
