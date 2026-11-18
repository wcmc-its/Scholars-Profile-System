/**
 * The publications CSV export carries a "translationalStage" column: appended
 * LAST on both granularities (existing column positions do not move), holding
 * the display text ("T2 · Clinical trials and efficacy") or an empty cell when
 * the paper has no displayable stage (`displayStage`: NA, unknown, low
 * confidence, or none recorded). The route drops the column while
 * SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stageCols = vi.hoisted(() => ({
  translationalStage: null as string | null,
  translationalStageConfidence: null as string | null,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    suppression: { findMany: vi.fn(async () => []) },
    publication: {
      findMany: vi.fn(async () => [
        {
          pmid: "12345678",
          title: "A fixture paper",
          year: 2024,
          journal: "Journal of Test Fixtures",
          doi: null,
          pmcid: null,
          dateAddedToEntrez: null,
          citationCount: 3,
          publicationType: "Journal Article",
          authorsString: "Ainsworth Q",
          fullAuthorsString: "Ainsworth Q",
          ...stageCols,
          authors: [
            {
              isFirst: true,
              isLast: true,
              isPenultimate: false,
              totalAuthors: 1,
              scholar: {
                cwid: "abc1234",
                preferredName: "Ainsworth Quinn",
                primaryDepartment: "Medicine",
              },
            },
          ],
        },
      ]),
    },
  },
}));

vi.mock("@/lib/search", () => ({
  PUBLICATIONS_INDEX: "scholars-publications",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  searchClient: () => ({
    async search() {
      return { body: { hits: { hits: [{ _source: { pmid: "12345678" } }] } } };
    },
  }),
}));

vi.mock("@/lib/auth/viewer-context", () => ({
  resolveViewerContext: vi.fn(async () => ({ internal: true, basis: "session", cwid: "abc1234" })),
}));

import {
  ARTICLE_HEADERS,
  AUTHORSHIP_HEADERS,
  fetchArticleRows,
  fetchAuthorshipRows,
} from "@/lib/api/export-publications";
import { POST } from "@/app/api/export/publications/[granularity]/route";

function setStage(stage: string | null, confidence: string | null) {
  stageCols.translationalStage = stage;
  stageCols.translationalStageConfidence = confidence;
}

async function csvLines(granularity: string): Promise<string[]> {
  const req = new Request(`http://localhost/api/export/publications/${granularity}`, {
    method: "POST",
    body: JSON.stringify({ q: "" }),
  });
  const resp = await POST(req as never, { params: Promise.resolve({ granularity }) });
  expect(resp.status).toBe(200);
  return (await resp.text()).replace(/^﻿/, "").trim().split(/\r?\n/);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  setStage(null, null);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET;
});

describe("publications export — translational stage column", () => {
  it("is the last column of both header arrays", () => {
    expect(ARTICLE_HEADERS.at(-1)).toBe("translationalStage");
    expect(AUTHORSHIP_HEADERS.at(-1)).toBe("translationalStage");
    // Existing columns keep their positions.
    expect(ARTICLE_HEADERS.at(-2)).toBe("authors");
    expect(AUTHORSHIP_HEADERS.at(-2)).toBe("authorPosition");
  });

  it("carries the display text on both row shapes", async () => {
    setStage("T2", "high");
    expect((await fetchArticleRows({ q: "" }))[0]!.translationalStage).toBe(
      "T2 · Clinical trials and efficacy",
    );
    expect((await fetchAuthorshipRows({ q: "" }))[0]!.translationalStage).toBe(
      "T2 · Clinical trials and efficacy",
    );
  });

  it("shows a stage with no confidence recorded", async () => {
    setStage("T3-4", null);
    expect((await fetchArticleRows({ q: "" }))[0]!.translationalStage).toBe(
      "T3–4 · Practice and population health",
    );
  });

  it.each([
    [null, null],
    ["NA", "high"],
    ["T1", "low"],
  ])("is empty for a paper with no displayable stage (%s / %s)", async (stage, confidence) => {
    setStage(stage, confidence);
    expect((await fetchArticleRows({ q: "" }))[0]!.translationalStage).toBe("");
    expect((await fetchAuthorshipRows({ q: "" }))[0]!.translationalStage).toBe("");
  });
});

describe("POST /api/export/publications — stage column gated by its flag", () => {
  it.each(["article", "authorship"])("flag ON: %s CSV ends with the stage column", async (g) => {
    process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET = "on";
    setStage("T0", "medium");
    const [header, row] = await csvLines(g);
    expect(header!.endsWith(",translationalStage")).toBe(true);
    expect(row!.endsWith("T0 · Basic research")).toBe(true);
  });

  it.each(["article", "authorship"])("flag OFF: %s CSV has no stage column", async (g) => {
    setStage("T0", "medium");
    const [header, row] = await csvLines(g);
    expect(header).not.toContain("translationalStage");
    expect(row).not.toContain("Basic research");
  });
});
