/**
 * Name-matching RECALL for the news matcher (etl/news/names.ts). The older
 * suite (news-names.test.ts) was built from clean matches; this one targets
 * the shapes measured MISSING on prod 10-07: a middle name or initial on one
 * side only, a roster middle name used as the first name, a compound surname
 * cut to its first part, and a nickname. Every name here is invented.
 */
import { describe, expect, it } from "vitest";

import {
  buildNameIndex,
  countUnmatchedPersonTags,
  detectMentions,
  type MentionSources,
  type ScholarNameInput,
} from "@/etl/news/names";

const scholar = (
  cwid: string,
  fullName: string,
  preferredName: string | null = fullName,
): ScholarNameInput => ({
  cwid,
  fullName,
  preferredName,
  primaryTitle: null,
  primaryDepartment: null,
});

const sources = (over: Partial<MentionSources> = {}): MentionSources => ({
  title: "",
  text: "",
  tags: [],
  captionText: "",
  ...over,
});

const ROSTER = [
  scholar("zzr0001", "Samira R Vellacott"),
  scholar("zzr0002", "Dorian Avi Quellmark"),
  scholar("zzr0003", "Kestrel Ragusa Penhallow"),
  scholar("zzr0004", "Annika Strathorne"),
  scholar("zzr0005", "Marisol Elspeth Thornquist"),
  scholar("zzr0006", "Teodora Valcarce Brennhold"),
  scholar("zzr0007", "Robert Fenwhistle"),
  scholar("zzr0008", "Eftychia Marlowind"),
  scholar("zzr0009", "Corwin B Haldane"),
  scholar("zzr0010", "Lydia M Farrowgate"),
  scholar("zzr0011", "Lydia P Farrowgate"),
  scholar("zzr0012", "Imogen Pellwright"),
];
const index = buildNameIndex(ROSTER);
const tagged = (tags: string[], idx = index) => detectMentions(sources({ tags }), idx);

describe("tags: middle tokens are ignored on BOTH sides", () => {
  it("roster has a middle initial the tag omits", () => {
    expect(tagged(["Dr. Samira Vellacott"])).toMatchObject([
      { cwid: "zzr0001", basis: "TAG", likelihood: "HIGH" },
    ]);
  });

  it("roster has a middle NAME the tag omits", () => {
    expect(tagged(["Dr. Dorian Quellmark"])).toMatchObject([
      { cwid: "zzr0002", basis: "TAG", likelihood: "HIGH" },
    ]);
  });

  it("tag has an initial, roster has the full middle name it abbreviates", () => {
    expect(tagged(["Dr. Kestrel R. Penhallow"])).toMatchObject([
      { cwid: "zzr0003", basis: "TAG", likelihood: "HIGH" },
    ]);
  });

  it("tag has a middle NAME the roster omits", () => {
    expect(tagged(["Dr. Annika Lise Strathorne"])).toMatchObject([
      { cwid: "zzr0004", basis: "TAG", likelihood: "HIGH" },
    ]);
  });

  it("drops trailing suffixes and credentials", () => {
    expect(tagged(["Dr. Samira Vellacott, MD, PhD"]).map((h) => h.cwid)).toEqual(["zzr0001"]);
    expect(tagged(["Dorian Quellmark Jr."]).map((h) => h.cwid)).toEqual(["zzr0002"]);
  });

  it("middle initials that DISAGREE are two different people", () => {
    expect(tagged(["Dr. Corwin A. Haldane"])).toEqual([]);
    expect(tagged(["Dr. Corwin B. Haldane"]).map((h) => h.cwid)).toEqual(["zzr0009"]);
  });

  it("two roster people sharing first+last are contested: both capped at MEDIUM, one groupKey", () => {
    const hits = tagged(["Dr. Lydia Farrowgate"]);
    expect(hits.map((h) => h.cwid).sort()).toEqual(["zzr0010", "zzr0011"]);
    expect(hits.every((h) => h.likelihood === "MEDIUM" && h.basis === "TAG")).toBe(true);
    expect(new Set(hits.map((h) => h.groupKey))).toEqual(new Set(["lydia farrowgate"]));
  });

  it("a VIVO-linked scholar is still excluded", () => {
    expect(
      detectMentions(sources({ tags: ["Dr. Samira Vellacott"] }), index, new Set(["zzr0001"])),
    ).toEqual([]);
  });
});

describe("tags: org-name guards still hold for the looser rule", () => {
  it("rejects donor-name centers and phrases", () => {
    expect(tagged(["Imogen and Ezra Pellwright Cancer Center"])).toEqual([]);
    expect(tagged(["Imogen and Ezra Pellwright"])).toEqual([]);
    expect(tagged(["Imogen & Ezra Pellwright"])).toEqual([]);
    expect(tagged(["Imogen of the Pellwright"])).toEqual([]);
  });

  it("rejects more than two full words between first and last", () => {
    expect(tagged(["Imogen Hall Annex Wing Pellwright"])).toEqual([]);
    expect(tagged(["Imogen Hall Annex Pellwright"]).map((h) => h.cwid)).toEqual(["zzr0012"]);
  });
});

describe("tags: weak rules are MEDIUM and need a unique roster match", () => {
  it("a roster MIDDLE name used as the first name", () => {
    expect(tagged(["Dr. Elspeth Thornquist"])).toMatchObject([
      { cwid: "zzr0005", basis: "TAG", likelihood: "MEDIUM", groupKey: "elspeth thornquist" },
    ]);
  });

  it("a compound surname cut to its first part", () => {
    expect(tagged(["Dr. Teodora Valcarce"])).toMatchObject([
      { cwid: "zzr0006", basis: "TAG", likelihood: "MEDIUM" },
    ]);
  });

  it("a table nickname", () => {
    expect(tagged(["Dr. Rob Fenwhistle"])).toMatchObject([
      { cwid: "zzr0007", basis: "TAG", likelihood: "MEDIUM" },
    ]);
    expect(tagged(["Dr. Bobby Fenwhistle"]).map((h) => h.cwid)).toEqual(["zzr0007"]);
  });

  it("a short form that is not in the table does not match", () => {
    expect(tagged(["Dr. Effie Marlowind"])).toEqual([]);
    expect(tagged(["Dr. Roberta Fenwhistle"])).toEqual([]);
  });

  it("two roster people sharing the middle name -> no hit", () => {
    const idx = buildNameIndex([
      scholar("zzr0101", "Ophelia Juniper Castellane"),
      scholar("zzr0102", "Beatrice Juniper Castellane"),
    ]);
    expect(tagged(["Dr. Juniper Castellane"], idx)).toEqual([]);
  });

  it("two roster people reachable by the same nickname -> no hit", () => {
    const idx = buildNameIndex([
      scholar("zzr0201", "William Tavernor"),
      scholar("zzr0202", "Billy Tavernor"),
    ]);
    expect(tagged(["Dr. Will Tavernor"], idx)).toEqual([]);
  });

  it("two people matched by DIFFERENT weak rules -> no hit", () => {
    const idx = buildNameIndex([
      scholar("zzr0301", "Robert Quillon"),
      scholar("zzr0302", "Agatha Rob Quillon"),
    ]);
    expect(tagged(["Dr. Rob Quillon"], idx)).toEqual([]);
  });

  it("a strong first+last match on the roster suppresses the weak rules", () => {
    const idx = buildNameIndex([
      scholar("zzr0401", "Elspeth Thornquist"),
      scholar("zzr0402", "Marisol Elspeth Thornquist"),
    ]);
    expect(tagged(["Dr. Elspeth Thornquist"], idx)).toMatchObject([
      { cwid: "zzr0401", likelihood: "HIGH" },
    ]);
  });

  it("uniqueness counts a VIVO-linked scholar too (roster-wide, not per article)", () => {
    const idx = buildNameIndex([
      scholar("zzr0101", "Ophelia Juniper Castellane"),
      scholar("zzr0102", "Beatrice Juniper Castellane"),
    ]);
    expect(
      detectMentions(sources({ tags: ["Dr. Juniper Castellane"] }), idx, new Set(["zzr0101"])),
    ).toEqual([]);
  });
});

describe("prose: first+last of a middle-bearing name, when unique on the roster", () => {
  it("matches the bare first+last in the body", () => {
    const hits = detectMentions(
      sources({ text: "The study was led by Samira Vellacott and colleagues." }),
      index,
    );
    expect(hits).toMatchObject([{ cwid: "zzr0001", basis: "BODY", groupKey: "samira vellacott" }]);
  });

  it("does not when two roster people share the first+last", () => {
    expect(
      detectMentions(sources({ text: "Remarks from Lydia Farrowgate followed." }), index),
    ).toEqual([]);
  });

  it("the full middle-bearing name still matches as before", () => {
    const hits = detectMentions(
      sources({ text: "Remarks from Lydia M Farrowgate followed." }),
      index,
    );
    expect(hits.map((h) => h.cwid)).toEqual(["zzr0010"]);
  });

  it("caption gets the same first+last sequence", () => {
    expect(
      detectMentions(sources({ captionText: "Dorian Quellmark in the lab" }), index),
    ).toMatchObject([{ cwid: "zzr0002", basis: "CAPTION", likelihood: "LOW" }]);
  });
});

describe("countUnmatchedPersonTags", () => {
  it("counts only 'Dr.' tags that name nobody, against the whole roster", () => {
    expect(
      countUnmatchedPersonTags(
        [
          "Dr. Samira Vellacott",
          "Dr. Nobody Unlisted",
          "Oncology",
          "Dr. Effie Marlowind",
          "Dr. Lydia Farrowgate",
        ],
        index,
      ),
    ).toBe(2);
  });
});
