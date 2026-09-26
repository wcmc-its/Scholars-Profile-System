/**
 * Feed-merge parity (Topic & Method refactor phase 4, step 1).
 *
 * The topic feed, the method family feed and the category "All work" list were
 * three copies of one row + toolbar. They now render through ONE shared
 * `PublicationFeed` / `PubRow` (`components/taxonomy/publication-feed.tsx`).
 * With TAXONOMY_FEED_LOAD_MORE off the merge is a pure refactor, so these
 * snapshots were recorded against the PRE-merge components and must match the
 * merged ones byte for byte (ids normalized): same rows, same controls, same
 * props into the row's children, same modal arguments.
 *
 * Child components are replaced by prop-echo stubs so the snapshot also pins
 * WHAT each row passes to the author chips and the meta band.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const modalCalls: unknown[][] = [];
vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({
    open: (...args: unknown[]) => {
      modalCalls.push(args);
    },
  }),
}));
vi.mock("@/components/publication/author-chip-row", () => ({
  AuthorChipRow: (props: Record<string, unknown>) => (
    <div data-stub="author-chips" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("@/components/publication/publication-meta", () => ({
  PublicationMeta: (props: Record<string, unknown>) => (
    <div data-stub="meta" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
let search = new URLSearchParams();
const replaceSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceSpy, push: vi.fn() }),
  usePathname: () => "/methods/sc/fam-fam_1",
  useSearchParams: () => search,
}));
vi.mock("@/components/ui/select", () => {
  type SelectProps = { value: string; onValueChange: (v: string) => void; children: React.ReactNode };
  return {
    Select: ({ value, onValueChange, children }: SelectProps) => (
      <select value={value} onChange={(e) => onValueChange(e.target.value)} data-mock-select>
        {children}
      </select>
    ),
    SelectTrigger: ({ children, "aria-label": ariaLabel }: { children: React.ReactNode; "aria-label"?: string }) => (
      <optgroup label={ariaLabel ?? ""} data-trigger-aria={ariaLabel}>
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

import { TopicPublicationFeed as PublicationFeed } from "@/components/taxonomy/publication-feed";
import { FamilyPublicationFeed } from "@/components/taxonomy/publication-feed";
import { SupercategoryAllWorkFeed } from "@/components/method/supercategory-all-work-feed";
import type { MethodPublicationHit } from "@/lib/api/methods";

const author = {
  name: "Ada Example",
  cwid: "abc1001",
  slug: "ada-example",
  identityImageEndpoint: "/img/abc1001",
  isFirst: true,
  isLast: false,
};

function topicHit(pmid: string, extra: Record<string, unknown> = {}) {
  return {
    pmid,
    title: `Paper <i>${pmid}</i>`,
    journal: "Journal of <b>Things</b>",
    year: 2024,
    publicationType: "Academic Article",
    citationCount: 7,
    pubmedUrl: null,
    doi: "10.1/x",
    pmcid: "PMC1",
    impactScore: 61,
    impactJustification: "Because.",
    authors: [author],
    hasAbstract: true,
    topTopic: null,
    ...extra,
  };
}

function familyHit(pmid: string, extra: Record<string, unknown> = {}) {
  return {
    pmid,
    title: `Fam paper ${pmid}`,
    journal: pmid === "3" ? null : "Cell",
    year: pmid === "3" ? 0 : 2023,
    publicationType: "Academic Article",
    citationCount: null,
    pubmedUrl: null,
    doi: null,
    pmcid: null,
    impactScore: 40,
    abstract: null,
    hasAbstract: pmid !== "2",
    authors: [author],
    ...extra,
  };
}

type Payload = Record<string, unknown>;
function stubFetch(route: (url: URL) => Payload) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    return { ok: true, status: 200, json: async () => route(url) } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** innerHTML with React's generated ids normalized so the snapshot is stable. */
function html(el: HTMLElement): string {
  return el.innerHTML.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:/g, "ID");
}

function clickAllTitles(container: HTMLElement) {
  container.querySelectorAll("li > div > button[aria-haspopup='dialog']").forEach((b) => {
    fireEvent.click(b);
  });
}

beforeEach(() => {
  modalCalls.length = 0;
  search = new URLSearchParams();
  replaceSpy.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const topicTotals = {
  totalAllTypes: 50,
  totalResearchOnly: 45,
  tierTotals: { strongly: 30, also: 15 },
  parentTierTotals: { strongly: 30, also: 15 },
  pageSize: 20,
};

describe("topic feed parity", () => {
  it("default (strongly) view with numbered pagination + best fit + type toggle", async () => {
    const fetchSpy = stubFetch((url) => ({
      hits:
        url.searchParams.get("tier") === "also"
          ? [topicHit("9")]
          : [topicHit("1", { topTopic: { id: "other_topic", label: "Other Topic" } }), topicHit("2", { impactScore: null, impactJustification: null, hasAbstract: false })],
      total: url.searchParams.get("tier") === "also" ? 15 : 30,
      page: Number(url.searchParams.get("page")),
      ...topicTotals,
    }));
    const { container } = render(<PublicationFeed topicSlug="cancer" activeSubtopic="sub_a" />);
    await screen.findByText(/Best fit:/);
    clickAllTitles(container);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toMatchSnapshot("requests");
    expect(modalCalls).toMatchSnapshot("modal");
    expect(html(container)).toMatchSnapshot("dom");
  });

  it("Show = All relevant stacks the Also relevant section", async () => {
    stubFetch((url) => ({
      hits: url.searchParams.get("tier") === "also" ? [topicHit("9")] : [topicHit("1")],
      total: url.searchParams.get("tier") === "also" ? 15 : 30,
      page: 1,
      ...topicTotals,
    }));
    const { container } = render(<PublicationFeed topicSlug="cancer" activeSubtopic={null} />);
    await screen.findByText("Paper");
    const show = container.querySelector("optgroup[data-trigger-aria='Show']")!.closest("select")!;
    fireEvent.change(show, { target: { value: "all" } });
    await screen.findByText("Also relevant");
    await waitFor(() => expect(container.querySelectorAll("ul.divide-y > li").length).toBe(2));
    expect(html(container)).toMatchSnapshot("dom");
  });

  it("strongly-empty falls back to the also list without the Show select (#326)", async () => {
    stubFetch((url) => ({
      hits: url.searchParams.get("tier") === "also" ? [topicHit("9")] : [],
      total: url.searchParams.get("tier") === "also" ? 4 : 0,
      page: 1,
      totalAllTypes: 4,
      totalResearchOnly: 4,
      tierTotals: { strongly: 0, also: 4 },
      parentTierTotals: { strongly: 10, also: 4 },
      pageSize: 20,
    }));
    const { container } = render(<PublicationFeed topicSlug="cancer" activeSubtopic="sub_b" />);
    await waitFor(() => expect(container.querySelectorAll("ul.divide-y > li").length).toBe(1));
    expect(html(container)).toMatchSnapshot("dom");
  });

  it("empty topic renders the empty state", async () => {
    stubFetch(() => ({
      hits: [],
      total: 0,
      page: 1,
      totalAllTypes: 0,
      totalResearchOnly: 0,
      tierTotals: { strongly: 0, also: 0 },
      parentTierTotals: { strongly: 0, also: 0 },
      pageSize: 20,
    }));
    const { container } = render(<PublicationFeed topicSlug="cancer" activeSubtopic={null} />);
    await screen.findByText("No publications found");
    expect(html(container)).toMatchSnapshot("dom");
  });
});

describe("family feed parity", () => {
  it("default view: sort + type toggle + numbered pagination", async () => {
    const fetchSpy = stubFetch(() => ({
      hits: [familyHit("1"), familyHit("2"), familyHit("3")],
      total: 45,
      totalAllTypes: 50,
      totalResearchOnly: 45,
      page: 0,
      pageSize: 20,
    }));
    const { container } = render(
      <FamilyPublicationFeed supercategorySlug="sc" familySegment="fam-fam_1" familyLabel="Fam" />,
    );
    await screen.findByText("Fam paper 1");
    clickAllTitles(container);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toMatchSnapshot("requests");
    expect(modalCalls).toMatchSnapshot("modal");
    expect(html(container)).toMatchSnapshot("dom");
  });

  it("entity-filtered view: context chip, N of M copy, usage snippets (#1166)", async () => {
    search = new URLSearchParams("entity=tool_000001");
    const fetchSpy = stubFetch(() => ({
      hits: [
        familyHit("1", {
          entityUsages: [
            { sentence: "We used HeLa cells here.", matchedSpan: { start: 8, end: 12 }, usage: "used" },
            { sentence: "HeLa appear in the background.", matchedSpan: null, usage: "appears" },
          ],
        }),
        familyHit("2", {
          entityUsages: [{ sentence: "HeLa only once.", matchedSpan: null, usage: "used" }],
        }),
      ],
      total: 2,
      totalAllTypes: 33,
      totalResearchOnly: 30,
      page: 0,
      pageSize: 20,
    }));
    const { container } = render(
      <FamilyPublicationFeed
        supercategorySlug="sc"
        familySegment="fam-fam_1"
        familyLabel="Fam"
        cellLineLabels={{ tool_000001: "HeLa" }}
      />,
    );
    await screen.findByText("Fam paper 1");
    fireEvent.click(screen.getByRole("button", { name: /1 more usage/ }));
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toMatchSnapshot("requests");
    expect(html(container)).toMatchSnapshot("dom");
    fireEvent.click(screen.getByRole("button", { name: "Clear HeLa filter" }));
    expect(replaceSpy.mock.calls).toMatchSnapshot("clear");
  });

  it("empty family renders the family empty state", async () => {
    stubFetch(() => ({
      hits: [],
      total: 0,
      totalAllTypes: 0,
      totalResearchOnly: 0,
      page: 0,
      pageSize: 20,
    }));
    const { container } = render(
      <FamilyPublicationFeed supercategorySlug="sc" familySegment="fam-fam_1" familyLabel="Fam" />,
    );
    await screen.findByText("No publications found");
    expect(html(container)).toMatchSnapshot("dom");
  });
});

describe("category All-work list parity", () => {
  it("renders the fixed representative list with the shared row", () => {
    const { container } = render(
      <SupercategoryAllWorkFeed
        pubs={[familyHit("1"), familyHit("2"), familyHit("3")] as unknown as MethodPublicationHit[]}
        supercategoryLabel="Reagents"
      />,
    );
    clickAllTitles(container);
    expect(modalCalls).toMatchSnapshot("modal");
    expect(html(container)).toMatchSnapshot("dom");
  });

  it("renders the empty prompt", () => {
    const { container } = render(<SupercategoryAllWorkFeed pubs={[]} supercategoryLabel="Reagents" />);
    expect(html(container)).toMatchSnapshot("dom");
  });
});
