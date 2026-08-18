/**
 * #2484 — `suggestNames` (lib/api/search.ts), the name-typeahead completion-
 * suggester query behind GET /api/search/suggest.
 *
 * Root cause: `buildPeopleDoc` (lib/search-index-docs.ts) indexes a
 * last-name-only `nameSuggest` input at a fixed weight (95) whose surface
 * text is just the surname — every scholar sharing a surname contributes an
 * identical-text option at the same weight. OpenSearch's completion
 * suggester with `skip_duplicates: true` only dedupes within a candidate
 * window proportional to the requested `completion.size`, so when 3+
 * same-surname scholars tie at weight 95 and `completion.size` equals the
 * small caller-facing `size` (5), the suggester can collapse the tie down to
 * a single survivor and never reach the next tier of legitimately-distinct
 * inputs (e.g. "Bender, Heidi Bender" at weight 90). Confirmed live in prod:
 * GET /api/search/suggest?q=Bender surfaced only Anna Bender, never Heidi.
 *
 * These tests don't (and can't, without a live cluster) reproduce OpenSearch's
 * internal windowing — the live repro in #2484 already established that. They
 * verify our side of the fix: given a raw completion-suggester response that
 * contains the same-text collision (multiple distinct cwids sharing a surface
 * form) alongside each scholar's distinct lower-weight input, `suggestNames`
 * must dedupe by cwid (first occurrence = highest weight, since options
 * arrive pre-sorted) and then truncate back down to the caller-facing `size`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}));

// Every scholar below shares the surname "Bender" — its weight-95 nameSuggest
// input is byte-identical text ("Bender") across all three docs. Each also has
// a distinct, lower-weight "Last, Full Name" input. Simulates the raw options
// OpenSearch could return once `suggestNames` widens `completion.size` past
// the caller-facing `size` (the over-fetch is what gives skip_duplicates room
// to reach past the tied "Bender" collision to those distinct inputs at all —
// see #2484). The mock always returns this full raw set: these tests check
// `suggestNames`'s own dedupe+truncate, not OpenSearch's internal windowing.
const RAW_SUGGEST_OPTIONS = [
  { text: "Bender", _index: "scholars-people", _id: "cwid-anna" },
  { text: "Bender", _index: "scholars-people", _id: "cwid-heidi" },
  { text: "Bender", _index: "scholars-people", _id: "cwid-carol" },
  { text: "Bender, Anna Bender", _index: "scholars-people", _id: "cwid-anna" },
  { text: "Bender, Heidi Bender", _index: "scholars-people", _id: "cwid-heidi" },
  { text: "Bender, Carol Bender", _index: "scholars-people", _id: "cwid-carol" },
];

const SOURCE_BY_CWID: Record<string, Record<string, unknown>> = {
  "cwid-anna": {
    slug: "anna-bender",
    preferredName: "Anna Bender",
    primaryTitle: "Research Associate",
    primaryDepartment: "Medicine",
    personType: "affiliated_faculty",
    lastNameSort: "bender",
    pubCountBucket: 1,
  },
  "cwid-heidi": {
    slug: "heidi-bender",
    preferredName: "Heidi Bender",
    primaryTitle: "Professor",
    primaryDepartment: "Medicine",
    personType: "full_time_faculty",
    lastNameSort: "bender",
    pubCountBucket: 3,
  },
  "cwid-carol": {
    slug: "carol-bender",
    preferredName: "Carol Bender",
    primaryTitle: "Postdoctoral Associate",
    primaryDepartment: "Medicine",
    personType: "postdoc",
    lastNameSort: "bender",
    pubCountBucket: 0,
  },
};

// Captured across calls so tests can assert what suggestNames actually asked
// OpenSearch for (completion.size) and hydrated via mget (ids) — i.e. that the
// over-fetch and the post-dedupe truncation both actually fired.
const capturedSearchBodies: Array<Record<string, unknown>> = [];
const capturedMgetIds: string[][] = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedSearchBodies.push(req.body);
      return {
        body: {
          suggest: {
            scholar: [{ options: RAW_SUGGEST_OPTIONS }],
          },
        },
      };
    },
    async mget(req: { body: { ids: string[] } }) {
      capturedMgetIds.push(req.body.ids);
      return {
        body: {
          docs: req.body.ids.map((id) => ({
            _id: id,
            _source: SOURCE_BY_CWID[id],
          })),
        },
      };
    },
  }),
}));

import { suggestNames } from "@/lib/api/search";

describe("suggestNames — same-surname collision (#2484)", () => {
  it("requests a larger completion.size than the caller-facing size (over-fetch headroom)", async () => {
    capturedSearchBodies.length = 0;
    await suggestNames("Bender", 5);
    const suggest = capturedSearchBodies[0]?.suggest as {
      scholar: { completion: { size: number } };
    };
    expect(suggest.scholar.completion.size).toBeGreaterThan(5);
  });

  it("returns all 3 distinct same-surname scholars, not just the first collapsed survivor", async () => {
    const result = await suggestNames("Bender", 5);
    const cwids = result.map((r) => r.cwid);
    expect(new Set(cwids)).toEqual(
      new Set(["cwid-anna", "cwid-heidi", "cwid-carol"]),
    );
    // In particular, the scholar the live-prod bug dropped must be present.
    expect(cwids).toContain("cwid-heidi");
  });

  it("dedupes by cwid — a scholar contributing multiple surviving options (surname + 'Last, Full Name') appears once", async () => {
    const result = await suggestNames("Bender", 5);
    const heidiEntries = result.filter((r) => r.cwid === "cwid-heidi");
    expect(heidiEntries).toHaveLength(1);
  });

  it("truncates the deduped list to the caller-facing size, even though the over-fetched raw response has more distinct cwids", async () => {
    capturedMgetIds.length = 0;
    const result = await suggestNames("Bender", 2);
    expect(result.length).toBe(2);
    // First-seen order (options arrive pre-sorted by weight desc): the two
    // highest-weight distinct survivors, not an arbitrary pair.
    expect(result.map((r) => r.cwid)).toEqual(["cwid-anna", "cwid-heidi"]);
    // The mget hydration call — and so its cost — reflects only the truncated
    // list, not the larger raw over-fetch (#2484 fix requirement 3).
    expect(capturedMgetIds[0]).toEqual(["cwid-anna", "cwid-heidi"]);
  });

  it("never returns more entries than the requested size", async () => {
    const result = await suggestNames("Bender", 1);
    expect(result.length).toBeLessThanOrEqual(1);
  });
});
