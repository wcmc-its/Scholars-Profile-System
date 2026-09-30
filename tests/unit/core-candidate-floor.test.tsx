/**
 * The core review display floor (lib/cores/review-thresholds.ts): open engine
 * candidates below CANDIDATE_DISPLAY_FLOOR are hidden from the queue by default
 * and left out of the /edit/core index and core-editor "To review" counts.
 *
 * Every fixture value here is synthetic: made-up titles, CWIDs and PMIDs.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  applyDisplayFloor,
  CoreClaimQueue,
  searchedPmids,
} from "@/components/edit/core-claim-queue";
import {
  buildCoreConsoleRows,
  countReviewSuggestions,
  type CoreConsoleInputs,
} from "@/lib/api/core-console-index";
import { partitionCoreQueue, type CoreQueueRow } from "@/lib/api/core-queue";
import {
  CANDIDATE_DISPLAY_FLOOR,
  CANDIDATE_DISPLAY_FLOOR_PCT,
  isBelowDisplayFloor,
} from "@/lib/cores/review-thresholds";

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
    signalAck: true,
    ackAlias: "SYN",
    ackSnippet: "run at the SYN facility",
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

// Two above the floor (one exactly AT it — inclusive), three below.
const HIGH = row({ pmid: "90000001", title: "High paper", likelihood: 0.82 });
const AT = row({ pmid: "90000002", title: "At floor paper", likelihood: CANDIDATE_DISPLAY_FLOOR });
const LOW_A = row({ pmid: "90000003", title: "Low paper A", likelihood: 0.39, year: 2019 });
const LOW_B = row({ pmid: "90000004", title: "Low paper B", likelihood: 0.35, year: 2019 });
const LOW_C = row({ pmid: "90000005", title: "Low paper C", likelihood: 0.3, year: 2019 });
const MIXED = [HIGH, AT, LOW_A, LOW_B, LOW_C];

function renderQueue(props: Partial<Parameters<typeof CoreClaimQueue>[0]> = {}) {
  const view = render(<CoreClaimQueue core={CORE} candidates={MIXED} confirmed={[]} {...props} />);
  const q = within(view.container);
  const titles = () =>
    [...view.container.querySelectorAll('[data-slot="core-queue-row"]')].map(
      (li) => li.getAttribute("data-pmid") ?? "",
    );
  const floorLine = () =>
    view.container.querySelector('[data-slot="core-queue-floor"]')?.textContent ?? null;
  return { view, q, titles, floorLine };
}

describe("isBelowDisplayFloor", () => {
  it("is the one global 0.40 floor, inclusive at the floor", () => {
    expect(CANDIDATE_DISPLAY_FLOOR).toBe(0.4);
    expect(CANDIDATE_DISPLAY_FLOOR_PCT).toBe(40);
    expect(isBelowDisplayFloor(row({ likelihood: 0.4 }))).toBe(false);
    expect(isBelowDisplayFloor(row({ likelihood: 0.3999 }))).toBe(true);
  });

  it("exempts queued, manual and claimed rows, and anything not an engine candidate", () => {
    expect(isBelowDisplayFloor(row({ likelihood: 0, status: "unscored", queued: true }))).toBe(
      false,
    );
    // an engine below_threshold row sent to review by hand
    expect(
      isBelowDisplayFloor(row({ likelihood: 0.2, status: "below_threshold", queued: true })),
    ).toBe(false);
    expect(isBelowDisplayFloor(row({ likelihood: 0.2, queued: true }))).toBe(false);
    expect(isBelowDisplayFloor(row({ likelihood: 0, isManual: true }))).toBe(false);
    expect(isBelowDisplayFloor(row({ likelihood: 0.2, claimed: true }))).toBe(false);
    expect(isBelowDisplayFloor(row({ likelihood: 0.2, status: "confirmed" }))).toBe(false);
  });
});

describe("applyDisplayFloor / searchedPmids", () => {
  const none = new Set<string>();
  it("hides below-floor rows and counts them, order kept", () => {
    const f = applyDisplayFloor(MIXED, { showLow: false, decided: none, searched: none });
    expect(f.shown.map((r) => r.pmid)).toEqual(["90000001", "90000002"]);
    expect(f.hidden).toBe(3);
    expect(f.belowFloor).toBe(3);
  });
  it("showLow, a session decision, or a searched PMID brings a row back", () => {
    expect(
      applyDisplayFloor(MIXED, { showLow: true, decided: none, searched: none }).shown,
    ).toHaveLength(5);
    const f = applyDisplayFloor(MIXED, {
      showLow: false,
      decided: new Set(["90000003"]),
      searched: new Set(["90000005"]),
    });
    expect(f.shown.map((r) => r.pmid)).toEqual(["90000001", "90000002", "90000003", "90000005"]);
    expect(f.hidden).toBe(1);
  });
  it("a search names PMIDs only when every token is one — a lone PMID counts", () => {
    expect([...searchedPmids(" 90000003 ")]).toEqual(["90000003"]);
    expect([...searchedPmids("90000003, 90000004;90000005")]).toEqual([
      "90000003",
      "90000004",
      "90000005",
    ]);
    expect(searchedPmids("imaging 90000003").size).toBe(0);
    expect(searchedPmids("").size).toBe(0);
  });
});

describe("CoreClaimQueue — display floor", () => {
  it("hides below-floor candidates from the list, rail, Select all and Reject all, and says how many", () => {
    const { q, titles, floorLine } = renderQueue();
    expect(titles()).toEqual(["90000001", "90000002"]);
    expect(floorLine()).toBe("3 lower-confidence candidates hidden (likelihood below 40%) · Show");
    // the rail's catch-all count and the phone scope select
    const scope = q.getByRole("combobox", { name: "Choose a scope" }) as HTMLSelectElement;
    expect(scope.options[0].textContent).toBe("All candidates (2)");
    // ...and every evidence group's count (all five fixtures share one group)
    expect([...scope.options].slice(1).map((o) => o.textContent?.match(/\((\d+)\)$/)?.[1])).toEqual(
      ["2"],
    );
    expect(q.getByText("Select all 2 shown")).toBeTruthy();
    expect(q.getByRole("button", { name: "Reject all 2…" })).toBeTruthy();
    expect(q.getByText("Showing 2 of 2 candidates")).toBeTruthy();
  });

  it("leaves hidden rows out of the facet counts", () => {
    const { q } = renderQueue();
    fireEvent.click(q.getByRole("button", { name: /^Filters/ }));
    // Only the three hidden rows are from 2019.
    expect(q.queryByRole("checkbox", { name: /^2019/ })).toBeNull();
    expect(q.getByRole("checkbox", { name: /^2021/ }).textContent).toBe("2021 2");
  });

  it("Show reveals them (every count follows), Hide puts them back", () => {
    const { q, titles, floorLine } = renderQueue();
    fireEvent.click(q.getByRole("button", { name: "Show" }));
    expect(titles()).toHaveLength(5);
    expect(floorLine()).toBe("3 lower-confidence candidates shown (likelihood below 40%) · Hide");
    expect(q.getByText("Select all 5 shown")).toBeTruthy();
    expect(q.getByRole("button", { name: "Reject all 5…" })).toBeTruthy();
    fireEvent.click(q.getByRole("button", { name: "Hide" }));
    expect(titles()).toEqual(["90000001", "90000002"]);
  });

  it("formats a large hidden count with a thousands separator", () => {
    const many = Array.from({ length: 1200 }, (_, i) =>
      row({ pmid: String(91000000 + i), title: `Low ${i}`, likelihood: 0.33 }),
    );
    const { titles, floorLine } = renderQueue({ candidates: [HIGH, ...many] });
    expect(titles()).toEqual(["90000001"]);
    expect(floorLine()).toBe(
      "1,200 lower-confidence candidates hidden (likelihood below 40%) · Show",
    );
  });

  it("never hides a queued (Added by you) or manual row, and shows no line when nothing is hidden", () => {
    const queued = row({
      pmid: "90000011",
      title: "Queued unscored",
      likelihood: 0,
      status: "unscored",
      queued: true,
      isManual: true,
    });
    const queuedLow = row({
      pmid: "90000012",
      title: "Queued below threshold",
      likelihood: 0.2,
      status: "below_threshold",
      queued: true,
    });
    const { titles, floorLine } = renderQueue({ candidates: [HIGH, queued, queuedLow] });
    expect(titles().sort()).toEqual(["90000001", "90000011", "90000012"]);
    expect(floorLine()).toBeNull();
  });

  it("never hides a claimed low-likelihood row on the Confirmed tab", () => {
    const claimedLow = row({
      pmid: "90000021",
      title: "Claimed low paper",
      likelihood: 0.31,
      claimed: true,
    });
    const { q, view } = renderQueue({ candidates: [HIGH], confirmed: [claimedLow] });
    fireEvent.click(q.getByRole("button", { name: /^Confirmed/ }));
    const list = q.getByRole("list", { name: "Confirmed papers" });
    expect(within(list).getByText("Claimed low paper")).toBeTruthy();
    expect(view.container.querySelector('[data-slot="core-queue-floor"]')).toBeNull();
  });

  it("a PMID search reaches below-floor rows without Show — one PMID or several", () => {
    const { q, titles, floorLine } = renderQueue();
    const box = q.getByRole("searchbox", { name: "Filter candidates" });
    fireEvent.change(box, { target: { value: "90000004" } });
    expect(titles()).toEqual(["90000004"]);
    fireEvent.change(box, { target: { value: "90000003 90000005 90000001" } });
    expect(titles().sort()).toEqual(["90000001", "90000003", "90000005"]);
    expect(q.getByText(/Matched 3 of 3 PMIDs here\./)).toBeTruthy();
    // the one below-floor row the search did not name is still hidden
    expect(floorLine()).toBe("1 lower-confidence candidate hidden (likelihood below 40%) · Show");
  });

  it("a free-text search does NOT reach below the floor", () => {
    const { q, titles } = renderQueue();
    fireEvent.change(q.getByRole("searchbox", { name: "Filter candidates" }), {
      target: { value: "Low paper" },
    });
    expect(titles()).toEqual([]);
  });
});

describe("index and editor counts agree on the floor", () => {
  it("countReviewSuggestions is the index's reviewTotal for the same queue", () => {
    // Engine rows for one core: a spread straddling the floor, two of them
    // decided by a claim, plus a pmid sent to review by hand.
    const engine = [
      row({ pmid: "1", likelihood: 0.9 }),
      row({ pmid: "2", likelihood: 0.55 }),
      row({ pmid: "3", likelihood: 0.4 }),
      row({ pmid: "4", likelihood: 0.39 }),
      row({ pmid: "5", likelihood: 0.31 }),
      row({ pmid: "6", likelihood: 0.6 }), // claimed
      row({ pmid: "7", likelihood: 0.35 }), // rejected
    ];
    const queuedOnly = row({ pmid: "8", likelihood: 0, status: "unscored", isManual: true });
    const claims = new Map([
      ["6", "claimed" as const],
      ["7", "rejected" as const],
    ]);
    const { candidates } = partitionCoreQueue(
      [...engine, queuedOnly],
      (p) => claims.get(p) ?? null,
      new Set(["8"]),
    );

    // What the index's grouped query sees: engine candidates at/above the floor.
    const aboveFloor = engine.filter((r) => r.likelihood >= CANDIDATE_DISPLAY_FLOOR).length;
    const inputs: CoreConsoleInputs = {
      cores: [
        {
          id: "2",
          name: "Synthetic Core",
          facility: null,
          visible: true,
          url: null,
          description: null,
          staffCount: null,
          staffTrackedCount: null,
        },
      ],
      leaders: [],
      roleLabels: new Map(),
      admins: [],
      names: new Map(),
      candidateTotals: new Map([["2", aboveFloor]]),
      candidateHighs: new Map([["2", 1]]),
      claimedCandidates: engine
        .filter((r) => claims.has(r.pmid))
        .map((r) => ({ coreId: "2", likelihood: r.likelihood })),
      confirmedByCore: new Map(),
      clients: [],
    };
    const [indexRow] = buildCoreConsoleRows(inputs);

    expect(indexRow.reviewTotal).toBe(3); // pmids 1, 2, 3
    expect(countReviewSuggestions(candidates)).toBe(indexRow.reviewTotal);
  });
});
