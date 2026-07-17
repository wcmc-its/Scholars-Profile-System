/**
 * #1654 — the preference nudge: extraction, the boost predicate, and how it reaches the score.
 *
 * The invariant worth protecting is the ORDERING one: a preference must be able to lift a
 * near-miss past a marginally-better topical match, and must NOT be able to haul a weak match
 * over a strong one. λ is what bounds that, so the tests pin the bound, not just the plumbing.
 */
import { describe, expect, it } from "vitest";

import {
  preferenceBoost,
  rerankCandidates,
  PREFERENCE_LAMBDA,
  type MatchaCandidate,
  type MatchaConcept,
  type MatchaPreference,
} from "@/lib/api/matcha-contract";
import { extractMatchaPreferences } from "@/lib/api/matcha-preferences";

const EARLY: MatchaPreference = {
  measure: "careerStage",
  stages: ["early"],
  label: "Early-career",
  evidence: "…early-career…",
  importance: 1,
};
const CLINICIAN: MatchaPreference = {
  measure: "isClinician",
  label: "Physician-scientist",
  evidence: "…physician-scientist…",
  importance: 1,
};

function cand(over: Partial<MatchaCandidate> & { cwid: string }): MatchaCandidate {
  return {
    name: over.cwid,
    profileSlug: over.cwid,
    title: null,
    department: null,
    fusedScore: 0,
    contributions: [],
    technologyCount: 0,
    ...over,
  };
}

describe("extractMatchaPreferences", () => {
  it("reads an early-career ask and a physician-scientist ask, with paste provenance", () => {
    const prefs = extractMatchaPreferences(
      "We fund fibrosis research and especially want to support early-career physician-scientists.",
    );
    expect(prefs.map((p) => p.label)).toEqual(["Early-career", "Physician-scientist"]);
    // The chip has to be able to show WHY it fired — an unexplained nudge is not auditable.
    expect(prefs[0].evidence).toContain("early-career");
    expect(prefs[0]).toMatchObject({ measure: "careerStage", stages: ["early"] });
  });

  it("returns [] for a purely topical paste — the nudge stays inert, as before", () => {
    expect(extractMatchaPreferences("We are interested in CAR-T for solid tumors.")).toEqual([]);
  });

  it("emits NO stage preference when a paste names both early and senior", () => {
    // Contradictory asks express no usable preference. Emitting both would have them cancel
    // inside the boost while still looking, on screen, like the sponsor was honoured.
    const prefs = extractMatchaPreferences(
      "Open to early-career applicants as well as senior investigators.",
    );
    expect(prefs.filter((p) => p.measure === "careerStage")).toEqual([]);
  });

  it("reads a senior ask on its own", () => {
    const prefs = extractMatchaPreferences("We seek established investigators with a track record.");
    expect(prefs[0]).toMatchObject({ measure: "careerStage", stages: ["senior"] });
  });

  // ── Inclusion is not preference ────────────────────────────────────────────
  // Regression, caught against the real eval gold set (`cardiovascular-broad`). The first
  // version of this extractor read the sentence below as "prefers clinicians" and boosted
  // them by up to λ — on a paste whose whole point was that it does NOT prefer them.
  it("does NOT fire on inclusive language — the sponsor welcoming everyone is not a preference", () => {
    const real =
      "We welcome basic, translational, and clinical investigators alike, including those " +
      "advancing imaging, biomarkers, device and surgical innovation. Bold ideas are welcome " +
      "at any career stage.";
    expect(extractMatchaPreferences(real)).toEqual([]);
  });

  it("suppresses the inclusive clause but still reads a genuine ask elsewhere in the paste", () => {
    // A paste may welcome all comers in one sentence and still state a real preference in
    // another. Suppressing the whole paste on one marker would throw away the real ask.
    const mixed =
      "We welcome basic and clinical investigators alike. That said, this award is reserved " +
      "for early-career applicants.";
    const prefs = extractMatchaPreferences(mixed);
    expect(prefs.map((p) => p.label)).toEqual(["Early-career"]);
  });

  it("'at any career stage' does not read as a stage preference", () => {
    expect(
      extractMatchaPreferences("Applications are encouraged at any career stage."),
    ).toEqual([]);
  });
});

describe("preferenceBoost", () => {
  it("is the importance-weighted fraction of preferences the candidate satisfies", () => {
    const both = cand({ cwid: "a", measures: { careerStage: "early", isClinician: true } });
    const half = cand({ cwid: "b", measures: { careerStage: "early", isClinician: false } });
    const none = cand({ cwid: "c", measures: { careerStage: "senior", isClinician: false } });

    expect(preferenceBoost(both, [EARLY, CLINICIAN])).toBe(1);
    expect(preferenceBoost(half, [EARLY, CLINICIAN])).toBe(0.5);
    expect(preferenceBoost(none, [EARLY, CLINICIAN])).toBe(0);
  });

  it("scores a candidate with NO measures as 0 — unproven, not disproven", () => {
    // Same arithmetic as "fails the preference", a different claim. She is not penalised for
    // being a non-clinician; she is simply never shown to be one.
    expect(preferenceBoost(cand({ cwid: "ghost" }), [EARLY, CLINICIAN])).toBe(0);
  });

  it("is 0 when there are no active preferences (the officer unchecked them all)", () => {
    expect(preferenceBoost(cand({ cwid: "a", measures: { careerStage: "early" } }), [])).toBe(0);
  });
});

describe("the nudge is a nudge — λ bounds what it can reorder", () => {
  const CONCEPTS: MatchaConcept[] = [
    { term: "fibrosis", kind: "concept", members: ["fibrosis"], centrality: 1, weightFactor: 1 },
  ];
  const opts = {
    prefBoost: (c: MatchaCandidate) => preferenceBoost(c, [EARLY]),
    lambda: PREFERENCE_LAMBDA,
  };

  it("lifts a near-miss over a marginally better topical match", () => {
    const ranked = rerankCandidates(
      [
        // Rank 2 on the concept, but early-career: the sponsor's stated preference.
        cand({ cwid: "early2", measures: { careerStage: "early" }, contributions: [{ term: "fibrosis", rank: 2 }] }),
        // Rank 1, but senior. Only marginally ahead topically (K=8 ⇒ 1/9 vs 1/10).
        cand({ cwid: "senior1", measures: { careerStage: "senior" }, contributions: [{ term: "fibrosis", rank: 1 }] }),
      ],
      CONCEPTS,
      opts,
    );
    expect(ranked.map((c) => c.cwid)).toEqual(["early2", "senior1"]);
  });

  it("CANNOT haul a weak match over a strong one", () => {
    const ranked = rerankCandidates(
      [
        // Early-career, but ranked 40th on the concept — a genuinely weak topical match.
        cand({ cwid: "early40", measures: { careerStage: "early" }, contributions: [{ term: "fibrosis", rank: 40 }] }),
        // Senior, but the single best topical match there is.
        cand({ cwid: "senior1", measures: { careerStage: "senior" }, contributions: [{ term: "fibrosis", rank: 1 }] }),
      ],
      CONCEPTS,
      opts,
    );
    // The money follows the science; the preference only breaks ties within it.
    expect(ranked.map((c) => c.cwid)).toEqual(["senior1", "early40"]);
  });

  it("is inert with no prefBoost — the default path is byte-for-byte the old ranking", () => {
    const cands = [
      cand({ cwid: "early2", measures: { careerStage: "early" }, contributions: [{ term: "fibrosis", rank: 2 }] }),
      cand({ cwid: "senior1", measures: { careerStage: "senior" }, contributions: [{ term: "fibrosis", rank: 1 }] }),
    ];
    expect(rerankCandidates(cands, CONCEPTS).map((c) => c.cwid)).toEqual(["senior1", "early2"]);
  });
});

describe("the bespoke engine (no concept decomposition) still honours preferences", () => {
  // It ships `concepts: []` and `contributions: []`, carrying its real score in `fusedScore`.
  // `rerankCandidates` returns that untouched — so a naive nudge would be SILENTLY INERT on
  // this engine. It must scale the score the server sent instead.
  const BESPOKE = [
    cand({ cwid: "senior", fusedScore: 1.0, measures: { careerStage: "senior" } }),
    cand({ cwid: "early", fusedScore: 0.85, measures: { careerStage: "early" } }),
  ];

  it("scales the server's score by the boost and re-sorts", () => {
    const ranked = rerankCandidates(BESPOKE, [], {
      prefBoost: (c) => preferenceBoost(c, [EARLY]),
      lambda: PREFERENCE_LAMBDA,
    });
    // 0.85 × 1.25 = 1.0625 > 1.0 — the early-career candidate takes the lead.
    expect(ranked.map((c) => c.cwid)).toEqual(["early", "senior"]);
    expect(ranked[0].fusedScore).toBeCloseTo(1.0625, 6);
  });

  it("with no preferences it returns the server's order and score untouched", () => {
    const ranked = rerankCandidates(BESPOKE, []);
    expect(ranked.map((c) => c.cwid)).toEqual(["senior", "early"]);
    expect(ranked[0].fusedScore).toBe(1.0);
  });
});
