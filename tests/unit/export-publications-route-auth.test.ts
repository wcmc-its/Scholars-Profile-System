/**
 * POST /api/export/publications/[granularity] is an internal-only surface.
 *
 * These /api/export/* routes are not covered by middleware, so the handler
 * carries the same internal-viewer gate the sibling scholars-export route uses
 * (app/api/export/scholars/[scope]/route.ts): an authenticated WCM session OR an
 * allowlisted on-network viewer may download; an external viewer => 401 and the
 * data fetchers are never reached.
 *
 * `resolveViewerContext` and the data fetchers are mocked so no DB / OpenSearch
 * is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/export/publications/[granularity]/route";
import { resolveViewerContext } from "@/lib/auth/viewer-context";
import {
  fetchAuthorshipRows,
  fetchArticleRows,
} from "@/lib/api/export-publications";
import { generateWordBibliography } from "@/lib/api/word-bibliography";

vi.mock("@/lib/auth/viewer-context", () => ({
  resolveViewerContext: vi.fn(),
}));
vi.mock("@/lib/api/export-publications", () => ({
  EXPORT_MAX_LIMIT: 5000,
  AUTHORSHIP_HEADERS: ["pmid"],
  ARTICLE_HEADERS: ["pmid"],
  fetchAuthorshipRows: vi.fn(),
  fetchArticleRows: vi.fn(),
}));
vi.mock("@/lib/api/word-bibliography", () => ({
  WORD_MAX_LIMIT: 1000,
  generateWordBibliography: vi.fn(),
}));

/** An internal viewer carrying a session cwid. */
const SESSION_VIEWER = { internal: true, basis: "session", cwid: "abc1234" } as const;
/** An anonymous on-WCM-network internal viewer (no cwid). */
const NETWORK_VIEWER = { internal: true, basis: "network" } as const;
/** An external viewer. */
const EXTERNAL_VIEWER = { internal: false, basis: null } as const;

function call(granularity: string, body: unknown = { q: "" }) {
  const req = new NextRequest(
    "http://localhost/api/export/publications/" + granularity,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
  return POST(req, { params: Promise.resolve({ granularity }) });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(resolveViewerContext).mockResolvedValue({ ...SESSION_VIEWER });
  vi.mocked(fetchAuthorshipRows).mockResolvedValue([{ pmid: "1" } as never]);
  vi.mocked(fetchArticleRows).mockResolvedValue([{ pmid: "1" } as never]);
  vi.mocked(generateWordBibliography).mockResolvedValue({
    buffer: Buffer.from("docx"),
    rowCount: 1,
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(resolveViewerContext).mockReset();
  vi.mocked(fetchAuthorshipRows).mockReset();
  vi.mocked(fetchArticleRows).mockReset();
  vi.mocked(generateWordBibliography).mockReset();
});

describe("POST /api/export/publications/[granularity] — internal-viewer gate", () => {
  it("401s an external viewer and never reaches the data fetchers", async () => {
    vi.mocked(resolveViewerContext).mockResolvedValue({ ...EXTERNAL_VIEWER });
    const resp = await call("authorship");
    expect(resp.status).toBe(401);
    expect(fetchAuthorshipRows).not.toHaveBeenCalled();
    expect(fetchArticleRows).not.toHaveBeenCalled();
  });

  it("401s an external viewer on the article granularity too", async () => {
    vi.mocked(resolveViewerContext).mockResolvedValue({ ...EXTERNAL_VIEWER });
    const resp = await call("article");
    expect(resp.status).toBe(401);
    expect(fetchArticleRows).not.toHaveBeenCalled();
  });

  it("401s an external viewer on the bibliography granularity too", async () => {
    vi.mocked(resolveViewerContext).mockResolvedValue({ ...EXTERNAL_VIEWER });
    const resp = await call("bibliography");
    expect(resp.status).toBe(401);
    expect(generateWordBibliography).not.toHaveBeenCalled();
  });

  it("200 text/csv for an authenticated session viewer", async () => {
    const resp = await call("authorship");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(fetchAuthorshipRows).toHaveBeenCalledTimes(1);
  });

  it("200 for an anonymous on-WCM-network internal viewer (no cwid)", async () => {
    vi.mocked(resolveViewerContext).mockResolvedValue({ ...NETWORK_VIEWER });
    const resp = await call("article");
    expect(resp.status).toBe(200);
    expect(fetchArticleRows).toHaveBeenCalledTimes(1);
  });
});
