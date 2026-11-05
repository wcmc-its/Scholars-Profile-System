/**
 * External (non-PubMed) publication metadata at ReciterDB ingest.
 *
 *   #2580 — external rows carry the literal four-character string 'NULL' in
 *           volume / issue / pages rather than a SQL NULL (40/40 sampled), so
 *           the ETL nulls them with the citation builders' own `isAbsentValue`
 *           predicate. The guard-rail cases below are REAL values in the live
 *           corpus ("Suppl", "Spec No", "IX", "DECIPHeR", ...): a looser sweep
 *           would silently delete them.
 *   #2581 — external rows have no byline in either analysis_summary_author*
 *           table, so the ETL composes one from
 *           `reciterdb.authorship_review.authors_json`. That value is upstream
 *           JSON we do not control, and a byline is cosmetic: a malformed value
 *           must yield null, never throw and fail the nightly upsert.
 *
 * The ETL's `main()` is guarded by `!process.env.VITEST`, so importing the
 * module here runs no ReciterDB sync.
 */
import { describe, expect, it } from "vitest";

import {
  composeAuthorStringFromReviewJson,
  REVIEW_BYLINE_SOURCES,
  reviewBareIdsForSource,
} from "@/etl/reciter/index";
import { isAbsentValue } from "@/lib/citation";

describe("composeAuthorStringFromReviewJson (#2581)", () => {
  it("composes the PubMed-style byline from a normal authors_json array", () => {
    const json = JSON.stringify([
      { given: "Ada B", surname: "Lovelace" },
      { given: "Charles", surname: "Babbage" },
      { given: "Jean-Marc", surname: "Fontaine" },
    ]);
    expect(composeAuthorStringFromReviewJson(json)).toBe(
      "Lovelace AB, Babbage C, Fontaine JM",
    );
  });

  it("returns null for a malformed, non-array, empty or missing value (never throws)", () => {
    expect(composeAuthorStringFromReviewJson("{not json")).toBeNull();
    expect(composeAuthorStringFromReviewJson('{"given":"Ada","surname":"Lovelace"}')).toBeNull();
    expect(composeAuthorStringFromReviewJson("[]")).toBeNull();
    expect(composeAuthorStringFromReviewJson("")).toBeNull();
    expect(composeAuthorStringFromReviewJson(null)).toBeNull();
  });

  it("skips an element with no surname and still composes the rest", () => {
    const json = JSON.stringify([
      { given: "Ada", surname: "Lovelace" },
      { given: "Charles" },
      { given: "Grace", surname: "   " },
      { given: "Alan", surname: "Turing" },
    ]);
    expect(composeAuthorStringFromReviewJson(json)).toBe("Lovelace A, Turing A");
  });

  it("keeps a surname whose element has no given name", () => {
    expect(composeAuthorStringFromReviewJson(JSON.stringify([{ surname: "Lovelace" }]))).toBe(
      "Lovelace",
    );
  });

  // The mariadb driver hands back a JSON column already decoded, and a TEXT
  // column as the raw string. Which one `authors_json` is was never probed, so
  // both must work — a string-only implementation would return null for every
  // row and the feature would look like missing upstream data, not a bug.
  it("accepts an already-decoded array, not just a JSON string", () => {
    const arr = [
      { given: "Ada B", surname: "Lovelace" },
      { given: "Charles", surname: "Babbage" },
    ];
    expect(composeAuthorStringFromReviewJson(arr)).toBe("Lovelace AB, Babbage C");
    expect(composeAuthorStringFromReviewJson(JSON.stringify(arr))).toBe(
      composeAuthorStringFromReviewJson(arr),
    );
  });

  it("returns null for a decoded value that is not an array", () => {
    expect(composeAuthorStringFromReviewJson({ surname: "Lovelace" })).toBeNull();
    expect(composeAuthorStringFromReviewJson(42)).toBeNull();
  });
});

describe("reviewBareIdsForSource (#2581)", () => {
  const articleIdByPmid = new Map<number, string>([
    [900001, "SCOPUS:105037533819"],
    [900002, "OPENALEX:W4401234567"],
    [900003, "WOS:000123456700001"],
    [900004, "CROSSREF:10.1016/j.surg.2026.110815"],
  ]);

  it("strips only its own prefix, so a bare id is looked up under one source", () => {
    expect(reviewBareIdsForSource(articleIdByPmid, "SCOPUS:")).toEqual(
      new Map([["105037533819", 900001]]),
    );
    expect(reviewBareIdsForSource(articleIdByPmid, "OPENALEX:")).toEqual(
      new Map([["W4401234567", 900002]]),
    );
    expect(reviewBareIdsForSource(articleIdByPmid, "CROSSREF:")).toEqual(
      new Map([["10.1016/j.surg.2026.110815", 900004]]),
    );
  });

  it("pins each prefix to its authorship_review source", () => {
    expect(REVIEW_BYLINE_SOURCES).toEqual([
      { prefix: "SCOPUS:", source: "scopus" },
      { prefix: "OPENALEX:", source: "openalex" },
      { prefix: "CROSSREF:", source: "crossref" },
    ]);
  });

  it("composes the openalex lane's authors_json (nullable given/surname)", () => {
    // aar_universe_openalex._authors_json: {given, surname} split from the raw
    // byline string; a name that can't be split yields nulls.
    const json = JSON.stringify([
      { given: "Gerald J.", surname: "Waliany" },
      { given: null, surname: "Consortium" },
      { given: null, surname: null },
    ]);
    expect(composeAuthorStringFromReviewJson(json)).toBe("Waliany GJ, Consortium");
  });
});

describe("isAbsentValue (#2580)", () => {
  it("treats every literal-null spelling and whitespace-only value as absent", () => {
    for (const v of ["NULL", "null", "nUlL", " NULL ", "", "   ", "\t", null, undefined]) {
      expect(isAbsentValue(v)).toBe(true);
    }
  });

  it("leaves real volume/issue/pages values in the live corpus alone", () => {
    for (const v of [
      "Suppl",
      "Spec No",
      "Suppl Web Exclusives",
      "IX",
      "PP",
      "IV",
      "XXIX",
      "DECIPHeR",
      "83",
      "500-510",
      "0",
    ]) {
      expect(isAbsentValue(v)).toBe(false);
    }
  });
});
