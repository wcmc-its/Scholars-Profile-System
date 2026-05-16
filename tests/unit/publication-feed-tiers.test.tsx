/**
 * Component tests for the two-tier display and top-topic inline label
 * landed on `components/topic/publication-feed.tsx` for #326 + #327.
 *
 * Scope:
 *   - Default load only fetches `tier=strongly`; the toggle stays hidden
 *     when `tierTotals.also === 0`.
 *   - When both tiers have content, the toggle renders with the also
 *     count and defaults to collapsed (acceptance criterion: page reload
 *     resets to collapsed — the component mounting equivalent here).
 *   - Clicking the toggle issues a `tier=also` request and renders the
 *     hits under an "Also relevant" subheading.
 *   - Strongly-empty + Also-non-empty edge case renders the also rows
 *     inline without a toggle (spec: "Should be rare given default
 *     display_threshold ~0.5").
 *   - Inline `Top topic: X` label renders when `topTopic` is non-null and
 *     suppressed otherwise (#327).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PublicationFeed } from "@/components/topic/publication-feed";
import { PublicationModalProvider } from "@/components/publication/publication-modal";

// next/link works in jsdom but its prefetch path is noisy; stub to a plain
// anchor so the href assertion below is direct.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={typeof href === "string" ? href : "#"} className={className}>
      {children}
    </a>
  ),
}));

type Hit = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number;
  publicationType: string | null;
  citationCount: number | null;
  pubmedUrl: string | null;
  doi: string | null;
  pmcid: string | null;
  impactScore: number | null;
  impactJustification: string | null;
  authors: never[];
  abstract: string | null;
  topTopic: { id: string; label: string } | null;
};

function makeHit(overrides: Partial<Hit> = {}): Hit {
  const pmid = overrides.pmid ?? "12345";
  return {
    pmid,
    title: overrides.title ?? `Paper ${pmid}`,
    journal: overrides.journal ?? "Journal of Things",
    year: overrides.year ?? 2024,
    publicationType: overrides.publicationType ?? "Academic Article",
    citationCount: overrides.citationCount ?? null,
    pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    doi: null,
    pmcid: null,
    impactScore: null,
    impactJustification: null,
    authors: [],
    abstract: null,
    topTopic: overrides.topTopic ?? null,
  };
}

type TierResponse = {
  hits: Hit[];
  total: number;
  totalAllTypes: number;
  totalResearchOnly: number;
  tierTotals: { strongly: number; also: number };
  page: number;
  pageSize: number;
};

function makeTierResponse(overrides: Partial<TierResponse> = {}): TierResponse {
  const hits = overrides.hits ?? [];
  return {
    hits,
    total: overrides.total ?? hits.length,
    totalAllTypes: overrides.totalAllTypes ?? hits.length,
    totalResearchOnly: overrides.totalResearchOnly ?? hits.length,
    tierTotals: overrides.tierTotals ?? { strongly: hits.length, also: 0 },
    page: overrides.page ?? 1,
    pageSize: overrides.pageSize ?? 20,
  };
}

/**
 * Wires fetch to dispatch on the `tier` query param so a single mock can
 * drive both strongly and also requests. Returns the spy so tests can
 * inspect what was called.
 */
function mockFetchByTier({
  strongly,
  also,
}: {
  strongly?: TierResponse;
  also?: TierResponse;
}) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const params = new URL(url).searchParams;
    const tier = params.get("tier");
    const payload =
      tier === "also"
        ? also ?? makeTierResponse()
        : tier === "strongly"
          ? strongly ?? makeTierResponse()
          : makeTierResponse();
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as unknown as Response;
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  return fetchSpy;
}

function renderFeed(props?: Partial<React.ComponentProps<typeof PublicationFeed>>) {
  return render(
    <PublicationModalProvider>
      <PublicationFeed
        topicSlug={props?.topicSlug ?? "cancer_genomics"}
        activeSubtopic={props?.activeSubtopic ?? null}
        subtopicLabel={props?.subtopicLabel ?? null}
        subtopicShortDescription={props?.subtopicShortDescription ?? null}
        suppressSubtopicHeader={props?.suppressSubtopicHeader ?? false}
      />
    </PublicationModalProvider>,
  );
}

beforeEach(() => {
  // Reset fetch each test
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PublicationFeed — two-tier display (#326)", () => {
  it("fetches tier=strongly on mount and shows hits", async () => {
    const spy = mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "111", title: "First strongly paper" })],
        tierTotals: { strongly: 1, also: 0 },
      }),
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByText("First strongly paper")).toBeDefined(),
    );
    // First call must be tier=strongly.
    const firstUrl = spy.mock.calls[0][0] as string;
    expect(new URL(firstUrl).searchParams.get("tier")).toBe("strongly");
  });

  it("hides the toggle when tierTotals.also === 0", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "111" })],
        tierTotals: { strongly: 1, also: 0 },
      }),
    });
    renderFeed();
    await waitFor(() => expect(screen.getByText("Paper 111")).toBeDefined());
    expect(
      screen.queryByRole("button", { name: /View additional articles/ }),
    ).toBeNull();
  });

  it("shows the toggle (collapsed) when both tiers have results", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "111" })],
        tierTotals: { strongly: 1, also: 4 },
      }),
    });
    renderFeed();
    const toggle = await screen.findByRole("button", {
      name: /View additional articles that are relevant \(4\)/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking the toggle fetches tier=also and reveals the section", async () => {
    const spy = mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "111", title: "Strongly paper" })],
        tierTotals: { strongly: 1, also: 2 },
      }),
      also: makeTierResponse({
        hits: [
          makeHit({ pmid: "222", title: "Also relevant paper one" }),
          makeHit({ pmid: "223", title: "Also relevant paper two" }),
        ],
        total: 2,
        tierTotals: { strongly: 1, also: 2 },
      }),
    });
    renderFeed();
    const toggle = await screen.findByRole("button", {
      name: /View additional articles that are relevant/,
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByText("Also relevant paper one")).toBeDefined(),
    );
    expect(screen.getByText("Also relevant")).toBeDefined();
    // tier=also call should have happened.
    const alsoCalls = spy.mock.calls.filter((c) => {
      const u = new URL(c[0] as string);
      return u.searchParams.get("tier") === "also";
    });
    expect(alsoCalls.length).toBeGreaterThan(0);
  });

  it("strongly-empty + also-non-empty edge case renders also list inline (no toggle)", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [],
        total: 0,
        tierTotals: { strongly: 0, also: 3 },
      }),
      also: makeTierResponse({
        hits: [makeHit({ pmid: "333", title: "Sole also-relevant paper" })],
        total: 3,
        tierTotals: { strongly: 0, also: 3 },
      }),
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByText("Sole also-relevant paper")).toBeDefined(),
    );
    // No toggle button when strongly is empty (rendered inline).
    expect(
      screen.queryByRole("button", { name: /View additional articles/ }),
    ).toBeNull();
    // No "Also relevant" subhead either — fallback renders the list as
    // the primary content.
    expect(screen.queryByText("Also relevant")).toBeNull();
  });

  it("empty result set (both tiers 0) renders the no-publications card", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [],
        total: 0,
        tierTotals: { strongly: 0, also: 0 },
      }),
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByText("No publications found")).toBeDefined(),
    );
  });
});

describe("PublicationFeed — inline top-topic label (#327)", () => {
  it("renders 'Top topic: X' as a link when hit.topTopic is non-null", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [
          makeHit({
            pmid: "555",
            topTopic: {
              id: "mental_health_psychiatry",
              label: "Mental Health & Psychiatry",
            },
          }),
        ],
        tierTotals: { strongly: 1, also: 0 },
      }),
    });
    renderFeed();
    const link = await screen.findByRole("link", {
      name: "Mental Health & Psychiatry",
    });
    expect(link.getAttribute("href")).toBe("/topics/mental_health_psychiatry");
    // "Top topic:" label appears adjacent to the link.
    expect(screen.getByText(/Top topic:/)).toBeDefined();
  });

  it("renders no inline top-topic label when hit.topTopic is null", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "556", topTopic: null })],
        tierTotals: { strongly: 1, also: 0 },
      }),
    });
    renderFeed();
    await waitFor(() => expect(screen.getByText("Paper 556")).toBeDefined());
    expect(screen.queryByText(/Top topic:/)).toBeNull();
  });

  it("top-topic label renders on Also-relevant tier hits too", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "100" })],
        tierTotals: { strongly: 1, also: 1 },
      }),
      also: makeTierResponse({
        hits: [
          makeHit({
            pmid: "777",
            title: "Cross-listed also paper",
            topTopic: { id: "biostatistics", label: "Biostatistics" },
          }),
        ],
        total: 1,
        tierTotals: { strongly: 1, also: 1 },
      }),
    });
    renderFeed();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /View additional articles that are relevant/,
      }),
    );
    const link = await screen.findByRole("link", { name: "Biostatistics" });
    expect(link.getAttribute("href")).toBe("/topics/biostatistics");
    // Confirm the label is on the also-relevant row.
    const row = screen.getByText("Cross-listed also paper").closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/Top topic:/)).toBeDefined();
  });
});
