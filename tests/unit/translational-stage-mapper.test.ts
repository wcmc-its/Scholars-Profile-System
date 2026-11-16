/**
 * Block 4 IMPACT# -> publication, translational-stage half
 * (etl/dynamodb/translational-stage-mapper.ts). Covers:
 *   - an item with a stage but NO impact_score still yields a stage write
 *   - an item without a stage (or with an unrecognized one) yields no write,
 *     so nothing can be nulled over a stored stage
 *   - confidence is optional; a row with an unknown stage or confidence value
 *     is skipped and counted
 *   - "NA" is stored raw
 *   - pmid from the attribute or the PK; unknown publications are counted
 *   - grouping by (stage, confidence) for the batched updateMany
 */
import { describe, expect, it } from "vitest";
import {
  buildTranslationalStageWrites,
  groupTranslationalStageWrites,
  impactRecordPmid,
  type ImpactStageInput,
} from "@/etl/dynamodb/translational-stage-mapper";

const KNOWN = new Set(["1001", "1002", "1003", "1004"]);

describe("impactRecordPmid", () => {
  it("prefers a usable pmid attribute, then the PK suffix", () => {
    expect(impactRecordPmid({ PK: "IMPACT#pmid_1001", pmid: 2002 })).toBe("2002");
    expect(impactRecordPmid({ PK: "IMPACT#pmid_1001", pmid: " 2002 " })).toBe("2002");
    expect(impactRecordPmid({ PK: "IMPACT#pmid_1001", pmid: "n/a" })).toBe("1001");
    expect(impactRecordPmid({ PK: "IMPACT#pmid_1001" })).toBe("1001");
    expect(impactRecordPmid({ PK: "OTHER#x" })).toBe("");
  });
});

describe("buildTranslationalStageWrites", () => {
  it("writes the stage for an item that has no impact_score", () => {
    const item = {
      PK: "IMPACT#pmid_1001",
      SK: "SCORE",
      synopsis: "A synopsis.",
      translational_stage: "T1",
      translational_stage_confidence: "high",
    } as ImpactStageInput;
    expect(buildTranslationalStageWrites([item], KNOWN)).toEqual({
      writes: [{ pmid: "1001", translationalStage: "T1", translationalStageConfidence: "high" }],
      skippedMissingPublication: 0,
      skippedUnrecognized: 0,
    });
  });

  it("yields no write for an item without a stage", () => {
    const items: ImpactStageInput[] = [
      { PK: "IMPACT#pmid_1001" },
      { PK: "IMPACT#pmid_1002", translational_stage_confidence: "high" },
      { PK: "IMPACT#pmid_1003", translational_stage: null },
      { PK: "IMPACT#pmid_1004", translational_stage: "" },
    ];
    expect(buildTranslationalStageWrites(items, KNOWN)).toEqual({
      writes: [],
      skippedMissingPublication: 0,
      skippedUnrecognized: 0,
    });
  });

  it("yields no write for an unrecognized stage value", () => {
    const items: ImpactStageInput[] = [
      { PK: "IMPACT#pmid_1001", translational_stage: "T5", translational_stage_confidence: "high" },
      { PK: "IMPACT#pmid_1002", translational_stage: 2 },
    ];
    const plan = buildTranslationalStageWrites(items, KNOWN);
    expect(plan.writes).toEqual([]);
    // Counted, so a changed spelling upstream is visible in the ETL log.
    expect(plan.skippedUnrecognized).toBe(2);
  });

  it("stores a missing confidence as null, and NA raw", () => {
    const items: ImpactStageInput[] = [
      { PK: "IMPACT#pmid_1001", translational_stage: "T2" },
      { PK: "IMPACT#pmid_1003", translational_stage: "NA", translational_stage_confidence: "low" },
    ];
    expect(buildTranslationalStageWrites(items, KNOWN).writes).toEqual([
      { pmid: "1001", translationalStage: "T2", translationalStageConfidence: null },
      { pmid: "1003", translationalStage: "NA", translationalStageConfidence: "low" },
    ]);
  });

  it("skips and counts a row whose confidence is present but not a known value", () => {
    // Writing NULL here would make a stored (stage, low) pair displayable.
    const items: ImpactStageInput[] = [
      { PK: "IMPACT#pmid_1002", translational_stage: "T0", translational_stage_confidence: "certain" },
    ];
    expect(buildTranslationalStageWrites(items, KNOWN)).toEqual({
      writes: [],
      skippedMissingPublication: 0,
      skippedUnrecognized: 1,
    });
  });

  it("counts staged items whose publication we do not have, and skips them", () => {
    const items: ImpactStageInput[] = [
      { PK: "IMPACT#pmid_9999", translational_stage: "T1" },
      { PK: "IMPACT#pmid_1001", translational_stage: "T1" },
      // No stage: not counted as a missing publication either.
      { PK: "IMPACT#pmid_8888" },
    ];
    const plan = buildTranslationalStageWrites(items, KNOWN);
    expect(plan.writes.map((w) => w.pmid)).toEqual(["1001"]);
    expect(plan.skippedMissingPublication).toBe(1);
  });

  it("keeps one write per pmid", () => {
    const items: ImpactStageInput[] = [
      { PK: "IMPACT#pmid_1001", translational_stage: "T1" },
      { PK: "IMPACT#pmid_1001", translational_stage: "T2", translational_stage_confidence: "medium" },
    ];
    expect(buildTranslationalStageWrites(items, KNOWN).writes).toEqual([
      { pmid: "1001", translationalStage: "T2", translationalStageConfidence: "medium" },
    ]);
  });

  it("empty input yields an empty plan", () => {
    expect(buildTranslationalStageWrites([], KNOWN)).toEqual({
      writes: [],
      skippedMissingPublication: 0,
      skippedUnrecognized: 0,
    });
  });
});

describe("groupTranslationalStageWrites", () => {
  it("groups pmids by (stage, confidence), keeping null confidence apart", () => {
    const groups = groupTranslationalStageWrites([
      { pmid: "1001", translationalStage: "T1", translationalStageConfidence: "high" },
      { pmid: "1002", translationalStage: "T1", translationalStageConfidence: null },
      { pmid: "1003", translationalStage: "T1", translationalStageConfidence: "high" },
      { pmid: "1004", translationalStage: "NA", translationalStageConfidence: "high" },
    ]);
    expect(groups).toEqual([
      { translationalStage: "T1", translationalStageConfidence: "high", pmids: ["1001", "1003"] },
      { translationalStage: "T1", translationalStageConfidence: null, pmids: ["1002"] },
      { translationalStage: "NA", translationalStageConfidence: "high", pmids: ["1004"] },
    ]);
  });
});
