/**
 * #853 — PersonPopover "Prominent method families" section (client side).
 *
 * The server contract (gating on `contextMethods` + METHODS_LENS_PAGES, suppression,
 * ranking, cap) is covered by popover-context-route.test.ts + methods-scholar-families.test.ts.
 * These cases cover the CLIENT half:
 *   1. A `contextMethods` popover sends `contextMethods=1` and renders the section
 *      (label, family name, per-scholar count, /methods link).
 *   2. A plain top-scholar popover (no `contextMethods`) sends NO such param and
 *      renders NO section — proving topic-page top-scholar chips can't grow one.
 *   3. The family-page chip path (`TopScholarChip enablePopover contextMethods`)
 *      threads the flag through to the fetch.
 *
 * The thin Radix `hover-card` wrapper is mocked to a click-to-open pass-through so
 * the test drives `onOpenChange(true)` (which builds the fetch URL) and renders the
 * card body deterministically — without depending on Radix hover-intent timers.
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
import { TopScholarChip } from "@/components/topic/top-scholar-chip";
import type { TopScholarChipData } from "@/lib/api/topics";

type ApiPayload = Parameters<typeof JSON.stringify>[0];

const basePayload = (over: Record<string, unknown> = {}): ApiPayload => ({
  header: {
    cwid: "abc123",
    preferredName: "Jane Doe",
    postnominal: "PhD",
    primaryTitle: "Professor of Pharmacology",
    primaryDepartment: "Pharmacology",
    slug: "jane-doe",
    identityImageEndpoint: "/headshot/abc123",
    totalPubCount: 42,
    totalGrantCount: 3,
    topTopic: null,
  },
  authorship: null,
  coPubs: null,
  topicRank: null,
  recentPubs: [],
  recentGrants: [],
  topSponsor: null,
  methodFamilies: [],
  ...over,
});

const TWO_FAMILIES = [
  {
    supercategory: "genomics",
    familyLabel: "CRISPR gene editing",
    familyId: "crispr",
    pmidCount: 24,
    href: "/methods/genomics/crispr-gene-editing",
  },
  {
    supercategory: "genomics",
    familyLabel: "RNA sequencing",
    familyId: "rnaseq",
    pmidCount: 1,
    href: "/methods/genomics/rna-sequencing",
  },
];

function mockFetch(payload: ApiPayload) {
  const fn = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  })) as unknown as typeof fetch;
  global.fetch = fn;
  return fn as unknown as ReturnType<typeof vi.fn>;
}

function lastFetchUrl(fn: ReturnType<typeof vi.fn>): string {
  return String(fn.mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("#853 PersonPopover method-families section", () => {
  it("contextMethods popover requests contextMethods=1 and renders the section", async () => {
    const fetchFn = mockFetch(basePayload({ methodFamilies: TWO_FAMILIES }));

    render(
      <PersonPopover cwid="abc123" surface="top-scholar" contextMethods>
        <a href="#">Jane Doe chip</a>
      </PersonPopover>,
    );

    fireEvent.click(screen.getByTestId("hovercard"));

    expect(await screen.findByText("Prominent method families")).toBeTruthy();
    // Plural vs singular count formatting + the canonical /methods link.
    const crispr = screen.getByText("CRISPR gene editing");
    expect(crispr.closest("a")?.getAttribute("href")).toBe(
      "/methods/genomics/crispr-gene-editing",
    );
    expect(screen.getByText("24 pubs")).toBeTruthy();
    expect(screen.getByText("1 pub")).toBeTruthy();

    expect(lastFetchUrl(fetchFn)).toContain("contextMethods=1");
  });

  it("plain top-scholar popover sends no contextMethods param and shows no section", async () => {
    const fetchFn = mockFetch(basePayload({ methodFamilies: [] }));

    render(
      <PersonPopover cwid="abc123" surface="top-scholar">
        <a href="#">Jane Doe chip</a>
      </PersonPopover>,
    );

    fireEvent.click(screen.getByTestId("hovercard"));

    // Wait for the body to render (View profile is keyed off the slug).
    expect(await screen.findByText("View profile")).toBeTruthy();
    expect(screen.queryByText("Prominent method families")).toBeNull();
    expect(lastFetchUrl(fetchFn)).not.toContain("contextMethods");
  });

  it("TopScholarChip with enablePopover+contextMethods threads the flag to the fetch", async () => {
    const fetchFn = mockFetch(basePayload({ methodFamilies: TWO_FAMILIES }));
    const scholar: TopScholarChipData = {
      rank: 1,
      cwid: "abc123",
      slug: "jane-doe",
      preferredName: "Jane Doe",
      primaryTitle: "Professor of Pharmacology",
      identityImageEndpoint: "/headshot/abc123",
    };

    render(<TopScholarChip scholar={scholar} enablePopover contextMethods />);

    fireEvent.click(screen.getByTestId("hovercard"));

    expect(await screen.findByText("Prominent method families")).toBeTruthy();
    expect(lastFetchUrl(fetchFn)).toContain("contextMethods=1");
    // The /methods chip must NOT send a topic context (would change the card).
    expect(lastFetchUrl(fetchFn)).not.toContain("contextTopicSlug");
  });
});
