/**
 * TOPIC_FEED_GRANTS_TRIALS — the topic page's "Activities" feed
 * (components/taxonomy/activity-feed.tsx).
 *
 *   - flag off: `TopicPublicationFeed` is today's feed ("Publications" heading,
 *     no Type select, only the publications route);
 *   - flag on: the Activities header (Scholars chips from `?kind=scholars`, type
 *     tabs with counts, Sort, the "Include related …" switch); a zero-count tab
 *     is hidden; switching to Grants / Clinical trials fetches
 *     `/api/topics/[slug]/activity?kind=…`, renders the feed's grant / trial rows, hides the
 *     research-articles toggle and writes `?feed=` on the client; `?feed=` is
 *     read back on load.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/publication/author-chip-row", () => ({ AuthorChipRow: () => null }));
vi.mock("@/components/publication/publication-meta", () => ({ PublicationMeta: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/topics/cardio",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/taxonomy/activity-rows", () => ({
  ActivityGrantRow: ({ hit }: { hit: { title: string } }) => <div data-testid="grant-row">{hit.title}</div>,
  ActivityTrialRow: ({ hit }: { hit: { title: string } }) => <div data-testid="trial-row">{hit.title}</div>,
}));
vi.mock("@/lib/use-nih-resolve", () => ({ useNihApplIdMap: () => ({}) }));
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

import { TopicPublicationFeed } from "@/components/taxonomy/publication-feed";
import { readFeedParam, TopicActivityFeed } from "@/components/taxonomy/activity-feed";

type Tiers = { strongly: number; also: number };
type Counts = { grant: Tiers; trial: Tiers };
const PUBS: Tiers = { strongly: 1, also: 0 };

function stubServer(counts: Counts) {
  const calls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push(url);
      const q = url.searchParams;
      let body: unknown;
      if (url.pathname.endsWith("/activity") && q.get("kind") === "scholars") {
        body = {
          totals: { pubs: PUBS, ...counts },
          scholars: [
            { cwid: "aaa1001", name: "Ann Able", slug: "ann-able", headshot: "", pubs: PUBS, ...counts },
            {
              cwid: "bbb2002",
              name: "Bob Baker",
              slug: "bob-baker",
              headshot: "",
              pubs: { strongly: 0, also: 0 },
              grant: { strongly: 1, also: 0 },
              trial: { strongly: 0, also: 0 },
            },
          ],
          displayThreshold: 0.5,
        };
      } else if (url.pathname.endsWith("/activity")) {
        const kind = q.get("kind") as "grant" | "trial";
        const t = counts[kind];
        const total = q.get("tier") === "strongly" ? t.strongly : t.strongly + t.also;
        const n = Math.min(20, total);
        body = {
          kind,
          hits: Array.from({ length: n }, (_, i) =>
            kind === "grant"
              ? { projectId: `p${i}`, title: `Grant ${i}`, awardNumber: null, areaScore: 0.8 }
              : { trialId: `t${i}`, title: `Trial ${i}`, areaScore: 0.8 },
          ),
          total,
          counts,
          tierTotals: t,
          displayThreshold: 0.5,
          subtopicApplied: false,
          page: Number(q.get("page")),
          pageSize: 20,
        };
      } else {
        body = {
          hits: [
            {
              pmid: "1",
              title: "Paper one",
              journal: "J",
              year: 2024,
              publicationType: "Academic Article",
              citationCount: null,
              pubmedUrl: null,
              doi: null,
              pmcid: null,
              impactScore: null,
              authors: ["Cy", "Di", "Ed", "Flo", "Gus"].map((n, i) => ({
                name: `${n} Author`,
                cwid: `zzz${i}`,
                slug: `${n.toLowerCase()}-author`,
                isFirst: i === 0,
                isLast: i === 4,
              })),
            },
          ],
          total: 1,
          totalAllTypes: 3,
          totalResearchOnly: 1,
          tierTotals: { strongly: 1, also: 0 },
          parentTierTotals: { strongly: 1, also: 0 },
          page: 1,
          pageSize: 20,
        };
      }
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
  return calls;
}

const heading = () => screen.getByTestId("publications-heading-row").querySelector("h3")!.textContent;
const select = (aria: string) =>
  document.querySelector(`optgroup[data-trigger-aria='${aria}']`)?.closest("select") ?? null;
const options = (aria: string) =>
  Array.from(select(aria)!.querySelectorAll("option")).map((o) => o.value);
const activityCalls = (calls: URL[]) => calls.filter((u) => u.pathname.endsWith("/activity"));

beforeEach(() => {
  window.history.replaceState(null, "", "/topics/cardio");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("flag off: TopicPublicationFeed is unchanged", () => {
  it("Publications heading, no Type select, publications route only", async () => {
    const calls = stubServer({ grant: { strongly: 3, also: 0 }, trial: { strongly: 2, also: 0 } });
    render(<TopicPublicationFeed topicSlug="cardio" activeSubtopic={null} />);
    await screen.findByText("Paper one");
    expect(heading()).toBe("Publications");
    expect(select("Type")).toBeNull();
    expect(select("Sort by")).not.toBeNull();
    expect(activityCalls(calls)).toHaveLength(0);
    expect(screen.queryByTestId("activity-note")).toBeNull();
  });
});

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const tabCount = (name: RegExp) => tab(name).querySelector("span")!.textContent;

describe("flag on: TopicActivityFeed", () => {
  it("Activities header: tabs with counts, zero-count tab hidden, Scholars chips", async () => {
    const calls = stubServer({ grant: { strongly: 3, also: 1 }, trial: { strongly: 0, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic={null} />);
    await screen.findByText("Paper one");
    expect(screen.getByRole("heading", { name: "Activities" })).toBeTruthy();
    await waitFor(() => expect(tabCount(/Grants/)).toBe("3"));
    expect(tab(/Publications/).getAttribute("aria-selected")).toBe("true");
    expect(tabCount(/Publications/)).toBe("1");
    expect(screen.queryByRole("tab", { name: /Clinical trials/ })).toBeNull();
    // Chips: "All" (no number), then each scholar's activity count, sorted by count.
    const chips = screen.getByTestId("activities-scholars").querySelectorAll("button[aria-pressed]");
    expect(Array.from(chips).map((c) => c.textContent)).toEqual(["All", "AAAnn Able4", "BBBob Baker1"]);
    expect(screen.queryByRole("link", { name: /View .*'s profile/ })).toBeNull();
    expect(calls.some((u) => u.searchParams.get("kind") === "scholars")).toBe(true);
    // Publications view keeps the research-articles toggle; no related switch (no also tier).
    expect(screen.getByText(/Show all publication types/)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("switching to Grants fetches the activity route; Sort and the related switch reach it", async () => {
    const calls = stubServer({ grant: { strongly: 3, also: 1 }, trial: { strongly: 2, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic="sub_a" />);
    await waitFor(() => expect(tabCount(/Grants/)).toBe("3"));
    const before = activityCalls(calls).length;

    fireEvent.click(tab(/Grants/));
    await waitFor(() => expect(screen.getAllByTestId("grant-row")).toHaveLength(3));
    const req = activityCalls(calls).slice(before).find((u) => u.searchParams.get("kind") === "grant")!;
    expect(req.searchParams.get("sort")).toBe("status");
    expect(req.searchParams.get("tier")).toBe("strongly");
    expect(req.searchParams.get("subtopic")).toBe("sub_a");
    expect(screen.queryByText(/Show all publication types/)).toBeNull();
    expect(options("Sort by")).toEqual(["status", "newest", "ending", "best_match"]);
    expect(screen.getByText("Include related grants")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("feed")).toBe("grants");

    fireEvent.change(select("Sort by")!, { target: { value: "ending" } });
    await waitFor(() => expect(activityCalls(calls).at(-1)!.searchParams.get("sort")).toBe("ending"));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getAllByTestId("grant-row")).toHaveLength(4));
    expect(activityCalls(calls).at(-1)!.searchParams.has("tier")).toBe(false);
    expect(tabCount(/Grants/)).toBe("4");

    // A chip pick filters the list by cwid.
    fireEvent.click(screen.getByRole("button", { name: /Bob Baker/ }));
    await waitFor(() => expect(activityCalls(calls).at(-1)!.searchParams.get("cwid")).toBe("bbb2002"));
    expect(screen.getByRole("link", { name: /View Bob Baker's profile/ }).getAttribute("href")).toMatch(/bob-baker/);
    expect(tabCount(/Grants/)).toBe("1");

    // Bob has no papers: Publications has no tab until "All" clears the pick.
    expect(screen.queryByRole("tab", { name: /Publications/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    // Back to Publications drops ?feed=.
    fireEvent.click(tab(/Publications/));
    // The switch is still on: the stub serves the paper in both tiers.
    await screen.findAllByText("Paper one");
    expect(new URLSearchParams(window.location.search).has("feed")).toBe(false);
  });

  it("publication authors are plain profile links, four then +N more", async () => {
    stubServer({ grant: { strongly: 0, also: 0 }, trial: { strongly: 0, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic={null} />);
    await screen.findByText("Paper one");
    expect(screen.getByRole("link", { name: "Cy Author" }).getAttribute("href")).toMatch(/cy-author/);
    expect(screen.queryByRole("link", { name: "Gus Author" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+1 more" }));
    expect(screen.getByRole("link", { name: "Gus Author" })).toBeTruthy();
  });

  it("?feed=trials is read on the client and opens the trials list", async () => {
    window.history.replaceState(null, "", "/topics/cardio?feed=trials");
    const calls = stubServer({ grant: { strongly: 0, also: 0 }, trial: { strongly: 2, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic={null} />);
    await waitFor(() => expect(screen.getAllByTestId("trial-row")).toHaveLength(2));
    expect(activityCalls(calls).some((u) => u.searchParams.get("kind") === "trial")).toBe(true);
    expect(tab(/Clinical trials/).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /NCT-registered.*0\.7 or higher/ })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("?feed= for a type with nothing in scope falls back to publications", async () => {
    window.history.replaceState(null, "", "/topics/cardio?feed=grants");
    stubServer({ grant: { strongly: 0, also: 0 }, trial: { strongly: 2, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic={null} />);
    await screen.findByText("Paper one");
    await waitFor(() => expect(tab(/Publications/).getAttribute("aria-selected")).toBe("true"));
    expect(screen.queryByRole("tab", { name: /Grants/ })).toBeNull();
  });

  it("readFeedParam accepts only grants / trials", () => {
    expect(readFeedParam("?feed=grants")).toBe("grants");
    expect(readFeedParam("?feed=trials")).toBe("trials");
    expect(readFeedParam("?feed=pubs")).toBe("publications");
    expect(readFeedParam("")).toBe("publications");
  });
});
