/**
 * Component tests for the two-tier display and inline best-fit label on
 * `components/topic/publication-feed.tsx` for #326 + #327, refined to use
 * a top-of-list scope select (replaces the prior bottom disclosure button)
 * and the "Best fit:" copy on its own row.
 *
 * Scope:
 *   - Default load only fetches `tier=strongly`. The Show select hides
 *     when the parent topic has no also-tier papers under the active
 *     pub-type filter (`parentTierTotals.also === 0`).
 *   - When the parent has also-tier papers, the Show select renders even
 *     on subtopic views whose own `tierTotals.also === 0` — option labels
 *     use subtopic-scoped counts so the user sees that switching modes
 *     would be a no-op for the current scope (#326 subtopic-consistency
 *     refinement).
 *   - Switching to "All relevant" issues a `tier=also` request and
 *     renders the rows under the "Also relevant" subheading.
 *   - Switching back to "Strongly relevant" hides the also rows without
 *     issuing a second `tier=strongly` request (stale cache reused).
 *   - Strongly-empty + Also-non-empty edge case renders the also rows
 *     inline without the select (spec: "Should be rare given default
 *     display_threshold ~0.5").
 *   - Inline `Best fit: X` label (#327) renders on its own line below
 *     journal/year — NOT inside the same DOM element as the journal text.
 *     Suppressed when `topTopic` is null.
 *
 * Radix Select is replaced with a plain HTML <select> harness at the
 * module mock layer so `fireEvent.change` can drive scope switches —
 * jsdom can't reliably open Radix portals.
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

// Radix Select renders a portal that's flaky in jsdom; swap for a native
// <select> with the same value/onValueChange contract. Tests drive scope
// switches via fireEvent.change on the select identified by its
// aria-label (Show / Sort by).
vi.mock("@/components/ui/select", () => {
  type SelectProps = {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  };
  return {
    Select: ({ value, onValueChange, children }: SelectProps) => (
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        data-mock-select
      >
        {children}
      </select>
    ),
    SelectTrigger: ({
      children,
      "aria-label": ariaLabel,
    }: {
      children: React.ReactNode;
      "aria-label"?: string;
    }) => (
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
  parentTierTotals: { strongly: number; also: number };
  page: number;
  pageSize: number;
};

function makeTierResponse(overrides: Partial<TierResponse> = {}): TierResponse {
  const hits = overrides.hits ?? [];
  const tierTotals = overrides.tierTotals ?? { strongly: hits.length, also: 0 };
  return {
    hits,
    total: overrides.total ?? hits.length,
    totalAllTypes: overrides.totalAllTypes ?? hits.length,
    totalResearchOnly: overrides.totalResearchOnly ?? hits.length,
    tierTotals,
    // Default: parent matches the in-scope totals. Tests that exercise
    // the subtopic-consistency refinement (subtopic also=0 but parent
    // also>0) override this explicitly.
    parentTierTotals: overrides.parentTierTotals ?? tierTotals,
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

/**
 * Find the mocked native <select> for the "Show" scope control. The
 * mocked SelectTrigger preserves the source aria-label as a data
 * attribute on an inner <optgroup>; we walk back up to the parent
 * <select>. Returns null if the select isn't rendered (tier select hidden).
 */
function getShowSelect(): HTMLSelectElement | null {
  const trigger = document.querySelector(
    "optgroup[data-trigger-aria='Show']",
  ) as HTMLElement | null;
  return (trigger?.closest("select") as HTMLSelectElement | null) ?? null;
}

beforeEach(() => {
  // Reset fetch each test
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PublicationFeed — two-tier display via Show scope select (#326)", () => {
  it("fetches tier=strongly on mount and the Show select defaults to 'strongly'", async () => {
    const spy = mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "111", title: "First strongly paper" })],
        tierTotals: { strongly: 1, also: 3 },
      }),
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByText("First strongly paper")).toBeDefined(),
    );
    const firstUrl = spy.mock.calls[0][0] as string;
    expect(new URL(firstUrl).searchParams.get("tier")).toBe("strongly");
    const showSelect = getShowSelect();
    expect(showSelect).not.toBeNull();
    expect(showSelect!.value).toBe("strongly");
  });

  it("hides the Show select when parent topic has no also-tier papers", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "111" })],
        tierTotals: { strongly: 1, also: 0 },
        parentTierTotals: { strongly: 1, also: 0 },
      }),
    });
    renderFeed();
    await waitFor(() => expect(screen.getByText("Paper 111")).toBeDefined());
    expect(getShowSelect()).toBeNull();
  });

  it("shows the Show select when subtopic also=0 but parent also>0 (consistency refinement)", async () => {
    // Subtopic-scoped tier totals: strongly=25, also=0. Parent topic
    // under the same pub-type filter has 134/38. The select must render
    // so the topic → subtopic UX is consistent. Option labels use the
    // subtopic-scoped counts so the user sees both options read "(25)"
    // and knows switching is a no-op for this scope.
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "111" })],
        tierTotals: { strongly: 25, also: 0 },
        parentTierTotals: { strongly: 134, also: 38 },
      }),
    });
    renderFeed();
    await waitFor(() => expect(getShowSelect()).not.toBeNull());
    const showSelect = getShowSelect()!;
    const labels = Array.from(showSelect.querySelectorAll("option")).map(
      (o) => o.textContent ?? "",
    );
    expect(labels.some((l) => /Strongly relevant \(25\)/.test(l))).toBe(true);
    expect(labels.some((l) => /All relevant \(25\)/.test(l))).toBe(true);
  });

  it("renders both options with subtopic-scoped counts in the dropdown", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "111" })],
        tierTotals: { strongly: 1, also: 4 },
        parentTierTotals: { strongly: 1, also: 4 },
      }),
    });
    renderFeed();
    await waitFor(() => expect(getShowSelect()).not.toBeNull());
    const showSelect = getShowSelect()!;
    const options = Array.from(showSelect.querySelectorAll("option"));
    const labels = options.map((o) => o.textContent ?? "");
    expect(labels.some((l) => /Strongly relevant \(1\)/.test(l))).toBe(true);
    expect(labels.some((l) => /All relevant \(5\)/.test(l))).toBe(true);
  });

  it("switching to 'All relevant' fetches tier=also and reveals the section", async () => {
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
    await waitFor(() => expect(getShowSelect()).not.toBeNull());
    fireEvent.change(getShowSelect()!, { target: { value: "all" } });
    await waitFor(() =>
      expect(screen.getByText("Also relevant paper one")).toBeDefined(),
    );
    expect(screen.getByText("Also relevant")).toBeDefined();
    const alsoCalls = spy.mock.calls.filter((c) => {
      const u = new URL(c[0] as string);
      return u.searchParams.get("tier") === "also";
    });
    expect(alsoCalls.length).toBeGreaterThan(0);
  });

  it("switching back to 'Strongly relevant' hides also rows and does not refetch strongly", async () => {
    const spy = mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "111", title: "Strongly paper" })],
        tierTotals: { strongly: 1, also: 1 },
      }),
      also: makeTierResponse({
        hits: [makeHit({ pmid: "222", title: "Also relevant paper" })],
        total: 1,
        tierTotals: { strongly: 1, also: 1 },
      }),
    });
    renderFeed();
    await waitFor(() => expect(getShowSelect()).not.toBeNull());
    fireEvent.change(getShowSelect()!, { target: { value: "all" } });
    await waitFor(() =>
      expect(screen.getByText("Also relevant paper")).toBeDefined(),
    );
    const stronglyCallsBefore = spy.mock.calls.filter(
      (c) => new URL(c[0] as string).searchParams.get("tier") === "strongly",
    ).length;
    fireEvent.change(getShowSelect()!, { target: { value: "strongly" } });
    await waitFor(() =>
      expect(screen.queryByText("Also relevant paper")).toBeNull(),
    );
    const stronglyCallsAfter = spy.mock.calls.filter(
      (c) => new URL(c[0] as string).searchParams.get("tier") === "strongly",
    ).length;
    expect(stronglyCallsAfter).toBe(stronglyCallsBefore);
    expect(screen.queryByText("Also relevant")).toBeNull();
  });

  it("strongly-empty + also-non-empty edge case renders also list inline (no Show select)", async () => {
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
    // No Show select when strongly is empty — the choice would be misleading.
    expect(getShowSelect()).toBeNull();
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

describe("PublicationFeed — inline best-fit label (#327)", () => {
  it("renders 'Best fit: X' as a link when hit.topTopic is non-null", async () => {
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
    expect(screen.getByText(/Best fit:/)).toBeDefined();
  });

  it("renders no inline best-fit label when hit.topTopic is null", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [makeHit({ pmid: "556", topTopic: null })],
        tierTotals: { strongly: 1, also: 0 },
      }),
    });
    renderFeed();
    await waitFor(() => expect(screen.getByText("Paper 556")).toBeDefined());
    expect(screen.queryByText(/Best fit:/)).toBeNull();
  });

  it("best-fit label renders on its own row, NOT inside the journal/year line", async () => {
    mockFetchByTier({
      strongly: makeTierResponse({
        hits: [
          makeHit({
            pmid: "557",
            journal: "Bibliographic Journal",
            year: 2023,
            topTopic: { id: "biostatistics", label: "Biostatistics" },
          }),
        ],
        tierTotals: { strongly: 1, also: 0 },
      }),
    });
    renderFeed();
    const bestFitText = await screen.findByText(/Best fit:/);
    const bestFitRow = bestFitText.closest("div");
    expect(bestFitRow).not.toBeNull();
    // The wrapper around "Best fit:" must NOT contain the journal text.
    // (If it did, we'd have regressed to the prior middot-chain layout.)
    expect(bestFitRow!.textContent ?? "").not.toMatch(/Bibliographic Journal/);
    expect(bestFitRow!.textContent ?? "").not.toMatch(/2023/);
  });

  it("best-fit label renders on All-relevant rows too", async () => {
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
    await waitFor(() => expect(getShowSelect()).not.toBeNull());
    fireEvent.change(getShowSelect()!, { target: { value: "all" } });
    const link = await screen.findByRole("link", { name: "Biostatistics" });
    expect(link.getAttribute("href")).toBe("/topics/biostatistics");
    const row = screen.getByText("Cross-listed also paper").closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/Best fit:/)).toBeDefined();
  });
});
