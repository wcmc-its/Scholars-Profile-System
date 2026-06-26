/**
 * Search reason-from-doc (lazy key papers, §5, commit 5) — `fetchKeyPaper` and
 * the card's patch helpers.
 *
 *   - `fetchKeyPaper` returns the same `RepresentativePub` shape the inline
 *     rep-pub did (pmid/title/titleHtml/year), scoped to ONE scholar + the
 *     resolved concept subtree, highlighting the literal query.
 *   - `reasonWantsKeyPaper` / `patchKeyPaper` — the card renders the reason line
 *     WITHOUT a key paper, then patches the fetched pub into it.
 */
import { describe, expect, it, vi } from "vitest";

// Capture the body `fetchKeyPaper` sends so we can assert the scholar + concept
// scoping and the size-3 top-papers fetch.
const captured: Array<Record<string, unknown>> = [];
const keyPaperHit = {
  _source: { pmid: 42424242, title: "Glandular adenocarcinoma sequencing", year: 2023 },
  highlight: { title: ["Glandular <mark>adenocarcinoma</mark> sequencing"] },
};

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) } },
}));

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_METHOD_CONTEXT_BOOST: 0.5,
  PEOPLE_TOPIC_METHOD_CONTEXT_BOOST: 0.8,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      captured.push(JSON.parse(JSON.stringify(req.body)));
      return { body: { hits: { hits: [keyPaperHit] } } };
    },
  }),
}));

import { fetchKeyPaper } from "@/lib/api/search";
import {
  reasonWantsKeyPaper,
  patchKeyPaper,
} from "@/components/search/people-result-card-streamed";

// With the default env (no SEARCH_PUB_RELEVANCE_RECENCY → "gentle"), `body.query`
// is wrapped in a `function_score` whose `.query` holds the bool. Unwrap to the
// bool whether or not the wrapper is present, so the admission assertions hold.
type BoolQuery = { bool: { filter: unknown[]; should?: unknown[] } };
const boolOf = (q: unknown): BoolQuery["bool"] => {
  const wrapped = q as { function_score?: { query: BoolQuery } } & Partial<BoolQuery>;
  return wrapped.function_score ? wrapped.function_score.query.bool : (q as BoolQuery).bool;
};

describe("fetchKeyPaper (lazy key paper)", () => {
  it("returns up to 3 RepresentativePubs with highlighted titles", async () => {
    captured.length = 0;
    const pubs = await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno", "Dcyst"],
      contentQuery: "adenocarcinoma",
    });
    expect(pubs).toEqual([
      {
        pmid: "42424242",
        title: "Glandular adenocarcinoma sequencing",
        titleHtml: "Glandular <mark>adenocarcinoma</mark> sequencing",
        year: 2023,
      },
    ]);
  });

  it("scopes the query to ONE scholar and the resolved concept subtree, top 3", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno", "Dcyst"],
      contentQuery: "adenocarcinoma",
    });
    const body = captured[0];
    expect(body.size).toBe(3);
    const filter = boolOf(body.query).filter;
    expect(filter).toContainEqual({ term: { wcmAuthorCwids: "abc1234" } });
    expect(filter).toContainEqual({ terms: { meshDescriptorUi: ["Dadeno", "Dcyst"] } });
  });

  it("falls back to a free-text scan when no concept resolved", async () => {
    captured.length = 0;
    await fetchKeyPaper({ cwid: "abc1234", descriptorUis: [], contentQuery: "16s rna" });
    const filter = boolOf(captured[0].query).filter;
    expect(filter).toContainEqual({ term: { wcmAuthorCwids: "abc1234" } });
    expect(filter.some((f) => JSON.stringify(f).includes("multi_match"))).toBe(true);
  });

  it("ranks by relevance (_score) first, then year, then citationCount", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "adenocarcinoma",
    });
    const sort = captured[0].sort as Array<Record<string, unknown>>;
    expect(sort[0]).toHaveProperty("_score");
    expect((sort[0] as { _score: { order: string } })._score.order).toBe("desc");
    expect(sort[1]).toHaveProperty("year");
    expect(sort[2]).toHaveProperty("citationCount");
  });

  it("injects a keyword-relevance `should` multi_match on the content query", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "adenocarcinoma",
    });
    const should = boolOf(captured[0].query).should ?? [];
    expect(should.some((s) => JSON.stringify(s).includes("adenocarcinoma"))).toBe(true);
    expect(should.some((s) => JSON.stringify(s).includes("multi_match"))).toBe(true);
  });

  it("wraps the query in a function_score recency tilt under the default (gentle) env", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "adenocarcinoma",
    });
    const q = captured[0].query as { function_score?: { query: BoolQuery } };
    expect(q.function_score).toBeDefined();
    expect(q.function_score?.query.bool).toBeDefined();
  });

  it("returns [] when there is neither a concept nor a query (nothing to fetch)", async () => {
    captured.length = 0;
    const pubs = await fetchKeyPaper({ cwid: "abc1234", descriptorUis: [], contentQuery: "" });
    expect(pubs).toEqual([]);
    expect(captured).toHaveLength(0); // no OpenSearch round-trip
  });

  it("returns [] when the cwid is empty", async () => {
    const pubs = await fetchKeyPaper({ cwid: "", descriptorUis: ["Dadeno"], contentQuery: "x" });
    expect(pubs).toEqual([]);
  });
});

describe("card key-paper patch helpers", () => {
  const taggedReason = { icon: "publications" as const, text: "14 of 372 publications tagged HIV" };
  const rep = { pmid: "1", title: "Key paper", year: 2024 };

  it("a pub-evidence reason with no pub wants a key paper", () => {
    expect(reasonWantsKeyPaper(taggedReason)).toBe(true);
  });

  it("a reason that already carries a pub does not re-fetch", () => {
    expect(reasonWantsKeyPaper({ ...taggedReason, pub: rep })).toBe(false);
  });

  it("a method/topic (kind) reason never takes a key paper", () => {
    expect(reasonWantsKeyPaper({ kind: "method", family: "Flow cytometry", tools: [] })).toBe(false);
    expect(reasonWantsKeyPaper({ kind: "topic", label: "Cardiology" })).toBe(false);
  });

  it("a concept-fallback reason does not take a key paper", () => {
    expect(reasonWantsKeyPaper({ icon: "concept", text: "via related concept HIV" })).toBe(false);
  });

  it("undefined reason wants nothing", () => {
    expect(reasonWantsKeyPaper(undefined)).toBe(false);
  });

  it("patchKeyPaper overlays the pub onto the reason, leaving the rest of the hit intact", () => {
    const hit = { cwid: "abc1234", matchReason: taggedReason, slug: "x" } as never;
    const patched = patchKeyPaper(hit, rep) as {
      cwid: string;
      slug: string;
      matchReason: { text: string; pub?: typeof rep };
    };
    expect(patched.matchReason.pub).toEqual(rep);
    expect(patched.matchReason.text).toBe(taggedReason.text);
    expect(patched.cwid).toBe("abc1234");
    expect(patched.slug).toBe("x");
  });

  it("patchKeyPaper is a no-op on a method/topic (kind) reason", () => {
    const hit = { cwid: "abc1234", matchReason: { kind: "topic", label: "X" } } as never;
    expect(patchKeyPaper(hit, rep)).toBe(hit);
  });
});
