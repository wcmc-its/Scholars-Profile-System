import { describe, expect, it } from "vitest";

import {
  BIOSKETCH_SYSTEM_PROMPT,
  buildBiosketchUserPrompt,
  parseBiosketchEntries,
} from "@/lib/edit/biosketch-generator";
import {
  ENTITY_PROVENANCE_FLOOR,
  VERBATIM_STRINGS,
} from "@/lib/edit/overview-prompt-fragments";
import { overviewVerifySystemPrompt } from "@/lib/edit/overview-generator";
import type { OverviewFacts } from "@/lib/edit/overview-facts";
import { normalizeBiosketchParams } from "@/lib/edit/biosketch-params";

const FACTS: OverviewFacts = {
  name: "Jane Q. Researcher",
  title: "Professor of Medicine",
  department: "Medicine",
  topics: [{ label: "Gene therapy", rationale: "AAV vectors" }],
  representativePublications: [
    {
      pmid: "1",
      title: "AAV biodistribution after CSF delivery",
      venue: "Nature",
      year: 2023,
      impact: 90,
      synopsis: "Vectors distribute 60-90% systemically.",
      impactJustification: "highly cited",
      topicRationale: "central to AAV safety",
      authorPosition: "last",
    },
  ],
  publicationCount: 120,
  yearsActive: { first: 2001, last: 2024 },
  activeGrants: [],
  education: [],
  titles: [],
  methods: [],
  facultyMetrics: null,
  existingBio: null,
} as unknown as OverviewFacts;

describe("BIOSKETCH_SYSTEM_PROMPT — composition", () => {
  it("reuses the shared entity-provenance floor and verbatim-strings fragments verbatim", () => {
    expect(BIOSKETCH_SYSTEM_PROMPT).toContain(ENTITY_PROVENANCE_FLOOR.join("\n"));
    expect(BIOSKETCH_SYSTEM_PROMPT).toContain(VERBATIM_STRINGS.join("\n"));
  });

  it("turns significance ON and bans external uptake (the v5 (b)-relaxation)", () => {
    expect(BIOSKETCH_SYSTEM_PROMPT).toContain("SIGNIFICANCE");
    expect(BIOSKETCH_SYSTEM_PROMPT).toContain("EXTERNAL UPTAKE");
    expect(BIOSKETCH_SYSTEM_PROMPT).toContain("FIRST PERSON");
  });
});

describe("buildBiosketchUserPrompt", () => {
  it("contributions mode states the count ceiling and fences the FACTS as data", () => {
    const params = normalizeBiosketchParams({ mode: "contributions", maxContributions: 4 });
    const turn = buildBiosketchUserPrompt(FACTS, params);
    expect(turn).toContain("Mode: Contributions to Science.");
    expect(turn).toContain("Produce up to 4 contributions");
    expect(turn).toContain("<FACTS>");
    // The withheld fields must never reach the model turn (toModelFacts projection).
    expect(turn).not.toContain("impactJustification");
    expect(turn).not.toContain("facultyMetrics");
  });

  it("personal statement mode carries the required project title + aims", () => {
    const params = normalizeBiosketchParams({
      mode: "personal_statement",
      projectTitle: "CNS gene therapy",
      aims: "Aim 1: dosing.",
    });
    const turn = buildBiosketchUserPrompt(FACTS, params);
    expect(turn).toContain("Mode: Personal Statement.");
    expect(turn).toContain("CNS gene therapy");
    expect(turn).toContain("Aim 1: dosing.");
  });

  it("includes an optional emphasis directive only when set", () => {
    const withEmphasis = buildBiosketchUserPrompt(
      FACTS,
      normalizeBiosketchParams({ mode: "contributions", emphasis: "clinical" }),
    );
    expect(withEmphasis).toContain("Weight toward the bodies of work most relevant to: clinical");
    const without = buildBiosketchUserPrompt(
      FACTS,
      normalizeBiosketchParams({ mode: "contributions" }),
    );
    expect(without).not.toContain("Weight toward the bodies of work");
  });
});

describe("parseBiosketchEntries", () => {
  it("splits numbered contribution blocks into { title:'', body } without extractTitle", () => {
    const text = "1. First body of work.\n\n2. Second body of work.\n\n3. Third.";
    const entries = parseBiosketchEntries(text, "contributions");
    expect(entries).toEqual([
      { title: "", body: "First body of work." },
      { title: "", body: "Second body of work." },
      { title: "", body: "Third." },
    ]);
  });

  it("falls back to blank-line split when the model omitted numbering", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    expect(parseBiosketchEntries(text, "contributions")).toEqual([
      { title: "", body: "First paragraph." },
      { title: "", body: "Second paragraph." },
    ]);
  });

  it("treats a personal statement as one title-less entry, stripping a stray enumerator", () => {
    expect(parseBiosketchEntries("1. My statement.", "personal_statement")).toEqual([
      { title: "", body: "My statement." },
    ]);
    expect(parseBiosketchEntries("My statement.", "personal_statement")).toEqual([
      { title: "", body: "My statement." },
    ]);
  });

  it("drops empty input", () => {
    expect(parseBiosketchEntries("   ", "contributions")).toEqual([]);
  });

  it("extracts the v7 TITLE: heading when extractTitle is on", () => {
    const text =
      "1. TITLE: CAR-T resistance\n\nWe studied resistance.\n\n2. TITLE: AAV tropism\n\nWe mapped tropism.";
    expect(parseBiosketchEntries(text, "contributions", { extractTitle: true })).toEqual([
      { title: "CAR-T resistance", body: "We studied resistance." },
      { title: "AAV tropism", body: "We mapped tropism." },
    ]);
  });

  it("tolerates a v7 contribution that omitted its TITLE line (empty title, full body)", () => {
    const text = "1. TITLE: Real one\n\nBody one.\n\n2. Body two with no title line.";
    expect(parseBiosketchEntries(text, "contributions", { extractTitle: true })).toEqual([
      { title: "Real one", body: "Body one." },
      { title: "", body: "Body two with no title line." },
    ]);
  });

  it("keeps a stray TITLE: line in the body when extractTitle is off (v5/v6)", () => {
    const text = "1. TITLE: Should stay\n\nBody.";
    expect(parseBiosketchEntries(text, "contributions")).toEqual([
      { title: "", body: "TITLE: Should stay\n\nBody." },
    ]);
  });

  it("does not treat a Personal Statement's leading TITLE as a heading", () => {
    expect(
      parseBiosketchEntries("TITLE: Nope\n\nStatement body.", "personal_statement", {
        extractTitle: true,
      }),
    ).toEqual([{ title: "", body: "TITLE: Nope\n\nStatement body." }]);
  });

  it("segments UNNUMBERED v7 output on TITLE: lines (titles survive, one entry per contribution)", () => {
    // The model dropped all numbering but kept the v7 TITLE: format. A blank-line split would tear
    // each contribution in two (and leak the marker); segmenting on TITLE: keeps them whole.
    const text =
      "TITLE: CAR-T resistance\n\nWe studied resistance.\n\nTITLE: AAV tropism\n\nWe mapped tropism.";
    const entries = parseBiosketchEntries(text, "contributions", { extractTitle: true });
    expect(entries).toEqual([
      { title: "CAR-T resistance", body: "We studied resistance." },
      { title: "AAV tropism", body: "We mapped tropism." },
    ]);
    expect(entries.every((e) => !e.body.includes("TITLE:"))).toBe(true);
  });

  it("consumes the TITLE: marker even on a degraded entry — empty heading never leaks", () => {
    expect(
      parseBiosketchEntries("1. TITLE:\n\nBody text here.", "contributions", { extractTitle: true }),
    ).toEqual([{ title: "", body: "Body text here." }]);
  });

  it("drops a degraded title-only entry (heading with no narrative) rather than leak it", () => {
    expect(
      parseBiosketchEntries("1. TITLE: Orphan heading", "contributions", { extractTitle: true }),
    ).toEqual([]);
  });
});

describe("overviewVerifySystemPrompt — biosketch significance opt is additive", () => {
  it("base and synopsis-only verifier prompts are unchanged when permitSignificance is absent", () => {
    const base = overviewVerifySystemPrompt();
    const synopsis = overviewVerifySystemPrompt({ permitSynopsisFindings: true });
    expect(base).not.toContain("unanchored-significance");
    expect(synopsis).not.toContain("unanchored-significance");
  });

  it("permitSignificance appends the significance exception + external-uptake ban", () => {
    const sig = overviewVerifySystemPrompt({ permitSignificance: true });
    expect(sig).toContain("EXCEPTION — significance of a grounded finding");
    expect(sig).toContain("external-uptake");
    expect(sig).toContain("unanchored-significance");
    // The base contract is still present (additive, not a replacement).
    expect(sig).toContain("You are a strict fact-checker");
  });

  it("both relaxations compose for the biosketch (significance + synopsis numbers)", () => {
    const both = overviewVerifySystemPrompt({
      permitSignificance: true,
      permitSynopsisFindings: true,
    });
    expect(both).toContain("EXCEPTION — synopsis findings");
    expect(both).toContain("EXCEPTION — significance of a grounded finding");
  });
});
