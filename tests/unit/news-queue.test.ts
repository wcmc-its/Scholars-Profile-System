/**
 * The news queue loader's history tabs.
 *
 * The queue used to filter to `source: "NAME"` for EVERY status. VIVO-linked
 * mentions auto-publish and never sit pending, so that filter made them invisible
 * in Approved — a scholar with four published mentions on their profile appeared
 * nowhere in the queue at all. Two behaviours are pinned here:
 *
 *  1. NO SOURCE FILTER. History must show both sources; pending is name-only by
 *     construction, so dropping the filter costs it nothing.
 *  2. THE HISTORY SORT MUST NOT RANK BY LIKELIHOOD. A VIVO row has a null
 *     likelihood ⇒ rank 0 ⇒ it sinks below every NAME approval. Pending keeps the
 *     likelihood rank; history is most-recent-article-first.
 */
import { describe, expect, it } from "vitest";

import { scoreProminence } from "@/lib/api/prominence";
import {
  NEWS_HISTORY_LIMIT,
  loadNewsQueue,
  snippetMatchRanges,
  sortNewsQueueGroups,
} from "@/lib/edit/news-queue";
import type { NewsQueueGroup } from "@/lib/edit/news-queue";

type Row = {
  id: string;
  cwid: string;
  url: string;
  title: string;
  publishedAt: Date | null;
  detectedName: string | null;
  likelihood: string | null;
  matchBasis: string | null;
  contextSnippet: string | null;
  showOnProfile: boolean;
  enteredByCwid: string | null;
  source: string;
  sourceRef: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function vivo(over: Partial<Row> & { id: string; cwid: string }): Row {
  return {
    url: `https://news.weill.cornell.edu/${over.id}`,
    title: "A VIVO-linked article",
    publishedAt: new Date("2026-07-10T00:00:00Z"),
    detectedName: null,
    likelihood: null,
    matchBasis: null,
    contextSnippet: null,
    showOnProfile: true,
    enteredByCwid: null,
    source: "VIVO",
    sourceRef: null,
    createdAt: new Date("2026-07-18T00:00:00Z"),
    updatedAt: new Date("2026-07-18T00:00:00Z"),
    ...over,
  };
}

function name(over: Partial<Row> & { id: string; cwid: string }): Row {
  return {
    ...vivo(over),
    title: "A name-matched article",
    detectedName: "Fei Wang",
    likelihood: "HIGH",
    matchBasis: "TAG",
    source: "NAME",
    sourceRef: `https://news.weill.cornell.edu/${over.id}|fei wang`,
    ...over,
  };
}

/** Per-cwid overrides for the fake roster, so a test can make one scholar the
 *  Dean or give another a deep publication record (the prominence inputs). */
type Person = {
  preferredName?: string;
  primaryTitle?: string | null;
  scoredPubCount?: number | null;
  hIndex?: number | null;
  /** #2599 — the two columns `formatPublishedName` reads. Overridable so a test
   *  can drive the enrolled-student suppression at the CALL SITE. */
  postnominal?: string | null;
  roleCategory?: string | null;
};

/** Minimal stand-in for the Prisma surface the loader touches. `calls` records
 *  the `where` each findMany got, so a re-added source filter fails the test;
 *  `scholarCwids` records the cwid IN-list of every scholar read, so dropping
 *  the decider (`entered_by_cwid`) from the name lookup fails too.
 *
 *  `grant` / `orgUnitRoleAssignment` are read by `computeProminence`, not by the
 *  loader itself: empty here, so a fixture's prominence is decided purely by its
 *  publication counts and title. */
function client(rows: Row[], people: Record<string, Person> = {}, omitCwids: string[] = []) {
  const calls: Array<Record<string, unknown>> = [];
  const scholarCwids: string[][] = [];
  const c = {
    newsMention: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push(args);
        return rows;
      },
    },
    scholar: {
      findMany: async (args: { where?: { cwid?: { in?: string[] } } }) => {
        const requested = args.where?.cwid?.in ?? [];
        scholarCwids.push(requested);
        // `omitCwids` lets a test drive the loader's "cwid absent from the
        // prominence map" branch, which is otherwise unreachable: the fake used
        // to answer for every cwid it was asked about.
        return requested
          .filter((cwid) => !omitCwids.includes(cwid))
          .map((cwid) => ({
            cwid,
            slug: `slug-${cwid}`,
            preferredName: people[cwid]?.preferredName ?? `Scholar ${cwid}`,
            postnominal: people[cwid]?.postnominal ?? null,
            fullName: `Scholar ${cwid}`,
            // `in`, not `??`: `roleCategory: null` is a MEANINGFUL fixture state
            // (an un-backfilled scholar, who keeps their credential), and `??`
            // would silently rewrite it to faculty.
            roleCategory:
              cwid in people && "roleCategory" in people[cwid]
                ? people[cwid].roleCategory
                : "full_time_faculty",
            primaryTitle: people[cwid]?.primaryTitle ?? "Professor of Medicine",
            primaryDepartment: "Medicine",
            scoredPubCount: people[cwid]?.scoredPubCount ?? null,
            hIndex: people[cwid]?.hIndex ?? null,
          }));
      },
    },
    grant: { groupBy: async () => [] },
    orgUnitRoleAssignment: { findMany: async () => [] },
  };
  return { client: c as unknown as Parameters<typeof loadNewsQueue>[0], calls, scholarCwids };
}

describe("loadNewsQueue — history shows every source", () => {
  it("queries without a source filter", async () => {
    const { client: c, calls } = client([vivo({ id: "v1", cwid: "aaa1001" })]);
    await loadNewsQueue(c, "published");
    expect(calls[0].where).toEqual({ status: "published" });
  });

  it("caps history and takes the most recent, but never caps pending", async () => {
    // news_mention is append-only, so an uncapped history load grows forever and
    // ships every row into the client payload. The cap must also order
    // newest-first at the DB, or it would keep the OLDEST rows.
    const { client: c, calls } = client([vivo({ id: "v1", cwid: "aaa1001" })]);

    await loadNewsQueue(c, "published");
    expect(calls[0].take).toBe(NEWS_HISTORY_LIMIT);
    expect(calls[0].orderBy).toEqual([{ publishedAt: "desc" }, { createdAt: "desc" }]);

    await loadNewsQueue(c, "pending");
    expect(calls[1].take).toBeUndefined();
  });

  it("returns VIVO rows alongside NAME approvals, each solo and uncontested", async () => {
    const { client: c } = client([
      vivo({ id: "v1", cwid: "aaa1001" }),
      name({ id: "n1", cwid: "bbb2002" }),
    ]);
    const groups = await loadNewsQueue(c, "published");

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.contested)).toBe(true);
    expect(groups.every((g) => g.rows.length === 1)).toBe(true);
    // The badge the UI keys on.
    expect(groups.flatMap((g) => g.rows.map((r) => r.source)).sort()).toEqual(["NAME", "VIVO"]);
    // A VIVO group is keyed by its own id — never lumped with the other NULL
    // sourceRefs, which would falsely mark unrelated mentions as competing.
    expect(groups.some((g) => g.key === "id:v1")).toBe(true);
  });

  it("does not bury a newer VIVO row under an older HIGH name-match", async () => {
    // The regression this whole change exists to prevent: rank by likelihood on a
    // history tab and every VIVO row (likelihood null ⇒ rank 0) sinks to the end.
    const { client: c } = client([
      name({ id: "n1", cwid: "bbb2002", publishedAt: new Date("2026-01-01T00:00:00Z") }),
      vivo({ id: "v1", cwid: "aaa1001", publishedAt: new Date("2026-07-10T00:00:00Z") }),
    ]);
    const groups = await loadNewsQueue(c, "published");

    expect(groups[0].rows[0].source).toBe("VIVO");
  });

  it("still ranks pending by likelihood, contested last", async () => {
    const { client: c } = client([
      name({ id: "m1", cwid: "bbb2002", likelihood: "MEDIUM" }),
      name({ id: "h1", cwid: "aaa1001", likelihood: "HIGH" }),
    ]);
    const groups = await loadNewsQueue(c, "pending");

    expect(groups.map((g) => g.rows[0].likelihood)).toEqual(["HIGH", "MEDIUM"]);
  });
});

/**
 * #2578 — the queue must be able to tell a reviewer WHY a candidate scored what
 * it did. `likelihood` cannot carry that alone: it folds in contested-ness as
 * well as basis, so a MEDIUM means either "prose match" or "tagged, but two
 * scholars share the name". The basis is the half that distinguishes them.
 */
describe("loadNewsQueue — match basis (#2578)", () => {
  it("carries matchBasis through to the row the UI renders", async () => {
    const { client: c } = client([
      name({ id: "t1", cwid: "aaa1001", likelihood: "HIGH", matchBasis: "TAG" }),
    ]);
    const groups = await loadNewsQueue(c, "pending");
    expect(groups[0].rows[0].matchBasis).toBe("TAG");
  });

  it("ranks the new LOW tier below MEDIUM but above an unscored row", async () => {
    // LOW must not collapse into the 0 fallback: a scored LOW candidate is still
    // more actionable than a pre-#2578 row carrying no likelihood at all.
    const { client: c } = client([
      name({ id: "u1", cwid: "ddd4004", likelihood: null, matchBasis: null }),
      name({ id: "l1", cwid: "ccc3003", likelihood: "LOW", matchBasis: "TITLE" }),
      name({ id: "m1", cwid: "bbb2002", likelihood: "MEDIUM", matchBasis: "BODY" }),
      name({ id: "h1", cwid: "aaa1001", likelihood: "HIGH", matchBasis: "TAG" }),
    ]);
    const groups = await loadNewsQueue(c, "pending");

    expect(groups.map((g) => g.rows[0].likelihood)).toEqual(["HIGH", "MEDIUM", "LOW", null]);
    expect(groups.map((g) => g.rows[0].matchBasis)).toEqual(["TAG", "BODY", "TITLE", null]);
  });

  it("still surfaces a contested group, whatever the basis, and sinks it last", async () => {
    // Two scholars, ONE detected name ⇒ one shared sourceRef ⇒ a single-select.
    // A TAG basis does not make it uncontested: the tag names *a* Fei Wang, not
    // which one. The UI keys "This is the one" / "None of these" off this flag.
    const ref = "https://news.weill.cornell.edu/x|fei wang";
    const { client: c } = client([
      name({ id: "c1", cwid: "aaa1001", likelihood: "MEDIUM", matchBasis: "TAG", sourceRef: ref }),
      name({ id: "c2", cwid: "bbb2002", likelihood: "MEDIUM", matchBasis: "TAG", sourceRef: ref }),
      name({ id: "s1", cwid: "ccc3003", likelihood: "LOW", matchBasis: "CAPTION" }),
    ]);
    const groups = await loadNewsQueue(c, "pending");

    const contested = groups.find((g) => g.contested);
    expect(contested).toBeDefined();
    expect(contested!.rows).toHaveLength(2);
    expect(contested!.rows.map((r) => r.competingCwids.length)).toEqual([1, 1]);
    // Contested ranks 0 — it needs disambiguation before it needs ranking, so it
    // sits below even the solo LOW candidate. Shipped behaviour, pinned here.
    expect(groups[groups.length - 1].contested).toBe(true);
  });

  it("carries contextSnippet through to the row the UI renders", async () => {
    const { client: c } = client([
      name({
        id: "t1",
        cwid: "aaa1001",
        likelihood: "LOW",
        matchBasis: "TITLE",
        contextSnippet: "…and the O. Wayne Isom Professor of Cardiothoracic Surgery, commended…",
      }),
    ]);
    const groups = await loadNewsQueue(c, "pending");
    expect(groups[0].rows[0].contextSnippet).toBe(
      "…and the O. Wayne Isom Professor of Cardiothoracic Surgery, commended…",
    );
  });

  /**
   * #2578 follow-up — "sort by confidence then recency": within one tier, newer
   * publishedAt sorts first. This was already the loader's behaviour before the
   * scored BODY tier (LIKELIHOOD_RANK ranks the tier, the comparator breaks ties
   * by publishedAt descending) — see the docblock on LIKELIHOOD_RANK. Pinned
   * here explicitly because the scored tier is what the product owner's ask was
   * actually about, even though the sort mechanism itself needed no change.
   */
  it("sorts newer before older WITHIN a tier (recency), after confidence", async () => {
    const { client: c } = client([
      name({
        id: "old-high",
        cwid: "aaa1001",
        likelihood: "HIGH",
        publishedAt: new Date("2026-01-01T00:00:00Z"),
      }),
      name({
        id: "new-high",
        cwid: "bbb2002",
        likelihood: "HIGH",
        publishedAt: new Date("2026-08-01T00:00:00Z"),
      }),
      name({
        id: "new-medium",
        cwid: "ccc3003",
        likelihood: "MEDIUM",
        publishedAt: new Date("2026-09-01T00:00:00Z"),
      }),
    ]);
    const groups = await loadNewsQueue(c, "pending");

    // Confidence still dominates: the newer MEDIUM sinks below BOTH HIGH rows
    // despite being the most recent article of the three...
    expect(groups.map((g) => g.rows[0].id)).toEqual(["new-high", "old-high", "new-medium"]);
    // ...and within the tied HIGH tier, the newer article sorts first.
    expect(groups[0].rows[0].id).toBe("new-high");
    expect(groups[1].rows[0].id).toBe("old-high");
  });
});

/**
 * #2578 follow-up — the reviewer-facing name highlight.
 *
 * The queue shows ~300 chars of scraped prose and asks the reviewer to judge
 * whether the story is really about this scholar. Until now the matched name was
 * rendered flat, so they had to find it themselves. `snippetMatchRanges` locates
 * it the same way the ETL did — on FOLDED tokens with original offsets — because
 * `detectedName` is the roster's name, not the article's wording.
 */
describe("snippetMatchRanges — #2578 name highlight", () => {
  const at = (snippet: string, ranges: [number, number][]) =>
    ranges.map(([s, e]) => snippet.slice(s, e));

  it("locates the full name and returns the ARTICLE's spelling, not the roster's", () => {
    const snippet = "…said Dr. Sarah Chen, who led the trial.";
    expect(at(snippet, snippetMatchRanges(snippet, "Sarah Chen"))).toEqual(["Sarah Chen"]);
  });

  it("matches across case and diacritics the roster name does not carry", () => {
    const snippet = "A study by JOSÉ GARCÍA found that…";
    expect(at(snippet, snippetMatchRanges(snippet, "Jose Garcia"))).toEqual(["JOSÉ GARCÍA"]);
  });

  it("marks every occurrence, without overlapping two marks", () => {
    const snippet = "Chen Wei joined in 2019. Chen Wei now leads the lab.";
    expect(at(snippet, snippetMatchRanges(snippet, "Chen Wei"))).toEqual(["Chen Wei", "Chen Wei"]);
  });

  it("falls back to the surname when the full name is not in the prose", () => {
    // The roster drifted (preferredName changed); the snippet was anchored on a
    // sequence that no longer matches in full.
    const snippet = "…as Dr. Chen explained to the audience.";
    expect(at(snippet, snippetMatchRanges(snippet, "Sarah Chen"))).toEqual(["Chen"]);
  });

  it("returns no ranges when neither the name nor the surname appears", () => {
    expect(snippetMatchRanges("A story about something else entirely.", "Sarah Chen")).toEqual([]);
  });

  it("returns no ranges for a null snippet or a null detected name", () => {
    expect(snippetMatchRanges(null, "Sarah Chen")).toEqual([]);
    expect(snippetMatchRanges("Dr. Chen spoke.", null)).toEqual([]);
    expect(snippetMatchRanges("", "Sarah Chen")).toEqual([]);
  });

  it("does not match a name fragment inside a longer word", () => {
    // Token equality, not substring: "Chenoweth" must not light up for "Chen".
    expect(snippetMatchRanges("…quoting Ann Chenoweth on the study.", "Sarah Chen")).toEqual([]);
  });

  it("survives an ellipsis-prefixed snippet, whose offsets shift", () => {
    const snippet = "…and then Sarah Chen said…";
    expect(at(snippet, snippetMatchRanges(snippet, "Sarah Chen"))).toEqual(["Sarah Chen"]);
  });
});

/**
 * The queue's sort selector.
 *
 * ~1,371 rows sit pending, so comms needs more than one way in: the shipped
 * certainty order for "work the confident matches", pure recency for "what did
 * the newsroom just run", and prominence for "the Dean's mentions first". All
 * three re-order the SAME loaded groups client-side — the loader is not
 * parameterised by sort (see its doc comment).
 */
describe("sortNewsQueueGroups — the reviewer's sort selector", () => {
  /** Prominence inputs. `grant` / `orgUnitRoleAssignment` are empty in the fake
   *  client, so the score reduces to publication counts + the faculty weight,
   *  and the tier to the title heuristic — "Dean" is tier 0, everyone else 3. */
  const people: Record<string, Person> = {
    aaa1001: { scoredPubCount: 5 },
    bbb2002: { scoredPubCount: 500 }, // the deepest record in the fixture
    ccc3003: { primaryTitle: "Dean", scoredPubCount: 1 }, // tier 0, thin record
    ddd4004: {},
    eee5005: {},
  };

  const contestedRef = "https://news.weill.cornell.edu/contested|fei wang";

  /** Likelihood, publication depth and article date each imply a DIFFERENT
   *  order, so no two sorts can pass by accident. */
  const fixture = () =>
    client(
      [
        name({
          id: "h1",
          cwid: "aaa1001",
          likelihood: "HIGH",
          publishedAt: new Date("2026-01-01T00:00:00Z"),
        }),
        name({
          id: "m1",
          cwid: "bbb2002",
          likelihood: "MEDIUM",
          publishedAt: new Date("2026-05-01T00:00:00Z"),
        }),
        name({
          id: "l1",
          cwid: "ccc3003",
          likelihood: "LOW",
          publishedAt: new Date("2026-08-01T00:00:00Z"),
        }),
        name({
          id: "c1",
          cwid: "ddd4004",
          likelihood: "MEDIUM",
          sourceRef: contestedRef,
          publishedAt: new Date("2026-09-01T00:00:00Z"),
        }),
        name({
          id: "c2",
          cwid: "eee5005",
          likelihood: "MEDIUM",
          sourceRef: contestedRef,
          publishedAt: new Date("2026-09-01T00:00:00Z"),
        }),
      ],
      people,
    );

  const ids = (groups: NewsQueueGroup[]) => groups.map((g) => g.rows[0].id);

  it("'certainty' IS the shipped pending order, whatever order it is handed", async () => {
    const { client: c } = fixture();
    const groups = await loadNewsQueue(c, "pending");
    // HIGH, MEDIUM, LOW, then the contested group (forced to rank 0) — today's
    // behaviour, and the default the sort selector must not disturb.
    expect(ids(groups)).toEqual(["h1", "m1", "l1", "c1"]);
    // Re-sorting a shuffled copy lands back on exactly that sequence.
    expect(ids(sortNewsQueueGroups([...groups].reverse(), "certainty"))).toEqual(ids(groups));
  });

  it("'recent' ignores likelihood entirely", async () => {
    const { client: c } = fixture();
    const groups = await loadNewsQueue(c, "pending");
    // Newest article first: the contested group leads despite ranking last under
    // certainty, and the HIGH match sinks to the bottom on its January date.
    expect(ids(sortNewsQueueGroups(groups, "recent"))).toEqual(["c1", "l1", "m1", "h1"]);
  });

  it("'prominence' puts a tier-0 Dean above a higher-scoring tier-3 scholar", async () => {
    const { client: c } = fixture();
    const groups = await loadNewsQueue(c, "pending");
    const sorted = sortNewsQueueGroups(groups, "prominence");
    // l1 is the Dean (tier 0) on a 1-publication record; m1 is tier 3 with 500.
    // Tier wins outright — then, WITHIN tier 3, prominence orders m1 (500) above
    // h1 (5) above the contested pair (0).
    expect(ids(sorted)).toEqual(["l1", "m1", "h1", "c1"]);
    expect(sorted[0].rows[0].leadershipTier).toBe(0);
    expect(sorted[1].rows[0].prominence).toBeGreaterThan(sorted[0].rows[0].prominence);
  });

  it("ranks a contested group by its BEST candidate, not by rows[0]", async () => {
    // The group exists because we do not know which scholar it belongs to, so a
    // group that might be the most prominent person in the queue must be offered
    // at that person's position — sorting on rows[0] would bury it arbitrarily.
    const { client: c } = client(
      [
        name({ id: "solo", cwid: "aaa1001" }),
        name({ id: "c1", cwid: "ddd4004", sourceRef: contestedRef }),
        name({ id: "c2", cwid: "eee5005", sourceRef: contestedRef }),
      ],
      { aaa1001: { scoredPubCount: 100 }, ddd4004: {}, eee5005: { scoredPubCount: 5000 } },
    );
    const groups = await loadNewsQueue(c, "pending");
    expect(ids(sortNewsQueueGroups(groups, "prominence"))).toEqual(["c1", "solo"]);
  });

  it("returns a new array and never mutates its argument", async () => {
    const { client: c } = fixture();
    const groups = await loadNewsQueue(c, "pending");
    const before = ids(groups);

    const sorted = sortNewsQueueGroups(groups, "recent");

    expect(sorted).not.toBe(groups);
    expect(ids(groups)).toEqual(before);
  });
});

/**
 * The two editorial/provenance fields the decision UI renders alongside status:
 * "do we want it on the profile?" and "who decided this?".
 */
describe("loadNewsQueue — showOnProfile + the decider", () => {
  it("carries showOnProfile through, orthogonal to status", async () => {
    // "Approved but don't publish" is published + showOnProfile=false — there is
    // deliberately no fourth status for it.
    const { client: c } = client([name({ id: "hidden", cwid: "aaa1001", showOnProfile: false })]);
    const groups = await loadNewsQueue(c, "published");
    expect(groups[0].rows[0].showOnProfile).toBe(false);
  });

  it("resolves the decider's name even though a steward is not in the queue", async () => {
    // `entered_by_cwid` is usually a comms steward, who has no mention of their
    // own in the queue — the name read must cover the ACTORS as well as the
    // mentioned scholars, or every decided row reads as an anonymous cwid.
    const { client: c, scholarCwids } = client(
      [name({ id: "d1", cwid: "aaa1001", enteredByCwid: "std9001" })],
      { std9001: { preferredName: "Robin Steward" } },
    );
    const groups = await loadNewsQueue(c, "published");

    expect(groups[0].rows[0].decidedByName).toBe("Robin Steward");
    expect(scholarCwids.some((cwids) => cwids.includes("std9001"))).toBe(true);
  });

  it("leaves decidedByName null on an ETL-written row", async () => {
    const { client: c } = client([name({ id: "etl", cwid: "aaa1001" })]);
    const groups = await loadNewsQueue(c, "pending");
    expect(groups[0].rows[0].decidedByName).toBeNull();
  });
});

/**
 * The shared prominence scorer (`lib/api/prominence.ts`), pinned from its second
 * consumer: /edit/scholars and this queue must never rank the same scholar
 * differently, which is why the formula was extracted rather than copied.
 */
describe("scoreProminence — the one prominence definition", () => {
  const base = {
    scoredPubCount: null,
    hIndex: null,
    roleCategory: null,
    primaryTitle: null,
    chairLabel: null,
    isChief: false,
    piCount: 0,
    nihPiCount: 0,
  };

  it("scores a scholar with no counts as a finite number, never NaN", () => {
    // A NaN score sorts arbitrarily against everything, so a scholar with a null
    // hIndex / scoredPubCount must land on a real 0 rather than propagating one.
    const { prominence } = scoreProminence(base);
    expect(Number.isNaN(prominence)).toBe(false);
    expect(prominence).toBe(0);
    expect(Number.isNaN(scoreProminence({ ...base, scoredPubCount: 10 }).prominence)).toBe(false);
  });

  it("ranks a chair above a chief on an otherwise identical record", () => {
    const chair = scoreProminence({ ...base, chairLabel: "Chair" });
    const chief = scoreProminence({ ...base, isChief: true });

    expect(chair.prominence).toBeGreaterThan(chief.prominence);
    expect(chair.leadershipLabel).toBe("Chair");
    expect(chief.leadershipLabel).toBe("Chief");
    // Both are tier 2 — the chair/chief difference is in the SCORE, not the tier.
    expect(chair.leadershipTier).toBe(chief.leadershipTier);
  });
});

/**
 * The two branches the mutation probe found unpinned.
 *
 * Both are "quiet" defaults — the kind that produce a plausible number rather
 * than an error — so nothing else in the suite notices when they invert.
 */
describe("prominence fallbacks — the unpinned defaults", () => {
  it("scores a mention whose scholar is missing as tier 3, not tier 0", async () => {
    // The worst possible inversion: default the tier to 0 and an unresolvable
    // cwid outranks the actual Dean and every chair on the `prominence` sort.
    // Mutating LEADERSHIP_TIER.none -> 0 here used to leave the suite green.
    const { client: c } = client(
      [name({ id: "n1", cwid: "ghost001", likelihood: "HIGH" })],
      {},
      ["ghost001"],
    );
    const groups = await loadNewsQueue(c, "pending");
    expect(groups[0].rows[0].leadershipTier).toBe(3);
    expect(groups[0].rows[0].prominence).toBe(0);
  });

  it("never lets a null count reach the sort as NaN", async () => {
    // `Math.log1p(null)` is 0, so asserting `prominence === 0` cannot tell a
    // guarded formula from an unguarded one. Assert FINITENESS, and assert the
    // row still orders — NaN silently makes every comparison false and scrambles
    // the sort rather than throwing.
    const { client: c } = client(
      [
        name({ id: "n1", cwid: "aaa1001", likelihood: "HIGH" }),
        name({ id: "n2", cwid: "bbb1002", likelihood: "HIGH" }),
      ],
      { aaa1001: { scoredPubCount: null, hIndex: null }, bbb1002: { scoredPubCount: 40, hIndex: 20 } },
    );
    const groups = await loadNewsQueue(c, "pending");
    for (const g of groups) {
      expect(Number.isFinite(g.rows[0].prominence)).toBe(true);
    }
    const sorted = sortNewsQueueGroups(groups, "prominence");
    expect(sorted.map((g) => g.rows[0].cwid)).toEqual(["bbb1002", "aaa1001"]);
  });
});

/**
 * #2599 — CALL-SITE coverage for the enrolled-student postnominal suppression.
 *
 * `lib/postnominal.ts` is unit-tested on its own; that cannot see whether THIS
 * loader still passes the real `roleCategory`. The third parameter is required but
 * its type admits `null`, so swapping `s?.roleCategory ?? null` for a literal `null`
 * here leaves `tsc` clean and every other test green while the feature goes dark.
 * These assertions are what go red on that mutation.
 *
 * The trap the mutation would imitate is one line away in the real loader:
 * `formatPublishedName(preferred, …, s?.roleCategory ?? null)` is immediately
 * followed by `formatRoleCategory(s?.roleCategory ?? null)`, which turns the same
 * value into `"Doctoral student"`. `roleLabel` is asserted alongside `scholarName`
 * below so the two stay visibly distinct.
 */
describe("loadNewsQueue — enrolled-student postnominal (#2599)", () => {
  it("renders the BARE name for an enrolled doctoral student", async () => {
    const { client: c } = client([name({ id: "n1", cwid: "prg9001", likelihood: "HIGH" })], {
      prg9001: {
        preferredName: "Priya Raghunathan",
        postnominal: "Doctor of Philosophy",
        roleCategory: "doctoral_student_phd",
      },
    });
    const groups = await loadNewsQueue(c, "pending");

    // The queue previews what an approval publishes, so it must not preview a
    // doctorate the scholar has not been awarded.
    expect(groups[0].rows[0].scholarName).toBe("Priya Raghunathan");
    // Same column, the OTHER helper — the humanized label still renders.
    expect(groups[0].rows[0].roleLabel).toBe("PhD student");
  });

  it("still normalizes and renders an earned full-title degree for faculty", async () => {
    // The control: identical postnominal, a recognized non-student role. Without
    // this the assertion above would also pass on a loader that had stopped
    // rendering postnominals entirely.
    const { client: c } = client([name({ id: "n1", cwid: "ewh9002", likelihood: "HIGH" })], {
      ewh9002: {
        preferredName: "Elena Whitcombe",
        postnominal: "Doctor of Philosophy",
        roleCategory: "full_time_faculty",
      },
    });
    const groups = await loadNewsQueue(c, "pending");

    expect(groups[0].rows[0].scholarName).toBe("Elena Whitcombe, PhD");
  });
});
