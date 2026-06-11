/**
 * #866 — pure IPv4 CIDR helper (lib/auth/cidr.ts).
 *
 * The internal-viewer network branch fails closed: any malformed IP or CIDR must
 * resolve to `false`, never throw. These cover in/out-of-range membership, /32
 * and /0 boundaries, the bare-IP-as-/32 shorthand, and malformed input on both
 * sides.
 */
import { describe, expect, it } from "vitest";
import {
  parseIpv4,
  parseCidr,
  ipv4InCidr,
  ipv4InAnyCidr,
} from "@/lib/auth/cidr";

describe("parseIpv4", () => {
  it("parses a dotted quad to its unsigned 32-bit value", () => {
    expect(parseIpv4("0.0.0.0")).toBe(0);
    expect(parseIpv4("255.255.255.255")).toBe(0xffffffff);
    // 203.0.113.5 = 0xCB007105.
    expect(parseIpv4("203.0.113.5")).toBe(0xcb007105);
  });

  it("returns null for out-of-range octets, wrong arity, and junk", () => {
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("1.2.3.")).toBeNull();
    expect(parseIpv4("1.2.3.4x")).toBeNull();
    expect(parseIpv4("a.b.c.d")).toBeNull();
    expect(parseIpv4("")).toBeNull();
    expect(parseIpv4("::1")).toBeNull();
  });
});

describe("parseCidr", () => {
  it("masks the base to the prefix and computes the mask", () => {
    // 10.20.30.40/24 → base 10.20.30.0, mask 0xffffff00.
    const parsed = parseCidr("10.20.30.40/24");
    expect(parsed).not.toBeNull();
    expect(parsed!.base).toBe(parseIpv4("10.20.30.0"));
    expect(parsed!.mask).toBe(0xffffff00);
  });

  it("treats a bare IP as a /32 host route", () => {
    const parsed = parseCidr("10.20.30.40");
    expect(parsed).not.toBeNull();
    expect(parsed!.base).toBe(parseIpv4("10.20.30.40"));
    expect(parsed!.mask).toBe(0xffffffff);
  });

  it("handles the /0 mask (matches everything) without an undefined shift", () => {
    const parsed = parseCidr("1.2.3.4/0");
    expect(parsed).not.toBeNull();
    expect(parsed!.base).toBe(0);
    expect(parsed!.mask).toBe(0);
  });

  it("returns null for malformed prefix lengths and IPs", () => {
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/-1")).toBeNull();
    expect(parseCidr("10.0.0.0/abc")).toBeNull();
    expect(parseCidr("999.0.0.0/8")).toBeNull();
    expect(parseCidr("")).toBeNull();
    expect(parseCidr("   ")).toBeNull();
    expect(parseCidr("2001:db8::/32")).toBeNull();
  });
});

describe("ipv4InCidr", () => {
  it("returns true for an IP inside the range and false for one outside", () => {
    expect(ipv4InCidr("10.20.30.42", "10.20.30.0/24")).toBe(true);
    expect(ipv4InCidr("10.20.31.42", "10.20.30.0/24")).toBe(false);
  });

  it("honors the /32 single-host boundary exactly", () => {
    expect(ipv4InCidr("10.20.30.40", "10.20.30.40/32")).toBe(true);
    expect(ipv4InCidr("10.20.30.41", "10.20.30.40/32")).toBe(false);
  });

  it("matches the network and broadcast boundaries of a /24", () => {
    expect(ipv4InCidr("10.20.30.0", "10.20.30.0/24")).toBe(true);
    expect(ipv4InCidr("10.20.30.255", "10.20.30.0/24")).toBe(true);
    expect(ipv4InCidr("10.20.29.255", "10.20.30.0/24")).toBe(false);
    expect(ipv4InCidr("10.20.31.0", "10.20.30.0/24")).toBe(false);
  });

  it("matches every address under /0", () => {
    expect(ipv4InCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
  });

  it("ignores host bits set in the CIDR base (40 in /24 is normalized)", () => {
    expect(ipv4InCidr("10.20.30.7", "10.20.30.40/24")).toBe(true);
  });

  it("fails closed (false) on malformed IP or CIDR — never throws", () => {
    expect(ipv4InCidr("not-an-ip", "10.20.30.0/24")).toBe(false);
    expect(ipv4InCidr("10.20.30.42", "garbage")).toBe(false);
    expect(ipv4InCidr("10.20.30.42", "10.20.30.0/99")).toBe(false);
    expect(ipv4InCidr("", "")).toBe(false);
  });
});

describe("ipv4InAnyCidr", () => {
  it("returns true when the IP matches any entry", () => {
    expect(
      ipv4InAnyCidr("10.20.30.5", ["192.168.0.0/16", "10.20.30.0/24"]),
    ).toBe(true);
  });

  it("returns false when no entry matches", () => {
    expect(
      ipv4InAnyCidr("172.16.0.1", ["192.168.0.0/16", "10.20.30.0/24"]),
    ).toBe(false);
  });

  it("returns false for an empty list", () => {
    expect(ipv4InAnyCidr("10.20.30.5", [])).toBe(false);
  });

  it("skips malformed entries without throwing and still matches a good one", () => {
    expect(
      ipv4InAnyCidr("10.20.30.5", ["garbage", "10.20.30.0/24"]),
    ).toBe(true);
    expect(ipv4InAnyCidr("10.20.30.5", ["garbage", "nope/99"])).toBe(false);
  });
});
