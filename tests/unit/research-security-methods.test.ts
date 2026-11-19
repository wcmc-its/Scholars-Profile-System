/**
 * `lib/api/research-security-methods.ts` — the methods and tools inferred from
 * a set of flagged papers: what is counted, what the overlays do, and that
 * nothing is loaded when there is nothing to look in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  METHODS_PEOPLE_CAP,
  loadInferredMethods,
  rollUpMethods,
  type MethodsClient,
} from "@/lib/api/research-security-methods";

const scope = { cwids: ["w1", "w2"], pmids: [1, 2, 3], papers: 4 };
const family = (cwid: string, familyLabel: string, pmids: unknown, supercategory = "imaging") => ({
  cwid,
  supercategory,
  familyLabel,
  definition: null,
  pmids,
});
const tool = (cwid: string, toolName: string, pmids: unknown) => ({ cwid, toolName, category: null, pmids });
const none = { suppressed: new Set<string>(), sensitive: new Set<string>() };

describe("rollUpMethods", () => {
  it("counts distinct papers in the set and distinct people, across scholars", () => {
    const m = rollUpMethods(
      scope,
      [
        // Paper 9 is not in the set; PMIDs may be stored as strings.
        family("w1", "confocal microscopy", [1, "2", 9]),
        family("w2", "confocal microscopy", [2]),
        family("w2", "mass spectrometry", [3]),
        family("w1", "patch clamp", [9]),
      ],
      [tool("w1", "ImageJ", [1]), tool("w2", "imagej", [1, 2]), tool("w1", "STAR", "not a list")],
      none,
    );
    expect(m.families.map((f) => [f.label, f.papers, f.people])).toEqual([
      ["confocal microscopy", 2, 2],
      ["mass spectrometry", 1, 1],
    ]);
    // Tool names are merged ignoring case.
    expect(m.tools.map((t) => [t.name, t.papers, t.people])).toEqual([["ImageJ", 2, 2]]);
    expect(m).toMatchObject({ papers: 4, pubmedPapers: 3, papersCovered: 3, familyCount: 2, toolCount: 1 });
  });

  it("a suppressed family is dropped; a sensitive one is shown and marked", () => {
    const m = rollUpMethods(
      scope,
      [family("w1", "descriptive statistics", [1]), family("w1", "mouse models", [2], "animal_cell_models")],
      [],
      {
        suppressed: new Set(["imaging::descriptive statistics"]),
        sensitive: new Set(["animal_cell_models::mouse models"]),
      },
    );
    expect(m.families.map((f) => [f.label, f.sensitive])).toEqual([["mouse models", true]]);
    // A paper whose only family is suppressed is not counted as covered.
    expect(m.papersCovered).toBe(1);
  });

  it("says when more people are in the set than are read", () => {
    const many = { ...scope, cwids: Array.from({ length: METHODS_PEOPLE_CAP + 1 }, (_, i) => `c${i}`) };
    expect(rollUpMethods(many, [], [], none).peopleCapped).toBe(true);
    expect(rollUpMethods(scope, [], [], none).peopleCapped).toBe(false);
  });
});

describe("loadInferredMethods", () => {
  const table = (rows: unknown[] = []) => ({ findMany: vi.fn().mockResolvedValue(rows) });
  const client = () => {
    const c = {
      scholarFamily: table([family("w1", "confocal microscopy", [1])]),
      scholarTool: table(),
      familySuppressionOverlay: table(),
      familySensitivityOverlay: table(),
    };
    return c as typeof c & MethodsClient;
  };
  afterEach(() => vi.unstubAllEnvs());

  it("loads nothing when the methods data is off or the set is empty", async () => {
    const c = client();
    vi.stubEnv("METHODS_LENS_ENABLED", "off");
    expect(await loadInferredMethods(c, scope)).toBeNull();
    vi.stubEnv("METHODS_LENS_ENABLED", "on");
    expect(await loadInferredMethods(c, { ...scope, pmids: [] })).toBeNull();
    expect(await loadInferredMethods(c, { ...scope, cwids: [] })).toBeNull();
    expect(c.scholarFamily.findMany).not.toHaveBeenCalled();
  });

  it("reads only the scope's people, capped, and rolls them up", async () => {
    vi.stubEnv("METHODS_LENS_ENABLED", "on");
    const c = client();
    const many = { ...scope, cwids: Array.from({ length: METHODS_PEOPLE_CAP + 50 }, (_, i) => `c${i}`) };
    const m = await loadInferredMethods(c, many);
    const asked = c.scholarFamily.findMany.mock.calls.flatMap((call) => call[0].where.cwid.in);
    expect(asked).toHaveLength(METHODS_PEOPLE_CAP);
    expect(m!.families.map((f) => f.label)).toEqual(["confocal microscopy"]);
  });
});
