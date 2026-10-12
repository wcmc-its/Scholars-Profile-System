/**
 * Newsroom honors (#3040, etl/honors/newsroom.ts): feed parsing, the screen,
 * normalization onto existing honor strings (the duplicate risk), attribution,
 * and the planning rules shared with the roster scraper. Every name is invented.
 */
import { describe, expect, it } from "vitest";

import { buildScholarIndex } from "@/etl/honors/lists/match";
import { HONORS_SCRAPER_ACTOR } from "@/etl/honors/lists/plan";
import {
  annotatedText,
  type ExtractedHonor,
  normalizeHonor,
  type NewsroomExisting,
  type NewsroomPost,
  parseFeedPage,
  planNewsroom,
  screenPost,
  scrapeNewsroom,
  walkFeed,
} from "@/etl/honors/newsroom";
import { rosterKey, rosterMatchedName } from "@/lib/edit/honor-queue";
import { honorListById, NEWSROOM_LIST_ID, NEWSROOM_ROSTER_URL } from "@/lib/honors/lists";

const META = honorListById(NEWSROOM_LIST_ID)!;
const INDEX = buildScholarIndex([
  { cwid: "zzq9001", preferredName: "Quentin Anvilworth", fullName: "Quentin Arlo Anvilworth" },
  { cwid: "zzq9002", preferredName: "Beatrix Brambleton", fullName: "Beatrix Lorna Brambleton" },
  { cwid: "zzq9003", preferredName: "Prudence Lanternhook", fullName: "Prudence Lanternhook" },
]);
const VOCAB = [
  { organization: "National Academy of Medicine", name: "Member" },
  { organization: "American Society for Clinical Investigation", name: "Member" },
];

const URL1 = `${NEWSROOM_ROSTER_URL}/2026/10/dr-anvilworth-elected`;

const story = (over: Record<string, string> = {}) => ({
  story: {
    path: URL1,
    title: "Dr. Quentin Anvilworth Elected to the National Academy of Medicine",
    field_story_teaser: "He joins the academy.",
    field_story_type: "Awards &amp; Honors",
    field_story_post_date: "October 6, 2026",
    field_story_body:
      '<p><a href="https://vivo.weill.cornell.edu/display/cwid-ZZQ9001">Dr. Quentin Anvilworth</a> was elected to the National Academy of Medicine.</p>',
    ...over,
  },
});

const post = (over: Partial<NewsroomPost> = {}): NewsroomPost => ({
  url: URL1,
  title: "t",
  storyType: "Awards & Honors",
  publishedAt: "2026-10-06",
  cwids: [],
  text: "Dr. Quentin Anvilworth was elected to the National Academy of Medicine. Dr. Beatrix Brambleton won the Quillfeather Prize.",
  ...over,
});

const honor = (over: Partial<ExtractedHonor> = {}): ExtractedHonor => ({
  scholarName: "Quentin Anvilworth",
  cwid: null,
  honorName: "member",
  organization: "Institute of Medicine",
  year: null,
  category: "ACADEMY_MEMBERSHIP",
  quote: "Dr. Quentin Anvilworth was elected to the National Academy of Medicine.",
  ...over,
});

describe("feed parsing", () => {
  it("keeps the story type, cwids, and marks each VIVO link after its name", () => {
    const [p] = parseFeedPage(JSON.stringify({ news_stories: [story()] }));
    expect(p.storyType).toBe("Awards & Honors");
    expect(p.publishedAt).toBe("2026-10-06");
    expect(p.cwids).toEqual(["zzq9001"]);
    expect(p.text).toBe(
      "Dr. Quentin Anvilworth [cwid-zzq9001] was elected to the National Academy of Medicine.",
    );
  });

  it("drops a story off the newsroom origin", () => {
    const out = parseFeedPage(
      JSON.stringify({ news_stories: [story({ path: "https://example.org/news/x" })] }),
    );
    expect(out).toEqual([]);
  });

  it("annotates only VIVO links", () => {
    expect(annotatedText('<a href="https://example.org">Elsewhere</a> text')).toBe(
      "Elsewhere text",
    );
  });
});

describe("screen", () => {
  it("takes every Awards & Honors post", () => {
    expect(screenPost({ storyType: "Awards & Honors", title: "Convocation" })).toBe(true);
  });
  it("takes an honor-shaped News from WCM post (the category misses some)", () => {
    expect(
      screenPost({ storyType: "News from WCM", title: "Dr. X Wins NIH Director's Pioneer Award" }),
    ).toBe(true);
  });
  it("ignores honor words in a research story's teaser", () => {
    const [p] = parseFeedPage(
      JSON.stringify({
        news_stories: [
          story({
            title: "Study Reveals How a Lipid Tunes Vision",
            field_story_type: "News from WCM",
            field_story_teaser: "Investigators named a new pathway.",
          }),
        ],
      }),
    );
    expect(screenPost(p)).toBe(false);
  });
  it("rejects grant posts and plain news", () => {
    expect(screenPost({ storyType: "News from WCM", title: "NIH Grant Awarded to Study Y" })).toBe(
      false,
    );
    expect(screenPost({ storyType: "News from WCM", title: "New Imaging Center Opens" })).toBe(
      false,
    );
  });
});

describe("normalizeHonor", () => {
  it("maps an alias and a case variant onto the strings already in use", () => {
    expect(
      normalizeHonor({ organization: "Institute of Medicine", honorName: "member" }, VOCAB),
    ).toEqual({
      organization: "National Academy of Medicine",
      name: "Member",
    });
    expect(
      normalizeHonor(
        { organization: "the American Society for Clinical Investigation", honorName: "Member" },
        VOCAB,
      ),
    ).toEqual({ organization: "American Society for Clinical Investigation", name: "Member" });
  });

  it("keeps an unknown honor as extracted", () => {
    expect(
      normalizeHonor(
        { organization: "Quillfeather Society", honorName: "Quillfeather Prize" },
        VOCAB,
      ),
    ).toEqual({
      organization: "Quillfeather Society",
      name: "Quillfeather Prize",
    });
  });

  it("does not guess the ambiguous AAAS", () => {
    expect(normalizeHonor({ organization: "AAAS", honorName: "Fellow" }, VOCAB).organization).toBe(
      "AAAS",
    );
  });
});

describe("planNewsroom", () => {
  const plan = (honors: ExtractedHonor[], existing: NewsroomExisting[] = [], p = post()) =>
    planNewsroom(META, [{ post: p, honors }], INDEX, existing, VOCAB);

  it("proposes a pending row under the canonical strings, linking the article", () => {
    const out = plan([honor()]);
    expect(out.creates).toHaveLength(1);
    const row = out.creates[0];
    expect(row).toMatchObject({
      cwid: "zzq9001",
      organization: "National Academy of Medicine",
      name: "Member",
      status: "pending",
      year: 2026,
      source: "NEWSROOM",
      enteredByCwid: HONORS_SCRAPER_ACTOR,
    });
    expect(row.evidence).toBe(
      "“Dr. Quentin Anvilworth was elected to the National Academy of Medicine.”",
    );
    expect(rosterKey(row.sourceRef)).toBe(NEWSROOM_ROSTER_URL);
    expect(rosterMatchedName(row.sourceRef)).toBe("Quentin Anvilworth");
    expect(row.sourceRef.startsWith(`${URL1}#`)).toBe(true);
  });

  it("never re-proposes an honor the scholar already has in any status (the seed's strings)", () => {
    for (const status of ["published", "pending", "rejected"] as const) {
      const out = plan(
        [honor()],
        [
          {
            id: "h1",
            cwid: "zzq9001",
            status,
            evidence: "x",
            sourceRef: null,
            organization: "national academy of medicine",
            name: "MEMBER",
          },
        ],
      );
      expect(out.creates).toEqual([]);
    }
  });

  it("fills a missing evidence line on a pending row only", () => {
    const out = plan(
      [honor()],
      [
        {
          id: "h1",
          cwid: "zzq9001",
          status: "pending",
          evidence: null,
          sourceRef: null,
          organization: "National Academy of Medicine",
          name: "Member",
        },
      ],
    );
    expect(out.evidenceFills).toEqual([{ id: "h1", evidence: expect.stringContaining("elected") }]);
  });

  it("uses the article's VIVO link when the model reports it, even under another name", () => {
    const out = plan(
      [honor({ scholarName: "Q. Arlo Anvilworth", cwid: "zzq9001" })],
      [],
      post({ cwids: ["zzq9001"], text: "Dr. Q. Arlo Anvilworth [cwid-zzq9001] was elected." }),
    );
    expect(out.creates.map((c) => c.cwid)).toEqual(["zzq9001"]);
  });

  it("ignores a cwid the article does not link", () => {
    const out = plan(
      [honor({ scholarName: "Q. Anvilworth", cwid: "zzq9003" })],
      [],
      post({ text: "Dr. Q. Anvilworth was elected." }),
    );
    expect(out.creates).toEqual([]);
  });

  it("drops a person the post never names (a model invention)", () => {
    expect(plan([honor({ scholarName: "Prudence Lanternhook" })]).creates).toEqual([]);
  });

  it("keeps two honors for one person in one post as two lines", () => {
    const out = plan([
      honor(),
      honor({ organization: "American Society for Clinical Investigation", honorName: "Member" }),
    ]);
    expect(out.creates).toHaveLength(2);
    expect(new Set(out.creates.map((c) => c.sourceRef)).size).toBe(2);
  });

  it("proposes an honor announced twice (standalone + roundup) once", () => {
    const out = planNewsroom(
      META,
      [
        { post: post(), honors: [honor()] },
        { post: post({ url: `${NEWSROOM_ROSTER_URL}/2026/10/roundup` }), honors: [honor()] },
      ],
      INDEX,
      [],
      VOCAB,
    );
    expect(out.creates).toHaveLength(1);
  });

  it("keeps a hyphenated surname", () => {
    const idx = buildScholarIndex([
      { cwid: "zzq9004", preferredName: "Maren Ostwick-Pell", fullName: "Maren Ostwick-Pell" },
    ]);
    const out = planNewsroom(
      META,
      [
        {
          post: post({ text: "Dr. Maren Ostwick-Pell was elected." }),
          honors: [honor({ scholarName: "Maren Ostwick-Pell" })],
        },
      ],
      idx,
      [],
      VOCAB,
    );
    expect(out.creates.map((c) => c.cwid)).toEqual(["zzq9004"]);
  });

  it("does not trust a linked cwid the model paired with someone else's name", () => {
    const out = plan(
      [honor({ scholarName: "Beatrix Brambleton", cwid: "zzq9001" })],
      [],
      post({ cwids: ["zzq9001"] }),
    );
    expect(out.creates.map((c) => c.cwid)).toEqual(["zzq9002"]);
  });

  it("never re-proposes a scholar from an article they already have a row from, however the honor is worded", () => {
    const out = plan(
      [honor({ honorName: "Elected Member" })],
      [
        {
          id: "h1",
          cwid: "zzq9001",
          status: "rejected",
          evidence: "x",
          organization: "National Academy of Medicine",
          name: "Member",
          sourceRef: `${URL1}#national-academy-of-medicine-member|Quentin Anvilworth|2026`,
        },
      ],
    );
    expect(out.creates).toEqual([]);
  });

  it("prefers the honor's own year over the post date", () => {
    expect(plan([honor({ year: 2025 })]).creates[0].year).toBe(2025);
  });
});

describe("walk + run", () => {
  const page = (stories: unknown[]) => JSON.stringify({ news_stories: stories });

  it("stops at the weekly floor and only sends screened posts to the model", async () => {
    const pages: Record<number, string> = {
      0: page([
        story(),
        story({
          path: `${NEWSROOM_ROSTER_URL}/2026/09/plain`,
          title: "New Imaging Center Opens",
          field_story_type: "News from WCM",
        }),
      ]),
      1: page([
        story({
          path: `${NEWSROOM_ROSTER_URL}/2020/old`,
          field_story_post_date: "January 1, 2020",
        }),
      ]),
      2: page([story({ path: `${NEWSROOM_ROSTER_URL}/2019/older` })]),
    };
    const fetched: string[] = [];
    const fetcher = async (u: string) => {
      fetched.push(u);
      return pages[Number(new URL(u).searchParams.get("page"))] ?? page([]);
    };
    const seen: string[] = [];
    const out = await scrapeNewsroom({
      meta: META,
      fetcher,
      index: INDEX,
      existing: [],
      vocab: VOCAB,
      backfill: false,
      now: new Date("2026-10-12T00:00:00Z"),
      extract: async (p) => {
        seen.push(p.url);
        return [honor()];
      },
    });
    expect(fetched).toHaveLength(2);
    expect(seen).toEqual([URL1]);
    expect(out.complete).toBe(true);
    expect(out.plan.creates).toHaveLength(1);
  });

  it("a failed later page is a partial walk, not a failure", async () => {
    const out = await walkFeed(async (u) => {
      if (u.endsWith("page=1")) throw new Error("HTTP 503");
      return page([story()]);
    }, null);
    expect(out.complete).toBe(false);
    expect(out.posts).toHaveLength(1);
    expect(out.warning).toContain("page 1");
  });

  it("throws when the model reads none of the posts", async () => {
    await expect(
      scrapeNewsroom({
        meta: META,
        fetcher: async (u) => (u.endsWith("page=0") ? page([story()]) : page([])),
        index: INDEX,
        existing: [],
        vocab: VOCAB,
        backfill: true,
        extract: async () => {
          throw new Error("throttled");
        },
      }),
    ).rejects.toThrow(/could not read any/);
  });
});
