/**
 * The old->new url mapping for the #2232 news_mention repoint. The mapping must
 * come from the canonical link the research page prints, never from a string
 * substitution — the two sites do not share a slug.
 */
import { describe, expect, it } from "vitest";

import {
  mergeGroup,
  newsroomCanonical,
  rewriteSourceRef,
  type MergeableRow,
} from "@/scripts/backfills/2026-08-05-news-url-repoint";

const NEWSROOM = "https://news.weill.cornell.edu";
const CANON = `${NEWSROOM}/news/2026/07/cancer-evolution-study-reveals-biology-of-glioma-progression`;

describe("newsroomCanonical", () => {
  it("reads <link rel=canonical>", () => {
    expect(newsroomCanonical(`<link rel="canonical" href="${CANON}" />`)).toBe(CANON);
  });

  it("falls back to og:url", () => {
    expect(newsroomCanonical(`<meta property="og:url" content="${CANON}" />`)).toBe(CANON);
  });

  it("falls back to any newsroom article href in the body", () => {
    expect(newsroomCanonical(`<p>see <a href="${CANON}">the story</a></p>`)).toBe(CANON);
  });

  it("returns null when the page links nowhere on the newsroom", () => {
    expect(newsroomCanonical(`<a href="https://example.org/news/2026/07/x">x</a>`)).toBeNull();
  });

  it("ignores a newsroom link that is not an article path", () => {
    expect(newsroomCanonical(`<a href="${NEWSROOM}/people/dr-jane-roe">Jane</a>`)).toBeNull();
  });

  it("keeps percent-encoded slugs intact", () => {
    const enc = `${NEWSROOM}/news/2026/06/formalizing-%E2%80%98healthcare-of-tomorrow%E2%80%99`;
    expect(newsroomCanonical(`<link rel="canonical" href="${enc}" />`)).toBe(enc);
  });

  it("does NOT reduce to a slug substitution — the sites differ on stopwords", () => {
    const oldUrl =
      "https://research.weill.cornell.edu/about-us/news-updates/cancer-evolution-study-reveals-biology-glioma-progression";
    const resolved = newsroomCanonical(`<link rel="canonical" href="${CANON}" />`)!;
    // "biology-glioma" vs "biology-of-glioma": a REPLACE() of the origin+prefix
    // would have produced a dead link.
    expect(resolved).not.toBe(oldUrl.replace(/.*\/news-updates\//, `${NEWSROOM}/news/2026/07/`));
    expect(resolved).toContain("biology-of-glioma");
  });
});

describe("rewriteSourceRef", () => {
  const oldUrl = "https://research.weill.cornell.edu/about-us/news-updates/a";
  const newUrl = `${NEWSROOM}/news/2026/07/a`;

  it("swaps the url stem and keeps the detected name", () => {
    expect(rewriteSourceRef(`${oldUrl}|Jane Roe`, oldUrl, newUrl)).toBe(`${newUrl}|Jane Roe`);
  });

  it("passes null through (VIVO/CURATOR rows carry no sourceRef)", () => {
    expect(rewriteSourceRef(null, oldUrl, newUrl)).toBeNull();
  });

  it("leaves an unrelated stem alone rather than corrupting it", () => {
    expect(rewriteSourceRef("something else|Jane Roe", oldUrl, newUrl)).toBe(
      "something else|Jane Roe",
    );
  });

  it("keeps a name containing a pipe intact", () => {
    expect(rewriteSourceRef(`${oldUrl}|A|B`, oldUrl, newUrl)).toBe(`${newUrl}|A|B`);
  });
});

describe("mergeGroup", () => {
  const row = (over: Partial<MergeableRow> & { id: string }): MergeableRow => ({
    status: "published",
    showOnProfile: true,
    enteredByCwid: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  it("is a no-op for the ordinary single-row group", () => {
    const r = row({ id: "a" });
    const m = mergeGroup([r]);
    expect(m.winner).toBe(r);
    expect(m.losers).toEqual([]);
  });

  it("prefers the human-touched row as the survivor", () => {
    const m = mergeGroup([
      row({ id: "etl", createdAt: new Date("2026-06-01T00:00:00Z") }),
      row({ id: "human", enteredByCwid: "abc1001" }),
    ]);
    expect(m.winner.id).toBe("human");
    expect(m.losers.map((l) => l.id)).toEqual(["etl"]);
  });

  it("falls back to the oldest row, so re-runs pick the same survivor", () => {
    const pick = () =>
      mergeGroup([
        row({ id: "new", createdAt: new Date("2026-07-05T00:00:00Z") }),
        row({ id: "old", createdAt: new Date("2026-06-01T00:00:00Z") }),
      ]).winner.id;
    expect(pick()).toBe("old");
    expect(pick()).toBe("old");
  });

  it("a hide ANYWHERE in the group survives the merge", () => {
    // Losing a scholar's hide would republish content they explicitly hid.
    const m = mergeGroup([row({ id: "a" }), row({ id: "b", showOnProfile: false })]);
    expect(m.showOnProfile).toBe(false);
  });

  it("'rejected' is terminal and outranks the winner's own status", () => {
    const m = mergeGroup([
      row({ id: "a", enteredByCwid: "abc1001", status: "published" }),
      row({ id: "b", status: "rejected" }),
    ]);
    expect(m.winner.id).toBe("a");
    expect(m.status).toBe("rejected");
  });

  it("carries a reviewer's identity over when the survivor has none", () => {
    const m = mergeGroup([
      row({ id: "a", createdAt: new Date("2026-06-01T00:00:00Z") }),
      row({ id: "b", enteredByCwid: "rev2002" }),
    ]);
    expect(m.enteredByCwid).toBe("rev2002");
  });
});
