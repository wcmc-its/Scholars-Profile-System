/**
 * Unit tests for the pure-function parts of the MeSH curated-topic anchor
 * ETL (spec §1.4):
 *
 *   - parseCuratedCsv  — CSV → CuratedRow[] with header validation and
 *                        RFC-4180 quoted-cell handling.
 *   - filterDerived    — threshold + min-support gates re-applied in JS.
 *   - mergeAnchors     — curated-overrides-derived merge.
 *   - percentiles      — instrumentation log values.
 *
 * The SQL aggregation itself is integration-tested via the smoke run in
 * `npm run etl:mesh-anchors`; unit tests stop at the pure boundaries.
 */
import { describe, it, expect } from "vitest";
import { parseCuratedCsv } from "@/etl/mesh-anchors/csv";
import { filterDerived, mergeAnchors, percentiles } from "@/etl/mesh-anchors/derive";

describe("parseCuratedCsv", () => {
  it("parses a minimal header-only file as empty", () => {
    const rows = parseCuratedCsv("descriptor_ui,parent_topic_id,source_note\n");
    expect(rows).toEqual([]);
  });

  it("parses a single quoted-source-note row", () => {
    const text =
      "descriptor_ui,parent_topic_id,source_note\n" +
      'D057286,biomedical_informatics,"EHR — top access-log query, 2026-Q1"\n';
    const rows = parseCuratedCsv(text);
    expect(rows).toEqual([
      {
        descriptorUi: "D057286",
        parentTopicId: "biomedical_informatics",
        sourceNote: "EHR — top access-log query, 2026-Q1",
      },
    ]);
  });

  it("handles embedded double quotes per RFC 4180 (escape by doubling)", () => {
    const text =
      "descriptor_ui,parent_topic_id,source_note\n" +
      'D1,topic_a,"note with ""quoted"" word"\n';
    const rows = parseCuratedCsv(text);
    expect(rows[0].sourceNote).toBe('note with "quoted" word');
  });

  it("treats an empty source_note as null", () => {
    const text =
      "descriptor_ui,parent_topic_id,source_note\n" + "D1,topic_a,\n";
    const rows = parseCuratedCsv(text);
    expect(rows[0].sourceNote).toBeNull();
  });

  it("throws on header mismatch", () => {
    const text = "wrong_col,parent_topic_id,source_note\nD1,t,note\n";
    expect(() => parseCuratedCsv(text)).toThrow(/header mismatch/);
  });

  it("throws when descriptor_ui or parent_topic_id is empty", () => {
    const text = "descriptor_ui,parent_topic_id,source_note\n,topic_a,note\n";
    expect(() => parseCuratedCsv(text)).toThrow(/required/);
  });

  it("throws on a row with the wrong column count", () => {
    const text = "descriptor_ui,parent_topic_id,source_note\nD1,topic_a\n";
    expect(() => parseCuratedCsv(text)).toThrow(/expected 3 columns/);
  });

  it("ignores a trailing newline (POSIX final newline) but not interior blanks", () => {
    const text =
      "descriptor_ui,parent_topic_id,source_note\nD1,t1,a\nD2,t2,b\n";
    const rows = parseCuratedCsv(text);
    expect(rows).toHaveLength(2);
  });

  it("strips UTF-8 BOM if present", () => {
    const text =
      "﻿descriptor_ui,parent_topic_id,source_note\nD1,t1,note\n";
    const rows = parseCuratedCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptorUi).toBe("D1");
  });
});

describe("filterDerived", () => {
  const sample = [
    { descriptor_ui: "D1", parent_topic_id: "t1", ratio: 0.5, n_both: 5, n_desc: 10 },
    { descriptor_ui: "D2", parent_topic_id: "t1", ratio: 0.2, n_both: 2, n_desc: 10 },
    { descriptor_ui: "D3", parent_topic_id: "t2", ratio: 0.8, n_both: 4, n_desc: 5 },
    { descriptor_ui: "D4", parent_topic_id: "t2", ratio: 0.9, n_both: 3, n_desc: 3 }, // below min-support
  ];

  it("drops rows below the ratio threshold", () => {
    const out = filterDerived(sample, { threshold: 0.3, minSupport: 1 });
    expect(out.map((r) => r.descriptor_ui)).toEqual(["D1", "D3", "D4"]);
  });

  it("drops rows below the min-support floor", () => {
    const out = filterDerived(sample, { threshold: 0.0, minSupport: 5 });
    expect(out.map((r) => r.descriptor_ui)).toEqual(["D1", "D2", "D3"]);
  });

  it("applies both gates together (AND)", () => {
    const out = filterDerived(sample, { threshold: 0.3, minSupport: 5 });
    expect(out.map((r) => r.descriptor_ui)).toEqual(["D1", "D3"]);
  });
});

describe("mergeAnchors", () => {
  it("emits curated rows first, then non-conflicting derived rows", () => {
    const curated = [
      { descriptorUi: "D1", parentTopicId: "t1", sourceNote: "manual" },
    ];
    const derived = [
      { descriptor_ui: "D1", parent_topic_id: "t1", ratio: 0.9, n_both: 9, n_desc: 10 },
      { descriptor_ui: "D2", parent_topic_id: "t2", ratio: 0.5, n_both: 5, n_desc: 10 },
    ];
    const out = mergeAnchors(curated, derived);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      descriptorUi: "D1",
      parentTopicId: "t1",
      confidence: "curated",
      sourceNote: "manual",
    });
    expect(out[1]).toMatchObject({
      descriptorUi: "D2",
      parentTopicId: "t2",
      confidence: "derived",
    });
  });

  it("curated wins on (descriptor_ui, parent_topic_id) conflict", () => {
    const curated = [
      { descriptorUi: "D1", parentTopicId: "t1", sourceNote: "curator says yes" },
    ];
    const derived = [
      { descriptor_ui: "D1", parent_topic_id: "t1", ratio: 0.9, n_both: 9, n_desc: 10 },
    ];
    const out = mergeAnchors(curated, derived);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe("curated");
    expect(out[0].sourceNote).toBe("curator says yes");
  });

  it("derived source_note carries the ratio and support counts", () => {
    const out = mergeAnchors([], [
      { descriptor_ui: "D1", parent_topic_id: "t1", ratio: 0.873, n_both: 7, n_desc: 8 },
    ]);
    expect(out[0].sourceNote).toBe("auto: ratio=0.873 n=7/8");
  });

  it("tolerates duplicate curated rows by keeping the first occurrence", () => {
    const curated = [
      { descriptorUi: "D1", parentTopicId: "t1", sourceNote: "first" },
      { descriptorUi: "D1", parentTopicId: "t1", sourceNote: "second" },
    ];
    const out = mergeAnchors(curated, []);
    expect(out).toHaveLength(1);
    expect(out[0].sourceNote).toBe("first");
  });
});

describe("percentiles", () => {
  it("returns nulls on empty input", () => {
    expect(percentiles([])).toEqual({ p50: null, p90: null, p99: null });
  });

  it("nearest-rank: p50 of [1..10] is 5, p90 is 9, p99 is 10", () => {
    const out = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(out).toEqual({ p50: 5, p90: 9, p99: 10 });
  });

  it("is order-independent (sorts internally)", () => {
    const out = percentiles([10, 1, 5, 2, 9]);
    expect(out.p50).toBe(5);
  });
});
