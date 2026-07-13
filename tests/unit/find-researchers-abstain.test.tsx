/**
 * `components/edit/find-researchers.tsx` — the weak-coverage banner (#1633).
 *
 * The matcher API returns `abstain: true` when the top matches all fall below
 * `GRANT_MATCHER_ABSTAIN_FLOOR`. The screen must say so: a ranked list that
 * reads as confident when every match is weak is the failure mode the floor
 * exists to prevent. `abstain` is always false when the floor is off, so the
 * banner is a strict add — the flag-off case is the `false` test below.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/edit/find-researchers",
  useSearchParams: () => new URLSearchParams("opp=wcm_curated%3Atest-abc123"),
}));

import { FindResearchers } from "@/components/edit/find-researchers";

const SCHOLAR = {
  cwid: "abc1234",
  slug: "ada-lovelace",
  preferredName: "Ada Lovelace",
  careerStage: "assistant" as const,
  title: "Assistant Professor",
  department: "Medicine",
  axes: { topicFit: 0.12, stageAppeal: 0.4 },
  topicContributions: [{ topicId: "t1", contribution: 0.12, pubCount: 2 }],
  defaultScore: 0.12,
};

function matchView(abstain: boolean) {
  return {
    opportunityId: "wcm_curated:test-abc123",
    count: 1,
    abstain,
    meanTopRel: abstain ? 0.04 : 0.6,
    opportunity: null,
    matchingOn: [],
    topicLabels: { t1: "Cardiology" },
    results: [SCHOLAR],
  };
}

function mockFetch(abstain: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => matchView(abstain) })),
  );
}

const BANNER = /no strong wcm match/i;

describe("FindResearchers — weak-coverage banner", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("renders the banner when the API abstains", async () => {
    mockFetch(true);
    render(<FindResearchers />);
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());
    // Still shows the ranking underneath — abstain warns, it does not suppress.
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });

  it("renders no banner when the API does not abstain (incl. floor off)", async () => {
    mockFetch(false);
    render(<FindResearchers />);
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeTruthy());
    expect(screen.queryByText(BANNER)).toBeNull();
  });
});
