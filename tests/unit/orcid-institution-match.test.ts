/**
 * `etl/orcid-evidence/institution-match` — history_match (ORCID queue v2 spec,
 * item 1): normalization (case, punctuation, diacritics, "The", "University of
 * X" vs "X University", abbreviations), the prefix rules, and that generic
 * words alone never match. Plus the ReCiter Identity `institutions` reader.
 */
import { describe, expect, it, vi } from "vitest";

import {
  historyMatches,
  institutionsMatch,
  institutionTokens,
} from "@/etl/orcid-evidence/institution-match";
import {
  IDENTITY_INSTITUTIONS_SCAN,
  institutionsFromIdentityItem,
  loadIdentityInstitutions,
} from "@/etl/orcid-evidence/identity-institutions";

describe("institutionsMatch", () => {
  it.each([
    ["Albany Medical College", "Albany Medical College of Union University"],
    ["University of Rochester", "Rochester University"],
    ["University of Rochester", "University of Rochester Medical Center"],
    ["The Johns Hopkins University", "Johns Hopkins University"],
    ["Université de Montréal", "Universite de Montreal"],
    ["Memorial Sloan-Kettering Cancer Center", "Memorial Sloan Kettering Cancer Ctr."],
    ["MSKCC", "Memorial Sloan Kettering Cancer Center"],
    ["St. Jude Children's Research Hospital", "Saint Jude Childrens Research Hospital"],
    ["Brigham & Women's Hospital", "Brigham and Women's Hospital"],
    ["Massachusetts General Hospital, Harvard Medical School", "Harvard Medical School"],
    ["Dept. of Medicine, Albany Medical College", "Albany Medical College"],
    ["New York University", "New York University School of Medicine"],
    ["UCSF", "University of California, San Francisco"],
    ["Mount Sinai Hospital", "Mt. Sinai Hospital"],
  ])("%s ↔ %s", (a, b) => {
    expect(institutionsMatch(a, b)).toBe(true);
    expect(institutionsMatch(b, a)).toBe(true);
  });

  it.each([
    ["University Hospital", "University Hospital"],
    ["Medical Center", "Medical Center"],
    ["School of Medicine", "School of Medicine"],
    ["Ohio University", "Ohio State University"],
    ["University of California, San Francisco", "University of California, Los Angeles"],
    ["University of California", "University of California, San Francisco"],
    ["University of Texas", "University of Texas at Austin"],
    ["Harvard University", "Harvard Medical School"],
    ["Columbia University", "Columbia College Chicago"],
    ["Albany Medical College", "Albany College of Pharmacy"],
  ])("%s ≠ %s", (a, b) => {
    expect(institutionsMatch(a, b)).toBe(false);
    expect(institutionsMatch(b, a)).toBe(false);
  });

  it("institutionTokens folds, drops punctuation and a leading The, expands abbreviations", () => {
    expect(institutionTokens("The Univ. of Rochester Med. Ctr.")).toEqual([
      "university",
      "of",
      "rochester",
      "medical",
      "center",
    ]);
  });
});

describe("historyMatches", () => {
  it("pairs each matching ORCID affiliation with the history entry it matched, once", () => {
    const pairs = historyMatches(
      [
        { name: "Albany Medical College", ror: null, kind: "employment", start: 1996, end: 2001 },
        { name: "Albany Medical College", ror: null, kind: "employment", start: 1996, end: 2001 },
        { name: "Medical Center", ror: null, kind: "employment", start: null, end: null },
        { name: null, ror: null, kind: "education", start: null, end: null },
      ],
      [
        { name: "Albany Medical College of Union University", source: "identity" },
        { name: "Medical Center", source: "appointment" },
      ],
    );
    expect(pairs).toEqual([
      {
        orcid: { name: "Albany Medical College", kind: "employment", start: 1996, end: 2001 },
        ours: { name: "Albany Medical College of Union University", source: "identity" },
      },
    ]);
  });
});

describe("ReCiter Identity institutions", () => {
  it("the scan keeps list-typed identity.institutions and projects two attributes", () => {
    expect(IDENTITY_INSTITUTIONS_SCAN).toEqual({
      FilterExpression: "attribute_type(#identity.#inst, :l)",
      ProjectionExpression: "uid, #identity.#inst",
      ExpressionAttributeNames: { "#identity": "identity", "#inst": "institutions" },
      ExpressionAttributeValues: { ":l": "L" },
    });
  });

  it("reads strings and {institution|name} objects, trimmed and de-duplicated", () => {
    expect(
      institutionsFromIdentityItem({
        uid: "jd0001",
        identity: {
          institutions: [
            " Albany Medical College ",
            { institution: "University of Rochester" },
            { name: "X" },
            3,
            "Albany Medical College",
          ],
        },
      }),
    ).toEqual(["Albany Medical College", "University of Rochester", "X"]);
    expect(institutionsFromIdentityItem({ uid: "jd0001", identity: null })).toEqual([]);
  });

  it("pages the scan and keeps only the cwids asked for, lowercased", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          { uid: "JD0001", identity: { institutions: ["Albany Medical College"] } },
          { uid: "zz9999", identity: { institutions: ["Elsewhere"] } },
        ],
        LastEvaluatedKey: { uid: "zz9999" },
      })
      .mockResolvedValueOnce({
        Items: [{ uid: "ab0002", identity: { institutions: [] } }],
      });
    const out = await loadIdentityInstitutions(new Set(["jd0001", "AB0002"]), send);
    expect(out).toEqual(new Map([["jd0001", ["Albany Medical College"]]]));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].input).toMatchObject({ ExclusiveStartKey: { uid: "zz9999" } });
  });
});
