/**
 * #1112 — pure helpers in `lib/coi-gap/mention.ts`: the `(pmid, subjectId)`
 * decision-unit key, the relationship-kind humanizer, and the spec §4 highlight
 * spans (mark EXACTLY the matched org(s) + the single subject, nothing else).
 */
import { describe, it, expect } from "vitest";
import {
  subjectId,
  normalizeSubject,
  humanizeRelationshipKind,
  humanizeRelationshipKinds,
  computeHighlightSpans,
} from "@/lib/coi-gap/mention";

describe("subjectId — the (pmid, subjectId) decision-unit key", () => {
  it("self collapses to a single 'self' key regardless of token or index", () => {
    expect(subjectId("self", "Dr Altorki", 0)).toBe("self");
    expect(subjectId("self", "Altorki", 3)).toBe("self");
    expect(subjectId("self", null, 7)).toBe("self");
  });

  it("co-author keys off the normalized token (stable across punctuation/spacing)", () => {
    expect(subjectId("coauthor", "A Saxena", 0)).toBe("coauthor:a saxena");
    expect(subjectId("coauthor", "A. Saxena,", 0)).toBe("coauthor:a saxena");
    expect(subjectId("coauthor", "Dr Altorki", 1)).toBe("coauthor:dr altorki");
    // Same co-author named twice in a paper → same key (one decision unit).
    expect(subjectId("coauthor", "SR", 0)).toBe(subjectId("coauthor", "SR", 5));
  });

  it("a tokenless co-author degrades to the index form (never silently merges)", () => {
    expect(subjectId("coauthor", null, 2)).toBe("coauthor:#2");
    expect(subjectId("coauthor", "", 4)).toBe("coauthor:#4");
  });

  it("unknown uses the per-paper index so two unresolved subjects stay separate and never become 'self'", () => {
    const a = subjectId("unknown", null, 0);
    const b = subjectId("unknown", null, 1);
    expect(a).toBe("unknown:#0");
    expect(b).toBe("unknown:#1");
    expect(a).not.toBe(b);
    expect(a).not.toBe("self");
  });

  it("normalizeSubject folds case, diacritics, and punctuation", () => {
    expect(normalizeSubject("Dr. Müller")).toBe("dr muller");
    expect(normalizeSubject("  A.  Saxena  ")).toBe("a saxena");
    expect(normalizeSubject(null)).toBe("");
  });
});

describe("relationship-kind humanizer", () => {
  it("maps known kinds to their human labels", () => {
    expect(humanizeRelationshipKind("advisory_board")).toBe("advisory");
    expect(humanizeRelationshipKind("steering_committee")).toBe("steering committee");
    expect(humanizeRelationshipKind("grant")).toBe("grants");
    expect(humanizeRelationshipKind("dsmb")).toBe("data safety monitoring");
  });

  it("passes unknown kinds through (underscores → spaces) defensively", () => {
    expect(humanizeRelationshipKind("some_new_kind")).toBe("some new kind");
  });

  it("humanizes + dedupes a list, preserving order", () => {
    expect(humanizeRelationshipKinds(["advisory_board", "consulting", "advisory_board"])).toEqual([
      "advisory",
      "consulting",
    ]);
  });
});

describe("computeHighlightSpans — spec §4 (mark ONLY org(s) + the single subject)", () => {
  it("marks the matched org and the self subject, and NOTHING else (no other names)", () => {
    const text = "Dr Altorki is a consultant for AstraZeneca; Dr Saxena reports grants from Pfizer.";
    // Only this paper's matched org (AstraZeneca) + this row's subject (Dr Altorki).
    const spans = computeHighlightSpans(text, ["AstraZeneca"], "Dr Altorki");
    const marked = spans.map((s) => ({ role: s.role, text: s.text }));
    expect(marked).toContainEqual({ role: "organization", text: "AstraZeneca" });
    expect(marked).toContainEqual({ role: "subject", text: "Dr Altorki" });
    // Pfizer and Dr Saxena are present in the sentence but NOT marked.
    expect(spans.some((s) => /pfizer/i.test(s.text))).toBe(false);
    expect(spans.some((s) => /saxena/i.test(s.text))).toBe(false);
    expect(spans).toHaveLength(2);
  });

  it("marks multiple matched orgs for one subject", () => {
    const text = "Dr Self consults for Roche and Novartis.";
    const spans = computeHighlightSpans(text, ["Roche", "Novartis"], "Dr Self");
    const orgs = spans.filter((s) => s.role === "organization").map((s) => s.text).sort();
    expect(orgs).toEqual(["Novartis", "Roche"]);
    expect(spans.filter((s) => s.role === "subject")).toHaveLength(1);
  });

  it("an unknown subject (null token) marks the org only — no inline subject mark", () => {
    const text = "An author reports a relationship with Gilead.";
    const spans = computeHighlightSpans(text, ["Gilead"], null);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ role: "organization", text: "Gilead" });
  });

  it("returns spans sorted by start with no overlaps (subject nested in an org name is not double-marked)", () => {
    // Contrived: subject token "Bard" sits inside the org "C R Bard".
    const text = "Bard discloses equity in C R Bard.";
    const spans = computeHighlightSpans(text, ["C R Bard"], "Bard");
    // Sorted by start.
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].start);
    // No two spans overlap.
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
  });

  it("is case-insensitive when locating org/subject", () => {
    const text = "dr self consults for astrazeneca.";
    const spans = computeHighlightSpans(text, ["AstraZeneca"], "Dr Self");
    expect(spans.map((s) => s.role).sort()).toEqual(["organization", "subject"]);
  });

  it("never marks a short token inside a larger word (word-boundary guard)", () => {
    // "SR" must not highlight inside "MRISR"; only the standalone initials subject.
    const text = "MRISR scanning aside, SR reports grants from Amgen.";
    const spans = computeHighlightSpans(text, ["Amgen"], "SR");
    const subj = spans.filter((s) => s.role === "subject");
    expect(subj).toHaveLength(1);
    expect(subj[0].start).toBe(text.indexOf("SR reports"));
    expect(text.slice(subj[0].start, subj[0].end)).toBe("SR");
  });
});
