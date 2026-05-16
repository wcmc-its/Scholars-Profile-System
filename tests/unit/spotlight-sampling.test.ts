/**
 * Unit tests for lib/spotlight-sampling.ts — the seeded 3-of-N publication
 * sampler for the home-page Spotlight (#286).
 *
 * Covers: PRNG determinism, distinct-item sampling, pool-size edge cases,
 * per-cycle stability + cross-cycle rotation, the lead/senior-author collision
 * check, and the soft re-roll (including the cap when one author dominates).
 */
import { describe, expect, it } from "vitest";
import {
  hashSeed,
  mulberry32,
  seededSample,
  hasKeyAuthorCollision,
  sampleSpotlightPapers,
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
