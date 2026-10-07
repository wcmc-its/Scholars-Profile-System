/**
 * The Confirmed tab's summary strip (Core publication queue mockup refresh,
 * PR 5): independent signals per paper, the band span, which signals fired with
 * the method-tier note, and "Behind these confirmations". The pure helpers
 * first, then the strip as rendered.
 *
 * Every fixture value here is synthetic: made-up titles, names, CWIDs and PMIDs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  confirmedBandSpan,
  CoreClaimQueue,
  methodTierNote,
  summarizeConfirmed,
} from "@/components/edit/core-claim-queue";
import { multiSignalText } from "@/components/edit/core-queue-panels";
import type { CoreQueueRow } from "@/lib/api/core-queue";

const PAT = { cwid: "zzz9001", name: "Pat Example", slug: "pat-example", dept: "Medicine" };
const SAM = { cwid: "zzz9002", name: "Sam Sample", slug: "sam-sample", dept: null };

function row(over: Partial<CoreQueueRow> = {}): CoreQueueRow {
  return {
    pmid: "90000001",
    title: "Synthetic paper",
    journal: "Synthetic Journal",
    journalAbbrev: "Synth J",
    year: 2021,
    dateAddedToEntrez: "2026-02-18",
    authorsString: "Example P",
    fullAuthorsString: "Example P",
    abstract: null,
    synopsis: null,
    likelihood: 0.95,
    status: "confirmed",
    coauthors: [],
    coauthorScholars: [],
    wcmAuthors: [],
    signalAck: false,
    ackAlias: null,
    ackSnippet: null,
    llmScore: 8,
    llmRationale: null,
    authorAffinity: null,
    topicalPrior: null,
    methodTier: null,
    methodEvidence: [],
    citationCount: 0,
    pubmedUrl: null,
    doi: null,
    claimed: true,
    isManual: false,
    relativeCitationRatio: null,
    nihPercentile: null,
    meshTerms: [],
    ...over,
  };
}

const CORE = { id: "2", name: "Synthetic Core", staffCount: 4, staffTrackedCount: 1 };

/** Pat has three confirmed papers here, Sam one. */
const COUNTS = {
  zzz9001: { papers: 3, recent: 1, total: 20 },
  zzz9002: { papers: 1, recent: 1, total: 9 },
};

/** Ack + LLM, method strong. Two signals. */
const ACK = row({
  pmid: "90000011",
  title: "Acknowledged alpha",
  likelihood: 0.99,
  signalAck: true,
  ackAlias: "Synthetic Core Facility",
  methodTier: "strong",
});
/** Ack (no alias) + LLM + repeat user (Pat). Three signals. */
const ACK_REPEAT = row({
  pmid: "90000012",
  title: "Repeat beta",
  likelihood: 1,
  signalAck: true,
  llmScore: 6,
  wcmAuthors: [PAT],
  authorAffinity: 0.3,
  methodTier: "weak",
});
/** LLM only, low read, Moderate band. One signal. */
const LLM_ONLY = row({
  pmid: "90000013",
  title: "Model gamma",
  likelihood: 0.7,
  llmScore: 3,
  wcmAuthors: [SAM],
  authorAffinity: 0.2,
  methodTier: "weak",
});
/** A human added this PMID; every engine field is a placeholder. */
const MANUAL = row({
  pmid: "90000014",
  title: "Manual delta",
  likelihood: 0,
  llmScore: null,
  isManual: true,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("summarizeConfirmed", () => {
  it("distributes papers by signals fired, skipping manual adds", () => {
    const s = summarizeConfirmed([ACK, ACK_REPEAT, LLM_ONLY, MANUAL], new Set(), COUNTS);
    expect(s.total).toBe(3);
    expect(s.manual).toBe(1);
    expect(s.bySignals).toEqual([0, 1, 1, 1, 0]);
    expect(s.multiSignal).toBe(2);
    expect(s.signals).toEqual({ ack: 2, coauthor: 0, llm: 3, affinity: 1 });
    // The manual add's 0% does not drag the span down.
    expect(s.low).toBe(0.7);
    expect(s.high).toBe(1);
  });

  it("reads each row through its own counts: Sam's only paper is no repeat use", () => {
    const s = summarizeConfirmed([LLM_ONLY], new Set(), COUNTS);
    expect(s.signals.affinity).toBe(0);
    expect(s.bySignals[1]).toBe(1);
  });

  it("leaves a paper revoked this session out of every count", () => {
    const s = summarizeConfirmed([ACK, ACK_REPEAT], new Set([ACK_REPEAT.pmid]), COUNTS);
    expect(s.total).toBe(1);
    expect(s.signals.affinity).toBe(0);
    expect(s.aliases).toEqual([{ alias: "Synthetic Core Facility", count: 1 }]);
    expect(s.ackNoAlias).toBe(0);
    expect(s.methodTiers).toEqual([{ tier: "strong", count: 1 }]);
  });

  it("counts aliases, method tiers strong-first, and LLM reads by llmVerdict", () => {
    const s = summarizeConfirmed([LLM_ONLY, ACK_REPEAT, ACK], new Set(), COUNTS);
    expect(s.aliases).toEqual([{ alias: "Synthetic Core Facility", count: 1 }]);
    expect(s.ackNoAlias).toBe(1);
    expect(s.methodTiers).toEqual([
      { tier: "strong", count: 1 },
      { tier: "weak", count: 2 },
    ]);
    expect(s.llm).toEqual([
      { tier: "core", label: "Reads as core work", count: 1 },
      { tier: "possible", label: "Possibly core work", count: 1 },
      { tier: "little", label: "Little sign of core use", count: 1 },
    ]);
    expect(s.llmUnread).toBe(0);
  });

  it("is empty-safe", () => {
    const s = summarizeConfirmed([MANUAL], new Set());
    expect(s.total).toBe(0);
    expect(s.low).toBeNull();
    expect(s.llm).toEqual([]);
    expect(confirmedBandSpan(s.low, s.high)).toBeNull();
  });
});

describe("confirmedBandSpan / methodTierNote / multiSignalText", () => {
  it("computes the band words and percent span from the rows", () => {
    expect(confirmedBandSpan(0.98, 1)).toEqual({ low: "Strong", high: "Strong", pct: "98–100%" });
    expect(confirmedBandSpan(0.41, 0.99)).toEqual({
      low: "Slight",
      high: "Strong",
      pct: "41–99%",
    });
    expect(confirmedBandSpan(0.9, 0.9)).toEqual({ low: "Strong", high: "Strong", pct: "90%" });
  });

  it("lists method tiers as context, never as a count", () => {
    expect(methodTierNote([])).toBe(
      "Method family is context and isn’t counted. No confirmed paper carries a tier.",
    );
    expect(
      methodTierNote([
        { tier: "strong", count: 48 },
        { tier: "weak", count: 14 },
      ]),
    ).toBe("Method family is context and isn’t counted. It reads strong on 48, weak on 14.");
  });

  it("is singular-safe", () => {
    expect(multiSignalText(1)).toBe(
      "of 1 confirmed paper rests on two or more independent signals",
    );
    expect(multiSignalText(3)).toBe(
      "of 3 confirmed papers rest on two or more independent signals",
    );
  });
});

function renderConfirmed(confirmed: CoreQueueRow[]) {
  return render(
    <CoreClaimQueue core={CORE} candidates={[]} confirmed={confirmed} paperCounts={COUNTS} />,
  );
}
const strip = () => within(screen.getByRole("region", { name: "Confirmed summary" }));
const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`) as HTMLElement;
const titles = () =>
  [...document.querySelectorAll('[data-slot="core-queue-confirmed-row"]')].map(
    (li) => li.querySelector("span.line-clamp-2")?.textContent,
  );

describe("Confirmed tab — summary strip", () => {
  it("shows the distribution, the computed band span and the method note", () => {
    renderConfirmed([ACK, ACK_REPEAT, LLM_ONLY, MANUAL]);
    const first = slot("core-queue-confirmed-summary-signals");
    expect(first.textContent).toContain(
      "2of 3 confirmed papers rest on two or more independent signals",
    );
    // The bar and legend are the rail's evidence groups, coloured as on To
    // review: strongest signal's hue, deeper for more signals, a manual pile slate.
    expect(first.textContent).toContain("Acknowledgment + LLM read1");
    expect(first.textContent).toContain("Acknowledgment + LLM read + repeat user1");
    expect(first.textContent).toContain("LLM read1");
    expect(first.textContent).toContain("Added by you1");
    const swatches = [
      ...first.querySelectorAll<HTMLElement>('[data-slot="core-queue-group-swatch"]'),
    ].map((e) => e.style.background);
    expect(swatches).toEqual([
      "var(--apollo-slate)",
      "var(--apollo-signal-ack-2)",
      "var(--apollo-signal-ack-3)",
      "var(--apollo-signal-llm-1)",
    ]);
    const segments = [
      ...first.querySelectorAll<HTMLElement>('[data-slot="core-queue-group-segment"]'),
    ].map((e) => e.style.background);
    expect(segments).toEqual(swatches);
    expect(first.textContent).toContain("1 manually added paper is unscored and not counted.");
    expect(slot("core-queue-confirmed-band").textContent).toBe(
      "Confirmations run from the Moderate to the Strong band, 70–100%.",
    );
    expect(slot("core-queue-summary-signals").textContent).toContain(
      "It reads strong on 1, weak on 2.",
    );
  });

  it("says only what the engine reads back, never that it trains the next run", () => {
    renderConfirmed([ACK, ACK_REPEAT, LLM_ONLY]);
    const behind = slot("core-queue-confirmed-summary-behind");
    expect(behind.textContent).toContain("Behind these confirmations");
    expect(behind.textContent).toContain("Repeat-user prior for 2 people");
    expect(behind.textContent).toContain("“Synthetic Core Facility”1");
    expect(behind.textContent).toContain("Acknowledged, no alias captured1");
    expect(behind.textContent).toContain("Reads as core work · 1");
    expect(behind.textContent).toContain("From the core’s alias list.");
    expect(behind.textContent).toContain("It is not a prior.");
    expect(screen.getByRole("region", { name: "Confirmed summary" }).textContent).not.toMatch(
      /teach|train|learn/i,
    );
  });

  it("a person chip opens By person on that person", () => {
    renderConfirmed([ACK, ACK_REPEAT, LLM_ONLY]);
    const chip = strip().getByRole("button", { name: "Pat Example, 3 confirmed papers" });
    fireEvent.click(chip);
    expect(screen.getByRole("button", { name: "By person" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(titles()).toEqual(["Repeat beta"]);
  });

  it("a signal click filters the Confirmed list", () => {
    renderConfirmed([ACK, ACK_REPEAT, LLM_ONLY]);
    fireEvent.click(strip().getByRole("button", { name: /^Repeat user/ }));
    expect(titles()).toEqual(["Repeat beta"]);
    expect(
      (strip().getByRole("button", { name: /^Staff co-author/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says only the manual note when every confirmation is a manual add", () => {
    renderConfirmed([MANUAL]);
    const first = slot("core-queue-confirmed-summary-signals");
    expect(first.textContent).not.toContain("of 0");
    expect(first.textContent).toContain("1 manually added paper is unscored and not counted.");
  });

  it("a signal click from a rail pile shows the whole tab, which is what it counted", () => {
    renderConfirmed([ACK, ACK_REPEAT, LLM_ONLY]);
    const rail = slot("core-queue-rail");
    fireEvent.click(within(rail).getByRole("button", { name: /^LLM read(?! \+)/ }));
    expect(titles()).toEqual(["Model gamma"]);
    fireEvent.click(strip().getByRole("button", { name: /^Repeat user/ }));
    expect(titles()).toEqual(["Repeat beta"]);
  });

  it("drops a revoked paper from the strip", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    renderConfirmed([ACK, LLM_ONLY]);
    const first = () => slot("core-queue-confirmed-summary-signals").textContent;
    expect(first()).toContain("of 2 confirmed papers");
    const pane = slot("core-queue-confirmed-focus");
    fireEvent.click(within(pane).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(first()).toContain("of 1 confirmed paper rests"));
  });
});
