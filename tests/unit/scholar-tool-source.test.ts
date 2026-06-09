/**
 * #794 — the SCHOLAR_TOOL_SOURCE cutover switch. Default is the reversible
 * "ddb" (legacy); "s3" makes etl:scholar-tool the sole writer. Locking this
 * because flipping it changes which producer owns the scholar_tool table.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveScholarToolSource } from "@/lib/etl/scholar-tool-source";

const ORIGINAL = process.env.SCHOLAR_TOOL_SOURCE;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SCHOLAR_TOOL_SOURCE;
  else process.env.SCHOLAR_TOOL_SOURCE = ORIGINAL;
  vi.restoreAllMocks();
});

describe("resolveScholarToolSource", () => {
  it("defaults to ddb when unset", () => {
    delete process.env.SCHOLAR_TOOL_SOURCE;
    expect(resolveScholarToolSource()).toBe("ddb");
  });

  it("returns s3 only on the exact 's3' value", () => {
    process.env.SCHOLAR_TOOL_SOURCE = "s3";
    expect(resolveScholarToolSource()).toBe("s3");
  });

  it("treats an explicit 'ddb' as ddb without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SCHOLAR_TOOL_SOURCE = "ddb";
    expect(resolveScholarToolSource()).toBe("ddb");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and falls back to ddb on an unrecognized value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SCHOLAR_TOOL_SOURCE = "dynamo";
    expect(resolveScholarToolSource()).toBe("ddb");
    expect(warn).toHaveBeenCalledOnce();
  });
});
