/**
 * #1119 / ReciterAI#238 — the tools-ETL short-circuit signature. Regression
 * guard: a tool_context.json-only republish (sentence-aligned fix) under a
 * BYTE-IDENTICAL tools.json must change the signature, so the corrected snippets
 * are re-imported instead of being masked by an unchanged primary-artifact sha.
 */
import { describe, expect, it } from "vitest";

import { manifestContentSignature } from "@/etl/tools/manifest-signature";

const TOOLS_SHA = "aeb0a8f1a5a48ec502de341a817d4a6fe07699fbf40e8bb66d6382dff798fc55";

/** A manifest whose top-level sha256 is the tools.json sha (the real A2 shape). */
function manifest(objectShas: {
  tools: string;
  families: string;
  faculty: string;
  toolContext: string;
}) {
  return {
    sha256: objectShas.tools, // top-level = primary tools.json sha
    objects: {
      "tools.json": { sha256: objectShas.tools },
      "families.json": { sha256: objectShas.families },
      "faculty.json": { sha256: objectShas.faculty },
      "tool_context.json": { sha256: objectShas.toolContext },
    },
  };
}

const BASE = manifest({
  tools: TOOLS_SHA,
  families: "b84bcc5d1bd0",
  faculty: "71219e2fe1d3",
  toolContext: "OLD_broken_fragments_sha",
});

describe("manifestContentSignature", () => {
  it("is stable for an identical manifest", () => {
    expect(manifestContentSignature(BASE)).toBe(manifestContentSignature(BASE));
  });

  it("CHANGES when ONLY tool_context.json changes (the ReciterAI#238 bug)", () => {
    const fixed = manifest({
      tools: TOOLS_SHA, // tools.json byte-identical
      families: "b84bcc5d1bd0",
      faculty: "71219e2fe1d3",
      toolContext: "a6a59bacceda_sentence_aligned",
    });
    expect(manifestContentSignature(fixed)).not.toBe(manifestContentSignature(BASE));
  });

  it("does NOT equal the bare top-level sha (the old, too-coarse basis)", () => {
    // The old short-circuit compared lastRun.manifestSha256 === manifest.sha256.
    // The composite signature must differ from that bare value, or the broadening
    // is a no-op.
    expect(manifestContentSignature(BASE)).not.toBe(BASE.sha256);
  });

  it("changes when families.json or faculty.json changes", () => {
    const famChanged = manifestContentSignature(
      manifest({
        tools: TOOLS_SHA,
        families: "DIFFERENT",
        faculty: "71219e2fe1d3",
        toolContext: "OLD_broken_fragments_sha",
      }),
    );
    const facChanged = manifestContentSignature(
      manifest({
        tools: TOOLS_SHA,
        families: "b84bcc5d1bd0",
        faculty: "DIFFERENT",
        toolContext: "OLD_broken_fragments_sha",
      }),
    );
    expect(famChanged).not.toBe(manifestContentSignature(BASE));
    expect(facChanged).not.toBe(manifestContentSignature(BASE));
  });

  it("is insensitive to object key insertion order (sorted basis)", () => {
    const reordered = {
      sha256: TOOLS_SHA,
      objects: {
        "tool_context.json": { sha256: "OLD_broken_fragments_sha" },
        "faculty.json": { sha256: "71219e2fe1d3" },
        "tools.json": { sha256: TOOLS_SHA },
        "families.json": { sha256: "b84bcc5d1bd0" },
      },
    };
    expect(manifestContentSignature(reordered)).toBe(manifestContentSignature(BASE));
  });

  it("changes when an object is added or removed", () => {
    const withExtra = {
      sha256: TOOLS_SHA,
      objects: { ...BASE.objects, "extra.json": { sha256: "new" } },
    };
    expect(manifestContentSignature(withExtra)).not.toBe(manifestContentSignature(BASE));
  });

  it("falls back to the top-level sha when no objects map is present", () => {
    expect(manifestContentSignature({ sha256: TOOLS_SHA })).toBe(TOOLS_SHA);
    expect(manifestContentSignature({ sha256: TOOLS_SHA, objects: {} })).toBe(TOOLS_SHA);
    expect(manifestContentSignature({})).toBe("");
  });
});
