/**
 * The core review queue's band and chip restyle (Core publication queue mockup
 * refresh, PR 3): band-coloured row spines and pills on master's FOUR bands,
 * LLM chip tints on `llmVerdict`'s own cut-offs, and the rail's band dot. The
 * pure helpers first, then the list and rail as rendered.
 *
 * Every fixture value here is synthetic: made-up titles, CWIDs and PMIDs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  bandDot,
  CoreClaimQueue,
  evidenceGroupColor,
  likelihoodBand,
  llmChipTone,
  llmTier,
  llmMeterSegments,
  llmVerdict,
  rowChips,
  rowMetaParts,
  rowSpine,
} from "@/components/edit/core-claim-queue";
import type { CoreQueueRow } from "@/lib/api/core-queue";

function row(over: Partial<CoreQueueRow> = {}): CoreQueueRow {
  return {
    pmid: "90000001",
    title: "Synthetic paper",
    journal: "Synthetic Journal",
    journalAbbrev: "Synth J",
    year: 2021,
    dateAddedToEntrez: "2026-02-18",
    authorsString: "Testerson A",
    fullAuthorsString: "Testerson A",
    abstract: null,
    synopsis: null,
    likelihood: 0.82,
    status: "candidate",
    coauthors: [],
    coauthorScholars: [],
    wcmAuthors: [],
    signalAck: false,
    ackAlias: null,
    ackSnippet: null,
    llmScore: 7,
    llmRationale: null,
    authorAffinity: null,
    topicalPrior: null,
    methodTier: null,
    methodEvidence: [],
    citationCount: 0,
    pubmedUrl: null,
    doi: null,
    claimed: false,
    isManual: false,
    relativeCitationRatio: null,
    nihPercentile: null,
    meshTerms: [],
    ...over,
  };
}

const CORE = { id: "2", name: "Synthetic Core", staffCount: null, staffTrackedCount: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("band styling", () => {
  it("keeps the four bands and gives each its own spine, none of them the focus slate", () => {
    const bands = [0.9, 0.7, 0.5, 0.1].map(likelihoodBand);
    expect(bands.map((b) => b.label)).toEqual(["Strong", "Moderate", "Slight", "Weak"]);
    const spines = bands.map((b) => b.spine);
    expect(new Set(spines).size).toBe(4);
    for (const s of spines) expect(s).not.toContain("slate");
    for (const b of bands) expect(b.tint).toMatch(/\bbg-\S+ border-\S+ text-\S+/);
  });

  it("rowSpine: band colour off Strong only, none for Strong or a PMID add", () => {
    expect(rowSpine(0.9, false)).toBe("border-l-transparent");
    expect(rowSpine(0.85, false)).toBe("border-l-transparent");
    expect(rowSpine(0.84, false)).toBe(likelihoodBand(0.84).spine);
    expect(rowSpine(0.5, false)).toBe(likelihoodBand(0.5).spine);
    expect(rowSpine(0.1, false)).toBe(likelihoodBand(0.1).spine);
    expect(rowSpine(0.5, true)).toBe("border-l-transparent");
  });

  it("rowMetaParts: short journal title first, then year and PMID", () => {
    expect(
      rowMetaParts({ journal: "Synth Journal", journalAbbrev: "Synth J", year: 2020, pmid: "9" }),
    ).toEqual({ journal: "Synth J", rest: "2020 · PMID 9" });
    expect(
      rowMetaParts({ journal: "Synth Journal", journalAbbrev: null, year: null, pmid: "9" }),
    ).toEqual({ journal: "Synth Journal", rest: "PMID 9" });
    expect(rowMetaParts({ journal: null, journalAbbrev: "", year: 2021, pmid: "9" })).toEqual({
      journal: null,
      rest: "2021 · PMID 9",
    });
  });

  it("bandDot takes the LOWEST band in the pile, neutral when empty", () => {
    expect(bandDot([0.95, 0.5])).toBe(likelihoodBand(0.5).fill);
    expect(bandDot([0.95])).toBe(likelihoodBand(0.95).fill);
    expect(bandDot([])).toBe("bg-apollo-border-strong");
  });
});

describe("LLM chip tone", () => {
  it("shares llmVerdict's cut-offs: slate at 8+, amber at 6-7, neutral below", () => {
    for (const score of [1, 5, 6, 7, 8, 10]) {
      const tier = llmTier(score);
      const tone = llmChipTone(score);
      expect(tone).toBe(tier === "core" ? "signal" : tier === "possible" ? "amber" : "quiet");
    }
    expect(llmChipTone(8)).toBe("signal");
    expect(llmChipTone(7.9)).toBe("amber");
    expect(llmChipTone(6)).toBe("amber");
    expect(llmChipTone(5.9)).toBe("quiet");
    // the mockup's 7 / 4 cut-offs are NOT adopted
    expect(llmChipTone(7)).toBe("amber");
    expect(llmChipTone(4)).toBe("quiet");
    expect(llmVerdict(8)).toBe("reads as core work");
  });

  it("llmMeterSegments: 10 segments, `score` filled in the llmTier colour", () => {
    const filled = (score: number) => llmMeterSegments(score).filter((c) => c !== "bg-apollo-rail");
    for (const score of [0, 3, 6, 7, 8, 10]) {
      expect(llmMeterSegments(score)).toHaveLength(10);
      expect(filled(score)).toHaveLength(score);
    }
    expect(new Set(filled(8))).toEqual(new Set(["bg-apollo-slate"]));
    expect(new Set(filled(7))).toEqual(new Set(["bg-apollo-amber"]));
    expect(new Set(filled(6))).toEqual(new Set(["bg-apollo-amber"]));
    expect(new Set(filled(5))).toEqual(new Set(["bg-muted-foreground"]));
    expect(llmMeterSegments(12).filter((c) => c === "bg-apollo-rail")).toHaveLength(0);
  });

  it("rowChips: counted signals slate, uncounted context neutral", () => {
    const r = row({
      signalAck: true,
      ackAlias: "SYN",
      coauthors: ["zzz9001"],
      llmScore: 9,
      methodTier: "moderate",
      wcmAuthors: [{ cwid: "yyy9002", name: "Pat Placeholder", slug: null, dept: null }],
    });
    expect(rowChips(r, {}, new Set(["yyy9002"]), "evidence")).toEqual([
      { label: "Acknowledged", tone: "signal" },
      { label: "Staff co-author", tone: "signal" },
      { label: "LLM 9/10", tone: "signal" },
      { label: "Client co-author", tone: "quiet" },
      { label: "Method moderate", tone: "quiet" },
    ]);
    expect(rowChips(row({ llmScore: 3 }), {}, new Set(), "evidence")).toEqual([
      { label: "LLM 3/10", tone: "quiet" },
    ]);
  });
});

function listRow(container: HTMLElement, pmid: string): HTMLElement {
  return container.querySelector(
    `[data-slot="core-queue-row"][data-pmid="${pmid}"]`,
  ) as HTMLElement;
}

describe("the list and rail as rendered", () => {
  const STRONG = row({ pmid: "90000011", title: "Strong paper", likelihood: 0.9 });
  const SLIGHT = row({ pmid: "90000012", title: "Slight paper", likelihood: 0.5, llmScore: 6 });

  it("spines non-Strong rows in their band colour, Strong rows not at all, focus in slate", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[STRONG, SLIGHT]} confirmed={[]} />,
    );
    // the first row is focused on load
    expect(listRow(container, "90000011").className).toContain("border-l-apollo-slate");
    expect(listRow(container, "90000012").className).toContain(likelihoodBand(0.5).spine);
    fireEvent.click(listRow(container, "90000012").querySelector("button") as HTMLElement);
    expect(listRow(container, "90000011").className).toContain("border-l-transparent");
    expect(listRow(container, "90000011").className).not.toContain(likelihoodBand(0.9).spine);
    expect(listRow(container, "90000012").className).toContain("border-l-apollo-slate");
  });

  it("puts the short journal, year and PMID on one meta line", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[STRONG, SLIGHT]} confirmed={[]} />,
    );
    const meta = listRow(container, "90000011").querySelector(
      '[data-slot="core-queue-row-meta"]',
    ) as HTMLElement;
    expect(meta.textContent).toBe(`${STRONG.journalAbbrev} · ${STRONG.year} · PMID ${STRONG.pmid}`);
    expect(meta.querySelector(".truncate")?.textContent).toBe(STRONG.journalAbbrev);
  });

  it("tints the band pill and the LLM chip", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[STRONG, SLIGHT]} confirmed={[]} />,
    );
    // the innermost span with the band text (its wrapper carries the same text)
    const pill = [...listRow(container, "90000012").querySelectorAll("span")]
      .filter((s) => s.textContent === "Slight 50%")
      .pop();
    expect(pill?.className).toContain(likelihoodBand(0.5).tint);
    const chip = listRow(container, "90000012").querySelector("[data-tone]") as HTMLElement;
    expect(chip.textContent).toBe("LLM 6/10");
    expect(chip.dataset.tone).toBe("amber");
  });

  it("puts each rail group's own evidence colour on its sub-line", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[STRONG, SLIGHT]} confirmed={[]} />,
    );
    const dots = [...container.querySelectorAll<HTMLElement>('[data-slot="core-queue-rail-dot"]')];
    // "All candidates" (slate) + the one LLM-read group, in its strip colour
    expect(dots).toHaveLength(2);
    expect(dots[0].className).toContain("bg-apollo-slate");
    expect(dots[1].style.background).toBe(evidenceGroupColor("llm"));
  });
});
