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
import {
  collapse,
  slugAgreement,
} from "@/scripts/backfills/2026-08-06-news-dedup-duplicate-stories";

type DedupRow = Parameters<typeof collapse>[0][number];

const NEWSROOM = "https://news.weill.cornell.edu";
const CANON = `${NEWSROOM}/news/2026/07/cancer-evolution-study-reveals-biology-of-glioma-progression`;

const sourcePane = (href: string) =>
  `<div class="panel-pane pane-node-field-source-link"><div class="field-source-link">` +
  `<div class="field-label">Source link:&nbsp;</div><div class="field-content-items">` +
  `<a href="${href}">${href}…</a></div></div></div>`;

describe("newsroomCanonical", () => {
  it("reads the source-link pane", () => {
    expect(newsroomCanonical(sourcePane(CANON))).toBe(CANON);
  });

  it("reads a self-labelled anchor when the pane class is absent", () => {
    expect(newsroomCanonical(`<a href="${CANON}">${CANON}</a>`)).toBe(CANON);
  });

  it("IGNORES inline prose links to other newsroom stories (#2241)", () => {
    // The real failure: prose links appear BEFORE the source-link pane, so
    // taking the first match mis-mapped 53 of 139 staging urls to real-but-wrong
    // articles. Verbatim shape from research.../nih-grant-aims-childhood-vaccine-against-hiv.
    const prose1 = `${NEWSROOM}/news/2024/08/childhood-hiv-vaccination-strategy-shows-promise-in-study`;
    const prose2 = `${NEWSROOM}/news/2025/08/the-quest-for-an-hiv-vaccine`;
    const truth = `${NEWSROOM}/news/2025/09/nih-grant-aims-for-childhood-vaccine-against-hiv`;
    const html =
      `<p><a href="${prose1}">Prior studies </a>of the new experimental vaccine…</p>` +
      `<p>In <a href="${prose2}">research spanning the last quarter-century</a>…</p>` +
      sourcePane(truth);
    expect(newsroomCanonical(html)).toBe(truth);
  });

  it("returns null rather than guessing when only prose links exist", () => {
    // Unresolved is loud and harmless; wrong is silent and points a profile at
    // someone else's story.
    expect(
      newsroomCanonical(`<p><a href="${CANON}">Prior studies</a> of the vaccine</p>`),
    ).toBeNull();
  });

  it("returns null when the page links nowhere on the newsroom", () => {
    expect(newsroomCanonical(sourcePane("https://example.org/news/2026/07/x"))).toBeNull();
  });

  it("ignores a newsroom link that is not an article path", () => {
    expect(newsroomCanonical(sourcePane(`${NEWSROOM}/people/dr-jane-roe`))).toBeNull();
  });

  it("keeps percent-encoded slugs intact", () => {
    const enc = `${NEWSROOM}/news/2026/06/formalizing-%E2%80%98healthcare-of-tomorrow%E2%80%99`;
    expect(newsroomCanonical(sourcePane(enc))).toBe(enc);
  });

  it("does NOT reduce to a slug substitution — the sites differ on stopwords", () => {
    const oldUrl =
      "https://research.weill.cornell.edu/about-us/news-updates/cancer-evolution-study-reveals-biology-glioma-progression";
    const resolved = newsroomCanonical(sourcePane(CANON))!;
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

describe("slugAgreement / collapse — url correctness in a merge (#2241)", () => {
  const row = (over: Partial<DedupRow> & { id: string; title: string; url: string }): DedupRow => ({
    cwid: "gef4003",
    publishedAt: new Date("2025-09-18T00:00:00Z"),
    status: "published",
    showOnProfile: true,
    enteredByCwid: null,
    createdAt: new Date("2026-07-20T03:43:44Z"),
    ...over,
  });

  const TITLE = "NIH Grant Aims for Childhood Vaccine Against HIV";
  const RIGHT = `${NEWSROOM}/news/2025/09/nih-grant-aims-for-childhood-vaccine-against-hiv`;
  const WRONG = `${NEWSROOM}/news/2024/08/childhood-hiv-vaccination-strategy-shows-promise-in-study`;

  it("scores a matching slug far above a mis-mapped one", () => {
    expect(slugAgreement(TITLE, RIGHT)).toBe(1);
    expect(slugAgreement(TITLE, WRONG)).toBeLessThan(0.4);
  });

  it("the survivor adopts the CORRECT url even when the stale row wins on age", () => {
    // The mis-mapped row is the older one (it predates the repoint), so the
    // age tie-break alone would have kept a url pointing at another story.
    const out = collapse([
      row({ id: "old", title: TITLE, url: WRONG, createdAt: new Date("2026-07-20T00:00:00Z") }),
      row({ id: "new", title: TITLE, url: RIGHT, createdAt: new Date("2026-08-06T04:12:08Z") }),
    ]);
    expect(out.winner.id).toBe("old"); // review state still comes from the older row
    expect(out.url).toBe(RIGHT); // but never its bad url
    expect(out.losers.map((l) => l.id)).toEqual(["new"]);
  });

  it("a human-touched row keeps its decisions but not a mis-mapped url", () => {
    const out = collapse([
      row({ id: "human", title: TITLE, url: WRONG, enteredByCwid: "cur1", showOnProfile: false }),
      row({ id: "etl", title: TITLE, url: RIGHT, createdAt: new Date("2026-08-06T04:12:08Z") }),
    ]);
    expect(out.winner.id).toBe("human");
    expect(out.enteredByCwid).toBe("cur1");
    expect(out.showOnProfile).toBe(false); // the hide survives
    expect(out.url).toBe(RIGHT); // the url is corrected anyway
  });

  it("keeps the winner's url when both agree equally", () => {
    const out = collapse([
      row({ id: "a", title: TITLE, url: RIGHT, createdAt: new Date("2026-07-20T00:00:00Z") }),
      row({ id: "b", title: TITLE, url: RIGHT, createdAt: new Date("2026-08-06T00:00:00Z") }),
    ]);
    expect(out.url).toBe(RIGHT);
  });
});
