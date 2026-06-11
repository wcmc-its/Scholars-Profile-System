/**
 * Tests for lib/coi-gap/diagnose.ts — the internal diagnostic projection that
 * re-runs the matcher with `includeSuppressed` so the export can study BOTH the
 * surfaced gaps and the suppressed (matched/co-author/non-personal) entities,
 * each with its nearest disclosure, fuzzy score, and token diff.
 *
 * This is internal analyst tooling — the numeric score is intentionally present
 * here (the governance "tier-only / no numbers" rule binds the scholar-facing
 * card, not this developer-only export).
 */
import { describe, expect, it } from "vitest";

import { diagnoseScholar, summarize, type DiagnoseInput } from "@/lib/coi-gap/diagnose";
import { deriveScholar } from "@/lib/coi-gap/pipeline";

const baseInput = (): DiagnoseInput => ({
  cwid: "smith1",
  scholar: deriveScholar("John", "Smith"),
  disclosed: ["Pfizer"],
  statements: [
    // Suppressed: matches the disclosed "Pfizer".
    { pmid: "1", statementText: "Dr. Smith is a consultant for Pfizer Inc." },
    // Surfaced: a genuine, undisclosed scholar-attributed relationship.
    { pmid: "2", statementText: "Dr. Smith is a consultant for Valeant Pharmaceuticals." },
  ],
});

describe("diagnoseScholar", () => {
  it("emits BOTH the surfaced gap and the suppressed (matched) entity", () => {
    const rows = diagnoseScholar(baseInput());

    const pfizer = rows.find((r) => /pfizer/i.test(r.entity));
    expect(pfizer).toBeDefined();
    expect(pfizer!.surfaced).toBe(false);
    expect(pfizer!.tier).toBe("Low");
    expect(pfizer!.nearestDisclosed).toBe("Pfizer");
    expect(pfizer!.nearestScore).toBeGreaterThanOrEqual(0.6);
    expect(pfizer!.pmid).toBe("1");

    const valeant = rows.find((r) => /valeant/i.test(r.entity));
    expect(valeant).toBeDefined();
    expect(valeant!.surfaced).toBe(true);
    expect(["High", "Medium"]).toContain(valeant!.tier);
    expect(valeant!.pmid).toBe("2");
  });

  it("computes the token diff vs the nearest disclosure (reveals strip-list gaps)", () => {
    // "Laboratories" / "Research" are NOT in the corp-suffix strip-list, so a
    // same-root pair scores below threshold and surfaces — the token diff names
    // exactly the offending words.
    const rows = diagnoseScholar({
      cwid: "smith1",
      scholar: deriveScholar("John", "Smith"),
      disclosed: ["Bionik Research"],
      statements: [{ pmid: "9", statementText: "Dr. Smith is a consultant for Bionik Laboratories." }],
    });
    const bionik = rows.find((r) => /bionik/i.test(r.entity));
    expect(bionik).toBeDefined();
    expect(bionik!.nearestDisclosed).toBe("Bionik Research");
    expect(bionik!.entityExtraTokens).toContain("laboratories");
    expect(bionik!.nearestExtraTokens).toContain("research");
    // Shared root drops out of both diffs.
    expect(bionik!.entityExtraTokens).not.toContain("bionik");
  });
});

describe("summarize", () => {
  it("tallies tiers, surfaced count, and suppression reasons", () => {
    const rows = diagnoseScholar(baseInput());
    const s = summarize(rows);
    expect(s.total).toBe(rows.length);
    expect(s.surfaced).toBeGreaterThanOrEqual(1);
    expect(s.byTier.Low).toBeGreaterThanOrEqual(1);
    expect(s.suppressedByReason["matched-disclosed"]).toBeGreaterThanOrEqual(1);
  });
});
