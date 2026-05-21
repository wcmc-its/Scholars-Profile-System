import { describe, expect, it } from "vitest";
import {
  RedactionSpanProcessor,
  redactAttributes,
  shaPrefix,
  shouldRedactSpan,
} from "@/lib/tracing/redact";

const SHA_RE = /^sha256:[0-9a-f]{12}$/;

function fakeSpan(attributes: Record<string, unknown>) {
  // Minimum shape SpanProcessor.onEnd touches: a mutable attributes bag.
  return { attributes } as unknown as Parameters<
    RedactionSpanProcessor["onEnd"]
  >[0];
}

describe("redactAttributes", () => {
  it("hashes identifier-key values", () => {
    const out = redactAttributes({
      cwid: "0000-0002-1234-5678",
      email: "x@example.org",
      name: "left alone",
    });
    expect(out.cwid).toMatch(SHA_RE);
    expect(out.email).toMatch(SHA_RE);
    expect(out.name).toBe("left alone");
  });

  it("hashes nested identifier-key values (matches by last dotted segment)", () => {
    const out = redactAttributes({ "user.cwid": "abcd-efgh" });
    expect(out["user.cwid"]).toMatch(SHA_RE);
  });

  it("hashes Prisma parameter arrays", () => {
    const out = redactAttributes({
      "db.statement.parameters": ["alice@example.org", 42],
    });
    expect(out["db.statement.parameters"]).toEqual([
      shaPrefix("alice@example.org"),
      shaPrefix("42"),
    ]);
  });

  it("hashes Prisma parameter strings (some emitters serialize)", () => {
    const out = redactAttributes({
      "db.statement.parameters": "[\"alice\",42]",
    });
    expect(out["db.statement.parameters"]).toMatch(SHA_RE);
  });

  it("rewrites dynamic route segments on http.target while keeping route shape", () => {
    const out = redactAttributes({
      "http.target": "/scholar/0000-0002-1234-5678/publications",
    });
    expect(out["http.target"]).toMatch(
      /^\/scholar\/sha256:[0-9a-f]{12}\/publications$/,
    );
  });

  it("leaves non-identifier path segments alone", () => {
    const out = redactAttributes({ "http.target": "/api/health" });
    expect(out["http.target"]).toBe("/api/health");
  });

  it("leaves unrelated attributes alone", () => {
    const out = redactAttributes({
      "http.method": "GET",
      "http.status_code": 200,
    });
    expect(out["http.method"]).toBe("GET");
    expect(out["http.status_code"]).toBe(200);
  });
});

describe("shouldRedactSpan", () => {
  it("redacts by default", () => {
    expect(shouldRedactSpan(fakeSpan({}), {})).toBe(true);
  });

  it("honors the per-span opt-out", () => {
    expect(
      shouldRedactSpan(fakeSpan({ "sps.trace.redact": "off" }), {}),
    ).toBe(false);
  });

  it("honors the SPS_TRACE_REDACT=off global kill switch", () => {
    expect(
      shouldRedactSpan(fakeSpan({ cwid: "x" }), { SPS_TRACE_REDACT: "off" }),
    ).toBe(false);
  });

  it("ignores SPS_TRACE_REDACT values other than 'off'", () => {
    expect(
      shouldRedactSpan(fakeSpan({}), { SPS_TRACE_REDACT: "on" }),
    ).toBe(true);
  });
});

describe("RedactionSpanProcessor.onEnd", () => {
  it("mutates the span attribute bag in place", () => {
    const proc = new RedactionSpanProcessor({});
    const span = fakeSpan({ cwid: "0000-0002-1234-5678" });
    proc.onEnd(span);
    expect((span.attributes as Record<string, unknown>).cwid).toMatch(SHA_RE);
  });

  it("does nothing when per-span opt-out is set", () => {
    const proc = new RedactionSpanProcessor({});
    const span = fakeSpan({
      cwid: "0000-0002-1234-5678",
      "sps.trace.redact": "off",
    });
    proc.onEnd(span);
    expect((span.attributes as Record<string, unknown>).cwid).toBe(
      "0000-0002-1234-5678",
    );
  });

  it("does nothing when the global kill switch is on", () => {
    const proc = new RedactionSpanProcessor({ SPS_TRACE_REDACT: "off" });
    const span = fakeSpan({ cwid: "0000-0002-1234-5678" });
    proc.onEnd(span);
    expect((span.attributes as Record<string, unknown>).cwid).toBe(
      "0000-0002-1234-5678",
    );
  });
});
