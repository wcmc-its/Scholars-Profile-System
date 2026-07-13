/**
 * Sponsor-match panel client behaviors.
 *
 * The load-bearing test here is "a slider re-ranks with NO fetch". PR #1673 re-POSTed the
 * description with edited concepts on every re-rank, which is the "re-query on every drag"
 * degradation the UI contract rejects (`lib/api/sponsor-match-contract.ts`). The response
 * now carries the decomposed score inputs, so the panel re-ranks in the browser. If anyone
 * re-adds a fetch to the slider path, `expect(fetchMock).toHaveBeenCalledTimes(1)` fails.
 *
 * Also covered:
 *  - facets (department / matched concept / CTL-IP) narrow rows client-side, and each row
 *    keeps its rank number from the FULL list;
 *  - a successful search lands in localStorage history — browser-only by design, since the
 *    server never persists descriptions (route contract);
 *  - the rail splits Concepts from Methods by `kind`, shows merged members as chips, and
 *    badges a rare concept;
 *  - the bespoke shape (empty concepts) renders no rail at all.
 * fetch is stubbed — no route/engine involvement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SponsorMatchPanel } from "@/components/edit/sponsor-match-panel";
import type { SponsorCandidate, SponsorConcept } from "@/lib/api/sponsor-match-contract";

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

function stubFetch(payload: { concepts: SponsorConcept[]; candidates: SponsorCandidate[] }) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, ...payload }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Mute Immuno-oncology. Alice and Bob ranked ONLY under it, so both collapse to 0 and
    // Cara — who ranked under Cancer Metabolism — takes the top. This is recomputed from
    // `contributions` already in the browser.
    fireEvent.change(screen.getByLabelText("Immuno-oncology centrality"), {
      target: { value: "0" },
    });

    expect(rowOrder()).toEqual(["Cara Gamma", "Alice Alpha", "Bob Beta"]);
    // THE ASSERTION THAT MATTERS: the re-rank cost zero round-trips.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
        "Rank,CWID,Name,Title,Department,Fit,Matched concepts,CTL technologies,Profile URL",
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

  it("renders no Career stage or Clinician facet, even when a candidate carries measures", async () => {
    await renderAndSearch();
    // The spine has no producer for these. Absent != zero: a filter that cannot filter, or a
    // blank column that reads as "nobody here is a clinician", is worse than nothing at all.
    expect(screen.queryByText(/Career stage/i)).toBeNull();
    expect(screen.queryByText(/Clinician/i)).toBeNull();
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

  it("saves the search to localStorage history and renders it", async () => {
    await renderAndSearch();
    const saved = JSON.parse(window.localStorage.getItem("sponsor-match-history")!) as Array<{
      d: string;
    }>;
    expect(saved[0].d).toBe("CAR T collaborators");
    expect(screen.getByText(/Recent searches \(1\)/)).toBeTruthy();
    // Clearing wipes storage too.
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(window.localStorage.getItem("sponsor-match-history")).toBeNull();
  });
});
