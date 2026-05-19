import { NextRequest, NextResponse } from "next/server";

/**
 * CSP violation report collector — issue #374 (follow-on to #120 / B21).
 *
 * `lib/security-headers.ts` ships the Content-Security-Policy in report-only
 * mode with both reporting directives pointed here:
 *   - `report-uri /api/csp-report` — sent by every current browser as a
 *     single `{ "csp-report": { … } }` object, content-type
 *     `application/csp-report`.
 *   - `report-to csp-endpoint` — the Reporting-API successor, sent as an
 *     array of `{ type, body }` entries, content-type
 *     `application/reports+json`.
 *
 * This route is the observation-window sink: every violation, in either
 * format, is written to the server log as one structured `csp-violation`
 * line (the shape the search route logs), so CloudWatch ingests them once a
 * production environment exists (#99) and Logs Insights can aggregate them.
 * The decision to keep `'unsafe-inline'` rather than adopt a nonce, and to
 * promote the policy to enforcing later, is recorded in docs/ADR-007.
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

/**
 * Content-types accepted: the legacy `report-uri` payload and the
 * Reporting-API `report-to` payload, respectively.
 */
const REPORT_CONTENT_TYPES = [
  "application/csp-report",
  "application/reports+json",
];

/** Coerce an unknown report field to a length-capped string, or undefined. */
function field(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, MAX_FIELD_LENGTH);
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Reduce either payload shape to a flat list of violation bodies:
 *   - `report-uri`:   `{ "csp-report": { … } }`             → `[ { … } ]`
 *   - Reporting-API:  `[ { type: "csp-violation", body } ]` → `[ body, … ]`
 * Anything that does not match is dropped — the result is always an array.
 */
function extractViolations(parsed: unknown): Record<string, unknown>[] {
  // Reporting-API `report-to`: an array of report objects; keep the CSP ones.
  if (Array.isArray(parsed)) {
    const out: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const { type, body } = entry as { type?: unknown; body?: unknown };
      if (type === "csp-violation" && body && typeof body === "object") {
        out.push(body as Record<string, unknown>);
      }
    }
    return out;
  }
  // Legacy `report-uri`: a single `{ "csp-report": { … } }` envelope.
  if (parsed && typeof parsed === "object") {
    const report = (parsed as { "csp-report"?: unknown })["csp-report"];
    if (report && typeof report === "object") {
      return [report as Record<string, unknown>];
    }
  }
  return [];
}

/**
 * One structured log line per violation. Each field is read under both its
 * `report-uri` (kebab-case) and Reporting-API (camelCase) key, since the two
 * payload formats name the same fields differently.
 */
function violationLine(body: Record<string, unknown>): Record<string, unknown> {
  return {
    event: "csp-violation",
    documentUri: field(body["document-uri"] ?? body["documentURL"]),
    violatedDirective: field(
      body["violated-directive"] ?? body["violatedDirective"],
    ),
    effectiveDirective: field(
      body["effective-directive"] ?? body["effectiveDirective"],
    ),
    blockedUri: field(body["blocked-uri"] ?? body["blockedURL"]),
    disposition: field(body["disposition"]),
    sourceFile: field(body["source-file"] ?? body["sourceFile"]),
    lineNumber: field(body["line-number"] ?? body["lineNumber"]),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // A CSP report arrives as `application/csp-report` or
  // `application/reports+json`. Reject anything else without reading the body.
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!REPORT_CONTENT_TYPES.some((type) => contentType.includes(type))) {
    return new NextResponse(null, { status: 415 });
  }

  // Reject an over-large body from its declared length, before reading it.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  let violations: Record<string, unknown>[] = [];
  try {
    const raw = await request.text();
    // Backstop in case Content-Length was absent or understated.
    if (raw.length > MAX_BODY_BYTES) {
      return new NextResponse(null, { status: 413 });
    }
    violations = extractViolations(JSON.parse(raw));
  } catch {
    // Unreadable body or malformed JSON — a probe or a broken client. Swallow
    // it: 204, no log noise, nothing persisted.
    return new NextResponse(null, { status: 204 });
  }

  // `csp-violation` is the grep anchor; the fields are what Logs Insights
  // groups the observation window on.
  for (const violation of violations) {
    console.warn(JSON.stringify(violationLine(violation)));
  }

  return new NextResponse(null, { status: 204 });
}
