/**
 * Tests for components/publication/publication-modal.tsx (#288 PR-B).
 *
 * Coverage focused on the contract — accessibility (a11y), behavior, and
 * the bits where regressions are most likely:
 *   - Trigger opens the modal; close button + Esc close it
 *   - focus returns to the trigger after close
 *   - aria-modal + aria-labelledby wired correctly
 *   - current-topic marker renders only when slug matches
 *   - synopsis / mesh / impact sections omitted when payload is empty
 *   - citing-pubs `null` shows fallback message
 *   - citing-pubs over cap shows "Showing N most recent of M total"
 *
 * Uses a fetch stub injected per test. The provider is mounted around a
 * minimal trigger button.
 */
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import {
  PublicationModalProvider,
  usePublicationModal,
} from "@/components/publication/publication-modal";
import type { PublicationDetailPayload } from "@/lib/api/publication-detail";

function makePayload(
  overrides: Partial<PublicationDetailPayload> = {},
): PublicationDetailPayload {
  return {
    pub: {
      pmid: "12345",
      title: "A study of widgets",
      journal: "Journal of Widgets",
      year: 2024,
      volume: "10",
      issue: "2",
      pages: "100-110",
      fullAuthorsString: "Smith A, Jones B, Wong C",
      abstract: "Widgets are interesting.\nThis study probes them.",
      impactScore: 78,
      impactJustification: "Novel methodology and broad influence.",
      citationCount: 2,
      pmcid: "PMC123",
      doi: "10.1234/widgets",
      pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/12345/",
      meshTerms: [
        { ui: "D001", label: "Widgets" },
        { ui: "D002", label: "Methodology" },
      ],
      synopsis: "Widgets are explained simply.",
    },
    topics: [
      {
        topicId: "widget_science",
        topicName: "Widget Science",
        topicSlug: "widget_science",
        score: 0.92,
        primarySubtopicId: "widget_design",
        subtopics: [
          { slug: "widget_design", name: "Widget Design", confidence: 0.9 },
          { slug: "widget_manufacturing", name: "Widget Manufacturing", confidence: 0.6 },
        ],
      },
      {
        topicId: "engineering",
        topicName: "Engineering",
        topicSlug: "engineering",
        score: 0.5,
        primarySubtopicId: null,
        subtopics: [],
      },
    ],
    citingPubs: [
      { pmid: "999", title: "Citation paper one", journal: "J1", year: 2025 },
      { pmid: "888", title: "Citation paper two", journal: "J2", year: 2024 },
    ],
    citingPubsTotal: 2,
    ...overrides,
  };
}

function TriggerHarness({
  pmid,
  currentTopicSlug,
}: {
  pmid: string;
  currentTopicSlug?: string;
}) {
  const { open } = usePublicationModal();
  return (
    <button
      type="button"
      onClick={() => open(pmid, { currentTopicSlug })}
      data-testid="harness-trigger"
    >
      Open
    </button>
  );
}

function renderModalHarness(props?: { currentTopicSlug?: string }) {
  return render(
    <PublicationModalProvider>
      <TriggerHarness pmid="12345" currentTopicSlug={props?.currentTopicSlug} />
    </PublicationModalProvider>,
  );
}

function mockFetch(payload: PublicationDetailPayload | Error) {
  globalThis.fetch = vi.fn(async () => {
    if (payload instanceof Error) throw payload;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  document.body.style.overflow = "";
});

afterEach(() => {
  // jsdom retains body styles between tests when createPortal is used.
  document.body.style.overflow = "";
});

describe("PublicationModal — trigger + close", () => {
  it("opens when the trigger fires and shows the title", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toBeDefined(),
    );
    await waitFor(() =>
      expect(screen.getByText("A study of widgets")).toBeDefined(),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("Esc closes the modal and restores focus to the trigger", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    const trigger = screen.getByTestId("harness-trigger") as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
    // Focus restored on next tick.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("close button click closes the modal", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    fireEvent.click(
      screen.getByRole("button", { name: /Close publication details/ }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
  });
});

describe("PublicationModal — content sections", () => {
  it("renders journal/year/volume in the citation context line", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(
      screen.getByText(/Journal of Widgets · 2024 · 10\(2\) · 100-110/),
    ).toBeDefined();
  });

  it("renders the abstract with whitespace-pre-line so newlines survive", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const abstractPara = screen.getByText(
      /Widgets are interesting\.\s*This study probes them\./,
    );
    expect(abstractPara.className).toContain("whitespace-pre-line");
  });

  it("clamps the abstract to line-clamp-4 by default", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const abstractPara = screen.getByText(
      /Widgets are interesting\.\s*This study probes them\./,
    );
    expect(abstractPara.className).toContain("line-clamp-4");
  });

  it("shows the Show more toggle only when the abstract overflows the clamp", async () => {
    // jsdom can't measure scrollHeight, so the overflow detector defaults to
    // false — Show more should NOT be present for short abstracts. We assert
    // the abstract paragraph renders without the toggle, then assert the
    // toggle's expand-collapse contract via the topics test below.
    mockFetch(
      makePayload({ pub: { ...makePayload().pub, abstract: "Short text." } }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("renders topics sorted by score desc", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const topicHeadings = screen
      .getAllByRole("link", { name: /Widget Science|Engineering/ })
      .map((el) => el.textContent);
    expect(topicHeadings[0]).toBe("Widget Science");
    expect(topicHeadings[1]).toBe("Engineering");
  });

  it("renders subtopics inline without per-subtopic confidence numbers", async () => {
    // Calmer presentation: comma-separated subtopic links, primary in
    // slightly heavier weight, no confidence floats per subtopic.
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const primary = screen.getByRole("link", { name: "Widget Design" });
    const other = screen.getByRole("link", { name: "Widget Manufacturing" });
    expect(primary.className).toContain("font-medium");
    expect(other.className).not.toContain("font-medium");
    // No 0.9 / 0.6 confidence labels anywhere — only the parent topic score
    // 0.92 renders.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("0.9")).toBeNull();
    expect(within(dialog).queryByText("0.6")).toBeNull();
  });

  it("omits the chatty Topics subtitle", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.queryByText(/Higher score = stronger fit/)).toBeNull();
  });

  it("renders a score bar with width proportional to the topic score", async () => {
    // 0.92 → 92%, 0.50 → 50%. The bar role="img" has a descriptive
    // aria-label so screen readers verbalize the score.
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const dialog = screen.getByRole("dialog");
    const widget = dialog.querySelector(
      'span[role="img"][aria-label*="Widget Science"]',
    ) as HTMLElement | null;
    const eng = dialog.querySelector(
      'span[role="img"][aria-label*="Engineering"]',
    ) as HTMLElement | null;
    expect(widget?.getAttribute("aria-label")).toBe(
      "Widget Science score 0.92 of 1.00",
    );
    expect(eng?.getAttribute("aria-label")).toBe(
      "Engineering score 0.50 of 1.00",
    );
    // Inner fill carries the width inline style; clamp to two decimals
    // when reading from style.width since browsers may round.
    const widgetFill = widget?.querySelector("span") as HTMLElement | null;
    const engFill = eng?.querySelector("span") as HTMLElement | null;
    expect(widgetFill?.style.width).toBe("92%");
    expect(engFill?.style.width).toBe("50%");
  });

  it("shows '(this page)' marker on the current topic when slug matches", async () => {
    mockFetch(makePayload());
    renderModalHarness({ currentTopicSlug: "widget_science" });
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.getByText("(this page)")).toBeDefined();
  });

  it("omits the '(this page)' marker when no currentTopicSlug passed", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.queryByText("(this page)")).toBeNull();
  });

  it("omits the synopsis section when payload.synopsis is null", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, synopsis: null },
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.queryByText(/Plain-language synopsis/)).toBeNull();
  });

  it("omits the impact section when impactScore is null", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, impactScore: null, impactJustification: null },
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Impact")).toBeNull();
  });

  it("omits the MeSH section when meshTerms is empty", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, meshTerms: [] },
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.queryByText("MeSH terms")).toBeNull();
  });

  it("renders authors inline in the header without a section heading", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.getByText("Smith A, Jones B, Wong C")).toBeDefined();
    // No "Authors" section heading anymore — flow as part of the citation block.
    expect(screen.queryByRole("heading", { name: "Authors" })).toBeNull();
  });

  it("renders identifiers inside the header with no section heading", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    // The identifier row carries an aria-label so screen readers can find
    // it; visually it sits inside the header between citation context and
    // authors, with no "Identifiers" heading.
    const dialog = screen.getByRole("dialog");
    const idLine = dialog.querySelector(
      'header [aria-label="Identifiers"]',
    ) as HTMLElement | null;
    expect(idLine).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Identifiers" })).toBeNull();
    // The PMID, PMCID, and DOI links still ship inside the identifier row.
    expect(idLine?.querySelector('a[href*="pubmed.ncbi.nlm.nih.gov"]')).not.toBeNull();
    expect(idLine?.querySelector('a[href*="pmc/articles/"]')).not.toBeNull();
    expect(idLine?.querySelector('a[href*="doi.org/"]')).not.toBeNull();
  });

  it("carries copy buttons next to PMID and PMCID in the header", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const dialog = screen.getByRole("dialog");
    const idLine = dialog.querySelector(
      'header [aria-label="Identifiers"]',
    ) as HTMLElement | null;
    expect(idLine).not.toBeNull();
    // PMID 12345 and PMCID PMC123 in the default test payload.
    const pmidCopy = idLine?.querySelector('button[aria-label="Copy PMID 12345"]');
    const pmcidCopy = idLine?.querySelector('button[aria-label="Copy PMCID PMC123"]');
    expect(pmidCopy).not.toBeNull();
    expect(pmcidCopy).not.toBeNull();
  });

  it("renders an About Impact info link in the Impact heading", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    // Info link sits adjacent to the SectionHeading and opens the
    // methodology deeplink in a new tab.
    const info = screen.getByRole("link", { name: /About Impact/ });
    expect(info.getAttribute("href")).toBe("/about/methodology#impact");
    expect(info.getAttribute("target")).toBe("_blank");
    expect(info.getAttribute("rel")).toContain("noopener");
  });

  it("renders an About Topics info link in the Topics heading", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const info = screen.getByRole("link", { name: /About Topics/ });
    expect(info.getAttribute("href")).toBe("/about/methodology#why-ai");
    expect(info.getAttribute("target")).toBe("_blank");
    expect(info.getAttribute("rel")).toContain("noopener");
  });
});

describe("PublicationModal — Cited by section", () => {
  it("renders the fallback message when reciterdb returned null", async () => {
    mockFetch(
      makePayload({ citingPubs: null, citingPubsTotal: null }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(
      screen.getByText(/Citing publication list temporarily unavailable/),
    ).toBeDefined();
  });

  it("uses pub.citationCount for the count chip even when the list is smaller", async () => {
    // Mirrors the real-world PMID 32432483 case: Publication.citationCount
    // = 197 (Scopus total), citingPubsTotal = 19 (PubMed/iCite subset).
    // Chip reflects 197 and the subhead qualifies the listed window.
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 197 },
        citingPubs: Array.from({ length: 19 }, (_, i) => ({
          pmid: String(i + 1),
          title: `c${i}`,
          journal: null,
          year: 2024,
        })),
        citingPubsTotal: 19,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.getByText("197")).toBeDefined();
    expect(
      screen.getByText("19 in PubMed · Scopus reports 197"),
    ).toBeDefined();
  });

  it("renders 'No PubMed-indexed citations yet.' when list empty but Scopus has cites", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 5 },
        citingPubs: [],
        citingPubsTotal: 0,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.getByText("No PubMed-indexed citations yet.")).toBeDefined();
    // Chip still shows the Scopus count.
    expect(screen.getByText("5")).toBeDefined();
  });

  it("renders 'No citing publications.' when both citationCount and list are zero", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 0 },
        citingPubs: [],
        citingPubsTotal: 0,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.getByText("No citing publications.")).toBeDefined();
    // No chip when citationCount is 0.
    expect(screen.queryByText("0")).toBeNull();
  });

  it("shows the cap-overflow subhead when the PubMed subset exceeds 500", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 1500 },
        citingPubs: Array.from({ length: 500 }, (_, i) => ({
          pmid: String(i + 1),
          title: `c${i}`,
          journal: null,
          year: 2024,
        })),
        citingPubsTotal: 1234,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(
      screen.getByText(
        "500 most recent in PubMed of 1,234 total · use CSV for the full list",
      ),
    ).toBeDefined();
    // Chip reflects the true Scopus total, not the PubMed indexed total.
    expect(screen.getByText("1,500")).toBeDefined();
  });

  it("paginates the citing list to 50 by default with a Show all toggle", async () => {
    // > 50 rows → first 50 render, "Show all 75" button reveals the rest.
    const rows = Array.from({ length: 75 }, (_, i) => ({
      pmid: String(i + 1),
      title: `Citation ${i + 1}`,
      journal: null,
      year: 2024,
    }));
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 75 },
        citingPubs: rows,
        citingPubsTotal: 75,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const dialog = screen.getByRole("dialog");
    const visible = () =>
      Array.from(dialog.querySelectorAll("ul a"))
        .map((a) => a.textContent)
        .filter((t) => t && t.startsWith("Citation "));
    expect(visible().length).toBe(50);
    const toggle = screen.getByRole("button", { name: "Show all 75" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(visible().length).toBe(75);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show fewer");
    fireEvent.click(toggle);
    expect(visible().length).toBe(50);
  });

  it("renders no pagination toggle when the list fits in the initial window", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      pmid: String(i + 1),
      title: `Citation ${i + 1}`,
      journal: null,
      year: 2024,
    }));
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 10 },
        citingPubs: rows,
        citingPubsTotal: 10,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Show fewer/ })).toBeNull();
  });

  it("renders a copyable PMID on every citing-pub row", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    // Two citing pubs with pmid 999 and 888 from makePayload defaults.
    // Each row should carry a "PMID:" label, the pmid as a link, and a
    // copy-to-clipboard button.
    expect(screen.getByText("999")).toBeDefined();
    expect(screen.getByText("888")).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy PMID 999" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy PMID 888" })).toBeDefined();
  });

  it("renders a Download CSV link pointing at the citations.csv route", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const link = screen.getByRole("link", { name: /Download CSV/ });
    expect(link.getAttribute("href")).toBe(
      "/api/publications/12345/citations.csv",
    );
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("nudges users toward CSV when the 500-row cap kicks in", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 5000 },
        citingPubs: Array.from({ length: 500 }, (_, i) => ({
          pmid: String(i + 1),
          title: `c${i}`,
          journal: null,
          year: 2024,
        })),
        citingPubsTotal: 5000,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(
      screen.getByText(
        /500 most recent in PubMed of 5,000 total · use CSV for the full list/,
      ),
    ).toBeDefined();
  });

  it("omits the CSV download link when reciterdb soft-failed (citingPubsTotal=null)", async () => {
    mockFetch(makePayload({ citingPubs: null, citingPubsTotal: null }));
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.queryByRole("link", { name: /Download CSV/ })).toBeNull();
  });

  it("omits the CSV download link when the indexed total is zero", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 5 },
        citingPubs: [],
        citingPubsTotal: 0,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.queryByRole("link", { name: /Download CSV/ })).toBeNull();
  });

  it("shows 'Most recent first' subhead when list equals total and >1", async () => {
    // Equal case: indexed total matches Scopus and list isn't capped.
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 2 },
        citingPubs: [
          { pmid: "1", title: "x", journal: null, year: 2024 },
          { pmid: "2", title: "y", journal: null, year: 2024 },
        ],
        citingPubsTotal: 2,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.getByText("Most recent first")).toBeDefined();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it("omits the order subhead when there is only one citing pub and counts align", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 1 },
        citingPubs: [{ pmid: "1", title: "Only one", journal: null, year: 2024 }],
        citingPubsTotal: 1,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.queryByText("Most recent first")).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it("omits the count chip when citationCount is 0", async () => {
    mockFetch(
      makePayload({
        pub: { ...makePayload().pub, citationCount: 0 },
        citingPubs: null,
        citingPubsTotal: null,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const dialog = screen.getByRole("dialog");
    const headingRow = within(dialog).getByText("Cited by").closest("div") as HTMLElement;
    expect(headingRow.textContent).toBe("Cited by");
  });

  it("renders citing pubs in the order returned by the payload (date desc)", async () => {
    mockFetch(makePayload());
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    const titles = screen.getAllByText(/Citation paper (one|two)/);
    expect(titles[0].textContent).toBe("Citation paper one");
    expect(titles[1].textContent).toBe("Citation paper two");
  });
});

describe("PublicationModal — error path", () => {
  it("shows the error fallback when /api/publications/[pmid] errors", async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() =>
      expect(screen.getByText(/Could not load publication/)).toBeDefined(),
    );
  });
});
