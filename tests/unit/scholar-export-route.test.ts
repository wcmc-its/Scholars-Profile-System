/**
 * Tests for POST /api/export/scholars/[scope] — the #847 internal scholar-list
 * CSV export route.
 *
 * Locked v1 gate order asserted here:
 *   (a) SCHOLAR_LIST_EXPORT off                 => 404 (whole feature dark)
 *   (b) no session                              => 401 (any authed WCM session ok)
 *   (c) scope not in the allowlist              => 404
 *   (d) method scope + METHODS_LENS_PAGES off   => 404
 *   (g) authed + flag on                        => 200 text/csv attachment,
 *                                                  <= 50 rows, NO "email" column
 *
 * `getSession`, the two flag helpers, and `buildScholarExport` (the data loader
 * the route delegates to) are mocked so no DB is touched.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/export/scholars/[scope]/route";
import { getSession } from "@/lib/auth/session-server";
import { isScholarListExportEnabled } from "@/lib/export/scholar-export-flags";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { buildScholarExport } from "@/lib/api/export-scholars";

vi.mock("@/lib/auth/session-server", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/export/scholar-export-flags", () => ({
  isScholarListExportEnabled: vi.fn(),
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodPagesEnabled: vi.fn(),
}));
vi.mock("@/lib/api/export-scholars", () => ({ buildScholarExport: vi.fn() }));

/** A small valid CSV the builder mock returns for the happy path. */
const SAMPLE_HEADER =
  "rank,cwid,preferred_name,postnominal,primary_title,primary_department,role_category,profile_url,pubs_in_family";
function sampleCsv(rowCount: number): string {
  const body = Array.from({ length: rowCount }, (_, i) =>
    [i + 1, `cwid${i}`, `Scholar ${i}`, "", "Title", "Dept", "full_time_faculty", `/slug-${i}`, 5].join(
      ",",
    ),
  );
  return [SAMPLE_HEADER, ...body].join("\r\n") + "\r\n";
}

function call(scope: string, body: unknown = {}) {
  const req = new NextRequest("http://localhost/api/export/scholars/" + scope, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return POST(req, { params: Promise.resolve({ scope }) });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  // Defaults for the happy path; individual tests override.
  vi.mocked(isScholarListExportEnabled).mockReturnValue(true);
  vi.mocked(isMethodPagesEnabled).mockReturnValue(true);
  vi.mocked(getSession).mockResolvedValue({ cwid: "abc1234" } as never);
  vi.mocked(buildScholarExport).mockResolvedValue({
    filename: "Method-Family-Scholars-2026-06-10.csv",
    csv: sampleCsv(50),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(isScholarListExportEnabled).mockReset();
  vi.mocked(isMethodPagesEnabled).mockReset();
  vi.mocked(getSession).mockReset();
  vi.mocked(buildScholarExport).mockReset();
});

describe("POST /api/export/scholars/[scope]", () => {
  it("(b) 401 for an anonymous viewer (no session), flag on", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const resp = await call("topic", { slug: "cardio" });
    expect(resp.status).toBe(401);
    expect(buildScholarExport).not.toHaveBeenCalled();
  });

  it("(a) 404 when SCHOLAR_LIST_EXPORT is off — even for an authed session", async () => {
    vi.mocked(isScholarListExportEnabled).mockReturnValue(false);
    const resp = await call("topic", { slug: "cardio" });
    expect(resp.status).toBe(404);
    // Flag-off short-circuits before the session is even read.
    expect(getSession).not.toHaveBeenCalled();
    expect(buildScholarExport).not.toHaveBeenCalled();
  });

  it("(c) 404 for a scope not in the allowlist", async () => {
    const resp = await call("department", { slug: "x" });
    expect(resp.status).toBe(404);
    expect(buildScholarExport).not.toHaveBeenCalled();
  });

  it("(d) 404 for the method-family scope when METHODS_LENS_PAGES is off", async () => {
    vi.mocked(isMethodPagesEnabled).mockReturnValue(false);
    const resp = await call("method-family", {
      supercategory: "animal-cell-models",
      family: "crispr-screens-fam_x",
    });
    expect(resp.status).toBe(404);
    expect(buildScholarExport).not.toHaveBeenCalled();
  });

  it("(g) 200 text/csv attachment, <= 50 rows, NO email column (authed + flag on)", async () => {
    const resp = await call("method-family", {
      supercategory: "animal-cell-models",
      family: "crispr-screens-fam_x",
    });
    expect(resp.status).toBe(200);

    // text/csv content type.
    expect(resp.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");

    // Content-Disposition attachment with the server-stamped filename.
    const disposition = resp.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    const match = /filename="([^"]+)"/.exec(disposition);
    expect(match?.[1]).toMatch(/^Method-Family-Scholars-\d{4}-\d{2}-\d{2}\.csv$/);

    // No-store, never edge-cached.
    expect(resp.headers.get("Cache-Control")).toBe("no-store");

    const csv = await resp.text();
    const lines = csv.trim().split("\r\n");
    const header = lines[0];
    const body = lines.slice(1);

    // <= 50 body rows (the cap).
    expect(body.length).toBeLessThanOrEqual(50);
    expect(body.length).toBe(50);

    // Header row carries NO email/contact column, ever.
    expect(header.toLowerCase()).not.toContain("email");
    expect(header.toLowerCase()).not.toContain("phone");
    expect(csv.toLowerCase()).not.toContain("email");
  });

  it("returns 404 when the scope target does not resolve (builder => null)", async () => {
    vi.mocked(buildScholarExport).mockResolvedValue(null);
    const resp = await call("topic", { slug: "nope" });
    expect(resp.status).toBe(404);
  });

  it("returns 400 on a structurally invalid (non-JSON) body", async () => {
    const req = new NextRequest("http://localhost/api/export/scholars/topic", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const resp = await POST(req, { params: Promise.resolve({ scope: "topic" }) });
    expect(resp.status).toBe(400);
    expect(buildScholarExport).not.toHaveBeenCalled();
  });
});
