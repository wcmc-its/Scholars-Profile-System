import { NextRequest, NextResponse } from "next/server";

/**
 * CSP violation report collector — issue #374 (follow-on to #120 / B21).
 *
 * `lib/security-headers.ts` ships the Content-Security-Policy in report-only
 * mode with a `report-uri /api/csp-report` directive: when a page violates the
 * policy the browser POSTs a JSON report here. This route is the
 * observation-window sink — every report is written to the server log as one
 * structured line (`event: "csp-violation"`, the shape the search route logs),
 * so CloudWatch ingests it once a production environment exists (#99) and Logs
 * Insights can aggregate it. Promoting the policy from report-only to
 * enforcing depends on that aggregated data coming back clean.
 *
 * The endpoint is intentionally public and unauthenticated — browsers send
 * violation reports with no credentials — so it is written defensively: it
 * rejects a non-report content-type and an oversized body without parsing,
 * coerces every payload field, never throws, and persists nothing. A public
 * write path into a database would be an unbounded spam/DoS vector.
 */

/** Reject bodies larger than this; a genuine CSP report is well under 4 KB. */
const MAX_BODY_BYTES = 16 * 1024;

/** Cap any single logged field so a crafted report cannot bloat a log line. */
const MAX_FIELD_LENGTH = 1024;

/** Coerce an unknown report field to a length-capped string, or undefined. */
function field(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, MAX_FIELD_LENGTH);
  if (typeof value === "number") return String(value);
  return undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // `report-uri` violations arrive as `application/csp-report`. Reject anything
  // else without reading the body — it is not a CSP report.
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/csp-report")) {
    return new NextResponse(null, { status: 415 });
  }

  // Reject an over-large body from its declared length, before reading it.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  let report: Record<string, unknown> | undefined;
  try {
    const raw = await request.text();
    // Backstop in case Content-Length was absent or understated.
    if (raw.length > MAX_BODY_BYTES) {
      return new NextResponse(null, { status: 413 });
    }
    // The browser POSTs `{ "csp-report": { ... } }`; every field inside is
    // attacker-controllable and is coerced below, never trusted.
    const envelope = JSON.parse(raw) as {
      "csp-report"?: Record<string, unknown>;
    };
    report = envelope?.["csp-report"];
  } catch {
    // Unreadable body or malformed JSON — a probe or a broken client. Swallow
    // it: 204, no log noise, nothing persisted.
    return new NextResponse(null, { status: 204 });
  }

  if (report && typeof report === "object") {
    // One structured line per violation; `csp-violation` is the grep anchor
    // and the fields are what Logs Insights groups the observation window on.
    console.warn(
      JSON.stringify({
        event: "csp-violation",
        documentUri: field(report["document-uri"]),
        violatedDirective: field(report["violated-directive"]),
        effectiveDirective: field(report["effective-directive"]),
        blockedUri: field(report["blocked-uri"]),
        disposition: field(report["disposition"]),
        sourceFile: field(report["source-file"]),
        lineNumber: field(report["line-number"]),
      }),
    );
  }

  return new NextResponse(null, { status: 204 });
}
