/** The publication modal's "Trials and patents" section: trials only, patents
 *  only, both, and neither. Every title, sponsor, assignee and number is invented. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PublicationModalProvider, usePublicationModal } from "@/components/publication/publication-modal";
import type { PublicationDetailPayload } from "@/lib/api/publication-detail";
import type { CitingInvention, CitingTrial, TrialPatentCitations } from "@/lib/citations/trials-patents";

const SOURCES =
  "Sources: ClinicalTrials.gov; Reliance on Science (Marx and Fuegi), CC BY-NC 4.0, with patent details from USPTO PatentsView. US patents only. Patents usually cite a paper years after it is published, so recent papers show few or none.";
const TRIALS_BLURB = "Trials that list this paper as background in their ClinicalTrials.gov record.";
const PATENTS_BLURB =
  "US patents whose text or references cite this paper. Citing a paper does not mean its authors hold the patent. Related patents for one invention are grouped.";

const trial = (n: number, over: Partial<CitingTrial> = {}): CitingTrial => ({
  id: n,
  title: `Widget trial ${n}`,
  url: `https://clinicaltrials.gov/study/NCT9000000${n}`,
  sponsor: "Example University",
  phase: "Phase 2/3",
  status: "Recruiting",
  startYear: 2031,
  nctId: `NCT9000000${n}`,
  ownTrial: false,
  ...over,
});

const invention = (n: number, over: Partial<CitingInvention> = {}): CitingInvention => ({
  id: 100 + n,
  title: `Widget assay ${n}`,
  url: `https://patents.google.com/patent/US9000000${n}B2/en`,
  holder: "Example Therapeutics, Inc.",
  year: 2030,
  granted: true,
  number: `US 9000000${n} B2`,
  related: 0,
  ...over,
});

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

async function openModal(p: PublicationDetailPayload) {
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => p })) as unknown as typeof fetch;
  render(
    <PublicationModalProvider>
      <Trigger />
    </PublicationModalProvider>,
  );
  fireEvent.click(screen.getByTestId("trigger"));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
  await waitFor(() => expect(screen.getByText("Widgets are interesting.")).toBeDefined());
  return within(screen.getByRole("dialog"));
}

afterEach(cleanup);

describe("PublicationModal — Trials and patents section", { retry: 2 }, () => {
  it("neither: no tab, no section, and the same markup as a payload that never had the field", async () => {
    const dialog = await openModal(payload());
    expect(dialog.queryByText("Trials and patents")).toBeNull();
    expect(dialog.queryByText("Registered clinical trials")).toBeNull();
    expect(dialog.queryByText("Patents that cite this paper")).toBeNull();
    expect(dialog.queryByText(/Reliance on Science/)).toBeNull();
    expect(document.querySelector('[data-sec="trials"]')).toBeNull();
  });

  it("trials only: the trials card, no patents card", async () => {
    const dialog = await openModal(
      payload({
        trials: {
          items: [
            trial(1),
            trial(2, { phase: null, startYear: null }),
            trial(3, { ownTrial: true, sponsor: "Sample Medical College" }),
            trial(4, { url: null }),
          ],
          count: 3,
          total: 4,
        },
      }),
    );
    // The tab counts the trials counted: the authors' own is not one of them.
    expect(dialog.getByRole("button", { name: "Trials and patents 3" })).toBeDefined();
    const section = within(document.querySelector<HTMLElement>('[data-sec="trials"]')!);
    expect(section.getByRole("heading", { name: "Trials and patents" })).toBeDefined();
    expect(section.getByText("Registered clinical trials").textContent).toBe("Registered clinical trials· 3");
    expect(section.getByText(TRIALS_BLURB)).toBeDefined();
    expect(section.queryByText("Patents that cite this paper")).toBeNull();
    expect(section.queryByText(PATENTS_BLURB)).toBeNull();
    expect(section.getByText("Sources: ClinicalTrials.gov.")).toBeDefined();

    const link = section.getByRole("link", { name: "Widget trial 1" });
    expect(link.getAttribute("href")).toBe("https://clinicaltrials.gov/study/NCT90000001");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(section.getByText("Example University · Phase 2/3 · Recruiting · started 2031 · NCT90000001")).toBeDefined();
    // No phase and no start year: both are left out, not printed empty.
    expect(section.getByText("Example University · Recruiting · NCT90000002")).toBeDefined();
    // The authors' own trial is listed and marked.
    expect(section.getByText("Authors’ own trial")).toBeDefined();
    expect(
      section.getByText(
        "Sample Medical College · Phase 2/3 · Recruiting · started 2031 · NCT90000003 · not included in the count",
      ),
    ).toBeDefined();
    // A URL the server did not allow renders as text.
    expect(section.queryByRole("link", { name: "Widget trial 4" })).toBeNull();
    expect(section.getByText("Widget trial 4")).toBeDefined();
    // Four rows: nothing to expand.
    expect(section.queryByRole("button")).toBeNull();
  });

  it("patents only: the patents card, no trials card", async () => {
    const dialog = await openModal(
      payload({
        inventions: {
          items: [
            invention(1),
            invention(2, { related: 3 }),
            invention(3, { related: 1, holder: "Ada Example et al.", granted: false, year: 2029, number: "US 20290000003 A1" }),
            invention(4, { holder: null, year: null }),
          ],
          total: 4,
        },
      }),
    );
    expect(dialog.getByRole("button", { name: "Trials and patents 4" })).toBeDefined();
    const section = within(document.querySelector<HTMLElement>('[data-sec="trials"]')!);
    expect(section.getByText("Patents that cite this paper").textContent).toBe("Patents that cite this paper· 4 inventions");
    expect(section.getByText(PATENTS_BLURB)).toBeDefined();
    expect(section.queryByText("Registered clinical trials")).toBeNull();
    expect(section.getByText(SOURCES.replace("ClinicalTrials.gov; ", ""))).toBeDefined();

    expect(section.getByRole("link", { name: "Widget assay 1" }).getAttribute("href")).toBe(
      "https://patents.google.com/patent/US90000001B2/en",
    );
    expect(section.getByText("Example Therapeutics, Inc. · granted 2030 · US 90000001 B2")).toBeDefined();
    expect(
      section.getByText("Example Therapeutics, Inc. · granted 2030 · US 90000002 B2 · and 3 related patents"),
    ).toBeDefined();
    expect(
      section.getByText("Ada Example et al. · application published 2029 · US 20290000003 A1 · and 1 related patent"),
    ).toBeDefined();
    expect(section.getByText("US 90000004 B2")).toBeDefined();
  });

  it("both: tab count is trials counted plus inventions; five shown, the rest behind Show all", async () => {
    const dialog = await openModal(
      payload({
        trials: { items: Array.from({ length: 7 }, (_, i) => trial(i + 1)), count: 7, total: 7 },
        // 50 sent of 1,622: the list says so once it is open.
        inventions: {
          items: Array.from({ length: 50 }, (_, i) => invention(i + 1, { number: `US 91000${String(i).padStart(3, "0")} B2` })),
          total: 1622,
        },
      }),
    );
    expect(dialog.getByRole("button", { name: "Trials and patents 1,629" })).toBeDefined();
    const section = within(document.querySelector<HTMLElement>('[data-sec="trials"]')!);
    expect(section.getByText("Patents that cite this paper").textContent).toContain("· 1,622 inventions");
    expect(section.getByText(SOURCES)).toBeDefined();
    expect(section.getAllByRole("link", { name: /^Widget trial/ })).toHaveLength(5);
    expect(section.getAllByRole("link", { name: /^Widget assay/ })).toHaveLength(5);

    const showTrials = section.getByRole("button", { name: "Show all 7 trials" });
    expect(showTrials.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(showTrials);
    expect(section.getAllByRole("link", { name: /^Widget trial/ })).toHaveLength(7);
    expect(section.getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
    // Every trial was sent, so there is no closing line.
    expect(section.queryByText(/most recent of/)).toBeNull();

    fireEvent.click(section.getByRole("button", { name: "Show all 1,622 inventions" }));
    expect(section.getAllByRole("link", { name: /^Widget assay/ })).toHaveLength(50);
    expect(section.getByText("The 50 most recent of 1,622 are listed.")).toBeDefined();
  });

  it("sits between Guidelines and policy and Cited by, and leaves that section alone", async () => {
    await openModal({
      ...payload({ trials: { items: [trial(1)], count: 1, total: 1 } }),
      policyCitations: {
        reviewTotal: 0,
        docs: [
          {
            id: 9,
            level: "guideline",
            title: "Example guideline on widgets",
            year: 2030,
            url: "https://pubmed.ncbi.nlm.nih.gov/222/",
            issuingBody: null,
            authors: "Example A",
            journal: "J Widgets",
            volume: null,
            issue: null,
            pages: null,
            doi: null,
            publisher: null,
            pmid: "222",
            bookshelfId: null,
            locations: [],
          },
        ],
      },
    });
    const nav = within(screen.getByRole("navigation", { name: "Publication sections" }));
    expect(nav.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Summary",
      "Guidelines and policy 1",
      "Trials and patents 1",
      "Cited by 2",
    ]);
    expect([...document.querySelectorAll("[data-sec]")].map((s) => s.getAttribute("data-sec"))).toEqual([
      "summary",
      "policy",
      "trials",
      "cited",
    ]);
    const policy = within(document.querySelector<HTMLElement>('[data-sec="policy"]')!);
    expect(policy.getByText("Clinical practice guidelines").textContent).toBe("Clinical practice guidelines · 1");
    expect(policy.queryByText(/Widget trial/)).toBeNull();
  });
});
