/**
 * #866 — a dependency-free, pure IPv4 CIDR membership test.
 *
 * The internal-viewer "on the WCM network" branch (lib/auth/viewer-context.ts)
 * matches a CloudFront-supplied source IP against an operator-configured set of
 * CIDRs. The WCM allowlist is IPv4-only (it mirrors the #461 WAF allow rules),
 * so this module deliberately handles only dotted-quad IPv4 / `a.b.c.d/len`.
 *
 * Everything here is total: any malformed input — a bad octet, an out-of-range
 * prefix length, an IPv6 literal, an empty string — yields `false` (or an empty
 * parse), never a throw. A security predicate must fail closed, not 500.
 */

/** A parsed IPv4 CIDR: a uint32 network base plus a /prefix mask. */
interface ParsedCidr {
  /** The network address as an unsigned 32-bit integer. */
  base: number;
  /** The prefix mask as an unsigned 32-bit integer (e.g. /24 → 0xffffff00). */
  mask: number;
}

/**
 * Parse a dotted-quad IPv4 string to an unsigned 32-bit integer, or `null` for
 * anything that is not exactly four 0–255 octets. Rejects IPv6, embedded ports,
 * leading/trailing junk, and empty octets. `>>> 0` keeps the result unsigned.
 */
export function parseIpv4(ip: string): number | null {
  if (typeof ip !== "string") return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // Reject empty, non-numeric, or zero-padded-but-malformed octets. A bare
    // `Number.parseInt` would accept "12abc"; require the whole octet to be
    // digits so "1.2.3.4x" and "1.2.3." are rejected.
    if (part.length === 0 || !/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * Parse an `a.b.c.d/len` CIDR string to a `ParsedCidr`, or `null` if either the
 * IP or the prefix length (0–32) is malformed. A bare IP with no `/len` is
 * treated as a /32 (a single host), which is convenient for an allowlist entry.
 */
export function parseCidr(cidr: string): ParsedCidr | null {
  if (typeof cidr !== "string") return null;
  const trimmed = cidr.trim();
  if (trimmed.length === 0) return null;
  const slash = trimmed.indexOf("/");
  const ipPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const lenPart = slash === -1 ? "32" : trimmed.slice(slash + 1);

  const base = parseIpv4(ipPart);
  if (base === null) return null;

  if (!/^\d{1,2}$/.test(lenPart)) return null;
  const len = Number.parseInt(lenPart, 10);
  if (len < 0 || len > 32) return null;

  // A /0 mask is 0 (matches everything); /32 is 0xffffffff. Shifting a uint32
  // by 32 is undefined in JS (`x << 32 === x`), so special-case len 0.
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

/**
 * True iff `ip` (a dotted-quad IPv4 string) falls inside `cidr`
 * (`a.b.c.d/len`). Malformed `ip` or `cidr` → `false` (fail closed).
 */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (parsed === null) return false;
  const value = parseIpv4(ip);
  if (value === null) return false;
  return ((value & parsed.mask) >>> 0) === parsed.base;
}

/**
 * True iff `ip` falls inside ANY of `cidrs`. Each malformed entry is skipped
 * (never throws); an empty list → `false`.
 */
export function ipv4InAnyCidr(ip: string, cidrs: readonly string[]): boolean {
  for (const cidr of cidrs) {
    if (ipv4InCidr(ip, cidr)) return true;
  }
  return false;
}
