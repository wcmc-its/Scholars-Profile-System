/**
 * Generalized evidence rows — the Scholars card's lazy "Funding" evidence row and
 * the opt-in publications flavor badge, both gated by `evidenceRows` (the
 * server-resolved SEARCH_EVIDENCE_ROWS):
 *   - a scholar with grantCount > 0 + an active query eager-fetches /grants and shows
 *     `[Funding] N grant(s) ⌄` ONLY when ≥1 matched (hide-when-empty, §4.1/§5);
 *   - expanding reveals the "Key funding" records (title · sponsor · years);
 *   - no fetch when the flag is off, the query is empty, or grantCount is 0;
 *   - with the flag on the publications reason row is a flavor pill
 *     (mention→Keyword, tagged→Research area, concept→Concept); off ⇒ muted, no pill.
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
    // count-only claim, never "of Y" (§4.6)
    expect(screen.getByText(/^1 grant$/)).toBeTruthy();
    expect(
      fetchFn.mock.calls.some((c) => c[0] === "/api/scholar/abc1234/grants?q=diabetes"),
    ).toBe(true);

    // expand → "Key funding" records
    fireEvent.click(screen.getByRole("button", { name: /key funding/i }));
    expect(screen.getByText(/Beta-cell regeneration in T2D/)).toBeTruthy();
    expect(screen.getByText(/NIH \/ NIDDK/)).toBeTruthy();
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

  it("badges a tagged match as Research area", () => {
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
    expect(screen.getByText("Research area")).toBeTruthy();
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
