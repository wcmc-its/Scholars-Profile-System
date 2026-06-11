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

import {
  countAuthorMentions,
  diagnoseScholar,
  summarize,
  type DiagnoseInput,
} from "@/lib/coi-gap/diagnose";
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

describe("countAuthorMentions", () => {
  it("counts distinct named author-subjects in a statement", () => {
    expect(countAuthorMentions("Dr. Smith is a consultant for Pfizer.")).toBe(1);
    expect(
      countAuthorMentions(
        "Scott Kasner has received funding from Bayer. Mitchell Elkind reports royalties from UpToDate.",
      ),
    ).toBe(2);
    // No "<Name> <verb>" subject at all → 0.
    expect(countAuthorMentions("The authors declare no competing interests.")).toBe(0);
  });
});

describe("diagnoseScholar — multi-author leakage signal", () => {
  const multiAuthorStmt =
    "Scott Kasner has received funding from Bayer. Mitchell Elkind has served as a consultant for Acme Therapeutics.";

  it("stamps isMultiAuthor on every row of a statement naming ≥2 authors", () => {
    const rows = diagnoseScholar({
      cwid: "smith1",
      scholar: deriveScholar("John", "Smith"),
      disclosed: [],
      statements: [{ pmid: "m", statementText: multiAuthorStmt }],
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.isMultiAuthor)).toBe(true);
    expect(rows.every((r) => r.authorMentions >= 2)).toBe(true);
  });

  it("a single-author statement is not flagged multi-author", () => {
    const rows = diagnoseScholar({
      cwid: "smith1",
      scholar: deriveScholar("John", "Smith"),
      disclosed: [],
      statements: [{ pmid: "s", statementText: "Dr. Smith is a consultant for Valeant Pharmaceuticals." }],
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !r.isMultiAuthor)).toBe(true);
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

  it("breaks surfaced rows into a precision picture (scholar-attributed core)", () => {
    const rows = diagnoseScholar(baseInput());
    const s = summarize(rows);
    // Valeant is surfaced and attributed to Dr. Smith by surname.
    expect(s.surfacedBreakdown.scholarAttributed).toBeGreaterThanOrEqual(1);
    // The four surfaced buckets are present and non-negative.
    for (const v of Object.values(s.surfacedBreakdown)) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("diagnoseScholar — extraction-junk sizing (junk suppressed; co-author sized)", () => {
  const junkInput = (): DiagnoseInput => ({
    cwid: "smith1",
    scholar: deriveScholar("John", "Smith"),
    disclosed: [],
    statements: [
      // A bare two-word co-author name + a junk word leak alongside a real org,
      // all inside one personal-cue clause so all three are captured.
      {
        pmid: "j",
        statementText: "Dr. Smith consults for Acme Robotics, Wei Zhang, and lists Various.",
      },
    ],
  });

  it("SURFACES a bare two-word co-author name but flags it for sizing (not suppressed)", () => {
    const rows = diagnoseScholar(junkInput());
    const zhang = rows.find((r) => r.entity === "Wei Zhang");
    expect(zhang).toBeDefined();
    expect(zhang!.surfaced).toBe(true); // precision over recall — not dropped
    expect(zhang!.entityIsPersonName).toBe(true); // …but sized
  });

  it("keeps the suppressed junk word as a Low row tagged junk-token", () => {
    const rows = diagnoseScholar(junkInput());
    const various = rows.find((r) => /various/i.test(r.entity));
    expect(various).toBeDefined();
    expect(various!.surfaced).toBe(false);
    expect(various!.entityIsJunk).toBe(true);
    expect(various!.failureModeGuess).toBe("junk-token");
  });

  it("still surfaces the real undisclosed org", () => {
    const rows = diagnoseScholar(junkInput());
    const acme = rows.find((r) => /acme/i.test(r.entity));
    expect(acme).toBeDefined();
    expect(acme!.surfaced).toBe(true);
  });

  it("summarize sizes the junk-word bucket and the surfaced co-author leakage", () => {
    const s = summarize(diagnoseScholar(junkInput()));
    expect(s.suppressedByReason["junk-word"]).toBeGreaterThanOrEqual(1);
    // The fixed false-negative: bare First-Last co-author names are now counted
    // (previously personNameSurfaced read 0 because the detector missed them).
    expect(s.surfacedBreakdown.personNameSurfaced).toBeGreaterThanOrEqual(1);
    // …and person-name is NOT a suppression bucket (the names surface).
    expect(s.suppressedByReason["person-name"]).toBeUndefined();
  });
});
