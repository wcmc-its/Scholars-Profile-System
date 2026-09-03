/**
 * Deterministic scholar-name detection (etl/news/names.ts). No network, no DB.
 *
 * Covers the queue's inputs: a full name shared by two scholars becomes a
 * contested pair (same groupKey); a lone surname is never proposed; a diacritic
 * name folds; a VIVO-linked scholar is excluded from the weaker prose pass.
 *
 * #2578 adds the confidence tiering: the newsroom feed's OWN story tags are the
 * strongest signal (HIGH), prose is MEDIUM, a photo caption is LOW, and a prose
 * hit that only ever appears inside an endowed-chair or memorial phrase is
 * demoted to LOW. The two regression cases at the bottom are the reason the
 * change exists and are pinned against the real live tag lists.
 */
import { describe, expect, it } from "vitest";

import {
  buildNameIndex,
  detectMentions,
  foldToken,
  honorificNamePhrases,
  tokenize,
  type MentionSources,
  type ScholarNameInput,
} from "@/etl/news/names";

const scholar = (over: Partial<ScholarNameInput> & { cwid: string; fullName: string }): ScholarNameInput => ({
  preferredName: over.fullName,
  primaryTitle: null,
  primaryDepartment: null,
  ...over,
});

/** Article sources with everything absent by default, so each test names only
 *  the stream it is exercising. */
const sources = (over: Partial<MentionSources> = {}): MentionSources => ({
  text: "",
  tags: [],
  captionText: "",
  ...over,
});

describe("foldToken", () => {
  it("folds diacritics to base ASCII, lowercase", () => {
    expect(foldToken("José")).toBe("jose");
    expect(foldToken("Muñoz")).toBe("munoz");
    expect(foldToken("O'Brien")).toBe("obrien");
  });
});

describe("tokenize", () => {
  it("keeps accented words whole then folds them", () => {
    expect(tokenize("Dr. José García, PhD")).toEqual(["dr", "jose", "garcia", "phd"]);
  });
});

describe("detectMentions", () => {
  const index = buildNameIndex([
    scholar({ cwid: "xim2002", fullName: "Xiaojing Ma", primaryTitle: "Professor", primaryDepartment: "Microbiology" }),
    scholar({ cwid: "dco1", fullName: "David Cohen", primaryTitle: "Prof A", primaryDepartment: "Dept A" }),
    scholar({ cwid: "dco2", fullName: "David Cohen", primaryTitle: "Prof B", primaryDepartment: "Dept B" }),
  ]);

  it("emits MEDIUM/BODY for a unique full-name match in prose", () => {
    // #2578 — prose alone is now MEDIUM, not HIGH. Only the feed's own tags earn
    // HIGH, because prose is exactly what the endowed-chair false positives
    // exploited.
    const hits = detectMentions(
      sources({ text: "Findings by Dr. Xiaojing Ma were published." }),
      index,
    );
    expect(hits).toEqual([
      {
        cwid: "xim2002",
        detectedName: "Xiaojing Ma",
        likelihood: "MEDIUM",
        basis: "BODY",
        groupKey: "xiaojing ma",
      },
    ]);
  });

  it("emits HIGH/TAG when the feed tags the scholar itself", () => {
    const hits = detectMentions(sources({ tags: ["Dr. Xiaojing Ma", "Research"] }), index);
    expect(hits).toEqual([
      {
        cwid: "xim2002",
        detectedName: "Xiaojing Ma",
        likelihood: "HIGH",
        basis: "TAG",
        groupKey: "xiaojing ma",
      },
    ]);
  });

  it("emits LOW/CAPTION when the name appears only in photo alt text", () => {
    const hits = detectMentions(
      sources({ text: "A study of zebrafish hearts.", captionText: "Headshot of Xiaojing Ma" }),
      index,
    );
    expect(hits).toEqual([
      {
        cwid: "xim2002",
        detectedName: "Xiaojing Ma",
        likelihood: "LOW",
        basis: "CAPTION",
        groupKey: "xiaojing ma",
      },
    ]);
  });

  it("takes the STRONGEST basis when a scholar appears in several streams", () => {
    const hits = detectMentions(
      sources({
        text: "Dr. Xiaojing Ma said.",
        tags: ["Dr. Xiaojing Ma"],
        captionText: "Xiaojing Ma",
      }),
      index,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ likelihood: "HIGH", basis: "TAG" });
  });

  it("emits a contested MEDIUM pair when a full name resolves to two scholars", () => {
    const hits = detectMentions(sources({ text: "Co-author David Cohen commented." }), index);
    expect(hits.map((h) => h.cwid).sort()).toEqual(["dco1", "dco2"]);
    expect(hits.every((h) => h.likelihood === "MEDIUM")).toBe(true);
    // Same groupKey => the queue groups them as one single-select decision.
    expect(new Set(hits.map((h) => h.groupKey)).size).toBe(1);
  });

  it("keeps a TAG match contested — and caps it at MEDIUM, never HIGH", () => {
    // A tag naming "David Cohen" says the story is about *a* David Cohen, not
    // which one. Basis stays TAG (that IS how it was found) but the confidence
    // in this particular pair is not high, and the queue must still single-select.
    const hits = detectMentions(sources({ tags: ["Dr. David Cohen"] }), index);
    expect(hits.map((h) => h.cwid).sort()).toEqual(["dco1", "dco2"]);
    expect(hits.every((h) => h.basis === "TAG")).toBe(true);
    expect(hits.every((h) => h.likelihood === "MEDIUM")).toBe(true);
    expect(new Set(hits.map((h) => h.groupKey)).size).toBe(1);
  });

  it("contested is a CAP, never a promotion — a contested caption stays LOW", () => {
    const hits = detectMentions(sources({ captionText: "David Cohen at the podium" }), index);
    expect(hits.map((h) => h.cwid).sort()).toEqual(["dco1", "dco2"]);
    expect(hits.every((h) => h.likelihood === "LOW")).toBe(true);
  });

  it("never proposes a lone surname", () => {
    expect(detectMentions(sources({ text: "Ma's lab reported results." }), index)).toEqual([]);
    expect(detectMentions(sources({ text: "The Cohen criterion was applied." }), index)).toEqual([]);
  });

  it("excludes a VIVO-linked scholar from the prose pass", () => {
    const hits = detectMentions(
      sources({ text: "Dr. Xiaojing Ma and David Cohen collaborated." }),
      index,
      new Set(["xim2002"]),
    );
    expect(hits.map((h) => h.cwid).sort()).toEqual(["dco1", "dco2"]);
  });

  it("excludes a VIVO-linked scholar from the TAG pass too", () => {
    // The identifier join already published them; a tag must not re-propose the
    // same person as a weaker pending candidate.
    const hits = detectMentions(
      sources({ tags: ["Dr. Xiaojing Ma"] }),
      index,
      new Set(["xim2002"]),
    );
    expect(hits).toEqual([]);
  });
});

describe("tag matching tolerates how the feed writes names", () => {
  const index = buildNameIndex([
    scholar({ cwid: "rah1", fullName: "Robert Harrington" }),
    scholar({ cwid: "owi1", fullName: "O Wayne Isom" }),
    scholar({ cwid: "smey1", fullName: "Sandra Meyer" }),
    scholar({ cwid: "idr1", fullName: "Ira Drukier" }),
  ]);
  const hit = (tags: string[]) => detectMentions(sources({ tags }), index);

  it("matches through a 'Dr. ' honorific AND a middle initial", () => {
    // The feed writes "Dr. Robert A. Harrington"; the roster says "Robert
    // Harrington". A consecutive-run match fails on the interposed initial.
    const hits = hit(["Dr. Robert A. Harrington", "Institutional"]);
    expect(hits.map((h) => h.cwid)).toEqual(["rah1"]);
    expect(hits[0]).toMatchObject({ likelihood: "HIGH", basis: "TAG" });
  });

  it("matches across punctuation — 'O. Wayne Isom' vs roster 'O Wayne Isom'", () => {
    expect(hit(["O. Wayne Isom"]).map((h) => h.cwid)).toEqual(["owi1"]);
  });

  it("does NOT match a center whose donor name embeds a scholar's first+last", () => {
    // The guard that makes the loose rule safe: a person tag ends on the
    // surname, so these org tags are rejected even though both contain a
    // plausible first+last pair.
    expect(hit(["Sandra and Edward Meyer Cancer Center"])).toEqual([]);
    expect(hit(["Gale and Ira Drukier Institute for Children's Health"])).toEqual([]);
  });

  it("does not blur two tag entries into one match across the comma", () => {
    // "…Cancer Center" followed by "Ira Drukier" must not join up.
    expect(hit(["Sandra Cancer Center", "Edward Meyer"])).toEqual([]);
  });
});

describe("honorificNamePhrases — the endowed-chair shapes (#2578)", () => {
  it("captures the '<name> Professor of' shape", () => {
    expect(
      honorificNamePhrases("and the O. Wayne Isom Professor of Cardiothoracic Surgery, commended"),
    ).toEqual([["o", "wayne", "isom"]]);
  });

  it("captures the 'in honor of <name>' shape", () => {
    expect(
      honorificNamePhrases("Professor of Hematology-Oncology in honor of Morton Coleman, M.D. at"),
    ).toContainEqual(["morton", "coleman"]);
  });

  it("does NOT fire on a scholar's REAL title — comma + lowercase 'professor'", () => {
    // Measured across 300 live stories: ", professor of" 75 hits (real titles),
    // ", Professor of" 0. Capitalization plus the comma is the whole
    // discriminator, and it is destroyed by token folding — which is why these
    // patterns run on raw text.
    expect(honorificNamePhrases("said Dr. Jane Smith, professor of medicine at Weill Cornell")).toEqual(
      [],
    );
  });
});

/**
 * The two rejections that motivated #2578, pinned against the REAL body text and
 * the REAL `term_node_tid` lists from the live feed (both verified 2026-09-03).
 *
 * Before this change both produced a HIGH candidate for a memorialized figure the
 * article is not about, while the person the article IS about went unproposed.
 * The two have deliberately different shapes — "<name> Professor of" vs "in honor
 * of <name>, M.D." — so a phrase regex alone would only ever have caught one.
 */
describe("#2578 regression — endowed-chair names must not outrank the tagged faculty", () => {
  it("White Coat Ceremony: Isom is demoted, Girardi is reachable at the tag tier", () => {
    const index = buildNameIndex([
      scholar({ cwid: "owi1", fullName: "O Wayne Isom", primaryTitle: "Professor Emeritus" }),
      scholar({ cwid: "lng1", fullName: "Leonard Girardi", primaryTitle: "Chair, Cardiothoracic Surgery" }),
    ]);
    const hits = detectMentions(
      {
        text:
          "White Coat Ceremony Kicks off Medical Education for M.D. Class of 2030 " +
          "In his keynote address, Dr. Leonard Girardi, M.D. '89 , chair of the Department of " +
          "Cardiothoracic Surgery and the O. Wayne Isom Professor of Cardiothoracic Surgery, " +
          "commended the students.",
        tags: [
          "Cassandra Stecker",
          "Dr. Joseph Safdieh",
          "Dr. Leonard Girardi",
          "Dr. Robert A. Harrington",
          "Education",
          "Institutional",
          "Kiran Abraham-Aggarwal",
          "Weill Cornell Medical College",
          "News from WCM",
        ],
        captionText: "A group of students wearing white coats",
      },
      index,
    );
    const byCwid = Object.fromEntries(hits.map((h) => [h.cwid, h]));

    // Isom holds the chair's NAME only — the feed does not tag him.
    expect(byCwid.owi1.likelihood).toBe("LOW");
    expect(byCwid.owi1.basis).toBe("TITLE");
    expect(byCwid.owi1.likelihood).not.toBe("HIGH");

    // Girardi, who holds the chair and gave the address, IS tagged.
    expect(byCwid.lng1).toMatchObject({ likelihood: "HIGH", basis: "TAG" });
  });

  it("Radiopharmaceutical: Coleman is demoted, Tagawa is reachable at the tag tier", () => {
    const index = buildNameIndex([
      scholar({ cwid: "mco1", fullName: "Morton Coleman" }),
      scholar({ cwid: "sta1", fullName: "Scott Tagawa" }),
    ]);
    const hits = detectMentions(
      {
        text:
          "Radiopharmaceutical May Benefit Patients with Metastatic Prostate Cancer Sooner " +
          "said lead author Dr. Scott Tagawa, the Gebroe Family Professor of Hematology-Oncology " +
          "in honor of Morton Coleman, M.D. at Weill Cornell Medicine and director of the " +
          "genitourinary oncology program.",
        tags: [
          "Dr. Scott Tagawa",
          "Englander Institute for Precision Medicine",
          "Hematology and Oncology",
          "Hematology/Medical Oncology",
          "Patient Care",
          "Research",
          "Sandra and Edward Meyer Cancer Center",
          "News from WCM",
        ],
        captionText: "prostate cancer cell with cholesterol",
      },
      index,
    );
    const byCwid = Object.fromEntries(hits.map((h) => [h.cwid, h]));

    // "in honor of <name>, M.D." — a memorial, not the subject of the article.
    expect(byCwid.mco1.likelihood).toBe("LOW");
    expect(byCwid.mco1.basis).toBe("TITLE");
    expect(byCwid.mco1.likelihood).not.toBe("HIGH");

    expect(byCwid.sta1).toMatchObject({ likelihood: "HIGH", basis: "TAG" });
  });

  it("a chair-holder named ELSEWHERE in the prose is not demoted with the chair", () => {
    // "Every occurrence", not "any": the demotion counts honorific hits against
    // total body hits, so someone quoted in the story keeps the prose tier even
    // when their name also appears in a chair title.
    const index = buildNameIndex([scholar({ cwid: "own1", fullName: "Owen North" })]);
    const hits = detectMentions(
      sources({
        text: "the Owen North Professor of Surgery. Separately, Dr. Owen North led the trial.",
      }),
      index,
    );
    expect(hits[0]).toMatchObject({ likelihood: "MEDIUM", basis: "BODY" });
  });
});
