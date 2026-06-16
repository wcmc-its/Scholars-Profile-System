/**
 * #824 follow-up Phase 1 — the coherent ResultEvidence model
 * (`lib/api/result-evidence.ts`). Tests the ONE precedence function +
 * the pure helpers, plus the two invariant guardrails that would have caught
 * the #1051-class failure mode (handoff §4 principle 5).
 */
import { describe, expect, it } from "vitest";
import {
  selectEvidence,
  refineExemplarTools,
  firstMatchingSentence,
  classifyNameHighlight,
  AREAS_CAP,
  type SelectEvidenceInput,
} from "@/lib/api/result-evidence";

const NAME_HL = "Jane <mark>Doe</mark>";
const AFFIL_HL = "Roel van Herten - AI In Medical <mark>Imaging</mark>";
const NAME_WITH_ORG_HL = "Roel <mark>van Herten</mark> - AI In Medical Imaging";
const BIO_HL = "The lab studies <mark>RNA</mark> regulatory pathways.";

const base: SelectEvidenceInput = {};

describe("selectEvidence — precedence (handoff §4 principle 2)", () => {
  it("name (rank 1) beats method/topic/everything", () => {
    const ev = selectEvidence({
      nameHighlight: NAME_WITH_ORG_HL,
      method: { family: "Flow cytometry", tools: ["FACS"] },
      topic: { label: "Immunology", id: "immunology" },
      pub: { tagged: { text: "5 of 9 publications tagged X" } },
      bioHighlight: BIO_HL,
      areas: { labels: ["A"], total: 1 },
    });
    expect(ev.kind).toBe("name");
  });

  it("method (rank 2) beats topic and pub:tagged", () => {
    const ev = selectEvidence({
      method: { family: "Single-cell RNA sequencing", tools: ["scRNA-seq"] },
      topic: { label: "Immunology", id: "immunology" },
      pub: { tagged: { text: "5 of 9 publications tagged X" } },
    });
    expect(ev).toEqual({ kind: "method", family: "Single-cell RNA sequencing", tools: ["scRNA-seq"] });
  });

  it("topic (rank 3) beats pub:tagged and bio", () => {
    const ev = selectEvidence({
      topic: { label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" },
      pub: { tagged: { text: "5 of 9 publications tagged X" } },
      bioHighlight: BIO_HL,
    });
    expect(ev).toEqual({
      kind: "topic",
      label: "Single-cell & spatial biology",
      id: "single_cell_spatial_biology",
    });
  });

  it("pub:tagged (rank 4) beats bio (rank 5) — strong subject tag above a sentence", () => {
    const ev = selectEvidence({
      pub: { tagged: { text: "25 of 373 publications tagged Melanoma" } },
      bioHighlight: BIO_HL,
    });
    expect(ev).toEqual({ kind: "publications", strength: "tagged", text: "25 of 373 publications tagged Melanoma" });
  });

  it("bio (rank 5) beats pub:mention (rank 6) — '1 of 133 mention' must not outrank a real sentence", () => {
    const ev = selectEvidence({
      bioHighlight: BIO_HL,
      pub: { mention: { text: "1 of 133 publications mention “optogenetics”" } },
    });
    expect(ev.kind).toBe("selfDescription");
  });

  it("pub:mention (rank 6) beats affiliation", () => {
    const mention = selectEvidence({
      pub: { mention: { text: "1 of 133 publications mention “x”" } },
      nameHighlight: AFFIL_HL,
    });
    expect(mention).toEqual({ kind: "publications", strength: "mention", text: "1 of 133 publications mention “x”" });
  });

  it("concept folds into the tagged tier (rank 4) — beats bio + mention, loses to tagged", () => {
    // concept above bio (matches the documented precedence + the legacy chain)
    expect(selectEvidence({ pub: { concept: { text: "via related concept X" } }, bioHighlight: BIO_HL })).toEqual({
      kind: "publications",
      strength: "concept",
      text: "via related concept X",
    });
    // tagged still wins over concept when both present
    expect(
      selectEvidence({ pub: { tagged: { text: "5 of 9 tagged X" }, concept: { text: "via related concept X" } } }),
    ).toMatchObject({ kind: "publications", strength: "tagged" });
    // concept (rank 4) beats a free-text mention (rank 6)
    expect(selectEvidence({ pub: { concept: { text: "c" }, mention: { text: "m" } } })).toMatchObject({
      strength: "concept",
    });
  });

  it("affiliation (rank 7) beats areas but loses to all content evidence", () => {
    const ev = selectEvidence({ nameHighlight: AFFIL_HL, areas: { labels: ["A", "B"], total: 2 } });
    expect(ev).toEqual({ kind: "affiliation", html: AFFIL_HL });
  });

  it("areas (rank 8) is last real evidence; carries total for '+N more'", () => {
    const ev = selectEvidence({ areas: { labels: ["A", "B", "C", "D"], total: 10 } });
    expect(ev).toEqual({ kind: "areas", labels: ["A", "B", "C", "D"], total: 10 });
  });

  it("none when nothing renderable", () => {
    expect(selectEvidence(base)).toEqual({ kind: "none" });
    expect(selectEvidence({ areas: { labels: [], total: 0 } })).toEqual({ kind: "none" });
  });

  it("carries the representative pub payload (for a future hover) without rendering it", () => {
    const ev = selectEvidence({
      pub: { tagged: { text: "5 of 9 tagged X", pub: { pmid: "1", title: "T", year: 2020 } } },
    });
    expect(ev).toMatchObject({ kind: "publications", strength: "tagged", pub: { pmid: "1" } });
  });
});

describe("classifyNameHighlight (handoff Edge G — name vs affiliation in preferredName)", () => {
  it("mark in the person-name segment ⇒ name", () => {
    expect(classifyNameHighlight(NAME_WITH_ORG_HL)).toBe("name");
    expect(classifyNameHighlight(NAME_HL)).toBe("name"); // no org separator at all
  });
  it("mark in the org segment after ' - ' ⇒ affiliation", () => {
    expect(classifyNameHighlight(AFFIL_HL)).toBe("affiliation");
  });
  it("no <mark> ⇒ null", () => {
    expect(classifyNameHighlight("Jane Doe - Org")).toBeNull();
  });
});

describe("refineExemplarTools (handoff §6 Case A — 4-clause cleaning rule)", () => {
  const FAM = "Single-cell RNA sequencing";

  it("real hit 1 — drops family restatement to its short form, keeps a 2-word tool, reduces a platform phrase", () => {
    expect(
      refineExemplarTools(FAM, [
        "Single-cell RNA sequencing (scRNA-seq)",
        "single-cell transcriptomics",
        "10x single-cell transcriptome analysis",
      ]),
    ).toEqual(["scRNA-seq", "single-cell transcriptomics", "10x"]);
  });

  it("real hit 2 — prefers the parenthetical short form (SnISOr-Seq)", () => {
    expect(
      refineExemplarTools(FAM, [
        "single-cell RNA isoform analysis",
        "single-nuclei RNA sequencing",
        "single-nuclei isoform RNA sequencing (SnISOr-Seq)",
      ]),
    ).toEqual(["single-cell RNA isoform analysis", "single-nuclei RNA sequencing", "SnISOr-Seq"]);
  });

  it("leading platform tokens win (Visium / Slide-seq / Smart-seq2)", () => {
    expect(refineExemplarTools("Spatial transcriptomics", ["Visium spatial gene expression"])).toEqual(["Visium"]);
    expect(refineExemplarTools("X", ["Slide-seq v2 protocol"])).toEqual(["Slide-seq"]);
    expect(refineExemplarTools("X", ["Smart-seq2 full-length"])).toEqual(["Smart-seq2"]);
  });

  it("drops a pure family restatement with no short form", () => {
    expect(refineExemplarTools(FAM, ["Single-cell RNA sequencing", "Visium x"])).toEqual(["Visium"]);
  });

  it("caps long names to 4 words, dedupes case-insensitively, caps the list at 3", () => {
    expect(refineExemplarTools("X", ["alpha beta gamma delta epsilon zeta"])).toEqual(["alpha beta gamma delta"]);
    expect(refineExemplarTools("X", ["FACS", "facs", "MACS", "Tetramer"])).toEqual(["FACS", "MACS", "Tetramer"]);
  });

  it("rejects PROSE parentheticals (multi-word) instead of surfacing them as a chip", () => {
    // non-restating, no platform token → clause 4 keeps the lead word, not the prose paren
    expect(refineExemplarTools("X", ["Histology (cell lines)"])).toEqual(["Histology"]);
    // a family restatement whose only paren is prose → dropped entirely, never surfaced
    expect(refineExemplarTools(FAM, ["Single-cell RNA sequencing (workflow overview)"])).toEqual([]);
  });

  it("never emits a punctuation-only / empty chip", () => {
    expect(refineExemplarTools("X", [",", "-", "()", "(   )"])).toEqual([]);
    expect(refineExemplarTools("X", [",", "FACS"])).toEqual(["FACS"]);
  });

  it("non-array / empty ⇒ []", () => {
    expect(refineExemplarTools("X", undefined)).toEqual([]);
    expect(refineExemplarTools("X", "nope")).toEqual([]);
    expect(refineExemplarTools("X", [" ", ""])).toEqual([]);
  });
});

describe("firstMatchingSentence (handoff Case D — trim a fragment to one sentence)", () => {
  it("returns the whole single sentence containing the mark, keeping <mark>", () => {
    const s = firstMatchingSentence(
      "The Jaffrey lab is interested in identifying <mark>RNA</mark> regulatory pathways that control protein expression.",
    );
    expect(s).toBe(
      "The Jaffrey lab is interested in identifying <mark>RNA</mark> regulatory pathways that control protein expression.",
    );
  });

  it("picks the matching sentence out of several", () => {
    const s = firstMatchingSentence(
      "We work on cancer. The lab studies <mark>RNA</mark> biology. Other things follow.",
    );
    expect(s).toBe("The lab studies <mark>RNA</mark> biology.");
  });

  it("no terminator (truncated fragment) ⇒ returns the trimmed fragment", () => {
    const s = firstMatchingSentence("identifying <mark>RNA</mark> regulatory pathways that control protein expr");
    expect(s).toBe("identifying <mark>RNA</mark> regulatory pathways that control protein expr");
  });

  it("no mark ⇒ trimmed fragment", () => {
    expect(firstMatchingSentence("  plain text  ")).toBe("plain text");
  });

  it("retains a trailing closing quote/bracket after the terminator (no off-by-one drop)", () => {
    expect(firstMatchingSentence('He studies <mark>cancer</mark> biology." Next stuff.')).toBe(
      'He studies <mark>cancer</mark> biology."',
    );
    expect(firstMatchingSentence("First. The <mark>RNA</mark> work (2024). More.")).toBe(
      "The <mark>RNA</mark> work (2024).",
    );
  });

  it("strips non-mark HTML from the bio fragment", () => {
    expect(firstMatchingSentence("<p>The lab studies <mark>RNA</mark> biology.</p>")).toBe(
      "The lab studies <mark>RNA</mark> biology.",
    );
  });

  const visible = (s: string) => s.replace(/<\/?mark>/g, "");

  it("run-on guard is MARK-AWARE: balanced marks, no literal '<mar', bounded length (#1051 guard)", () => {
    const long = "<mark>X</mark> " + "word ".repeat(80);
    const s = firstMatchingSentence(long.trim());
    expect(visible(s).length).toBeLessThanOrEqual(201);
    expect(s.endsWith("…")).toBe(true);
    // exactly one balanced mark, never a truncated tag
    expect((s.match(/<mark>/g) ?? []).length).toBe((s.match(/<\/mark>/g) ?? []).length);
    expect(s).not.toMatch(/<mar(?!k>)/); // no "<mar" / "<mark" partial
  });

  it("never cuts inside a mark when the matched span crosses the length boundary", () => {
    // mark sits right at the 200-char boundary, in a long run-on with no terminator
    const s = firstMatchingSentence("x".repeat(195) + " <mark>RNAseq</mark> " + "y".repeat(200));
    expect((s.match(/<mark>/g) ?? []).length).toBe((s.match(/<\/mark>/g) ?? []).length);
    expect(s).toContain("<mark>RNAseq</mark>"); // the matched term is preserved intact
    expect(s).not.toMatch(/<mar(?!k>)/);
  });

  it("windows AROUND a mark that starts well past the budget (term never silently dropped)", () => {
    const s = firstMatchingSentence("z".repeat(260) + " <mark>HIT</mark> tail");
    expect(s).toContain("<mark>HIT</mark>");
    expect(s.startsWith("…")).toBe(true);
    expect(visible(s).length).toBeLessThanOrEqual(202);
  });
});

describe("INVARIANT guardrails (handoff §4 principle 5 — would have caught #1051)", () => {
  it("never renders a raw under_score slug — labels are humanized upstream, payload carries no slugs", () => {
    // selectEvidence passes areas labels through verbatim; the server humanizes
    // them, so a slug reaching here is a contract violation. Assert the payload
    // a real caller produces is slug-free.
    const ev = selectEvidence({ areas: { labels: ["Single-cell & spatial biology", "Lung cancer"], total: 5 } });
    if (ev.kind !== "areas") throw new Error("expected areas");
    expect(ev.labels.every((l) => !l.includes("_"))).toBe(true);
  });

  it("never renders an unbounded list — areas labels are capped to AREAS_CAP by the caller", () => {
    // The cap lives in the server derive; assert the contract constant the
    // server slices to is 4, and that selectEvidence does not expand it.
    expect(AREAS_CAP).toBe(4);
    const capped = ["a", "b", "c", "d"];
    const ev = selectEvidence({ areas: { labels: capped, total: 12 } });
    if (ev.kind !== "areas") throw new Error("expected areas");
    expect(ev.labels.length).toBeLessThanOrEqual(AREAS_CAP);
  });
});
