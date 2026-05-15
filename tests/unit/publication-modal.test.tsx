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
});

describe("PublicationModal — citing publications", () => {
  it("renders the fallback message when reciterdb returned null", async () => {
    mockFetch(
      makePayload({ citingPubs: null, citingPubsTotal: null }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(
      screen.getByText(/Citation list temporarily unavailable/),
    ).toBeDefined();
  });

  it("renders 'No citing publications' when the list is empty", async () => {
    mockFetch(
      makePayload({ citingPubs: [], citingPubsTotal: 0 }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.getByText("No citing publications.")).toBeDefined();
  });

  it("shows the truncation footer when total exceeds rows returned", async () => {
    mockFetch(
      makePayload({
        citingPubs: [
          { pmid: "1", title: "x", journal: null, year: 2024 },
          { pmid: "2", title: "y", journal: null, year: 2024 },
        ],
        citingPubsTotal: 1234,
      }),
    );
    renderModalHarness();
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(
      screen.getByText(/Showing 2 most recent of 1,234 total/),
    ).toBeDefined();
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
