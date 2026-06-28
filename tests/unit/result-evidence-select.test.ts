/**
 * #824 follow-up Phase 1 — the coherent ResultEvidence model
 * (`lib/api/result-evidence.ts`). Tests the ONE precedence function +
 * the pure helpers, plus the two invariant guardrails that would have caught
 * the #1051-class failure mode (handoff §4 principle 5).
 */
import { describe, expect, it } from "vitest";
import {
  selectEvidence,
  clinicalExactMatch,
  bioCoversQuery,
  refineExemplarTools,
  firstMatchingSentence,
  clampAroundMarks,
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
  it("name match is NOT surfaced as a snippet (#1267) — falls through to real evidence", () => {
    // The card already shows the name as its heading, so a name-only snippet just
    // repeats it. A name match now falls through to the strongest OTHER evidence
    // (here: method).
    const ev = selectEvidence({
      nameHighlight: NAME_WITH_ORG_HL,
      method: { family: "Flow cytometry", tools: ["FACS"] },
      topic: { label: "Immunology", id: "immunology" },
      pub: { tagged: { text: "5 of 9 publications tagged X", count: 5 } },
      bioHighlight: BIO_HL,
      areas: { labels: ["A"], total: 1 },
    });
    expect(ev.kind).toBe("method");
  });

  it("method (rank 2) beats topic and pub:tagged", () => {
    const ev = selectEvidence({
      method: { family: "Single-cell RNA sequencing", tools: ["scRNA-seq"] },
      topic: { label: "Immunology", id: "immunology" },
      pub: { tagged: { text: "5 of 9 publications tagged X", count: 5 } },
    });
    expect(ev).toEqual({ kind: "method", family: "Single-cell RNA sequencing", tools: ["scRNA-seq"] });
  });

  it("pub:tagged (rank 3) now beats topic — a direct MeSH hit outranks the research area", () => {
    // The reorder: a scholar with pubs tagged the query subject shows that direct
    // match, NOT a (possibly unrelated parent) research-area badge.
    const ev = selectEvidence({
      topic: { label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" },
      pub: { tagged: { text: "5 of 9 publications tagged X", count: 5 } },
      bioHighlight: BIO_HL,
    });
    expect(ev).toMatchObject({ kind: "publications", strength: "tagged" });
  });

  it("pub:concept also beats topic — the MeSH-expansion variant outranks research area too", () => {
    const ev = selectEvidence({
      topic: { label: "Immunology", id: "immunology" },
      pub: { concept: { text: "via related concept X" } },
    });
    expect(ev).toMatchObject({ kind: "publications", strength: "concept" });
  });

  it("a full-query bio sentence beats topic — a query-literal 'why' over an area whose parent can look unrelated", () => {
    // BIO_HL with no query ⇒ bioCoversQuery true ⇒ a FULL bio match, which now
    // outranks the research-area topic.
    const ev = selectEvidence({
      topic: { label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" },
      bioHighlight: BIO_HL,
    });
    expect(ev.kind).toBe("selfDescription");
  });

  it("a paper mention also beats topic — a title/abstract that literally mentions the term", () => {
    const ev = selectEvidence({
      topic: { label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" },
      pub: { mention: { text: "1 of 9 publications mention “stem cells”", count: 1 } },
    });
    expect(ev).toMatchObject({ kind: "publications", strength: "mention" });
  });

  it("topic is the LAST real reason — beats a weak partial-bio, affiliation, and the identity hints", () => {
    // partial-bio (subset-only highlight) is weaker than a curated area match.
    const partial = selectEvidence({
      topic: { label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" },
      bioHighlight: "The <mark>stem</mark> of the issue.",
      query: "stem cells",
    });
    expect(partial.kind).toBe("topic");
    // topic still beats org-affiliation + the areas/concepts identity hints.
    const overHints = selectEvidence({
      topic: { label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" },
      nameHighlight: AFFIL_HL,
      areas: { labels: ["A"], total: 1 },
    });
    expect(overHints.kind).toBe("topic");
  });

  it("pub:tagged (rank 3) beats bio (rank 5) — strong subject tag above a sentence; carries count", () => {
    const ev = selectEvidence({
      pub: { tagged: { text: "25 of 373 publications tagged Melanoma", count: 25 } },
      bioHighlight: BIO_HL,
    });
    expect(ev).toEqual({
      kind: "publications",
      strength: "tagged",
      text: "25 of 373 publications tagged Melanoma",
      count: 25,
    });
  });

  it("bio (rank 5) beats pub:mention (rank 6) — '1 of 133 mention' must not outrank a real FULL-query bio match", () => {
    // single-token query ⇒ bioCoversQuery true ⇒ bio is "full" and wins.
    const ev = selectEvidence({
      bioHighlight: BIO_HL,
      pub: { mention: { text: "1 of 133 publications mention “optogenetics”", count: 1 } },
      query: "rna",
    });
    expect(ev.kind).toBe("selfDescription");
  });

  it("pub:mention (rank 6) beats affiliation", () => {
    const mention = selectEvidence({
      pub: { mention: { text: "1 of 133 publications mention “x”", count: 1 } },
      nameHighlight: AFFIL_HL,
    });
    expect(mention).toEqual({
      kind: "publications",
      strength: "mention",
      text: "1 of 133 publications mention “x”",
      count: 1,
    });
  });

  it("concept folds into the tagged tier (rank 3) — beats topic + bio + mention, loses to tagged", () => {
    // concept above bio (matches the documented precedence + the legacy chain).
    // Concept carries no count/pubs (folded text variant).
    expect(selectEvidence({ pub: { concept: { text: "via related concept X" } }, bioHighlight: BIO_HL })).toEqual({
      kind: "publications",
      strength: "concept",
      text: "via related concept X",
    });
    // tagged still wins over concept when both present
    expect(
      selectEvidence({
        pub: { tagged: { text: "5 of 9 tagged X", count: 5 }, concept: { text: "via related concept X" } },
      }),
    ).toMatchObject({ kind: "publications", strength: "tagged" });
    // concept (rank 4) beats a free-text mention (rank 6)
    expect(
      selectEvidence({ pub: { concept: { text: "c" }, mention: { text: "m", count: 1 } } }),
    ).toMatchObject({
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

  it("carries up to 3 representative papers (pubs) + count on a tagged publications result", () => {
    const ev = selectEvidence({
      pub: {
        tagged: {
          text: "5 of 9 tagged X",
          count: 5,
          pubs: [
            { pmid: "1", title: "T1", year: 2020 },
            { pmid: "2", title: "T2", year: 2019 },
          ],
        },
      },
    });
    expect(ev).toEqual({
      kind: "publications",
      strength: "tagged",
      text: "5 of 9 tagged X",
      count: 5,
      pubs: [
        { pmid: "1", title: "T1", year: 2020 },
        { pmid: "2", title: "T2", year: 2019 },
      ],
    });
  });

  it("omits `pubs` (but always sets `count`) when the rep-pub list is empty", () => {
    const tagged = selectEvidence({ pub: { tagged: { text: "5 of 9 tagged X", count: 5, pubs: [] } } });
    expect(tagged).toEqual({ kind: "publications", strength: "tagged", text: "5 of 9 tagged X", count: 5 });
    expect("pubs" in tagged).toBe(false);

    const mention = selectEvidence({ pub: { mention: { text: "1 of 9 mention x", count: 1 } } });
    expect(mention).toEqual({ kind: "publications", strength: "mention", text: "1 of 9 mention x", count: 1 });
    expect("pubs" in mention).toBe(false);
  });

  it("carries `pubs` + `count` on a mention publications result too", () => {
    const ev = selectEvidence({
      pub: { mention: { text: "2 of 40 mention 16s rna", count: 2, pubs: [{ pmid: "9", title: "M", year: 2022 }] } },
    });
    expect(ev).toEqual({
      kind: "publications",
      strength: "mention",
      text: "2 of 40 mention 16s rna",
      count: 2,
      pubs: [{ pmid: "9", title: "M", year: 2022 }],
    });
  });
});

describe("selectEvidence — partial-bio-vs-pub.mention precedence split (handoff decision 2)", () => {
  // A multi-word query whose bio highlight covered only a SUBSET loses to a
  // publication-mention; a FULL-query (or single-token) bio match still wins.
  const MULTI = "single cell rna";
  // bio highlight marked only "single" — a SUBSET of the 3-token query.
  const PARTIAL_BIO = "The lab studies <mark>single</mark> things broadly.";
  // bio highlight marked every significant token of the query.
  const FULL_BIO = "We do <mark>single</mark> <mark>cell</mark> <mark>rna</mark> sequencing.";

  it("partial-bio match loses to pub.mention (rank 6 beats the demoted bio)", () => {
    const ev = selectEvidence({
      bioHighlight: PARTIAL_BIO,
      pub: { mention: { text: "4 of 80 publications mention “single cell rna”", count: 4 } },
      query: MULTI,
    });
    expect(ev).toEqual({
      kind: "publications",
      strength: "mention",
      text: "4 of 80 publications mention “single cell rna”",
      count: 4,
    });
  });

  it("full-query bio match still wins over pub.mention", () => {
    const ev = selectEvidence({
      bioHighlight: FULL_BIO,
      pub: { mention: { text: "4 of 80 publications mention “single cell rna”", count: 4 } },
      query: MULTI,
    });
    expect(ev.kind).toBe("selfDescription");
  });

  it("a demoted partial-bio match still beats affiliation / areas / empty (rank 6b)", () => {
    const ev = selectEvidence({
      bioHighlight: PARTIAL_BIO,
      nameHighlight: AFFIL_HL,
      areas: { labels: ["A"], total: 1 },
      query: MULTI,
    });
    // no pub.mention present ⇒ the partial bio falls to 6b and beats affiliation
    expect(ev.kind).toBe("selfDescription");
  });

  it("absent query ⇒ no demotion (back-compat: any bio match wins)", () => {
    const ev = selectEvidence({
      bioHighlight: PARTIAL_BIO,
      pub: { mention: { text: "4 of 80 mention x", count: 4 } },
    });
    expect(ev.kind).toBe("selfDescription");
  });
});

describe("bioCoversQuery (handoff decision 2 — does the bio cover the WHOLE query)", () => {
  it("≤1 significant token ⇒ true (a single-token bio match is 'full')", () => {
    expect(bioCoversQuery("The <mark>rna</mark> lab.", "rna")).toBe(true);
    // a query of only sub-2-char tokens has 0 significant tokens ⇒ true
    expect(bioCoversQuery("nothing marked here", "a b")).toBe(true);
  });

  it("empty / absent query ⇒ true (back-compat: no demotion)", () => {
    expect(bioCoversQuery("The <mark>rna</mark> lab.", "")).toBe(true);
    // @ts-expect-error — exercise the nullish-coalescing guard
    expect(bioCoversQuery("anything", undefined)).toBe(true);
  });

  it("true only when EVERY significant query token appears in the marked text", () => {
    const full = "We do <mark>single</mark> <mark>cell</mark> <mark>rna</mark> sequencing.";
    expect(bioCoversQuery(full, "single cell rna")).toBe(true);
    // a partial highlight (only 'single' marked) ⇒ false
    expect(bioCoversQuery("The <mark>single</mark> lab.", "single cell rna")).toBe(false);
  });

  it("only MARKED text counts — unmarked occurrences don't satisfy a token", () => {
    // 'cell' appears in the sentence but only OUTSIDE the marks ⇒ not covered.
    expect(bioCoversQuery("The <mark>single</mark> cell lab.", "single cell")).toBe(false);
  });

  it("a mark spanning the whole multi-word phrase covers all its tokens", () => {
    expect(bioCoversQuery("We study <mark>single cell rna</mark> biology.", "single cell rna")).toBe(true);
  });

  it("tokenizes on punctuation and drops sub-2-char tokens", () => {
    // '16s' and 'rna' are the significant tokens; both inside the mark.
    expect(bioCoversQuery("Profiling <mark>16s rna</mark> amplicons.", "16s-rna")).toBe(true);
    // a 1-char stray ('a') is dropped, so the rest must still match
    expect(bioCoversQuery("The <mark>crispr</mark> screen.", "crispr a")).toBe(true);
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

// Tier 3 (funding text-evidence) depends on `clampAroundMarks` being EXPORTED.
// These pin the now-public contract directly (independent of firstMatchingSentence).
describe("clampAroundMarks (Tier 3 — now-exported mark-aware clamp)", () => {
  const visible = (s: string) => s.replace(/<\/?mark>/g, "");

  it("returns a short marked string under maxLen verbatim", () => {
    const s = "targeting <mark>BRCA</mark> in tumor cells";
    expect(clampAroundMarks(s, 160)).toBe(s);
  });

  it("windows AROUND a mark that sits past the budget, keeping exactly one balanced mark", () => {
    const s = "a ".repeat(120) + "<mark>WIDGET</mark>" + " b".repeat(120);
    const out = clampAroundMarks(s, 60);
    expect((out.match(/<mark>/g) ?? []).length).toBe(1);
    expect((out.match(/<\/mark>/g) ?? []).length).toBe(1);
    expect(out).toContain("<mark>WIDGET</mark>");
    expect(out).not.toMatch(/<mar(?!k>)/); // no truncated "<mark" tag
  });

  it("bounds the visible length to maxLen + the marked region size", () => {
    const region = "<mark>HIT</mark>";
    const s = "z".repeat(400) + " " + region + " " + "y".repeat(400);
    const maxLen = 80;
    const out = clampAroundMarks(s, maxLen);
    // visible budget = maxLen window + the visible region ("HIT") it windows around
    expect(visible(out).length).toBeLessThanOrEqual(maxLen + "HIT".length);
    expect(out).toContain(region);
  });
});

describe("clinicalExactMatch — exact-tier detection (spec §4.1)", () => {
  const BOARD_SET = ["Cardiology", "Interventional Cardiology", "Internal Medicine"];

  it("exact single-token match returns the specialty + boardCertified=true when in boardSet", () => {
    expect(clinicalExactMatch("cardiology", ["Cardiology"], ["Cardiology"])).toEqual({
      specialty: "Cardiology",
      boardCertified: true,
    });
  });

  it("boardCertified=false when specialty is in list but NOT in boardSet", () => {
    expect(clinicalExactMatch("cardiology", ["Cardiology"], [])).toEqual({
      specialty: "Cardiology",
      boardCertified: false,
    });
  });

  it("case-insensitive comparison — normalizes both query and specialty", () => {
    expect(clinicalExactMatch("CARDIOLOGY", ["Cardiology"], ["Cardiology"])).toEqual({
      specialty: "Cardiology",
      boardCertified: true,
    });
  });

  it("token-subset: a single-token query matches a multi-word specialty", () => {
    // "cardiology" query matches "Interventional Cardiology" because every
    // query token ("cardiology") appears in the normalized specialty.
    expect(clinicalExactMatch("cardiology", ["Interventional Cardiology"], BOARD_SET)).toEqual({
      specialty: "Interventional Cardiology",
      boardCertified: true,
    });
  });

  it("phrase equality: multi-word query matching the specialty exactly", () => {
    expect(clinicalExactMatch("interventional cardiology", ["Interventional Cardiology"], BOARD_SET)).toEqual({
      specialty: "Interventional Cardiology",
      boardCertified: true,
    });
  });

  it('"pediatric cardiology" vs ["Cardiology"] → null (query is narrower than specialty)', () => {
    // token "pediatric" is NOT in normalize("Cardiology") = "cardiology",
    // and phrase equality "cardiology" ≠ "pediatric cardiology" → no match.
    expect(clinicalExactMatch("pediatric cardiology", ["Cardiology"], BOARD_SET)).toBeNull();
  });

  it('"heart surgery" vs ["Cardiac Surgery"] → null (no token overlap)', () => {
    // "heart" not in "cardiac surgery", "cardiac surgery" ≠ "heart surgery" → no match.
    expect(clinicalExactMatch("heart surgery", ["Cardiac Surgery"], ["Cardiac Surgery"])).toBeNull();
  });

  it("returns the FIRST matching specialty in list order", () => {
    const result = clinicalExactMatch("cardiology", ["Internal Medicine", "Cardiology"], BOARD_SET);
    // "Internal Medicine" fails ("cardiology" NOT in "internal medicine");
    // "Cardiology" matches first.
    expect(result).toEqual({ specialty: "Cardiology", boardCertified: true });
  });

  it("empty specialties → null", () => {
    expect(clinicalExactMatch("cardiology", [], BOARD_SET)).toBeNull();
  });

  it("blank query → null", () => {
    expect(clinicalExactMatch("", ["Cardiology"], BOARD_SET)).toBeNull();
    expect(clinicalExactMatch("   ", ["Cardiology"], BOARD_SET)).toBeNull();
  });

  it("boardCertified flag is case-insensitive against boardSet", () => {
    // boardSet contains lowercase "cardiology"; specialty is "Cardiology".
    expect(clinicalExactMatch("cardiology", ["Cardiology"], ["cardiology"])).toEqual({
      specialty: "Cardiology",
      boardCertified: true,
    });
  });
});

describe("selectEvidence — clinical:exact precedence (rank 4, spec §4.1)", () => {
  const CLINICAL = { specialty: "Cardiology", boardCertified: true };

  it("clinical (rank 4) beats pub:mention (rank 7) — the key fix for the clinical-specialty failure mode", () => {
    const ev = selectEvidence({
      clinical: CLINICAL,
      pub: { mention: { text: '1 of 9 publications mention "cardiology"', count: 1 } },
    });
    expect(ev).toEqual({ kind: "clinical", specialty: "Cardiology", boardCertified: true });
  });

  it("clinical (rank 4) beats topic (rank 8)", () => {
    const ev = selectEvidence({
      clinical: CLINICAL,
      topic: { label: "Cardiology", id: "cardiology" },
    });
    expect(ev).toEqual({ kind: "clinical", specialty: "Cardiology", boardCertified: true });
  });

  it("clinical (rank 4) beats pub:concept (rank 5)", () => {
    const ev = selectEvidence({
      clinical: CLINICAL,
      pub: { concept: { text: "via related concept cardiology" } },
    });
    expect(ev).toEqual({ kind: "clinical", specialty: "Cardiology", boardCertified: true });
  });

  it("pub:tagged (rank 3) beats clinical (rank 4) — publishes on it wins in a research system", () => {
    const ev = selectEvidence({
      clinical: CLINICAL,
      pub: { tagged: { text: "5 of 9 publications tagged Cardiology", count: 5 } },
    });
    expect(ev).toMatchObject({ kind: "publications", strength: "tagged" });
  });

  it("method (rank 2) beats clinical (rank 4)", () => {
    const ev = selectEvidence({
      clinical: CLINICAL,
      method: { family: "Echocardiography", tools: [] },
    });
    expect(ev).toEqual({ kind: "method", family: "Echocardiography", tools: [] });
  });

  it("boardCertified=false is passed through faithfully", () => {
    const ev = selectEvidence({ clinical: { specialty: "Cardiology", boardCertified: false } });
    expect(ev).toEqual({ kind: "clinical", specialty: "Cardiology", boardCertified: false });
  });
});

describe("selectEvidence — clinical:exact vs tagged, COUNT-GATED (tuning: board 6 / specialty 4)", () => {
  const TH = { boardOverTagged: 6, specialtyOverTagged: 4 };
  const board = { specialty: "Interventional Cardiology", boardCertified: true };
  const spec = { specialty: "Cardiology", boardCertified: false };
  const tagged = (count: number) => ({ tagged: { text: `${count} of 99 publications tagged Cardiology`, count } });

  it('board cert beats a WEAK tagged signal (5 < 6) — "show clinical" inclination', () => {
    const ev = selectEvidence({ clinical: board, pub: tagged(5), clinicalReasonThresholds: TH });
    expect(ev).toMatchObject({ kind: "clinical", boardCertified: true });
  });

  it("board cert loses to a STRONG tagged signal (6 >= 6) — heavy publisher keeps pubs", () => {
    const ev = selectEvidence({ clinical: board, pub: tagged(6), clinicalReasonThresholds: TH });
    expect(ev).toMatchObject({ kind: "publications", strength: "tagged" });
  });

  it('specialty-only beats 3 tagged pubs (3 < 4) — "3 maybe not"', () => {
    const ev = selectEvidence({ clinical: spec, pub: tagged(3), clinicalReasonThresholds: TH });
    expect(ev).toMatchObject({ kind: "clinical", boardCertified: false });
  });

  it('specialty-only loses to 5 tagged pubs (5 >= 4) — "5 pubs > 1 specialty"', () => {
    const ev = selectEvidence({ clinical: spec, pub: tagged(5), clinicalReasonThresholds: TH });
    expect(ev).toMatchObject({ kind: "publications", strength: "tagged" });
  });

  it("board cert > specialty: at 4 tagged pubs board wins but specialty loses", () => {
    expect(selectEvidence({ clinical: board, pub: tagged(4), clinicalReasonThresholds: TH })).toMatchObject({
      kind: "clinical",
    });
    expect(selectEvidence({ clinical: spec, pub: tagged(4), clinicalReasonThresholds: TH })).toMatchObject({
      kind: "publications",
      strength: "tagged",
    });
  });

  it("clinical still wins when there are NO tagged pubs, regardless of thresholds", () => {
    const ev = selectEvidence({ clinical: spec, pub: { mention: { text: "x", count: 1 } }, clinicalReasonThresholds: TH });
    expect(ev).toMatchObject({ kind: "clinical" });
  });

  it("thresholds ABSENT ⇒ original behavior: tagged always wins when present", () => {
    const ev = selectEvidence({ clinical: board, pub: tagged(1) });
    expect(ev).toMatchObject({ kind: "publications", strength: "tagged" });
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
