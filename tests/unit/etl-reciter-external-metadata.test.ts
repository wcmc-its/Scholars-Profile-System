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

import { composeAuthorStringFromReviewJson } from "@/etl/reciter/index";
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
