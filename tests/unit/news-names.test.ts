/**
 * Deterministic scholar-name detection (etl/news/names.ts). No network, no DB.
 *
 * Covers the queue's inputs: a full name shared by two scholars becomes a
 * contested pair (same groupKey); a lone surname is never proposed; a diacritic
 * name folds; a VIVO-linked scholar is excluded from the weaker prose pass.
 *
 * #2578 adds the confidence tiering: the newsroom feed's OWN story tags are the
 * strongest signal (HIGH), a photo caption is LOW, and a prose hit that only
 * ever appears inside an endowed-chair or memorial phrase is demoted to LOW.
 * The two regression cases near the bottom are the reason the change exists and
 * are pinned against the real live tag lists.
 *
 * #2578 FOLLOW-UP adds the BODY score (0..7, banded HIGH/MEDIUM/LOW) that
 * replaced the old flat BODY -> MEDIUM band, plus the context-snippet capture.
 * See the "BODY score components" and the final regression test below.
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
  title: "",
  text: "",
  tags: [],
  captionText: "",
  ...over,
});

/** `n` filler tokens that never match a scholar surname — lets a fixture place
 *  a name at an EXACT fraction of the token stream without hand-counting words
 *  (#2578 follow-up BODY-score tests). */
const filler = (n: number) => Array(n).fill("x").join(" ");

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

  it("emits a scored LOW/BODY for a plain prose match with none of the four score signals (#2578 follow-up)", () => {
    // "Xiaojing Ma" is at token index 3 of 7 (43%: past the first third), named
    // once, no feed tags at all (so no department bonus), and no headline — so
    // every one of the four score signals is absent and the score is 0.
    // Also pins the exact context snippet: the whole text, since it is shorter
    // than the extraction radius on both sides.
    const hits = detectMentions(
      sources({ text: "Findings by Dr. Xiaojing Ma were published." }),
      index,
    );
    expect(hits).toEqual([
      {
        cwid: "xim2002",
        detectedName: "Xiaojing Ma",
        likelihood: "LOW",
        basis: "BODY",
        groupKey: "xiaojing ma",
        contextSnippet: "Findings by Dr. Xiaojing Ma were published.",
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
        // TAG has no prose position to snippet (#2578 follow-up).
        contextSnippet: null,
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
        // CAPTION's occurrence lives in captionText, a separate stream with no
        // position in the scanned text (#2578 follow-up).
        contextSnippet: null,
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

  it("caps a contested BODY match at MEDIUM even when its score alone would be HIGH", () => {
    // "David Cohen" is at token index 0 of 11 (< 10% -> +3), mentioned twice
    // (+1) = score 4 = HIGH on its own. The contested cap (a folded full name
    // shared by >1 scholar) pulls it down to MEDIUM, same as it would a
    // contested TAG or a contested score that only just cleared MEDIUM — the
    // cap is a ceiling, not a re-scoring.
    const hits = detectMentions(
      sources({ text: "David Cohen chaired the panel. Later, David Cohen closed the session." }),
      index,
    );
    expect(hits.map((h) => h.cwid).sort()).toEqual(["dco1", "dco2"]);
    expect(hits.every((h) => h.basis === "BODY")).toBe(true);
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
 * #2578 follow-up — the four BODY score signals, each isolated with a fixture
 * built from `filler()` tokens so the exact position fraction is arithmetic,
 * not eyeballed, plus the two required band boundaries (1/2 and 3/4). Weights
 * and boundary provenance are documented on `scoreBodyMention`/`bandForScore`
 * in etl/news/names.ts; this file only pins the resulting behaviour.
 */
describe("BODY score components + band boundaries (#2578 follow-up)", () => {
  const index = buildNameIndex([
    scholar({ cwid: "jsm1", fullName: "Jane Smith", primaryDepartment: "Neurology" }),
  ]);
  const hit = (over: Partial<MentionSources>) => detectMentions(sources(over), index)[0];

  it("position in the first tenth alone scores +3 -> MEDIUM (score 3)", () => {
    // "Jane Smith" at token index 5 of 100 (5%, under the 10% cutoff).
    const hits = hit({ text: `${filler(5)} Jane Smith ${filler(93)}` });
    expect(hits).toMatchObject({ basis: "BODY", likelihood: "MEDIUM" });
  });

  it("...plus a second mention crosses into HIGH (score 4) — the 3/4 boundary", () => {
    // Identical to the case above but the name is repeated once more: +3 (still
    // in the first tenth) +1 (mentioned twice) = 4.
    const hits = hit({ text: `${filler(5)} Jane Smith ${filler(40)} Jane Smith ${filler(53)}` });
    expect(hits).toMatchObject({ basis: "BODY", likelihood: "HIGH" });
  });

  it("position in the first third, but NOT the first tenth, scores +1 -> LOW (score 1)", () => {
    // Index 20 of 100 (20%: in the first third, past the first tenth).
    const hits = hit({ text: `${filler(20)} Jane Smith ${filler(78)}` });
    expect(hits).toMatchObject({ basis: "BODY", likelihood: "LOW" });
  });

  it("...plus a second mention crosses into MEDIUM (score 2) — the 1/2 boundary", () => {
    // +1 (first-third position) +1 (mentioned twice) = 2.
    const hits = hit({ text: `${filler(20)} Jane Smith ${filler(58)} Jane Smith ${filler(18)}` });
    expect(hits).toMatchObject({ basis: "BODY", likelihood: "MEDIUM" });
  });

  it("outside the first third and mentioned once earns no bonus -> LOW (score 0)", () => {
    // Index 50 of 100 (50%: past the first third).
    const hits = hit({ text: `${filler(50)} Jane Smith ${filler(48)}` });
    expect(hits).toMatchObject({ basis: "BODY", likelihood: "LOW" });
  });

  it("mentioned more than once, ALONE, scores +1 -> LOW (score 1)", () => {
    // Both occurrences sit past the first third (50/104 and 82/104), so the
    // repeat bonus is the only signal firing.
    const hits = hit({ text: `${filler(50)} Jane Smith ${filler(30)} Jane Smith ${filler(20)}` });
    expect(hits).toMatchObject({ basis: "BODY", likelihood: "LOW" });
  });

  it("a feed tag containing the scholar's own department, ALONE, scores +2 -> MEDIUM (score 2)", () => {
    const hits = hit({
      text: `${filler(50)} Jane Smith ${filler(48)}`,
      tags: ["Neurology research"],
    });
    expect(hits).toMatchObject({ basis: "BODY", likelihood: "MEDIUM" });
  });

  it("named in the headline, ALONE, scores +1 -> LOW (score 1)", () => {
    // The headline itself is 42 tokens (36 filler + "Jane Smith wins prize
    // today finally"), with the name at index 36 — still under a third of the
    // combined 62-token stream, so no position bonus fires and the headline
    // bonus is isolated.
    const title = `${filler(36)} Jane Smith wins prize today finally`;
    const hits = hit({ title, text: `${title} ${filler(20)}` });
    expect(hits).toMatchObject({ basis: "BODY", likelihood: "LOW" });
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
        title: "White Coat Ceremony Kicks off Medical Education for M.D. Class of 2030",
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
    // #2578 follow-up — the reviewer-facing snippet: this is what makes the
    // rejection instant without opening the article.
    expect(byCwid.owi1.contextSnippet).not.toBeNull();
    expect(byCwid.owi1.contextSnippet).toContain("O. Wayne Isom");

    // Girardi, who holds the chair and gave the address, IS tagged.
    expect(byCwid.lng1).toMatchObject({ likelihood: "HIGH", basis: "TAG" });
    // A TAG row gets a snippet too, taken from the prose. The feed tags the
    // people a story quotes, so a tagged scholar is normally also named in the
    // body — and the HIGH rows are the ones a reviewer is actually deciding on,
    // so leaving them contextless would defeat the point of the snippet.
    expect(byCwid.lng1.contextSnippet).not.toBeNull();
    expect(byCwid.lng1.contextSnippet).toContain("Girardi");
  });

  it("a tag-only mention — name never in the prose — has no snippet to quote", () => {
    // The one case that legitimately stays null: tagged, but absent from the
    // body, so there is no prose position to extract.
    const index = buildNameIndex([
      {
        cwid: "abs1",
        fullName: "Alexis Nordgren",
        preferredName: "Alexis Nordgren",
        primaryTitle: "Professor",
        primaryDepartment: "Neurology",
      },
    ]);
    const [hit] = detectMentions(
      {
        title: "A study with no faculty named in the prose",
        text: "A study with no faculty named in the prose. The work was described in a journal.",
        tags: ["Alexis Nordgren", "Neurology"],
        captionText: "",
      },
      index,
    );
    expect(hit).toMatchObject({ likelihood: "HIGH", basis: "TAG" });
    expect(hit!.contextSnippet).toBeNull();
  });

  it("Radiopharmaceutical: Coleman is demoted, Tagawa is reachable at the tag tier", () => {
    const index = buildNameIndex([
      scholar({ cwid: "mco1", fullName: "Morton Coleman" }),
      scholar({ cwid: "sta1", fullName: "Scott Tagawa" }),
    ]);
    const hits = detectMentions(
      {
        title: "Radiopharmaceutical May Benefit Patients with Metastatic Prostate Cancer Sooner",
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
    // when their name also appears in a chair title. This particular fixture
    // also happens to score HIGH (index 1 of 13 tokens = 7.7%, under the first
    // tenth: +3; mentioned twice: +1 = 4) — incidental to the point, which is
    // that basis stays BODY, never TITLE.
    const index = buildNameIndex([scholar({ cwid: "own1", fullName: "Owen North" })]);
    const hits = detectMentions(
      sources({
        text: "the Owen North Professor of Surgery. Separately, Dr. Owen North led the trial.",
      }),
      index,
    );
    expect(hits[0]).toMatchObject({ basis: "BODY", likelihood: "HIGH" });
  });

  /**
   * The regression test #2578's follow-up spec calls out by name: the guard
   * that makes the BODY score safe to ship is that TITLE is decided and
   * short-circuited BEFORE `scoreBodyMention` ever runs (see the module
   * docblock in etl/news/names.ts). This fixture is deliberately built so that,
   * WERE it scored instead of short-circuited, it would earn HIGH: the name
   * sits at token index 4 of 25 (16% — a first-third position bonus, +1), is
   * mentioned twice (+1), and a feed tag contains the scholar's own department
   * (+2) — 4 points, >= HIGH_SCORE. It must stay LOW/TITLE regardless, because
   * EVERY occurrence sits inside "the … Professor of …".
   *
   * Verified locally that this test actually exercises the guard: temporarily
   * removing the short-circuit (making TITLE fall through into
   * scoreBodyMention like BODY does) turns this test red — it asserts HIGH/BODY
   * instead of LOW/TITLE — confirming it is not vacuous.
   */
  it("stays LOW/TITLE even positioned early and mentioned twice — proves scoring cannot promote an honorific match", () => {
    const index = buildNameIndex([
      scholar({
        cwid: "owi1",
        fullName: "O Wayne Isom",
        primaryTitle: "Professor Emeritus",
        primaryDepartment: "Cardiothoracic Surgery",
      }),
    ]);
    const hits = detectMentions(
      sources({
        text:
          "Alumni gathered as the O. Wayne Isom Professor of Cardiothoracic Surgery welcomed the class. " +
          "Later, the O. Wayne Isom Professor of Cardiothoracic Surgery addressed guests.",
        // The scholar's own department, present in a tag — would earn the
        // DEPARTMENT_TAG_BONUS if this were ever scored.
        tags: ["Cardiothoracic Surgery"],
      }),
      index,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ likelihood: "LOW", basis: "TITLE" });
  });
});
