/**
 * #2018 — arm precedence for the people concentration boost.
 *
 * The boost has two arms and only one of them is keyed on the query. On master the
 * concept arm is gated on the curated arm returning nothing, and an area reaches
 * `taxonomyMatch.areas` via a MeSH anchor or a subtopic->parent collapse even when the
 * query matches no area NAME — so the descriptor-keyed arm never runs on exactly the
 * queries where it is the right signal.
 *
 * These tests pin the ONE thing that matters: which arm is called, and that flag-OFF is
 * master's order (curated first, concept only as the #1343 fallback) with no extra
 * round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getConceptScholarConcentration = vi.fn();
const getAreaScholarConcentration = vi.fn();

vi.mock("@/lib/api/search", () => ({
  getConceptScholarConcentration: (...a: unknown[]) => getConceptScholarConcentration(...a),
}));
vi.mock("@/lib/api/topics", () => ({
  getAreaScholarConcentration: (...a: unknown[]) => getAreaScholarConcentration(...a),
}));

import { resolveAreaConcentration } from "@/lib/api/area-concentration";

const CONCEPT = [{ cwid: "conceptarm", total: 9 }];
const CURATED = [{ cwid: "curatedarm", total: 9 }];

/** A query that resolved BOTH a curated area and a MeSH descriptor — the shape every
 *  reported gene-therapy query actually has, and the only shape where the arms compete. */
function bothArmsAvailable() {
  return {
    state: "matches",
    areas: [{ id: "gene_cell_therapy", entityType: "parentTopic" }],
    meshResolution: { descendantUis: ["D015316", "D005818"] },
  } as never;
}

describe("#2018 concentration-boost arm precedence", () => {
  beforeEach(() => {
    process.env.SEARCH_PEOPLE_AREA_BOOST = "on";
    delete process.env.SEARCH_PEOPLE_CONCEPT_ARM_FIRST;
    getConceptScholarConcentration.mockReset().mockResolvedValue(CONCEPT);
    getAreaScholarConcentration.mockReset().mockResolvedValue(CURATED);
  });
  afterEach(() => {
    delete process.env.SEARCH_PEOPLE_AREA_BOOST;
    delete process.env.SEARCH_PEOPLE_CONCEPT_ARM_FIRST;
  });

  it("flag OFF: curated arm wins and the concept arm never runs (master's order)", async () => {
    const out = await resolveAreaConcentration({
      taxonomyMatch: bothArmsAvailable(),
      meshOff: false,
    });
    expect(out).toEqual(CURATED);
    expect(getAreaScholarConcentration).toHaveBeenCalledTimes(1);
    expect(getConceptScholarConcentration).not.toHaveBeenCalled();
  });

  it("flag ON: the descriptor-keyed arm wins and the curated arm is not consulted", async () => {
    process.env.SEARCH_PEOPLE_CONCEPT_ARM_FIRST = "on";
    const out = await resolveAreaConcentration({
      taxonomyMatch: bothArmsAvailable(),
      meshOff: false,
    });
    expect(out).toEqual(CONCEPT);
    expect(getConceptScholarConcentration).toHaveBeenCalledWith(
      ["D015316", "D005818"],
      expect.any(Number),
    );
    expect(getAreaScholarConcentration).not.toHaveBeenCalled();
  });

  it("flag ON but the concept arm is empty: falls back to curated, no third call", async () => {
    process.env.SEARCH_PEOPLE_CONCEPT_ARM_FIRST = "on";
    getConceptScholarConcentration.mockResolvedValue([]);
    const out = await resolveAreaConcentration({
      taxonomyMatch: bothArmsAvailable(),
      meshOff: false,
    });
    expect(out).toEqual(CURATED);
    // The #1343 tail must NOT re-run the same aggregation that just came back empty.
    expect(getConceptScholarConcentration).toHaveBeenCalledTimes(1);
  });

  it("flag ON with no resolved descriptor: curated arm, unchanged", async () => {
    process.env.SEARCH_PEOPLE_CONCEPT_ARM_FIRST = "on";
    const out = await resolveAreaConcentration({
      taxonomyMatch: {
        state: "matches",
        areas: [{ id: "gene_cell_therapy", entityType: "parentTopic" }],
        meshResolution: null,
      } as never,
      meshOff: false,
    });
    expect(out).toEqual(CURATED);
    expect(getConceptScholarConcentration).not.toHaveBeenCalled();
  });

  it("#1343 fallback still reaches concept queries with no curated area (flag OFF)", async () => {
    const out = await resolveAreaConcentration({
      taxonomyMatch: {
        state: "none",
        areas: [],
        meshResolution: { descendantUis: ["D009765"] },
      } as never,
      meshOff: false,
    });
    expect(out).toEqual(CONCEPT);
    expect(getAreaScholarConcentration).not.toHaveBeenCalled();
  });

  it("meshOff (?match=exact) suppresses both arms", async () => {
    process.env.SEARCH_PEOPLE_CONCEPT_ARM_FIRST = "on";
    const out = await resolveAreaConcentration({
      taxonomyMatch: bothArmsAvailable(),
      meshOff: true,
    });
    expect(out).toBeUndefined();
    expect(getConceptScholarConcentration).not.toHaveBeenCalled();
    expect(getAreaScholarConcentration).not.toHaveBeenCalled();
  });

  // `=== "on"` is case-sensitive on purpose: an absent or misspelled key must be master's
  // order, never a half-on ranking nobody deployed.
  it.each(["off", "On", "ON", "true", "1", ""])(
    "flag value %o does not switch the arms",
    async (v) => {
      process.env.SEARCH_PEOPLE_CONCEPT_ARM_FIRST = v;
      const out = await resolveAreaConcentration({
        taxonomyMatch: bothArmsAvailable(),
        meshOff: false,
      });
      expect(out).toEqual(CURATED);
      expect(getConceptScholarConcentration).not.toHaveBeenCalled();
    },
  );

  it("the parent boost off suppresses both arms even with the sub-lever on", async () => {
    process.env.SEARCH_PEOPLE_AREA_BOOST = "off";
    process.env.SEARCH_PEOPLE_CONCEPT_ARM_FIRST = "on";
    const out = await resolveAreaConcentration({
      taxonomyMatch: bothArmsAvailable(),
      meshOff: false,
    });
    expect(out).toBeUndefined();
    expect(getConceptScholarConcentration).not.toHaveBeenCalled();
    expect(getAreaScholarConcentration).not.toHaveBeenCalled();
  });
});
