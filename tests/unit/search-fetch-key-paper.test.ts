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
// scoping and the size-1 single-paper fetch.
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

describe("fetchKeyPaper (lazy key paper)", () => {
  it("returns the RepresentativePub shape with a highlighted title", async () => {
    captured.length = 0;
    const pub = await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno", "Dcyst"],
      contentQuery: "adenocarcinoma",
    });
    expect(pub).toEqual({
      pmid: "42424242",
      title: "Glandular adenocarcinoma sequencing",
      titleHtml: "Glandular <mark>adenocarcinoma</mark> sequencing",
      year: 2023,
    });
  });

  it("scopes the query to ONE scholar and the resolved concept subtree, size 1", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno", "Dcyst"],
      contentQuery: "adenocarcinoma",
    });
    const body = captured[0];
    expect(body.size).toBe(1);
    const filter = (body.query as { bool: { filter: unknown[] } }).bool.filter;
    expect(filter).toContainEqual({ term: { wcmAuthorCwids: "abc1234" } });
    expect(filter).toContainEqual({ terms: { meshDescriptorUi: ["Dadeno", "Dcyst"] } });
  });

  it("falls back to a free-text scan when no concept resolved", async () => {
    captured.length = 0;
    await fetchKeyPaper({ cwid: "abc1234", descriptorUis: [], contentQuery: "16s rna" });
    const filter = (captured[0].query as { bool: { filter: unknown[] } }).bool.filter;
    expect(filter).toContainEqual({ term: { wcmAuthorCwids: "abc1234" } });
    expect(filter.some((f) => JSON.stringify(f).includes("multi_match"))).toBe(true);
  });

  it("returns undefined when there is neither a concept nor a query (nothing to fetch)", async () => {
    captured.length = 0;
    const pub = await fetchKeyPaper({ cwid: "abc1234", descriptorUis: [], contentQuery: "" });
    expect(pub).toBeUndefined();
    expect(captured).toHaveLength(0); // no OpenSearch round-trip
  });

  it("returns undefined when the cwid is empty", async () => {
    const pub = await fetchKeyPaper({ cwid: "", descriptorUis: ["Dadeno"], contentQuery: "x" });
    expect(pub).toBeUndefined();
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
