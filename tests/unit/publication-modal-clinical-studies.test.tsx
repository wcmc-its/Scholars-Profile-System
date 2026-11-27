/** The publication modal's "Clinical studies" group, in the "Trials and
 *  patents" section: rows, the "By the authors" label, and "Show more" paging
 *  to the end of the list. Every title and journal is invented. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PublicationModalProvider, usePublicationModal } from "@/components/publication/publication-modal";
import type { PublicationDetailPayload } from "@/lib/api/publication-detail";
import type { CitingClinicalStudy, ClinicalCitations, TrialPatentCitations } from "@/lib/citations/trials-patents";

const BLURB =
  "Clinical articles in PubMed that cite this paper, such as reports of clinical trials and clinical studies.";

const study = (n: number, over: Partial<CitingClinicalStudy> = {}): CitingClinicalStudy => ({
  id: n,
  title: `Widget study ${n}`,
  url: `https://pubmed.ncbi.nlm.nih.gov/9${String(n).padStart(7, "0")}/`,
  journal: "J Widget Med",
  year: 2031,
  ownWork: false,
  ...over,
});
const studies = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => study(from + i));

function payload(trialPatentCitations?: TrialPatentCitations): PublicationDetailPayload {
  return {
    pub: {
      pmid: "111",
      title: "A study of widgets",
      journal: "Journal of Widgets",
      year: 2024,
      volume: "10",
      issue: "2",
      pages: "100-110",
      fullAuthorsString: "Example A, Sample B",
      abstract: "Widgets are interesting.",
      impactScore: null,
      impactJustification: null,
      citationCount: 2,
      pmcid: null,
      doi: null,
      ecommonsLink: null,
      pubmedUrl: null,
      meshTerms: [],
      synopsis: null,
    },
    wcmAuthors: [],
    topics: [],
    methodFamilies: [],
    cores: [],
    citingPubs: [],
    citingPubsTotal: 0,
    ...(trialPatentCitations ? { trialPatentCitations } : {}),
  };
}

function Trigger() {
  const { open } = usePublicationModal();
  return (
    <button type="button" onClick={() => open("111")} data-testid="trigger">
      Open
    </button>
  );
}

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Reply => ({ ok: true, status: 200, json: async () => body });

/** Opens the modal on `p`; `pages` answers the paged route by URL. */
async function openModal(p: PublicationDetailPayload, pages: Record<string, () => Promise<Reply> | Reply> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/publications/111") return ok(p);
    const page = pages[url];
    if (!page) throw new Error(`unexpected fetch ${url}`);
    return page();
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  render(
    <PublicationModalProvider>
      <Trigger />
    </PublicationModalProvider>,
  );
  fireEvent.click(screen.getByTestId("trigger"));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
  await waitFor(() => expect(screen.getByText("Widgets are interesting.")).toBeDefined());
  return { dialog: within(screen.getByRole("dialog")), fetchMock };
}

const section = () => within(document.querySelector<HTMLElement>('[data-sec="trials"]')!);
const rows = () => section().queryAllByRole("link", { name: /^Widget study/ });

afterEach(cleanup);

describe("PublicationModal — Clinical studies group", { retry: 2 }, () => {
  it("a payload without the group renders no clinical card and no clinical source", async () => {
    await openModal(
      payload({
        trials: {
          items: [
            {
              id: 1,
              title: "Widget trial 1",
              url: "https://clinicaltrials.gov/study/NCT90000001",
              sponsor: "Example University",
              phase: null,
              status: "Recruiting",
              startYear: 2031,
              nctId: "NCT90000001",
              ownTrial: false,
            },
          ],
          count: 1,
          total: 1,
        },
      }),
    );
    expect(section().queryByText("Clinical studies")).toBeNull();
    expect(section().queryByRole("button", { name: "Show more" })).toBeNull();
    expect(section().queryByRole("status")).toBeNull();
    expect(section().getByText("Sources: ClinicalTrials.gov.")).toBeDefined();
  });

  it("clinical studies only: the section renders, with rows, links, journal, year and the own-work label", async () => {
    const clinical: ClinicalCitations = {
      items: [
        study(1),
        study(2, { ownWork: true }),
        study(3, { url: null, journal: null }),
        study(4, { year: null }),
      ],
      count: 3,
      total: 4,
    };
    const { dialog } = await openModal(payload({ clinical }));
    // The tab counts the studies counted: the authors' own is not one of them.
    expect(dialog.getByRole("button", { name: "Trials and patents 3" })).toBeDefined();
    expect(section().getByRole("heading", { name: "Trials and patents" })).toBeDefined();
    expect(section().getByText("Clinical studies").textContent).toBe("Clinical studies· 3");
    expect(section().getByText(BLURB)).toBeDefined();
    expect(section().queryByText("Registered clinical trials")).toBeNull();
    expect(section().queryByText("Patents that cite this paper")).toBeNull();
    expect(section().getByText("Sources: PubMed and NIH iCite.")).toBeDefined();

    const link = section().getByRole("link", { name: "Widget study 1" });
    expect(link.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/90000001/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(section().getAllByText("J Widget Med · 2031")).toHaveLength(1);

    // The authors' own study is listed, labelled, and said not to be counted.
    expect(section().getAllByText("By the authors")).toHaveLength(1);
    expect(section().getByText("J Widget Med · 2031 · not included in the count")).toBeDefined();
    // A URL the server dropped is plain text; a missing journal or year is left out.
    expect(section().queryByRole("link", { name: "Widget study 3" })).toBeNull();
    expect(section().getByText("Widget study 3")).toBeDefined();
    expect(section().getByText("2031")).toBeDefined();
    expect(section().getByText("J Widget Med")).toBeDefined();
    // Four rows fit: nothing to show more of.
    expect(section().queryByRole("button", { name: "Show more" })).toBeNull();
    expect(section().queryByRole("button", { name: "Show fewer" })).toBeNull();
  });

  it("the tab count is trials counted plus inventions plus clinical studies counted", async () => {
    const { dialog } = await openModal(
      payload({
        trials: { items: [], count: 2, total: 3 },
        inventions: { items: [], total: 10 },
        clinical: { items: studies(1, 50), count: 5170, total: 5180 },
      }),
    );
    expect(dialog.getByRole("button", { name: "Trials and patents 5,182" })).toBeDefined();
    expect(section().getByText("Clinical studies").textContent).toBe("Clinical studies· 5,170");
  });

  it("Show more reveals the first page, then loads each next page until the list ends", async () => {
    let release: (r: Reply) => void = () => {};
    const { fetchMock } = await openModal(payload({ clinical: { items: studies(1, 50), count: 120, total: 120 } }), {
      "/api/publications/111/clinical-citations/50": () =>
        new Promise<Reply>((resolve) => {
          release = resolve;
        }),
      "/api/publications/111/clinical-citations/100": () => ok({ items: studies(101, 120), count: 120, total: 120 }),
    });
    expect(rows()).toHaveLength(5);
    const status = section().getByRole("status");
    expect(status.textContent).toBe("");

    // First click: the rows the payload carried, no request.
    const more = section().getByRole("button", { name: "Show more" });
    more.focus();
    fireEvent.click(more);
    expect(rows()).toHaveLength(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status.textContent).toBe("Showing 50 of 120 clinical studies.");
    expect(section().getByText("The 50 most recent of 120 are listed.")).toBeDefined();
    expect(document.activeElement).toBe(more);

    // Second click: the next page is fetched; loading is announced and a repeat click is ignored.
    fireEvent.click(more);
    expect(status.textContent).toBe("Loading more clinical studies.");
    expect(more.textContent).toBe("Loading…");
    expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(more.hasAttribute("disabled")).toBe(false);
    fireEvent.click(more);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    release(ok({ items: studies(51, 100), count: 120, total: 120 }));
    await waitFor(() => expect(rows()).toHaveLength(100));
    expect(status.textContent).toBe("Showing 100 of 120 clinical studies.");
    expect(section().getByText("The 100 most recent of 120 are listed.")).toBeDefined();
    // Same button, still focused, rows appended above it.
    expect(document.activeElement).toBe(more);
    expect(more.textContent).toBe("Show more");
    expect(rows()[0].textContent).toBe("Widget study 1");

    // Last page: every study is listed, the button and the closing line go, focus moves to Show fewer.
    fireEvent.click(more);
    await waitFor(() => expect(rows()).toHaveLength(120));
    expect(rows()[119].textContent).toBe("Widget study 120");
    expect(section().queryByRole("button", { name: "Show more" })).toBeNull();
    expect(section().queryByText(/most recent of/)).toBeNull();
    expect(status.textContent).toBe("Showing 120 of 120 clinical studies.");
    const fewer = section().getByRole("button", { name: "Show fewer" });
    expect(document.activeElement).toBe(fewer);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Show fewer folds back to five; Show more opens what is already loaded without a request.
    // Focus was on Show fewer, which is gone: it moves to Show more, not to the page.
    fireEvent.click(fewer);
    expect(rows()).toHaveLength(5);
    const again = section().getByRole("button", { name: "Show more" });
    expect(document.activeElement).toBe(again);
    fireEvent.click(again);
    expect(rows()).toHaveLength(120);
    expect(section().queryByRole("button", { name: "Show more" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a list of 6 to 50 needs no request: Show more shows them all and goes", async () => {
    const { fetchMock } = await openModal(payload({ clinical: { items: studies(1, 12), count: 12, total: 12 } }));
    expect(rows()).toHaveLength(5);
    fireEvent.click(section().getByRole("button", { name: "Show more" }));
    expect(rows()).toHaveLength(12);
    expect(section().queryByRole("button", { name: "Show more" })).toBeNull();
    expect(section().queryByText(/most recent of/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A pointer click that left focus elsewhere does not pull it to Show more.
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    fireEvent.click(section().getByRole("button", { name: "Show fewer" }));
    expect(rows()).toHaveLength(5);
    expect(document.activeElement).toBe(trigger);
  });

  it("a failed load says so, keeps the rows and the button, and a retry works", async () => {
    let calls = 0;
    await openModal(payload({ clinical: { items: studies(1, 50), count: 60, total: 60 } }), {
      "/api/publications/111/clinical-citations/50": () =>
        ++calls === 1
          ? { ok: false, status: 500, json: async () => ({ error: "Clinical studies unavailable" }) }
          : ok({ items: studies(51, 60), count: 60, total: 60 }),
    });
    const more = section().getByRole("button", { name: "Show more" });
    fireEvent.click(more);
    fireEvent.click(more);
    await waitFor(() =>
      expect(section().getByRole("status").textContent).toBe("More clinical studies could not be loaded. Try again."),
    );
    expect(section().getByRole("status").className).not.toContain("sr-only");
    expect(rows()).toHaveLength(50);
    expect(more.textContent).toBe("Show more");

    fireEvent.click(more);
    await waitFor(() => expect(rows()).toHaveLength(60));
    expect(section().getByRole("status").className).toContain("sr-only");
    expect(section().queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("a list that changed since the modal opened never repeats a study, and an empty page ends it", async () => {
    await openModal(payload({ clinical: { items: studies(1, 50), count: 150, total: 150 } }), {
      // One new study arrived at the top, so page two starts with one already listed.
      "/api/publications/111/clinical-citations/50": () => ok({ items: studies(50, 99), count: 150, total: 150 }),
      "/api/publications/111/clinical-citations/100": () => ok({ items: [], count: 150, total: 150 }),
    });
    const more = section().getByRole("button", { name: "Show more" });
    fireEvent.click(more);
    fireEvent.click(more);
    await waitFor(() => expect(rows()).toHaveLength(99));
    expect(new Set(rows().map((r) => r.textContent)).size).toBe(99);
    fireEvent.click(more);
    await waitFor(() => expect(section().queryByRole("button", { name: "Show more" })).toBeNull());
    expect(rows()).toHaveLength(99);
  });
});
