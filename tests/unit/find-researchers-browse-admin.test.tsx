/**
 * Matcha-admin Phase 1b — the Browse-tab corpus-freshness strip and the
 * MATCHA_ADMIN suppress/restore controls (`components/edit/opportunity-browse.tsx`):
 *  - `freshnessTone` bucket boundaries (13/14/30/31 days);
 *  - the strip's headline (newest ingest, warning-toned when stale) + per-source rows;
 *  - NO admin affordances and NO strip without the opt-in props — a plain
 *    `BrowseList` mount renders byte-identically to before Phase 1b;
 *  - Suppress → confirm dialog (mockup copy) → PATCH `/api/edit/opportunity-admin`
 *    with the optional reason → list refetch;
 *  - Show suppressed refetches with `includeSuppressed=1`; suppressed rows render
 *    muted with attribution and a Restore action that PATCHes `restore`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/edit/grant-matcha",
  useSearchParams: () => new URLSearchParams(""),
}));

import { BrowseList, CorpusFreshness, freshnessTone } from "@/components/edit/opportunity-browse";

const DAY = 86_400_000;
const NOW = new Date("2026-08-20T12:00:00.000Z").getTime();

/** An ISO timestamp exactly `days` days before NOW. */
function iso(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

const OPPS = [
  {
    opportunityId: "wcm_curated:hartwell-abc123",
    title: "Hartwell Individual Biomedical Research Award",
    sponsor: "The Hartwell Foundation",
    mechanism: null,
    dueDate: null,
    source: "wcm_curated",
    status: "open",
    awardFloor: null,
    awardCeiling: null,
    suppressedAt: null,
    suppressedBy: null,
    suppressReason: null,
  },
];

const SUPPRESSED = {
  opportunityId: "manual_url:dup-def456",
  title: "Duplicate Prize Listing",
  sponsor: "Other Org",
  mechanism: null,
  dueDate: null,
  source: "manual_url",
  status: "open",
  awardFloor: null,
  awardCeiling: null,
  suppressedAt: "2026-08-18T15:00:00.000Z",
  suppressedBy: "flm4001",
  suppressReason: "duplicate row",
};

const SOURCES = [
  { source: "wcm_curated", count: 374, newestIngestedAt: iso(52) },
  { source: "grants_gov", count: 634, newestIngestedAt: iso(59) },
  { source: "manual_url", count: 1, newestIngestedAt: iso(45) },
];

/** Every fetch call the component made, with parsed PATCH bodies. */
const calls: Array<{ url: string; method: string; body?: unknown }> = [];

/** GET → the list fixture (suppressed rows only under includeSuppressed=1); PATCH → `patch`. */
function stubFetch({
  suppressed = [] as Array<Record<string, unknown>>,
  patch = { status: 200, body: {} as object },
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "PATCH") {
        return { ok: patch.status < 400, status: patch.status, json: async () => patch.body };
      }
      const opportunities = url.includes("includeSuppressed=1") ? [...OPPS, ...suppressed] : OPPS;
      return {
        ok: true,
        status: 200,
        json: async () => ({ count: opportunities.length, opportunities, sources: SOURCES }),
      };
    }),
  );
}

describe("freshnessTone — age buckets", () => {
  it("13d is fresh, 14d and 30d are aging, 31d is stale", () => {
    expect(freshnessTone(13)).toBe("fresh");
    expect(freshnessTone(14)).toBe("aging");
    expect(freshnessTone(30)).toBe("aging");
    expect(freshnessTone(31)).toBe("stale");
  });
});

describe("CorpusFreshness — the strip", () => {
  it("renders the headline date off the newest ingest and one toned row per source", () => {
    render(
      <CorpusFreshness
        sources={[
          { source: "wcm_curated", count: 374, newestIngestedAt: iso(13) },
          { source: "grants_gov", count: 634, newestIngestedAt: iso(14) },
          { source: "manual_url", count: 1, newestIngestedAt: iso(31) },
        ]}
        now={NOW}
      />,
    );
    const headline = screen.getByTestId("corpus-freshness-headline");
    expect(headline.textContent).toContain("Corpus freshness — newest row");
    expect(headline.textContent).toContain("13 days ago");
    // The DATE is the newest row's; the TONE is the worst source's (manual_url, 31d).
    // This used to assert "fresh" — off the 13d max — which is exactly the masking that
    // let the corpus freeze unnoticed. See the worst-source test below.
    expect(headline.getAttribute("data-tone")).toBe("stale");

    const curated = screen.getByTestId("freshness-wcm_curated");
    expect(curated.textContent).toContain("WCM curated");
    expect(curated.textContent).toContain("374");
    expect(curated.textContent).toContain("(13d)");
    expect(curated.querySelector("[data-tone]")!.getAttribute("data-tone")).toBe("fresh");
    expect(
      screen.getByTestId("freshness-grants_gov").querySelector("[data-tone]")!.getAttribute("data-tone"),
    ).toBe("aging");
    expect(
      screen.getByTestId("freshness-manual_url").querySelector("[data-tone]")!.getAttribute("data-tone"),
    ).toBe("stale");
    // "Submitted URL" is the manual_url display label — raw source keys never render.
    expect(screen.getByTestId("freshness-manual_url").textContent).toContain("Submitted URL");
  });

  it("warning-tones the headline when even the newest row is stale", () => {
    render(
      <CorpusFreshness
        sources={[{ source: "manual_url", count: 1, newestIngestedAt: iso(45) }]}
        now={NOW}
      />,
    );
    const headline = screen.getByTestId("corpus-freshness-headline");
    expect(headline.getAttribute("data-tone")).toBe("stale");
    expect(headline.textContent).toContain("45 days ago");
  });

  /**
   * 🔴 The regression these two pin is the six-week silent freeze itself.
   *
   * Note what they assert and what they do NOT: `getByTestId` and `textContent` are
   * blind to visibility (jsdom loads no stylesheet, so `class="hidden"` hides nothing),
   * so the per-source assertions above would pass identically against a disclosure that
   * could never be opened. `aria-expanded` and the `hidden` class are the observables
   * that actually move.
   */
  it("collapses by default when every source is fresh, and the trigger opens it", () => {
    render(
      <CorpusFreshness
        sources={[
          { source: "wcm_curated", count: 374, newestIngestedAt: iso(3) },
          { source: "grants_gov", count: 634, newestIngestedAt: iso(6) },
        ]}
        now={NOW}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Corpus freshness/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("corpus-freshness-detail")!.className).toContain("hidden");
    // Nothing is being hidden from anyone here — an all-fresh corpus is allowed to be compact.
    expect(screen.getByTestId("corpus-freshness-headline").getAttribute("data-tone")).toBe("fresh");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("corpus-freshness-detail")!.className).not.toContain("hidden");
    expect(screen.getByTestId("freshness-wcm_curated").textContent).toContain("374");
  });

  it("seeds itself OPEN and tones the pill by the WORST source, never the newest", () => {
    render(
      <CorpusFreshness
        sources={[
          { source: "wcm_curated", count: 374, newestIngestedAt: iso(3) },
          { source: "grants_gov", count: 634, newestIngestedAt: iso(6) },
          { source: "manual_url", count: 1, newestIngestedAt: iso(31) },
        ]}
        now={NOW}
      />,
    );
    // One source has been dead a month. A pill read off the MAX ingest would show the
    // reassuring grey "3 days ago" branch and stay collapsed over the top of it.
    const trigger = screen.getByRole("button", { name: /Corpus freshness/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("corpus-freshness-detail")!.className).not.toContain("hidden");

    const headline = screen.getByTestId("corpus-freshness-headline");
    expect(headline.textContent).toContain("3 days ago");
    expect(headline.getAttribute("data-tone")).toBe("stale");
    // …and the pill says which source it is toned for, so the red is not a mystery.
    expect(headline.textContent).toContain("oldest Submitted URL 31d");
  });

  it("gives the per-source detail real table semantics, not a bare grid", () => {
    render(
      <CorpusFreshness
        sources={[{ source: "wcm_curated", count: 374, newestIngestedAt: iso(31) }]}
        now={NOW}
      />,
    );
    const table = screen.getByRole("table", { name: "Corpus freshness by source" });
    expect(within(table).getByRole("columnheader", { name: "Source" })).toBeTruthy();
    // NOT "Rows": `sources` comes from an UNFILTERED groupBy, so it is never the list's
    // denominator. NOT "Last updated": the cell renders `ingestedAt`, and the whole point
    // of this strip is that `lastRefreshedAt` is the field that lies.
    expect(within(table).getByRole("columnheader", { name: "Corpus rows" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Last ingested" })).toBeTruthy();
    const row = screen.getByTestId("freshness-wcm_curated");
    expect(row.getAttribute("role")).toBe("row");
    expect(within(row).getAllByRole("cell")).toHaveLength(3);
  });

  it("renders nothing at all with no dated sources", () => {
    const { container } = render(
      <CorpusFreshness sources={[{ source: "grants_gov", count: 0, newestIngestedAt: null }]} now={NOW} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("BrowseList — admin gating (default off)", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders no strip, no toggle, no row actions, and the unchanged fetch URL", async () => {
    stubFetch();
    render(<BrowseList hrefFor={(id) => `/edit/grant-matcha?opp=${id}`} />);
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Funding opportunities" })).toBeTruthy(),
    );

    // The exact pre-Phase-1b URL — no includeSuppressed param leaks in.
    expect(calls[0].url).toBe("/api/opportunities?limit=500");
    expect(screen.queryByTestId("corpus-freshness")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Show suppressed/ })).toBeNull();
    expect(screen.queryByTestId("opportunity-suppress")).toBeNull();
    // Still the pre-existing fields, unaffected by the flag being off.
    const list = screen.getByRole("list", { name: "Funding opportunities" });
    expect(within(list).getByText("The Hartwell Foundation")).toBeTruthy();
  });

  it("freshness alone (flag off) shows the strip but still no admin controls", async () => {
    stubFetch();
    render(<BrowseList hrefFor={(id) => `/edit/grant-matcha?opp=${id}`} freshness />);
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Funding opportunities" })).toBeTruthy(),
    );
    expect(screen.getByTestId("corpus-freshness")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Show suppressed/ })).toBeNull();
    expect(screen.queryByTestId("opportunity-suppress")).toBeNull();
  });
});

describe("BrowseList — MATCHA_ADMIN suppress/restore", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function renderAdmin(opts?: Parameters<typeof stubFetch>[0]) {
    stubFetch(opts);
    render(<BrowseList hrefFor={(id) => `/edit/grant-matcha?opp=${id}`} freshness admin />);
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Funding opportunities" })).toBeTruthy(),
    );
  }

  it("Suppress opens the confirm dialog and PATCHes with the typed reason, then refetches", async () => {
    await renderAdmin();
    fireEvent.click(screen.getByTestId("opportunity-suppress"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Suppress this opportunity?")).toBeTruthy();
    // The opportunity title is quoted back, and the body states the CDN + nightly contract.
    expect(dialog.textContent).toContain("Hartwell Individual Biomedical Research Award");
    expect(dialog.textContent).toContain(
      "Hidden immediately from browse; cached detail pages can linger up to ~15 minutes (CDN). Matching surfaces that read the search index clear on the next nightly run. The nightly sync will NOT undo this; restore any time from Browse.",
    );

    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: "duplicate row" },
    });
    fireEvent.click(screen.getByTestId("suppress-opportunity-confirm"));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/edit/opportunity-admin");
    expect(patch.body).toEqual({
      opportunityId: "wcm_curated:hartwell-abc123",
      action: "suppress",
      reason: "duplicate row",
    });
    // The list refetches after the write.
    await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2));
  });

  it("a blank reason is omitted from the PATCH body, not sent as an empty string", async () => {
    await renderAdmin();
    fireEvent.click(screen.getByTestId("opportunity-suppress"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("suppress-opportunity-confirm"));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      opportunityId: "wcm_curated:hartwell-abc123",
      action: "suppress",
    });
  });

  it("Cancel closes the dialog without any PATCH", async () => {
    await renderAdmin();
    fireEvent.click(screen.getByTestId("opportunity-suppress"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("Show suppressed refetches with includeSuppressed=1 and renders muted rows with Restore", async () => {
    await renderAdmin({ suppressed: [SUPPRESSED] });
    fireEvent.click(screen.getByRole("checkbox", { name: /Show suppressed/ }));

    await waitFor(() => expect(screen.getByTestId("suppressed-note")).toBeTruthy());
    expect(calls.at(-1)!.url).toContain("includeSuppressed=1");

    const note = screen.getByTestId("suppressed-note");
    expect(note.textContent).toContain("suppressed Aug 18, 2026 by flm4001");
    const row = note.closest("li")!;
    expect(row.className).toContain("opacity-60");
    // Suppressed rows offer Restore; live rows keep Suppress.
    expect(within(row).getByTestId("opportunity-restore")).toBeTruthy();
    expect(screen.getByTestId("opportunity-suppress")).toBeTruthy();

    fireEvent.click(within(row).getByTestId("opportunity-restore"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      opportunityId: "manual_url:dup-def456",
      action: "restore",
    });
  });

  it("surfaces a mapped message on a 409 and still refetches", async () => {
    await renderAdmin({ patch: { status: 409, body: { error: "already_suppressed" } } });
    fireEvent.click(screen.getByTestId("opportunity-suppress"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("suppress-opportunity-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("opportunity-admin-error").textContent).toBe(
        "Already suppressed — refreshing the list.",
      ),
    );
    await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2));
  });
});
