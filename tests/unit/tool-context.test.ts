/**
 * #1119 — pure helpers for the ReciterAI tool-context artifact: junk filter,
 * snippet clamping, salient-name extraction, index build (+ coverage stats), and
 * the best-of-N snippet selection (scholar-pmid intersection → name-bias →
 * longest, with provenance pmid). Verifiable without an S3 fetch or a DB.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_PUB_COUNT_FOR_SNIPPET,
  MAX_SNIPPET_LEN,
  buildToolContextIndex,
  clampSnippet,
  isUsableSnippet,
  salientNameForms,
  selectBestSnippet,
  startsAtSentenceBoundary,
} from "@/etl/tools/tool-context";

describe("isUsableSnippet — junk filter", () => {
  it("keeps a descriptive snippet of sufficient length", () => {
    expect(isUsableSnippet("a non-invasive automated method of embryo evaluation")).toBe(true);
  });

  it("drops sub-25-char boilerplate", () => {
    expect(isUsableSnippet("MRI was used")).toBe(false);
    expect(isUsableSnippet("Logistic regression.")).toBe(false);
  });

  it("drops bare URLs and 'available at …' repo pointers (the Blackbird case)", () => {
    expect(isUsableSnippet("https://github.com/1dayac/Blackbird is the repo here")).toBe(false);
    expect(isUsableSnippet("available at https://github.com/1dayac/Blackbird")).toBe(false);
    expect(isUsableSnippet("Available online at https://example.org/tool/page")).toBe(false);
  });

  it("drops a short snippet dominated by a code-host link, keeps a long one that mentions it", () => {
    expect(isUsableSnippet("Tool, github.com/x/y")).toBe(false);
    expect(
      isUsableSnippet(
        "We extended the pipeline with a custom aligner whose source lives at github.com/x/y and benchmarked it against three baselines",
      ),
    ).toBe(true); // ≥80 chars → a real description that happens to cite a repo
  });

  it("rejects non-strings", () => {
    expect(isUsableSnippet(null)).toBe(false);
    expect(isUsableSnippet(undefined)).toBe(false);
    expect(isUsableSnippet(42 as unknown)).toBe(false);
  });
});

describe("clampSnippet", () => {
  it("leaves a short snippet unchanged but collapses whitespace", () => {
    expect(clampSnippet("  a   tidy   snippet  ")).toBe("a tidy snippet");
  });

  it("clamps an over-long snippet at a word boundary with an ellipsis", () => {
    const long = `${"alpha beta gamma delta ".repeat(40)}END`;
    const out = clampSnippet(long);
    expect(out.length).toBeLessThanOrEqual(MAX_SNIPPET_LEN + 1); // + the ellipsis char
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("  ");
  });
});

describe("salientNameForms", () => {
  it("returns the lowercased full name", () => {
    expect(salientNameForms("STORK-A")).toEqual(["stork-a"]);
  });

  it("extracts a parenthetical acronym and the parens-stripped form", () => {
    const forms = salientNameForms("Magnetic resonance imaging (MRI) scanner");
    expect(forms).toContain("magnetic resonance imaging (mri) scanner");
    expect(forms).toContain("mri");
    expect(forms).toContain("magnetic resonance imaging scanner");
  });

  it("returns [] for an empty name", () => {
    expect(salientNameForms("   ")).toEqual([]);
  });
});

describe("buildToolContextIndex — coverage stats + junk drop", () => {
  it("indexes survivors per tool and reports coverage", () => {
    const idx = buildToolContextIndex({
      tool_a: {
        "111": "a non-invasive automated method of embryo evaluation predicting ploidy",
        "222": "short", // junk: < 25 chars
      },
      tool_b: {
        "333": "available at https://github.com/x/y", // junk
      },
      tool_c: {
        "444": "assembling full-length isoforms from barcoded RNA-seq linked-read data",
      },
    });
    expect(idx.stats.toolsWithContext).toBe(3);
    expect(idx.stats.toolsWithUsable).toBe(2); // tool_b had only junk
    expect(idx.stats.rawSnippets).toBe(4);
    expect(idx.stats.droppedJunk).toBe(2);
    expect(idx.byTool.has("tool_b")).toBe(false);
    expect(idx.byTool.get("tool_a")).toHaveLength(1);
  });

  it("returns an empty index for a missing/!object tool_context (pre-v3 artifact)", () => {
    const idx = buildToolContextIndex(null);
    expect(idx.byTool.size).toBe(0);
    expect(idx.stats).toEqual({
      toolsWithContext: 0,
      toolsWithUsable: 0,
      rawSnippets: 0,
      droppedJunk: 0,
    });
  });
});

describe("selectBestSnippet — best-of-N", () => {
  const idx = buildToolContextIndex({
    stork: {
      "36543475":
        "develop STORK-A, a non-invasive and automated method of embryo evaluation that uses artificial intelligence to predict embryo ploidy status",
    },
    multi: {
      "1": "STORK was applied in the cohort for evaluation", // names the tool (short-ish)
      // longest OVERALL, but does NOT name the tool — the name-bias pass must skip it
      "2": "an incidental sentence of considerable length describing the surrounding clinical workflow and cohort design in detail that never once mentions the tool itself",
      "3": "STORK, a deep-learning framework for automated time-lapse embryo assessment and ranking", // names the tool, longest NAMED
    },
  });

  it("returns the lone survivor (clamped) with its provenance pmid", () => {
    const best = selectBestSnippet(idx, "stork", { displayName: "STORK-A" });
    expect(best?.pmid).toBe("36543475");
    expect(best?.context).toContain("non-invasive and automated method of embryo evaluation");
  });

  it("biases to snippets naming the tool, then picks the longest among them", () => {
    const best = selectBestSnippet(idx, "multi", { displayName: "STORK" });
    // pmid 2 is longest overall but never names STORK → excluded by the name bias;
    // pmid 3 is the longest of the two that DO name STORK.
    expect(best?.pmid).toBe("3");
    expect(best?.context).toContain("deep-learning framework");
  });

  it("falls back to the longest overall when no survivor names the tool", () => {
    const best = selectBestSnippet(idx, "multi", { displayName: "NoSuchToolName" });
    expect(best?.pmid).toBe("2"); // no survivor names the (bogus) tool → longest overall
  });

  it("intersects with scholar pmids, falling back to all when the intersection is empty", () => {
    const scoped = selectBestSnippet(idx, "multi", {
      displayName: "STORK",
      scholarPmids: new Set(["1"]),
    });
    expect(scoped?.pmid).toBe("1"); // restricted to pmid 1

    const empty = selectBestSnippet(idx, "multi", {
      displayName: "STORK",
      scholarPmids: new Set(["999"]), // no overlap → fall back to all survivors
    });
    expect(empty?.pmid).toBe("3");
  });

  it("returns null for an unknown tool", () => {
    expect(selectBestSnippet(idx, "nope")).toBeNull();
  });

  it("is deterministic: equal-length snippets break ties by lower pmid", () => {
    const tie = buildToolContextIndex({
      t: {
        "20": "exactly the same descriptive length of snippet here AB",
        "10": "exactly the same descriptive length of snippet here CD",
      },
    });
    const best = selectBestSnippet(tie, "t");
    expect(best?.pmid).toBe("10");
  });
});

describe("startsAtSentenceBoundary", () => {
  it("accepts a capitalized / digit / bracket sentence start", () => {
    expect(startsAtSentenceBoundary("FooTool maps reads to a reference")).toBe(true);
    expect(startsAtSentenceBoundary("42 patients were enrolled in the trial")).toBe(true);
    expect(startsAtSentenceBoundary("(MRI) was acquired on every participant")).toBe(true);
  });
  it("rejects a lowercase or continuation-word mid-clause start", () => {
    expect(startsAtSentenceBoundary("using FooTool we aligned the reads")).toBe(false);
    expect(startsAtSentenceBoundary("were compared measuring the AUC across arms")).toBe(false);
    expect(startsAtSentenceBoundary("Which the model then ranked by score")).toBe(false); // capital continuation word
  });
});

describe("selectBestSnippet — #1119 calibration levers", () => {
  const gidx = buildToolContextIndex({
    g: {
      "1": "GeneTool assembles full-length transcripts from linked-read data in a reference-free manner",
    },
  });

  it("opaque gate: suppresses the snippet when pub_count exceeds the cut", () => {
    expect(selectBestSnippet(gidx, "g", { displayName: "GeneTool", toolPubCount: 5 })).toBeNull();
    expect(selectBestSnippet(gidx, "g", { displayName: "GeneTool", toolPubCount: 9 })).toBeNull();
  });

  it("opaque gate: keeps the snippet at or below the cut, and when pub_count is unknown", () => {
    expect(
      selectBestSnippet(gidx, "g", {
        displayName: "GeneTool",
        toolPubCount: MAX_PUB_COUNT_FOR_SNIPPET,
      })?.context,
    ).toContain("assembles");
    expect(selectBestSnippet(gidx, "g", { displayName: "GeneTool" })?.context).toContain(
      "assembles",
    );
    expect(
      selectBestSnippet(gidx, "g", { displayName: "GeneTool", toolPubCount: null })?.context,
    ).toContain("assembles");
  });

  it("subject-not-foil guard: prefers an early-named snippet over a LONGER one that names the tool only late (foil)", () => {
    const idx = buildToolContextIndex({
      f: {
        "1": "FooTool quantifies tumor purity directly from a stained histological slide",
        // longer, but names the tool only at the very end → a foil/contrast mention
        "2": "Results were markedly worse for every alternative pipeline we benchmarked against the older FooTool",
      },
    });
    const best = selectBestSnippet(idx, "f", { displayName: "FooTool" });
    expect(best?.pmid).toBe("1"); // early-named bucket wins despite pmid 2 being longer
  });

  it("subject-not-foil guard: falls back to a late-named snippet when it is the only one (never drops)", () => {
    const idx = buildToolContextIndex({
      f: {
        "1": "Results were markedly worse for the alternative pipelines benchmarked against the older FooTool",
      },
    });
    expect(selectBestSnippet(idx, "f", { displayName: "FooTool" })?.pmid).toBe("1");
  });

  it("clean-start breaks an EXACT length tie (over the lower pmid)", () => {
    const clean = "FooTool maps short reads to the reference genome assembly";
    const frag = "via FooTool we map short reads to a reference genome here";
    expect(clean.length).toBe(frag.length); // self-check: the tiebreak only fires on equal length
    const idx = buildToolContextIndex({ t: { "1": frag, "2": clean } });
    const best = selectBestSnippet(idx, "t", { displayName: "FooTool" });
    expect(best?.pmid).toBe("2"); // clean sentence-start wins even though pmid 1 is lower
  });

  it("length stays PRIMARY: a long descriptive fragment beats a short clean snippet (wins are not dropped)", () => {
    const idx = buildToolContextIndex({
      d: {
        "1": "FooTool is a sequencing assay tool.",
        "2": "using FooTool we generated a detailed and lengthy descriptive characterization of method behavior across many varied clinical samples",
      },
    });
    // pmid 2 begins mid-clause but is far more descriptive → still chosen.
    expect(selectBestSnippet(idx, "d", { displayName: "FooTool" })?.pmid).toBe("2");
  });
});
