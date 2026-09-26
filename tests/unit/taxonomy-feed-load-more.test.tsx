/**
 * Phase 4 (TAXONOMY_FEED_LOAD_MORE) — the shared feed's Load more mode.
 *
 *   - label math: "Show 20 more · 20 of 45", the last chunk is the remainder,
 *     hidden once everything is shown, "Loading…" while a chunk is in flight;
 *   - focus moves to the first newly loaded row and the new count is announced
 *     politely;
 *   - `?shown=N` is written after each chunk and restored on load with ONE
 *     bounded `limit` request; an invalid value is ignored;
 *   - Sort / Show / type toggle / rail item reset to one chunk and drop `?shown=`;
 *   - topics: ONE "All relevant" list (no "Also relevant" section), and the
 *     #326 contract (Show hidden without an also-tier; strongly-empty falls back
 *     to every tier);
 *   - per-row area label: topic rows name their subarea when no subarea is
 *     selected, category rows name their family, family pages never do.
 * Plus the pure helpers in lib/taxonomy/feed-load-more.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/publication/author-chip-row", () => ({ AuthorChipRow: () => null }));
vi.mock("@/components/publication/publication-meta", () => ({ PublicationMeta: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/methods/sc/fam-fam_1",
  useSearchParams: () => search,
}));
vi.mock("@/components/ui/select", () => {
  type SelectProps = { value: string; onValueChange: (v: string) => void; children: React.ReactNode };
  return {
    Select: ({ value, onValueChange, children }: SelectProps) => (
      <select value={value} onChange={(e) => onValueChange(e.target.value)}>
        {children}
      </select>
    ),
    SelectTrigger: ({ children, "aria-label": a }: { children: React.ReactNode; "aria-label"?: string }) => (
      <optgroup label={a ?? ""} data-trigger-aria={a}>
        {children}
      </optgroup>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

import {
  CategoryPublicationFeed,
  FamilyPublicationFeed,
  TopicPublicationFeed,
} from "@/components/taxonomy/publication-feed";
import {
  FEED_CHUNK,
  loadMoreLabel,
  nextChunkSize,
  parseFeedLimit,
  readShownParam,
  writeShownParam,
} from "@/lib/taxonomy/feed-load-more";

type Server = {
  /** Rows per tier request: strongly, also, or every tier (no tier param). */
  strongly: number;
  also: number;
  /** Non-research extras (reach the list only with filter=all). */
  extraAllTypes?: number;
  parentAlso?: number;
  subtopicOf?: (i: number) => string | null;
  familyOf?: (i: number) => string;
};

/** A fake feed route: pages `page`/`limit` over a synthetic ordered id list. */
function stubServer(s: Server) {
  const calls: URL[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url);
    const q = url.searchParams;
    const tier = q.get("tier");
    const extra = q.get("filter") === "all" ? (s.extraAllTypes ?? 0) : 0;
    const sortTag = q.get("sort") ?? "newest";
    const total = tier === "strongly" ? s.strongly : tier === "also" ? s.also : s.strongly + s.also + extra;
    const limit = Number(q.get("limit") ?? FEED_CHUNK);
    const page = Number(q.get("page"));
    const start = (page - 1) * limit;
    const n = Math.max(0, Math.min(limit, total - start));
    const hits = Array.from({ length: n }, (_, k) => {
      const i = start + k;
      return {
        pmid: `${sortTag}-${tier ?? "any"}-${i}`,
        title: `Row ${i}`,
        journal: "J",
        year: 2024,
        publicationType: "Academic Article",
        citationCount: null,
        pubmedUrl: null,
        doi: null,
        pmcid: null,
        impactScore: null,
        authors: [],
        hasAbstract: false,
        primarySubtopicId: s.subtopicOf ? s.subtopicOf(i) : null,
        familyLabel: s.familyOf ? s.familyOf(i) : undefined,
      };
    });
    const body = {
      hits,
      total,
      totalAllTypes: s.strongly + s.also + (s.extraAllTypes ?? 0),
      totalResearchOnly: s.strongly + s.also,
      tierTotals: { strongly: s.strongly, also: s.also },
      parentTierTotals: { strongly: s.strongly, also: s.parentAlso ?? s.also },
      page,
      pageSize: limit,
    };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return calls;
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("ul.divide-y > li"));
const button = () => screen.queryByTestId("feed-load-more");
const shownParam = () => new URLSearchParams(window.location.search).get("shown");
const select = (aria: string) =>
  document.querySelector(`optgroup[data-trigger-aria='${aria}']`)!.closest("select")!;

beforeEach(() => {
  window.history.replaceState(null, "", "/topics/cardio");
  search = new URLSearchParams();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feed-load-more helpers", () => {
  it("label: next chunk, shown, total, localized", () => {
    expect(loadMoreLabel(40, 40, 279)).toBe("Show 20 more · 40 of 279");
    expect(loadMoreLabel(260, 260, 279)).toBe("Show 19 more · 260 of 279");
    expect(loadMoreLabel(1000, 1000, 1234)).toBe("Show 20 more · 1,000 of 1,234");
    // Rows the server dropped (dark pubs) show as fewer rows, same offset.
    expect(loadMoreLabel(40, 38, 279)).toBe("Show 20 more · 38 of 279");
  });
  it("next chunk: min(20, remaining), 0 when done", () => {
    expect(nextChunkSize(20, 45)).toBe(20);
    expect(nextChunkSize(40, 45)).toBe(5);
    expect(nextChunkSize(60, 45)).toBe(0);
    expect(nextChunkSize(20, 20)).toBe(0);
  });
  it.each([
    ["?shown=40", 40],
    ["?shown=60&subtopic=x", 60],
    ["?shown=35", 40], // rounded up to a whole chunk
    ["?shown=41", 60],
    ["?shown=200", 200],
    ["?shown=999", 200], // clamped
    ["?shown=20", null], // one chunk is the default
    ["?shown=5", null],
    ["?shown=0", null],
    ["?shown=-40", null],
    ["?shown=4e1", null],
    ["?shown=40.0", null],
    ["?shown=abc", null],
    ["?shown=", null],
    ["?shown=1234567", null],
    ["", null],
  ])("readShownParam(%j) = %j", (qs, want) => {
    expect(readShownParam(qs)).toBe(want);
  });
  it("parseFeedLimit: absent = 20; whole chunks 20..200 only", () => {
    expect(parseFeedLimit(null)).toBe(20);
    expect(parseFeedLimit("20")).toBe(20);
    expect(parseFeedLimit("200")).toBe(200);
    for (const bad of ["0", "19", "30", "220", "-20", "2e1", "", "20 "]) {
      expect(parseFeedLimit(bad), bad).toBe("invalid");
    }
  });
  it("writeShownParam keeps other params and the hash; one chunk removes it", () => {
    window.history.replaceState(null, "", "/topics/cardio?subtopic=s1#publications");
    writeShownParam(60);
    expect(window.location.search).toBe("?subtopic=s1&shown=60");
    expect(window.location.hash).toBe("#publications");
    writeShownParam(20);
    expect(window.location.search).toBe("?subtopic=s1");
    writeShownParam(null);
    expect(window.location.search).toBe("?subtopic=s1");
  });
});

describe("topic feed, Load more", () => {
  it("pages in 20s: label, append, focus, announcement, ?shown, hidden at the end", async () => {
    const calls = stubServer({ strongly: 45, also: 0 });
    render(<TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} loadMore />);
    await waitFor(() => expect(rows()).toHaveLength(20));
    expect(calls[0].searchParams.get("page")).toBe("1");
    expect(calls[0].searchParams.has("limit")).toBe(false);
    expect(button()!.textContent).toBe("Show 20 more · 20 of 45");
    // No numbered pager in this mode.
    expect(screen.queryByRole("navigation", { name: "pagination" })).toBeNull();

    fireEvent.click(button()!);
    expect(button()!.textContent).toBe("Loading…");
    expect(button()!.hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(rows()).toHaveLength(40));
    expect(calls[1].searchParams.get("page")).toBe("2");
    expect(document.activeElement).toBe(rows()[20]);
    expect(rows()[20].getAttribute("tabindex")).toBe("-1");
    expect(screen.getByTestId("feed-announcement").textContent).toBe("Showing 40 of 45 publications");
    expect(shownParam()).toBe("40");
    expect(button()!.textContent).toBe("Show 5 more · 40 of 45");

    fireEvent.click(button()!);
    await waitFor(() => expect(rows()).toHaveLength(45));
    expect(button()).toBeNull();
    expect(shownParam()).toBe("60");
  });

  it("the button is full width and 44px tall below sm", async () => {
    stubServer({ strongly: 45, also: 0 });
    render(<TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} loadMore />);
    await waitFor(() => expect(button()).not.toBeNull());
    expect(button()!.className).toContain("max-sm:w-full");
    expect(button()!.className).toContain("max-sm:min-h-11");
  });

  it("restores ?shown=N with one bounded request", async () => {
    window.history.replaceState(null, "", "/topics/cardio?shown=60#publications");
    const calls = stubServer({ strongly: 100, also: 0 });
    render(<TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} loadMore />);
    await waitFor(() => expect(rows()).toHaveLength(60));
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("limit")).toBe("60");
    expect(calls[0].searchParams.get("page")).toBe("1");
    expect(button()!.textContent).toBe("Show 20 more · 60 of 100");
    expect(shownParam()).toBe("60");
    fireEvent.click(button()!);
    await waitFor(() => expect(rows()).toHaveLength(80));
    // The next chunk continues at offset 60: page 4 of 20.
    expect(calls[1].searchParams.get("page")).toBe("4");
    expect(calls[1].searchParams.has("limit")).toBe(false);
    expect(shownParam()).toBe("80");
  });

  it("ignores an invalid ?shown", async () => {
    window.history.replaceState(null, "", "/topics/cardio?shown=abc");
    const calls = stubServer({ strongly: 100, also: 0 });
    render(<TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} loadMore />);
    await waitFor(() => expect(rows()).toHaveLength(20));
    expect(calls[0].searchParams.has("limit")).toBe(false);
  });

  it("Sort, the type toggle, Show and the rail item each reset to one chunk and drop ?shown", async () => {
    const calls = stubServer({ strongly: 100, also: 30, extraAllTypes: 10 });
    const { rerender } = render(<TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} loadMore />);
    const loadTwo = async () => {
      await waitFor(() => expect(button()?.textContent).toMatch(/^Show 20 more · 20 of/));
      fireEvent.click(button()!);
      await waitFor(() => expect(shownParam()).toBe("40"));
    };
    const expectReset = async (check: (u: URL) => void) => {
      await waitFor(() => expect(shownParam()).toBeNull());
      await waitFor(() => expect(rows()).toHaveLength(20));
      const last = calls[calls.length - 1];
      expect(last.searchParams.get("page")).toBe("1");
      expect(last.searchParams.has("limit")).toBe(false);
      check(last);
    };

    await loadTwo();
    fireEvent.change(select("Sort by"), { target: { value: "most_cited" } });
    await expectReset((u) => expect(u.searchParams.get("sort")).toBe("most_cited"));

    await loadTwo();
    fireEvent.click(screen.getByRole("button", { name: /Show all publication types/ }));
    await expectReset((u) => expect(u.searchParams.get("filter")).toBe("all"));

    await loadTwo();
    fireEvent.change(select("Show"), { target: { value: "all" } });
    await expectReset((u) => expect(u.searchParams.has("tier")).toBe(false));

    await loadTwo();
    rerender(<TopicPublicationFeed topicSlug="cardio" activeSubtopic="sub_a" loadMore />);
    await expectReset((u) => expect(u.searchParams.get("subtopic")).toBe("sub_a"));
  });

  it("All relevant is ONE list: no tier param, no 'Also relevant' section; heading and denominator agree", async () => {
    const calls = stubServer({ strongly: 12, also: 30 });
    render(<TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} loadMore />);
    await waitFor(() => expect(rows()).toHaveLength(12));
    expect(calls[0].searchParams.get("tier")).toBe("strongly");
    // Heading = every tier (the rail's number); Show=Strongly denominator = 12.
    expect(screen.getByTestId("publications-count").textContent).toBe("42");
    expect(button()).toBeNull();

    fireEvent.change(select("Show"), { target: { value: "all" } });
    await waitFor(() => expect(rows()).toHaveLength(20));
    expect(calls[calls.length - 1].searchParams.has("tier")).toBe(false);
    expect(screen.queryByText("Also relevant")).toBeNull();
    expect(document.querySelectorAll("ul.divide-y")).toHaveLength(1);
    expect(screen.getByTestId("publications-count").textContent).toBe("42");
    expect(button()!.textContent).toBe("Show 20 more · 20 of 42");
  });

  it("#326: no Show select without an also-tier in the parent topic", async () => {
    stubServer({ strongly: 12, also: 0, parentAlso: 0 });
    render(<TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} loadMore />);
    await waitFor(() => expect(rows()).toHaveLength(12));
    expect(document.querySelector("optgroup[data-trigger-aria='Show']")).toBeNull();
  });

  it("#326: an empty strongly tier falls back to every tier, without the Show select", async () => {
    const calls = stubServer({ strongly: 0, also: 25 });
    render(<TopicPublicationFeed topicSlug="cardio" activeSubtopic="sub_b" loadMore />);
    await waitFor(() => expect(rows()).toHaveLength(20));
    expect(calls.map((u) => u.searchParams.get("tier"))).toEqual(["strongly", null]);
    expect(document.querySelector("optgroup[data-trigger-aria='Show']")).toBeNull();
    fireEvent.click(button()!);
    await waitFor(() => expect(rows()).toHaveLength(25));
    // Later chunks stay on every tier.
    expect(calls[2].searchParams.has("tier")).toBe(false);
  });

  it("per-row subarea label only when no subarea is selected", async () => {
    stubServer({ strongly: 3, also: 0, subtopicOf: (i) => (i === 2 ? null : i === 0 ? "sub_a" : "sub_b") });
    const labels = { sub_a: "Surveillance", sub_b: "Imaging" };
    const { rerender } = render(
      <TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} loadMore subtopicLabels={labels} />,
    );
    await waitFor(() => expect(rows()).toHaveLength(3));
    const text = rows().map((li) => within(li).queryByTestId("pub-area-label")?.textContent ?? null);
    expect(text).toEqual(["Surveillance", "Imaging", null]);
    rerender(<TopicPublicationFeed topicSlug="cardio" activeSubtopic="sub_a" loadMore subtopicLabels={labels} />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByTestId("pub-area-label")).toBeNull();
  });

  it("flag off: no label, numbered pages, stacked tiers (unchanged)", async () => {
    stubServer({ strongly: 45, also: 0, subtopicOf: () => "sub_a" });
    render(
      <TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} subtopicLabels={{ sub_a: "A" }} />,
    );
    await waitFor(() => expect(rows()).toHaveLength(20));
    expect(screen.queryByTestId("pub-area-label")).toBeNull();
    expect(button()).toBeNull();
    expect(screen.getByRole("navigation", { name: "pagination" })).toBeTruthy();
    expect(rows()[0].hasAttribute("tabindex")).toBe(false);
  });
});

describe("family and category feeds, Load more", () => {
  it("family feed: Load more, no area label, entity change resets", async () => {
    window.history.replaceState(null, "", "/methods/sc/fam-fam_1");
    const calls = stubServer({ strongly: 30, also: 0, familyOf: () => "Should not show" });
    const { rerender } = render(
      <FamilyPublicationFeed supercategorySlug="sc" familySegment="fam-fam_1" familyLabel="Fam" loadMore />,
    );
    await waitFor(() => expect(rows()).toHaveLength(20));
    expect(calls[0].pathname).toBe("/api/methods/sc/fam-fam_1/publications");
    expect(screen.queryByTestId("pub-area-label")).toBeNull();
    expect(button()!.textContent).toBe("Show 10 more · 20 of 30");
    fireEvent.click(button()!);
    await waitFor(() => expect(shownParam()).toBe("40"));
    search = new URLSearchParams("entity=tool_000001");
    rerender(
      <FamilyPublicationFeed
        supercategorySlug="sc"
        familySegment="fam-fam_1"
        familyLabel="Fam"
        cellLineLabels={{ tool_000001: "HeLa" }}
        loadMore
      />,
    );
    await waitFor(() => expect(shownParam()).toBeNull());
    expect(calls[calls.length - 1].searchParams.get("entity")).toBe("tool_000001");
  });

  it("category feed: the all-families route, a family label per row", async () => {
    window.history.replaceState(null, "", "/methods/sc");
    const calls = stubServer({ strongly: 3, also: 0, familyOf: (i) => ["CRISPR", "Flow", "CRISPR"][i] });
    render(<CategoryPublicationFeed supercategorySlug="sc" />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(calls[0].pathname).toBe("/api/methods/sc/all/publications");
    expect(calls[0].searchParams.has("tier")).toBe(false);
    expect(rows().map((li) => within(li).getByTestId("pub-area-label").textContent)).toEqual([
      "CRISPR",
      "Flow",
      "CRISPR",
    ]);
    expect(screen.getByTestId("publications-count").textContent).toBe("3");
    expect(document.querySelector("optgroup[data-trigger-aria='Show']")).toBeNull();
  });
});

describe("StrictMode-safe restore", () => {
  it("a re-run of the mount effect still restores ?shown", async () => {
    window.history.replaceState(null, "", "/topics/cardio?shown=40");
    const calls = stubServer({ strongly: 100, also: 0 });
    const { StrictMode } = await import("react");
    await act(async () => {
      render(
        <StrictMode>
          <TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} loadMore />
        </StrictMode>,
      );
    });
    await waitFor(() => expect(rows()).toHaveLength(40));
    expect(calls.every((u) => u.searchParams.get("limit") === "40")).toBe(true);
    expect(shownParam()).toBe("40");
  });
});
