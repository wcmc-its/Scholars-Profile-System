/**
 * Unit tests for app/api/csp-report/route.ts — issue #374.
 *
 * The CSP violation collector is a public, unauthenticated POST endpoint that
 * logs `report-uri` violation reports as structured lines and persists
 * nothing. Tests cover the accepted path, the structured log it emits, and the
 * defensive rejections (wrong content-type, oversized body, malformed JSON).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/csp-report/route";

/** A minimal, well-formed `report-uri` violation payload. */
const SAMPLE_REPORT = {
  "csp-report": {
    "document-uri": "https://scholars.example.edu/scholars/jane-doe",
    "violated-directive": "script-src",
    "effective-directive": "script-src",
    "blocked-uri": "https://evil.example.com/x.js",
    disposition: "report",
  },
};

/** POST a body to the collector with the given content-type. */
function post(
  body: string,
  contentType = "application/csp-report",
): NextRequest {
  return new NextRequest("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/csp-report", () => {
  it("accepts a well-formed report with 204 and an empty body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resp = await POST(post(JSON.stringify(SAMPLE_REPORT)));
    expect(resp.status).toBe(204);
    expect(await resp.text()).toBe("");
  });

  it("logs the violation as a structured csp-violation line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await POST(post(JSON.stringify(SAMPLE_REPORT)));

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][0] as string);
    expect(logged.event).toBe("csp-violation");
    expect(logged.blockedUri).toBe("https://evil.example.com/x.js");
    expect(logged.violatedDirective).toBe("script-src");
  });

  it("rejects a non-report content-type with 415 and does not log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resp = await POST(
      post(JSON.stringify(SAMPLE_REPORT), "application/json"),
    );
    expect(resp.status).toBe(415);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects an oversized body with 413 and does not log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const huge = JSON.stringify({
      "csp-report": { "blocked-uri": "x".repeat(20 * 1024) },
    });
    const resp = await POST(post(huge));
    expect(resp.status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it("swallows a malformed JSON body with 204 and does not log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resp = await POST(post("{not json"));
    expect(resp.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("swallows a body with no csp-report envelope with 204 and does not log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resp = await POST(post(JSON.stringify({ something: "else" })));
    expect(resp.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a Reporting-API (application/reports+json) violation array", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify([
      {
        type: "csp-violation",
        age: 10,
        url: "https://scholars.example.edu/",
        body: {
          documentURL: "https://scholars.example.edu/",
          effectiveDirective: "script-src",
          blockedURL: "https://evil.example.com/x.js",
          disposition: "report",
        },
      },
    ]);
    const resp = await POST(post(body, "application/reports+json"));
    expect(resp.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][0] as string);
    expect(logged.event).toBe("csp-violation");
    expect(logged.blockedUri).toBe("https://evil.example.com/x.js");
    expect(logged.effectiveDirective).toBe("script-src");
  });

  it("ignores non-csp-violation entries in a reports+json array", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify([
      { type: "deprecation", body: { id: "old-api" } },
      {
        type: "csp-violation",
        body: { blockedURL: "https://evil.example.com/y.js" },
      },
    ]);
    const resp = await POST(post(body, "application/reports+json"));
    expect(resp.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0] as string).blockedUri).toBe(
      "https://evil.example.com/y.js",
    );
  });
});
