/**
 * Unit tests for lib/spotlight-sampling.ts — the seeded 3-of-N publication
 * sampler for the home-page Spotlight (#286) AND the card-level near-duplicate
 * guard added with the ReciterAI 25-card bump.
 *
 * Covers: PRNG determinism, distinct-item sampling, pool-size edge cases,
 * per-cycle stability + cross-cycle rotation, the lead/senior-author collision
 * check, the soft re-roll (including the cap when one author dominates), and the
 * card-level paper-overlap guard + re-draw used by the home component.
 */
import { describe, expect, it } from "vitest";
import {
  hashSeed,
  mulberry32,
  seededSample,
  hasKeyAuthorCollision,
  sampleSpotlightPapers,
  cardPaperOverlap,
  hasNearDuplicateCardPair,
  sampleDistinctCards,
} from "@/lib/spotlight-sampling";

/** Minimal paper fixture: a pmid and a byline-ordered list of WCM author cwids. */
function paper(pmid: string, authorCwids: string[]) {
  return { pmid, authors: authorCwids.map((cwid) => ({ cwid })) };
}

/** A pool of n papers, each with one distinct author — no possible collisions. */
function distinctPool(n: number) {
  return Array.from({ length: n }, (_, i) => paper(`p${i}`, [`a${i}`]));
}

const pmidsOf = (papers: { pmid: string }[]) => papers.map((p) => p.pmid);

/** Minimal card fixture: an id and the PMIDs it would display. */
function card(id: string, pmids: string[]) {
  return { subtopicId: id, papers: pmids.map((pmid) => ({ pmid })) };
}

/** A full deterministic Fisher–Yates shuffle driven by an injected rng. */
function seededShuffle(rng: () => number) {
  return <T>(arr: readonly T[]): T[] => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
}

describe("hashSeed", () => {
  it("is deterministic", () => {
    expect(hashSeed("v2026-05-07:cancer_genomics")).toBe(
      hashSeed("v2026-05-07:cancer_genomics"),
    );
  });

  it("returns a uint32", () => {
    for (const k of ["", "a", "v1:sub", "a-longer-seed-key-here"]) {
      const h = hashSeed(k);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("separates distinct keys", () => {
    const keys = ["v1:a", "v1:b", "v2:a", "v2:b", "v1:aa"];
    expect(new Set(keys.map(hashSeed)).size).toBe(keys.length);
  });
});

describe("mulberry32", () => {
  it("produces a deterministic sequence for a given seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("returns floats in [0, 1)", () => {
    const rng = mulberry32(987654321);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("seededSample", () => {
  it("returns k distinct items drawn from the pool", () => {
    const pool = distinctPool(7);
    const out = seededSample(pool, 3, mulberry32(hashSeed("k")));
    expect(out).toHaveLength(3);
    expect(new Set(pmidsOf(out)).size).toBe(3);
    for (const p of out) expect(pool).toContain(p);
  });

  it("returns the whole pool when k exceeds pool size", () => {
    const out = seededSample(distinctPool(2), 3, mulberry32(hashSeed("k")));
    expect(out).toHaveLength(2);
  });

  it("advances the generator across successive draws", () => {
    const rng = mulberry32(hashSeed("k"));
    const pool = distinctPool(7);
    const draws = Array.from({ length: 8 }, () =>
      pmidsOf(seededSample(pool, 3, rng)).join(","),
    );
    // Eight consecutive draws from one generator must not all be identical.
    expect(new Set(draws).size).toBeGreaterThan(1);
  });
});

describe("hasKeyAuthorCollision", () => {
  it("returns false when every paper's lead/senior authors are distinct", () => {
    expect(
      hasKeyAuthorCollision([
        paper("p1", ["a", "b"]),
        paper("p2", ["c", "d"]),
        paper("p3", ["e", "f"]),
      ]),
    ).toBe(false);
  });

  it("detects a shared lead author", () => {
    expect(
      hasKeyAuthorCollision([
        paper("p1", ["X", "b"]),
        paper("p2", ["X", "d"]),
        paper("p3", ["e", "f"]),
      ]),
    ).toBe(true);
  });

  it("detects lead-of-one equal to senior-of-another", () => {
    expect(
      hasKeyAuthorCollision([
        paper("p1", ["a", "Y"]), // senior = Y
        paper("p2", ["Y", "d"]), // lead = Y
        paper("p3", ["e", "f"]),
      ]),
    ).toBe(true);
  });

  it("ignores shared middle authors — only lead + senior count", () => {
    // M is a middle author on two papers but is neither lead nor senior.
    expect(
      hasKeyAuthorCollision([
        paper("p1", ["a", "M", "b"]),
        paper("p2", ["c", "M", "d"]),
        paper("p3", ["e", "f"]),
      ]),
    ).toBe(false);
  });

  it("does not self-collide on single-author papers", () => {
    expect(
      hasKeyAuthorCollision([
        paper("p1", ["a"]),
        paper("p2", ["b"]),
        paper("p3", ["c"]),
      ]),
    ).toBe(false);
  });
});

describe("sampleSpotlightPapers — pool size", () => {
  it.each([0, 1, 2, 3])(
    "returns the whole pool unchanged for pool size %i",
    (n) => {
      const pool = distinctPool(n);
      const out = sampleSpotlightPapers(pool, "v1:sub");
      expect(out).toHaveLength(n);
      expect(pmidsOf(out)).toEqual(pmidsOf(pool));
    },
  );

  it.each([4, 5, 6, 7, 8, 12])(
    "samples exactly 3 distinct papers for pool size %i",
    (n) => {
      const pool = distinctPool(n);
      const out = sampleSpotlightPapers(pool, "v1:sub");
      expect(out).toHaveLength(3);
      expect(new Set(pmidsOf(out)).size).toBe(3);
      for (const p of out) expect(pool).toContain(p);
    },
  );
});

describe("sampleSpotlightPapers — determinism & rotation", () => {
  it("is stable for a given seed key", () => {
    const pool = distinctPool(7);
    const first = pmidsOf(sampleSpotlightPapers(pool, "v2026-05-07:cancer"));
    for (let i = 0; i < 100; i++) {
      expect(pmidsOf(sampleSpotlightPapers(pool, "v2026-05-07:cancer"))).toEqual(
        first,
      );
    }
  });

  it("rotates across publish cycles (same subtopic, different artifactVersion)", () => {
    const pool = distinctPool(7);
    const versions = [
      "v2026-05-07",
      "v2026-05-14",
      "v2026-05-21",
      "v2026-05-28",
      "v2026-06-04",
    ];
    const triples = versions.map((v) =>
      pmidsOf(sampleSpotlightPapers(pool, `${v}:cancer`)).join(","),
    );
    expect(new Set(triples).size).toBeGreaterThan(1);
  });

  it("samples each spotlight independently (same cycle, different subtopic)", () => {
    const pool = distinctPool(7);
    const subs = ["cancer", "neuro", "cardio", "immuno", "endo", "renal"];
    const triples = subs.map((s) =>
      pmidsOf(sampleSpotlightPapers(pool, `v2026-05-07:${s}`)).join(","),
    );
    expect(new Set(triples).size).toBeGreaterThan(1);
  });
});

describe("sampleSpotlightPapers — soft re-roll", () => {
  it("re-rolls toward triples without a repeated lead/senior author", () => {
    // Pool of 4: p1 & p2 share lead author X; p3, p4 have unique authors.
    // Of the C(4,3)=4 triples, 2 collide (those with both p1 & p2) and 2 are
    // clean. A no-re-roll sampler lands on a colliding triple ~50% of the
    // time; the soft re-roll (cap 3 ⇒ 4 draws) drives that to ~1/16.
    const pool = [
      paper("p1", ["X"]),
      paper("p2", ["X"]),
      paper("p3", ["a"]),
      paper("p4", ["b"]),
    ];
    const KEYS = 80;
    let clean = 0;
    for (let i = 0; i < KEYS; i++) {
      const out = sampleSpotlightPapers(pool, `v1:s${i}`);
      expect(out).toHaveLength(3);
      expect(new Set(pmidsOf(out)).size).toBe(3);
      if (!hasKeyAuthorCollision(out)) clean++;
    }
    // ~15/16 expected clean; well clear of the ~50% a no-re-roll sampler gives.
    expect(clean).toBeGreaterThan(KEYS * 0.8);
  });

  it("still returns a full triple when one author dominates the pool", () => {
    // Every paper has the same lone author — every triple collides. The
    // re-roll cap must terminate and still yield 3 distinct papers.
    const pool = Array.from({ length: 6 }, (_, i) => paper(`p${i}`, ["dominant"]));
    const out = sampleSpotlightPapers(pool, "v1:dominated");
    expect(out).toHaveLength(3);
    expect(new Set(pmidsOf(out)).size).toBe(3);
    expect(hasKeyAuthorCollision(out)).toBe(true); // cap reached — collision accepted
  });
});

describe("cardPaperOverlap", () => {
  it("is 0 for cards with no shared papers", () => {
    expect(cardPaperOverlap(card("a", ["1", "2", "3"]), card("b", ["4", "5", "6"]))).toBe(0);
  });

  it("is 1.0 when two single-paper cards show the same paper", () => {
    expect(cardPaperOverlap(card("a", ["1"]), card("b", ["1"]))).toBe(1);
  });

  it("uses min-cardinality so a contained card scores 1.0", () => {
    // a's single paper is a subset of b's three — fully contained.
    expect(cardPaperOverlap(card("a", ["2"]), card("b", ["1", "2", "3"]))).toBe(1);
  });

  it("is 2/3 when two 3-paper cards share two papers", () => {
    expect(
      cardPaperOverlap(card("a", ["1", "2", "3"]), card("b", ["2", "3", "9"])),
    ).toBeCloseTo(2 / 3, 10);
  });

  it("is 1/3 when two 3-paper cards share one paper", () => {
    expect(
      cardPaperOverlap(card("a", ["1", "2", "3"]), card("b", ["3", "8", "9"])),
    ).toBeCloseTo(1 / 3, 10);
  });

  it("is 0 when either card has no papers", () => {
    expect(cardPaperOverlap(card("a", []), card("b", ["1", "2"]))).toBe(0);
  });
});

describe("hasNearDuplicateCardPair", () => {
  it("is false when every card pair is disjoint", () => {
    expect(
      hasNearDuplicateCardPair([
        card("a", ["1", "2", "3"]),
        card("b", ["4", "5", "6"]),
        card("c", ["7", "8", "9"]),
      ]),
    ).toBe(false);
  });

  it("is true when one pair overlaps at or above the threshold (2 of 3)", () => {
    expect(
      hasNearDuplicateCardPair([
        card("a", ["1", "2", "3"]),
        card("b", ["7", "8", "9"]),
        card("c", ["2", "3", "8"]), // shares 2/3 with a
      ]),
    ).toBe(true);
  });

  it("ignores a single shared paper (1 of 3 = 0.33 < 0.40)", () => {
    expect(
      hasNearDuplicateCardPair([
        card("a", ["1", "2", "3"]),
        card("b", ["3", "8", "9"]), // shares 1/3 with a
        card("c", ["4", "5", "6"]),
      ]),
    ).toBe(false);
  });

  it("respects a caller-supplied threshold", () => {
    const cards = [card("a", ["1", "2", "3"]), card("b", ["3", "8", "9"])]; // 1/3 overlap
    expect(hasNearDuplicateCardPair(cards, 0.3)).toBe(true);
    expect(hasNearDuplicateCardPair(cards, 0.5)).toBe(false);
  });
});

describe("sampleDistinctCards", () => {
  it("draws exactly `count` distinct cards", () => {
    const pool = Array.from({ length: 25 }, (_, i) => card(`s${i}`, [`${i}`]));
    const out = sampleDistinctCards(pool, 8, seededShuffle(mulberry32(hashSeed("k"))));
    expect(out).toHaveLength(8);
    expect(new Set(out.map((c) => c.subtopicId)).size).toBe(8);
  });

  it("returns the whole pool when count exceeds pool size", () => {
    const pool = [card("a", ["1"]), card("b", ["2"])];
    const out = sampleDistinctCards(pool, 8, seededShuffle(mulberry32(hashSeed("k"))));
    expect(out).toHaveLength(2);
  });

  it("re-draws away from near-duplicate pairs across many page loads", () => {
    // 25 cards. Two of them (dupA / dupB) are containment-nested near-duplicates
    // sharing all three displayed papers; the other 23 are disjoint. A no-guard
    // shuffle-and-slice-8 would surface both dups together with non-trivial
    // probability; the guard should drive co-occurrence far down.
    const shared = ["x1", "x2", "x3"];
    const pool = [
      card("dupA", shared),
      card("dupB", shared),
      ...Array.from({ length: 23 }, (_, i) => card(`s${i}`, [`p${i}`])),
    ];
    const DRAWS = 200;
    let withDupPair = 0;
    for (let i = 0; i < DRAWS; i++) {
      const out = sampleDistinctCards(pool, 8, seededShuffle(mulberry32(hashSeed(`load${i}`))));
      expect(out).toHaveLength(8);
      const ids = new Set(out.map((c) => c.subtopicId));
      if (ids.has("dupA") && ids.has("dupB")) withDupPair++;
    }
    // Both members of the lone near-dup pair landing in the same 8-of-25 draw
    // should be rare after the guard's re-rolls — comfortably under 5%. (An
    // unguarded draw co-occurs them ~9% of the time: C(23,6)/C(25,8) ≈ 0.093.)
    expect(withDupPair).toBeLessThan(DRAWS * 0.05);
  });

  it("accepts the final draw when a near-duplicate pair is unavoidable", () => {
    // Pool of 3 cards that all share the same papers; any draw of 2 collides.
    // The re-draw cap must terminate and still return `count` distinct cards.
    const shared = ["x1", "x2", "x3"];
    const pool = [card("a", shared), card("b", shared), card("c", shared)];
    const out = sampleDistinctCards(pool, 2, seededShuffle(mulberry32(hashSeed("k"))));
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.subtopicId)).size).toBe(2);
    expect(hasNearDuplicateCardPair(out)).toBe(true); // cap reached — collision accepted
  });
});
