/**
 * #866 — the shared "internal viewer" predicate.
 *
 * An *internal viewer* is one of:
 *   - SESSION: an authenticated request carrying a valid session cookie
 *     (any signed-in scholar), OR
 *   - NETWORK: an unauthenticated request whose CloudFront-reported source IP
 *     is inside the operator-configured WCM allowlist — and ONLY when the
 *     `INTERNAL_VIEWER_NETWORK_SIGNAL` flag is on.
 *
 * Everything else (no session, and either the flag is off or the IP is not in
 * the allowlist) is an EXTERNAL viewer. This predicate gates two dark features:
 *   - UC-A: broadening the #801 reveal of sensitive method families from
 *     {self, admin} to any internal viewer.
 *   - UC-B: adding an email column to the internal-only #847 roster CSV export.
 *
 * Default-safe: an external viewer must NEVER be classified internal. The
 * network branch is off by default (the flag) and additionally inert when
 * `INTERNAL_VIEWER_CIDRS` is empty, so a misconfiguration fails closed.
 *
 * Edge-safe: this module imports only the request-based session reader
 * (`getSessionFromRequest` from lib/auth/session.ts — iron-session + config) and
 * the pure CIDR helper. It MUST NOT import `session-server.ts` (which pulls in
 * `next/headers` and is Node/Server-Component-only), so it can run in middleware
 * and in any route handler.
 */
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { ipv4InAnyCidr } from "@/lib/auth/cidr";
import { isInternalViewerNetworkSignalOn } from "@/lib/auth/viewer-flags";

/** How a viewer qualified as internal — or `null` when external. */
export type ViewerBasis = "session" | "network" | null;

export interface ViewerContext {
  /** True iff the viewer is a session OR an allowlisted-network viewer. */
  internal: boolean;
  /** Which branch matched: "session", "network", or null when external. */
  basis: ViewerBasis;
  /** The signed-in CWID — present only on the SESSION branch. */
  cwid?: string;
}

/**
 * The CloudFront-generated header carrying the true viewer source address. Its
 * value is `IP:port` (e.g. IPv4 `203.0.113.5:50000`, IPv6
 * `[2001:db8::1]:50000`). CloudFront sets it on origin requests, so behind the
 * CDN this is the trustworthy client IP — not `x-forwarded-for`, which the
 * ALB→container hop can append to. Absent in non-CloudFront contexts (local
 * dev, direct origin hits) → no network match.
 */
const VIEWER_ADDRESS_HEADER = "cloudfront-viewer-address";

/**
 * Extract the IPv4 dotted-quad from a `cloudfront-viewer-address` value, or
 * `null`. The format is `IP:port`; the IPv4 case is `a.b.c.d:port`, so strip the
 * trailing `:port` by taking everything before the LAST colon. An IPv6 value
 * (which contains multiple colons and/or brackets) is skipped — the WCM
 * allowlist is IPv4-only (#461), so an IPv6 viewer simply never matches the
 * network branch. Malformed / empty input → null. Never throws.
 */
export function extractIpv4FromViewerAddress(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  // IPv6 literals are bracketed (`[...]:port`) or contain multiple colons.
  // Either way they are not IPv4 — skip rather than mis-parse.
  if (value.includes("[") || value.includes("]")) return null;
  const lastColon = value.lastIndexOf(":");
  // `a.b.c.d:port` has exactly one colon; `a.b.c.d` (no port) has none. More
  // than one colon means it is not a bare IPv4(:port), so skip it.
  if (value.indexOf(":") !== lastColon) return null;
  const ipPart = lastColon === -1 ? value : value.slice(0, lastColon);
  // An IPv4 has exactly three dots; cheap guard before the strict CIDR parser.
  if (ipPart.split(".").length !== 4) return null;
  return ipPart;
}

/**
 * Parse `INTERNAL_VIEWER_CIDRS` (comma-separated IPv4 CIDRs) into a trimmed,
 * non-empty list. Unset / empty → `[]`, so the network branch never matches.
 */
function readConfiguredCidrs(): string[] {
  const raw = process.env.INTERNAL_VIEWER_CIDRS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve the internal-viewer context for a request. Evaluated in order:
 *   1. SESSION — a valid session cookie ⇒ internal / "session" + cwid.
 *   2. NETWORK — only when `INTERNAL_VIEWER_NETWORK_SIGNAL` is on AND the
 *      CloudFront source IPv4 is inside any `INTERNAL_VIEWER_CIDRS` entry ⇒
 *      internal / "network".
 *   3. otherwise ⇒ external (`{ internal: false, basis: null }`).
 *
 * Never throws: a session-read failure is treated as "no session" (mirroring the
 * middleware's fail-closed try/catch), and all IP/CIDR parsing is total.
 */
export async function resolveViewerContext(
  request: NextRequest,
): Promise<ViewerContext> {
  // 1. SESSION branch. Read from the REQUEST (not next/headers). A thrown error
  // (e.g. SESSION_COOKIE_SECRET unset) is treated as no session — fail toward
  // external rather than 500, exactly as middleware.ts does at its gate.
  let cwid: string | undefined;
  try {
    const session = await getSessionFromRequest(request);
    if (session) cwid = session.cwid;
  } catch {
    cwid = undefined;
  }
  if (cwid) return { internal: true, basis: "session", cwid };

  // 2. NETWORK branch — dark unless the flag is on.
  if (isInternalViewerNetworkSignalOn()) {
    const ip = extractIpv4FromViewerAddress(
      request.headers.get(VIEWER_ADDRESS_HEADER),
    );
    if (ip && ipv4InAnyCidr(ip, readConfiguredCidrs())) {
      return { internal: true, basis: "network" };
    }
  }

  // 3. External viewer.
  return { internal: false, basis: null };
}
