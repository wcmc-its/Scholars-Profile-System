/**
 * PersonPopover — the mentee co-pubs jump action (#184 / #1514).
 *
 * The "See N co-pubs →" primary action links to the bookmarkable pairwise page
 * `/scholars/{mentorSlug}/co-pubs/{menteeCwid}`, built from the MENTOR's slug
 * (`contextScholarSlug`) + the hovered mentee's cwid — and ONLY on the mentee
 * surface, since `getMentorMenteePair` 404s for a non-mentee pair.
 *
 * The Radix `hover-card` is mocked to click-to-open (mirrors
 * person-popover-method-families.test.tsx) so the fetch fires deterministically.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";

vi.mock("@/components/ui/hover-card", () => ({
  HoverCard: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "hovercard", onClick: () => onOpenChange?.(true) },
      children,
    ),
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => children,
  HoverCardContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "hovercard-content" }, children),
}));

import { PersonPopover } from "@/components/scholar/person-popover";

type ApiPayload = Parameters<typeof JSON.stringify>[0];

const payload = (over: Record<string, unknown> = {}): ApiPayload => ({
  header: {
    cwid: "mentee1",
    preferredName: "Sam Mentee",
    postnominal: null,
    primaryTitle: "Postdoctoral Fellow",
    primaryDepartment: "Medicine",
    slug: "sam-mentee",
    identityImageEndpoint: "/headshot/mentee1",
    totalPubCount: 12,
    totalGrantCount: 0,
    topTopic: null,
  },
  authorship: null,
  coPubs: { count: 5 },
  topicRank: null,
  recentPubs: [],
  recentGrants: [],
  topSponsor: null,
  methodFamilies: [],
  ...over,
});

function mockFetch(p: ApiPayload) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => p,
  })) as unknown as typeof fetch;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("PersonPopover — mentee co-pubs jump", () => {
  it("mentee surface links to /scholars/{mentorSlug}/co-pubs/{menteeCwid}", async () => {
    mockFetch(payload());
    render(
      <PersonPopover
        cwid="mentee1"
        surface="mentee"
        contextScholarCwid="mentor1"
        contextScholarSlug="dr-mentor"
      >
        <a href="#">Sam</a>
      </PersonPopover>,
    );
    fireEvent.click(screen.getByTestId("hovercard"));
    const link = await screen.findByText("See 5 co-pubs →");
    // mentor slug from contextScholarSlug, mentee cwid from the popover target —
    // NOT the old self-referential `/scholars/{menteeSlug}/co-pubs?with={menteeCwid}`.
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "/scholars/dr-mentor/co-pubs/mentee1",
    );
  });

  it("co-author surface offers no co-pubs jump (no pairwise page for a non-mentee pair)", async () => {
    mockFetch(payload());
    render(
      <PersonPopover
        cwid="mentee1"
        surface="co-author"
        contextScholarCwid="profile1"
        contextScholarSlug="dr-profile"
      >
        <a href="#">Sam</a>
      </PersonPopover>,
    );
    fireEvent.click(screen.getByTestId("hovercard"));
    // Card opened (View profile renders) but no "co-pubs →" action link.
    expect(await screen.findByText("View profile")).toBeTruthy();
    expect(screen.queryByText(/co-pubs? →/)).toBeNull();
  });

  it("mentee with zero co-pubs shows no jump", async () => {
    mockFetch(payload({ coPubs: { count: 0 } }));
    render(
      <PersonPopover
        cwid="mentee1"
        surface="mentee"
        contextScholarCwid="mentor1"
        contextScholarSlug="dr-mentor"
      >
        <a href="#">Sam</a>
      </PersonPopover>,
    );
    fireEvent.click(screen.getByTestId("hovercard"));
    expect(await screen.findByText("View profile")).toBeTruthy();
    expect(screen.queryByText(/co-pubs? →/)).toBeNull();
  });
});
