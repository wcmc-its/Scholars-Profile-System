/**
 * Scholar card hover on topic / method pages (`taxonomy-card` surface) and the
 * per-scholar publication filter it drives:
 *   - the popover sends the page scope (topic slug, or supercategory + family
 *     label) and renders "N publications in {scope} · M as first or senior
 *     author", the recent papers with journal, and no person header;
 *   - "Filter publications →" picks the scholar (label flips to "Clear filter");
 *     the category page (not filterable) gets no filter link;
 *   - the picked card highlights and the others dim;
 *   - the topic feed adds `cwid=` while a scholar is picked, shows the chip, and
 *     drops the pick on a subarea change.
 * The Radix hover card is a click-to-open pass-through. Fake people only.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { PublicationModalProvider } from "@/components/publication/publication-modal";
import {
  ScholarCardPickState,
  setScholarFilter,
  useScholarFilter,
} from "@/components/taxonomy/scholar-filter";
import { TopicPublicationFeed } from "@/components/taxonomy/publication-feed";

const header = {
  cwid: "abc1234",
  preferredName: "Jane Doe",
  postnominal: "PhD",
  primaryTitle: "Professor of Testing",
  primaryDepartment: "Testing",
  slug: "jane-doe",
  identityImageEndpoint: "/img",
  totalPubCount: 40,
  totalGrantCount: 0,
  topTopic: null,
};

const payload = {
  header,
  authorship: null,
  coPubs: null,
  topicRank: null,
  recentPubs: [],
  recentGrants: [],
  topSponsor: null,
  methodFamilies: [],
  scope: {
    pubCount: 12,
    leadCount: 5,
    recent: [
      { pmid: "111", title: "A study of things", journal: "Journal of Things", year: 2025 },
      { pmid: "222", title: "Another study", journal: null, year: 2023 },
    ],
  },
};

function stubFetch(body: unknown) {
  const fn = vi.fn(async (_url: RequestInfo | URL) => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function PickProbe() {
  const p = useScholarFilter();
  return <span data-testid="probe">{p ? p.cwid : "none"}</span>;
}

function renderPopover(props: Partial<React.ComponentProps<typeof PersonPopover>> = {}) {
  return render(
    <PublicationModalProvider>
      <PersonPopover
        cwid="abc1234"
        surface="taxonomy-card"
        contextTopicSlug="cardio"
        contextTopicLabel="Cardiology"
        filterable
        {...props}
      >
        <a href="/jane-doe">card</a>
      </PersonPopover>
      <PickProbe />
    </PublicationModalProvider>,
  );
}

beforeEach(() => {
  act(() => setScholarFilter(null));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("taxonomy-card popover", () => {
  it("sends the topic scope and renders count, lead count and recent papers, no header", async () => {
    const fetchFn = stubFetch(payload);
    renderPopover();
    fireEvent.click(screen.getByTestId("hovercard"));

    expect(await screen.findByText("12 publications")).toBeTruthy();
    const content = screen.getByTestId("hovercard-content");
    expect(content.textContent).toContain("in Cardiology · 5 as first or senior author");
    expect(screen.getByText("A study of things")).toBeTruthy();
    expect(screen.getByText("Journal of Things").tagName).toBe("EM");
    expect(content.textContent).not.toContain("Jane Doe");
    expect(content.textContent).not.toContain("Professor of Testing");

    const url = new URL(String(fetchFn.mock.calls[0][0]), "http://x");
    expect(url.searchParams.get("surface")).toBe("taxonomy-card");
    expect(url.searchParams.get("contextTopicSlug")).toBe("cardio");
  });

  it("sends supercategory + family label on a method family page", async () => {
    const fetchFn = stubFetch(payload);
    renderPopover({
      contextTopicSlug: undefined,
      contextTopicLabel: "CRISPR",
      contextSupercategory: "genomics",
      contextFamilyLabel: "CRISPR",
    });
    fireEvent.click(screen.getByTestId("hovercard"));
    await screen.findByText("12 publications");
    const url = new URL(String(fetchFn.mock.calls[0][0]), "http://x");
    expect(url.searchParams.get("contextSupercategory")).toBe("genomics");
    expect(url.searchParams.get("contextFamilyLabel")).toBe("CRISPR");
    expect(url.searchParams.get("contextTopicSlug")).toBeNull();
  });

  it("Filter publications → picks the scholar; clicking again clears", async () => {
    stubFetch(payload);
    renderPopover();
    fireEvent.click(screen.getByTestId("hovercard"));
    fireEvent.click(await screen.findByRole("button", { name: "Filter publications →" }));
    expect(screen.getByTestId("probe").textContent).toBe("abc1234");
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(screen.getByTestId("probe").textContent).toBe("none");
    expect(screen.getByRole("link", { name: "View profile" }).getAttribute("href")).toBe(
      "/jane-doe",
    );
  });

  it("no filter link when the page's feed takes no scholar filter", async () => {
    stubFetch(payload);
    renderPopover({ filterable: false });
    fireEvent.click(screen.getByTestId("hovercard"));
    await screen.findByText("12 publications");
    expect(screen.queryByRole("button", { name: /Filter publications/ })).toBeNull();
  });
});

describe("ScholarCardPickState", () => {
  it("marks the picked card and dims the rest; nothing picked ⇒ no state", () => {
    render(
      <>
        <ScholarCardPickState cwid="abc1234">a</ScholarCardPickState>
        <ScholarCardPickState cwid="xyz9876">b</ScholarCardPickState>
      </>,
    );
    const [a, b] = [screen.getByText("a"), screen.getByText("b")];
    expect(a.getAttribute("data-pick")).toBeNull();
    act(() => setScholarFilter({ cwid: "abc1234", name: "Jane Doe", slug: "jane-doe" }));
    expect(a.getAttribute("data-pick")).toBe("picked");
    expect(b.getAttribute("data-pick")).toBe("dimmed");
  });
});

describe("topic feed scholar filter", () => {
  const feedBody = {
    hits: [],
    total: 0,
    totalAllTypes: 0,
    totalResearchOnly: 0,
    tierTotals: { strongly: 0, also: 0 },
    parentTierTotals: { strongly: 0, also: 0 },
    page: 1,
    pageSize: 20,
  };
  const cwidsRequested = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("cwid"));

  function renderFeed(activeSubtopic: string | null) {
    return (
      <PublicationModalProvider>
        <TopicPublicationFeed topicSlug="cardio" activeSubtopic={activeSubtopic} />
      </PublicationModalProvider>
    );
  }

  it("adds cwid while a scholar is picked, shows the chip, and the chip × clears it", async () => {
    const fetchFn = stubFetch(feedBody);
    render(renderFeed(null));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(cwidsRequested(fetchFn).every((c) => c === null)).toBe(true);

    act(() => setScholarFilter({ cwid: "abc1234", name: "Jane Doe", slug: "jane-doe" }));
    await waitFor(() => expect(cwidsRequested(fetchFn)).toContain("abc1234"));
    expect(screen.getByTestId("scholar-filter-chip").textContent).toContain("Jane Doe");
    expect(screen.getByRole("status").textContent).toBe("Showing publications by Jane Doe");

    fireEvent.click(screen.getByRole("button", { name: "Clear scholar filter" }));
    expect(screen.queryByTestId("scholar-filter-chip")).toBeNull();
  });

  it("a subarea change drops the pick; unmounting the feed drops it too", async () => {
    stubFetch(feedBody);
    const { rerender, unmount } = render(renderFeed(null));
    act(() => setScholarFilter({ cwid: "abc1234", name: "Jane Doe", slug: "jane-doe" }));
    expect(await screen.findByTestId("scholar-filter-chip")).toBeTruthy();
    rerender(renderFeed("heart_failure"));
    await waitFor(() => expect(screen.queryByTestId("scholar-filter-chip")).toBeNull());

    act(() => setScholarFilter({ cwid: "abc1234", name: "Jane Doe", slug: "jane-doe" }));
    unmount();
    render(<PickProbe />);
    expect(screen.getByTestId("probe").textContent).toBe("none");
  });
});
