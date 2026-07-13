/**
 * Sponsor-match panel client behaviors.
 *
 * The load-bearing test here is "a slider re-ranks with NO fetch". PR #1673 re-POSTed the
 * description with edited concepts on every re-rank, which is the "re-query on every drag"
 * degradation the UI contract rejects (`lib/api/sponsor-match-contract.ts`). The response
 * now carries the decomposed score inputs, so the panel re-ranks in the browser. If anyone
 * re-adds a fetch to the slider path, `expect(rankCalls(fetchMock)).toBe(1)` fails.
 *
 * That assertion counts RANKING POSTs, not all fetches, because the panel legitimately GETs its
 * retained-search list on mount and after a search (#6d). Counting every call would have made
 * the test fail for a harmless reason — and, worse, would have let a genuinely re-added
 * re-query hide behind a history refresh.
 *
 * Also covered:
 *  - facets (department / matched concept / CTL-IP) narrow rows client-side, and each row
 *    keeps its rank number from the FULL list;
 *  - retained searches are listed from the SERVER and are cross-officer (#6d), the officer is
 *    told they are kept, and deleting one really deletes it;
 *  - the rail splits Concepts from Methods by `kind`, shows merged members as chips, and
 *    badges a rare concept;
 *  - the bespoke shape (empty concepts) renders no rail at all.
 * fetch is stubbed — no route/engine involvement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SponsorMatchPanel } from "@/components/edit/sponsor-match-panel";
import type {
  SponsorCandidate,
  SponsorConcept,
  SponsorPreference,
} from "@/lib/api/sponsor-match-contract";

// K = 60. Scores below are the RRF sums the server would have sent; the panel recomputes
// them from `contributions` × `concepts`, so they only have to be self-consistent.
const CONCEPTS: SponsorConcept[] = [
  {
    term: "Immuno-oncology",
    kind: "concept",
    members: ["Immuno-oncology", "immunotherapy"],
    centrality: 0.9,
    weightFactor: 3.0,
    // An order of magnitude scarcer than Cancer Metabolism below ⇒ the ONLY ·rare badge.
    corpusCoverage: 5e-5,
  },
  {
    term: "Cancer Metabolism",
    kind: "concept",
    members: ["Cancer Metabolism"],
    centrality: 0.5,
    weightFactor: 1.0,
    corpusCoverage: 1e-3, // the most-covered concept in this ask ⇒ the baseline
  },
  {
    term: "CRISPR screening",
    kind: "method",
    members: ["CRISPR screening"],
    centrality: 0.4,
    weightFactor: 1.0,
    // No corpusCoverage at all — unknown. Must NOT be badged (absent ≠ common, and
    // absent ≠ rare either).
  },
];

function candidate(over: Partial<SponsorCandidate> & { cwid: string }): SponsorCandidate {
  return {
    name: "X",
    profileSlug: `slug-${over.cwid}`,
    title: "Professor",
    department: "Medicine",
    fusedScore: 0,
    contributions: [],
    technologyCount: 0,
    ...over,
  };
}

// In fused order, as the server ships them.
const THREE: SponsorCandidate[] = [
  candidate({
    cwid: "a",
    name: "Alice Alpha",
    fusedScore: 0.9 * 3.0 / 61, // 0.0443
    contributions: [{ term: "Immuno-oncology", rank: 1 }],
    evidence: {
      papers: [
        { pmid: "111", title: "CAR T persistence", year: 2024, journal: "Blood", relevance: 0.9 },
      ],
    },
  }),
  candidate({
    cwid: "b",
    name: "Bob Beta",
    technologyCount: 2,
    fusedScore: 0.9 * 3.0 / 62, // 0.0435
    contributions: [{ term: "Immuno-oncology", rank: 2 }],
  }),
  candidate({
    cwid: "c",
    name: "Cara Gamma",
    department: "Surgery",
    fusedScore: 0.5 * 1.0 / 61, // 0.0082
    contributions: [{ term: "Cancer Metabolism", rank: 1 }],
  }),
];

/** Exactly what the route's `bespokeToCandidate` emits: a real score, and NO contributions
 *  (that engine does no concept decomposition, so there is nothing to re-rank by). */
const BESPOKE: SponsorCandidate[] = [
  candidate({ cwid: "a", name: "Alice Alpha", fusedScore: 0.91 }),
  candidate({ cwid: "b", name: "Bob Beta", fusedScore: 0.44 }),
  candidate({ cwid: "c", name: "Cara Gamma", department: "Surgery", fusedScore: 0.06 }),
];

/**
 * The panel now talks to the route with three verbs, so the stub answers by verb:
 *   POST   — run the matcher (the ranking payload)
 *   GET    — the retained searches (#6d)
 *   DELETE — erase one
 * A GET that returned the ranking payload would leave `submissions` undefined, which is a
 * silently-empty history rather than an obviously-wrong one — worth not doing.
 */
function stubFetch(payload: {
  concepts: SponsorConcept[];
  candidates: SponsorCandidate[];
  preferences?: SponsorPreference[];
  submissions?: Submission[];
}) {
  const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return { ok: true, json: async () => ({ ok: true, submissions: payload.submissions ?? [] }) };
    }
    return { ok: true, json: async () => ({ ok: true, ...payload }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Ranking requests only. The panel also GETs its retained-search list on mount and after a
 *  search; those are not round-trips the SLIDER is allowed to cause, and conflating them with
 *  the matcher POST would let a re-added re-query hide behind a history refresh. */
function rankCalls(fetchMock: { mock: { calls: unknown[][] } }): number {
  return fetchMock.mock.calls.filter(
    (c) => ((c[1] as { method?: string } | undefined)?.method ?? "GET") === "POST",
  ).length;
}

type Submission = {
  id: string;
  description: string;
  title: string | null;
  engine: string;
  candidateCount: number;
  submittedBy: string;
  createdAt: string;
};

async function renderAndSearch() {
  render(<SponsorMatchPanel />);
  fireEvent.change(screen.getByLabelText(/description/i), {
    target: { value: "CAR T collaborators" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
  await screen.findByText("Alice Alpha");
}

/** Names of the result rows, in RENDERED (DOM) order — each row links to a profile, so the
 *  profile links in document order are the ranking the user actually sees. */
function rowOrder(): string[] {
  return screen
    .getAllByRole("link")
    .filter((a) => a.getAttribute("href")?.startsWith("/slug-"))
    .map((a) => a.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
  stubFetch({ concepts: CONCEPTS, candidates: THREE });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SponsorMatchPanel", () => {
  // ── The contract's hinge ────────────────────────────────────────────────────
  it("re-ranks LIVE on a slider move — with NO new fetch", async () => {
    const fetchMock = stubFetch({ concepts: CONCEPTS, candidates: THREE });
    await renderAndSearch();

    // Server order: Alice (Immuno #1), Bob (Immuno #2), Cara (Metabolism #1).
    expect(rowOrder()).toEqual(["Alice Alpha", "Bob Beta", "Cara Gamma"]);
    expect(rankCalls(fetchMock)).toBe(1);

    // Mute Immuno-oncology. Alice and Bob ranked ONLY under it, so both collapse to 0 and
    // Cara — who ranked under Cancer Metabolism — takes the top. This is recomputed from
    // `contributions` already in the browser.
    fireEvent.change(screen.getByLabelText("Immuno-oncology centrality"), {
      target: { value: "0" },
    });

    expect(rowOrder()).toEqual(["Cara Gamma", "Alice Alpha", "Bob Beta"]);
    // THE ASSERTION THAT MATTERS: the re-rank cost zero round-trips to the RANKER.
    expect(rankCalls(fetchMock)).toBe(1);
  });

  it("slides a muted concept back up and its candidates return", async () => {
    const fetchMock = stubFetch({ concepts: CONCEPTS, candidates: THREE });
    await renderAndSearch();
    const slider = screen.getByLabelText("Immuno-oncology centrality");

    fireEvent.change(slider, { target: { value: "0" } });
    expect(rowOrder()[0]).toBe("Cara Gamma");

    // A 0 is a mute, NOT a delete — the contributions survive, so the concept revives.
    // (Under #1673 this was impossible: 0 round-tripped through the server's
    // sanitizeConcepts, which rewrote any non-positive centrality to 0.3.)
    fireEvent.change(slider, { target: { value: "0.9" } });
    expect(rowOrder()).toEqual(["Alice Alpha", "Bob Beta", "Cara Gamma"]);
    expect(rankCalls(fetchMock)).toBe(1);
  });

  // ── The rail ───────────────────────────────────────────────────────────────
  it("splits Concepts and Methods by kind, and seeds each slider to its centrality", async () => {
    await renderAndSearch();
    expect(screen.getByRole("heading", { name: "Concepts" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Methods" })).toBeTruthy();

    const immuno = screen.getByLabelText("Immuno-oncology centrality") as HTMLInputElement;
    expect(immuno.value).toBe("0.9");
    // Floor is 0, not 0.05: with the re-rank client-side there is no sanitize hop to snap
    // a 0 back to 0.3, so "mute this concept" is finally expressible.
    expect(immuno.min).toBe("0");
    expect(immuno.max).toBe("1");
    expect(screen.getByLabelText("CRISPR screening centrality")).toBeTruthy();
  });

  it("shows merged member forms as chips", async () => {
    await renderAndSearch();
    // "immunotherapy" merged into the Immuno-oncology cluster — one slider, not two.
    expect(screen.getByText("immunotherapy")).toBeTruthy();
  });

  it("badges the scarce concept, and says what it actually measured", async () => {
    await renderAndSearch();
    // Exactly one: Immuno-oncology (5e-5) is an order of magnitude scarcer than the
    // most-covered concept in the ask (Cancer Metabolism, 1e-3). CRISPR has NO coverage at
    // all and must not be badged — unknown is neither rare nor common.
    const badges = screen.getAllByText("·rare");
    expect(badges).toHaveLength(1);
    // The tooltip states the measured fact and makes no claim about the ranking. The old
    // badge said "so a match on it counts for more", which is exactly the conflation the
    // IDF finding called out.
    const title = badges[0].getAttribute("title")!;
    expect(title).toMatch(/about 1 in 20,000 Weill Cornell papers/);
    expect(title).not.toMatch(/counts for more/);
  });

  it("badges nothing when no concept has a known coverage", async () => {
    // The §6 cliff: 40% of descriptors have zero coverage, and the spine omits the field
    // for those. A response with no coverage anywhere must render no badge at all.
    stubFetch({
      concepts: CONCEPTS.map((c) => ({ ...c, corpusCoverage: undefined })),
      candidates: THREE,
    });
    await renderAndSearch();
    expect(screen.queryByText("·rare")).toBeNull();
  });

  it("shows NO rail on the bespoke shape (empty concepts)", async () => {
    stubFetch({ concepts: [], candidates: BESPOKE });
    await renderAndSearch();
    expect(screen.queryByLabelText(/centrality/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Concepts" })).toBeNull();
    // And no stale Re-rank button — re-ranking is a render now, never an action.
    expect(screen.queryByRole("button", { name: /Re-rank/ })).toBeNull();
  });

  /**
   * The bespoke engine (whenever SPONSOR_MATCH_SPINE is off) ships concepts: [] and
   * contributions: [], carrying its real BM25 score in fusedScore. Re-ranking that by the
   * formula would zero every score — leaving the ORDER correct, so the list looks fine, while
   * every fit badge silently collapses to "Weak fit", top hit included.
   *
   * Note this fixture uses candidates with NO contributions, unlike THREE. The earlier version
   * of the bespoke test reused the spine fixture, which is why it could not catch this.
   */
  it("keeps the bespoke engine's own scores — the re-rank must not flatten every tier to weak", async () => {
    stubFetch({ concepts: [], candidates: BESPOKE });
    await renderAndSearch();

    expect(rowOrder()).toEqual(["Alice Alpha", "Bob Beta", "Cara Gamma"]);
    // Alice (0.91) is the top hit; Cara (0.06) is not. They must not read the same.
    expect(screen.getByText("Strong fit")).toBeTruthy();
    expect(screen.getAllByText("Weak fit")).toHaveLength(1);
  });

  // ── Facets ─────────────────────────────────────────────────────────────────
  // The facets are a checkbox PANEL now (the mockup's shape), not a row of toggle chips —
  // so they are queried by the `checkbox` role rather than `button`.
  it("department facet narrows rows and keeps the rank number from the full list", async () => {
    await renderAndSearch();
    fireEvent.click(screen.getByRole("checkbox", { name: /Surgery/ }));

    expect(screen.queryByText("Alice Alpha")).toBeNull();
    expect(screen.queryByText("Bob Beta")).toBeNull();
    const row = screen.getByText("Cara Gamma").closest("li")!;
    expect(row.textContent).toMatch(/^3/); // still #3 overall, not #1-of-filtered
    expect(screen.getByText(/1 of 3/)).toBeTruthy();
  });

  it("CTL-IP facet keeps only technology holders; Clear filters restores all", async () => {
    await renderAndSearch();
    fireEvent.click(screen.getByRole("checkbox", { name: /Holds CTL technology/ }));
    expect(screen.queryByText("Alice Alpha")).toBeNull();
    expect(screen.getByText("Bob Beta")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Alice Alpha")).toBeTruthy();
    expect(screen.getByText("Cara Gamma")).toBeTruthy();
  });

  it("concept facet matches rows that ranked under the selected concept", async () => {
    await renderAndSearch();
    // Facets count only concepts people actually MATCHED, so the CRISPR method — which no
    // candidate ranked under — gets no facet row even though it IS in the rail (where it still
    // has a slider, hence the `checkbox` role rather than a text query).
    expect(screen.queryByRole("checkbox", { name: /CRISPR screening/ })).toBeNull();
    expect(screen.getByLabelText("CRISPR screening centrality")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cancer Metabolism/ }));
    expect(screen.queryByText("Alice Alpha")).toBeNull();
    expect(screen.getByText("Cara Gamma")).toBeTruthy();
  });

  // ── Sort / export (the reskin) ─────────────────────────────────────────────
  it("sorts by Name without renumbering — the rank stays the FIT rank", async () => {
    await renderAndSearch();
    expect(rowOrder()).toEqual(["Alice Alpha", "Bob Beta", "Cara Gamma"]);

    fireEvent.click(screen.getByRole("button", { name: "Name" }));

    // Cara is #3 by fit but sorts first by surname… no — by given name she is last. Assert the
    // ranks travel with the people, which is the property that matters: a Name sort must not
    // claim the alphabetically-first person is the best match.
    const rows = screen.getAllByRole("listitem").filter((li) => li.textContent?.includes("fit"));
    const rankOf = (name: string) =>
      rows.find((r) => r.textContent?.includes(name))!.textContent!.match(/^\d+/)![0];
    expect(rankOf("Alice Alpha")).toBe("1");
    expect(rankOf("Bob Beta")).toBe("2");
    expect(rankOf("Cara Gamma")).toBe("3");
  });

  it("Fit is the default sort", async () => {
    await renderAndSearch();
    expect(screen.getByRole("button", { name: "Fit" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Name" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("exports the VISIBLE rows as CSV — no raw fused score in the file", async () => {
    // Capture at the Blob constructor: jsdom's Blob is a stub with no readable body, and the
    // CSV text is the thing under test anyway.
    const parts: string[] = [];
    const OrigBlob = globalThis.Blob;
    class CapturingBlob {
      constructor(bits: BlobPart[]) {
        parts.push(bits.map(String).join(""));
      }
    }
    globalThis.Blob = CapturingBlob as unknown as typeof Blob;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => "blob:stub") as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      await renderAndSearch();
      fireEvent.click(screen.getByRole("button", { name: /Export \(3\)/ }));

      expect(parts).toHaveLength(1);
      const csv = parts[0];
      expect(csv.split("\r\n")[0]).toBe(
        "Rank,CWID,Name,Title,Department,Fit,Matched concepts,Person type,Career stage,Clinician,CTL technologies,Profile URL",
      );
      expect(csv).toContain("Alice Alpha");
      expect(csv).toContain("Strong fit");
      // The fused score is withheld from the DOM; it must not leak into a spreadsheet either.
      expect(csv).not.toContain("0.91");
    } finally {
      globalThis.Blob = OrigBlob;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  // ── Career stage / Clinician facets (#1654) ────────────────────────────────
  it("renders no Career stage or Clinician facet when no candidate carries the measure", async () => {
    await renderAndSearch(); // THREE — no `measures`
    // Absent != zero. A filter that cannot filter, or one that reads as "nobody here is a
    // clinician" when the truth is "we don't know", is worse than no filter at all.
    expect(screen.queryByText("Career stage")).toBeNull();
    expect(screen.queryByText("Clinician")).toBeNull();
  });

  it("renders both facets once the measures are produced, and filters on them", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          fusedScore: 0.9,
          measures: { careerStage: "early", isClinician: true },
        }),
        candidate({
          cwid: "b",
          name: "Bob Beta",
          fusedScore: 0.5,
          measures: { careerStage: "senior", isClinician: false },
        }),
      ],
    });
    render(<SponsorMatchPanel />);
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // Both groups appear, in career-ladder order (not count order).
    expect(screen.getByText("Career stage")).toBeTruthy();
    expect(screen.getByText("Clinician")).toBeTruthy();

    // Filtering by stage keeps only the early-career candidate.
    fireEvent.click(screen.getByRole("checkbox", { name: /Early career/ }));
    expect(screen.getByText("Alice Alpha")).toBeTruthy();
    expect(screen.queryByText("Bob Beta")).toBeNull();

    // Clearing restores both; the clinician facet then narrows to the one clinician.
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Bob Beta")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Practicing clinician/ }));
    expect(screen.getByText("Alice Alpha")).toBeTruthy();
    expect(screen.queryByText("Bob Beta")).toBeNull();
  });

  // ── Person type facet (§2) ─────────────────────────────────────────────────
  it("renders no Person type facet when no candidate carries a role", async () => {
    await renderAndSearch(); // THREE — no `measures`
    // Same rule as the two facets above: a candidate with no Scholar row is ABSENT from the
    // facet, never bucketed into a made-up "unknown" person type.
    expect(screen.queryByText("Person type")).toBeNull();
  });

  it("renders the Person type facet with ED's labels, and filters on it", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          fusedScore: 0.9,
          measures: { roleCategory: "full_time_faculty" },
        }),
        candidate({
          cwid: "b",
          name: "Bob Beta",
          fusedScore: 0.5,
          measures: { roleCategory: "postdoc" },
        }),
        // No role at all — must survive the unfiltered view but be excluded by any selection.
        candidate({ cwid: "c", name: "Carol Gamma", fusedScore: 0.4, measures: {} }),
      ],
    });
    render(<SponsorMatchPanel />);
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    expect(screen.getByText("Person type")).toBeTruthy();
    // The raw ED code is never shown — `full_time_faculty` is not a label.
    expect(screen.queryByText(/full_time_faculty/)).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /Full-time faculty/ }));
    expect(screen.getByText("Alice Alpha")).toBeTruthy();
    expect(screen.queryByText("Bob Beta")).toBeNull();
    // The roleless candidate fails the filter — she cannot be SHOWN to satisfy it.
    expect(screen.queryByText("Carol Gamma")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Carol Gamma")).toBeTruthy();
  });

  // ── Paste read-back (§6a) ──────────────────────────────────────────────────
  it("marks the extracted terms in the paste, and says how many it could not point at", async () => {
    await renderAndSearch(); // searches for "CAR T"; CONCEPTS has 2 concepts
    // The readback quotes the text that was SEARCHED. None of the three concept terms occurs
    // in "CAR T collaborators", so nothing marks — and the panel must SAY so, rather than let
    // an unmarked paste read as "the matcher ignored all of this".
    expect(screen.getByText(/What we read from the description/)).toBeTruthy();
    expect(screen.getByText(/0 of 3 concepts are highlighted/)).toBeTruthy();
  });

  it("highlights a member phrasing and ties it back to its concept", async () => {
    stubFetch({
      concepts: CONCEPTS, // "Immuno-oncology" carries the member "immunotherapy"
      candidates: [candidate({ cwid: "a", name: "Alice Alpha", fusedScore: 0.9 })],
    });
    render(<SponsorMatchPanel />);
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: "We fund immunotherapy research." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    const mark = screen.getByText("immunotherapy", { selector: "mark" });
    expect(mark).toBeTruthy();
    // The mark points back at the CONCEPT, not at itself — that is the audit trail.
    expect(mark.getAttribute("title")).toBe("Immuno-oncology");
    expect(screen.getByText(/1 of 3 concepts are highlighted/)).toBeTruthy();
  });

  // ── Sponsor preferences (#1654) ────────────────────────────────────────────
  it("drops a deselected preference from the ask header, so it cannot contradict the ranking", async () => {
    // The header is DERIVED from the ACTIVE preferences, not frozen at submit. An officer who
    // unchecks an ask the extractor invented has said the sponsor never wanted it — a header
    // still announcing "· Early-career" over a ranking that no longer honours it is the panel
    // contradicting itself.
    stubFetch({
      concepts: CONCEPTS,
      candidates: [candidate({ cwid: "a", name: "Alice Alpha", fusedScore: 0.9 })],
      preferences: [
        {
          measure: "careerStage",
          stages: ["early"],
          label: "Early-career",
          evidence: "…support early-career investigators…",
          importance: 1,
        },
      ],
    });
    render(<SponsorMatchPanel />);
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    const header = () => document.querySelector('[data-slot="sponsor-match-ask"]')?.textContent;
    expect(header()).toContain("Early-career");

    fireEvent.click(screen.getByRole("checkbox", { name: /Early-career/ }));
    expect(header()).not.toContain("Early-career");
    // The topical half of the handle survives — only the honoured ask is gone.
    expect(header()).toContain("Immuno-oncology");
  });

  it("applies a detected preference to the ranking, and unchecking it re-ranks live", async () => {
    // Bob leads topically (rank 1 vs Alice's rank 2), but the sponsor asked for early-career
    // and Alice is early-career. At λ the nudge is enough to flip a margin this thin.
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "b",
          name: "Bob Beta",
          contributions: [{ term: "Immuno-oncology", rank: 1 }],
          measures: { careerStage: "senior", isClinician: false },
        }),
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          contributions: [{ term: "Immuno-oncology", rank: 2 }],
          measures: { careerStage: "early", isClinician: false },
        }),
      ],
      preferences: [
        {
          measure: "careerStage",
          stages: ["early"],
          label: "Early-career",
          evidence: "…support early-career investigators…",
          importance: 1,
        },
      ],
    });
    render(<SponsorMatchPanel />);
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // The chip shows, checked, with its provenance — an unexplained nudge is not auditable.
    const box = screen.getByRole("checkbox", { name: /Early-career/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/support early-career investigators/)).toBeTruthy();

    // Honoured by default: Alice (rank 2 + preference) leads Bob (rank 1, no preference).
    expect(rowOrder()).toEqual(["Alice Alpha", "Bob Beta"]);

    // Unchecking is the officer's override, and it re-ranks live — back to pure topical order.
    fireEvent.click(box);
    expect(rowOrder()).toEqual(["Bob Beta", "Alice Alpha"]);
  });

  it("renders no preference panel when the paste stated no non-topical ask", async () => {
    await renderAndSearch(); // no `preferences` in the response
    expect(screen.queryByText("Sponsor preferences")).toBeNull();
  });

  it("a candidate with NO measure is filtered OUT by a measure filter, never silently kept", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          fusedScore: 0.9,
          measures: { careerStage: "early", isClinician: true },
        }),
        // No `measures` at all — unknown stage, unknown clinician status.
        candidate({ cwid: "u", name: "Unknown Ursula", fusedScore: 0.8 }),
      ],
    });
    render(<SponsorMatchPanel />);
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Unknown Ursula");

    fireEvent.click(screen.getByRole("checkbox", { name: /Early career/ }));
    // Ursula might be early-career — but we have no evidence she is, so she cannot be
    // shown as satisfying the filter.
    expect(screen.queryByText("Unknown Ursula")).toBeNull();
    expect(screen.getByText("Alice Alpha")).toBeTruthy();
  });

  // ── Rows ───────────────────────────────────────────────────────────────────
  it("renders a fit tier relative to the top candidate, never the raw score", async () => {
    await renderAndSearch();
    // Bob is ~98% of Alice's score ⇒ both strong; Cara is ~19% ⇒ weak.
    expect(screen.getAllByText("Strong fit")).toHaveLength(2);
    expect(screen.getByText("Weak fit")).toBeTruthy();
    // The RRF sum is meaningless to a reader and must never be rendered.
    expect(screen.queryByText(/0\.044/)).toBeNull();
  });

  it("renders per-row paper evidence: PubMed link + relevance percentage", async () => {
    await renderAndSearch();
    const link = screen.getByRole("link", { name: "CAR T persistence" });
    expect(link.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/111/");
    expect(screen.getByText(/90% match/)).toBeTruthy();
  });

  // ── Retained searches (#6d) ────────────────────────────────────────────────
  it("lists retained searches from the SERVER, including a colleague's, and says they are kept", async () => {
    // Cross-officer visibility is the whole reason this replaced the localStorage history: the
    // private list could never tell you that someone else had already run this sponsor.
    stubFetch({
      concepts: CONCEPTS,
      candidates: THREE,
      submissions: [
        {
          id: "s1",
          description: "We fund cardiac fibrosis work.",
          title: "cardiac fibrosis",
          engine: "spine",
          candidateCount: 12,
          submittedBy: "zzz9001", // NOT the current officer
          createdAt: "2026-07-13T10:00:00.000Z",
        },
      ],
    });
    render(<SponsorMatchPanel />);
    expect(await screen.findByText(/Recent searches \(1\)/)).toBeTruthy();
    expect(screen.getByText("zzz9001")).toBeTruthy();
    expect(screen.getByText("cardiac fibrosis")).toBeTruthy();
    // The officer is TOLD, on the surface where it happens — not in a policy page.
    expect(screen.getByText(/Searches are saved/)).toBeTruthy();
    expect(screen.getByText(/improve match quality/)).toBeTruthy();
  });

  it("deletes a retained search and drops it from the list", async () => {
    const fetchMock = stubFetch({
      concepts: CONCEPTS,
      candidates: THREE,
      submissions: [
        {
          id: "s1",
          description: "We fund cardiac fibrosis work.",
          title: "cardiac fibrosis",
          engine: "spine",
          candidateCount: 12,
          submittedBy: "aaa1001",
          createdAt: "2026-07-13T10:00:00.000Z",
        },
      ],
    });
    render(<SponsorMatchPanel />);
    await screen.findByText(/Recent searches \(1\)/);

    fireEvent.click(screen.getByRole("button", { name: /Delete search: cardiac fibrosis/ }));
    await screen.findByText(/Recent searches \(0\)/).catch(() => null);

    // The row is gone from the list, and a DELETE actually went to the server — a client-only
    // hide would leave the sponsor's text sitting in the database.
    const deletes = fetchMock.mock.calls.filter(
      (c) => (c[1] as { method?: string } | undefined)?.method === "DELETE",
    );
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(String((deletes[0][1] as { body: string }).body))).toEqual({
      submissionId: "s1",
    });
    expect(screen.queryByText("cardiac fibrosis")).toBeNull();
  });
});
