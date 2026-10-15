/**
 * TOPIC_FEED_GRANTS_TRIALS — the topic page's "Activities" feed
 * (components/taxonomy/activity-feed.tsx).
 *
 *   - flag off: `TopicPublicationFeed` is today's feed ("Publications" heading,
 *     no Type select, only the publications route);
 *   - flag on: "Activities" heading, a Type select with Show / Sort; a type
 *     with a zero count is not offered; switching to Grants / Clinical trials
 *     fetches `/api/topics/[slug]/activity?kind=…`, renders the Search rows,
 *     hides the research-articles toggle and writes `?feed=` on the client;
 *     `?feed=` is read back on load.
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
vi.mock("@/components/search/funding-result-row", () => ({
  FundingResultRow: ({ hit }: { hit: { title: string } }) => <div data-testid="grant-row">{hit.title}</div>,
}));
vi.mock("@/components/search/trial-result-row", () => ({
  TrialResultRow: ({ hit }: { hit: { title: string } }) => <div data-testid="trial-row">{hit.title}</div>,
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

type Counts = { grant: { strongly: number; also: number }; trial: { strongly: number; also: number } };

function stubServer(counts: Counts) {
  const calls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push(url);
      const q = url.searchParams;
      let body: unknown;
      if (url.pathname.endsWith("/activity")) {
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
              authors: [],
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
const count = () => screen.getByTestId("publications-count").textContent;
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

describe("flag on: TopicActivityFeed", () => {
  it("Activities heading; Type select first; a zero-count type is not offered", async () => {
    stubServer({ grant: { strongly: 3, also: 1 }, trial: { strongly: 0, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic={null} />);
    await screen.findByText("Paper one");
    expect(heading()).toBe("Activities");
    await waitFor(() => expect(select("Type")).not.toBeNull());
    expect(options("Type")).toEqual(["publications", "grants"]);
    expect(select("Type")!.value).toBe("publications");
    // Type sits before Sort in the controls.
    const selects = Array.from(document.querySelectorAll("select"));
    expect(selects.indexOf(select("Type")!)).toBeLessThan(selects.indexOf(select("Sort by")!));
    // Publications view keeps the research-articles toggle.
    expect(screen.getByText(/Show all publication types/)).toBeTruthy();
  });

  it("no grants and no trials: no Type select", async () => {
    const calls = stubServer({ grant: { strongly: 0, also: 0 }, trial: { strongly: 0, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic={null} />);
    await screen.findByText("Paper one");
    await waitFor(() => expect(activityCalls(calls).length).toBeGreaterThan(0));
    expect(select("Type")).toBeNull();
    expect(heading()).toBe("Activities");
  });

  it("switching to Grants fetches the activity route and renders grant rows", async () => {
    const calls = stubServer({ grant: { strongly: 3, also: 1 }, trial: { strongly: 2, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic="sub_a" />);
    await waitFor(() => expect(select("Type")).not.toBeNull());
    expect(options("Type")).toEqual(["publications", "grants", "trials"]);
    const before = activityCalls(calls).length;

    fireEvent.change(select("Type")!, { target: { value: "grants" } });
    await waitFor(() => expect(screen.getAllByTestId("grant-row")).toHaveLength(3));
    const req = activityCalls(calls).slice(before)[0];
    expect(req.pathname).toBe("/api/topics/cardio/activity");
    expect(req.searchParams.get("kind")).toBe("grant");
    expect(req.searchParams.get("sort")).toBe("newest");
    expect(req.searchParams.get("tier")).toBe("strongly");
    expect(req.searchParams.get("subtopic")).toBe("sub_a");
    expect(heading()).toBe("Activities");
    expect(count()).toBe("4");
    expect(screen.getByTestId("activity-note").textContent).toMatch(/InfoEd awards since 2020/);
    expect(screen.queryByText(/Show all publication types/)).toBeNull();
    expect(options("Sort by")).toEqual(["newest", "best_match"]);
    expect(options("Show")).toEqual(["strongly", "all"]);
    expect(new URLSearchParams(window.location.search).get("feed")).toBe("grants");

    // Sort and Show reach the route.
    fireEvent.change(select("Sort by")!, { target: { value: "best_match" } });
    await waitFor(() =>
      expect(activityCalls(calls).at(-1)!.searchParams.get("sort")).toBe("best_match"),
    );
    fireEvent.change(select("Show")!, { target: { value: "all" } });
    await waitFor(() => expect(screen.getAllByTestId("grant-row")).toHaveLength(4));
    expect(activityCalls(calls).at(-1)!.searchParams.has("tier")).toBe(false);

    // Back to Publications drops ?feed=.
    fireEvent.change(select("Type")!, { target: { value: "publications" } });
    await screen.findByText("Paper one");
    expect(new URLSearchParams(window.location.search).has("feed")).toBe(false);
  });

  it("?feed=trials is read on the client and opens the trials list", async () => {
    window.history.replaceState(null, "", "/topics/cardio?feed=trials");
    const calls = stubServer({ grant: { strongly: 0, also: 0 }, trial: { strongly: 2, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic={null} />);
    await waitFor(() => expect(screen.getAllByTestId("trial-row")).toHaveLength(2));
    expect(activityCalls(calls).some((u) => u.searchParams.get("kind") === "trial")).toBe(true);
    expect(options("Type")).toEqual(["publications", "trials"]);
    expect(count()).toBe("2");
    expect(screen.getByTestId("activity-note").textContent).toMatch(/NCT-registered/);
    // No also tier: no Show select.
    expect(select("Show")).toBeNull();
  });

  it("?feed= for a type with nothing in scope falls back to publications", async () => {
    window.history.replaceState(null, "", "/topics/cardio?feed=grants");
    stubServer({ grant: { strongly: 0, also: 0 }, trial: { strongly: 2, also: 0 } });
    render(<TopicActivityFeed topicSlug="cardio" activeSubtopic={null} />);
    await screen.findByText("Paper one");
    await waitFor(() => expect(options("Type")).toEqual(["publications", "trials"]));
    expect(select("Type")!.value).toBe("publications");
  });

  it("readFeedParam accepts only grants / trials", () => {
    expect(readFeedParam("?feed=grants")).toBe("grants");
    expect(readFeedParam("?feed=trials")).toBe("trials");
    expect(readFeedParam("?feed=pubs")).toBe("publications");
    expect(readFeedParam("")).toBe("publications");
  });
});
