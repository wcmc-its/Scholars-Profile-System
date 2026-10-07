/**
 * The To review summary strip (Core publication queue mockup refresh, PR 1):
 * "Open candidates by evidence", "Which signals fired" (click to filter) and
 * "This session". The pure helpers first, then the strip as rendered.
 *
 * Every fixture value here is synthetic: made-up titles, CWIDs and PMIDs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  ADDED_GROUP,
  CoreClaimQueue,
  evidenceGroupColor,
  facetValues,
  reasonTally,
  sessionNote,
  SIGNAL_KINDS,
  summarizeOpen,
} from "@/components/edit/core-claim-queue";
import { openSummaryText, sessionCountTone } from "@/components/edit/core-queue-panels";
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

// Ack + staff co-author + LLM, above the floor.
const RICH = row({
  pmid: "90000001",
  title: "Rich paper",
  signalAck: true,
  ackAlias: "SYN",
  coauthors: ["zzz9001"],
});
// LLM read only, above the floor.
const LLM_ONLY = row({ pmid: "90000002", title: "Plain paper", likelihood: 0.7 });
// LLM read only, BELOW the 0.40 display floor — hidden by default.
const HIDDEN = row({ pmid: "90000003", title: "Hidden paper", likelihood: 0.2 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("summarizeOpen", () => {
  it("counts open rows, two-or-more-signal rows, groups and per-signal hits", () => {
    const s = summarizeOpen([RICH, LLM_ONLY], new Map());
    expect(s.total).toBe(2);
    expect(s.multiSignal).toBe(1);
    expect(s.groups).toEqual([
      { key: "ack+coauthor+llm", count: 1 },
      { key: "llm", count: 1 },
    ]);
    expect(s.signals).toEqual({ ack: 1, coauthor: 1, llm: 2, affinity: 0 });
  });

  it("skips decided rows everywhere, and drops a group with nothing open", () => {
    const s = summarizeOpen([RICH, LLM_ONLY], new Map([["90000001", "claimed"]]));
    expect(s.total).toBe(1);
    expect(s.multiSignal).toBe(0);
    expect(s.groups).toEqual([{ key: "llm", count: 1 }]);
    expect(s.signals).toEqual({ ack: 0, coauthor: 0, llm: 1, affinity: 0 });
  });

  it("applies the repeat-user de-dup exactly as the card does", () => {
    // The only counted person on the byline is the staff co-author, so the
    // repeat-user prior is that same person again and does not fire.
    const r = row({
      coauthors: ["zzz9001"],
      wcmAuthors: [{ cwid: "zzz9001", name: "Zed Fixture", slug: null, dept: null }],
      authorAffinity: 0.6,
    });
    const s = summarizeOpen([r], new Map(), { zzz9001: { papers: 4, total: 9, recent: 1 } });
    expect(s.signals.affinity).toBe(0);
    expect(s.groups).toEqual([{ key: "coauthor+llm", count: 1 }]);
  });
});

describe("SIGNAL_KINDS", () => {
  it("drives the very facet values facetValues emits", () => {
    const v = facetValues(RICH);
    for (const k of SIGNAL_KINDS.filter((x) => x.kind !== "affinity"))
      expect(v.signal).toContain(k.facet);
  });
});

describe("reasonTally", () => {
  it("counts reasons only for papers still rejected, most-used first", () => {
    const notes = new Map([
      ["1", "Method match only"],
      ["2", "Method match only"],
      ["3", "External data, not this core"],
      ["4", "Author used core elsewhere"], // undone: no longer decided
      ["5", "Author used core elsewhere"], // re-decided as a confirm
    ]);
    const decided = new Map([
      ["1", "rejected"],
      ["2", "rejected"],
      ["3", "rejected"],
      ["5", "claimed"],
    ]);
    expect(reasonTally(notes, decided)).toEqual([
      { label: "Method match only", count: 2 },
      { label: "External data, not this core", count: 1 },
    ]);
  });
});

describe("sessionNote", () => {
  it("never claims the engine learns from reasons", () => {
    for (const note of [sessionNote(0, 5), sessionNote(3, 1)]) {
      expect(note).not.toMatch(/train|learn/i);
      expect(note).toMatch(/never reads|not sent to the engine/);
    }
    expect(sessionNote(3, 1)).toMatch(/^1 candidate left to review\. Confirmed papers feed/);
  });
});

describe("openSummaryText", () => {
  it("is singular-safe", () => {
    expect(openSummaryText(1, 1, 1)).toBe(
      "candidate in 1 evidence group. 1 has two or more signals.",
    );
    expect(openSummaryText(9, 4, 0)).toBe(
      "candidates in 4 evidence groups. 0 have two or more signals.",
    );
  });
  it("sessionCountTone is muted gray at 0 and colours only once > 0", () => {
    expect(sessionCountTone(0, "text-apollo-brick")).toBe("text-muted-foreground");
    expect(sessionCountTone(1, "text-apollo-brick")).toBe("text-apollo-brick");
  });
});

function strip() {
  return within(screen.getByRole("region", { name: "Queue summary" }));
}

describe("CoreClaimQueue — summary strip", () => {
  it("counts only the rows the list SHOWS, not the ones below the display floor", () => {
    render(<CoreClaimQueue core={CORE} candidates={[RICH, LLM_ONLY, HIDDEN]} confirmed={[]} />);
    const groups = document.querySelector('[data-slot="core-queue-summary-groups"]')!;
    expect(groups.textContent).toContain(
      "2candidates in 2 evidence groups. 1 has two or more signals.",
    );
    expect(groups.textContent).toContain("Acknowledgment + staff co-author + LLM read1");
    expect(groups.textContent).toContain("LLM read1");
    // LLM fired on all three, but the hidden one is not counted
    expect(strip().getByRole("button", { name: /^LLM read/ }).textContent).toMatch(/2$/);

    // Showing the hidden rows brings them into the strip too.
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(groups.textContent).toContain("3candidates in 2 evidence groups.");
    expect(strip().getByRole("button", { name: /^LLM read/ }).textContent).toMatch(/3$/);
  });

  it("a signal click toggles the Signals fired facet; a zero-count signal is disabled", () => {
    render(<CoreClaimQueue core={CORE} candidates={[RICH, LLM_ONLY]} confirmed={[]} />);
    const rows = () =>
      [...document.querySelectorAll('[data-slot="core-queue-row"]')].map((li) =>
        li.getAttribute("data-pmid"),
      );
    expect(rows()).toEqual(["90000001", "90000002"]);
    expect(
      (strip().getByRole("button", { name: /^Repeat user/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    const ack = strip().getByRole("button", { name: /^Acknowledgment/ });
    fireEvent.click(ack);
    expect(ack.getAttribute("aria-pressed")).toBe("true");
    expect(rows()).toEqual(["90000001"]);
    expect(
      screen.getByRole("button", { name: "Remove filter Signals fired: Acknowledged" }),
    ).toBeTruthy();

    fireEvent.click(ack);
    expect(ack.getAttribute("aria-pressed")).toBe("false");
    expect(rows()).toEqual(["90000001", "90000002"]);
  });

  it("tallies reject reasons this session, and an undo takes the reason back out", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[RICH, LLM_ONLY]} confirmed={[]} />);
    const session = () => document.querySelector('[data-slot="core-queue-session"]')!;
    expect(session().textContent).toContain("Nothing decided yet.");

    const pane = document.querySelector('[data-slot="core-queue-focus"]') as HTMLElement;
    const reasons = within(pane).getByRole("group", { name: "Reject with a reason" });
    fireEvent.click(within(reasons).getByRole("button", { name: "Method match only" }));

    const tally = await screen.findByRole("list", { name: "Reject reasons this session" });
    expect(tally.textContent).toBe("Method match only1");
    expect(session().textContent).toContain("1 candidate left to review.");
    expect(session().textContent).not.toMatch(/train/i);

    fireEvent.click(strip().getByRole("button", { name: "Undo last" }));
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Reject reasons this session" })).toBeNull(),
    );
  });
});

describe("evidenceGroupColor — a pile takes its strongest signal's hue", () => {
  it("picks the strongest signal by the fixed ranking, whatever the key order", () => {
    expect(evidenceGroupColor("ack")).toBe("var(--apollo-signal-ack-1)");
    expect(evidenceGroupColor("coauthor")).toBe("var(--apollo-signal-coauthor-1)");
    expect(evidenceGroupColor("llm")).toBe("var(--apollo-signal-llm-1)");
    expect(evidenceGroupColor("affinity")).toBe("var(--apollo-signal-affinity)");
    // the ranking, not the position in the key, decides
    expect(evidenceGroupColor("affinity+coauthor")).toBe(evidenceGroupColor("coauthor+affinity"));
    expect(evidenceGroupColor("llm+ack")).toBe("var(--apollo-signal-ack-2)");
  });

  it("goes a step deeper for every further signal, within the same hue", () => {
    expect(evidenceGroupColor("ack+coauthor")).toBe("var(--apollo-signal-ack-2)");
    expect(evidenceGroupColor("ack+coauthor+llm")).toBe("var(--apollo-signal-ack-3)");
    expect(evidenceGroupColor("ack+coauthor+llm+affinity")).toBe("var(--apollo-signal-ack-4)");
    expect(evidenceGroupColor("coauthor+llm")).toBe("var(--apollo-signal-coauthor-2)");
    expect(evidenceGroupColor("coauthor+llm+affinity")).toBe("var(--apollo-maroon)");
    expect(evidenceGroupColor("llm+affinity")).toBe("var(--apollo-amber)");
  });

  it("gives every distinct (strongest signal, signal count) pile its own colour", () => {
    const keys = [
      "ack",
      "ack+coauthor",
      "ack+coauthor+llm",
      "ack+coauthor+llm+affinity",
      "coauthor",
      "coauthor+llm",
      "coauthor+llm+affinity",
      "llm",
      "llm+affinity",
      "affinity",
      "none",
      ADDED_GROUP,
    ];
    expect(new Set(keys.map(evidenceGroupColor)).size).toBe(keys.length);
  });

  it("paints a pile a person added slate, and a pile with no counted signal grey", () => {
    expect(evidenceGroupColor(ADDED_GROUP)).toBe("var(--apollo-slate)");
    expect(evidenceGroupColor("none")).toBe("var(--apollo-signal-none)");
  });

  it("colours the bar segment, its legend square and the rail dot alike", () => {
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "90000101", signalAck: false, llmScore: 8 }),
          row({ pmid: "90000102", signalAck: true, llmScore: 8 }),
        ]}
        confirmed={[]}
      />,
    );
    const fills = (slot: string) =>
      [...container.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)].map(
        (e) => e.style.background,
      );
    const segments = fills("core-queue-group-segment");
    expect(segments).toHaveLength(2);
    expect(new Set(segments).size).toBe(2);
    expect(fills("core-queue-group-swatch")).toEqual(segments);
    // the rail lists "All candidates" (a class, no inline colour) then the groups
    expect(fills("core-queue-rail-dot").slice(1)).toEqual(segments);
  });
});
