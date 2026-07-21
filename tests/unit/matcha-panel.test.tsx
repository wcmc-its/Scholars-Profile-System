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
 *  - the rail splits Concepts from Methods by `kind`, surfaces merged members behind each concept's
 *    provenance ⓘ, and badges a rare concept;
 *  - the bespoke shape (empty concepts) renders no rail at all.
 * fetch is stubbed — no route/engine involvement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MatchaPanel } from "@/components/edit/matcha-panel";
import { conceptWeight } from "@/lib/api/matcha-contract";
import type {
  CulledConcept,
  MatchaCandidate,
  MatchaConcept,
  MatchaPreference,
  MatchaSearchEvidence,
} from "@/lib/api/matcha-contract";

// K = 60. Scores below are the RRF sums the server would have sent; the panel recomputes
// them from `contributions` × `concepts`, so they only have to be self-consistent.
const CONCEPTS: MatchaConcept[] = [
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

function candidate(over: Partial<MatchaCandidate> & { cwid: string }): MatchaCandidate {
  return {
    name: "X",
    profileSlug: `slug-${over.cwid}`,
    title: "Professor",
    department: "Medicine",
    fusedScore: 0,
    contributions: [],
    technologyCount: 0,
    // A default research-match block so a fixture candidate is a RESULT (the common case) and is
    // not dropped by the zero-evidence exclusion. Its term is deliberately one no concept in these
    // fixtures uses, so it satisfies `hasMatchEvidence` WITHOUT joining to a concept — the coverage
    // strip and evidence blocks render exactly as before. Tests exercising the exclusion or the
    // coverage states override `searchEvidence` explicitly.
    searchEvidence: [
      {
        term: "__match__",
        evidence: { kind: "publications", strength: "tagged", text: "1 of 10 tagged", count: 1 },
        pubCount: 10,
        keyPaper: { descriptorUis: ["D_x"], contentQuery: "__match__" },
      },
    ],
    ...over,
  };
}

// In fused order, as the server ships them.
const THREE: MatchaCandidate[] = [
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

/**
 * A pool BIGGER than the render cap (RESULT_MAX = 100), with the only CTL-technology holder
 * buried at rank 105 — below the cap, inside the pool. A staging run ranked 430 candidates; the
 * fixtures here ranked 3, which is exactly why the cap could sit inside `ranked` (making every
 * facet count and every filter search only the top 100) with a green suite over it.
 *
 * Ranks drive the ordering, not `fusedScore`: the panel re-ranks from `contributions` and
 * `concepts` in the browser (that is the whole contract), so `fusedScore` only feeds the tier.
 */
const POOL: MatchaCandidate[] = Array.from({ length: 120 }, (_, i) => {
  const rank = i + 1;
  const deep = rank === 105;
  return candidate({
    cwid: deep ? "deep" : `p${rank}`,
    name: deep ? "Zed Deepcut" : `Person ${String(rank).padStart(3, "0")}`,
    department: deep ? "Pathology" : "Medicine",
    technologyCount: deep ? 1 : 0,
    fusedScore: (0.9 ** 3 * 3.0) / (60 + rank),
    contributions: [{ term: "Immuno-oncology", rank }],
  });
});

/** Exactly what the route's `bespokeToCandidate` emits: a real score, and NO contributions
 *  (that engine does no concept decomposition, so there is nothing to re-rank by). */
const BESPOKE: MatchaCandidate[] = [
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
  concepts: MatchaConcept[];
  candidates: MatchaCandidate[];
  preferences?: MatchaPreference[];
  /** #1780 Phase 2 — the culled tail, for the click-to-include chips. */
  culled?: CulledConcept[];
  submissions?: Submission[];
  /** §9 — the SERVER's verdict on whose searches this list holds. Defaults to `"own"`, which is
   *  what every non-superuser gets and therefore the right default for a fixture. `"omit"` sends
   *  a payload with NO `scope` key at all — an explicit sentinel, because `undefined` cannot
   *  express that here: it is indistinguishable from "not set" and would silently take the
   *  default, turning the fail-closed test into theatre that passes on any implementation. */
  scope?: "all" | "own" | "omit";
}) {
  const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          submissions: payload.submissions ?? [],
          ...(payload.scope === "omit" ? {} : { scope: payload.scope ?? "own" }),
        }),
      };
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
  /** §10 — the resolved label the route ships (name, else cwid). The raw cwid is not on the
   *  wire; mirror the route's shape here or the fixture stops being a fixture. */
  submittedByName: string;
  createdAt: string;
};

async function renderAndSearch() {
  render(<MatchaPanel />);
  fireEvent.change(screen.getByLabelText(/the ask/i), {
    target: { value: "CAR T collaborators" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
  await screen.findByText("Alice Alpha");
}

/**
 * Read a `HoverTooltip`'s text — the panel's ONLY hover mechanism since round-2 §1 swept the last
 * native `title=` out of it.
 *
 * Why focus and not hover: the pill is portaled and is only in the DOM while OPEN, and Radix opens
 * on focus IMMEDIATELY (the 200ms delay is mouse-enter only), so focus needs no timers. The event
 * goes to `el.parentElement` because that is the wrapper span `HoverTooltip` puts around its child
 * — the wrapper is the Radix trigger, not the element you passed in.
 *
 * Radix renders the content twice: the visible pill, and a `VisuallyHidden` copy carrying
 * `role="tooltip"` for AT. This reads the latter — one element, whole text, no duplicate matches.
 */
async function tooltipTextOf(el: Element): Promise<string> {
  fireEvent.focus(el.parentElement as HTMLElement);
  const tip = await screen.findByRole("tooltip");
  return tip.textContent ?? "";
}

async function renderAndSearchPool() {
  stubFetch({ concepts: CONCEPTS, candidates: POOL });
  render(<MatchaPanel />);
  fireEvent.change(screen.getByLabelText(/the ask/i), {
    target: { value: "CAR T collaborators" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
  await screen.findByText("Person 001");
}

/** Names of the result rows, in RENDERED (DOM) order — each row links to a profile, so the
 *  profile links in document order are the ranking the user actually sees. Expands the relevance
 *  floor first (weak-tier rows collapse behind a "Show" toggle), so an order assertion sees the
 *  WHOLE ranking, not just the head above the floor. Idempotent: the toggle reads "Hide ↑" once
 *  open, so a second call finds no "Show ↓" and does not re-collapse it. */
function rowOrder(): string[] {
  const show = screen.queryByRole("button", { name: /Show ↓/ });
  if (show) fireEvent.click(show);
  return screen
    .getAllByRole("link")
    .filter((a) => a.getAttribute("href")?.startsWith("/slug-"))
    .map((a) => a.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
  // Compact is the APP's default density since the warm-palette redesign, but almost every test here
  // exercises the DETAILED card (evidence blocks, full tier labels, profile links). Pin detailed for
  // the suite so those assertions read what they were written against; the compact-default first-visit
  // behaviour is asserted on its own in "the shortlist is reachable in the default density", which
  // clears this key before rendering.
  window.localStorage.setItem("sponsor-match-density", "detailed");
  stubFetch({ concepts: CONCEPTS, candidates: THREE });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MatchaPanel", () => {
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

  it("shows merged member forms as chips behind the provenance ⓘ", async () => {
    await renderAndSearch();
    // "immunotherapy" merged into the Immuno-oncology cluster — one slider, not two. Since the
    // warm-palette redesign the merged forms live behind the concept's provenance ⓘ hover.
    const info = screen.getByLabelText(/Where .*Immuno-oncology.* came from/);
    // The ⓘ must be keyboard-reachable: it now carries provenance that used to be always-visible DOM,
    // so a non-focusable trigger would hide it from keyboard/SR users (opens on hover only).
    expect(info.getAttribute("tabindex")).toBe("0");
    const tip = await tooltipTextOf(info);
    expect(tip).toContain("immunotherapy");
    expect(tip).toContain("merged forms");
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
    const tip = await tooltipTextOf(badges[0]);
    expect(tip).toMatch(/about 1 in 20,000 Weill Cornell papers/);
    expect(tip).not.toMatch(/counts for more/);
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

  it("shows the funder's gloss behind the concept's provenance ⓘ ('From the ask')", async () => {
    stubFetch({
      concepts: [
        { ...CONCEPTS[0], gloss: "lysosomal processing of ADC linkers" },
        CONCEPTS[1], // no gloss ⇒ its ⓘ shows a plain provenance line instead
        CONCEPTS[2],
      ],
      candidates: THREE,
    });
    await renderAndSearch();
    const info = screen.getByLabelText(/Where .*Immuno-oncology.* came from/);
    const tip = await tooltipTextOf(info);
    expect(tip).toContain("lysosomal processing of ADC linkers");
    expect(tip).toContain("From the ask");
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
   * The bespoke engine (whenever MATCHA_SPINE is off) ships concepts: [] and
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
    // Three numbers, three meanings: 1 painted, 1 matched, 3 in the pool. The old header said
    // "1 of 3" and meant painted-of-POOL, which collapses to the same string as painted-of-
    // MATCHED and is what let the top-100 cap hide (see `resultsSummary`).
    expect(screen.getByText(/1 matching · 3 ranked/)).toBeTruthy();
  });

  it("CTL-IP facet keeps only technology holders; Clear filters restores all", async () => {
    await renderAndSearch();
    fireEvent.click(screen.getByRole("checkbox", { name: /Holds CTL technology/ }));
    expect(screen.queryByText("Alice Alpha")).toBeNull();
    expect(screen.getByText("Bob Beta")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    // Restored: all three are back. `rowOrder` expands the floor, so weak-tier Cara — who now sits
    // below the relevance floor with no filter narrowing to her — is counted too.
    expect(rowOrder()).toEqual(["Alice Alpha", "Bob Beta", "Cara Gamma"]);
  });

  // ── The cap is a RENDER cap (the top-100 bug) ──────────────────────────────
  // Every test above this line runs on a 3-candidate pool, which is why the old
  // `.slice(0, RESULT_MAX)` inside `ranked` was a no-op in all of them: the whole suite was
  // green while every facet and every filter saw only the first 100 of a pool that runs to
  // ~800. These three run on a pool of 120 with the only CTL holder buried at rank 105 —
  // put the slice back into `ranked` and all three fail.
  it("the CTL facet counts the WHOLE pool, and can surface a holder below the render cap", async () => {
    await renderAndSearchPool();

    // 9-of-the-top-100 was the bug on staging. The holder is at 105; the count must see him.
    const ctl = screen.getByRole("checkbox", { name: /Holds CTL technology/ });
    expect(ctl.closest("label")!.textContent).toMatch(/1\s*$/);

    fireEvent.click(ctl);
    const row = screen.getByText("Zed Deepcut").closest("li")!;
    expect(row.textContent).toMatch(/^105/); // his POOL rank, not "#1 of the filtered one"
    expect(screen.queryByText("Person 001")).toBeNull();
  });

  it("paints at most RESULT_MAX rows, and says so without claiming a filter did it", async () => {
    await renderAndSearchPool();

    expect(rowOrder()).toHaveLength(100); // the cap still bounds what we mount
    expect(rowOrder()[0]).toBe("Person 001");
    // NOT "100 of 120 researchers" — nothing was filtered out; 20 were simply not painted.
    expect(screen.getByText(/Top 100 of 120 researchers/)).toBeTruthy();
  });

  it("exports every row the filters matched, not just the hundred on screen", async () => {
    await renderAndSearchPool();

    // The officer sees 100 rows and downloads 120 — the cap must not silently truncate a
    // portfolio download. With the CTL filter on, the export narrows to the real match count.
    expect(screen.getByRole("button", { name: /Export \(120\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Holds CTL technology/ }));
    expect(screen.getByRole("button", { name: /Export \(1\)/ })).toBeTruthy();
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

  /**
   * "Name" means BY SURNAME. It used to compare `name`, i.e. the display string, i.e. by FIRST
   * name — and every fixture in this file was named so that the two orders agree, which is exactly
   * why the sort test above could not see it.
   *
   * These names invert: by given name it is Alice / Bob / Zoe; by surname it is Abbott, Abbott,
   * Zephyr — so the two orderings share no position and the old comparator cannot produce this
   * expectation. Bob and Zoe share a surname, which pins the tie-break onto the full name rather
   * than onto whatever order the ranker happened to fuse them in.
   */
  it("sorts by SURNAME, not by the first name in the display string", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "z",
          name: "Alice Zephyr",
          lastNameSort: "zephyr",
          fusedScore: (0.9 * 3.0) / 61,
          contributions: [{ term: "Immuno-oncology", rank: 1 }],
        }),
        candidate({
          cwid: "a2",
          name: "Zoe Abbott",
          lastNameSort: "abbott",
          fusedScore: (0.9 * 3.0) / 62,
          contributions: [{ term: "Immuno-oncology", rank: 2 }],
        }),
        candidate({
          cwid: "a1",
          name: "Bob Abbott",
          lastNameSort: "abbott",
          fusedScore: (0.9 * 3.0) / 63,
          contributions: [{ term: "Immuno-oncology", rank: 3 }],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Zephyr");

    expect(rowOrder()).toEqual(["Alice Zephyr", "Zoe Abbott", "Bob Abbott"]); // fit order

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    // Surnames first, given name only to break the Abbott tie. Under the old comparator this
    // would read ["Alice Zephyr", "Bob Abbott", "Zoe Abbott"].
    expect(rowOrder()).toEqual(["Bob Abbott", "Zoe Abbott", "Alice Zephyr"]);
  });

  /**
   * A doc that predates the ETL field is re-keyed with the ETL's OWN `extractLastNameSort`, so it
   * takes its true alphabetical place rather than being sorted as "" (top of the list, reads as an
   * outage) or by its display name (a SECOND comparator over the same list — see below).
   *
   * ⚠ THIS FIXTURE IS THE TEST. Three rows, ONE unkeyed, and the unkeyed surname ("unindexed")
   * must land BETWEEN the two keyed ones — so the row order is wrong under every comparator except
   * a total one. A keyed-vs-unkeyed split admits a 3-cycle here (abbott<zephyr, but
   * "Alice Zephyr"<"Bob Unindexed"<"Zoe Abbott"), which sorts Zephyr AHEAD of Abbott: one unkeyed
   * row inverting two KEYED rows. A 2-row pool cannot express that and is why the earlier version
   * of this test passed under the old comparator — it proved nothing.
   */
  it("re-keys an unindexed row so it cannot invert two keyed rows", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Zoe Abbott",
          lastNameSort: "abbott",
          fusedScore: (0.9 * 3.0) / 61,
          contributions: [{ term: "Immuno-oncology", rank: 1 }],
        }),
        candidate({
          cwid: "u",
          name: "Bob Unindexed", // no `lastNameSort` — not yet reindexed
          fusedScore: (0.9 * 3.0) / 62,
          contributions: [{ term: "Immuno-oncology", rank: 2 }],
        }),
        candidate({
          cwid: "z",
          name: "Alice Zephyr",
          lastNameSort: "zephyr",
          fusedScore: (0.9 * 3.0) / 63,
          contributions: [{ term: "Immuno-oncology", rank: 3 }],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Zoe Abbott");

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    // abbott < unindexed < zephyr. The keyed pair keeps its order and the unkeyed row slots in.
    expect(rowOrder()).toEqual(["Zoe Abbott", "Bob Unindexed", "Alice Zephyr"]);
  });

  /**
   * `extractLastNameSort` returns "" — NOT null — for a blank name, so an emptiness guard of
   * `!= null` lets "" through as a live key that sorts ahead of every real surname. This is the
   * regression that shipped once already behind a comment claiming the opposite.
   */
  it("does not herd a blank surname key to the top of the alphabet", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "b",
          name: "Wanda Blank",
          lastNameSort: "", // the ETL's value for an unusable preferredName
          fusedScore: (0.9 * 3.0) / 61,
          contributions: [{ term: "Immuno-oncology", rank: 1 }],
        }),
        candidate({
          cwid: "a",
          name: "Zoe Abbott",
          lastNameSort: "abbott",
          fusedScore: (0.9 * 3.0) / 62,
          contributions: [{ term: "Immuno-oncology", rank: 2 }],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Zoe Abbott");

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    // "" is re-derived to "blank" from the display name, so Abbott still leads. Under a `!= null`
    // guard the blank row would sort first purely for being blank.
    expect(rowOrder()).toEqual(["Zoe Abbott", "Wanda Blank"]);
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
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
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
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
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
    // The read-only ask quotes the text that was SEARCHED. None of the three concept terms occurs
    // in "CAR T collaborators", so nothing marks — and the panel must SAY so, rather than let
    // an unmarked paste read as "the matcher ignored all of this".
    expect(screen.getByText(/What we read from the ask/)).toBeTruthy();
    expect(screen.getByText(/0 of 3 concepts are highlighted/)).toBeTruthy();
  });

  it("highlights a member phrasing and ties it back to its concept", async () => {
    stubFetch({
      concepts: CONCEPTS, // "Immuno-oncology" carries the member "immunotherapy"
      candidates: [candidate({ cwid: "a", name: "Alice Alpha", fusedScore: 0.9 })],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), {
      target: { value: "We fund immunotherapy research." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    const mark = screen.getByText("immunotherapy", { selector: "mark" });
    expect(mark).toBeTruthy();
    // The mark points back at the CONCEPT, not at itself — that is the audit trail.
    expect(await tooltipTextOf(mark)).toBe("Immuno-oncology");
    expect(screen.getByText(/1 of 3 concepts are highlighted/)).toBeTruthy();
  });

  it("replaces the textarea with a read-only ask once a search commits, and Edit paste brings it back", async () => {
    await renderAndSearch(); // pastes "CAR T collaborators"
    // The committed search is now the read-only ask — the textarea is gone, Re-run is offered.
    expect(screen.queryByLabelText(/description/i)).toBeNull();
    expect(screen.getByText(/What we read from the ask/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-run match" })).toBeTruthy();

    // Edit paste restores the textarea, pre-filled with the text that was searched.
    fireEvent.click(screen.getByRole("button", { name: "Edit paste" }));
    const paste = screen.getByLabelText(/the ask/i) as HTMLTextAreaElement;
    expect(paste.value).toBe("CAR T collaborators");
    expect(screen.getByRole("button", { name: "Rank researchers" })).toBeTruthy();
  });

  // ── Evidence, via the SEARCH's own renderer (#1689/#1696) ───────────────────
  /**
   * The rendered evidence blocks, in DOM order: `[concept caption, reason line]` each.
   *
   * Queried by `data-slot` and not by text, because a concept's term legitimately appears four
   * times on the page (the rail slider, the facet, the row's chip, and this caption) — a text
   * query cannot tell which one it found, and would pass on a card that rendered no block at all.
   */
  function evidenceBlocks(): [string, string][] {
    return [...document.querySelectorAll('[data-slot="matcha-evidence"]')].map((el) => {
      const caption = el.firstElementChild!;
      // The caption is `[[concept][provenance chip]] [ask N.NN]` — the concept + its chip share a
      // wrapper on the left, the ask sits on the right. Take the concept span (the wrapper's first
      // child), so these assertions keep saying what they were written to say. The ask is asserted
      // on its own below, and the chip via `document.body.textContent`.
      const term = caption.firstElementChild?.firstElementChild?.textContent ?? "";
      const line = (el.textContent ?? "").slice((caption.textContent ?? "").length);
      return [term, line.replace(/\s+/g, " ").trim()];
    });
  }

  /** The `ask N.NN` each block reports, in DOM order. */
  function evidenceAsks(): string[] {
    return [...document.querySelectorAll('[data-slot="matcha-evidence"]')].map(
      (el) => el.firstElementChild?.lastElementChild?.textContent ?? "",
    );
  }

  /** The spine's per-concept evidence, in the shape the wire carries it (#1696). */
  function searchEvidence(term: string, count: number): MatchaSearchEvidence {
    return {
      term,
      evidence: {
        kind: "publications",
        strength: "tagged",
        text: `${count} of 210 publications tagged`,
        term: `MeSH:${term}`, // the DESCRIPTOR name — often not the sponsor's word for it
        count,
      },
      pubCount: 210,
      keyPaper: {
        descriptorUis: [`D-${term}`],
        contentQuery: term.toLowerCase(),
        conceptLabel: `MeSH:${term}`,
      },
    };
  }

  it("renders the spine's evidence with the public search's EvidenceLine", async () => {
    // The console's "why this match" block was EMPTY in prod: the panel read `evidence`
    // (bespoke-only) while the spine — the prod default — produced none. It now carries the
    // search's own ResultEvidence, rendered by the search's own component, so the two surfaces
    // cannot tell an officer two different stories about the same scholar.
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          fusedScore: 0.9,
          contributions: [{ term: "Immuno-oncology", rank: 1 }],
          searchEvidence: [searchEvidence("Immuno-oncology", 142)],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // The real reason line, with the real counts — not an empty disclosure. The count and the
    // term are rendered as separate spans by the search's renderer (count-first emphasis), so
    // assert on the assembled text of the line rather than on one node.
    const line = screen
      .getAllByText((_t, el) => /142 of 210 publications tagged/.test(el?.textContent ?? ""))
      .pop();
    expect(line).toBeTruthy();
    expect(line!.textContent).toContain("MeSH:Immuno-oncology");
  });

  it("renders ONE block per matched concept, captioned with the concept it answers for", async () => {
    // #1696 — the spine already fetched a reason for every concept the candidate ranked under;
    // only the best one used to survive. Alice matched two, so she gets two blocks — and each
    // is captioned with the SLIDER's term, because the reason line names the MeSH descriptor
    // ("MeSH:…"), which is routinely not the sponsor's word for the concept.
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          contributions: [
            { term: "Immuno-oncology", rank: 2 },
            { term: "Cancer Metabolism", rank: 1 },
          ],
          searchEvidence: [
            searchEvidence("Cancer Metabolism", 30), // best RANK — the wire order
            searchEvidence("Immuno-oncology", 142),
          ],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    const blocks = evidenceBlocks();
    // TWO blocks — the second is the whole issue: it was fetched, then discarded.
    // Blocks follow the LIVE weighting, like the chips: Immuno-oncology (centrality .9 ×
    // weightFactor 3, rank 2) contributes more than Cancer Metabolism (.5 × 1, rank 1), so it
    // leads — even though the wire shipped Metabolism first on rank.
    expect(blocks.map(([caption]) => caption)).toEqual(["Immuno-oncology", "Cancer Metabolism"]);
    // And each caption sits over ITS OWN reason. A join that crossed the two would still render
    // two blocks and two counts, and be wrong about both.
    expect(blocks[0][1]).toContain("142 of 210 publications tagged");
    expect(blocks[1][1]).toContain("30 of 210 publications tagged");
  });

  it("names a ranked-but-unevidenced concept so reweighting is legible (#1780)", async () => {
    // The Safford case (staging 2026-07-17): a scholar ranks under a concept via a keyword/capped
    // hit that ships no evidence block. The card must NAME that concept — otherwise the driver is
    // invisible (an unlabeled strip segment) and an officer sees a #1 with no reason to zero.
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          // Ranks under Immuno-oncology but ships NO searchEvidence for it (only the default
          // __match__, which joins to no concept) ⇒ conceptCoverage state "ranked".
          contributions: [{ term: "Immuno-oncology", rank: 1 }],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    const line = document.querySelector('[data-slot="matcha-ranked-no-evidence"]');
    expect(line).toBeTruthy();
    expect(line!.textContent).toContain("Immuno-oncology");
    // Named, but NOT as an evidence block — it must not masquerade as shown evidence.
    expect(evidenceBlocks().map(([caption]) => caption)).not.toContain("Immuno-oncology");
  });

  it("does not repeat an evidenced concept in the ranked-no-evidence line", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          contributions: [{ term: "Immuno-oncology", rank: 1 }],
          searchEvidence: [searchEvidence("Immuno-oncology", 142)],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // Immuno-oncology is evidenced ⇒ it renders as a block; the ranked-no-evidence line does not
    // exist for it (no OTHER concept is ranked-without-evidence here).
    const line = document.querySelector('[data-slot="matcha-ranked-no-evidence"]');
    expect(line?.textContent ?? "").not.toContain("Immuno-oncology");
    expect(evidenceBlocks().map(([caption]) => caption)).toContain("Immuno-oncology");
  });

  it("drops a muted concept's evidence block along with its chip", async () => {
    // Slide a concept to zero and it stops being a reason this person ranked. A block still
    // captioned with it would have the card contradicting the ranking beside it.
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          contributions: [
            { term: "Immuno-oncology", rank: 2 },
            { term: "Cancer Metabolism", rank: 1 },
          ],
          searchEvidence: [
            searchEvidence("Cancer Metabolism", 30),
            searchEvidence("Immuno-oncology", 142),
          ],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");
    expect(evidenceBlocks().map(([caption]) => caption)).toEqual([
      "Immuno-oncology",
      "Cancer Metabolism",
    ]);

    fireEvent.change(screen.getByLabelText("Immuno-oncology centrality"), {
      target: { value: "0" },
    });

    // The muted concept's block is gone — and the concept she still ranks under survives, so
    // muting one does not blank the card.
    expect(evidenceBlocks().map(([caption]) => caption)).toEqual(["Cancer Metabolism"]);
    expect(document.body.textContent).not.toContain("142 of 210 publications tagged");
    expect(document.body.textContent).toContain("30 of 210 publications tagged");
  });

  it("renders no block for a concept the spine gave no evidence for", async () => {
    // Absent ≠ an empty block. The candidate ranked under both concepts (both chips show), but
    // only one produced a tagged count — the other resolved to no MeSH descriptor, so there is
    // nothing to count and nothing to say. Say nothing.
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          contributions: [
            { term: "Immuno-oncology", rank: 1 },
            { term: "Cancer Metabolism", rank: 2 },
          ],
          searchEvidence: [searchEvidence("Immuno-oncology", 142)],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // Exactly one block — not two, and certainly not one padded with a zero count.
    expect(evidenceBlocks()).toHaveLength(1);
    expect(evidenceBlocks()[0][0]).toBe("Immuno-oncology");
    expect(evidenceBlocks()[0][1]).toContain("142 of 210 publications tagged");
    // The chip for the evidence-less concept still shows: she DID rank under it. Only the
    // claim about WHY is withheld, because there is none to make.
    expect(screen.getAllByText("Cancer Metabolism").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("0 of 210");
  });

  it("renders no evidence line when the candidate carries none", async () => {
    await renderAndSearch(); // THREE — no `searchEvidence`
    // Absent is not zero: an empty disclosure reads as "this match has no evidence", which is
    // a claim we never made. Render nothing instead.
    expect(screen.queryByText(/publications tagged/)).toBeNull();
  });

  /**
   * A fetch stub whose key-paper endpoint always resolves the SAME pmid (111), so a stale claim
   * is visible as an `exclude=111` on a later URL. Ranking POSTs return Alice with `over`'s
   * contributions/evidence.
   */
  function stubWithKeyPaper(over: Partial<MatchaCandidate>) {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (typeof url === "string" && url.startsWith("/api/search/key-paper")) {
        // HONOR `exclude`, as the real route does. A stub that returns pmid 111 no matter what
        // cannot observe the de-dup at all — both blocks would render the same paper and the test
        // would pass against a build in which the de-dup had been deleted.
        const excluded = new URLSearchParams(url.split("?")[1] ?? "").get("exclude") ?? "";
        return {
          ok: true,
          json: async () =>
            excluded.includes("111")
              ? { pubs: [{ pmid: "222", title: "Metabolic rewiring", year: 2023 }] }
              : { pubs: [{ pmid: "111", title: "CAR T persistence", year: 2024 }] },
        };
      }
      const method = init?.method ?? "GET";
      if (method === "GET") return { ok: true, json: async () => ({ ok: true, submissions: [] }) };
      return {
        ok: true,
        json: async () => ({
          ok: true,
          concepts: CONCEPTS,
          candidates: [
            candidate({ cwid: "a", name: "Alice Alpha", fusedScore: 0.9, ...over }),
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const keyPaperCalls = () =>
      fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/search/key-paper"));
    return { fetchMock, keyPaperCalls };
  }

  it("an unmuted concept's block re-fetches CLEAN — it never excludes its OWN paper (#1696)", async () => {
    // THE claimedPmids LIFETIME BUG, and it is REPRODUCIBLE — this test fails against the
    // `useMemo(() => new Set(), [])` it replaces.
    //
    // `claimedPmids` de-dups representative papers across a card's blocks: whoever's lazy
    // `/api/search/key-paper` fetch resolves first claims the paper, and the others send it as
    // `exclude=` so they surface a DIFFERENT one. But `EvidenceLine` only ever ADDS to that set —
    // it has no release-on-unmount — so a claim OUTLIVES the block that made it.
    //
    // Mute a concept: its block unmounts, pmid still claimed. Unmute it: the block remounts, and
    // because it is a fresh line its one-shot `keyPaperFetched` guard is clean, so it fetches
    // again — and excludes the very paper it displayed thirty seconds ago. The officer watches
    // the disclosure come back with a worse paper, or with NOTHING (the chevron then vanishes)
    // while the count line beside it still reads "142 of 210 publications tagged".
    //
    // Note this path has NO loading state — a slider is not a fetch — so unlike a re-run it is
    // not saved by the results tree unmounting. It is the case that actually fires.
    const { keyPaperCalls } = stubWithKeyPaper({
      contributions: [
        { term: "Immuno-oncology", rank: 1 },
        { term: "Cancer Metabolism", rank: 1 },
      ],
      searchEvidence: [
        searchEvidence("Immuno-oncology", 142),
        searchEvidence("Cancer Metabolism", 30),
      ],
    });

    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // The blocks now resolve WITHOUT a click (the card leads with the artifact), and they resolve
    // IN ORDER — which is the only reason the de-dup below still holds. Fired in one commit they
    // would both read an empty claimed set and both show pmid 111.
    await waitFor(() => expect(keyPaperCalls()).toHaveLength(2));
    expect(keyPaperCalls()[0]).not.toContain("exclude"); // first block: nothing claimed yet
    expect(keyPaperCalls()[1]).toContain("exclude=111"); // second block: EXCLUDES the claim
    // …and therefore the two concepts lead with DIFFERENT papers. This is the assertion that
    // fails if the blocks auto-resolve in one commit instead of in order.
    await screen.findByText(/CAR T persistence/);
    await screen.findByText(/Metabolic rewiring/);

    // Mute it — the block unmounts, and its claim on 111 would outlive it.
    fireEvent.change(screen.getByLabelText("Immuno-oncology centrality"), {
      target: { value: "0" },
    });
    expect(evidenceBlocks().map(([caption]) => caption)).toEqual(["Cancer Metabolism"]);

    // Unmute — the block comes back and re-fetches, on its own.
    fireEvent.change(screen.getByLabelText("Immuno-oncology centrality"), {
      target: { value: "0.9" },
    });
    await waitFor(() => expect(keyPaperCalls()).toHaveLength(3));

    // AND IT FETCHES CLEAN. With the set memoised on `[]` this URL carried `exclude=111` — the
    // block suppressing the one paper it had just told the officer was Alice's best.
    expect(keyPaperCalls()[2]).not.toContain("exclude");
    expect(keyPaperCalls()[2]).toContain("cwid=a");
    // And the paper is actually back on screen, not silently dropped.
    await screen.findByText(/CAR T persistence/);
  });

  it("a slider drag that does NOT mute keeps the claimed set — no gratuitous re-fetch", async () => {
    // The other side of the reset, and the reason the key is the BLOCK LIST rather than the
    // concepts' values. Dragging centrality 0.9 → 0.5 re-ranks and re-renders every row, but it
    // does not change WHICH concepts matched — so the block list is unchanged, the set survives,
    // and the lines must not re-fetch papers they have already claimed. A set minted on every
    // render (the naive "fix") would re-fetch the whole visible list on every drag frame.
    const { keyPaperCalls } = stubWithKeyPaper({
      contributions: [{ term: "Immuno-oncology", rank: 1 }],
      searchEvidence: [searchEvidence("Immuno-oncology", 142)],
    });

    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    await waitFor(() => expect(keyPaperCalls()).toHaveLength(1));

    // Drag, but not to zero — the concept still matches, so its block stays.
    fireEvent.change(screen.getByLabelText("Immuno-oncology centrality"), {
      target: { value: "0.5" },
    });
    expect(evidenceBlocks().map(([caption]) => caption)).toEqual(["Immuno-oncology"]);
    // No remount, no re-fetch: still exactly the one call. Note this is the assertion that would
    // catch an `autoResolve` wired to something that changes on every drag frame — it would
    // re-fetch the whole visible list on every pixel of slider travel.
    expect(keyPaperCalls()).toHaveLength(1);
  });

  it("a fresh ranking run starts every row's claimed set empty (#1696)", async () => {
    // An INVARIANT GUARD, and — unlike the mute/unmute test above — it does NOT discriminate the
    // `runId` key today, because the panel already swaps the whole results tree for skeletons
    // while `status.kind === "loading"`. That unmounts these rows between runs and rebuilds the
    // set regardless of how it is keyed. Verified, not assumed: with the pre-fix `[]` deps AND
    // the pre-fix `key={concept.term}` both restored, this test still passed.
    //
    // It is kept because that unmount is INCIDENTAL to the reset, not a statement of it. A
    // perfectly reasonable future change — keep the current results on screen while a re-rank is
    // in flight, rather than flashing skeletons — would delete the unmount and silently
    // reintroduce a cross-run leak. This pins the behaviour that must survive it, and `runId`
    // makes the row own the guarantee instead of inheriting it from a conditional far away.
    const { keyPaperCalls } = stubWithKeyPaper({
      contributions: [{ term: "Immuno-oncology", rank: 1 }],
      searchEvidence: [searchEvidence("Immuno-oncology", 142)],
    });

    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");
    await waitFor(() => expect(keyPaperCalls()).toHaveLength(1));
    await screen.findByText(/CAR T persistence/);

    // Re-run with an edited paste. The committed search replaced the textarea with the read-only
    // ask, so "Edit paste" reveals it again; Alice returns under the SAME cwid.
    fireEvent.click(screen.getByRole("button", { name: "Edit paste" }));
    fireEvent.change(screen.getByLabelText(/the ask/i), {
      target: { value: "CAR T and solid tumors" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // The evidence resolves at all (a stale one-shot fetch guard would leave it dead)…
    await waitFor(() => expect(keyPaperCalls()).toHaveLength(2));
    // …and it fetches clean: no pmid claimed under the PREVIOUS paste is excluded under this one.
    expect(keyPaperCalls()[1]).not.toContain("exclude");
  });

  // ── Artifact-lead evidence (the design spec) ───────────────────────────────
  it("leads with the ARTIFACT — a titled paper, venue and year, with no click", async () => {
    // The spec puts a paper on the card face. The app used to put a COUNT there and hide the paper
    // behind a chevron, which is the gap this closes. `venue` is the field that had to be added to
    // the shared key-paper `_source` to make it sayable at all.
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (String(url).startsWith("/api/search/key-paper")) {
        return {
          ok: true,
          json: async () => ({
            pubs: [
              { pmid: "111", title: "CAR T persistence", year: 2025, journal: "Blood" },
              { pmid: "222", title: "Second paper", year: 2023 },
              { pmid: "333", title: "Third paper", year: 2021 },
            ],
          }),
        };
      }
      if ((init?.method ?? "GET") === "GET")
        return { ok: true, json: async () => ({ ok: true, submissions: [] }) };
      return {
        ok: true,
        json: async () => ({
          ok: true,
          concepts: CONCEPTS,
          candidates: [
            candidate({
              cwid: "a",
              name: "Alice Alpha",
              fusedScore: 0.9,
              contributions: [{ term: "Immuno-oncology", rank: 1 }],
              searchEvidence: [searchEvidence("Immuno-oncology", 142)],
            }),
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // No click anywhere in this test — the artifact resolves because the card is on screen.
    const lead = await screen.findByText("CAR T persistence");
    expect(lead.closest("a")?.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/111/");
    expect(screen.getByText(/Blood/)).toBeTruthy();
    expect(screen.getByText(/2025/)).toBeTruthy();

    // The caption carries what the SPONSOR asked for this concept — the slider's own value.
    expect(evidenceAsks()).toEqual(["ask 0.90"]);

    // The COUNT IS NOT ON THE FACE. That was the design objection: a card answering "why did this
    // person match?" with a statistic instead of a paper. It is not deleted — it moves into the
    // disclosure, where the spec puts it, and it keeps the word "tagged" (a real MeSH tag, not a
    // literal text mention). And there is no "Concept ·" kind word anywhere: the caption above
    // already named the concept.
    expect(evidenceBlocks()[0][1]).not.toContain("142 of 210 publications tagged");
    expect(evidenceBlocks()[0][1]).not.toContain("Concept");

    // "+ 2 more pubs (2023, 2021)" — the years of the papers it can ACTUALLY show. It must not
    // offer "+140 more" off the tagged count: the response holds three papers, and a click that
    // promised 140 could produce only two.
    const more = screen.getByRole("button", { name: /2 more pubs/ });
    expect(more.textContent).toBe("+ 2 more pubs (2023, 2021)");
    expect(screen.queryByText("Second paper")).toBeNull();
    fireEvent.click(more);
    expect(screen.getByText("Second paper")).toBeTruthy();
    expect(screen.getByText("Third paper")).toBeTruthy();
    // …and NOW the count is said, in the disclosure.
    expect(evidenceBlocks()[0][1]).toContain("142 of 210 publications tagged");
  });

  it("falls back to the count when NOTHING resolves — a block is never silently empty", async () => {
    // The one case that makes the count line non-optional. If the key-paper fetch returns nothing
    // (all its papers claimed by a sibling, or the index is having a bad day), a card that only
    // knows how to render artifacts renders an empty block — and a scholar with 142 tagged
    // publications reads as a scholar with nothing to say.
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          fusedScore: 0.9,
          contributions: [{ term: "Immuno-oncology", rank: 1 }],
          searchEvidence: [searchEvidence("Immuno-oncology", 142)],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    await waitFor(() =>
      expect(evidenceBlocks()[0][1]).toContain("142 of 210 publications tagged"),
    );
  });

  it("lists concept-matched GRANTS, and leads with them", async () => {
    // A funded award is the strongest thing a sponsor can be told, and the only artifact carrying a
    // FORWARD date — a paper says what someone did; an active R01 says what they are doing.
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (u.startsWith("/api/scholar/") && u.includes("/grants")) {
        return {
          ok: true,
          json: async () => ({
            grants: [
              {
                projectId: "R01 CA-2xxxxx",
                title: "Resistance mechanisms in HER2-low disease",
                sponsor: "NCI",
                startYear: 2023,
                endYear: 2028,
                isActive: true,
                role: "Multi-PI",
                // Admitted by the CONCEPT axis — the only kind a concept-captioned block may lead
                // with. The sibling test below supplies the text-only kind and asserts it is DROPPED.
                matchedConcept: true,
              },
            ],
            total: 1,
          }),
        };
      }
      if (u.startsWith("/api/search/key-paper"))
        return {
          ok: true,
          json: async () => ({ pubs: [{ pmid: "111", title: "CAR T persistence", year: 2024 }] }),
        };
      if ((init?.method ?? "GET") === "GET")
        return { ok: true, json: async () => ({ ok: true, submissions: [] }) };
      return {
        ok: true,
        json: async () => ({
          ok: true,
          concepts: CONCEPTS,
          candidates: [
            candidate({
              cwid: "a",
              name: "Alice Alpha",
              fusedScore: 0.9,
              contributions: [{ term: "Immuno-oncology", rank: 1 }],
              searchEvidence: [searchEvidence("Immuno-oncology", 142)],
            }),
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    await screen.findByText("Resistance mechanisms in HER2-low disease");
    expect(screen.getByText("GRANT")).toBeTruthy();
    expect(screen.getByText(/active to 2028/)).toBeTruthy();
    // Multi-PI reads as "MPI" (mockup brevity) — and it is THIS scholar's role, threaded from the
    // route's per-person pick, not the grant's lead PI.
    expect(screen.getByText("MPI")).toBeTruthy();

    // The grant leads: it renders BEFORE the paper in the block.
    const block = evidenceBlocks()[0][1];
    expect(block.indexOf("Resistance mechanisms")).toBeLessThan(block.indexOf("CAR T persistence"));
  });

  it("an expired grant reads 'expired <year>' + the scholar's role, never an active date", async () => {
    // The two questions a sponsor asks of a grant: is this scholar the PI, and is it still funded.
    // A dead award is a materially different pitch, so the line says so plainly instead of a bare
    // 2014–2020 range.
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (u.startsWith("/api/scholar/") && u.includes("/grants")) {
        return {
          ok: true,
          json: async () => ({
            grants: [
              {
                projectId: "R01 CA-1xxxxx",
                title: "ERG-induced taxane resistance",
                sponsor: "NCI",
                startYear: 2014,
                endYear: 2020,
                isActive: false,
                role: "PI",
                matchedConcept: true,
              },
            ],
            total: 1,
          }),
        };
      }
      if (u.startsWith("/api/search/key-paper")) return { ok: true, json: async () => ({ pubs: [] }) };
      if ((init?.method ?? "GET") === "GET")
        return { ok: true, json: async () => ({ ok: true, submissions: [] }) };
      return {
        ok: true,
        json: async () => ({
          ok: true,
          concepts: CONCEPTS,
          candidates: [
            candidate({
              cwid: "a",
              name: "Alice Alpha",
              fusedScore: 0.9,
              contributions: [{ term: "Immuno-oncology", rank: 1 }],
              searchEvidence: [searchEvidence("Immuno-oncology", 142)],
            }),
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    await screen.findByText("ERG-induced taxane resistance");
    expect(screen.getByText(/expired 2020/)).toBeTruthy();
    expect(screen.getByText("PI")).toBeTruthy();
    expect(screen.queryByText(/active to/)).toBeNull();
  });

  it("demotes the weakest matched concepts to one-line supporting rows (three-register hierarchy)", async () => {
    // The strongest PRIMARY_BLOCKS concepts carry the full artifact; the rest demote to a row that
    // does not fetch — the concept, its ask weight, and the tagged count, and nothing it never
    // fetched (no role, no year).
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          fusedScore: 0.9,
          contributions: [
            { term: "Immuno-oncology", rank: 1 }, // centrality 0.9 — strongest
            { term: "Cancer Metabolism", rank: 1 }, // 0.5
            { term: "CRISPR screening", rank: 1 }, // 0.4 — weakest ⇒ demoted
          ],
          searchEvidence: [
            searchEvidence("Immuno-oncology", 142),
            searchEvidence("Cancer Metabolism", 88),
            searchEvidence("CRISPR screening", 12),
          ],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    const full = document.querySelectorAll('[data-slot="matcha-evidence"]');
    const supporting = document.querySelectorAll('[data-slot="matcha-evidence-supporting"]');
    expect(full).toHaveLength(2); // PRIMARY_BLOCKS
    expect(supporting).toHaveLength(1);
    // The weakest concept demotes, and shows the MATCHED count for THIS concept (12) over the total
    // (210) — NOT the bare total, which is the same for every concept and read as wrong.
    expect(supporting[0].textContent).toContain("CRISPR screening");
    expect(supporting[0].textContent).toMatch(/12 of 210 pubs/);
  });

  it("relabels a middle author as 'contributing author', never 'middle author' (sponsor console)", async () => {
    // The honest word when a scholar was neither lead nor senior — the read an officer needs when
    // it is the only evidence for the sponsor's top ask.
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (u.startsWith("/api/scholar/") && u.includes("/grants"))
        return { ok: true, json: async () => ({ grants: [], total: 0 }) };
      if (u.startsWith("/api/search/key-paper"))
        return {
          ok: true,
          json: async () => ({
            pubs: [{ pmid: "111", title: "A contributing-author paper", year: 2024, role: "middle" }],
          }),
        };
      if ((init?.method ?? "GET") === "GET")
        return { ok: true, json: async () => ({ ok: true, submissions: [] }) };
      return {
        ok: true,
        json: async () => ({
          ok: true,
          concepts: CONCEPTS,
          candidates: [
            candidate({
              cwid: "a",
              name: "Alice Alpha",
              fusedScore: 0.9,
              contributions: [{ term: "Immuno-oncology", rank: 1 }],
              searchEvidence: [searchEvidence("Immuno-oncology", 142)],
            }),
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    await screen.findByText("A contributing-author paper");
    expect(screen.getByText(/contributing author/)).toBeTruthy();
    expect(screen.queryByText(/middle author/)).toBeNull();
  });

  it("DROPS a grant the concept axis never admitted — a text hit is not evidence for the concept", async () => {
    // The funding query is an OR: literal text OR concept tag. So a grant can surface having
    // matched nothing but a stray word of the ask, and the block's caption would then assert it as
    // evidence for a concept it was never tagged with. Found on STAGING, not here: for cwid
    // stt2007 asked "HER2-low breast cancer" (D001943) the concept axis admits ZERO grants, while
    // the text arm returns three — led by "WCM SPORE in Prostate Cancer". A prostate SPORE is not
    // evidence of HER2-low breast cancer work, however plausibly it renders.
    //
    // The page-level `strength` cannot express this: on a MIXED page it reads "tagged" while
    // individual rows are literal-text hits. Hence the per-row `matchedConcept`, asserted here on
    // exactly such a mixed page.
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (u.startsWith("/api/scholar/") && u.includes("/grants")) {
        return {
          ok: true,
          json: async () => ({
            grants: [
              {
                projectId: "R01 REAL",
                title: "Concept-tagged award",
                sponsor: "NCI",
                isActive: true,
                matchedConcept: true,
              },
              {
                projectId: "P50 TEXTONLY",
                title: "WCM SPORE in Prostate Cancer",
                sponsor: "NCI",
                isActive: true,
                matchedConcept: false,
              },
            ],
            // The page reads "tagged" because ONE row was admitted by concept. Gating on this
            // would let the prostate SPORE through — the bug this test exists to hold shut.
            strength: "tagged",
            total: 2,
          }),
        };
      }
      if (u.startsWith("/api/search/key-paper"))
        return {
          ok: true,
          json: async () => ({ pubs: [{ pmid: "111", title: "CAR T persistence", year: 2024 }] }),
        };
      if ((init?.method ?? "GET") === "GET")
        return { ok: true, json: async () => ({ ok: true, submissions: [] }) };
      return {
        ok: true,
        json: async () => ({
          ok: true,
          concepts: CONCEPTS,
          candidates: [
            candidate({
              cwid: "a",
              name: "Alice Alpha",
              fusedScore: 0.9,
              contributions: [{ term: "Immuno-oncology", rank: 1 }],
              searchEvidence: [searchEvidence("Immuno-oncology", 142)],
            }),
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // The concept-admitted grant renders...
    await screen.findByText("Concept-tagged award");
    // ...and the text-only one NEVER does, on a page the server called "tagged".
    expect(screen.queryByText("WCM SPORE in Prostate Cancer")).toBeNull();
  });

  it("coverage line shows the evidence count; a ranked-only concept is the strip's partial fill, not prose (D7)", async () => {
    // D7 — the coverage caption no longer enumerates "also ranked under X". A sub-threshold hit
    // (ranked under a concept, no evidence block) is now carried by the strip's own lighter `ranked`
    // segment, which names the concept on hover. The caption states only the count the strip can't.
    // Alice ranks under 2 of the 3 concepts and has a block for only ONE.
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          fusedScore: 0.9,
          contributions: [
            { term: "Immuno-oncology", rank: 1 },
            { term: "Cancer Metabolism", rank: 2 },
          ],
          searchEvidence: [searchEvidence("Immuno-oncology", 142)], // none for Cancer Metabolism
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    const line = document.querySelector('[data-slot="matcha-coverage"] p')!.textContent!;
    expect(line).toContain("Evidence for 1 of 3 concepts asked");
    // D7 — the prose is gone; the ranked-only concept is the strip's lighter segment, which names
    // itself on hover ("Cancer Metabolism — ranked under this, evidence not shown").
    expect(line).not.toContain("also ranked under");
    const rankedSeg = document.querySelector(
      '[data-slot="matcha-coverage-segment"][data-term="Cancer Metabolism"]',
    )!;
    expect(rankedSeg.getAttribute("data-coverage")).toBe("ranked");
    const segTip = await tooltipTextOf(rankedSeg);
    expect(segTip).toContain("ranked under this");
    // §4 — and the segment says what the STRIP is, not only what the segment is. This is the whole
    // requirement ("the bars don't mean much"): a segment's state is unreadable until you know the
    // bar is one concept and the width is the ask's weight.
    expect(segTip).toContain("One bar per concept this opportunity calls for");
    expect(segTip).toContain("width = how much it matters");
    // The evidence-state segment leads with its KIND + term and points at the detailed view — the
    // strip rides the compact row too, where the old "evidence below" was simply wrong.
    const evSeg = document.querySelector(
      '[data-slot="matcha-coverage-segment"][data-term="Immuno-oncology"]',
    )!;
    expect(evSeg.getAttribute("data-coverage")).toBe("evidence");
    const evTip = await tooltipTextOf(evSeg);
    expect(evTip).toContain("Concept: Immuno-oncology");
    expect(evTip).toContain("Evidence shown in the Detailed view");
    // …and the strip is legible to a screen reader at all, which it was not: the bar was
    // `aria-hidden`, so its only textual equivalent was the "1 of 3" caption — a count naming no
    // concept and no state, and absent entirely from the inline variant.
    const strip = document.querySelector('[data-slot="matcha-coverage"] [role="img"]')!;
    const spoken = strip.getAttribute("aria-label")!;
    expect(spoken).toContain("One bar per concept this opportunity calls for");
    // ⚠ The legend must NOT say the literal "the ask": this string is an accessible name, and the
    // paste textarea already carries that label — two elements answering to one name.
    expect(spoken).not.toContain("the ask");
    expect(spoken).toContain("Cancer Metabolism — ranked under this, evidence not shown");
    expect(spoken).toContain("CRISPR screening — no evidence");
    // A genuine gap: she never ranked under it at all. It moved OFF the coverage line to a single
    // muted line at the card's foot (mockup), so the strip caption no longer carries it.
    expect(line).not.toContain("no evidence for");
    const gaps = document.querySelector('[data-slot="matcha-gaps"]')!.textContent!;
    expect(gaps).toContain("No evidence");
    expect(gaps).toContain("CRISPR screening");
    // 1 + 1 + 1 = the 3 concepts asked. The old line could not make that claim.
    expect(screen.queryByText(/ranked, no evidence shown/)).toBeNull();
  });

  /**
   * A segment's WIDTH is `conceptWeight` — `centrality ** CENTRALITY_GAMMA * weightFactor`, the very
   * number the fusion ranks on. This test exists because wrapping the segments in `HoverTooltip`
   * moved the flex item one level out: the wrapper span is what the bar now sizes, so `flexGrow` had
   * to move onto it. Left on the child it would be inert — every segment would collapse to
   * `min-w-[3px]`, the ranking's own numbers would vanish from the drawing, and NOTHING else in this
   * file would have noticed, because a strip of eight equal slivers still renders, still hovers, and
   * still says the right words. That is this repo's signature bug (declared, never connected) in its
   * purest form: pixels, and only the eyeball or an assertion like this one can see it.
   */
  it("§4 — the segment WIDTHS are the concepts' fusion weights, and they ride the hover wrapper", async () => {
    await renderAndSearch();
    const segments = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="matcha-coverage-segment"]'),
    ].slice(0, CONCEPTS.length);
    expect(segments).toHaveLength(3);

    const growOf = (seg: HTMLElement) => Number((seg.parentElement as HTMLElement).style.flexGrow);
    for (const [i, seg] of segments.entries()) {
      // On the WRAPPER, not the painted child — the child carries no sizing at all.
      expect(seg.style.flexGrow).toBe("");
      expect((seg.parentElement as HTMLElement).style.flexBasis).toBe("0px");
      expect(growOf(seg)).toBeCloseTo(conceptWeight(CONCEPTS[i]), 6);
    }
    // And they are genuinely different: Immuno-oncology (0.9 × 3.0) outweighs Cancer Metabolism
    // (0.5 × 1.0), so the bar cannot be eight equal slivers.
    expect(growOf(segments[0])).toBeGreaterThan(growOf(segments[1]));
  });

  /**
   * §5a — THE ASKS COLUMN COUNTS WHAT THE SCHOLAR RANKS UNDER, NOT WHAT WE CAN EVIDENCE.
   *
   * This column shipped counting `state === "evidence"`, which the contract caps at
   * MAX_EVIDENCE_CONCEPTS (3). It had NO test at all — which is exactly why it shipped lying.
   * Measured on staging over 17 real asks: 39–83% of candidates (mean ~60%) had more
   * contributions than evidence, and on a 7-concept ask EVERY visible row read "3/7".
   *
   * The fixture below is that production shape in miniature: a scholar who ranks under BOTH
   * concepts but can only be evidenced for ONE. Pre-fix this row read "1/2"; it must read "2/2".
   */
  it("§5a — the ASKS count is uncapped: it counts ranked concepts, not the evidence-capped subset", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "cap",
          name: "Cappy Capped",
          fusedScore: 0.9,
          // Ranks under BOTH concepts…
          contributions: [
            { term: "Immuno-oncology", rank: 4 },
            { term: "Cancer Metabolism", rank: 9 },
          ],
          // …but only ONE is evidenced. This asymmetry IS the MAX_EVIDENCE_CONCEPTS cap.
          searchEvidence: [searchEvidence("Immuno-oncology", 12)],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T collaborators" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Cappy Capped");
    fireEvent.click(screen.getByRole("button", { name: "compact" }));

    const count = document.querySelector('[data-slot="matcha-asks-count"]')!;
    // 2 of 3 — the concepts RANKED under. "1/3" is the old evidence-capped read: same scholar,
    // same data, one fewer concept claimed, purely because we cap what we can EVIDENCE at 3.
    expect(count.textContent).toBe("2/3");
    expect(count.textContent).not.toBe("1/3");
  });

  it("§5a — the ASKS count does not count a concept the scholar never ranked under", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "one",
          name: "Solo Single",
          fusedScore: 0.9,
          // Ranks under ONE of the two concepts — `state: "none"` for the other.
          contributions: [{ term: "Immuno-oncology", rank: 4 }],
          searchEvidence: [searchEvidence("Immuno-oncology", 12)],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T collaborators" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Solo Single");
    fireEvent.click(screen.getByRole("button", { name: "compact" }));

    // The guard against over-correcting: `!== "none"` must not become "count every concept".
    expect(document.querySelector('[data-slot="matcha-asks-count"]')!.textContent).toBe("1/3");
  });

  it("§5a — the count says what it counts; a bare ratio cannot", async () => {
    await renderAndSearch();
    fireEvent.click(screen.getByRole("button", { name: "compact" }));
    const tip = await tooltipTextOf(
      document.querySelector('[data-slot="matcha-asks-count"]') as HTMLElement,
    );
    expect(tip).toContain("concepts this opportunity calls for");
    expect(tip).toContain("not only the ones we can show evidence for");
  });

  it("Compact density renders one scannable row per scholar; a row click expands the detailed card (D8/D9)", async () => {
    await renderAndSearch(); // Detailed (pinned in beforeEach; compact is the app default)
    // Detailed: the full evidence card is present, no compact rows.
    expect(document.querySelector('[data-slot="matcha-row"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="matcha-compact-row"]')).toBeNull();

    // Toggle to Compact → one-line rows, no detailed cards.
    fireEvent.click(screen.getByRole("button", { name: "compact" }));
    expect(document.querySelector('[data-slot="matcha-row"]')).toBeNull();
    expect(
      document.querySelectorAll('[data-slot="matcha-compact-row"]').length,
    ).toBeGreaterThan(0);

    // Alice carries a 2024 paper on the bespoke path → the row shows the latest year. D9 — a compact
    // row carries no no-evidence enumeration.
    const alice = screen.getByRole("button", { name: "Expand Alice Alpha" });
    expect(alice.textContent).toContain("latest 2024");
    expect(alice.querySelector('[data-slot="matcha-gaps"]')).toBeNull();

    // A row click expands THAT scholar to the detailed card in place; the rest stay compact.
    fireEvent.click(alice);
    const card = document.querySelector('[data-slot="matcha-row"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Alice Alpha");
    expect(document.querySelector('[data-slot="matcha-compact-row"]')).not.toBeNull(); // Bob still compact
  });

  /**
   * THE COLLAPSE DIRECTION, which is the whole test. `toggled` was always a correct toggle, but it
   * was wired ONLY to the compact row — so the instant it ADDED a cwid, the row holding it unmounted
   * and the expanded card offered nothing to fire it again with. `expanded` could only grow, and
   * only a new search ever emptied it.
   *
   * A test that expands and stops (the one above) passes either way. This one has to press the
   * collapse control, so it cannot pass without one existing.
   */
  it("D8 — an expanded row COLLAPSES back to its compact row", async () => {
    await renderAndSearch();
    fireEvent.click(screen.getByRole("button", { name: "compact" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Alice Alpha" }));

    // Expanded: the detailed card is up and the compact row that spawned it is gone.
    expect(document.querySelector('[data-slot="matcha-row"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Expand Alice Alpha" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Alice Alpha" }));

    // Back to a compact row — and the round trip is repeatable, which "expanded.add() only" is not.
    expect(document.querySelector('[data-slot="matcha-row"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Expand Alice Alpha" })).toBeTruthy();
  });

  it("D8 — Detailed density offers no collapse: there is nothing to collapse TO", async () => {
    await renderAndSearch(); // Detailed (pinned in beforeEach)
    // The card is not an expansion of anything here, so a control returning it to a mode the
    // officer is not in would be a worse bug than the one above.
    // Queried per-scholar, not by a /^Collapse/ sweep: the ask card's own paste clamp is a button
    // reading "Collapse ▴", and a loose regex would pass on that instead of on what it names.
    for (const name of ["Alice Alpha", "Bob Beta", "Cara Gamma"]) {
      expect(screen.queryByRole("button", { name: `Collapse ${name}` })).toBeNull();
    }
  });

  // ── Shortlist (§6) ─────────────────────────────────────────────────────────
  /**
   * ⚠ THIS TEST DOES NOT TOUCH THE DENSITY TOGGLE, AND THAT IS THE ENTIRE POINT. Compact is the
   * DEFAULT density since the warm-palette redesign, so a shortlist wired only to the DETAILED card
   * would be INVISIBLE on a first visit — dark in exactly the way D1's year was dark: shipped,
   * tested, and never reachable. It renders WITHOUT the shared helper (which opts into detailed) so
   * the assertion sees the true first-visit density.
   *
   * Second half of the same defect: the selection bar is NOT density-gated, so a detailed-only
   * checkbox would let the bar offer a shortlist over compact rows with nothing to untick it with —
   * exporting a list you cannot see or audit.
   */
  it("the shortlist is reachable in the DEFAULT density, not only in detailed", async () => {
    // Clear the suite's detailed pin (see beforeEach) so this sees the true first-visit default.
    window.localStorage.clear();
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), {
      target: { value: "CAR T collaborators" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // First visit lands on COMPACT rows; the shortlist checkbox must be reachable there with no
    // density click — the mirror of the old detailed-default guard.
    expect(screen.getByRole("button", { name: "compact" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.querySelector('[data-slot="matcha-compact-row"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Alice Alpha" }));
    expect(document.querySelector('[data-slot="matcha-shortlist"]')!.textContent).toContain(
      "1 shortlisted",
    );
    // And it unticks from the same row it was ticked on — the bar can never outlive its checkbox.
    fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Alice Alpha" }));
    expect(document.querySelector('[data-slot="matcha-shortlist"]')).toBeNull();
  });

  /**
   * Selection spans BOTH densities (the checkbox is a verb of the result set, not of a row style),
   * and on the compact row it forced the root off `<button>`: a checkbox inside a button is invalid
   * HTML and the two click targets fight. `data-slot` stays on the root, and the expand button
   * keeps its name — the two tests above still pass, which is the evidence the restructure
   * preserved the row.
   */
  it("shortlists compact rows, counts them, and exports the SHORTLIST — not the filtered list", async () => {
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
      fireEvent.click(screen.getByRole("button", { name: "compact" }));
      // Cara is weak-tier and sits below the relevance floor; open it so her row has a checkbox.
      fireEvent.click(screen.getByRole("button", { name: /Show ↓/ }));

      // Nothing ticked ⇒ no bar, and Export is the un-narrowed one it has always been.
      expect(document.querySelector('[data-slot="matcha-shortlist"]')).toBeNull();
      expect(screen.getByRole("button", { name: /Export \(3\)/ })).toBeTruthy();

      fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Alice Alpha" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Cara Gamma" }));

      expect(document.querySelector('[data-slot="matcha-shortlist"]')!.textContent).toContain(
        "2 shortlisted",
      );
      // The un-narrowed export is still REACHABLE — it just stops being the unqualified "Export",
      // and says which list it is.
      expect(screen.getByRole("button", { name: /Export all \(3\)/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Export \(3\)/ })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Export shortlist \(2\)/ }));
      expect(parts).toHaveLength(1);
      const rows = parts[0].split("\r\n").slice(1).filter(Boolean);
      expect(rows).toHaveLength(2); // the two picked — not the three the facets matched
      expect(parts[0]).toContain("Alice Alpha");
      expect(parts[0]).toContain("Cara Gamma");
      expect(parts[0]).not.toContain("Bob Beta");
      // POOL ranks, carried: Cara exports as #3, not as "#2 of the shortlist".
      expect(rows[0].startsWith("1,")).toBe(true);
      expect(rows[1].startsWith("3,")).toBe(true);
    } finally {
      globalThis.Blob = OrigBlob;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it("a facet does not drop a shortlisted scholar — they were CHOSEN, not matched", async () => {
    await renderAndSearch();
    fireEvent.click(screen.getByRole("button", { name: "compact" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Alice Alpha" })); // Medicine

    // Narrow to a department Alice is not in. Her row leaves the view; her pick does not.
    fireEvent.click(screen.getByRole("checkbox", { name: /Surgery/ }));
    expect(screen.queryByRole("checkbox", { name: "Shortlist Alice Alpha" })).toBeNull();
    expect(document.querySelector('[data-slot="matcha-shortlist"]')!.textContent).toContain(
      "1 shortlisted",
    );
  });

  it("the shortlist is PER-ASK — a new search clears it", async () => {
    await renderAndSearch();
    fireEvent.click(screen.getByRole("button", { name: "compact" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Alice Alpha" }));
    expect(document.querySelector('[data-slot="matcha-shortlist"]')!.textContent).toContain(
      "1 shortlisted",
    );

    // A different sponsor. A cwid set carried across would export people this sponsor never asked
    // about, under this ask's title and this ask's ranks.
    fireEvent.click(screen.getByRole("button", { name: "Edit paste" }));
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "ADC linkers" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));

    await waitFor(() =>
      expect(document.querySelector('[data-slot="matcha-shortlist"]')).toBeNull(),
    );
    // The stub returns the same people, so this is the real check: the row is back and UNTICKED.
    expect(
      (screen.getByRole("checkbox", { name: "Shortlist Alice Alpha" }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  // ── D3 recency dial ────────────────────────────────────────────────────────
  /**
   * The dial must be CONNECTED, not merely present: the whole point is that it re-ranks the
   * already-fetched candidates in the browser. `old` outranks `new` topically (rank 1 vs 6) but is
   * 27 years stale, so the default curve sinks it; Any restores the topical order. Years are
   * relative to the real clock the panel reads, so the flip holds whatever year this runs in.
   */
  it("D3 — the recency dial re-ranks the fetched candidates; Any restores the topical order, with no re-query", async () => {
    const NOW = new Date().getUTCFullYear();
    const fetchMock = stubFetch({
      concepts: [{ term: "ADC", kind: "concept", members: ["ADC"], centrality: 1, weightFactor: 1 }],
      candidates: [
        candidate({
          cwid: "old",
          name: "Olive Old",
          mostRecentYear: NOW - 27,
          contributions: [{ term: "ADC", rank: 1 }],
        }),
        candidate({
          cwid: "new",
          name: "Nina New",
          mostRecentYear: NOW,
          contributions: [{ term: "ADC", rank: 6 }],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "ADC work" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Nina New");

    const leader = () =>
      document.querySelector('[data-slot="matcha-row"]')!.textContent!;

    // Default "Prefer recent" = the server's own curve: recency sinks the older, better-ranked one.
    expect(leader()).toContain("Nina New");

    // Any → recency off → the topical order returns…
    fireEvent.click(screen.getByRole("button", { name: "Any" }));
    expect(leader()).toContain("Olive Old");

    // …and none of it cost a round-trip. This is a client re-rank, like the centrality slider.
    expect(rankCalls(fetchMock)).toBe(1);
  });

  it("D3/D8 — a stale year is flagged and explained; under Any nothing claims stale", async () => {
    const NOW = new Date().getUTCFullYear();
    stubFetch({
      concepts: [{ term: "ADC", kind: "concept", members: ["ADC"], centrality: 1, weightFactor: 1 }],
      candidates: [
        candidate({
          cwid: "old",
          name: "Olive Old",
          mostRecentYear: NOW - 27,
          contributions: [{ term: "ADC", rank: 1 }],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "ADC work" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Olive Old");
    fireEvent.click(screen.getByRole("button", { name: "compact" }));

    // Queried by its own `data-slot`, not by sweeping every span for "latest": the tooltip wrapper
    // is ALSO a span carrying that same text, so a text sweep silently returns the wrapper and
    // every assertion below reads the wrong element.
    const yearCell = () =>
      screen
        .getByRole("button", { name: "Expand Olive Old" })
        .querySelector('[data-slot="matcha-latest-year"]')!;

    expect(yearCell().textContent).toBe(`latest ${NOW - 27}`);
    // Under the default curve the year is older than one half-life ⇒ flagged, and it SAYS why.
    // The hover is the ONLY thing that says so — the stale treatment is de-emphasis with no hue.
    expect(await tooltipTextOf(yearCell())).toContain("down-weighting");

    // Any weighs no recency, so the row may not claim the match is stale. No wrapper, no tooltip:
    // the cell's parent is the row's expand button, so focusing it can open nothing.
    fireEvent.click(screen.getByRole("button", { name: "Any" }));
    fireEvent.focus(yearCell().parentElement as HTMLElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("D3 — the dial is hidden when the payload carries no years (flag off)", async () => {
    await renderAndSearch(); // THREE carries no `mostRecentYear`
    expect(screen.queryByRole("group", { name: "Recency" })).toBeNull();
  });

  // ── D4 hard year cutoff ────────────────────────────────────────────────────
  /**
   * D4 REMOVES people, which is categorically different from D1 demoting them: the demotion is
   * floored at ×0.5 and stays on the page, a removal is unbounded and unnoticeable. So these
   * tests exercise the two ways it can silently produce a wrong answer — hiding on an ABSENT
   * year, and hiding under a mode the officer did not ask for — not just the happy path.
   */
  const sinceFixture = () =>
    stubFetch({
      concepts: [{ term: "ADC", kind: "concept", members: ["ADC"], centrality: 1, weightFactor: 1 }],
      candidates: [
        candidate({
          cwid: "fresh",
          name: "Fran Fresh",
          mostRecentYear: 2026,
          contributions: [{ term: "ADC", rank: 1 }],
        }),
        candidate({
          cwid: "stale",
          name: "Stan Stale",
          mostRecentYear: 2011,
          contributions: [{ term: "ADC", rank: 2 }],
        }),
        // No year at all — the flag-off/uncurated case. MUST survive every cutoff.
        candidate({ cwid: "noyear", name: "Nora Noyear", contributions: [{ term: "ADC", rank: 3 }] }),
      ],
    });

  const search = async () => {
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "ADC work" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Fran Fresh");
  };

  it("D4 — Since removes the scholars below the cutoff and says how many, naming the escape", async () => {
    sinceFixture();
    await search();
    // Before: "Prefer recent" is a SOFT preference — Stan is demoted, never removed.
    expect(screen.queryByText("Stan Stale")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Since" }));
    expect(screen.queryByText("Stan Stale")).toBeNull();
    // The count is the only signal an absence leaves. Without it the officer cannot know the
    // filter cost them anyone, let alone whom.
    expect(screen.queryByText(/1 hidden · no publication since/)).not.toBeNull();
    expect(screen.queryByText(/set recency to “Any” to include them/)).not.toBeNull();
  });

  it("D4 — a candidate with NO year is never hidden: absent is not old", async () => {
    // `mostRecentYear` is absent when the flag is off OR when nobody curated the scholar's pubs.
    // Neither is a fact about the scholar, and deleting people for a gap in our own data is the
    // one failure this filter must not have.
    sinceFixture();
    await search();
    fireEvent.click(screen.getByRole("button", { name: "Since" }));
    expect(screen.queryByText("Nora Noyear")).not.toBeNull();
  });

  it("D4 — Prefer recent and Any hide NOBODY (a soft preference must never delete)", async () => {
    // `staleBefore("recent")` is currentYear−8, so a filter keyed on IT rather than on the mode
    // would make the DEFAULT dial position silently delete Stan. It must not.
    sinceFixture();
    await search();
    expect(screen.queryByText("Stan Stale")).not.toBeNull(); // default = "Prefer recent"
    expect(screen.queryByText(/hidden · no publication since/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Any" }));
    expect(screen.queryByText("Stan Stale")).not.toBeNull();
    expect(screen.queryByText(/hidden · no publication since/)).toBeNull();
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
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    const header = () => document.querySelector('[data-slot="matcha-ask"]')?.textContent;
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
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
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
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
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
    // Cara (~19% of Alice) is weak, which now puts her below the relevance floor — expand it so her
    // badge is in the DOM. The point of this test is the tier COMPUTATION, not the floor.
    fireEvent.click(screen.getByRole("button", { name: /Show ↓/ }));
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

  // ── The relevance floor + zero-evidence exclusion ──────────────────────────
  it("collapses the weak tier below a floor bar, and Show reveals it — a toggle, not a cut", async () => {
    await renderAndSearch(); // THREE: Alice + Bob strong, Cara ~19% ⇒ weak
    // Cara is below the floor: not painted, but not lost. The bar counts her and offers her.
    expect(screen.queryByText("Cara Gamma")).toBeNull();
    const bar = screen.getByRole("button", { name: /weaker match/ });
    expect(bar.textContent).toMatch(/1 weaker match/);
    fireEvent.click(bar);
    expect(screen.getByText("Cara Gamma")).toBeTruthy();
  });

  it("excludes a candidate the spine shipped no evidence for, and says how many are hidden", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          fusedScore: 0.9,
          contributions: [{ term: "Immuno-oncology", rank: 1 }],
        }),
        // Pugh ranked into a concept's top-100 on an identity-tail hit — NO research evidence.
        candidate({
          cwid: "pugh",
          name: "Pugh Nomatch",
          searchEvidence: undefined,
          contributions: [{ term: "Immuno-oncology", rank: 8 }],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    // Excluded entirely — not collapsed under the floor, GONE — and the count is stated.
    expect(screen.queryByText("Pugh Nomatch")).toBeNull();
    expect(screen.queryByRole("button", { name: /weaker match/ })).toBeNull();
    expect(screen.getByText(/1 with no evidence hidden/)).toBeTruthy();
  });

  it("marks each evidence block's provenance — subject-tagged vs keyword only", async () => {
    stubFetch({
      concepts: CONCEPTS,
      candidates: [
        candidate({
          cwid: "a",
          name: "Alice Alpha",
          fusedScore: 0.9,
          contributions: [
            { term: "Immuno-oncology", rank: 1 },
            { term: "Cancer Metabolism", rank: 1 },
          ],
          searchEvidence: [
            searchEvidence("Immuno-oncology", 142), // strength "tagged" ⇒ structured
            {
              term: "Cancer Metabolism",
              evidence: {
                kind: "publications",
                strength: "mention", // free text ⇒ the keyword-only signal
                text: "3 publications mentioning 'metabolism'",
              },
              pubCount: 210,
              keyPaper: { descriptorUis: [], contentQuery: "metabolism" },
            },
          ],
        }),
      ],
    });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    expect(document.body.textContent).toContain("subject-tagged");
    expect(document.body.textContent).toContain("keyword only");
  });

  // ── Retained searches (#6d) ────────────────────────────────────────────────
  it("lists retained searches from the SERVER and says they are kept", async () => {
    // The server list replaced a localStorage history because only it can offer a delete that
    // actually erases the sponsor's words rather than clearing one browser. (It ALSO used to be
    // cross-officer, and that WAS the headline reason — §9 removed it for everyone but a
    // superuser once the audience became chairs pasting email. See the scope tests below.)
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
          submittedByName: "Dana Ellis",
          createdAt: "2026-07-13T10:00:00.000Z",
        },
      ],
    });
    render(<MatchaPanel />);
    // The count rides the drawer trigger; opening it reveals the list + the retention notice.
    fireEvent.click(await screen.findByRole("button", { name: /Recent \(1\)/ }));
    expect(await screen.findByText(/Recent searches \(1\)/)).toBeTruthy();
    expect(screen.getByText("cardiac fibrosis")).toBeTruthy();
    // The officer is TOLD, on the surface where it happens — not in a policy page.
    expect(screen.getByText(/They’re saved/)).toBeTruthy();
    expect(screen.getByText(/improve match quality/)).toBeTruthy();
  });

  it("replaying a Recent opens the ask FULL, not collapsed to the pinned bar", async () => {
    // The gripe: a Recent replay used to open the compact pinned bar ("already read"), hiding the
    // full "What we read from the ask" card. A replay is still the officer's context, so it now
    // opens Full exactly like a fresh paste; the scroll-tuck (D10) and manual Collapse still apply.
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
          submittedByName: "Dana Ellis",
          createdAt: "2026-07-13T10:00:00.000Z",
        },
      ],
    });
    render(<MatchaPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Recent \(1\)/ }));
    fireEvent.click(await screen.findByText("cardiac fibrosis")); // replay the saved ask

    // Full card (its eyebrow) is present; the compact bar's "Show original ▾" is NOT.
    expect(await screen.findByText(/What we read from the ask/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show original ▾" })).toBeNull();
  });

  describe("history scope (§9) and the submitter (§10)", () => {
    function submission(over: Partial<Submission> = {}): Submission {
      return {
        id: "s1",
        description: "We fund cardiac fibrosis work.",
        title: "cardiac fibrosis",
        engine: "spine",
        candidateCount: 12,
        submittedByName: "Dana Ellis",
        createdAt: "2026-07-13T10:00:00.000Z",
        ...over,
      };
    }

    it("scope 'own': NO submitter column — every row is yours, so the name is a constant", async () => {
      stubFetch({
        concepts: CONCEPTS,
        candidates: THREE,
        scope: "own",
        submissions: [submission()],
      });
      render(<MatchaPanel />);
      fireEvent.click(await screen.findByRole("button", { name: /Recent \(1\)/ }));
      await screen.findByText(/Recent searches \(1\)/);

      expect(screen.getByText("cardiac fibrosis")).toBeTruthy();
      expect(screen.queryByText("Dana Ellis")).toBeNull();
      // And the notice must not tell a chair that the console at large reads their donor email.
      expect(
        screen.getByText(/Only you and console administrators can see your searches/),
      ).toBeTruthy();
    });

    it("scope 'all': the submitter's NAME renders — it is what distinguishes a superuser's rows", async () => {
      stubFetch({
        concepts: CONCEPTS,
        candidates: THREE,
        scope: "all",
        submissions: [
          submission({ id: "s1", submittedByName: "Dana Ellis" }),
          submission({ id: "s2", title: "heart failure", submittedByName: "Chris Hale" }),
        ],
      });
      render(<MatchaPanel />);
      fireEvent.click(await screen.findByRole("button", { name: /Recent \(2\)/ }));
      await screen.findByText(/Recent searches \(2\)/);

      expect(screen.getByText("Dana Ellis")).toBeTruthy();
      expect(screen.getByText("Chris Hale")).toBeTruthy();
      expect(screen.getByText(/you are seeing every user's searches/)).toBeTruthy();
    });

    it("renders the CWID fallback verbatim when the route could not resolve a name", async () => {
      // The route falls back to the cwid for a submitter with no Scholar row. The panel must
      // render whatever label it is handed — a client-side "prettify" that blanked an
      // unrecognised value would reintroduce the empty cell the fallback exists to prevent.
      stubFetch({
        concepts: CONCEPTS,
        candidates: THREE,
        scope: "all",
        submissions: [submission({ submittedByName: "abc1234" })],
      });
      render(<MatchaPanel />);
      fireEvent.click(await screen.findByRole("button", { name: /Recent \(1\)/ }));
      await screen.findByText(/Recent searches \(1\)/);

      expect(screen.getByText("abc1234")).toBeTruthy();
    });

    it("FAILS CLOSED on a response with no scope — no submitter column", async () => {
      // An older/partial payload must not default to the privileged rendering. `"omit"` really
      // drops the key (see stubFetch) — with `undefined` this test would pass on any code.
      stubFetch({
        concepts: CONCEPTS,
        candidates: THREE,
        scope: "omit",
        submissions: [submission()],
      });
      render(<MatchaPanel />);
      fireEvent.click(await screen.findByRole("button", { name: /Recent \(1\)/ }));
      await screen.findByText(/Recent searches \(1\)/);

      expect(screen.queryByText("Dana Ellis")).toBeNull();
    });
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
          submittedByName: "Dana Ellis",
          createdAt: "2026-07-13T10:00:00.000Z",
        },
      ],
    });
    render(<MatchaPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Recent \(1\)/ }));
    await screen.findByText(/Recent searches \(1\)/);

    fireEvent.click(screen.getByRole("button", { name: /Delete search: cardiac fibrosis/ }));
    // Last search deleted ⇒ the trigger (and the drawer) unmount; the row is gone.
    await waitFor(() => expect(screen.queryByText("cardiac fibrosis")).toBeNull());

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

describe("MatchaPanel — #1780 Phase 2 culled chip-picker", () => {
  const CULLED: CulledConcept[] = [
    { term: "organoids", kind: "method", centrality: 0.5 },
    { term: "single-cell RNA-seq", kind: "concept", centrality: 0.45 },
  ];

  it("renders the culled tail as kind-coloured 'Also detected' chips", async () => {
    stubFetch({ concepts: CONCEPTS, candidates: THREE, culled: CULLED });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    expect(screen.getByText("Also detected")).toBeTruthy();
    const method = screen.getByRole("button", { name: "Add organoids to the search" });
    const concept = screen.getByRole("button", { name: "Add single-cell RNA-seq to the search" });
    // Kind drives the colour token — purple method / blue concept, matching the rail + paste marks.
    expect(method.className).toContain("--color-facet-method-fill");
    expect(concept.className).toContain("--color-facet-topic-fill");
  });

  it("clicking a chip re-runs the match with the term in `include`", async () => {
    const fetchMock = stubFetch({ concepts: CONCEPTS, candidates: THREE, culled: CULLED });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");
    expect(rankCalls(fetchMock)).toBe(1); // the initial search sent include: []

    fireEvent.click(screen.getByRole("button", { name: "Add organoids to the search" }));
    await waitFor(() => expect(rankCalls(fetchMock)).toBe(2));

    const posts = fetchMock.mock.calls.filter(
      (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
    );
    const body = JSON.parse(String((posts[posts.length - 1][1] as { body: string }).body));
    expect(body.include).toEqual(["organoids"]); // force-included; NOT a scoring override
    expect(body.description).toBe("CAR T");
  });

  it("shows no chip section when the response carries no culled tail", async () => {
    stubFetch({ concepts: CONCEPTS, candidates: THREE }); // culled omitted ⇒ []
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");
    expect(screen.queryByText("Also detected")).toBeNull();
  });

  it("accumulates include across multiple adds (append, not replace)", async () => {
    const fetchMock = stubFetch({ concepts: CONCEPTS, candidates: THREE, culled: CULLED });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    fireEvent.click(screen.getByRole("button", { name: "Add organoids to the search" }));
    await waitFor(() => expect(rankCalls(fetchMock)).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Add single-cell RNA-seq to the search" }));
    await waitFor(() => expect(rankCalls(fetchMock)).toBe(3));

    const posts = fetchMock.mock.calls.filter(
      (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
    );
    const body = JSON.parse(String((posts[posts.length - 1][1] as { body: string }).body));
    // Both adds present, in click order — kills a "replace instead of append" regression.
    expect(body.include).toEqual(["organoids", "single-cell RNA-seq"]);
  });

  it("a Re-run after adding a chip preserves the included term", async () => {
    const fetchMock = stubFetch({ concepts: CONCEPTS, candidates: THREE, culled: CULLED });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Add organoids to the search" }));
    await waitFor(() => expect(rankCalls(fetchMock)).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "Re-run match" }));
    await waitFor(() => expect(rankCalls(fetchMock)).toBe(3));
    const posts = fetchMock.mock.calls.filter(
      (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
    );
    const body = JSON.parse(String((posts[posts.length - 1][1] as { body: string }).body));
    // The Re-run kept the officer's add — pins the `{ include: included }` wiring on the Re-run button.
    expect(body.include).toEqual(["organoids"]);
  });

  it("disables the chips and shows the cap note at the term ceiling", async () => {
    // The server caps on the PRE-cluster term count; the client reads it from `members`, NOT
    // `concepts.length` (which under-counts after MeSH merges). Four concepts × 3 members = 12 raw
    // terms ⇒ exactly at MAX_TERMS_WITH_INCLUDES. Regresses if atCap goes back to `concepts.length`.
    const capped: MatchaConcept[] = ["c1", "c2", "c3", "c4"].map((t) => ({
      term: t,
      kind: "concept",
      members: [t, `${t}a`, `${t}b`],
      centrality: 0.5,
      weightFactor: 1,
    }));
    stubFetch({ concepts: capped, candidates: THREE, culled: CULLED });
    render(<MatchaPanel />);
    fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
    await screen.findByText("Alice Alpha");

    const chip = screen.getByRole("button", {
      name: "Add organoids to the search",
    }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(screen.getByText(/maximum terms reached/i)).toBeTruthy();
  });
});
