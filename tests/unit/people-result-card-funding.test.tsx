/**
 * Generalized evidence rows — the Scholars card's lazy "Funding" evidence row and
 * the opt-in publications flavor badge, both gated by `evidenceRows` (the
 * server-resolved SEARCH_EVIDENCE_ROWS):
 *   - a scholar with grantCount > 0 + an active query eager-fetches /grants and shows
 *     `[Funding] N grant(s) ⌄` ONLY when ≥1 matched (hide-when-empty, §4.1/§5);
 *   - expanding reveals the "Key funding" records (title · sponsor · years);
 *   - no fetch when the flag is off, the query is empty, or grantCount is 0;
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

describe("PeopleResultCard — lazy Funding evidence row", () => {
  it("eager-fetches /grants and shows the Funding row when ≥1 grant matched", async () => {
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
      total: 1,
    });
    render(<PeopleResultCard {...base} evidenceRows hit={makeHit({ evidence: pubEvidence() })} />);

    await waitFor(() => expect(screen.getByText("Funding")).toBeTruthy());
    // Single-evidence (non-stacked) path is unchanged by the tiered redesign: the
    // Funding row keeps the full badge — "N of M grants mention 'query'" (#1361).
    expect(screen.getByText(/1 of 3 grants mention/)).toBeTruthy();
    expect(screen.getByText("“diabetes”").tagName).toBe("STRONG");
    expect(
      fetchFn.mock.calls.some((c) => c[0] === "/api/scholar/abc1234/grants?q=diabetes"),
    ).toBe(true);

    // expand → "Key funding" records
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    expect(screen.getByText(/Beta-cell regeneration in T2D/)).toBeTruthy();
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
      total: 1,
    });
    const { container } = render(
      <PeopleResultCard {...base} evidenceRows hit={makeHit({ evidence: pubEvidence() })} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /key funding/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    // highlightedTitleHtml keeps a real <mark> (styled as the light-red pill).
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("diabetes");
  });

  it("Option A — the KEY FUNDING disclosure header shows the matching count (top N of M)", async () => {
    mockFetch({
      grants: [
        { projectId: "p1", title: "Grant one", sponsor: "NIH", startYear: 2021, endYear: 2025, isActive: true },
      ],
      total: 8,
    });
    render(<PeopleResultCard {...base} evidenceRows hit={makeHit({ evidence: pubEvidence() })} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /key funding/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    // 1 of 8 surfaced grants shown in the disclosure (the rest are "+7 more in profile").
    expect(screen.getByText("1 of 8")).toBeTruthy();
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
      total: 2,
      strength: "tagged",
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
        hit={makeHit({ evidence: pubEvidence() })}
      />,
    );
    await waitFor(() => expect(screen.getByText("Funding")).toBeTruthy());
    // Single-evidence (non-stacked): the full "tagged" line — normal-weight count
    // prefix + the underlined, semibold CONCEPT term (unchanged by the redesign).
    expect(screen.getByText(/2 of 3 grants tagged/)).toBeTruthy();
    const term = screen.getByText("Heart Arrest");
    expect(term.tagName).toBe("STRONG");
    expect(term.className).toMatch(/underline/);
    // the page-resolved concept is threaded into the /grants fetch
    expect(
      fetchFn.mock.calls.some(
        (c) => String(c[0]).includes("descriptorUis=D006323") && String(c[0]).includes("label=Heart"),
      ),
    ).toBe(true);
  });

  it("hides the Funding row entirely when no grant matched (never 0 of N)", async () => {
    const fetchFn = mockFetch({ grants: [], total: 0 });
    render(<PeopleResultCard {...base} evidenceRows hit={makeHit({ evidence: pubEvidence() })} />);
    await waitFor(() =>
      expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("/grants?q="))).toBe(true),
    );
    expect(screen.queryByText("Funding")).toBeNull();
    expect(screen.queryByRole("button", { name: /key funding/i })).toBeNull();
  });

  it("never fetches /grants when the flag is off", async () => {
    const fetchFn = mockFetch({ grants: [], total: 0 });
    render(<PeopleResultCard {...base} hit={makeHit({ evidence: pubEvidence() })} />);
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.queryByText("Funding")).toBeNull();
  });

  it("never fetches /grants for a scholar with no grants", async () => {
    const fetchFn = mockFetch({ grants: [], total: 0 });
    render(
      <PeopleResultCard {...base} evidenceRows hit={makeHit({ grantCount: 0, evidence: pubEvidence() })} />,
    );
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never fetches /grants on the no-query Browse page", async () => {
    const fetchFn = mockFetch({ grants: [], total: 0 });
    render(<PeopleResultCard {...base} q="" evidenceRows hit={makeHit({ evidence: pubEvidence() })} />);
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("PeopleResultCard — publications flavor badge (§4.7, Scholars card only)", () => {
  it("badges a literal mention as Keyword when the flag is on", () => {
    mockFetch({ grants: [], total: 0 });
    render(
      <PeopleResultCard {...base} evidenceRows hit={makeHit({ grantCount: 0, evidence: pubEvidence() })} />,
    );
    expect(screen.getByText("Keyword")).toBeTruthy();
  });

  it("badges a tagged match as Concept (a MeSH descriptor is a concept, not a research area)", () => {
    mockFetch({ grants: [], total: 0 });
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
    mockFetch({ grants: [], total: 0 });
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

  it("leaves the pub row un-badged (muted) when the flag is off", () => {
    mockFetch({ grants: [], total: 0 });
    render(<PeopleResultCard {...base} hit={makeHit({ grantCount: 0, evidence: pubEvidence() })} />);
    expect(screen.queryByText("Keyword")).toBeNull();
    expect(screen.getByText(/publications mention/)).toBeTruthy();
  });
});

describe("PeopleResultCard — Funding supersedes the generic no-match fallback", () => {
  const oneGrant = {
    grants: [{ projectId: "p1", title: "Pediatric trial", sponsor: "NIH", startYear: 2022, endYear: 2025 }],
    total: 1,
  };

  it("drops the '— no specific match —' fallback when a grant matched", async () => {
    mockFetch(oneGrant);
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ evidence: { kind: "none" } as PeopleHit["evidence"] })}
      />,
    );
    await waitFor(() => expect(screen.getByText("Funding")).toBeTruthy());
    // the honest-empty identity fallback is gone — the Funding row IS the match
    expect(screen.queryByText(/no specific match for this query/i)).toBeNull();
  });

  it("#1366 — PROMOTES Funding to the full primary badge when it is the only signal", async () => {
    mockFetch(oneGrant);
    const { container } = render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ evidence: { kind: "none" } as PeopleHit["evidence"] })}
      />,
    );
    await waitFor(() => expect(screen.getByText("Funding")).toBeTruthy());
    // No first-class pub line ⇒ Funding LEADS with the full badge ("N of M grants
    // mention 'query'" + semibold query term), NOT a demoted dot, and there is no
    // "Also matched" group to subordinate it under.
    expect(screen.getByText(/1 of 3 grants mention/)).toBeTruthy();
    expect(screen.getByText("“diabetes”").tagName).toBe("STRONG");
    expect(container.textContent).not.toContain("Also matched");
  });

  it("keeps the '— no specific match —' fallback when NO grant matched", async () => {
    const fetchFn = mockFetch({ grants: [], total: 0 });
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({ evidence: { kind: "none" } as PeopleHit["evidence"] })}
      />,
    );
    await waitFor(() =>
      expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("/grants?q="))).toBe(true),
    );
    expect(screen.getByText(/no specific match for this query/i)).toBeTruthy();
    expect(screen.queryByText("Funding")).toBeNull();
  });

  it("does NOT suppress a real publications match — both rows coexist", async () => {
    mockFetch(oneGrant);
    render(<PeopleResultCard {...base} evidenceRows hit={makeHit({ evidence: pubEvidence() })} />);
    await waitFor(() => expect(screen.getByText("Funding")).toBeTruthy());
    // the real match reason still renders alongside the Funding row
    expect(screen.getByText(/publications mention/)).toBeTruthy();
  });
});

describe("PeopleResultCard — #1366 follow-up tiered 'Also matched' (stacked evidenceLines)", () => {
  const oneGrant = {
    grants: [{ projectId: "p1", title: "Pediatric trial", sponsor: "NIH", startYear: 2022, endYear: 2025 }],
    total: 1,
  };
  const stackedHit = (over: Record<string, unknown> = {}) =>
    makeHit({
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
    await waitFor(() => expect(screen.getByText("Funding")).toBeTruthy());
    // the primary keeps the full Method badge...
    expect(screen.getByText("Method")).toBeTruthy();
    // ...and the demoted signals sit under "Also matched", Funding as a compact dot:
    // "Funding · mentions 'diabetes' · N of M grants".
    expect(screen.getByText("Also matched")).toBeTruthy();
    expect(container.textContent).toMatch(/mentions\s*“diabetes”/);
    expect(container.textContent).toMatch(/1 of 3 grants/);
    // the demoted dot still expands to the KEY FUNDING records.
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    expect(screen.getByText(/Pediatric trial/)).toBeTruthy();
  });

  it("a single stacked line with grants still shows the 'Also matched' Funding dot", async () => {
    mockFetch(oneGrant);
    render(
      <PeopleResultCard
        {...base}
        evidenceRows
        hit={makeHit({
          evidenceLines: [
            { kind: "method", family: "CRISPR genome editing", tools: [], count: 3 },
          ] as PeopleHit["evidenceLines"],
        })}
      />,
    );
    await waitFor(() => expect(screen.getByText("Funding")).toBeTruthy());
    expect(screen.getByText("Also matched")).toBeTruthy();
  });
});
