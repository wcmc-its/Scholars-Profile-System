/**
 * Scholars card "Funding" evidence row + the opt-in publications flavor badge, both
 * gated by `evidenceRows` (server-resolved SEARCH_EVIDENCE_ROWS).
 *
 * #1412 — the row's presence + `N of M` count + tagged/mention strength are EAGER, read
 * off the hit (`grantMatchCount` / `grantMatchTaggedCount`) which a single page-level funding
 * agg precomputes; there is NO per-card mount fetch. The top-N grant RECORDS stay lazy —
 * `/grants` is called only when the disclosure opens (chevron for the full badge, the
 * "Also matched" umbrella for a demoted row). So:
 *   - a scholar with `grantMatchCount > 0` shows `[Funding] N of M grants … ⌄`
 *     immediately (hide-when-empty, §4.1/§5), with no fetch;
 *   - expanding fetches + reveals the "Key funding" records (title · sponsor · years);
 *   - no `grantMatchCount` (flag off / no match / no grants / no query) ⇒ no row,
 *     and no fetch ever fires;
 *   - with the flag on the publications reason row is a flavor pill
 *     (mention→Keyword, tagged→Concept, concept→Concept); off ⇒ muted, no pill.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/scholar/headshot-avatar", () => ({
  HeadshotAvatar: () => <div data-testid="avatar" />,
}));

import { PeopleResultCard } from "@/components/search/people-result-card";
import type { PeopleHit } from "@/lib/api/search";

function makeHit(over: Partial<PeopleHit>): PeopleHit {
  return {
    cwid: "abc1234",
    slug: "jane-doe",
    preferredName: "Jane Doe",
    primaryTitle: "Professor of Medicine",
    primaryDepartment: "Medicine",
    deptName: "Medicine",
    divisionName: null,
    roleCategory: "full_time_faculty",
    pubCount: 100,
    grantCount: 3,
    hasActiveGrants: true,
    identityImageEndpoint: "https://example.com/abc1234.png",
    ...over,
  };
}

const base = {
  position: 0,
  q: "diabetes",
  total: 1,
  filters: { deptDiv: [], personType: [], activity: [] },
};

// The /grants records payload (the ONLY thing the route now supplies to the card — count
// and strength come off the hit). Fired on expand.
function mockFetch(payload: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function pubEvidence(over: Record<string, unknown> = {}): PeopleHit["evidence"] {
  return {
    kind: "publications",
    strength: "mention",
    text: "2 of 100 publications mention “diabetes”",
    count: 2,
    ...over,
  } as PeopleHit["evidence"];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PeopleResultCard — Funding evidence row (eager count, lazy records)", () => {
  it("shows the Funding row + count eagerly from the hit; fetches records only on expand", async () => {
    const fetchFn = mockFetch({
      grants: [
        {
          projectId: "p1",
          title: "Beta-cell regeneration in T2D",
          sponsor: "NIH / NIDDK",
          startYear: 2021,
          endYear: 2025,
          isActive: true,
        },
      ],
    });
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ grantMatchCount: 1, evidence: pubEvidence() })}
      />,
    );

    // Eager: the row + count-first line render immediately, NO fetch on mount.
    expect(screen.getByText("Funding")).toBeTruthy();
    expect(document.body.textContent).toMatch(/1 of 3 grants mention/);
    expect(screen.getByText("“diabetes”").tagName).toBe("SPAN");
    expect(fetchFn).not.toHaveBeenCalled();

    // Expand → records fetched from /grants and shown.
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    expect(
      fetchFn.mock.calls.some((c) => c[0] === "/api/scholar/abc1234/grants?q=diabetes"),
    ).toBe(true);
    expect(await screen.findByText(/Beta-cell regeneration in T2D/)).toBeTruthy();
    expect(screen.getByText(/NIH \/ NIDDK/)).toBeTruthy();
  });

  it("#1359 — marks the matched term in a KEY FUNDING grant title when a highlight is present", async () => {
    mockFetch({
      grants: [
        {
          projectId: "p1",
          title: "Beta-cell regeneration in diabetes",
          titleHighlight: "Beta-cell regeneration in <mark>diabetes</mark>",
          sponsor: "NIH / NIDDK",
          startYear: 2021,
          endYear: 2025,
          isActive: true,
        },
      ],
    });
    const { container } = render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ grantMatchCount: 1, evidence: pubEvidence() })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    // highlightedTitleHtml keeps a real <mark> (styled as the light-red pill).
    await waitFor(() => expect(container.querySelector("mark")).toBeTruthy());
    expect(container.querySelector("mark")?.textContent).toBe("diabetes");
  });

  it("the KEY FUNDING disclosure header carries no inline count (total via '+N more')", async () => {
    mockFetch({
      grants: [
        { projectId: "p1", title: "Grant one", sponsor: "NIH", startYear: 2021, endYear: 2025, isActive: true },
      ],
    });
    // grantMatchCount 8, one record returned ⇒ "+7 more in profile".
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ grantMatchCount: 8, grantCount: 8, evidence: pubEvidence() })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    await screen.findByText(/Grant one/);
    // Sentence-case subhead, no "1 of 8" count (approved); the rest live in "+7 more".
    expect(screen.queryByText("1 of 8")).toBeNull();
    expect(screen.getByText(/\+7 more in profile/)).toBeTruthy();
  });

  it("#1359 — concept-tagged grants read 'N of M grants tagged <Concept>' (underlined term, concept threaded)", async () => {
    const fetchFn = mockFetch({
      grants: [
        {
          projectId: "p1",
          title: "Cardiac arrest survival",
          sponsor: "NIH",
          startYear: 2022,
          endYear: 2026,
          isActive: true,
        },
      ],
    });
    render(
      <PeopleResultCard
        {...base}
        q="cardiac arrest"
        evidenceRows
        keyPaperConfig={{
          descriptorUis: ["D006323"],
          contentQuery: "cardiac arrest",
          conceptLabel: "Heart Arrest",
        }}
        // ALL matched grants are tagged (2 of 2) — the unmixed case, whose rendering #1732
        // deliberately leaves byte-identical.
        hit={makeHit({ grantMatchCount: 2, grantMatchTaggedCount: 2, evidence: pubEvidence() })}
      />,
    );
    // #1381 count-first: emphasized count + muted "of 3 grants tagged" + the underlined
    // CONCEPT term (a span now, not <strong>) — all eager from the hit.
    expect(document.body.textContent).toMatch(/2 of 3 grants tagged/);
    const term = screen.getByText("Heart Arrest");
    expect(term.tagName).toBe("SPAN");
    expect(term.className).toMatch(/underline/);

    // On expand the page-resolved concept is threaded into the /grants records fetch.
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    await screen.findByText(/Cardiac arrest survival/);
    expect(
      fetchFn.mock.calls.some(
        (c) => String(c[0]).includes("descriptorUis=D006323") && String(c[0]).includes("label=Heart"),
      ),
    ).toBe(true);
  });

  it("#1732 — a MIXED set states BOTH clauses, and they add up; the tagged count NEVER captions the OR total", async () => {
    // THE BUG THIS REPLACES, reproduced from prod. The funding query is an OR — literal
    // text OR concept tag — so `grantMatchCount` counts BOTH kinds. The card captioned
    // that OR total "tagged <Concept>" whenever ANY grant carried the tag, and rendered:
    //
    //     "5 of 24 grants tagged Immunoconjugates"     <- for ONE tagged grant
    //
    // The other four were text mentions, and the two ranked ABOVE the tagged one were
    // PROSTATE cancer awards. A false count, on the public People card.
    //
    // 5 matched, 1 tagged ⇒ the line must lead with 1, and account for the other 4.
    mockFetch({ grants: [] });
    render(
      <PeopleResultCard
        {...base}
        q="antibody-drug conjugate"
        evidenceRows
        keyPaperConfig={{
          descriptorUis: ["D018796"],
          contentQuery: "antibody-drug conjugate",
          conceptLabel: "Immunoconjugates",
        }}
        hit={makeHit({
          grantMatchCount: 5,
          grantMatchTaggedCount: 1,
          grantCount: 24,
          evidence: pubEvidence(),
        })}
      />,
    );
    const text = document.body.textContent ?? "";

    // The lead number is the TAGGED count, under the "tagged" relation.
    expect(text).toMatch(/1 of 24 grants tagged/);
    // The remainder is stated, not silently dropped.
    expect(text).toMatch(/4 mention/);
    // And the false claim is gone: the OR total is never captioned "tagged".
    expect(text).not.toMatch(/5 of 24 grants tagged/);

    // The clauses PARTITION the matched set: 1 tagged + 4 mention-only = 5 matched.
    const tagged = Number(text.match(/(\d+) of 24 grants tagged/)![1]);
    const mention = Number(text.match(/(\d+) mention/)![1]);
    expect(tagged + mention).toBe(5);
  });

  it("#1732 — an all-mention set is unchanged: no tagged clause, the OR total leads", async () => {
    mockFetch({ grants: [] });
    render(
      <PeopleResultCard
        {...base}
        q="antibody-drug conjugate"
        evidenceRows
        keyPaperConfig={{
          descriptorUis: ["D018796"],
          contentQuery: "antibody-drug conjugate",
          conceptLabel: "Immunoconjugates",
        }}
        hit={makeHit({
          grantMatchCount: 5,
          grantMatchTaggedCount: 0,
          grantCount: 24,
          evidence: pubEvidence(),
        })}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/5 of 24 grants mention/);
    // Nothing is claimed as tagged, and no orphan "N mention" clause is appended.
    expect(text).not.toMatch(/grants tagged/);
    expect(text).not.toMatch(/· \d+ mention/);
  });

  it("hides the Funding row entirely when no grant matched (no grantMatchCount, no fetch)", async () => {
    const fetchFn = mockFetch({ grants: [] });
    render(<PeopleResultCard {...base} evidenceRows hit={makeHit({ evidence: pubEvidence() })} />);
    await Promise.resolve();
    expect(screen.queryByText("Funding")).toBeNull();
    expect(screen.queryByRole("button", { name: /key funding/i })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never fetches /grants when the flag is off (no eager count is emitted)", async () => {
    const fetchFn = mockFetch({ grants: [] });
    render(<PeopleResultCard {...base} hit={makeHit({ evidence: pubEvidence() })} />);
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.queryByText("Funding")).toBeNull();
  });

  it("never fetches /grants for a scholar with no matching grants", async () => {
    const fetchFn = mockFetch({ grants: [] });
    render(
      <PeopleResultCard {...base} evidenceRows hit={makeHit({ grantCount: 0, evidence: pubEvidence() })} />,
    );
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never fetches /grants on the no-query Browse page", async () => {
    const fetchFn = mockFetch({ grants: [] });
    render(<PeopleResultCard {...base} q="" evidenceRows hit={makeHit({ evidence: pubEvidence() })} />);
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("PeopleResultCard — publications flavor badge (§4.7, Scholars card only)", () => {
  it("badges a literal mention as Keyword when the flag is on", () => {
    mockFetch({ grants: [] });
    render(
      <PeopleResultCard {...base} evidenceRows hit={makeHit({ grantCount: 0, evidence: pubEvidence() })} />,
    );
    expect(screen.getByText("Keyword")).toBeTruthy();
  });

  it("badges a tagged match as Concept (a MeSH descriptor is a concept, not a research area)", () => {
    mockFetch({ grants: [] });
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({
          grantCount: 0,
          evidence: pubEvidence({ strength: "tagged", text: "30 of 757 publications tagged Diabetes" }),
        })}
      />,
    );
    expect(screen.getByText("Concept")).toBeTruthy();
  });

  it("badges a concept match as Concept", () => {
    mockFetch({ grants: [] });
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({
          grantCount: 0,
          evidence: pubEvidence({ strength: "concept", text: "tagged Insulin Resistance" }),
        })}
      />,
    );
    expect(screen.getByText("Concept")).toBeTruthy();
  });

  it("renders the pub row as a dot + type word — the dot layout is not flag-gated", () => {
    mockFetch({ grants: [] });
    render(<PeopleResultCard {...base} hit={makeHit({ grantCount: 0, evidence: pubEvidence() })} />);
    // #1381 — the primary is the count-first dot layout regardless of SEARCH_EVIDENCE_ROWS;
    // the old muted MatchReason row and the bordered flavor pill are both gone.
    expect(screen.getByText("Keyword")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("rounded-[5px]");
    expect(screen.getByText(/publications mention/)).toBeTruthy();
  });
});

describe("PeopleResultCard — Funding supersedes the generic no-match fallback", () => {
  const oneGrant = {
    grants: [{ projectId: "p1", title: "Pediatric trial", sponsor: "NIH", startYear: 2022, endYear: 2025 }],
  };

  it("drops the '— no specific match —' fallback when a grant matched", () => {
    mockFetch(oneGrant);
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ grantMatchCount: 1, evidence: { kind: "none" } as PeopleHit["evidence"] })}
      />,
    );
    expect(screen.getByText("Funding")).toBeTruthy();
    // the honest-empty identity fallback is gone — the Funding row IS the match
    expect(screen.queryByText(/no specific match for this query/i)).toBeNull();
  });

  it("#1366 — PROMOTES Funding to the full primary badge when it is the only signal", () => {
    mockFetch(oneGrant);
    const { container } = render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ grantMatchCount: 1, evidence: { kind: "none" } as PeopleHit["evidence"] })}
      />,
    );
    // No first-class pub line ⇒ Funding LEADS with the count-first dot layout ("N of M
    // grants mention 'query'" + quoted query span), NOT a demoted dot, and there is no
    // "Also matched" group to subordinate it under.
    expect(container.textContent).toMatch(/1 of 3 grants mention/);
    expect(screen.getByText("“diabetes”").tagName).toBe("SPAN");
    expect(container.textContent).not.toContain("Also matched");
  });

  it("keeps the '— no specific match —' fallback when NO grant matched (no fetch)", async () => {
    const fetchFn = mockFetch({ grants: [] });
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ evidence: { kind: "none" } as PeopleHit["evidence"] })}
      />,
    );
    await Promise.resolve();
    expect(screen.getByText(/no specific match for this query/i)).toBeTruthy();
    expect(screen.queryByText("Funding")).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does NOT suppress a real publications match — both rows coexist", () => {
    mockFetch(oneGrant);
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ grantMatchCount: 1, evidence: pubEvidence() })}
      />,
    );
    expect(screen.getByText("Funding")).toBeTruthy();
    // the real match reason still renders alongside the Funding row
    expect(screen.getByText(/publications mention/)).toBeTruthy();
  });
});

describe("PeopleResultCard — #1366 follow-up tiered 'Also matched' (stacked evidenceLines)", () => {
  const oneGrant = {
    grants: [{ projectId: "p1", title: "Pediatric trial", sponsor: "NIH", startYear: 2022, endYear: 2025 }],
  };
  const stackedHit = (over: Record<string, unknown> = {}) =>
    makeHit({
      grantMatchCount: 1,
      evidenceLines: [
        { kind: "method", family: "CRISPR genome editing", tools: [], count: 3 },
        { kind: "topic", label: "Stem Cell & Regenerative Medicine", id: "stem", count: 2 },
      ] as PeopleHit["evidenceLines"],
      ...over,
    });

  it("leads with the primary badge and DEMOTES Funding into 'Also matched' as a dot row", async () => {
    mockFetch(oneGrant);
    const { container } = render(
      <PeopleResultCard {...base} evidenceRows hit={stackedHit()} />,
    );
    // the primary keeps the full Method badge...
    expect(screen.getByText("Method")).toBeTruthy();
    // ...and the demoted signals sit under "Also matched", collapsed by default.
    expect(screen.getByText("Also matched")).toBeTruthy();
    // expand the umbrella → the demoted Funding dot row: "mentions 'diabetes' · N of M".
    fireEvent.click(screen.getByRole("button", { name: /also matched/i }));
    expect(container.textContent).toMatch(/mentions\s*“diabetes”/);
    expect(container.textContent).toMatch(/1 of 3 grants/);
    // the demoted dot still expands to the KEY FUNDING records (fetched on this click).
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    expect(await screen.findByText(/Pediatric trial/)).toBeTruthy();
  });

  it("Part D collapse — the 'Also matched' group is a category summary line by default (counts/entities hidden)", () => {
    mockFetch(oneGrant);
    const { container } = render(<PeopleResultCard {...base} evidenceRows hit={stackedHit()} />);
    // the summary shows colored category labels for each secondary...
    expect(screen.getByRole("button", { name: /also matched/i })).toBeTruthy();
    expect(screen.getByText("Research area")).toBeTruthy();
    // ...but NOT the entities or counts (they mix denominators — see the collapse note).
    expect(screen.queryByText(/Stem Cell & Regenerative Medicine/)).toBeNull();
    expect(container.textContent).not.toMatch(/1 of 3 grants/);
    // and the per-row disclosures are hidden until expanded.
    expect(screen.queryByRole("button", { name: /key funding/i })).toBeNull();
  });

  it("Part D collapse — expanding the summary reveals the full lesser rows", () => {
    mockFetch(oneGrant);
    render(<PeopleResultCard {...base} evidenceRows hit={stackedHit()} />);
    fireEvent.click(screen.getByRole("button", { name: /also matched/i }));
    // the topic entity + funding count + disclosure now render.
    expect(screen.getByText(/Stem Cell & Regenerative Medicine/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /key funding/i })).toBeTruthy();
  });

  it("#1381 follow-up — a LONE secondary collapses under 'Also matched' and ONE click reveals its records", async () => {
    mockFetch(oneGrant);
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({
          grantMatchCount: 1,
          evidenceLines: [
            { kind: "method", family: "CRISPR genome editing", tools: [], count: 3 },
          ] as PeopleHit["evidenceLines"],
        })}
      />,
    );
    // ONE secondary (the funding dot; the method badge is the primary) still collapses
    // under the "Also matched" umbrella — the summary shows, the detail is hidden.
    expect(screen.getByRole("button", { name: /also matched/i })).toBeTruthy();
    expect(screen.queryByText(/mentions\s*“diabetes”/)).toBeNull();
    expect(screen.queryByText(/Pediatric trial/)).toBeNull();
    // and there is NO separate inner "key funding" chevron — the umbrella is the sole
    // control, so ONE click on it reveals the grant records directly (fetched now).
    expect(screen.queryByRole("button", { name: /key funding/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /also matched/i }));
    expect(screen.getByText(/mentions\s*“diabetes”/)).toBeTruthy();
    expect(await screen.findByText(/Pediatric trial/)).toBeTruthy();
  });

  it("#1381 follow-up — a lone LESSER LINE secondary also reveals its records in one click", async () => {
    mockFetch({ grants: [] });
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({
          grantCount: 0, // no funding ⇒ the sole secondary is the lesser pub line
          evidenceLines: [
            { kind: "method", family: "CRISPR genome editing", tools: [], count: 3 },
            {
              kind: "publications",
              strength: "mention",
              text: "2 of 100 publications mention",
              count: 2,
              pubs: [{ pmid: "1", title: "Inline lesser paper", year: 2020 }],
            },
          ] as PeopleHit["evidenceLines"],
        })}
      />,
    );
    // collapsed under "Also matched" (Keyword chip); the record is hidden until expand
    const umbrella = await screen.findByRole("button", { name: /also matched/i });
    expect(screen.queryByText(/Inline lesser paper/)).toBeNull();
    // ONE click on the umbrella reveals the lesser line's records (mounted pre-expanded)
    fireEvent.click(umbrella);
    expect(screen.getByText(/Inline lesser paper/)).toBeTruthy();
  });

  it("#1366 follow-up Part C — the demoted funding MENTION dot is FILLED green (bg-[#16a34a]), not bordered", () => {
    mockFetch(oneGrant);
    const { container } = render(<PeopleResultCard {...base} evidenceRows hit={stackedHit()} />);
    // expand the umbrella so the demoted funding dot renders.
    fireEvent.click(screen.getByRole("button", { name: /also matched/i }));
    const dots = Array.from(container.querySelectorAll("span.rounded-full")).map((d) => d.className);
    // the funding dot is filled green; no dot uses the old hollow bordered-green style.
    expect(dots.some((c) => c.includes("bg-[#16a34a]"))).toBe(true);
    expect(dots.some((c) => c.includes("border-[#16a34a]"))).toBe(false);
  });
});
