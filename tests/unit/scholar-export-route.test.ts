/**
 * Tests for POST /api/export/scholars/[scope] — the #847 internal scholar-list
 * CSV export route.
 *
 * Locked v1 gate order asserted here:
 *   (a) SCHOLAR_LIST_EXPORT off                 => 404 (whole feature dark)
 *   (b) external viewer (not internal)          => 401 (session OR on-network ok)
 *   (c) scope not in the allowlist              => 404
 *   (d) method scope + METHODS_LENS_PAGES off   => 404
 *   (g) internal + flag on                      => 200 text/csv attachment,
 *                                                  <= 50 rows, NO "email" column
 *
 * #866 UC-B additions: with SCHOLAR_LIST_EXPORT_EMAIL on, an internal viewer
 * (session OR mocked on-network) gets an `email` column + a `scholar_export_email`
 * audit record; an external viewer is still 401; with the flag off there is no
 * email column.
 *
 * `resolveViewerContext` + `extractIpv4FromViewerAddress`, the flag helpers, and
 * `buildScholarExport` (the data loader the route delegates to) are mocked so no
 * DB is touched.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/export/scholars/[scope]/route";
import {
  resolveViewerContext,
  extractIpv4FromViewerAddress,
} from "@/lib/auth/viewer-context";
import {
  isScholarListExportEnabled,
  isScholarListExportEmailEnabled,
} from "@/lib/export/scholar-export-flags";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { buildScholarExport } from "@/lib/api/export-scholars";

vi.mock("@/lib/auth/viewer-context", () => ({
  resolveViewerContext: vi.fn(),
  extractIpv4FromViewerAddress: vi.fn(),
}));
vi.mock("@/lib/export/scholar-export-flags", () => ({
  isScholarListExportEnabled: vi.fn(),
  isScholarListExportEmailEnabled: vi.fn(),
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodPagesEnabled: vi.fn(),
}));
vi.mock("@/lib/api/export-scholars", () => ({ buildScholarExport: vi.fn() }));

/** Common identity columns the builder always emits, in order. */
const COMMON =
  "rank,cwid,preferred_name,postnominal,primary_title,primary_department,role_category,profile_url";
/** No-email canonical method-family header. */
const SAMPLE_HEADER = `${COMMON},pubs_in_family`;
/** Email-augmented header (email spliced right after profile_url). */
const SAMPLE_HEADER_EMAIL = `${COMMON},email,pubs_in_family`;

function sampleCsv(rowCount: number): string {
  const body = Array.from({ length: rowCount }, (_, i) =>
    [i + 1, `cwid${i}`, `Scholar ${i}`, "", "Title", "Dept", "full_time_faculty", `/slug-${i}`, 5].join(
      ",",
    ),
  );
  return [SAMPLE_HEADER, ...body].join("\r\n") + "\r\n";
}

/** Email-augmented CSV the builder mock returns when includeEmail is true. */
function sampleCsvEmail(rowCount: number): string {
  const body = Array.from({ length: rowCount }, (_, i) =>
    [
      i + 1,
      `cwid${i}`,
      `Scholar ${i}`,
      "",
      "Title",
      "Dept",
      "full_time_faculty",
      `/slug-${i}`,
      `scholar${i}@med.cornell.edu`,
      5,
    ].join(","),
  );
  return [SAMPLE_HEADER_EMAIL, ...body].join("\r\n") + "\r\n";
}

/** An internal viewer carrying a session cwid. */
const SESSION_VIEWER = { internal: true, basis: "session", cwid: "abc1234" } as const;
/** An anonymous on-WCM-network internal viewer (no cwid). */
const NETWORK_VIEWER = { internal: true, basis: "network" } as const;
/** An external viewer. */
const EXTERNAL_VIEWER = { internal: false, basis: null } as const;

function call(scope: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const req = new NextRequest("http://localhost/api/export/scholars/" + scope, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
  return POST(req, { params: Promise.resolve({ scope }) });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  // Defaults for the happy path; individual tests override.
  vi.mocked(isScholarListExportEnabled).mockReturnValue(true);
  vi.mocked(isScholarListExportEmailEnabled).mockReturnValue(false);
  vi.mocked(isMethodPagesEnabled).mockReturnValue(true);
  vi.mocked(resolveViewerContext).mockResolvedValue({ ...SESSION_VIEWER });
  vi.mocked(extractIpv4FromViewerAddress).mockReturnValue(null);
  vi.mocked(buildScholarExport).mockResolvedValue({
    filename: "Method-Family-Scholars-2026-06-10.csv",
    csv: sampleCsv(50),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(isScholarListExportEnabled).mockReset();
  vi.mocked(isScholarListExportEmailEnabled).mockReset();
  vi.mocked(isMethodPagesEnabled).mockReset();
  vi.mocked(resolveViewerContext).mockReset();
  vi.mocked(extractIpv4FromViewerAddress).mockReset();
  vi.mocked(buildScholarExport).mockReset();
});

describe("POST /api/export/scholars/[scope]", () => {
  it("(b) 401 for an external viewer (no session, off-network), flag on", async () => {
    vi.mocked(resolveViewerContext).mockResolvedValue({ ...EXTERNAL_VIEWER });
    const resp = await call("topic", { slug: "cardio" });
    expect(resp.status).toBe(401);
    expect(buildScholarExport).not.toHaveBeenCalled();
  });

  it("(b) 200 for an anonymous on-WCM-network internal viewer (no cwid)", async () => {
    vi.mocked(resolveViewerContext).mockResolvedValue({ ...NETWORK_VIEWER });
    const resp = await call("topic", { slug: "cardio" });
    expect(resp.status).toBe(200);
    expect(buildScholarExport).toHaveBeenCalled();
  });

  it("(a) 404 when SCHOLAR_LIST_EXPORT is off — even for an internal viewer", async () => {
    vi.mocked(isScholarListExportEnabled).mockReturnValue(false);
    const resp = await call("topic", { slug: "cardio" });
    expect(resp.status).toBe(404);
    // Flag-off short-circuits before the viewer context is even resolved.
    expect(resolveViewerContext).not.toHaveBeenCalled();
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

  it("(SPEC row 11) 404 when the cohort exceeds the HARD <=50 cap (builder refuses => null), even for an internal viewer", async () => {
    // The builder returns null for an over-cap cohort (same dark-feature
    // semantics as an unresolved scope) — the route must 404, never serve a
    // partial top-50, and never emit a contact audit.
    vi.mocked(isScholarListExportEmailEnabled).mockReturnValue(true);
    vi.mocked(buildScholarExport).mockResolvedValue(null);
    const resp = await call("method-family", {
      supercategory: "animal-cell-models",
      family: "crispr-screens-fam_x",
    });
    expect(resp.status).toBe(404);
    expect(console.info).not.toHaveBeenCalled();
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

  describe("#866 UC-B — email column + audit", () => {
    it("passes includeEmail=false to the builder when the email flag is off (no email column)", async () => {
      vi.mocked(isScholarListExportEmailEnabled).mockReturnValue(false);
      const resp = await call("method-family", {
        supercategory: "animal-cell-models",
        family: "crispr-screens-fam_x",
      });
      expect(resp.status).toBe(200);
      expect(buildScholarExport).toHaveBeenCalledWith(
        "method-family",
        expect.any(Object),
        undefined,
        { includeEmail: false },
      );
      const csv = await resp.text();
      expect(csv.toLowerCase()).not.toContain("email");
      // No contact-data audit fires when the column is not included.
      expect(console.info).not.toHaveBeenCalled();
    });

    it("emits the email column + a scholar_export_email audit for a session viewer when the flag is on", async () => {
      vi.mocked(isScholarListExportEmailEnabled).mockReturnValue(true);
      vi.mocked(buildScholarExport).mockResolvedValue({
        filename: "Method-Family-Scholars-2026-06-10.csv",
        csv: sampleCsvEmail(3),
      });

      const resp = await call("method-family", {
        supercategory: "animal-cell-models",
        family: "crispr-screens-fam_x",
      });
      expect(resp.status).toBe(200);
      expect(buildScholarExport).toHaveBeenCalledWith(
        "method-family",
        expect.any(Object),
        undefined,
        { includeEmail: true },
      );

      const csv = await resp.text();
      const header = csv.trim().split("\r\n")[0];
      expect(header).toContain("email");
      expect(header).toContain("profile_url,email");
      expect(csv).toContain("scholar0@med.cornell.edu");

      // Exactly one structured audit record, with the session cwid + row count.
      expect(console.info).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(vi.mocked(console.info).mock.calls[0][0] as string);
      expect(payload).toMatchObject({
        event: "scholar_export_email",
        downloader_cwid: "abc1234",
        source_ip: null,
        scope: "method-family",
        row_count: 3,
      });
      expect(typeof payload.ts).toBe("string");
    });

    it("audits an anonymous on-network download by source IP (no cwid)", async () => {
      vi.mocked(isScholarListExportEmailEnabled).mockReturnValue(true);
      vi.mocked(resolveViewerContext).mockResolvedValue({ ...NETWORK_VIEWER });
      vi.mocked(extractIpv4FromViewerAddress).mockReturnValue("203.0.113.5");
      vi.mocked(buildScholarExport).mockResolvedValue({
        filename: "Topic-Scholars-2026-06-10.csv",
        csv: sampleCsvEmail(2),
      });

      const resp = await call(
        "topic",
        { slug: "cardio" },
        { "cloudfront-viewer-address": "203.0.113.5:50000" },
      );
      expect(resp.status).toBe(200);

      expect(console.info).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(vi.mocked(console.info).mock.calls[0][0] as string);
      expect(payload).toMatchObject({
        event: "scholar_export_email",
        downloader_cwid: null,
        source_ip: "203.0.113.5",
        scope: "topic",
        row_count: 2,
      });
    });

    it("still 401s an external viewer even with the email flag on (no email ever leaks)", async () => {
      vi.mocked(isScholarListExportEmailEnabled).mockReturnValue(true);
      vi.mocked(resolveViewerContext).mockResolvedValue({ ...EXTERNAL_VIEWER });
      const resp = await call("topic", { slug: "cardio" });
      expect(resp.status).toBe(401);
      expect(buildScholarExport).not.toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
    });
  });
});
