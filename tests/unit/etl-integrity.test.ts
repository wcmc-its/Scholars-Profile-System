import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CHANGE_COUNT_SOURCES,
  findVolumeRegressions,
  splitOrphansByKeyspace,
  staleSources,
} from "@/etl/integrity";

describe("findVolumeRegressions", () => {
  it("flags a >50% overnight drop on a substantial source", () => {
    const out = findVolumeRegressions([
      { source: "ReCiter", latest: 40_000, previous: 180_000 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("ReCiter");
    expect(out[0].dropPct).toBeGreaterThan(50);
  });

  it("passes growth and moderate shrink", () => {
    expect(
      findVolumeRegressions([
        { source: "ED", latest: 9_100, previous: 8_900 },
        { source: "COI", latest: 5_100, previous: 6_000 },
      ]),
    ).toEqual([]);
  });

  it("exempts sources that were never substantial (Tools in ddb mode, empty COI-Gap)", () => {
    expect(
      findVolumeRegressions([
        { source: "Tools", latest: 0, previous: 0 },
        { source: "COI-Gap", latest: 1, previous: 40 },
      ]),
    ).toEqual([]);
  });

  it("honors custom thresholds", () => {
    const out = findVolumeRegressions(
      [{ source: "Reporter", latest: 700, previous: 1_000 }],
      { maxDropPct: 20 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].dropPct).toBe(30);
  });
});

// #2038 — the nightly and the weekly run the same `etl:integrity`, so a weekly
// source used to be re-graded by every nightly against a pair that cannot move
// until its next weekly run.
//
// These used to be written against News, which was the source that exposed the
// bug. News is now permanently exempt (#2200, below), so the cadence rule is
// exercised here through Technology — also a weekly, tier:"continue" step — to
// keep #2038 covered by a source the rule can actually reach.
describe("findVolumeRegressions — cycle-window scoping (#2038)", () => {
  const NOW = new Date("2026-08-04T04:25:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

  const WEEKLY = { source: "Technology", latest: 5, previous: 1_595 } as const;

  it("does not grade a weekly source on a nightly that did not run it", () => {
    expect(
      findVolumeRegressions([{ ...WEEKLY, latestAt: hoursAgo(48) }], { now: NOW }),
    ).toEqual([]);
  });

  it("STILL grades that same pair in the cycle that produced it", () => {
    // Guards against "fixed" by simply never grading the source again.
    const out = findVolumeRegressions([{ ...WEEKLY, latestAt: hoursAgo(1) }], {
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("Technology");
    expect(out[0].dropPct).toBeCloseTo(99.7, 1);
  });

  it("grades a sample with unknown age, as before (fail-safe)", () => {
    expect(findVolumeRegressions([WEEKLY], { now: NOW })).toHaveLength(1);
    expect(
      findVolumeRegressions([{ ...WEEKLY, latestAt: null }], { now: NOW }),
    ).toHaveLength(1);
  });

  it("names the skipped sources so the gap is never silent", () => {
    const history = [
      { ...WEEKLY, latestAt: hoursAgo(48) },
      { source: "ED", latest: 9_100, previous: 8_900, latestAt: hoursAgo(1) },
    ];
    expect(staleSources(history, NOW)).toEqual(["Technology"]);
  });
});

// #2200 — News's rowsProcessed is `inserted + updated`: a CHANGE count, delta on
// both the input and the count. No ratio between two such samples means anything.
describe("findVolumeRegressions — change-count sources (#2200)", () => {
  const NOW = new Date("2026-08-10T07:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

  it("never grades News, even on a fresh sample in its own cycle", () => {
    // This deliberately REVERSES the #2038 tripwire above, which asserted the
    // owning cycle still grades this pair. The pair itself was never evidence of
    // anything: 1595 was an operator backfill and 5 an ordinary weekly delta.
    expect(
      findVolumeRegressions([{ source: "News", latest: 5, previous: 1_595, latestAt: hoursAgo(1) }], {
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("does not grade the staging repoint pair either (measured 2026-08-06)", () => {
    // 2,495 came from an ORDINARY incremental run with no NEWS_BACKFILL — the
    // newsroom corpus is simply deeper than the site it replaced. The next ~5-row
    // delta reads as a 99.8% collapse and nothing is wrong.
    expect(
      findVolumeRegressions([{ source: "News", latest: 5, previous: 2_495, latestAt: hoursAgo(1) }], {
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("is a NAMED exemption, not a widened threshold — peers still fail loudly", () => {
    const out = findVolumeRegressions(
      [
        { source: "News", latest: 5, previous: 2_495, latestAt: hoursAgo(1) },
        { source: "ReCiter", latest: 5, previous: 2_495, latestAt: hoursAgo(1) },
      ],
      { now: NOW },
    );
    expect(out.map((r) => r.source)).toEqual(["ReCiter"]);
  });

  it("exempts by exact source name, so a lookalike is still graded", () => {
    expect(CHANGE_COUNT_SOURCES.has("News")).toBe(true);
    const out = findVolumeRegressions(
      [{ source: "NewsMentions", latest: 5, previous: 2_495, latestAt: hoursAgo(1) }],
      { now: NOW },
    );
    expect(out).toHaveLength(1);
  });
});

// #2224 — one orphan count summed two opposite meanings: a `reporter:` orphan
// is the re-add protection working (deterministic id, re-attaches on re-add),
// an `INFOED-` orphan is a live un-hiding (the Account_Number re-key).
describe("splitOrphansByKeyspace (#2224)", () => {
  it("separates the self-healing keyspace from the one that pages", () => {
    expect(
      splitOrphansByKeyspace([
        { id: "s1", entityId: "reporter:aaa1111:R01CA000001" },
        { id: "s2", entityId: "INFOED-90210-aaa1111" },
        { id: "s3", entityId: "reporter:bbb2222:R01CA000002" },
        { id: "s4", entityId: "legacy-91" },
      ]),
    ).toEqual({ infoed: ["s2"], reporter: ["s1", "s3"], other: ["s4"] });
  });

  it("carries suppression ids only — never the entityId, which embeds a CWID", () => {
    const split = splitOrphansByKeyspace([
      { id: "s1", entityId: "INFOED-90210-aaa1111" },
    ]);
    expect(JSON.stringify(split)).not.toContain("aaa1111");
  });

  it("is empty per keyspace when there are no orphans, so nothing is graded", () => {
    expect(splitOrphansByKeyspace([])).toEqual({
      infoed: [],
      reporter: [],
      other: [],
    });
  });
});

/**
 * The split above is only worth having because the `infoed` side GRADES: it
 * goes through `note()`, which pushes a violation and fails the nightly.
 * Swapping that one call for `console.log`/`console.warn` deletes the whole
 * behaviour and every test above stays green — nothing here reaches `main()`,
 * which opens Prisma and OpenSearch. Hence a source-text assertion, comments
 * stripped first (same as `tests/unit/etl-disconnect-guard.test.ts`) so a
 * commented-out call fails it too.
 */
describe("the InfoEd-orphan split is graded, not just logged (#2224)", () => {
  const SRC = readFileSync(join(process.cwd(), "etl/integrity/index.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("routes the infoed keyspace through note(), which is what fails the run", () => {
    expect(SRC).toMatch(/\bnote\(\s*"suppression:orphan-infoed",/);
  });
});
