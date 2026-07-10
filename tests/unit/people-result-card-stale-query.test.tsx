/**
 * #1366 evidence-line-stale-cache — result cards are keyed by cwid (search page
 * `<li key={h.cwid}>`) and PERSIST across client-side query navigations. A
 * scholar that reappears under a NEW query must not show the previous query's
 * expanded exemplar papers, and a fresh exemplar fetch must not carry the
 * previous query's `exclude` pmids. Baking `qParam` into each EvidenceLine's key
 * (+ a per-query `claimedPmids` Set) makes the evidence identity part of the reset.
 *
 * Mirrors the mock idiom of people-result-card-method-exemplar.test.tsx (avatar
 * mock, makeHit, stubbed fetch returning a `{ pubs, total }` exemplar payload,
 * chevron accessible-name /key papers/i).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/scholar/headshot-avatar", () => ({
  HeadshotAvatar: () => <div data-testid="avatar" />,
}));

import { PeopleResultCard } from "@/components/search/people-result-card";
import type { PeopleHit } from "@/lib/api/search";

function makeHit(overrides: Partial<PeopleHit>): PeopleHit {
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
    grantCount: 0,
    hasActiveGrants: false,
    identityImageEndpoint: "https://example.com/abc1234.png",
    ...overrides,
  };
}

const baseProps = {
  position: 0,
  total: 1,
  filters: { deptDiv: [], personType: [], activity: [] },
};

// The SAME method family matches both queries (a family is query-agnostic; the
// exemplar loader uses `&q=` to prefer the query's papers), so the scholar
// reappears on the same evidence line across the navigation — the persistence
// the bug needs.
const methodHit = makeHit({
  evidence: { kind: "method", family: "Confocal microscopy", tools: ["CCM"] },
});

const chevron = () => screen.getByRole("button", { name: /key papers/i });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PeopleResultCard — stale evidence cache reset on query change (#1366)", () => {
  it("drops the prior query's exemplar papers and does not carry its exclude when re-queried", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          pubs: [{ pmid: "C1", title: "Cancer exemplar paper", year: 2021 }],
          total: 5,
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          pubs: [{ pmid: "D1", title: "Diabetes exemplar paper", year: 2022 }],
          total: 3,
        }),
      });
    vi.stubGlobal("fetch", fetchFn);

    const { rerender } = render(<PeopleResultCard {...baseProps} q="cancer" hit={methodHit} />);
    fireEvent.click(chevron()); // expand → first exemplar fetch (cancer)
    await waitFor(() => expect(screen.getByText(/Cancer exemplar paper/)).toBeTruthy());

    // Same card instance (cwid unchanged) re-rendered under a new query — the
    // persisted `<li key={h.cwid}>` on a client-side query navigation.
    rerender(<PeopleResultCard {...baseProps} q="diabetes" hit={methodHit} />);

    // The EvidenceLine remounts (key includes qParam) → collapsed, state reset:
    // the previous query's paper is gone even before re-expanding.
    expect(screen.queryByText(/Cancer exemplar paper/)).toBeNull();

    // Re-expand under the new query → a fresh fetch keyed to "diabetes" whose
    // exclude does not carry the cancer pmid.
    fireEvent.click(chevron());
    await waitFor(() => expect(screen.getByText(/Diabetes exemplar paper/)).toBeTruthy());

    const secondUrl = fetchFn.mock.calls[1][0] as string;
    expect(secondUrl).toContain("q=diabetes");
    expect(secondUrl).not.toContain("C1");
  });
});
