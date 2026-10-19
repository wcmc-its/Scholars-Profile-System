import { describe, expect, it } from "vitest";

import {
  HIDE_AT,
  PRIOR,
  SHOW_AT,
  WEIGHTS,
  authorKey,
  coauthorCounts,
  doctoralYearRange,
  evidenceKey,
  isDoctoralForTimeline,
  middleInitialConflict,
  priorInstitutionMatch,
  sameInstitution,
  scholarInitials,
  scoreAttribution,
  timelineGapYears,
  topicOverlap,
  type AttributionEvidence,
} from "@/etl/reporter-grants/score";
import { isWcmOrg } from "@/etl/reporter-grants/transform";

/** An award with no evidence either way, under the name-only policy. */
const ev = (over: Partial<AttributionEvidence> = {}): AttributionEvidence => ({
  policy: "wcm-or-publication",
  wcmOrgHistory: false,
  publicationLinked: false,
  activityCode: "R01",
  startYear: 2015,
  infoedOther: null,
  rejected: null,
  doctoralYears: { earliest: 2000, latest: 2000 },
  middleInitialConflict: null,
  priorInstitution: null,
  coPiSharedPapers: null,
  topic: null,
  ...over,
});

const ids = (e: AttributionEvidence) => scoreAttribution(e).reasons.map((r) => r.id);

describe("band thresholds and the #3088/#3092 baseline", () => {
  it("hides an award with no evidence at all (the old default-hide)", () => {
    const s = scoreAttribution(ev());
    expect(s.score).toBe(PRIOR);
    expect(PRIOR).toBeLessThanOrEqual(HIDE_AT);
    expect(s.band).toBe("hide");
    expect(s.reasons).toEqual([]);
  });

  it("shows on one strong tie: a linked confirmed publication", () => {
    const s = scoreAttribution(ev({ publicationLinked: true }));
    expect(s.band).toBe("show");
    expect(s.score).toBe(PRIOR + WEIGHTS.pub_linked);
  });

  it("lets WCM org history show a name-only award, never a grant-join one", () => {
    expect(scoreAttribution(ev({ wcmOrgHistory: true })).band).toBe("show");
    const gj = scoreAttribution(ev({ policy: "publication-only", wcmOrgHistory: true }));
    expect(gj.band).toBe("hide");
    expect(gj.reasons).toEqual([]);
  });

  it("queues on one moderate tie and shows on two", () => {
    expect(scoreAttribution(ev({ priorInstitution: "Elsewhere University" })).band).toBe("queue");
    expect(scoreAttribution(ev({ coPiSharedPapers: 3 })).band).toBe("queue");
    const both = scoreAttribution(ev({ priorInstitution: "Elsewhere University", coPiSharedPapers: 3 }));
    expect(both.score).toBeGreaterThanOrEqual(SHOW_AT);
    expect(both.band).toBe("show");
  });

  it("never judges a scholar whose profiles were all confirmed by publications", () => {
    const s = scoreAttribution(ev({ policy: "none", infoedOther: { piLevel: true, profileNameMatchesOther: true } }));
    expect(s.band).toBe("show");
    expect(s.reasons).toEqual([]);
  });
});

describe("cue 1: the core is in InfoEd under another WCM investigator", () => {
  it("is decisive when our NIH profile's name matches theirs, even over WCM org", () => {
    const s = scoreAttribution(
      ev({ wcmOrgHistory: true, infoedOther: { piLevel: true, profileNameMatchesOther: true } }),
    );
    expect(s.band).toBe("hide");
    expect(s.rule).toBe("decisive");
    expect(s.reasons[0]!.id).toBe("infoed_other_wcm_pi_named");
  });

  it("queues instead when a linked confirmed publication contradicts it", () => {
    const s = scoreAttribution(
      ev({ publicationLinked: true, infoedOther: { piLevel: true, profileNameMatchesOther: true } }),
    );
    expect(s.band).toBe("queue");
    expect(s.rule).toBe("conflict");
  });

  it("is a moderate negative when the names differ (multi-PI, contact-PI-only InfoEd)", () => {
    const s = scoreAttribution(
      ev({ publicationLinked: true, policy: "publication-only", infoedOther: { piLevel: true, profileNameMatchesOther: false } }),
    );
    expect(ids(ev({ infoedOther: { piLevel: true, profileNameMatchesOther: false } }))).toEqual([
      "infoed_other_wcm_pi",
    ]);
    expect(s.score).toBe(PRIOR + WEIGHTS.pub_linked + WEIGHTS.infoed_other_wcm_pi);
    expect(s.band).toBe("queue");
  });

  it("ignores another WCM holder below PI level (Co-I, key personnel, subaward)", () => {
    expect(ids(ev({ infoedOther: { piLevel: false, profileNameMatchesOther: true } }))).toEqual([]);
  });
});

describe("cue 2: papers linked to the award were rejected in ReCiter", () => {
  it("fires on any overlap with a small linked set, and conflicts with a linked paper", () => {
    expect(ids(ev({ rejected: { overlap: 1, linkedTotal: 12 } }))).toEqual(["rejected_pmids"]);
    const s = scoreAttribution(ev({ publicationLinked: true, rejected: { overlap: 1, linkedTotal: 12 } }));
    expect(s.band).toBe("queue");
    expect(s.rule).toBe("conflict");
  });

  it("needs two overlaps on a large (center/training) linked set", () => {
    expect(ids(ev({ rejected: { overlap: 1, linkedTotal: 900 } }))).toEqual([]);
    expect(ids(ev({ rejected: { overlap: 2, linkedTotal: 900 } }))).toEqual(["rejected_pmids"]);
  });

  it("never fires when the rejections are unavailable or do not overlap", () => {
    expect(ids(ev({ rejected: null }))).toEqual([]);
    expect(ids(ev({ rejected: { overlap: 0, linkedTotal: 3 } }))).toEqual([]);
  });
});

describe("cue 3: timeline", () => {
  const md2000 = { earliest: 2000, latest: 2000 };

  it("flags a faculty-level award starting well before the first doctorate", () => {
    expect(timelineGapYears("R01", 1990, md2000)).toBe(9);
    expect(ids(ev({ activityCode: "R01", startYear: 1990 }))).toEqual(["timeline_impossible"]);
    expect(ids(ev({ activityCode: "R21", startYear: 1997 }))).toEqual(["timeline_unlikely"]);
  });

  it("allows a year of slack around the degree", () => {
    expect(timelineGapYears("R01", 1999, md2000)).toBe(0);
    expect(timelineGapYears("F31", 2001, md2000)).toBe(0);
  });

  it("treats F32 and K99 as postdoctoral: never before the degree", () => {
    expect(timelineGapYears("F32", 1995, md2000)).toBeGreaterThan(0);
    expect(timelineGapYears("K99", 2003, md2000)).toBe(0);
    expect(timelineGapYears("F32", 2004, md2000)).toBe(0);
  });

  it("flags a predoctoral fellowship starting long after the LAST doctorate", () => {
    expect(ids(ev({ activityCode: "F31", startYear: 2010 }))).toEqual(["timeline_impossible"]);
    // An MD who later earns a PhD with an F31: the latest degree governs.
    expect(timelineGapYears("F31", 2005, { earliest: 2000, latest: 2008 })).toBe(0);
    expect(timelineGapYears("F30", 1996, md2000)).toBe(0);
  });

  it("fails open with no degree year, no start year or no activity code", () => {
    expect(ids(ev({ doctoralYears: null, startYear: 1950 }))).toEqual([]);
    expect(timelineGapYears(null, 1950, md2000)).toBe(0);
    expect(timelineGapYears("R01", null, md2000)).toBe(0);
  });

  it("goes to the queue when a linked paper meets an impossible timeline", () => {
    const s = scoreAttribution(ev({ publicationLinked: true, startYear: 1985 }));
    expect(s.band).toBe("queue");
    expect(s.rule).toBe("conflict");
  });

  it("reads doctoral and UK medical degrees, not master's", () => {
    expect(isDoctoralForTimeline("M.D.")).toBe(true);
    expect(isDoctoralForTimeline("Ph.D.")).toBe(true);
    expect(isDoctoralForTimeline("M.B.,B.S.")).toBe(true);
    expect(isDoctoralForTimeline("M.B., Ch.B.")).toBe(true);
    expect(isDoctoralForTimeline("M.S.")).toBe(false);
    expect(isDoctoralForTimeline("M.P.H.")).toBe(false);
    expect(
      doctoralYearRange([
        { degree: "M.D.", year: 2001 },
        { degree: "Ph.D.", year: 2005 },
        { degree: "B.A.", year: 1993 },
        { degree: "Ph.D.", year: null },
      ]),
    ).toEqual({ earliest: 2001, latest: 2005 });
    expect(doctoralYearRange([{ degree: "B.S.", year: 1990 }])).toBeNull();
  });
});

describe("cue 4: middle initial", () => {
  it("conflicts only when both sides have one and nothing matches", () => {
    const s = scholarInitials(["Jane Q Public, MD", "Jane Public"]);
    expect([...s.middle]).toEqual(["q"]);
    expect(middleInitialConflict(["R."], s)).toBe(true);
    expect(middleInitialConflict(["Quentin"], s)).toBe(false);
    expect(middleInitialConflict([null, ""], s)).toBeNull();
    expect(middleInitialConflict(["R"], scholarInitials(["Jane Public"]))).toBeNull();
  });

  it("accepts a RePORTER middle name that is the scholar's first name (goes by middle)", () => {
    expect(middleInitialConflict(["Jane"], scholarInitials(["J Quinn Public"]))).toBe(false);
  });

  it("does not read surname particles as middle names", () => {
    expect([...scholarInitials(["Ana de la Cruz"]).middle]).toEqual([]);
  });

  it("is a weak negative: alone it cannot move a shown award out of show", () => {
    const s = scoreAttribution(ev({ publicationLinked: true, middleInitialConflict: true }));
    expect(s.band).toBe("show");
    expect(s.score).toBe(PRIOR + WEIGHTS.pub_linked + WEIGHTS.middle_initial_conflict);
  });
});

describe("cue 5: prior institution", () => {
  it("matches distinctive tokens, not institution kinds", () => {
    expect(sameInstitution("UNIV OF PENNSYLVANIA", "University of Pennsylvania")).toBe(true);
    expect(sameInstitution("ICAHN SCHOOL OF MEDICINE AT MOUNT SINAI", "Mount Sinai School of Medicine")).toBe(true);
    expect(sameInstitution("UNIVERSITY OF CALIFORNIA SAN FRANCISCO", "University of California")).toBe(false);
    expect(sameInstitution("PENNSYLVANIA STATE UNIVERSITY", "University of Pennsylvania")).toBe(false);
    expect(sameInstitution("UNIVERSITY HOSPITAL", "Medical College")).toBe(false);
  });

  it("needs the award year inside the degree's window and ignores WCM", () => {
    const edu = [{ institution: "University of Pennsylvania", year: 2000 }];
    expect(priorInstitutionMatch([{ orgName: "UNIV OF PENNSYLVANIA", fiscalYear: 2004 }], edu, isWcmOrg)).toBe(
      "University of Pennsylvania",
    );
    expect(priorInstitutionMatch([{ orgName: "UNIV OF PENNSYLVANIA", fiscalYear: 2015 }], edu, isWcmOrg)).toBeNull();
    expect(
      priorInstitutionMatch(
        [{ orgName: "WEILL MEDICAL COLL OF CORNELL UNIV", fiscalYear: 2004 }],
        [{ institution: "Weill Cornell Medical College", year: 2000 }],
        isWcmOrg,
      ),
    ).toBeNull();
  });
});

describe("cue 6: co-PIs who are co-authors", () => {
  it("counts papers per co-author key, once per paper, without the scholar", () => {
    const self = authorKey("Public", "Jane");
    const m = coauthorCounts(
      ["Public J, Smith AB, Doe C", "Smith A, Public JQ", "Smith AB, Smith A", null],
      self,
    );
    expect(m.get("smith a")).toBe(3);
    expect(m.get("doe c")).toBe(1);
    expect(m.has("public j")).toBe(false);
  });

  it("needs at least two shared papers", () => {
    expect(ids(ev({ coPiSharedPapers: 1 }))).toEqual([]);
    expect(ids(ev({ coPiSharedPapers: 2 }))).toEqual(["copi_coauthor"]);
  });
});

describe("cue 7: topic is a tie-break", () => {
  const counts = new Map([
    ["D000001", 3],
    ["D000002", 2],
    ["D000003", 1],
  ]);

  it("ignores check tags and counts descriptors in two or more papers", () => {
    const t = topicOverlap(["D006801", "D000001", "D000002", "D000003", "D000004"], counts, 20);
    expect(t).toEqual({ share: 0.5, descriptors: 4, papers: 20 });
    expect(topicOverlap(["D006801"], counts, 20)).toBeNull();
    expect(topicOverlap(["D000001"], counts, 0)).toBeNull();
  });

  it("never lifts a hide or sinks a show on its own", () => {
    const high = { share: 0.9, descriptors: 10, papers: 50 };
    const none = { share: 0, descriptors: 10, papers: 50 };
    expect(scoreAttribution(ev({ topic: high })).band).toBe("hide");
    expect(scoreAttribution(ev({ publicationLinked: true, topic: none })).band).toBe("show");
    expect(ids(ev({ topic: high }))).toEqual([]);
  });

  it("tips a borderline award inside the queue band", () => {
    // pub + other-WCM-PI = +1 (queue); a topic match tips it to show.
    const base = ev({ publicationLinked: true, infoedOther: { piLevel: true, profileNameMatchesOther: false } });
    expect(scoreAttribution(base).band).toBe("queue");
    expect(scoreAttribution({ ...base, topic: { share: 0.6, descriptors: 8, papers: 30 } }).band).toBe("show");
    // prior institution + middle-initial conflict = -1 (queue); a mismatch tips it to hide.
    const weak = ev({ priorInstitution: "Elsewhere University", middleInitialConflict: true });
    expect(scoreAttribution(weak).band).toBe("queue");
    expect(scoreAttribution({ ...weak, topic: { share: 0, descriptors: 8, papers: 30 } }).band).toBe("hide");
  });

  it("needs enough data on both sides before calling a mismatch", () => {
    const weak = ev({ priorInstitution: "Elsewhere University", middleInitialConflict: true });
    expect(scoreAttribution({ ...weak, topic: { share: 0, descriptors: 3, papers: 30 } }).band).toBe("queue");
    expect(scoreAttribution({ ...weak, topic: { share: 0, descriptors: 8, papers: 4 } }).band).toBe("queue");
  });
});

describe("degraded inputs never fire a cue", () => {
  it("an all-unknown award scores exactly the prior", () => {
    const s = scoreAttribution(
      ev({
        activityCode: null,
        startYear: null,
        doctoralYears: null,
        infoedOther: null,
        rejected: null,
        middleInitialConflict: null,
        priorInstitution: null,
        coPiSharedPapers: null,
        topic: null,
      }),
    );
    expect(s.reasons).toEqual([]);
    expect(s.score).toBe(PRIOR);
  });
});

describe("evidenceKey", () => {
  it("changes with the band or a deciding cue, not with topic", () => {
    const a = scoreAttribution(ev({ priorInstitution: "X University" }));
    const b = scoreAttribution(ev({ priorInstitution: "X University", topic: { share: 0.9, descriptors: 9, papers: 40 } }));
    expect(a.band).toBe(b.band);
    expect(evidenceKey(a)).toBe(evidenceKey(b));
    const c = scoreAttribution(ev({ priorInstitution: "X University", coPiSharedPapers: 4 }));
    expect(evidenceKey(c)).not.toBe(evidenceKey(a));
  });
});
