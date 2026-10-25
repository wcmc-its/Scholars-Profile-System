import { describe, expect, it } from "vitest";

import {
  HIDE_AT,
  PRIOR,
  PROFILE_PROVEN_MIN_LINKED,
  SHOW_AT,
  WEIGHTS,
  NAME_COMMON_MIN,
  nameProfileCountFrom,
  piSurnameMatches,
  authorKey,
  coauthorCounts,
  doctoralYearRange,
  evidenceKey,
  firstNameAgreement,
  infoedOtherEvidence,
  isIndividualAward,
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
import { profileProof } from "@/etl/reporter-grants/evidence";
import { namesMatch } from "@/etl/nih-profile/resolver";

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
  profileProven: null,
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
  it("is a strong negative when our NIH profile's name matches theirs: hides with nothing else", () => {
    const s = scoreAttribution(ev({ infoedOther: { piLevel: true, profileNameMatchesOther: true } }));
    expect(s.band).toBe("hide");
    expect(s.rule).toBe("sum");
    expect(s.score).toBe(PRIOR + WEIGHTS.infoed_other_wcm_pi_named);
    expect(s.reasons[0]!.id).toBe("infoed_other_wcm_pi_named");
  });

  it("is not an override: a strong tie the other way (WCM org) queues it", () => {
    const s = scoreAttribution(
      ev({ wcmOrgHistory: true, infoedOther: { piLevel: true, profileNameMatchesOther: true } }),
    );
    expect(s.band).toBe("queue");
    expect(s.rule).toBe("conflict");
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

  it("leaves institutional awards out of the before-the-doctorate branch (they pass PI to PI)", () => {
    for (const c of ["T32", "P30", "P01", "U54", "S10", "R25", "K12"]) {
      expect(timelineGapYears(c, 1980, md2000)).toBe(0);
    }
    expect(ids(ev({ activityCode: "T32", startYear: 1980 }))).toEqual([]);
  });

  it("pins the unlikely weight where it decides the band", () => {
    // WCM (+5), another WCM PI in InfoEd (-2), unlikely timeline (-3):
    // -2 + 5 - 2 - 3 lands exactly on HIDE_AT. A lighter unlikely weight
    // would queue it.
    const s = scoreAttribution(
      ev({
        wcmOrgHistory: true,
        infoedOther: { piLevel: true, profileNameMatchesOther: false },
        activityCode: "R21",
        startYear: 1997,
      }),
    );
    expect(s.reasons.map((r) => r.id).sort()).toEqual(
      ["infoed_other_wcm_pi", "timeline_unlikely", "wcm_org"].sort(),
    );
    expect(WEIGHTS.timeline_unlikely).toBe(-3);
    expect(s.score).toBe(HIDE_AT);
    expect(s.band).toBe("hide");
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

  it("is a strong negative: hides an award nothing else ties to the scholar", () => {
    const s = scoreAttribution(ev({ middleInitialConflict: true }));
    expect(s.band).toBe("hide");
    expect(s.score).toBe(PRIOR + WEIGHTS.middle_initial_conflict);
  });

  it("queues, not hides, an award a confirmed paper cites (a data error on one side)", () => {
    const s = scoreAttribution(ev({ publicationLinked: true, middleInitialConflict: true }));
    expect(s.band).toBe("queue");
    expect(s.rule).toBe("conflict");
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

  it("a co-PI co-author plus a topic match queues, never shows on its own", () => {
    const r = scoreAttribution(ev({ coPiSharedPapers: 5, topic: { share: 0.9, descriptors: 10, papers: 50 } }));
    expect(r.band).toBe("queue");
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
    expect(topicOverlap(["D000003", "D000004", "D000005", "D000006", "D000007", "D000008", "D000009", "D000010", "D000011", "D000012", "D000001"], counts, 20)!.share).toBeCloseTo(1 / 11);
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
    expect(scoreAttribution({ ...base, topic: { share: 0.05, descriptors: 8, papers: 30 } }).band).toBe("queue");
    // prior institution + co-PI + unlikely timeline = -1 (queue); a mismatch tips it to hide.
    const weak = ev({ priorInstitution: "Elsewhere University", coPiSharedPapers: 3, activityCode: "K99", startYear: 1997 });
    expect(scoreAttribution(weak).band).toBe("queue");
    expect(scoreAttribution({ ...weak, topic: { share: 0, descriptors: 8, papers: 30 } }).band).toBe("hide");
  });

  it("needs enough data on both sides before calling a mismatch", () => {
    const weak = ev({ priorInstitution: "Elsewhere University", coPiSharedPapers: 3, activityCode: "K99", startYear: 1997 });
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

describe("cue 1 evidence: whose name the NIH profile carries", () => {
  const us = ["Jane Q Example", "Jane Example"];
  const colleague = { role: "PI", names: ["Joan Example", "Joan Example"] };

  it("grades first-name agreement", () => {
    expect(firstNameAgreement("Joan", us)).toBe("initial");
    expect(firstNameAgreement("Jane", us)).toBe("full");
    expect(firstNameAgreement("Mark", us)).toBe("none");
    expect(firstNameAgreement(null, us)).toBe("none");
  });

  it("is decisive-grade when the PI is the colleague by full first name and not us", () => {
    const e = infoedOtherEvidence({
      ourPis: [{ first_name: "Joan", piName: "Joan Example" }],
      scholarNames: us,
      others: [colleague],
      namesMatch,
    });
    expect(e).toEqual({ piLevel: true, profileNameMatchesOther: true });
  });

  it("is only moderate when the PI's full first name is ours (a multi-PI award)", () => {
    const e = infoedOtherEvidence({
      ourPis: [{ first_name: "Jane", piName: "Jane Example" }],
      scholarNames: us,
      others: [colleague],
      namesMatch,
    });
    expect(e).toEqual({ piLevel: true, profileNameMatchesOther: false });
  });

  it("drops a holder a RePORTER co-PI accounts for (multi-PI award)", () => {
    const e = infoedOtherEvidence({
      ourPis: [{ first_name: "Joan", piName: "Joan Example" }],
      coPiNames: ["Joan B Example"],
      scholarNames: us,
      others: [colleague],
      namesMatch,
    });
    expect(e).toEqual({ piLevel: false, profileNameMatchesOther: false });
  });

  it("does not count Co-I, key personnel or a subaward PI, and is null with no other holder", () => {
    const args = { ourPis: [{ first_name: "Joan", piName: "Joan Example" }], scholarNames: us, namesMatch };
    for (const role of ["Co-I", "Key Personnel", "PI-Subaward"]) {
      expect(infoedOtherEvidence({ ...args, others: [{ ...colleague, role }] })).toEqual({
        piLevel: false,
        profileNameMatchesOther: false,
      });
    }
    expect(infoedOtherEvidence({ ...args, others: [] })).toBeNull();
  });
});

describe("cue 2 scope: individual awards only", () => {
  it("covers R, K, F, DP and U01, not center, training or program cores", () => {
    for (const c of ["R01", "R21", "K08", "K99", "F32", "DP2", "U01"]) expect(isIndividualAward(c)).toBe(true);
    for (const c of ["P30", "P01", "T32", "UL1", "U54", "S10", "R25", "K12", "KL2", null]) {
      expect(isIndividualAward(c)).toBe(false);
    }
  });

  it("treats an over-cap core (unknown link total) as a large set", () => {
    expect(ids(ev({ rejected: { overlap: 1, linkedTotal: null } }))).toEqual([]);
    expect(ids(ev({ rejected: { overlap: 2, linkedTotal: null } }))).toEqual(["rejected_pmids"]);
    expect(scoreAttribution(ev({ rejected: { overlap: 2, linkedTotal: null } })).reasons[0]!.reason).not.toMatch(
      /of the/,
    );
  });

  it("does not fire cue 2 on a center core", () => {
    expect(ids(ev({ activityCode: "P30", rejected: { overlap: 5, linkedTotal: 10 } }))).toEqual([]);
  });
});

describe("cue 8: a proven NIH profile vouches for its awards", () => {
  it("shows a pre-WCM award no paper cites when its profile was matched by publications", () => {
    // A former institution's contract on the scholar's PMID-matched profile.
    const s = scoreAttribution(ev({ activityCode: "N01", profileProven: { kind: "matched" } }));
    expect(s.band).toBe("show");
    expect(ids(ev({ profileProven: { kind: "matched" } }))).toEqual(["profile_proven"]);
  });

  it("shows a conference grant when two sibling awards on the profile are cited", () => {
    const s = scoreAttribution(
      ev({ policy: "publication-only", activityCode: "R13", profileProven: { kind: "siblings", linked: 3 } }),
    );
    expect(s.band).toBe("show");
  });

  it("queues, not shows, when a strong negative fires too", () => {
    const s = scoreAttribution(
      ev({ profileProven: { kind: "matched" }, rejected: { overlap: 3, linkedTotal: 10 } }),
    );
    expect(s.band).toBe("queue");
    expect(s.rule).toBe("conflict");
  });

  it("queues when InfoEd names another WCM PI whose name the profile matches", () => {
    const s = scoreAttribution(
      ev({ profileProven: { kind: "matched" }, infoedOther: { piLevel: true, profileNameMatchesOther: true } }),
    );
    expect(s.band).toBe("queue");
    expect(s.rule).toBe("conflict");
  });
});

describe("profileProof", () => {
  const MATCHED = 1917230;
  const NAMESAKE = 10404502;

  it("judges each profile alone: the matched one vouches, a namesake's gains nothing", () => {
    const proof = profileProof(
      [
        { ourProfileIds: [MATCHED], publicationLinked: false }, // old contract
        { ourProfileIds: [MATCHED], publicationLinked: true },
        { ourProfileIds: [NAMESAKE], publicationLinked: false }, // other person's R01
      ],
      new Set([MATCHED]),
    );
    expect(proof).toEqual([{ kind: "matched" }, { kind: "matched" }, null]);
  });

  it("proves a grant-join profile by two OTHER cited awards, never by the award itself", () => {
    const P = 6602684;
    const awards = [
      { ourProfileIds: [P], publicationLinked: false }, // conference grant
      { ourProfileIds: [P], publicationLinked: true },
      { ourProfileIds: [P], publicationLinked: true },
      { ourProfileIds: [P], publicationLinked: true },
    ];
    const proof = profileProof(awards, new Set());
    expect(proof[0]).toEqual({ kind: "siblings", linked: 3 });
    expect(proof[1]).toEqual({ kind: "siblings", linked: 2 });
    expect(profileProof(awards.slice(0, 2), new Set())).toEqual([null, null]);
    expect(PROFILE_PROVEN_MIN_LINKED).toBe(2);
  });
});

describe("rule 4: name rarity", () => {
  it("adds a rare name only next to other evidence", () => {
    expect(ids(ev({ nameProfileCount: 1 }))).toEqual([]);
    expect(scoreAttribution(ev({ nameProfileCount: 1 })).score).toBe(PRIOR);
    const s = scoreAttribution(ev({ coPiSharedPapers: 3, nameProfileCount: 1 }));
    expect(s.reasons.map((r) => r.id)).toEqual(["copi_coauthor", "name_rare"]);
    expect(s.score).toBe(PRIOR + WEIGHTS.copi_coauthor + WEIGHTS.name_rare);
  });

  it("takes one off for a common name, and nothing in between", () => {
    const common = scoreAttribution(ev({ coPiSharedPapers: 3, nameProfileCount: NAME_COMMON_MIN }));
    expect(common.score).toBe(PRIOR + WEIGHTS.copi_coauthor + WEIGHTS.name_common);
    expect(ids(ev({ coPiSharedPapers: 3, nameProfileCount: NAME_COMMON_MIN - 1 }))).toEqual(["copi_coauthor"]);
    expect(ids(ev({ coPiSharedPapers: 3, nameProfileCount: 2 }))).toEqual(["copi_coauthor"]);
  });

  it("is unknown at 0 or null, and ignored for grant-join profiles", () => {
    expect(ids(ev({ coPiSharedPapers: 3, nameProfileCount: 0 }))).toEqual(["copi_coauthor"]);
    expect(ids(ev({ coPiSharedPapers: 3, nameProfileCount: null }))).toEqual(["copi_coauthor"]);
    expect(
      ids(ev({ policy: "publication-only", coPiSharedPapers: 3, nameProfileCount: 1 })),
    ).toEqual(["copi_coauthor"]);
  });

  it("reads a full RePORTER page as a lower bound: common stays common, never rare", () => {
    expect(nameProfileCountFrom(1, 120, 500)).toBe(1);
    expect(nameProfileCountFrom(1, 500, 500)).toBeNull();
    expect(nameProfileCountFrom(4, 500, 500)).toBeNull();
    expect(nameProfileCountFrom(NAME_COMMON_MIN, 500, 500)).toBe(NAME_COMMON_MIN);
  });

  it("stays out of the evidence key, so a moving count never reopens a review", () => {
    const a = scoreAttribution(ev({ coPiSharedPapers: 3, priorInstitution: "X", nameProfileCount: 1 }));
    const b = scoreAttribution(ev({ coPiSharedPapers: 3, priorInstitution: "X", nameProfileCount: 2 }));
    expect(evidenceKey(a)).toBe(evidenceKey(b));
  });
});

describe("held at WCM, with a WCM namesake", () => {
  it("drops to moderate and queues when someone else at WCM shares the name", () => {
    const s = scoreAttribution(ev({ wcmOrgHistory: true, wcmNamesakes: 1 }));
    expect(s.reasons.map((r) => r.id)).toEqual(["wcm_org_shared_name"]);
    expect(s.score).toBe(PRIOR + WEIGHTS.wcm_org_shared_name);
    expect(s.band).toBe("queue");
  });

  it("is the strong tie as before with no namesake, or when the count is unknown", () => {
    expect(ids(ev({ wcmOrgHistory: true, wcmNamesakes: 0 }))).toEqual(["wcm_org"]);
    expect(ids(ev({ wcmOrgHistory: true, wcmNamesakes: null }))).toEqual(["wcm_org"]);
    expect(scoreAttribution(ev({ wcmOrgHistory: true })).band).toBe("show");
  });
});

describe("the NIH profile's PI carries the scholar's surname", () => {
  it("compares RePORTER's surname, in either order, against every name on record", () => {
    expect(piSurnameMatches("SAMPLE, LEE D", ["Lee A. Sample, PhD"])).toBe(true);
    expect(piSurnameMatches("Lee Sample", ["Lee A. Sample"])).toBe(true);
    expect(piSurnameMatches("Lee Sample Jr", ["Lee A. Sample"])).toBe(true);
    expect(piSurnameMatches("EXAMPLE-SAMPLE, LEE", ["Lee Sample"])).toBe(true);
    expect(piSurnameMatches("Pat Other", ["Lee A. Sample", "Lee Sample"])).toBe(false);
    expect(piSurnameMatches("OTHER, LEE", ["Lee Sample"])).toBe(false);
    expect(piSurnameMatches(null, ["Lee Sample"])).toBeNull();
    expect(piSurnameMatches("Pat Other", [null, undefined])).toBeNull();
  });

  it("is strong evidence against: hides with nothing else, queues against a citing paper", () => {
    const alone = scoreAttribution(ev({ piSurnameMatches: false }));
    expect(alone.band).toBe("hide");
    expect(alone.score).toBe(PRIOR + WEIGHTS.pi_name_mismatch);
    const cited = scoreAttribution(ev({ publicationLinked: true, piSurnameMatches: false }));
    expect(cited.band).toBe("queue");
    expect(cited.rule).toBe("conflict");
  });

  it("stops a profile that isn't the scholar's from vouching for its awards", () => {
    const s = scoreAttribution(
      ev({ profileProven: { kind: "siblings", linked: 2 }, piSurnameMatches: false }),
    );
    expect(s.reasons.map((r) => r.id)).toEqual(["pi_name_mismatch"]);
    expect(s.band).toBe("hide");
    expect(ids(ev({ profileProven: { kind: "matched" }, piSurnameMatches: true }))).toEqual(["profile_proven"]);
  });
});
