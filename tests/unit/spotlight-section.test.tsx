/**
 * #947 — the home Spotlight section's representative-paper titles open the
 * shared publication modal (in place of the previous open-PubMed-in-a-new-tab
 * anchor), while still firing the `spotlight_paper_click` CTR beacon
 * (#286/#343). Because the home route lives outside the app/(public) group,
 * the modal provider is wrapped around the section in app/page.tsx; this test
 * renders that same provider/section pairing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SpotlightSection } from "@/components/home/spotlight-section";
import { PublicationModalProvider } from "@/components/publication/publication-modal";
import type { SpotlightCard } from "@/lib/api/home";

const card: SpotlightCard = {
  subtopicId: "sub_1",
  parentTopicSlug: "widget_science",
  parentTopicLabel: "Widget Science",
  displayName: "Widget Design",
  shortDescription: "short",
  lede: "A lede about widgets.",
  publicationCount: 42,
  scholarCount: 7,
  artifactVersion: "cycle_2026_06",
  papers: [
    {
      pmid: "12345",
      title: "A study of widgets",
      journal: "Journal of Widgets",
      year: 2024,
      authors: [
        {
          cwid: "abc1001",
          displayName: "Ada Smith",
          identityImageEndpoint: "",
          profileSlug: "ada-smith",
          roleCategory: "faculty",
        },
      ],
    },
  ],
};

function renderHome() {
  // The draw now happens on the server (#1709); the component renders exactly
  // the `items` it is handed, starting at `startIdx` (default 0). One card in →
  // that card is active, so the paper row always renders.
  return render(
    <PublicationModalProvider>
      <SpotlightSection items={[card]} />
    </PublicationModalProvider>,
  );
}

let beacon: ReturnType<typeof vi.fn>;

beforeEach(() => {
  beacon = vi.fn();
  // jsdom has no sendBeacon; define it so the row's SSR guard does not no-op.
  Object.defineProperty(navigator, "sendBeacon", {
    value: beacon,
    configurable: true,
    writable: true,
  });
  // Minimal detail payload so the modal can mount its dialog on open().
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      pub: {
        pmid: "12345",
        title: "A study of widgets",
        journal: "Journal of Widgets",
        year: 2024,
        volume: null,
        issue: null,
        pages: null,
        fullAuthorsString: null,
        abstract: null,
        impactScore: null,
        impactJustification: null,
        citationCount: 0,
        pmcid: null,
        doi: null,
        pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/12345/",
        meshTerms: [],
        synopsis: null,
      },
      topics: [],
      methodFamilies: [],
      citingPubs: [],
      citingPubsTotal: 0,
    }),
  })) as unknown as typeof fetch;
  document.body.style.overflow = "";
});

afterEach(() => {
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

describe("SpotlightSection — representative-paper title (#947)", { retry: 2 }, () => {
  it("renders the paper title as a button, not a PubMed anchor", () => {
    renderHome();
    const title = screen.getByRole("button", { name: "A study of widgets" });
    expect(title.tagName).toBe("BUTTON");
    // The title is no longer an <a href={pubmedUrl} target="_blank">.
    expect(
      screen.queryAllByRole("link", { name: "A study of widgets" }).length,
    ).toBe(0);
  });

  it("opens the publication modal and still fires the CTR beacon on title click", async () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "A study of widgets" }));
    // Modal opens — the provider context is reachable on the home route.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    // #286/#343 CTR beacon preserved alongside open(pmid).
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0] as [string, Blob];
    expect(url).toBe("/api/analytics");
    // jsdom's Blob has no .text(); read it via FileReader.
    const text = await new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.readAsText(body);
    });
    const payload = JSON.parse(text);
    expect(payload.event).toBe("spotlight_paper_click");
    expect(payload.pmid).toBe("12345");
  });
});

describe("SpotlightSection — absent counts are not zero counts (#2218)", () => {
  function renderCard(over: Partial<SpotlightCard>) {
    return render(
      <PublicationModalProvider>
        <SpotlightSection items={[{ ...card, ...over }]} />
      </PublicationModalProvider>,
    );
  }

  it("renders both count links when the aggregate row exists", () => {
    renderCard({});
    const pubs = screen.getByRole("link", {
      name: /Browse all 42 publications in Widget Design/,
    });
    expect(pubs.getAttribute("href")).toBe(
      "/topics/widget_science?subtopic=sub_1#publications",
    );
    expect(
      screen.getByRole("link", { name: /Browse all 7 scholars working in Widget Design/ }),
    ).toBeDefined();
  });

  it("never prints '0 publications · 0 scholars' when the counts are unknown", () => {
    // The 2026-08-01 taxonomy split retired a subtopic under a still-published
    // artifact; the aggregate returns no row, which the DAL now reports as null.
    // Rendering it as a confident zero — beside a real representative paper —
    // is the user-facing half of #2218.
    renderCard({ publicationCount: null, scholarCount: null });
    expect(screen.queryByText(/publications/)).toBeNull();
    expect(screen.queryByText(/scholars/)).toBeNull();
    expect(screen.queryAllByRole("link", { name: /Browse all/ })).toHaveLength(0);
  });

  it("falls back to the parent topic page rather than deep-linking a subtopic that may be gone", () => {
    renderCard({ publicationCount: null, scholarCount: null });
    const title = screen.getByRole("link", { name: "View subarea Widget Design" });
    expect(title.getAttribute("href")).toBe("/topics/widget_science");
    // The paper itself still renders — only the dead subtopic links are dropped.
    expect(screen.getByRole("button", { name: "A study of widgets" })).toBeDefined();
  });

  it("degrades one side at a time (scholars known, publications not)", () => {
    renderCard({ publicationCount: null });
    expect(screen.queryByText(/publications/)).toBeNull();
    expect(
      screen.getByRole("link", { name: /Browse all 7 scholars working in Widget Design/ }),
    ).toBeDefined();
  });
});
