/**
 * The per-core review queue client component (components/edit/core-claim-queue).
 * Renders candidate evidence and posts confirm/reject to /api/edit/core-claim with
 * optimistic local state. fetch is mocked — no DB/network.
 *
 * Every fixture value here is synthetic: made-up names, made-up CWIDs, made-up
 * PMIDs. Nothing in this file is a real person or a real record.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

import {
  bandRange,
  buildSignals,
  compareBySort,
  CoreClaimQueue,
  decodeTopicalPrior,
  displayTitle,
  evidenceGroupKey,
  evidenceGroupLabel,
  evidenceTokens,
  formatAddedToPubMed,
  initialsOf,
  likelihoodBand,
  llmVerdict,
  matchesFilters,
  matchesQuery,
  parsePmidBlock,
  priorFootnote,
  repeatUser,
  searchBlob,
  CSV_HEADERS,
  csvRow,
} from "@/components/edit/core-claim-queue";
import type { FilterKey } from "@/components/edit/core-claim-queue";
import type { CoreQueueRow } from "@/lib/api/core-queue";
import type { CoreClientRow } from "@/lib/api/core-clients";

function row(over: Partial<CoreQueueRow> = {}): CoreQueueRow {
  return {
    pmid: "30418319",
    title: "Advanced MRI of the brain",
    journal: "Synthetic Journal of Core Imaging Science",
    journalAbbrev: "Synth J Core Imaging Sci",
    year: 2021,
    dateAddedToEntrez: "2026-02-18",
    authorsString: "Testerson A, Fixture B",
    fullAuthorsString: "Testerson A, Fixture B, Sample C",
    abstract: "We imaged the brain in detail.",
    synopsis: "A faster MRI sequence.",
    likelihood: 0.82,
    status: "candidate",
    coauthors: ["aaa1001"],
    coauthorScholars: [
      { cwid: "aaa1001", name: "Alex Testerson", slug: "alex-testerson", dept: "Radiology" },
    ],
    wcmAuthors: [{ cwid: "ccc1003", name: "Casey Sample", slug: "casey-sample", dept: "Genomics" }],
    signalAck: true,
    ackAlias: "CBIC",
    ackSnippet: "processed at the CBIC imaging facility",
    llmScore: 7,
    llmRationale: "Acknowledges the imaging core for confocal microscopy.",
    authorAffinity: 0.42,
    topicalPrior: null,
    methodTier: null,
    methodEvidence: [],
    citationCount: 12,
    pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/30418319/",
    doi: "10.1000/synthetic.2021.001",
    claimed: false,
    isManual: false,
    relativeCitationRatio: null,
    nihPercentile: null,
    meshTerms: [],
    ...over,
  };
}

/** Both staff counts null is the DEFAULT fixture state on purpose — the engine
 *  has published none for most cores, and every test that is not about the chip
 *  should be rendering the queue exactly as it looked before the chip existed.
 *  The chip tests override them. */
const CORE = {
  id: "2",
  name: "Biomedical Imaging",
  staffCount: null as number | null,
  staffTrackedCount: null as number | null,
};

/** Expand the only open card's evidence strip — signal rows start collapsed. */
function showEvidence() {
  fireEvent.click(screen.getByRole("button", { name: /Show evidence/ }));
}

/** The expanded per-signal list of the only open card. */
function evidence() {
  return screen.getByLabelText("evidence");
}

/**
 * The card header's meta line (the sibling right under the title), whitespace-
 * collapsed. The middot separators carry no spaces of their own, so this reads
 * as "<journal>·<vintage>·PMID <n>" — the copy button contributes no text.
 */
function metaLine(container: HTMLElement): string {
  const el = container.querySelector("h3")?.nextElementSibling;
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoreClaimQueue", () => {
  it("reads the score as a band word plus a percent, with no 'likelihood' caption", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.getByText("Advanced MRI of the brain")).toBeTruthy();
    // the whole score vocabulary is the band word + the percent
    expect(screen.getByText("Moderate 82%")).toBeTruthy();
    expect(screen.queryByText("Combined likelihood")).toBeNull();
    expect(screen.queryByText(/Evidence score/)).toBeNull();
    expect(screen.getByText(/4 of 4 signals/)).toBeTruthy();
  });

  it("names each band at its exact threshold, and just below it", () => {
    const at = (likelihood: number) => {
      const view = render(
        <CoreClaimQueue core={CORE} candidates={[row({ likelihood })]} confirmed={[]} />,
      );
      const text = view.container.querySelector('[data-slot="core-queue-score"]')?.textContent;
      view.unmount();
      return text;
    };
    // inclusive lower bounds: 0.85 / 0.65 / 0.40 are IN the higher band
    expect(at(0.85)).toBe("Strong 85%");
    expect(at(0.94)).toBe("Strong 94%");
    expect(at(0.84)).toBe("Moderate 84%");
    expect(at(0.65)).toBe("Moderate 65%");
    expect(at(0.71)).toBe("Moderate 71%");
    expect(at(0.64)).toBe("Slight 64%");
    expect(at(0.4)).toBe("Slight 40%");
    expect(at(0.52)).toBe("Slight 52%");
    expect(at(0.39)).toBe("Weak 39%");
    expect(at(0.34)).toBe("Weak 34%");
    expect(at(0)).toBe("Weak 0%");
  });

  it("summarises the evidence as label/value tokens before anything is expanded", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const strip = screen.getByRole("button", { name: /Show evidence/ });
    expect(strip.textContent).toContain("Acknowledged as");
    expect(strip.textContent).toContain("“CBIC”");
    expect(strip.textContent).toContain("Alex Testerson");
    // No paperCounts passed, so nobody is nameable and the strip falls back to
    // the engine's own unnamed rate rather than inventing a person.
    expect(strip.textContent).toContain("42% of an author's own work");
    expect(strip.textContent).toContain("possibly core work"); // llmScore 7
    // the signal rows themselves stay closed until asked for
    expect(screen.queryByLabelText("evidence")).toBeNull();
  });

  it("renders the per-signal rows, their strength words and their raw readouts once expanded", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    showEvidence();
    const list = within(evidence());
    expect(list.getByText("Named in the acknowledgments")).toBeTruthy();
    expect(list.getByText("Direct")).toBeTruthy(); // ack tier
    expect(list.getByRole("link", { name: "Alex Testerson" })).toBeTruthy(); // co-author row
    expect(list.getByText("LLM read of title and abstract")).toBeTruthy();
    expect(list.getByText("Moderate")).toBeTruthy(); // LLM is Moderate regardless of 7/10
    expect(list.getByText("7/10")).toBeTruthy(); // raw score still shown
    expect(list.getByText("Repeat user")).toBeTruthy();
    // No counts passed, so nobody is nameable and the row falls back to the
    // engine's own scalar — a RATE post-ReciterAI #382, so the copy says so.
    expect(list.getByText("42%")).toBeTruthy();
    expect(
      list.getByText(
        "The largest share of any byline author's own publications that are work with this core",
      ),
    ).toBeTruthy();
  });

  it("names the repeat user and prints THAT person's numbers once counts are on hand", () => {
    // The mockup's row, verbatim: "Repeat user / 18 confirmed papers / Samprit
    // Banerjee, Population Health Sciences. 18 of their 29 publications are
    // confirmed work with this core, 11 in the last three years."
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row()]}
        confirmed={[]}
        paperCounts={{ ccc1003: { papers: 18, recent: 11, total: 29 } }}
      />,
    );
    showEvidence();
    const list = within(evidence());
    expect(list.getByText("18 confirmed papers")).toBeTruthy();
    expect(
      list.getByText(
        "Casey Sample, Genomics. 18 of their 29 publications are confirmed work with this core, 11 in the last three years.",
      ),
    ).toBeTruthy();
    // the engine's own scalar is NOT printed beside a derived name — affinity is
    // the largest SHARE, which need not belong to the largest COUNT
    expect(list.queryByText("42%")).toBeNull();
  });

  it("drops the recent clause and reads singular at one paper", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row()]}
        confirmed={[]}
        paperCounts={{ ccc1003: { papers: 1, recent: 0, total: 1 } }}
      />,
    );
    showEvidence();
    const list = within(evidence());
    expect(list.getByText("1 confirmed paper")).toBeTruthy();
    expect(
      list.getByText(
        "Casey Sample, Genomics. 1 of their 1 publication is confirmed work with this core.",
      ),
    ).toBeTruthy();
  });

  it("highlights the matched alias inside the acknowledgment quote", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />,
    );
    showEvidence();
    expect(container.querySelector("mark")?.textContent).toBe("CBIC");
  });

  it("shows the PMID verbatim (linked to PubMed) and the rationale", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    showEvidence();
    expect(screen.getByText("Acknowledges the imaging core for confocal microscopy.")).toBeTruthy();
    // the PMID is shown verbatim and is the PubMed link
    const pubmed = screen.getByRole("link", { name: /PMID 30418319/ });
    expect(pubmed.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/30418319/");
  });

  it("reads the header meta as one middot line: FULL journal title, PubMed date, PMID", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />,
    );
    // Round 2 reversed #2620: the abbreviation is not a venue a reviewer can
    // identify at a glance, so it is now only the fallback.
    expect(metaLine(container)).toBe(
      "Synthetic Journal of Core Imaging Science·Added to PubMed Feb 18, 2026·PMID 30418319",
    );
    expect(screen.queryByText("Synth J Core Imaging Sci")).toBeNull();
  });

  it("falls back to the abbreviation when no full title is on file", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[row({ journal: null })]} confirmed={[]} />,
    );
    expect(metaLine(container)).toBe(
      "Synth J Core Imaging Sci·Added to PubMed Feb 18, 2026·PMID 30418319",
    );
  });

  it("falls back to the publication year when PubMed never indexed a date", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[row({ dateAddedToEntrez: null })]} confirmed={[]} />,
    );
    expect(metaLine(container)).toBe(
      "Synthetic Journal of Core Imaging Science·2021·PMID 30418319",
    );
    expect(metaLine(container)).not.toContain("Added to PubMed");
  });

  it("renders no vintage and no dangling separator when the row has neither date nor year", () => {
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ dateAddedToEntrez: null, year: null, journal: null, journalAbbrev: null }),
        ]}
        confirmed={[]}
      />,
    );
    // one surviving part → no separator at all, and no "Added to PubMed —"
    expect(metaLine(container)).toBe("PMID 30418319");
  });

  it("keeps the DOI, the citation count and the RCR readout off the card header", () => {
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ relativeCitationRatio: 2.1, nihPercentile: 0 })]}
        confirmed={[]}
      />,
    );
    const meta = metaLine(container);
    expect(meta).not.toContain("RCR");
    expect(meta).not.toContain("pct");
    expect(meta).not.toContain("DOI");
    expect(screen.queryByRole("link", { name: /doi/i })).toBeNull();
    // the pre-existing "RCR 0 (0th pct)" case: nihPercentile is literally 0, not
    // null, so the old header rendered it. It goes with the readout.
    expect(screen.queryByText(/RCR/)).toBeNull();
    expect(screen.queryByText(/citations?/i)).toBeNull();
  });

  it("copies the PMID and flips the button label", () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy PMID" }));
    expect(writeText).toHaveBeenCalledWith("30418319");
    expect(screen.getByRole("button", { name: "PMID copied" })).toBeTruthy();
  });

  it("falls back to a generic ack chip when signalAck is set without an alias", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ ackAlias: null, signalAck: true })]}
        confirmed={[]}
      />,
    );
    showEvidence();
    expect(within(evidence()).getByText("Acknowledged in text")).toBeTruthy();
  });

  it("omits a signal row when its signal did not fire", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ authorAffinity: null, coauthors: [], signalAck: false, ackAlias: null })]}
        confirmed={[]}
      />,
    );
    showEvidence();
    const list = within(evidence());
    expect(list.queryByText("Repeat user")).toBeNull();
    expect(list.queryByText("Staff co-author")).toBeNull();
    expect(list.queryByText(/Named in the acknowledgments|Acknowledged in text/)).toBeNull();
  });

  it("chips the method families at the card top and quotes the extractor, UNCOUNTED", () => {
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            methodTier: "weak",
            methodEvidence: [
              // Two tools, ONE family — one chip, not two.
              { family: "Flow cytometry", tool: "FACSAria", sentence: "Cells were sorted on a." },
              { family: "Flow cytometry", tool: "CytoFLEX", sentence: null },
              { family: "Mass spectrometry", tool: "Orbitrap", sentence: null },
            ],
          }),
        ]}
        confirmed={[]}
      />,
    );
    const card = container.querySelector("[data-card]") as HTMLElement;
    expect(within(card).getAllByText("Flow cytometry")).toHaveLength(1);
    expect(within(card).getByText("Mass spectrometry")).toBeTruthy();
    // The tier always rides along, and the caveat is on screen, not in a title.
    expect(card.textContent).toContain(
      "weak method match — what the paper did, not whether this core did it",
    );
    showEvidence();
    expect(within(card).getByText("Methods used")).toBeTruthy();
    expect(card.textContent).toContain("“Cells were sorted on a.”");
    // Weighted 0.00 in the engine, and the lift inverts on weak rows — so it is
    // shown but never counted: four signals fire here, and the denominator is 4.
    expect(within(card).queryByLabelText("evidence")?.textContent).not.toContain("Methods used");
    expect(card.textContent).toContain("4 of 4 signals");
  });

  it("renders the prefilter prior as a footnote, NOT as a counted signal row", () => {
    // Owner decision, round 2: the prior is not evidence about the paper, so it
    // comes out of the denominator and off the signal list — but stays on screen,
    // because a reviewer who can see the score has to be able to see what moved it.
    render(<CoreClaimQueue core={CORE} candidates={[row({ topicalPrior: 0.6 })]} confirmed={[]} />);
    showEvidence();
    expect(within(evidence()).queryByText(/prior/i)).toBeNull();
    expect(
      screen.getByText(
        "No evidence found: the topical prior (60%) has no mapped MeSH branch for this core, so it only restates the repeat-user number.",
      ),
    ).toBeTruthy();
    // and the prior no longer inflates the count: four signals, four fired
    expect(screen.getByText("4 of 4 signals")).toBeTruthy();
  });

  it("does not claim a MeSH descriptor on an author-only prefilter prior", () => {
    // The bug this pins: every prefilter_prior rendered "The paper carries a MeSH
    // descriptor under this core's technique branch". On prod 2026-09-04 that was
    // false on 7,332 of 9,352 live chips, and core 14's entire backfill is 0.60
    // (author-only, MeSH membership zero) — so it would have been false on every
    // row of the queue that actually gets reviewed. Demoting the row to a footnote
    // does not retire the trap: the footnote asserts a MeSH branch too.
    render(<CoreClaimQueue core={CORE} candidates={[row({ topicalPrior: 0.6 })]} confirmed={[]} />);
    showEvidence();
    expect(screen.queryByText(/is a MeSH-branch match/)).toBeNull();
    expect(screen.getByText(/has no mapped MeSH branch for this core/)).toBeTruthy();
  });

  it("does not say 'no mapped MeSH branch' on the rows where MeSH DID fire", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row({ topicalPrior: 0.4 })]} confirmed={[]} />);
    showEvidence();
    expect(screen.queryByText(/no mapped MeSH branch/)).toBeNull();
    expect(screen.getByText(/is a MeSH-branch match on the paper's own descriptors/)).toBeTruthy();
  });

  it("names both halves when the prior is the noisy-OR of the two", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row({ topicalPrior: 0.76 })]} confirmed={[]} />);
    showEvidence();
    expect(screen.getByText(/blends a MeSH-branch match with the repeat-user number/)).toBeTruthy();
  });

  it("counts all four signals, so the numerator can reach its own denominator", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.getByText("4 of 4 signals")).toBeTruthy();
  });

  it("renders the synopsis and links resolved core-staff co-authors to their profile", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.getByText("A faster MRI sequence.")).toBeTruthy();
    showEvidence();
    const staff = within(evidence()).getByRole("link", { name: "Alex Testerson" });
    expect(staff.getAttribute("href")).toBe("/alex-testerson");
    // "1 person" over "Alex Testerson, Radiology" — the mockup's two-line form.
    // The department follows a COMMA, not parentheses: it identifies the person
    // rather than annotating them.
    expect(within(evidence()).getByText("1 person")).toBeTruthy();
    expect(screen.getByText(", Radiology")).toBeTruthy();
    expect(screen.queryByText(/\(Radiology\)/)).toBeNull();
  });

  it("shows an unresolved core-staff CWID as bare text", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ coauthors: ["aaa1001", "zzz9999"], coauthorScholars: row().coauthorScholars }),
        ]}
        confirmed={[]}
      />,
    );
    showEvidence();
    expect(screen.getByText(/zzz9999/)).toBeTruthy();
  });

  it("names an ED-only core-staff co-author without linking a profile (#1239)", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            coauthors: ["bbb9001"],
            coauthorScholars: [{ cwid: "bbb9001", name: "Robin Placeholder", slug: null, dept: "CBIC" }],
          }),
        ]}
        confirmed={[]}
      />,
    );
    showEvidence();
    expect(screen.getAllByText("Robin Placeholder").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Robin Placeholder" })).toBeNull();
    expect(screen.queryByText(/bbb9001/)).toBeNull();
  });

  it("names a staff co-author WITHOUT their curated disambiguation suffix", () => {
    // The byline and the person card already strip it (#2049); the co-author
    // detail row did not, so this line read "Alessandro Fichera - Surgery,
    // Surgery" — the department inside the name and again beside it. The suffix
    // is a roster disambiguation device, not part of anybody's name.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            coauthors: ["zqf9101"],
            coauthorScholars: [
              {
                cwid: "zqf9101",
                name: "Alessandro Fichera - Surgery",
                slug: "alessandro-fichera",
                dept: "Surgery",
              },
            ],
          }),
        ]}
        confirmed={[]}
      />,
    );
    showEvidence();
    const link = within(evidence()).getByRole("link", { name: "Alessandro Fichera" });
    expect(link.getAttribute("href")).toBe("/alessandro-fichera");
    expect(evidence().textContent).not.toContain("Fichera - Surgery");
    // The department still identifies him, once, behind the comma.
    expect(within(evidence()).getByText(", Surgery")).toBeTruthy();
  });

  it("names an ED-only staff co-author without the suffix either", () => {
    // Same strip on the unlinked branch — an ED-only scholar has no profile, so
    // this is the only place their name is printed.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            coauthors: ["bbb9002"],
            coauthorScholars: [
              { cwid: "bbb9002", name: "Robin Placeholder (CBIC)", slug: null, dept: "CBIC" },
            ],
          }),
        ]}
        confirmed={[]}
      />,
    );
    showEvidence();
    expect(within(evidence()).getByText("Robin Placeholder")).toBeTruthy();
    expect(evidence().textContent).not.toContain("Placeholder (CBIC)");
  });

  it("no longer offers the abstract/MeSH Details disclosure", () => {
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ meshTerms: [{ ui: "D001921", label: "Brain" }] })]}
        confirmed={[]}
      />,
    );
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText("Details")).toBeNull();
    expect(screen.queryByText("We imaged the brain in detail.")).toBeNull();
    expect(screen.queryByText("Brain")).toBeNull();
    expect(screen.queryByText(/Testerson A, Fixture B, Sample C/)).toBeNull();
  });

  it("posts a claim and moves the row out of the review list on Confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/edit/core-claim");
    expect(JSON.parse(init.body)).toEqual({ pmid: "30418319", coreId: "2", status: "claimed" });

    // the confirmed row leaves "To review" (its Confirm button is gone)
    await waitFor(() => expect(screen.queryByRole("button", { name: /^confirm$/i })).toBeNull());
  });

  it("tints the decided strip green on confirm and red on reject (mockup parity)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "1", title: "Confirm me" }), row({ pmid: "2", title: "Reject me" })]}
        confirmed={[]}
      />,
    );
    const confirmCard = screen.getByRole("group", { name: /^Candidate: Confirm me/ });
    fireEvent.click(within(confirmCard).getByRole("button", { name: /^confirm$/i }));
    const rejectCard = screen.getByRole("group", { name: /^Candidate: Reject me/ });
    fireEvent.click(within(rejectCard).getByRole("button", { name: /^reject$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const confirmedStrip = await screen.findByRole("group", { name: /^Confirmed: Confirm me/ });
    expect(confirmedStrip.className).toContain("bg-emerald-50");
    const rejectedStrip = screen.getByRole("group", { name: /^Rejected: Reject me/ });
    expect(rejectedStrip.className).toContain("bg-red-50");
  });

  it("explains a 0-signal candidate instead of silently omitting the evidence list", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            pmid: "1",
            signalAck: false,
            ackAlias: null,
            coauthors: [],
            coauthorScholars: [],
            llmScore: null,
            authorAffinity: null,
          }),
        ]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText(/0 of 4 signals/)).toBeTruthy();
    // the collapsed strip says so too, before anything is opened
    expect(screen.getByText("No labelled signal.")).toBeTruthy();
    showEvidence();
    expect(screen.getByText(/The score moved on engine inputs this queue doesn’t show/)).toBeTruthy();
  });

  it("does not claim it can show nothing when a METHOD FAMILY is the only thing on the row", () => {
    // Three statements about one row, two of them false: the strip showed a
    // "Method family" token, the panel showed "No labelled signal.", and a fully
    // rendered "Methods used" block sat directly under that panel. The family is
    // uncounted, which is what the panel is about — it is not invisible.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            pmid: "1",
            signalAck: false,
            ackAlias: null,
            coauthors: [],
            coauthorScholars: [],
            llmScore: null,
            authorAffinity: null,
            methodTier: "strong",
            methodEvidence: [{ family: "Flow cytometry", tool: "FACSAria", sentence: "Sorted." }],
          }),
        ]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText(/0 of 4 signals/)).toBeTruthy();
    // the strip is not empty — it carries the method token — so it never said this
    expect(screen.queryByText("No labelled signal.")).toBeNull();
    showEvidence();
    expect(screen.queryByText(/engine inputs this queue doesn’t show/)).toBeNull();
    expect(screen.getByText(/The method family on this card is all it carries/)).toBeTruthy();
    expect(screen.getByText("Methods used")).toBeTruthy();
  });

  it("keeps a DIFFERENT person's repeat-user row when core staff outrank them on the byline", () => {
    // The whole signal used to vanish here: the maximum paper count on the byline
    // belongs to the staff co-author, and identity was tested only after he had
    // won. Reads 3 of 4, with the second person's own numbers.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            signalAck: false,
            ackAlias: null,
            wcmAuthors: [
              { cwid: "aaa1001", name: "Alex Testerson", slug: "alex-testerson", dept: "Radiology" },
              { cwid: "bbb2028", name: "Blake Fixture", slug: "blake-fixture", dept: "Genomics" },
            ],
          }),
        ]}
        confirmed={[]}
        paperCounts={{
          aaa1001: { papers: 120, recent: 40, total: 300 },
          bbb2028: { papers: 18, recent: 11, total: 29 },
        }}
      />,
    );
    expect(screen.getByText(/3 of 4 signals/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show evidence/ }).textContent).toContain(
      "Blake Fixture has used the core on 18 previous occasions (out of 29 publications).",
    );
    showEvidence();
    expect(within(evidence()).getByText("Repeat user")).toBeTruthy();
    expect(within(evidence()).getByText("18 confirmed papers")).toBeTruthy();
  });

  it("does not print the department TWICE in the named repeat-user sentence", () => {
    // The named sentence is new in round 2 — master's affinity row printed only
    // the engine percentage — so it arrived with the curated collision suffix
    // still on the name, and that suffix IS a department: "Alessandro Fichera -
    // Surgery, Surgery. 18 of their 29 publications...". Every other surface that
    // prints a scholar goes through `displayName`; this one now does too.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            signalAck: false,
            ackAlias: null,
            coauthors: [],
            coauthorScholars: [],
            wcmAuthors: [
              {
                cwid: "afi1007",
                name: "Alessandro Fichera - Surgery",
                slug: "alessandro-fichera",
                dept: "Surgery",
              },
            ],
          }),
        ]}
        confirmed={[]}
        paperCounts={{ afi1007: { papers: 18, recent: 11, total: 29 } }}
      />,
    );
    // The collapsed token first — it names him too.
    const strip = screen.getByRole("button", { name: /Show evidence/ }).textContent ?? "";
    expect(strip).toContain(
      "Alessandro Fichera has used the core on 18 previous occasions (out of 29 publications).",
    );
    expect(strip).not.toContain("Fichera - Surgery");
    showEvidence();
    const ev = evidence();
    expect(
      within(ev).getByText(
        "Alessandro Fichera, Surgery. 18 of their 29 publications are confirmed work with this core, 11 in the last three years.",
      ),
    ).toBeTruthy();
    expect(ev.textContent).not.toContain("Fichera - Surgery");
  });

  it("stops footnoting the repeat-user row once de-duplication has taken it off the card", () => {
    // The footnote's author-only sentence points at a row ("it only restates the
    // repeat-user number"). Here the only counted byline author IS the staff
    // co-author, so that row is gone and the sentence has to stop naming it.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            topicalPrior: 0.6,
            wcmAuthors: [
              { cwid: "aaa1001", name: "Alex Testerson", slug: "alex-testerson", dept: "Radiology" },
            ],
          })
        ]}
        confirmed={[]}
        paperCounts={{ aaa1001: { papers: 6, recent: 2, total: 30 } }}
      />,
    );
    showEvidence();
    expect(within(evidence()).queryByText("Repeat user")).toBeNull();
    expect(screen.queryByText(/only restates the repeat-user number/)).toBeNull();
    expect(screen.getByText(/rests on an author's prior use of this core/)).toBeTruthy();
  });

  it("does not claim it can show nothing when the prior IS the only thing on the row", () => {
    // The prior stopped being a counted signal, so a prior-only row now reads as
    // 0 of 4 — but the footnote right underneath shows exactly what moved the
    // score, and the empty state must not contradict the line below it.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            pmid: "1",
            signalAck: false,
            ackAlias: null,
            coauthors: [],
            coauthorScholars: [],
            llmScore: null,
            authorAffinity: null,
            topicalPrior: 0.6,
          }),
        ]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText(/0 of 4 signals/)).toBeTruthy();
    showEvidence();
    expect(screen.queryByText(/engine inputs this queue doesn’t show/)).toBeNull();
    expect(screen.getByText(/The prefilter prior on this card is all it carries/)).toBeTruthy();
    expect(screen.getByText(/the topical prior \(60%\)/)).toBeTruthy();
  });

  it("surfaces an error and keeps the row when the POST is refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "not_core_owner" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not_core_owner"));
    // still reviewable — the Confirm button is still present
    expect(screen.getByRole("button", { name: /^confirm$/i })).toBeTruthy();
  });

  // --- undo / keyboard / facets / sort ---

  it("undo posts a revoke and restores the actionable card", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    const undo = await screen.findByRole("button", { name: /undo/i });
    fireEvent.click(undo);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body)).toEqual({
      pmid: "30418319",
      coreId: "2",
      status: "revoked",
    });
    // the card is actionable again
    await waitFor(() => expect(screen.getByRole("button", { name: /^confirm$/i })).toBeTruthy());
  });

  it("confirms via the 'a' keyboard shortcut on the focused card", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.keyDown(container.querySelector("[data-card]") as HTMLElement, { key: "a" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).status).toBe(
      "claimed",
    );
  });

  it("filters the visible candidates", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Acked paper", signalAck: true, ackAlias: "CBIC" }),
          row({
            pmid: "2",
            title: "Bare paper",
            signalAck: false,
            ackAlias: null,
            coauthors: [],
            coauthorScholars: [],
            llmScore: null,
            authorAffinity: null,
          }),
        ]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText("Acked paper")).toBeTruthy();
    expect(screen.getByText("Bare paper")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /^Acknowledged/ }));
    expect(screen.getByText("Acked paper")).toBeTruthy();
    expect(screen.queryByText("Bare paper")).toBeNull();
  });

  it("AND-combines two ticked facets, narrowing to the rows carrying both", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            pmid: "1",
            title: "Acked only",
            signalAck: true,
            ackAlias: "CBIC",
            coauthors: [],
            coauthorScholars: [],
          }),
          row({
            pmid: "2",
            title: "Co-authored only",
            signalAck: false,
            ackAlias: null,
          }),
          row({
            pmid: "3",
            title: "Both signals",
            signalAck: true,
            ackAlias: "CBIC",
          }),
        ]}
        confirmed={[]}
      />,
    );
    const tick = (name: RegExp) => fireEvent.click(screen.getByRole("checkbox", { name }));

    tick(/^Acknowledged/);
    expect(screen.queryByText("Co-authored only")).toBeNull();
    expect(screen.getByText("Acked only")).toBeTruthy();

    tick(/^Staff co-author/);
    // intersection, not union: only the row carrying BOTH survives
    expect(screen.queryByText("Acked only")).toBeNull();
    expect(screen.queryByText("Co-authored only")).toBeNull();
    expect(screen.getByText("Both signals")).toBeTruthy();

    // un-ticking is the same click
    tick(/^Acknowledged/);
    expect(screen.getByText("Co-authored only")).toBeTruthy();
  });

  it("drops a facet whose count is 0 rather than offering a pill that empties the queue", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row()]} // has an affinity, and no known client on the byline
        confirmed={[]}
      />,
    );
    // present, with counts
    expect(screen.getByRole("checkbox", { name: /^Acknowledged/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^Staff co-author/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^LLM-flagged/ })).toBeTruthy();
    // absent entirely (not disabled, not zero-labelled)
    expect(screen.queryByRole("checkbox", { name: /^Client co-author/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /^No prior usage/ })).toBeNull();
    // and every pill in the group is a genuine checkbox — the "All" reset pill
    // is gone, so there is no button-among-checkboxes left in this row
    expect(screen.queryByRole("button", { name: /^All\b/ })).toBeNull();
    const facets = screen.getByRole("group", { name: "Filter candidates by evidence" });
    expect(within(facets).queryAllByRole("button")).toEqual([]);
  });

  it("shows the Client co-author facet once a byline author is a known client", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row()]}
        confirmed={[]}
        clients={[
          {
            id: "client-ccc1003",
            cwid: "ccc1003",
            name: "Casey Sample",
            slug: "casey-sample",
            affiliation: null,
            addedByName: null,
            addedAt: new Date("2026-01-01"),
            addedBy: "aaa1001",
          },
        ]}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Client co-author 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show evidence/ }).textContent).toContain(
      "Casey Sample",
    );
  });

  it("has NO 'All' reset pill — 'Clear filters' is the only reset, for pills and text alike", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Acked paper", signalAck: true, ackAlias: "CBIC" }),
          row({
            pmid: "2",
            title: "Bare paper",
            signalAck: false,
            ackAlias: null,
            ackSnippet: null,
            coauthors: [],
            coauthorScholars: [],
            llmScore: null,
            authorAffinity: null,
          }),
        ]}
        confirmed={[]}
      />,
    );
    const box = (name: RegExp) => screen.getByRole("checkbox", { name });
    // the pill is gone in every guise — as a button, and as a checkbox
    expect(screen.queryByRole("button", { name: /^All\b/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /^All\b/ })).toBeNull();

    // a PILL narrowing resets through "Clear filters"
    fireEvent.click(box(/^Acknowledged/));
    expect(box(/^Acknowledged/).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Bare paper")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(box(/^Acknowledged/).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Bare paper")).toBeTruthy();

    // ...and so does a TEXT-ONLY narrowing, which the retired "All" pill never
    // touched: with it gone this link is the sole reset affordance on the queue.
    fireEvent.change(screen.getByLabelText("Filter candidates"), {
      target: { value: "acked" },
    });
    expect(screen.queryByText("Bare paper")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect((screen.getByLabelText("Filter candidates") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Bare paper")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("labels each facet with its count over the still-undecided rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Acked paper", signalAck: true, ackAlias: "CBIC" }),
          row({
            pmid: "2",
            title: "Bare paper",
            signalAck: false,
            ackAlias: null,
            coauthors: [],
            coauthorScholars: [],
            llmScore: null,
            authorAffinity: null,
          }),
        ]}
        confirmed={[]}
      />,
    );
    const label = (name: RegExp) => screen.getByRole("checkbox", { name }).textContent;
    expect(screen.getByText("Showing 2 of 2 candidates")).toBeTruthy();
    expect(label(/^Acknowledged/)).toBe("Acknowledged 1");
    expect(label(/^Staff co-author/)).toBe("Staff co-author 1");
    expect(label(/^LLM-flagged/)).toBe("LLM-flagged 1");
    // "Bare paper" has no affinity, so the no-prior facet is live at 1
    expect(label(/^No prior usage/)).toBe("No prior usage on the byline 1");

    // a decided row is held on screen for its undo but must not inflate a count
    const acked = screen.getByLabelText("Candidate: Acked paper");
    fireEvent.click(within(acked).getByRole("button", { name: /^confirm$/i }));
    // it drops out of the counts entirely once it is the last row carrying that signal
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: /^Acknowledged/ })).toBeNull(),
    );
    // the remaining facets fall with it — the decided row counts for nothing
    expect(label(/^No prior usage/)).toBe("No prior usage on the byline 1");
    expect(screen.queryByRole("checkbox", { name: /^Staff co-author/ })).toBeNull();
  });

  it("re-sorts by LLM score when selected", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "High likelihood, low LLM", likelihood: 0.9, llmScore: 3 }),
          row({ pmid: "2", title: "Low likelihood, high LLM", likelihood: 0.5, llmScore: 9 }),
        ]}
        confirmed={[]}
      />,
    );
    const titles = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    // likelihood-desc is the default; set it explicitly so the baseline is pinned
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "likelihood" } });
    expect(titles()).toEqual(["High likelihood, low LLM", "Low likelihood, high LLM"]);

    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "llm" } });
    expect(titles()).toEqual(["Low likelihood, high LLM", "High likelihood, low LLM"]);
  });

  it("splits the sort control into a visible 'Sort' label and BARE option text", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const select = screen.getByLabelText("Sort by") as HTMLSelectElement;
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    // the label now carries the word, so no option repeats it. Order is the
    // shipped order (unchanged by this pass); membership is what's pinned.
    expect(options).toHaveLength(6);
    for (const label of [
      "Most certain first",
      "Most uncertain first",
      "Newest in PubMed",
      "Most cited",
      "Strongest signal",
      "LLM score",
    ]) {
      expect(options).toContain(label);
    }
    expect(options.some((o) => o?.startsWith("Sort"))).toBe(false);

    // the visible label is a real <label for=…> tied to the select — not loose
    // text sitting next to it...
    const visible = screen.getByText("Sort", { selector: "label" }) as HTMLLabelElement;
    expect(visible.htmlFor).toBe(select.id);
    expect(select.id).not.toBe("");
    // ...and the select keeps the fuller accessible name the sr-only span gave it
    expect(select.getAttribute("aria-label")).toBe("Sort by");
  });

  it("defaults to likelihood-desc ordering, not uncertain-first", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Near-certain", likelihood: 0.96 }),
          row({ pmid: "2", title: "Borderline", likelihood: 0.58 }),
        ]}
        confirmed={[]}
      />,
    );
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Near-certain", "Borderline"]); // highest likelihood first
    // and the select agrees, so the visible label matches the applied order
    expect((screen.getByLabelText("Sort by") as HTMLSelectElement).value).toBe("likelihood");
  });

  it("re-sorts likelihood-desc, then uncertain-first when selected", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Very confident", likelihood: 0.97 }),
          row({ pmid: "2", title: "Coin-flip", likelihood: 0.52 }),
        ]}
        confirmed={[]}
      />,
    );
    const titles = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "likelihood" } });
    expect(titles()).toEqual(["Very confident", "Coin-flip"]);
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "uncertain" } });
    expect(titles()).toEqual(["Coin-flip", "Very confident"]);
  });

  it("announces the outcome politely for screen readers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const live = screen.getByTestId("core-claim-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe(""); // silent until an action

    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() => expect(live.textContent).toBe("Confirmed Advanced MRI of the brain."));
  });

  it("rejects via the 'r' shortcut and undoes via 'u' on the decided card", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const card = () => container.querySelector("[data-card]") as HTMLElement;

    fireEvent.keyDown(card(), { key: "r" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).status).toBe(
      "rejected",
    );

    await screen.findByRole("button", { name: /undo/i });
    fireEvent.keyDown(card(), { key: "u" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body).status).toBe(
      "revoked",
    );
  });

  it("ArrowDown moves roving focus to the next card", () => {
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "1", title: "First" }), row({ pmid: "2", title: "Second" })]}
        confirmed={[]}
      />,
    );
    const cards = container.querySelectorAll("[data-card]");
    fireEvent.keyDown(cards[0] as HTMLElement, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement)?.getAttribute("data-pmid")).toBe("2");
  });

  it("moves roving focus with j (down) and k (up), the vi twins of the arrows", () => {
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "First" }),
          row({ pmid: "2", title: "Second" }),
          row({ pmid: "3", title: "Third" }),
        ]}
        confirmed={[]}
      />,
    );
    const card = (pmid: string) =>
      container.querySelector(`[data-card][data-pmid="${pmid}"]`) as HTMLElement;
    const focused = () => (document.activeElement as HTMLElement)?.getAttribute("data-pmid");

    fireEvent.keyDown(card("1"), { key: "j" });
    expect(focused()).toBe("2");
    fireEvent.keyDown(card("2"), { key: "j" });
    expect(focused()).toBe("3");
    fireEvent.keyDown(card("3"), { key: "k" });
    expect(focused()).toBe("2");
    fireEvent.keyDown(card("2"), { key: "k" });
    expect(focused()).toBe("1");
    // uppercase reads the same (the handler lowercases the key)
    fireEvent.keyDown(card("1"), { key: "J" });
    expect(focused()).toBe("2");
  });

  it("'x' ticks the focused card AND arms selection mode from the default state", () => {
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "1", title: "Picked A" }), row({ pmid: "2", title: "Picked B" })]}
        confirmed={[]}
      />,
    );
    const card = (pmid: string) =>
      container.querySelector(`[data-card][data-pmid="${pmid}"]`) as HTMLElement;
    // selection mode is OFF by default — no checkboxes, no selection bar
    expect(screen.getByRole("button", { name: "Select several" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Select Picked A" })).toBeNull();

    fireEvent.keyDown(card("1"), { key: "x" });
    // it armed the mode...
    expect(screen.getByRole("button", { name: "Exit selection" })).toBeTruthy();
    // ...and ticked this row, and only this row
    expect(
      (screen.getByRole("checkbox", { name: "Select Picked A" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: "Select Picked B" }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByText("1 paper selected")).toBeTruthy();

    // a second 'x' TOGGLES it back off (and leaves the mode armed)
    fireEvent.keyDown(card("1"), { key: "x" });
    expect(
      (screen.getByRole("checkbox", { name: "Select Picked A" }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.queryByText(/paper[s]? selected/)).toBeNull();
    expect(screen.getByRole("button", { name: "Exit selection" })).toBeTruthy();
  });

  it("advertises the new keys on the card shell via aria-keyshortcuts", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />,
    );
    const shell = container.querySelector("[data-card]") as HTMLElement;
    const keys = (shell.getAttribute("aria-keyshortcuts") ?? "").split(" ");
    for (const k of ["a", "r", "x", "j", "k", "ArrowUp", "ArrowDown"]) expect(keys).toContain(k);
  });

  it("does NOT fire a shortcut typed into a child control (the shell-only guard)", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "1", title: "First" }), row({ pmid: "2", title: "Second" })]}
        confirmed={[]}
      />,
    );

    // 'a' typed while the Confirm button (a child) is focused must NOT claim.
    const confirm = screen.getAllByRole("button", { name: /^confirm$/i })[0];
    fireEvent.keyDown(confirm, { key: "a" });
    expect(fetchMock).not.toHaveBeenCalled();
    // ...nor may the new keys act from a child: no roving move, no selection.
    fireEvent.keyDown(confirm, { key: "j" });
    expect(container.querySelector("[data-card]:focus")).toBeNull();
    fireEvent.keyDown(confirm, { key: "x" });
    expect(screen.getByRole("button", { name: "Select several" })).toBeTruthy();

    // The same holds for a child INPUT: arm selection, then type into the row's
    // own checkbox. 'x' there must toggle nothing beyond the native control.
    fireEvent.click(screen.getByRole("button", { name: "Select several" }));
    const box = screen.getByRole("checkbox", { name: "Select First" }) as HTMLInputElement;
    fireEvent.keyDown(box, { key: "x" });
    expect(box.checked).toBe(false);
    fireEvent.keyDown(box, { key: "j" });
    expect(container.querySelector("[data-card]:focus")).toBeNull();
    fireEvent.keyDown(box, { key: "r" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT hijack j/k/x typed into the FILTER BOX", () => {
    // The load-bearing case for the shell-only guard now that the shortcuts are
    // ordinary printable characters and the filter box moved into the header:
    // typing a word containing j, k or x must narrow the queue and nothing else
    // — no focus jump, no selection mode, no claim.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Jacks, Kydd and Xu on imaging" }),
          row({ pmid: "2", title: "Second" }),
        ]}
        confirmed={[]}
      />,
    );
    const input = screen.getByLabelText("Filter candidates") as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    for (const key of ["j", "k", "x", "a", "r", "u", "ArrowDown", "ArrowUp"]) {
      fireEvent.keyDown(input, { key });
    }
    // focus never left the box for a card, no card was decided, no mode armed
    expect(document.activeElement).toBe(input);
    expect(container.querySelector("[data-card]:focus")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Select several" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /^Select / })).toBeNull();

    // and the box still filters, so the guard didn't cost the control anything
    fireEvent.change(input, { target: { value: "jacks" } });
    expect(screen.getByText("Showing 1 of 2 candidates")).toBeTruthy();
  });

  it("keeps a just-decided row visible under a facet that would exclude it, so undo stays reachable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    // two candidates so the Acknowledged facet survives the decision
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", signalAck: false, ackAlias: null }),
          row({ pmid: "2", title: "Acked sibling", signalAck: true, ackAlias: "CBIC" }),
        ]}
        confirmed={[]}
      />,
    );

    const target = screen.getByLabelText("Candidate: Advanced MRI of the brain");
    fireEvent.click(within(target).getByRole("button", { name: /^confirm$/i }));
    await screen.findByRole("button", { name: /undo/i });

    fireEvent.click(screen.getByRole("checkbox", { name: /^Acknowledged/ }));
    // still shown via the decided-row override, so its Undo is reachable
    expect(screen.getByRole("button", { name: /undo/i })).toBeTruthy();
  });

  // --- evidence grouping ---

  it("groups rows by evidence kind, in the group vocabulary, with a band range", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Acked A", likelihood: 0.94 }),
          row({ pmid: "2", title: "Acked B", likelihood: 0.52 }),
          row({
            pmid: "3",
            title: "LLM only",
            likelihood: 0.5,
            signalAck: false,
            ackAlias: null,
            coauthors: [],
            coauthorScholars: [],
            authorAffinity: null,
          }),
        ]}
        confirmed={[]}
      />,
    );
    expect(
      screen.getByText("2 papers · acknowledgment + staff co-author + LLM read + repeat user"),
    ).toBeTruthy();
    expect(screen.getByText("1 paper · LLM read")).toBeTruthy();
    // the range speaks bands, never "likelihood 52–94%"
    expect(screen.getByText("Slight to Strong")).toBeTruthy();
    expect(screen.queryByText(/likelihood \d/)).toBeNull();
  });

  it("labels a group with no COUNTED evidence kinds 'no counted signal'", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            pmid: "1",
            signalAck: false,
            ackAlias: null,
            coauthors: [],
            coauthorScholars: [],
            llmScore: null,
            authorAffinity: null,
          }),
        ]}
        confirmed={[]}
      />,
    );
    // "counted", not "labelled": a method-family row groups here too, and its
    // chips, strip token and quote are all labels the card draws.
    expect(screen.getByText("1 paper · no counted signal")).toBeTruthy();
  });

  it("collapses and re-expands a group", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const caret = screen.getByRole("button", { name: "Collapse or expand this group" });
    expect(caret.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(caret);
    expect(screen.queryByText("Advanced MRI of the brain")).toBeNull();
    fireEvent.click(caret);
    expect(screen.getByText("Advanced MRI of the brain")).toBeTruthy();
  });

  it("turns grouping off and back on", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const toggle = screen.getByRole("button", { name: /^Grouped by evidence$/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /^Group by evidence$/ })).toBeTruthy();
    // no group header while flat
    expect(screen.queryByRole("button", { name: "Collapse or expand this group" })).toBeNull();
    expect(screen.getByText("Advanced MRI of the brain")).toBeTruthy();
  });

  // --- selection mode + the hand-picked bulk bar ---

  it("has no likelihood-gated bulk-confirm sweep", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "High A", likelihood: 0.96 }),
          row({ pmid: "2", title: "High B", likelihood: 0.91 }),
        ]}
        confirmed={[]}
      />,
    );
    expect(screen.queryByRole("button", { name: /high-confidence/i })).toBeNull();
    expect(screen.queryByText(/Confirm 2/)).toBeNull();
  });

  it("confirms a hand-selected set through one bulk POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Picked A" }),
          row({ pmid: "2", title: "Picked B" }),
          row({ pmid: "3", title: "Left alone" }),
        ]}
        confirmed={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select several" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Picked A" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Picked B" }));
    expect(screen.getByText("2 papers selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm all" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/edit/core-claim/bulk");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", pmids: ["1", "2"], status: "claimed" });
    expect(screen.getByTestId("core-claim-live").textContent).toBe("Confirmed 2 publications.");
  });

  it("asks before bulk-rejecting, and posts nothing when the reviewer declines", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "1", title: "Picked A" }), row({ pmid: "2", title: "Picked B" })]}
        confirmed={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));

    expect(confirmMock).toHaveBeenCalledWith("Reject 2 publications for this core?");
    expect(fetchMock).not.toHaveBeenCalled();
    // the rows stay selected, so declining costs the reviewer nothing
    expect(screen.getByText("2 papers selected")).toBeTruthy();
  });

  it("bulk-rejects once the reviewer accepts the guard", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "1", title: "Picked A" }), row({ pmid: "2", title: "Picked B" })]}
        confirmed={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/edit/core-claim/bulk");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", pmids: ["1", "2"], status: "rejected" });
    expect(screen.getByTestId("core-claim-live").textContent).toBe("Rejected 2 publications.");
  });

  it("does not ask before bulk-confirming — only reject is guarded", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmMock);
    render(
      <CoreClaimQueue core={CORE} candidates={[row({ pmid: "1", title: "Picked A" })]} confirmed={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm all" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("drops a selected row from the bulk post once the filter hides it", async () => {
    // Ticking a row and then narrowing the filter used to leave it in the batch: the bar
    // counted every selected pmid, visible or not. Acting on rows the reviewer cannot see
    // is the exact failure that retiring the high-confidence sweep was meant to end.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Alpha imaging study" }),
          row({ pmid: "2", title: "Beta sequencing study" }),
        ]}
        confirmed={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select several" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha imaging study" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta sequencing study" }));
    expect(screen.getByText("2 papers selected")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter candidates" }), {
      target: { value: "beta" },
    });
    expect(screen.getByText("1 paper selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm all" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).pmids).toEqual(["2"]);
  });

  it("surfaces the failure on every selected row when the bulk POST is refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue core={CORE} candidates={[row({ pmid: "1", title: "Picked A" })]} confirmed={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select several" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Picked A" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm all" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("bulk confirm failed"));
    // the row stays reviewable
    expect(screen.getByRole("button", { name: /^confirm$/i })).toBeTruthy();
    expect(screen.getByTestId("core-claim-live").textContent).toBe(
      "Bulk confirm could not be saved.",
    );
  });

  it("'Select N' on a group arms selection mode and picks that whole pile", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "1", title: "Picked A" }), row({ pmid: "2", title: "Picked B" })]}
        confirmed={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select 2" }));
    expect(screen.getByText("2 papers selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit selection" })).toBeTruthy();
  });

  it("shows a 'Manually added' badge on a confirmed row with no engine signals", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ pmid: "5", title: "Old paper", claimed: true, isManual: true })]}
      />,
    );
    expect(screen.getByText("Manually added")).toBeTruthy();
  });

  it("does not show the badge on an ordinary confirmed row", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ pmid: "5", title: "Old paper", claimed: true, isManual: false })]}
      />,
    );
    expect(screen.queryByText("Manually added")).toBeNull();
  });

  it("claims a pasted block of PMIDs via the bulk endpoint and refreshes on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ dryRun: true, wouldWrite: 2, skipped: 0, notFound: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ written: 2, skipped: 0, notFound: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add PMIDs/ }));
    fireEvent.change(screen.getByLabelText("Paste PMIDs"), {
      target: { value: "111, 222\n222" }, // dupe collapses client-side
    });
    // Step 1: the dry run. Nothing is written by it.
    fireEvent.click(screen.getByRole("button", { name: "Check PMIDs" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)).toEqual({
      coreId: "2",
      pmids: ["111", "222"],
      status: "claimed",
      dryRun: true,
    });
    // Step 2: the real claim, which the check has now enabled.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Claim publications" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Claim publications" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as [string, { body: string }];
    expect(url).toBe("/api/edit/core-claim/bulk");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", pmids: ["111", "222"], status: "claimed" });
    // "Claimed 2." lands in both the result line and the aria-live announcer —
    // scope to the status paragraph specifically.
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Claimed 2."));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("reports skipped/not-found pmids and does NOT refresh when nothing new was written", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        // wouldWrite 1 so the footer button enables; the real call then finds
        // the row already claimed and writes nothing.
        json: async () => ({ dryRun: true, wouldWrite: 1, skipped: 1, notFound: ["999"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ written: 0, skipped: 1, notFound: ["999"] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add PMIDs/ }));
    fireEvent.change(screen.getByLabelText("Paste PMIDs"), {
      target: { value: "1 999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check PMIDs" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Claim publications" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Claim publications" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /Already claimed: 1\..*Not found in SPS: 999\./,
      ),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("does not call the API on a block with no valid PMIDs, and names what it ignored", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add PMIDs/ }));
    fireEvent.change(screen.getByLabelText("Paste PMIDs"), {
      target: { value: "abc, def" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check PMIDs" }));
    expect(screen.getByText(/No valid PMIDs found \(ignored: abc, def\)\./)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    // And with nothing checked, the commit button never enables.
    expect(
      (screen.getByRole("button", { name: "Claim publications" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("revokes a human-claimed Confirmed row with 'revoked' and offers undo", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ pmid: "9", title: "Claimed pub", claimed: true })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({
      pmid: "9",
      coreId: "2",
      status: "revoked",
    });
    // Title, year, PMID all stay visible — only the trailing note changes.
    expect(await screen.findByText("Claimed pub")).toBeTruthy();
    expect(screen.getByText(/— Revoked, re-files on next load/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /undo/i })).toBeTruthy();
  });

  it("revokes an engine-confirmed Confirmed row with 'rejected' (no claim to revoke)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ pmid: "8", title: "Engine pub", claimed: false })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).status).toBe(
      "rejected",
    );
  });

  // --- segmented tabs (#1239): To review / Confirmed / Rejected ---

  it("stays a single scroll (no tabs) when there is no confirmed/rejected history", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    // the "To review" heading is present; no segmented view-switch group
    expect(screen.queryByRole("group", { name: "Queue view" })).toBeNull();
  });

  it("lands on the Confirmed tab when there is no open review work", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ pmid: "9", title: "Done pub", claimed: true })]}
      />,
    );
    // no candidates → default view is Confirmed, so the row shows without a click
    expect(screen.getByRole("group", { name: "Queue view" })).toBeTruthy();
    expect(screen.getByText("Done pub")).toBeTruthy();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeTruthy();
  });

  it("lands on the Rejected tab when the only history is rejected items", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[]}
        rejected={[row({ pmid: "9", title: "Rejected only", claimed: true })]}
      />,
    );
    // no candidates and no confirmed → default ladder falls through to Rejected
    expect(screen.getByText("Rejected only")).toBeTruthy();
    expect(screen.getByRole("button", { name: /restore/i })).toBeTruthy();
  });

  it("shows previously-rejected items on the Rejected tab and restores via 'revoked'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "1", title: "Open candidate" })]}
        confirmed={[]}
        rejected={[row({ pmid: "9", title: "Rejected pub", claimed: true })]}
      />,
    );
    // default lands on To review (a candidate is present); the rejected row is hidden
    expect(screen.queryByText("Rejected pub")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Rejected 1/ }));
    expect(screen.getByText("Rejected pub")).toBeTruthy();

    // Restore posts the soft 'revoked' undo and shows the restored affordance
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({
      pmid: "9",
      coreId: "2",
      status: "revoked",
    });
    // Title stays visible (not swallowed by the restored note) — same fix as revoke.
    expect(await screen.findByText("Rejected pub")).toBeTruthy();
    expect(screen.getByText(/— Restored, re-files on next load/)).toBeTruthy();
  });

  it("keeps a rejected row and surfaces an error when the restore POST is refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "not_core_owner" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[]}
        rejected={[row({ pmid: "9", title: "Rejected pub", claimed: true })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not_core_owner"));
    // not restored — the Restore affordance is still present
    expect(screen.getByRole("button", { name: /restore/i })).toBeTruthy();
    expect(screen.queryByText(/re-files on next load/)).toBeNull();
  });

  it("highlights the core-staff author inline in the byline, named in FULL", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    // "Testerson A" resolves to the scholar, so the byline shows the display
    // name rather than the PubMed initials, and links to the profile.
    const byline = document.querySelector('[data-slot="core-queue-byline"]');
    const chip = within(byline as HTMLElement).getByText("Alex Testerson");
    expect(chip.closest("a")?.getAttribute("href")).toBe("/alex-testerson");
    expect(byline?.textContent).not.toContain("Testerson A");
  });

  it("leaves an author we cannot resolve in its PubMed form", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    // "Fixture B" matches no scholar — no rename, no link.
    const el = document.querySelector('[data-slot="core-queue-byline"]');
    expect(el?.textContent).toContain("Fixture B");
  });

  it("does NOT rename on a surname collision — it would print one person twice", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            authorsString: "Testerson A, Testerson B",
            fullAuthorsString: "Testerson A, Testerson B",
            coauthorScholars: [
              { cwid: "aaa1001", name: "Alex Testerson", slug: "alex-testerson", dept: "Radiology" },
              { cwid: "bbb1002", name: "Blair Testerson", slug: "blair-testerson", dept: "Radiology" },
            ],
          }),
        ]}
        confirmed={[]}
      />,
    );
    const el = document.querySelector('[data-slot="core-queue-byline"]') as HTMLElement;
    // Both tokens keep their PubMed form; neither is rewritten to the other's name.
    expect(el.textContent).toContain("Testerson A");
    expect(el.textContent).toContain("Testerson B");
    // And neither is a LINK or a card. We do not know which person the token is,
    // so the href we used to emit pointed at whichever colliding scholar landed
    // in the map first — a wrong link by construction (round 2, item 1b).
    expect(el.querySelectorAll("a")).toHaveLength(0);
    expect(el.querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  it("does NOT rename when the first initial disagrees", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            authorsString: "Testerson Z",
            fullAuthorsString: "Testerson Z",
          }),
        ]}
        confirmed={[]}
      />,
    );
    const el = document.querySelector('[data-slot="core-queue-byline"]');
    expect(el?.textContent).toContain("Testerson Z");
    expect(el?.textContent).not.toContain("Alex Testerson");
  });

  it("expands a MULTI-WORD surname, which the last-word key could never match", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            // PubMed's lead word here is "Niño"; the scholar's last word is
            // "Rivera", so before round 2 these two could never meet.
            authorsString: "Niño de Rivera S, Fixture B",
            fullAuthorsString: "Niño de Rivera S, Fixture B",
            wcmAuthors: [
              {
                cwid: "snr1004",
                name: "Sara Niño de Rivera",
                slug: "sara-nino-de-rivera",
                dept: "Population Health Sciences",
              },
            ],
          }),
        ]}
        confirmed={[]}
      />,
    );
    const byline = document.querySelector('[data-slot="core-queue-byline"]') as HTMLElement;
    const named = within(byline).getByText("Sara Niño de Rivera");
    expect(named.closest("a")?.getAttribute("href")).toBe("/sara-nino-de-rivera");
    expect(byline.textContent).not.toContain("Niño de Rivera S");
  });

  it("cards EVERY resolvable WCM author, not just core staff and known clients", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            authorsString: "Testerson A, Sample C, Fixture B",
            fullAuthorsString: "Testerson A, Sample C, Fixture B",
          }),
        ]}
        confirmed={[]}
      />,
    );
    const byline = document.querySelector('[data-slot="core-queue-byline"]') as HTMLElement;
    // Casey Sample is neither core staff nor a known client — a plain WCM
    // co-author — and still gets the full name, the link and a card. Before
    // round 2, 29 of the live page's 3,497 byline anchors carried one.
    const casey = within(byline).getByText("Casey Sample");
    expect(casey.getAttribute("data-slot")).toBe("hover-card-trigger");
    expect(within(byline).getByText("Alex Testerson").getAttribute("data-slot")).toBe(
      "hover-card-trigger",
    );
    // "Fixture B" resolves to nobody, so it stays PubMed's, uncarded and unlinked.
    expect(byline.querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(2);
    expect(byline.textContent).toContain("Fixture B");
  });

  it("says on the card that a plain WCM co-author is NOT staff and NOT a client", async () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            authorsString: "Sample C, Fixture B",
            fullAuthorsString: "Sample C, Fixture B",
          }),
        ]}
        confirmed={[]}
      />,
    );
    const byline = document.querySelector('[data-slot="core-queue-byline"]') as HTMLElement;
    // Radix opens on the synthetic pointerenter React derives from pointerover,
    // after the wrapper's 200ms openDelay — hence pointerOver, not pointerEnter.
    fireEvent.pointerOver(within(byline).getByText("Casey Sample"));
    const card = (await screen.findByText(/WCM co-author on this paper/)).closest(
      '[data-slot="core-queue-person-card"]',
    ) as HTMLElement;
    // The role line must identify, never imply core usage — Casey Sample has no
    // staff row and is on no client list, and the card has to say so rather than
    // leave a reviewer to read the card's existence as evidence.
    expect(card.textContent).toContain("not core staff, and not a known client of this core");
    expect(card.textContent).not.toContain("Core staff");
    expect(card.textContent).not.toContain("Known client of this core"); // the client line, capitalised
    expect(card.textContent).toContain("ccc1003");
  });

  it("reports how much of the queue the current filter is showing", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Acked paper" }),
          row({
            pmid: "2",
            title: "Bare paper",
            signalAck: false,
            ackAlias: null,
            coauthors: [],
            coauthorScholars: [],
            llmScore: null,
            authorAffinity: null,
          }),
        ]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText("Showing 2 of 2 candidates")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Acknowledged/ }));
    expect(screen.getByText("Showing 1 of 2 candidates")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Showing 2 of 2 candidates")).toBeTruthy();
  });

  it("narrows the queue on the free-text filter, and counts it in the showing line", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Advanced MRI of the brain" }),
          row({ pmid: "2", title: "Flow cytometry gating strategies", journal: "Cytometry A" }),
        ]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText("Showing 2 of 2 candidates")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter candidates"), {
      target: { value: "cytometry" },
    });
    expect(screen.getByText("Showing 1 of 2 candidates")).toBeTruthy();
    expect(screen.getByText("Flow cytometry gating strategies")).toBeTruthy();
    expect(screen.queryByText("Advanced MRI of the brain")).toBeNull();
  });

  it("shows the empty state when the text query matches nothing", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row(), row({ pmid: "2" })]} confirmed={[]} />);
    fireEvent.change(screen.getByLabelText("Filter candidates"), {
      target: { value: "electron tomography" },
    });
    expect(screen.getByText("Nothing matches this filter.")).toBeTruthy();
    expect(screen.getByText("Showing 0 of 2 candidates")).toBeTruthy();
  });

  it("'Clear filters' clears the text box as well as the pills, and appears for text alone", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "Acked paper" }),
          row({
            pmid: "2",
            title: "Bare paper",
            signalAck: false,
            ackAlias: null,
            ackSnippet: null,
            coauthors: [],
            coauthorScholars: [],
            llmScore: null,
            authorAffinity: null,
          }),
        ]}
        confirmed={[]}
      />,
    );
    const input = screen.getByLabelText("Filter candidates") as HTMLInputElement;
    // nothing narrowed yet — no clear affordance to offer
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();

    // text ALONE surfaces the clear link (the text box has none of its own)
    fireEvent.change(input, { target: { value: "acked" } });
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
    expect(screen.getByText("Showing 1 of 2 candidates")).toBeTruthy();

    // pills on top of text: both narrowings AND-combine
    fireEvent.click(screen.getByRole("checkbox", { name: /^Acknowledged/ }));
    expect(screen.getByText("Showing 1 of 2 candidates")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(input.value).toBe("");
    expect(
      screen.getByRole("checkbox", { name: /^Acknowledged/ }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText("Showing 2 of 2 candidates")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("disables both selection-bar buttons while a bulk decision is in flight", async () => {
    // A double-click on "Confirm all" used to post the same batch twice: the bar
    // had no disabled state, unlike every per-row button in this component.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(() =>
      gate.then(() => ({ ok: true, json: async () => ({ ok: true }) })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "1", title: "Picked A" }), row({ pmid: "2", title: "Picked B" })]}
        confirmed={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm all" }));

    // the acting button swaps to the pending label, both are disabled
    const confirming = screen.getByRole("button", { name: "Confirming…" }) as HTMLButtonElement;
    expect(confirming.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject all" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(confirming);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the second click posts nothing

    release();
    await waitFor(() =>
      expect(screen.getByTestId("core-claim-live").textContent).toBe("Confirmed 2 publications."),
    );
  });

  it("offers no CSV download — the button came out to match the mockup toolbar", () => {
    // Owner decision: the header is [Known clients] [Add PMIDs] [Reporting...]
    // and nothing else. `downloadCsv()` is deliberately KEPT in the component,
    // uncalled, for the day a reporting view gives it an entry point again — so
    // this asserts the BUTTON is gone, not that the export was deleted.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ pmid: "111", title: "A candidate." })]}
        confirmed={[row({ pmid: "222", title: "A confirmed one", claimed: true })]}
      />,
    );
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /csv/i })).toBeNull();
  });
});

describe("matchesQuery", () => {
  const searchable = row({
    title: "Advanced MRI of the brain",
    journal: "NeuroImage",
    pmid: "30418319",
    synopsis: "A faster acquisition sequence.",
    authorsString: "Testerson A, Fixture B",
    ackAlias: "CBIC",
    ackSnippet: "processed at the CBIC imaging facility",
    wcmAuthors: [{ cwid: "ccc1003", name: "Casey Sample", slug: "casey-sample", dept: "Genomics" }],
    coauthorScholars: [
      { cwid: "aaa1001", name: "Alex Testerson", slug: "alex-testerson", dept: "Radiology" },
    ],
    meshTerms: [{ ui: "D000000", label: "Zebrafish" }],
  });

  it("matches on each field the card puts on screen", () => {
    expect(matchesQuery(searchable, "advanced mri")).toBe(true); // title, case-insensitive
    expect(matchesQuery(searchable, "NeuroImage")).toBe(true); // journal
    expect(matchesQuery(searchable, "30418")).toBe(true); // pmid, partial
    expect(matchesQuery(searchable, "acquisition")).toBe(true); // synopsis
    expect(matchesQuery(searchable, "Fixture B")).toBe(true); // byline
    expect(matchesQuery(searchable, "cbic")).toBe(true); // acknowledgment alias
    expect(matchesQuery(searchable, "imaging facility")).toBe(true); // acknowledgment quote
    expect(matchesQuery(searchable, "Casey Sample")).toBe(true); // WCM byline scholar
    expect(matchesQuery(searchable, "Alex Testerson")).toBe(true); // core-staff co-author
    // the method chips at the card top, but NOT the extractor's quote behind them
    const chipped = row({
      methodTier: "weak",
      methodEvidence: [{ family: "Flow cytometry", tool: "FACSAria", sentence: "Sorted on a." }],
    });
    expect(matchesQuery(chipped, "flow cytometry")).toBe(true);
    expect(matchesQuery(chipped, "Sorted on a")).toBe(false);
    // ...and no chips are drawn on an untiered row, so its families are not
    // searched either — a hit there would be one a reviewer cannot see a reason for
    expect(matchesQuery(row({ ...chipped, methodTier: null }), "flow cytometry")).toBe(false);
  });

  it("narrows nothing on a blank query, and misses what the row doesn't carry", () => {
    expect(matchesQuery(searchable, "")).toBe(true);
    expect(matchesQuery(searchable, "   ")).toBe(true);
    expect(matchesQuery(searchable, "flow cytometry")).toBe(false);
  });

  it("does NOT search MeSH — the card no longer shows it, so a hit is unexplainable", () => {
    expect(matchesQuery(searchable, "Zebrafish")).toBe(false);
  });

  it("tolerates a row with every optional text field null", () => {
    const bare = row({
      journal: null,
      synopsis: null,
      authorsString: null,
      ackAlias: null,
      ackSnippet: null,
      wcmAuthors: [],
      coauthorScholars: [],
    });
    expect(matchesQuery(bare, "brain")).toBe(true); // still has a title
    expect(matchesQuery(bare, "NeuroImage")).toBe(false);
  });
});

describe("parsePmidBlock", () => {
  it("splits on newlines, commas, and spaces, and dedupes", () => {
    expect(parsePmidBlock("111, 222\n333 111").pmids).toEqual(["111", "222", "333"]);
  });

  it("separates malformed tokens into invalid, not pmids", () => {
    const { pmids, invalid } = parsePmidBlock("111, abc, 007, 222");
    expect(pmids).toEqual(["111", "222"]);
    expect(invalid).toEqual(["abc", "007"]); // leading zero is not a real PMID
  });

  it("never salvages digits out of a mixed token", () => {
    // A weaker parser that split on any non-digit run would silently turn
    // "abc123def" into PMID 123. A trust boundary does not guess.
    const { pmids, invalid } = parsePmidBlock("abc123def 456");
    expect(pmids).toEqual(["456"]);
    expect(invalid).toEqual(["abc123def"]);
  });

  it("returns empty arrays for blank input", () => {
    expect(parsePmidBlock("   \n  ")).toEqual({ pmids: [], invalid: [] });
  });
});

describe("likelihoodBand", () => {
  it("uses inclusive lower bounds at every boundary", () => {
    expect(likelihoodBand(1).label).toBe("Strong");
    expect(likelihoodBand(0.85).label).toBe("Strong");
    expect(likelihoodBand(0.8499).label).toBe("Moderate");
    expect(likelihoodBand(0.65).label).toBe("Moderate");
    expect(likelihoodBand(0.6499).label).toBe("Slight");
    expect(likelihoodBand(0.4).label).toBe("Slight");
    expect(likelihoodBand(0.3999).label).toBe("Weak");
    expect(likelihoodBand(0).label).toBe("Weak");
  });
});

describe("llmVerdict", () => {
  it("reads the dense triage score in words", () => {
    expect(llmVerdict(10)).toBe("reads as core work");
    expect(llmVerdict(8)).toBe("reads as core work");
    expect(llmVerdict(7)).toBe("possibly core work");
    expect(llmVerdict(6)).toBe("possibly core work");
    expect(llmVerdict(5)).toBe("little sign of core use");
    expect(llmVerdict(1)).toBe("little sign of core use");
  });
});

describe("evidenceTokens", () => {
  it("names each fired signal as a label/value pair", () => {
    expect(evidenceTokens(row())).toEqual([
      { label: "Acknowledged as", value: "“CBIC”" },
      { label: "Staff co-author", value: "Alex Testerson" },
      { label: "Repeat user", value: "42% of an author's own work" },
      { label: "LLM on title and abstract", value: "possibly core work" },
    ]);
  });

  it("adds a client-co-author token only for a byline author on the known-clients list", () => {
    expect(evidenceTokens(row(), new Set(["ccc1003"]))).toContainEqual({
      label: "Client co-author",
      value: "Casey Sample",
    });
    expect(evidenceTokens(row(), new Set(["nobody0001"]))).not.toContainEqual(
      expect.objectContaining({ label: "Client co-author" }),
    );
  });

  it("ALWAYS names the repeat user, even on a byline with several WCM authors", () => {
    // Round 2 reverses #2620's "name only a sole WCM author" rule. The name is
    // not a guess at whose scalar the engine published — it is the byline author
    // this core holds the most confirmed papers from, and the numbers printed
    // beside it are that same person's, so the two cannot disagree.
    const two = row({
      wcmAuthors: [
        { cwid: "ccc1003", name: "Casey Sample", slug: "casey-sample", dept: "Genomics" },
        { cwid: "ddd1004", name: "Dana Second", slug: "dana-second", dept: "Genomics" },
      ],
    });
    const counts = {
      ccc1003: { papers: 3, recent: 1, total: 40 },
      ddd1004: { papers: 8, recent: 2, total: 210 },
    };
    expect(evidenceTokens(two, new Set(), counts)).toContainEqual({
      label: "Repeat user",
      value: "Dana Second has used the core on 8 previous occasions (out of 210 publications).",
    });
  });

  it("is singular-safe at one occasion and one publication", () => {
    const counts = { ccc1003: { papers: 1, recent: 0, total: 1 } };
    expect(evidenceTokens(row(), new Set(), counts)).toContainEqual({
      label: "Repeat user",
      value: "Casey Sample has used the core on 1 previous occasion (out of 1 publication).",
    });
  });

  it("names nobody rather than inventing one when no byline author has a count", () => {
    // The engine flagged affinity but every candidate is past the 12-author cap
    // or new to this core. The honest reading is the engine's own unnamed rate.
    expect(evidenceTokens(row(), new Set(), {})).toContainEqual({
      label: "Repeat user",
      value: "42% of an author's own work",
    });
  });

  it("drops the repeat-user token when it is ABOUT the staff co-author already named", () => {
    // Same person, so the same evidence — "Staff co-author" already counts it.
    const same = row({
      wcmAuthors: [{ cwid: "aaa1001", name: "Alex Testerson", slug: "a", dept: "Radiology" }],
    });
    const counts = { aaa1001: { papers: 6, recent: 2, total: 30 } };
    expect(evidenceTokens(same, new Set(), counts)).not.toContainEqual(
      expect.objectContaining({ label: "Repeat user" }),
    );
    expect(evidenceTokens(same, new Set(), counts)).toContainEqual({
      label: "Staff co-author",
      value: "Alex Testerson",
    });
  });

  it("keeps the repeat-user token when it is about a DIFFERENT person from the staff co-author", () => {
    // Independent evidence: a second person with prior confirmed use is not the
    // co-author signal restated, and de-duplicating it would erase a real read.
    const counts = { ccc1003: { papers: 6, recent: 2, total: 30 } };
    expect(evidenceTokens(row(), new Set(), counts)).toContainEqual({
      label: "Repeat user",
      value: "Casey Sample has used the core on 6 previous occasions (out of 30 publications).",
    });
  });

  it("keeps that person even when the staff co-author OUTRANKS them on paper count", () => {
    // The de-dup EXCLUDES first and picks the maximum second. Picking first and
    // testing identity after is the same code with the steps swapped, and it
    // silently dropped the whole signal on the normal case: core staff hold more
    // of their own core's confirmed papers than anyone else on the byline, so the
    // maximum was a staff member on nearly every staff-co-authored row and the
    // second person's independent prior use went with them (item 6c forbids it).
    const outranked = row({
      signalAck: false,
      ackAlias: null,
      wcmAuthors: [
        { cwid: "aaa1001", name: "Alex Testerson", slug: "alex-testerson", dept: "Radiology" },
        { cwid: "bbb2028", name: "Blake Fixture", slug: "blake-fixture", dept: "Genomics" },
      ],
    });
    const counts = {
      aaa1001: { papers: 120, recent: 40, total: 300 },
      bbb2028: { papers: 18, recent: 11, total: 29 },
    };
    expect(evidenceTokens(outranked, new Set(), counts)).toContainEqual({
      label: "Repeat user",
      value: "Blake Fixture has used the core on 18 previous occasions (out of 29 publications).",
    });
    // ...and the count keeps it: co-author + LLM + repeat user, 3 of 4
    expect(buildSignals(outranked, counts).map((sig) => sig.kind)).toEqual([
      "coauthor",
      "llm",
      "affinity",
    ]);
  });

  it("drops the repeat-user token when the CLIENT co-author token already named that person", () => {
    // One person, one pile of 18 papers, printed twice: "Client co-author: Casey
    // Sample, 18 papers, 11 recent" and "Repeat user: Casey Sample has used the
    // core on 18 previous occasions". Item 6b says never twice, and the de-dup is
    // over every token that NAMES someone, not just the staff one.
    const clientOnly = row({ signalAck: false, ackAlias: null, coauthors: [], coauthorScholars: [] });
    const counts = { ccc1003: { papers: 18, recent: 11, total: 29 } };
    const clients = new Set(["ccc1003"]);
    expect(evidenceTokens(clientOnly, clients, counts)).toContainEqual({
      label: "Client co-author",
      value: "Casey Sample, 18 papers, 11 recent",
    });
    expect(evidenceTokens(clientOnly, clients, counts)).not.toContainEqual(
      expect.objectContaining({ label: "Repeat user" }),
    );
    // the rendered count falls with it, on the same rule as the staff case
    expect(buildSignals(clientOnly, counts, clients).map((sig) => sig.kind)).toEqual(["llm"]);
  });

  it("prints a person who is BOTH staff and a known client once — under Staff co-author", () => {
    // Item 6b, the last place it was not applied: the staff and client tokens
    // de-duplicated against the repeat-user line but never against each other, so
    // one person came out as "Staff co-author: Dana Both" AND "Client co-author:
    // Dana Both, 40 papers, 10 recent". Staff wins the collision — it is the
    // stronger read, the only one of the two that is a counted signal, and the
    // same way the byline chip already resolves a person who is both.
    const both = row({
      signalAck: false,
      ackAlias: null,
      coauthors: ["aaa1001"],
      coauthorScholars: [
        { cwid: "aaa1001", name: "Dana Both", slug: "dana-both", dept: "Radiology" },
      ],
      wcmAuthors: [
        { cwid: "aaa1001", name: "Dana Both", slug: "dana-both", dept: "Radiology" },
        { cwid: "ccc3003", name: "Cleo Client", slug: "cleo-client", dept: "Genomics" },
        { cwid: "bbb2002", name: "Rae Second", slug: "rae-second", dept: "Genomics" },
      ],
    });
    const counts = {
      aaa1001: { papers: 40, recent: 10, total: 100 },
      ccc3003: { papers: 7, recent: 2, total: 30 },
      bbb2002: { papers: 5, recent: 1, total: 20 },
    };
    const tokens = evidenceTokens(both, new Set(["aaa1001", "ccc3003"]), counts);
    expect(tokens).toContainEqual({ label: "Staff co-author", value: "Dana Both" });
    // The OTHER client is untouched — the de-dup is per person, so the token
    // survives naming only her, and goes singular with her.
    expect(tokens).toContainEqual({
      label: "Client co-author",
      value: "Cleo Client, 7 papers, 2 recent",
    });
    expect(JSON.stringify(tokens)).not.toContain("Dana Both, 40 papers");
    // ...and a THIRD person's independent prior use still survives both (6c).
    expect(tokens).toContainEqual({
      label: "Repeat user",
      value: "Rae Second has used the core on 5 previous occasions (out of 20 publications).",
    });
  });

  it("keeps the client token for a both-flavour person the staff token does NOT name", () => {
    // "Staff wins" only wins where staff SPEAKS. The collapsed token names
    // `coauthorScholars[0]` and nobody else, so suppressing EVERY staff CWID
    // deleted the second one: Dana Both, a roster client on this byline with 40
    // confirmed papers, was named nowhere in the strip and her count went with
    // her. The suppression is now exactly the one person the token prints — the
    // test above, where she IS first-listed, still suppresses her.
    const both = row({
      signalAck: false,
      ackAlias: null,
      coauthors: ["zzz9999", "aaa1001"],
      coauthorScholars: [
        { cwid: "zzz9999", name: "Zed Ninety", slug: "zed-ninety", dept: "Radiology" },
        { cwid: "aaa1001", name: "Dana Both", slug: "dana-both", dept: "Radiology" },
      ],
      wcmAuthors: [
        { cwid: "aaa1001", name: "Dana Both", slug: "dana-both", dept: "Radiology" },
        { cwid: "bbb2002", name: "Rae Second", slug: "rae-second", dept: "Genomics" },
      ],
    });
    const counts = {
      aaa1001: { papers: 40, recent: 10, total: 60 },
      bbb2002: { papers: 5, recent: 1, total: 20 },
    };
    const tokens = evidenceTokens(both, new Set(["aaa1001"]), counts);
    expect(tokens).toContainEqual({ label: "Staff co-author", value: "Zed Ninety" });
    expect(tokens).toContainEqual({
      label: "Client co-author",
      value: "Dana Both, 40 papers, 10 recent",
    });
    // The repeat-user line is a different question — "does this card name them
    // ANYWHERE", including the expanded co-author list — so it still de-duplicates
    // against every staff CWID, and a third person's own prior use survives (6c).
    expect(tokens).toContainEqual({
      label: "Repeat user",
      value: "Rae Second has used the core on 5 previous occasions (out of 20 publications).",
    });
  });

  it("prints a curated collision suffix on NEITHER the client nor the repeat-user token", () => {
    // The suffix IS a department, so leaving it on printed the department twice:
    // "Alessandro Fichera - Surgery, 18 papers". Both tokens go through
    // `displayName`, like the byline label and the person card.
    const fichera = {
      cwid: "afi1007",
      name: "Alessandro Fichera - Surgery",
      slug: "alessandro-fichera",
      dept: "Surgery",
    };
    const counts = { afi1007: { papers: 18, recent: 11, total: 29 } };
    const asClient = row({ coauthors: [], coauthorScholars: [], wcmAuthors: [fichera] });
    expect(evidenceTokens(asClient, new Set(["afi1007"]), counts)).toContainEqual({
      label: "Client co-author",
      value: "Alessandro Fichera, 18 papers, 11 recent",
    });
    expect(evidenceTokens(asClient, new Set(), counts)).toContainEqual({
      label: "Repeat user",
      value:
        "Alessandro Fichera has used the core on 18 previous occasions (out of 29 publications).",
    });
  });

  it("carries the paper counts this core already holds from a named client", () => {
    const counts = { ccc1003: { papers: 18, recent: 11, total: 29 } };
    expect(evidenceTokens(row(), new Set(["ccc1003"]), counts)).toContainEqual({
      label: "Client co-author",
      value: "Casey Sample, 18 papers, 11 recent",
    });
  });

  it("drops a zero count rather than printing '0 papers'", () => {
    const counts = { ccc1003: { papers: 0, recent: 0, total: 4 } };
    expect(evidenceTokens(row(), new Set(["ccc1003"]), counts)).toContainEqual({
      label: "Client co-author",
      value: "Casey Sample",
    });
  });

  it("omits the recent clause when nothing recent, and is singular-safe at one paper", () => {
    const counts = { ccc1003: { papers: 1, recent: 0, total: 1 } };
    expect(evidenceTokens(row(), new Set(["ccc1003"]), counts)).toContainEqual({
      label: "Client co-author",
      value: "Casey Sample, 1 paper",
    });
  });

  it("returns nothing when no signal fired", () => {
    expect(
      evidenceTokens(
        row({
          signalAck: false,
          ackAlias: null,
          coauthors: [],
          coauthorScholars: [],
          llmScore: null,
          authorAffinity: null,
        }),
      ),
    ).toEqual([]);
  });

  it("carries the method-family TIER, never a bare boolean", () => {
    for (const tier of ["strong", "moderate", "weak"]) {
      expect(evidenceTokens(row({ methodTier: tier }))).toContainEqual({
        label: "Method family",
        value: tier,
      });
    }
  });

  it("emits no method token when the engine found no family", () => {
    expect(evidenceTokens(row({ methodTier: null }))).not.toContainEqual(
      expect.objectContaining({ label: "Method family" }),
    );
  });

  it("does NOT make method a counted signal — SIGNAL_COUNT stays 4", () => {
    // The owner decision: method is an uncounted chip. A tier must never change
    // the "N of 4 signals" line, because it is weighted 0.00 in the engine.
    expect(buildSignals(row({ methodTier: "strong" }))).toEqual(buildSignals(row()));
  });
});

describe("evidenceGroupKey / evidenceGroupLabel / bandRange", () => {
  it("keys a row by which evidence kinds fired, prior excluded", () => {
    expect(evidenceGroupKey(row())).toBe("ack+coauthor+llm+affinity");
    // the prefilter prior is no longer a signal at all, so it never splits a pile
    expect(evidenceGroupKey(row({ topicalPrior: 0.6 }))).toBe("ack+coauthor+llm+affinity");
    expect(
      evidenceGroupKey(
        row({
          signalAck: false,
          ackAlias: null,
          coauthors: [],
          coauthorScholars: [],
          llmScore: null,
          authorAffinity: null,
        }),
      ),
    ).toBe("none");
  });

  it("speaks the group vocabulary, singular-safe", () => {
    expect(evidenceGroupLabel("ack", 1)).toBe("1 paper · acknowledgment");
    expect(evidenceGroupLabel("ack", 3)).toBe("3 papers · acknowledgment");
    expect(evidenceGroupLabel("coauthor", 2)).toBe("2 papers · staff co-author");
    expect(evidenceGroupLabel("llm", 2)).toBe("2 papers · LLM read");
    expect(evidenceGroupLabel("affinity", 2)).toBe("2 papers · repeat user");
    // "no counted signal", not "no labelled signal": a method-only row lands in
    // this group and DOES carry a label the card draws.
    expect(evidenceGroupLabel("none", 2)).toBe("2 papers · no counted signal");
    expect(evidenceGroupLabel("ack+coauthor", 2)).toBe("2 papers · acknowledgment + staff co-author");
  });

  it("gives the group's range in band words, never a likelihood percentage", () => {
    expect(bandRange([0.52, 0.94])).toBe("Slight to Strong");
    expect(bandRange([0.9, 0.95])).toBe("Strong");
    expect(bandRange([0.9])).toBe(""); // a single row already shows its own band
    expect(bandRange([])).toBe("");
  });
});

describe("buildSignals", () => {
  it("returns only fired signals, scored and ordered strongest-first", () => {
    const signals = buildSignals(row()); // four fire; topicalPrior defaults to null
    expect(signals.map((s) => s.kind)).toEqual(["ack", "coauthor", "llm", "affinity"]);
    expect(signals[0]).toMatchObject({ kind: "ack", dots: 4, strength: "Direct" });
    expect(signals.at(-1)).toMatchObject({ kind: "affinity", dots: 1, strength: "Weak" });
  });

  it("counts NO signal for the prefilter prior, whatever it reads", () => {
    // Demoted to a footnote in round 2, so no value of it can move the count.
    for (const topicalPrior of [null, 0, 0.4, 0.6, 0.76]) {
      expect(buildSignals(row({ topicalPrior })).map((s) => s.kind)).toEqual([
        "ack",
        "coauthor",
        "llm",
        "affinity",
      ]);
    }
  });

  it("drops the repeat-user signal — and the COUNT — when it is about the staff co-author", () => {
    // Per-person de-dup: the owner decided the rendered count DOES fall, because
    // showing one person's involvement twice is what makes 4-of-4 a lie.
    const same = row({
      wcmAuthors: [{ cwid: "aaa1001", name: "Alex Testerson", slug: "a", dept: "Radiology" }],
    });
    const counts = { aaa1001: { papers: 6, recent: 2, total: 30 } };
    expect(buildSignals(same, counts).map((s) => s.kind)).toEqual(["ack", "coauthor", "llm"]);
    // ...and a DIFFERENT person is independent evidence that has to survive
    const counts2 = { ccc1003: { papers: 6, recent: 2, total: 30 } };
    expect(buildSignals(row(), counts2).map((s) => s.kind)).toEqual([
      "ack",
      "coauthor",
      "llm",
      "affinity",
    ]);
  });

  it("de-duplicates nothing when it has no counts to name anybody with", () => {
    // Dropping a signal on a guess is worse than counting it twice.
    const same = row({
      wcmAuthors: [{ cwid: "aaa1001", name: "Alex Testerson", slug: "a", dept: "Radiology" }],
    });
    expect(buildSignals(same).map((s) => s.kind)).toContain("affinity");
  });

  it("omits a signal that did not fire", () => {
    const signals = buildSignals(
      row({ authorAffinity: null, coauthors: [], signalAck: false, ackAlias: null }),
    );
    expect(signals.map((s) => s.kind)).toEqual(["llm"]); // only the LLM score survives
  });

  it("fixes strength by signal type, not by the model's score", () => {
    const onlyLlm = (score: number) =>
      buildSignals(
        row({ llmScore: score, coauthors: [], signalAck: false, ackAlias: null, authorAffinity: null }),
      )[0];
    // LLM is Moderate (2) whether the model said 2 or 10
    expect(onlyLlm(2)).toMatchObject({ kind: "llm", dots: 2, strength: "Moderate" });
    expect(onlyLlm(10)).toMatchObject({ kind: "llm", dots: 2, strength: "Moderate" });
    // ack is Direct (4) even with no matched alias
    const [ack] = buildSignals(
      row({ ackAlias: null, signalAck: true, coauthors: [], llmScore: null, authorAffinity: null }),
    );
    expect(ack).toMatchObject({ kind: "ack", dots: 4, strength: "Direct" });
  });
});

describe("decodeTopicalPrior", () => {
  // prefilter_prior = noisy-OR(author 0.6, mesh 0.4) -> exactly four reachable values.
  it("decodes each of the four reachable values", () => {
    expect(decodeTopicalPrior(0.76)).toEqual({ mesh: true, affinity: true });
    expect(decodeTopicalPrior(0.6)).toEqual({ mesh: false, affinity: true });
    expect(decodeTopicalPrior(0.4)).toEqual({ mesh: true, affinity: false });
    expect(decodeTopicalPrior(0)).toEqual({ mesh: false, affinity: false });
  });

  it("does not claim a MeSH match on an author-only prior", () => {
    // The whole point: 7,332 of 9,352 live chips were 0.60 and every one of them
    // rendered "carries a MeSH descriptor". Core 14's MeSH membership is zero, so
    // every row of its backfill lands here.
    expect(decodeTopicalPrior(0.6).mesh).toBe(false);
  });
});

describe("repeatUser", () => {
  const A = { cwid: "ccc1003", name: "Casey Sample", slug: "casey-sample", dept: "Genomics" };
  const B = { cwid: "ddd1004", name: "Dana Second", slug: "dana-second", dept: "Genomics" };

  it("names the byline author this core holds the MOST confirmed papers from", () => {
    // Not the first author, and not whoever the engine's scalar was about — the
    // derivation is what makes the name and the number one fact.
    const two = row({ wcmAuthors: [A, B] });
    const counts = {
      ccc1003: { papers: 3, recent: 1, total: 40 },
      ddd1004: { papers: 8, recent: 2, total: 210 },
    };
    expect(repeatUser(two, counts)?.scholar.name).toBe("Dana Second");
    expect(repeatUser(two, counts)?.counts.papers).toBe(8);
  });

  it("breaks a tie on byline order, so the choice is deterministic", () => {
    const two = row({ wcmAuthors: [A, B] });
    const tied = {
      ccc1003: { papers: 5, recent: 0, total: 9 },
      ddd1004: { papers: 5, recent: 0, total: 60 },
    };
    expect(repeatUser(two, tied)?.scholar.name).toBe("Casey Sample");
  });

  it("names nobody when the engine flagged no affinity, or when no one has a count", () => {
    expect(
      repeatUser(row({ authorAffinity: null }), { ccc1003: { papers: 3, recent: 0, total: 4 } }),
    ).toBeNull();
    expect(repeatUser(row(), {})).toBeNull();
  });

  it("excludes everyone another token already names BEFORE taking the maximum", () => {
    // The staff co-author holds the most papers, so the maximum over EVERYONE is
    // him — and testing his identity afterwards returned null for the whole row.
    // Excluding first leaves the one person the card can still honestly name.
    const STAFF = { cwid: "aaa1001", name: "Alex Testerson", slug: "alex-testerson", dept: "Radiology" };
    const withStaff = row({ wcmAuthors: [STAFF, B] }); // row()'s coauthors is ["aaa1001"]
    const counts = {
      aaa1001: { papers: 120, recent: 40, total: 300 },
      ddd1004: { papers: 8, recent: 2, total: 210 },
    };
    expect(repeatUser(withStaff, counts)?.scholar.name).toBe("Dana Second");
    // a known client is excluded on exactly the same footing as core staff
    const withClient = row({ coauthors: [], coauthorScholars: [], wcmAuthors: [A, B] });
    const clientLeads = {
      ccc1003: { papers: 120, recent: 40, total: 300 },
      ddd1004: { papers: 8, recent: 2, total: 210 },
    };
    expect(repeatUser(withClient, clientLeads, new Set(["ccc1003"]))?.scholar.name).toBe(
      "Dana Second",
    );
  });
});

describe("priorFootnote", () => {
  it("carries the owner's copy on the common author-only prior", () => {
    expect(priorFootnote(0.6, true)).toBe(
      "No evidence found: the topical prior (60%) has no mapped MeSH branch for this core, so it only restates the repeat-user number.",
    );
  });

  it("never says 'no mapped MeSH branch' on a prior where MeSH DID fire", () => {
    // Same discipline as decodeTopicalPrior: the footnote asserts a MeSH fact of
    // its own, so it must decode rather than assume the common case.
    expect(priorFootnote(0.4, true)).not.toContain("no mapped MeSH branch");
    expect(priorFootnote(0.4, true)).toContain("is a MeSH-branch match");
    expect(priorFootnote(0.76, true)).not.toContain("no mapped MeSH branch");
    expect(priorFootnote(0.76, true)).toContain("blends a MeSH-branch match");
  });

  it("stops pointing at a repeat-user row the card is not showing", () => {
    // Same discipline again, one surface further out: both affinity sentences
    // name a row ("it only restates the repeat-user number"), and per-person
    // de-duplication can take that row off the card. The claim has to follow.
    expect(priorFootnote(0.6, false)).not.toContain("repeat-user");
    expect(priorFootnote(0.6, false)).toContain("no mapped MeSH branch");
    expect(priorFootnote(0.76, false)).not.toContain("restates");
    // the MeSH-only sentence never mentioned the repeat user, so it does not move
    expect(priorFootnote(0.4, false)).toBe(priorFootnote(0.4, true));
  });

  it("footnotes nothing at a prior of 0 or absent — that is no evidence, not weak evidence", () => {
    expect(priorFootnote(0, true)).toBeNull();
    expect(priorFootnote(null, true)).toBeNull();
  });
});

describe("matchesFilters", () => {
  const acked = row({ signalAck: true, ackAlias: "CBIC", coauthors: [], llmScore: null });
  const llmOnly = row({ signalAck: false, ackAlias: null, coauthors: [], llmScore: 4 });
  const both = row({ signalAck: true, ackAlias: "CBIC", llmScore: 4 });
  const set = (...keys: FilterKey[]) => new Set<FilterKey>(keys);

  it("keeps everything when nothing is ticked (the empty set is 'All')", () => {
    expect(matchesFilters(acked, set())).toBe(true);
    expect(matchesFilters(llmOnly, set())).toBe(true);
  });

  it("ANDs the ticked keys — every one of them has to match", () => {
    expect(matchesFilters(both, set("ack", "llm"))).toBe(true);
    expect(matchesFilters(acked, set("ack", "llm"))).toBe(false); // no LLM score
    expect(matchesFilters(llmOnly, set("ack", "llm"))).toBe(false); // not acknowledged
  });

  it("excludes a row that matches none of the ticked keys", () => {
    expect(matchesFilters(acked, set("coauthored"))).toBe(false);
  });

  it("matches the client facet only against the passed known-clients set", () => {
    expect(matchesFilters(row(), set("client"), new Set(["ccc1003"]))).toBe(true);
    expect(matchesFilters(row(), set("client"), new Set(["nobody0001"]))).toBe(false);
    expect(matchesFilters(row(), set("client"))).toBe(false);
  });

  it("matches the no-prior facet on a null affinity", () => {
    expect(matchesFilters(row({ authorAffinity: null }), set("noprior"))).toBe(true);
    expect(matchesFilters(row({ authorAffinity: 0.1 }), set("noprior"))).toBe(false);
  });

  it("scopes the method facet to strong+moderate — weak inverts below background", () => {
    expect(matchesFilters(row({ methodTier: "strong" }), set("method"))).toBe(true);
    expect(matchesFilters(row({ methodTier: "moderate" }), set("method"))).toBe(true);
    expect(matchesFilters(row({ methodTier: "weak" }), set("method"))).toBe(false);
    expect(matchesFilters(row({ methodTier: null }), set("method"))).toBe(false);
  });
});

describe("compareBySort", () => {
  it("strongest: a 4-dot direct ack outranks a higher-likelihood weak prior", () => {
    const direct = row({
      likelihood: 0.6,
      ackAlias: "CBIC",
      signalAck: true,
      coauthors: [],
      llmScore: null,
      authorAffinity: null,
    });
    const weak = row({
      likelihood: 0.95,
      ackAlias: null,
      signalAck: false,
      coauthors: [],
      llmScore: null,
      authorAffinity: 0.3,
    });
    expect(compareBySort("strongest", direct, weak)).toBeLessThan(0);
  });

  it("uncertain: a coin-flip outranks a near-certain row", () => {
    const sure = row({ likelihood: 0.98 });
    const flip = row({ likelihood: 0.51 });
    expect(compareBySort("uncertain", flip, sure)).toBeLessThan(0);
  });

  it("year: the newer paper comes first, ties broken by likelihood", () => {
    expect(compareBySort("year", row({ year: 2026 }), row({ year: 2019 }))).toBeLessThan(0);
    expect(
      compareBySort("year", row({ year: 2024, likelihood: 0.9 }), row({ year: 2024, likelihood: 0.3 })),
    ).toBeLessThan(0);
  });

  it("cites: the more-cited paper comes first", () => {
    expect(compareBySort("cites", row({ citationCount: 90 }), row({ citationCount: 2 }))).toBeLessThan(
      0,
    );
  });
});

// The toolbar's core-staff lock chip. `core.staffCount` is how many core staff
// ReciterAI's facility dictionary LISTS; `core.staffTrackedCount` is how many
// of those the co-author signal can actually MATCH, landed on
// `core.staff_count` / `core.staff_tracked_count` by etl/dynamodb Block 6b.
//
// The four states are NOT interchangeable, and the reason the tracked count
// exists at all is that the chip must never claim the signal draws on staff it
// cannot match: on the live dictionary the two counts differ on 9 of 14 cores,
// core 14 (the one in the owner's mockup) lists 4 and tracks 1, and cores 8, 10
// and 13 list staff while tracking none.
describe("CoreClaimQueue — core-staff lock chip", () => {
  const chip = () => document.querySelector('[data-slot="core-staff-chip"]');
  const chipText = () => (chip()?.textContent ?? "").replace(/\s+/g, " ").trim();

  it("renders the mockup's sentence as 'M of N', and EMPHASISES that fraction", () => {
    // Core 14's live shape. The pre-revision chip said "draws on 4 core staff"
    // here, which was false: the signal can match exactly one of the four.
    render(
      <CoreClaimQueue
        core={{ ...CORE, staffCount: 4, staffTrackedCount: 1 }}
        candidates={[row()]}
        confirmed={[]}
      />,
    );
    expect(chipText()).toBe(
      "Co-author signal draws on 1 of 4 core staff from the facility dictionary",
    );
    // the mockup bolds the number; the number here is the fraction, not the
    // listed count alone — bolding "4" would re-tell the lie in bold.
    const bolded = chip()?.querySelector(".font-semibold");
    expect((bolded?.textContent ?? "").replace(/\s+/g, " ").trim()).toBe("1 of 4");
  });

  it("still says 'M of N' when every listed staff member is tracked", () => {
    // Core 1 on the live dictionary: 4 listed, 4 tracked. The fraction stays —
    // a bare "4" would make the reader guess which of the two numbers it is.
    render(
      <CoreClaimQueue
        core={{ ...CORE, staffCount: 4, staffTrackedCount: 4 }}
        candidates={[row()]}
        confirmed={[]}
      />,
    );
    expect(chipText()).toBe(
      "Co-author signal draws on 4 of 4 core staff from the facility dictionary",
    );
  });

  it("renders NOTHING when the counts are null — not-yet-published must look like nothing", () => {
    // CORE's own counts are null: this is the pre-chip rendering, unchanged.
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(chip()).toBeNull();
    expect(screen.queryByText(/core staff/)).toBeNull();
    expect(screen.queryByText(/facility dictionary/)).toBeNull();
  });

  it("renders NOTHING for a half-known row (listed known, tracked null)", () => {
    // The ETL writes the pair together or not at all, so this row should not
    // exist — and if one ever does, silence beats guessing: the chip can
    // neither claim the signal draws on 4 nor claim it cannot fire.
    render(
      <CoreClaimQueue
        core={{ ...CORE, staffCount: 4, staffTrackedCount: null }}
        candidates={[row()]}
        confirmed={[]}
      />,
    );
    expect(chip()).toBeNull();
    expect(screen.queryByText(/draws on/)).toBeNull();
  });

  it("says the signal cannot fire when the dictionary LISTS none — never 'draws on 0'", () => {
    // Cores 4, 6 and 7 on the live dictionary. The most useful thing a reviewer
    // can learn here: every candidate they see is carried by the other four
    // signals.
    render(
      <CoreClaimQueue
        core={{ ...CORE, staffCount: 0, staffTrackedCount: 0 }}
        candidates={[row()]}
        confirmed={[]}
      />,
    );
    expect(chipText()).toBe(
      "The facility dictionary lists no core staff, so the co-author signal cannot fire for this core.",
    );
    expect(chipText()).not.toContain("draws on");
  });

  it("says the signal cannot fire when staff are LISTED but none are tracked", () => {
    // Cores 8 (3 listed), 10 (2) and 13 (1). This is the state the single-count
    // chip got most wrong — it would have claimed "draws on 3 core staff" for a
    // core where the co-author signal cannot contribute anything at all.
    render(
      <CoreClaimQueue
        core={{ ...CORE, staffCount: 3, staffTrackedCount: 0 }}
        candidates={[row()]}
        confirmed={[]}
      />,
    );
    expect(chipText()).toBe(
      "The facility dictionary lists 3 core staff, but none are resolvable, so the co-author signal cannot fire for this core.",
    );
    expect(chipText()).not.toContain("draws on");
  });

  it("never renders a bare listed count as the number the signal draws on", () => {
    // The single property this whole revision exists for, swept over the 8
    // DISTINCT listed/tracked pairs that the 9 diverging live cores produce.
    // 8, not 9, because core 11's 3/2 repeats core 3's, and the chip is a pure
    // function of the pair — a ninth row would re-run an identical case, not
    // cover another one. The other 5 cores agree: core 1 at 4/4, core 12 at
    // 1/1, and cores 4, 6 and 7 at 0/0. The named cases above pin 4/4 and 0/0,
    // and 1/1 takes the same branch as 4/4.
    for (const [staffCount, staffTrackedCount] of [
      [7, 4], // core 2
      [3, 2], // cores 3 and 11
      [5, 2], // core 5
      [3, 0], // core 8
      [2, 1], // core 9
      [2, 0], // core 10
      [1, 0], // core 13
      [4, 1], // core 14 — the owner's mockup
    ]) {
      const view = render(
        <CoreClaimQueue
          core={{ ...CORE, staffCount, staffTrackedCount }}
          candidates={[row()]}
          confirmed={[]}
        />,
      );
      expect(chipText()).not.toContain(`draws on ${staffCount} core staff`);
      if (staffTrackedCount > 0) {
        expect(chipText()).toContain(`draws on ${staffTrackedCount} of ${staffCount} core staff`);
      } else {
        expect(chipText()).toContain("cannot fire");
      }
      view.unmount();
    }
  });

  it("keeps the chip and the button group in the same toolbar row, chip first", () => {
    render(
      <CoreClaimQueue
        core={{ ...CORE, staffCount: 4, staffTrackedCount: 1 }}
        candidates={[row()]}
        confirmed={[]}
      />,
    );
    const toolbar = document.querySelector('[data-slot="core-queue-toolbar"]');
    const knownClients = screen.getByRole("button", { name: /Known clients/ });
    expect(toolbar?.contains(chip()!)).toBe(true);
    expect(toolbar?.contains(knownClients)).toBe(true);
    expect(
      chip()!.compareDocumentPosition(knownClients) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // wraps rather than overflowing on a narrow viewport
    expect(toolbar?.className).toContain("flex-wrap");
  });

  it("offers NO 'Manage staff' control, in any state — there is no destination", () => {
    // The mockup draws one. The roster lives in the facility dictionary, not in
    // SPS, and this toolbar already carries one knowingly-inert control
    // ("Reporting..."); a second would make dead controls the pattern.
    for (const [staffCount, staffTrackedCount] of [
      [null, null],
      [0, 0],
      [3, 0],
      [4, 1],
    ] as Array<[number | null, number | null]>) {
      const view = render(
        <CoreClaimQueue
          core={{ ...CORE, staffCount, staffTrackedCount }}
          candidates={[row()]}
          confirmed={[]}
        />,
      );
      expect(screen.queryByRole("button", { name: /Manage staff/i })).toBeNull();
      expect(screen.queryByRole("link", { name: /Manage staff/i })).toBeNull();
      expect(screen.queryByText(/Manage staff/i)).toBeNull();
      view.unmount();
    }
  });
});

// "Known clients" panel (ReciterAI #383 / SPS #2607) — the panel's own
// behavior is covered by tests/unit/core-clients-panel.test.tsx; this just
// confirms CoreClaimQueue wires the toolbar button in with the right count.
// The method-family surfaces, RENDERED. The pure helpers (evidenceTokens,
// matchesFilter) are covered above, but a helper can be correct while nothing
// calls it: deleting the FILTERS pill, or filtering the token out of the strip,
// leaves every pure-function test green. These are the tests that fail when
// either surface is disconnected.
//
// Both assertions read the CARD, never document.body — the facet pill's own
// label contains the words "Method family", so a body-wide match would pass
// with the card rendering nothing at all.
describe("CoreClaimQueue — method family, on screen", () => {
  /** The collapsed evidence strip of the only open card, as text. */
  const cardStrip = () =>
    (screen.getByRole("button", { expanded: false }).textContent ?? "").replace(/\s+/g, " ");

  it("paints the tier IN THE CARD, and leaves the 'N of 4 signals' line alone", () => {
    const { unmount } = render(
      <CoreClaimQueue core={CORE} candidates={[row({ methodTier: "strong" })]} confirmed={[]} />,
    );
    expect(cardStrip()).toContain("Method family");
    expect(cardStrip()).toContain("strong");
    const withTier = screen.getByText(/of 4 signals/).textContent;
    unmount();

    render(<CoreClaimQueue core={CORE} candidates={[row({ methodTier: null })]} confirmed={[]} />);
    expect(cardStrip()).not.toContain("Method family");
    // Same row, no tier: the counted-signal line must be byte-identical.
    expect(screen.getByText(/of 4 signals/).textContent).toBe(withTier);
  });

  it("offers the facet as a pill, and ticking it drops the weak and untiered rows", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", methodTier: "strong" }),
          row({ pmid: "2", methodTier: "moderate" }),
          row({ pmid: "3", methodTier: "weak" }),
          row({ pmid: "4", methodTier: null }),
        ]}
        confirmed={[]}
      />,
    );
    fireEvent.click(screen.getByText(/Method family \(strong\/moderate\)/));
    // 2 of the 4 survive — weak and null are excluded on purpose: weak families
    // invert to below background, so a facet returning them would narrow the
    // queue towards the rows the signal argues against.
    expect(screen.getByText(/Showing 2 of 4/)).toBeTruthy();
  });

  it("searches the token a reviewer can SEE — both 'method' and the tier word", () => {
    // searchBlob's rule is "search only what the card puts on screen", and the
    // placeholder promises "method". Both halves of the rendered token match.
    expect(searchBlob(row({ methodTier: "strong" }))).toContain("method family strong");
    expect(matchesQuery(row({ methodTier: "strong" }), "method")).toBe(true);
    expect(matchesQuery(row({ methodTier: "strong" }), "strong")).toBe(true);
    expect(matchesQuery(row({ methodTier: null }), "method")).toBe(false);
  });
});

// The byline, RENDERED. `authors_string` marks WCM authors with `((…))`, and the
// card was printing that markup raw on 70.4% of core 14's live queue while the
// truncated preview silently dropped authors on 68.4% of it.
describe("CoreClaimQueue — byline markers and the dropped-author suffix", () => {
  const byline = (over: Partial<CoreQueueRow>) => {
    render(<CoreClaimQueue core={CORE} candidates={[row(over)]} confirmed={[]} />);
    const el = document.querySelector('[data-slot="core-queue-byline"]');
    return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  };

  it("never prints the `((…))` WCM marker on screen", () => {
    const text = byline({
      authorsString: "Madden K, Andy C, Sholle ET, Gerber LM, ((Traube C))",
      fullAuthorsString: "Madden K, Andy C, Sholle ET, Gerber LM, Traube C",
      coauthorScholars: [],
      coauthors: [],
    });
    expect(text).not.toContain("((");
    expect(text).not.toContain("))");
    expect(text).toContain("Traube C");
  });

  it("says how many authors the truncated preview dropped", () => {
    const text = byline({
      authorsString: "Testerson A, Fixture B",
      fullAuthorsString: "Testerson A, Fixture B, Sample C, Fourth D",
      coauthorScholars: [],
      coauthors: [],
    });
    expect(text).toContain(", +2 more");
  });

  it("adds no suffix when the preview is the whole byline", () => {
    const text = byline({
      authorsString: "Testerson A, Fixture B",
      fullAuthorsString: "Testerson A, Fixture B",
      coauthorScholars: [],
      coauthors: [],
    });
    expect(text).not.toContain("more");
  });

  it("highlights a core-staff author the marker used to hide", () => {
    // The lead token of "((Traube C))" is "((traube", so the surname match could
    // never fire — for exactly the authors the marker exists to mark.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({
            authorsString: "Madden K, ((Testerson A))",
            fullAuthorsString: "Madden K, Testerson A",
          }),
        ]}
        confirmed={[]}
      />,
    );
    const link = screen.getByRole("link", { name: /Alex Testerson/ });
    expect(link.getAttribute("href")).toBe("/alex-testerson");
  });
});

// The Confirmed tab. A confirmation is not final -- the engine re-scores nightly,
// so a row confirmed months ago may be one the evidence no longer supports. The
// list used to show title/year/PMID and a Revoke button, and nothing to judge on.
describe("CoreClaimQueue — Confirmed rows carry the score", () => {
  const ev = () => document.querySelector('[data-slot="core-queue-confirmed-evidence"]');

  it("shows the band, the signal count and the evidence on a confirmed row", () => {
    render(
      <CoreClaimQueue core={CORE} candidates={[]} confirmed={[row({ likelihood: 0.91 })]} />,
    );
    fireEvent.click(within(screen.getByRole("group", { name: "Queue view" })).getByText(/Confirmed/));
    const text = (ev()?.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Strong 91%");
    expect(text).toContain(`of ${4} signals`);
    expect(text).toContain("Acknowledged as");
  });

  it("takes a confirmed row's OWN paper out of its 'previous occasions'", () => {
    // `loadCoreClientPaperCounts` counts over queue.confirmed, and this list IS
    // queue.confirmed, so the paper on screen was inside its own evidence line:
    // 18 read as 18 previous occasions when the truth is 17, out of 28 not 29.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ year: 2026 })]}
        paperCounts={{ ccc1003: { papers: 18, recent: 11, total: 29 } }}
      />,
    );
    fireEvent.click(within(screen.getByRole("group", { name: "Queue view" })).getByText(/Confirmed/));
    const text = (ev()?.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain(
      "Casey Sample has used the core on 17 previous occasions (out of 28 publications).",
    );
    expect(text).not.toContain("18 previous occasions");
  });

  it("says nothing at all rather than '0 previous occasions' on a person's only paper", () => {
    // The 247 people on staging core 14 with exactly one confirmed paper: it is
    // this one, so there is no PREVIOUS occasion — not a weak claim, no claim.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ year: 2026 })]}
        paperCounts={{ ccc1003: { papers: 1, recent: 1, total: 1 } }}
      />,
    );
    fireEvent.click(within(screen.getByRole("group", { name: "Queue view" })).getByText(/Confirmed/));
    const text = (ev()?.textContent ?? "").replace(/\s+/g, " ");
    expect(text).not.toContain("previous occasion");
    // ...and it does NOT fall through to the unnamed fallback either. This
    // assertion is REVERSED from round 3, which read the zero as "nobody on this
    // byline qualifies" and printed the engine's rate underneath it. The zero
    // does not mean that: it means this core holds exactly one paper from her and
    // it is the one on screen, so the row would be counting itself as its own
    // prior evidence — and "N of 4" rising on the one tab that subtracts. Casey
    // Sample is a PLAIN author here (not staff, not on the clients roster), which
    // is the half of the rule "already named by another token" never covered.
    expect(text).not.toContain("of an author's own work");
    expect(text).toContain("3 of 4 signals");
  });

  // The pair below is the ONE distinction the own-paper subtraction has to keep:
  // "this person's adjusted count is 0, so there is nothing FURTHER to add about
  // somebody already named" is not the state "nobody on this byline qualifies".
  // Collapsing the two (by deleting the zeroed key instead of keeping it) fired
  // the unnamed fallback directly underneath the token that had just named the
  // person — their prior use restated, and the counted total going UP on the one
  // tab that subtracts. Both cases below are single-WCM-author confirmed rows
  // whose sole author holds exactly this paper, which is the shape the subtraction
  // zeroes; strip the `paperCounts` prop and neither can fail.
  const onlyOnce = { cwid: "cli5005", name: "Only Once", slug: "only-once", dept: "Genomics" };
  const soleAuthorRow = (over: Partial<CoreQueueRow> = {}) =>
    row({
      signalAck: false,
      ackAlias: null,
      coauthors: [],
      coauthorScholars: [],
      wcmAuthors: [onlyOnce],
      year: 2021,
      ...over,
    });
  const openConfirmed = () =>
    fireEvent.click(
      within(screen.getByRole("group", { name: "Queue view" })).getByText(/Confirmed/),
    );

  it("does not restate a CLIENT co-author's prior use when the row IS their only paper", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[soleAuthorRow()]}
        clients={[
          {
            id: "client-cli5005",
            cwid: "cli5005",
            name: "Only Once",
            slug: "only-once",
            affiliation: null,
            addedByName: null,
            addedAt: new Date("2026-01-01"),
            addedBy: "aaa1001",
          },
        ]}
        paperCounts={{ cli5005: { papers: 1, recent: 1, total: 4 } }}
      />,
    );
    openConfirmed();
    const text = (ev()?.textContent ?? "").replace(/\s+/g, " ");
    // The client token names her, so the repeat-user line has nothing to add —
    // and the count is the LLM read alone.
    expect(text).toContain("Client co-author");
    expect(text).toContain("Only Once");
    expect(text).not.toContain("Repeat user");
    expect(text).not.toContain("of an author's own work");
    expect(text).toContain("1 of 4 signals");
  });

  it("does not restate a STAFF co-author's prior use when the row IS their only paper", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[soleAuthorRow({ coauthors: ["cli5005"], coauthorScholars: [onlyOnce] })]}
        paperCounts={{ cli5005: { papers: 1, recent: 1, total: 4 } }}
      />,
    );
    openConfirmed();
    const text = (ev()?.textContent ?? "").replace(/\s+/g, " ");
    // Staff co-author + LLM. The affinity signal must not come back as the
    // unnamed fallback about the very person the staff token names.
    expect(text).toContain("Staff co-author");
    expect(text).not.toContain("Repeat user");
    expect(text).not.toContain("of an author's own work");
    expect(text).toContain("2 of 4 signals");
  });

  it("does not restate a PLAIN author's prior use when the row IS their only paper", () => {
    // The half of the rule round 3 left out. This person is on no roster and is
    // not core staff, so nothing else on the card names her — and the guard read
    // that as "nobody on this byline qualifies" and fired the unnamed fallback:
    // the row counted as its own prior evidence, and "N of 4" going UP on the one
    // tab that subtracts. An adjusted count of zero means nothing FURTHER to add,
    // whoever holds it. The LLM read is the only signal here.
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[soleAuthorRow()]}
        paperCounts={{ cli5005: { papers: 1, recent: 1, total: 4 } }}
      />,
    );
    openConfirmed();
    const text = (ev()?.textContent ?? "").replace(/\s+/g, " ");
    expect(text).not.toContain("Repeat user");
    expect(text).not.toContain("of an author's own work");
    expect(text).toContain("1 of 4 signals");
  });

  it("gives a client the SAME paper count on both tabs — it is a holding, not a history", () => {
    // Two statements, two maps. "18 papers, 11 recent" is what this core holds
    // from her, and the paper on screen is part of it; "17 previous occasions" is
    // what it held BEFORE this one. Feeding the subtracted map to both made the
    // same person's number disagree with itself between the tabs.
    const roster = [
      {
        id: "client-ccc1003",
        cwid: "ccc1003",
        name: "Casey Sample",
        slug: "casey-sample",
        affiliation: null,
        addedByName: null,
        addedAt: new Date("2026-01-01"),
        addedBy: "aaa1001",
      },
    ];
    const counts = { ccc1003: { papers: 18, recent: 11, total: 29 } };
    const { unmount } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ year: 2026 })]}
        confirmed={[]}
        clients={roster}
        paperCounts={counts}
      />,
    );
    expect(screen.getByRole("button", { name: /Show evidence/ }).textContent).toContain(
      "Casey Sample, 18 papers, 11 recent",
    );
    unmount();
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ year: 2026 })]}
        clients={roster}
        paperCounts={counts}
      />,
    );
    openConfirmed();
    const text = (ev()?.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Casey Sample, 18 papers, 11 recent");
    expect(text).not.toContain("17 papers");
    expect(text).not.toContain("10 recent");
  });

  it("gives a MANUAL add no score — it was never engine-scored", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ isManual: true, likelihood: 0 })]}
      />,
    );
    fireEvent.click(within(screen.getByRole("group", { name: "Queue view" })).getByText(/Confirmed/));
    // A 0% band on a human's deliberate addition would read as the engine
    // disagreeing, when it simply never scored it.
    expect(ev()).toBeNull();
    expect(screen.getByText(/Manually added/)).toBeTruthy();
  });
});

describe("CoreClaimQueue — Known clients toolbar wiring", () => {
  it("renders Known clients with a PARENTHESISED count, first of the three header buttons", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[]}
        clients={[
          {
            id: "client-aaa1001",
            cwid: "aaa1001",
            name: "Alex Testerson",
            slug: "alex-testerson",
            affiliation: null,
            addedByName: null,
            addedAt: new Date("2026-01-01"),
            addedBy: "rev01",
          },
        ]}
      />,
    );
    const knownClients = screen.getByRole("button", { name: /Known clients/ });
    const addPmids = screen.getByRole("button", { name: /Add PMIDs/ });
    // A LINK since the core-reports widening, not a button — see the test below.
    const reporting = screen.getByRole("link", { name: /Reporting/ });
    // "(1)", not the old bare "1"
    expect(knownClients.textContent?.replace(/\s+/g, " ").trim()).toBe("Known clients (1)");
    // mockup order: [Known clients (N)] [Add PMIDs] [Reporting...]
    expect(
      knownClients.compareDocumentPosition(addPmids) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      addPmids.compareDocumentPosition(reporting) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("'Reporting...' now LINKS to this core's Publications report — the route it was waiting on exists", () => {
    // It shipped inert-and-saying-so while no core reporting route existed. The
    // core-reports widening gave cores reports 3 and 6, so the placeholder is
    // now a real link — and it must carry BOTH `center=<coreId>` and
    // `kind=core`: without the kind, `/edit/reports/3` resolves the code as a
    // CENTER and 404s on the CenterProgram taxonomy gate.
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const reporting = screen.getByRole("link", { name: /Reporting/ });
    expect(reporting.textContent).toContain("Reporting...");
    expect(reporting.getAttribute("href")).toBe(
      `/edit/reports/3?center=${encodeURIComponent(CORE.id)}&kind=core`,
    );
    // No leftover "not built yet" affordances.
    expect(reporting.getAttribute("aria-disabled")).toBeNull();
    expect(document.getElementById("core-queue-reporting-why")).toBeNull();
  });

  it("draws the three controls as text-only rounded rectangles — no icons, no pills", () => {
    // The mockup's toolbar is plain rectangles with labels; the shipped pills
    // carried a lucide glyph each (Users / Plus / FileText). "Reporting..." is a
    // LINK now that cores are reportable, so it is queried by that role — but the
    // three still have to MATCH on height, border and text size, or the group
    // stops reading as one. The restyle landed while the core-reports branch was
    // open, so this is also what stops the link reinstating the old pill.
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const controls = [
      screen.getByRole("button", { name: /Known clients/ }),
      screen.getByRole("button", { name: /Add PMIDs/ }),
      screen.getByRole("link", { name: /Reporting/ }),
    ];
    for (const control of controls) {
      expect(control.querySelector("svg")).toBeNull();
      expect(control.className).toContain("rounded-md");
      expect(control.className).not.toContain("rounded-full");
      expect(control.className).toContain("h-8");
      expect(control.className).toContain("text-sm");
      expect(control.className).toContain("border");
    }
  });

  it("keeps the CSV column contract under test while the export button is off the toolbar", () => {
    // Removing "Download CSV" removed the only caller of downloadCsv(), and with it
    // the only coverage of the column order. A downloaded CSV's headers are a
    // de-facto contract for whoever parses the file, so they are pinned directly.
    expect([...CSV_HEADERS]).toEqual([
      "PMID",
      "Title",
      "Authors",
      "Journal",
      "Year",
      "DOI",
      "Status",
      "Likelihood",
      "Citation",
    ]);
    const r = row({
      pmid: "42",
      title: "A candidate.",
      journal: "Journal of Synthetic Results",
      journalAbbrev: "J Synth Res",
      year: 2024,
      doi: "10.1000/xyz",
      likelihood: 0.82,
      authorsString: "Testerson A, Sample C",
      fullAuthorsString: "Testerson A, Sample C, Placeholder R",
    });
    const cells = csvRow(r, "To review");
    expect(cells[0]).toBe("42");
    // RAW title, period intact — an export is a record, not a rendering
    expect(cells[1]).toBe("A candidate.");
    expect(cells[2]).toBe("Testerson A, Sample C, Placeholder R");
    // FULL journal — the same one the card shows since round 2
    expect(cells[3]).toBe("Journal of Synthetic Results");
    expect(cells[5]).toBe("10.1000/xyz");
    expect(cells[6]).toBe("To review");
    expect(cells[7]).toBe("0.820");
    expect(cells[8]).toContain("PMID: 42.");
  });

  it("renders the Known clients button with a 0 count when no clients prop is passed", () => {
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    expect(screen.getByRole("button", { name: /Known clients/ }).textContent).toContain("0");
  });

  it("opens the roster as a MODAL, portalled clear of the toolbar, on click", () => {
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    // absent before the click — a closed Dialog renders no content at all
    expect(screen.queryByLabelText("Paste CWIDs")).toBeNull();

    const toggle = screen.getByRole("button", { name: /Known clients/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);

    const textarea = screen.getByLabelText("Paste CWIDs");
    expect(textarea).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("dialog")).toBeTruthy();

    // The modal is portalled, so it can never be nested inside the toolbar row
    // — the property the old inline panel had to be positioned to achieve.
    const outerRow = toggle.closest('[data-slot="core-queue-toolbar"]');
    expect(outerRow).toBeTruthy();
    expect(outerRow?.contains(textarea)).toBe(false);
    // ...and clear of the queue panel too, so opening it cannot push the list.
    const queuePanel = document.querySelector('[data-slot="core-queue-panel"]');
    expect(queuePanel?.contains(textarea)).toBe(false);
  });

  it("closing the modal drops what was typed, so the next open starts clean", () => {
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    const toggle = screen.getByRole("button", { name: /Known clients/ });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Paste CWIDs"), { target: { value: "jx2001" } });
    // The footer button, not Radix's own sr-only close icon — both say "Close".
    const footer = document.querySelector('[data-slot="dialog-footer"]') as HTMLElement;
    fireEvent.click(within(footer).getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Paste CWIDs")).toBeNull();
    fireEvent.click(toggle);
    expect((screen.getByLabelText("Paste CWIDs") as HTMLTextAreaElement).value).toBe("");
  });
});

// The queue header as the mockup draws it: one bordered panel holding a TAB
// STRIP (not pills), the free-text filter on the tabs' own line, the facet and
// control rows, and a status band along the bottom.
describe("CoreClaimQueue — header panel", () => {
  const withHistory = (
    <CoreClaimQueue
      core={CORE}
      candidates={[row({ pmid: "1" }), row({ pmid: "2" })]}
      confirmed={[row({ pmid: "8", title: "Done pub", claimed: true })]}
      rejected={[row({ pmid: "9", title: "Nope pub" })]}
    />
  );
  const panel = (container: HTMLElement) =>
    container.querySelector('[data-slot="core-queue-panel"]') as HTMLElement;

  it("wraps the tabs, facets, controls and status strip in ONE bordered panel", () => {
    const { container } = render(withHistory);
    const p = panel(container);
    expect(p).toBeTruthy();
    expect(p.className).toContain("rounded-lg");
    expect(p.className).toContain("border");
    // everything the header owns lives inside it...
    expect(p.contains(screen.getByRole("group", { name: "Queue view" }))).toBe(true);
    expect(p.contains(screen.getByLabelText("Filter candidates"))).toBe(true);
    expect(p.contains(screen.getByRole("group", { name: "Filter candidates by evidence" }))).toBe(
      true,
    );
    expect(p.contains(screen.getByLabelText("Sort by"))).toBe(true);
    expect(p.contains(screen.getByText(/^Showing /))).toBe(true);
    // ...and the candidate cards do NOT
    expect(p.querySelector("[data-card]")).toBeNull();
  });

  it("keeps the tab semantics: a Queue view group of aria-pressed buttons", () => {
    render(withHistory);
    const tabs = screen.getByRole("group", { name: "Queue view" });
    const buttons = within(tabs).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);

    fireEvent.click(screen.getByRole("button", { name: /Confirmed 1/ }));
    expect(
      within(screen.getByRole("group", { name: "Queue view" }))
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["false", "true", "false"]);
    expect(screen.getByText("Done pub")).toBeTruthy();
  });

  it("renders Confirmed/Rejected tabs ONLY when their own count is above 0", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row()]}
        confirmed={[row({ pmid: "8", title: "Done pub", claimed: true })]}
      />,
    );
    const tabs = screen.getByRole("group", { name: "Queue view" });
    expect(
      within(tabs)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["To review1", "Confirmed1"]);
    expect(within(tabs).queryByRole("button", { name: /Rejected/ })).toBeNull();
  });

  it("badges the ACTIVE tab's count in filled maroon and leaves inactive counts plain", () => {
    render(withHistory);
    const tab = (name: RegExp) =>
      within(screen.getByRole("group", { name: "Queue view" })).getByRole("button", { name });
    const countSpan = (el: HTMLElement) => el.querySelector("span") as HTMLElement;
    // active: a filled circular badge
    expect(countSpan(tab(/^To review/)).className).toContain("bg-apollo-maroon");
    expect(countSpan(tab(/^To review/)).className).toContain("rounded-full");
    // inactive: plain muted text, no fill
    expect(countSpan(tab(/^Confirmed/)).className).not.toContain("bg-apollo-maroon");
    expect(countSpan(tab(/^Confirmed/)).className).toContain("text-muted-foreground");
  });

  it("puts the filter on the tab-strip line, and promises 'method' knowingly", () => {
    const { container } = render(withHistory);
    const input = screen.getByLabelText("Filter candidates") as HTMLInputElement;
    // the mockup's exact string. NOTE `searchBlob` does NOT search a method —
    // CoreQueueRow carries none — so that word is aspirational by owner
    // decision, not a bug. See the comment at the placeholder.
    expect(input.placeholder).toBe("Filter by title, author, journal, PMID or method...");
    // same row as the tabs: one shared parent, not stacked under them
    const tabs = screen.getByRole("group", { name: "Queue view" });
    expect(tabs.parentElement?.contains(input)).toBe(true);
    // and the row is the first thing in the panel
    expect(panel(container).firstElementChild?.contains(input)).toBe(true);
  });

  it("keeps the filter OFF the Confirmed and Rejected tabs, where it is inert", () => {
    render(withHistory);
    expect(screen.getByLabelText("Filter candidates")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Confirmed 1/ }));
    expect(screen.queryByLabelText("Filter candidates")).toBeNull();
    expect(screen.queryByRole("group", { name: "Filter candidates by evidence" })).toBeNull();
    expect(screen.queryByText(/^Showing /)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Rejected 1/ }));
    expect(screen.queryByLabelText("Filter candidates")).toBeNull();

    // ...and comes back on the way home
    fireEvent.click(screen.getByRole("button", { name: /To review/ }));
    expect(screen.getByLabelText("Filter candidates")).toBeTruthy();
  });

  it("bands the status strip inside the panel: count left, key legend right", () => {
    const { container } = render(withHistory);
    const strip = container.querySelector('[data-slot="core-queue-status"]') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(panel(container).contains(strip)).toBe(true);
    // a real background band, not loose text on the page
    expect(strip.className).toContain("bg-apollo-surface-2");
    expect(strip.className).toContain("border-t");
    expect(within(strip).getByText("Showing 2 of 2 candidates")).toBeTruthy();
    // the legend, verbatim
    const legend = strip.lastElementChild as HTMLElement;
    expect(legend.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Keys: j/k move · a confirm · r reject · x select · u undo",
    );
    // it sits after the count, pushed to the right edge
    expect(legend.className).toContain("ml-auto");
  });

  it("still shows a plain 'To review' heading (no tab strip) when there is no history", () => {
    const { container } = render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.queryByRole("group", { name: "Queue view" })).toBeNull();
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("To review1");
    // and it is inside the panel, where the tab strip would be
    expect(panel(container).contains(heading)).toBe(true);
  });
});

describe("displayTitle", () => {
  it("drops the sentence-final period PubMed stores on nearly every title", () => {
    expect(displayTitle("A synthetic study of core usage.")).toBe(
      "A synthetic study of core usage",
    );
  });

  it("leaves a title that carries no trailing period alone", () => {
    expect(displayTitle("Advanced MRI of the brain")).toBe("Advanced MRI of the brain");
  });

  it("keeps a trailing question mark or exclamation — that punctuation is the title's own", () => {
    expect(displayTitle("Does the assay scale?")).toBe("Does the assay scale?");
    expect(displayTitle("It scales!")).toBe("It scales!");
  });

  it("keeps a period that closes an initialism (dropping it would misspell the word)", () => {
    expect(displayTitle("Core facility funding in the U.S.")).toBe(
      "Core facility funding in the U.S.",
    );
    expect(displayTitle("A trial run at the N.I.H.")).toBe("A trial run at the N.I.H.");
  });

  it("strips ONE period only, and survives degenerate input", () => {
    expect(displayTitle("Ends in an ellipsis...")).toBe("Ends in an ellipsis..");
    expect(displayTitle("")).toBe("");
  });

  it("is display-only — the raw title still reaches the free-text filter", () => {
    // searchBlob is the card's own text; it must keep matching what curators
    // paste in, periods and all.
    expect(searchBlob(row({ title: "A synthetic study of core usage." }))).toContain(
      "a synthetic study of core usage.",
    );
  });
});

describe("formatAddedToPubMed", () => {
  it("reads as the mockup does", () => {
    expect(formatAddedToPubMed("2026-02-18")).toBe("Added to PubMed Feb 18, 2026");
  });

  it("returns null with no date, so the caller renders nothing rather than an empty slot", () => {
    expect(formatAddedToPubMed(null)).toBeNull();
    expect(formatAddedToPubMed("")).toBeNull();
    expect(formatAddedToPubMed("not-a-date")).toBeNull();
  });

  it("formats in UTC — a local format would show the PREVIOUS day west of UTC", () => {
    // `dateAddedToEntrez` is a `@db.Date`: a calendar date with no zone, which
    // parses to midnight UTC. Format that instant in New York and Feb 18 reads
    // as Feb 17 — the exact off-by-one this pins.
    const prev = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // Control: proves the zone switch actually took, so this test cannot pass
      // vacuously on a UTC runner.
      expect(
        new Date("2026-02-18T00:00:00Z").toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
      ).toBe("Feb 17, 2026");
      expect(formatAddedToPubMed("2026-02-18")).toBe("Added to PubMed Feb 18, 2026");
      // and the same trap at a month boundary, where it also changes the month
      expect(formatAddedToPubMed("2026-03-01")).toBe("Added to PubMed Mar 1, 2026");
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});

describe("initialsOf", () => {
  it("takes first + last initial, and one letter for a single-token name", () => {
    expect(initialsOf("Casey Sample")).toBe("CS");
    expect(initialsOf("Alex Q Testerson")).toBe("AT");
    expect(initialsOf("Cher")).toBe("C");
    expect(initialsOf("   ")).toBe("?");
    // A curated disambiguation suffix is not part of anyone's initials.
    expect(initialsOf("Alessandro Fichera - Surgery")).toBe("AF");
    expect(initialsOf("Jane Doe (Radiology)")).toBe("JD");
    // A REAL generational suffix still is not.
    expect(initialsOf("John Smith III")).toBe("JS");
    // ...but a two-word name whose surname merely LOOKS generational keeps both
    // words: "Vi", "V" and "I" are surnames and first names here, and reading
    // them as suffixes left this avatar showing a single "H".
    expect(initialsOf("Hoang Vi")).toBe("HV");
    expect(initialsOf("Anh V")).toBe("AV");
    expect(initialsOf("Tran I")).toBe("TI");
  });
});

describe("CoreClaimQueue — byline person cards", () => {
  const STAFF = { cwid: "aaa1001", name: "Alex Testerson", slug: "alex-testerson", dept: "Genomics" };
  const CLIENT = { cwid: "ccc1003", name: "Casey Sample", slug: "casey-sample", dept: "Population Health Sciences" };

  function renderByline(over: Partial<CoreQueueRow> = {}, clients: CoreClientRow[] = []) {
    return render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ coauthorScholars: [], coauthors: [], wcmAuthors: [], ...over })]}
        confirmed={[]}
        clients={clients}
      />,
    );
  }

  function clientRow(cwid: string): CoreClientRow {
    return {
      id: `c-${cwid}`,
      cwid,
      name: null,
      slug: null,
      affiliation: null,
      addedByName: null,
      addedAt: new Date("2026-01-01"),
      addedBy: "rev01",
    };
  }

  it("marks a CORE STAFF byline name and names the role in its card", async () => {
    renderByline({
      authorsString: "Testerson A, Other B",
      fullAuthorsString: "Testerson A, Other B",
      coauthorScholars: [STAFF],
      coauthors: [STAFF.cwid],
    });
    const name = screen.getByRole("link", { name: "Alex Testerson" });
    fireEvent.pointerEnter(name);
    // The role line is the whole point of the card — without it a reviewer sees
    // a highlighted name and has to guess which signal it belongs to.
    expect(await screen.findByText("Core staff")).toBeTruthy();
    expect(screen.getByText("Genomics")).toBeTruthy();
    expect(screen.getByText("(aaa1001)")).toBeTruthy();
    expect(screen.getByText("AT")).toBeTruthy(); // avatar initials
  });

  it("marks a KNOWN CLIENT byline name with the client role, not the staff role", async () => {
    renderByline(
      {
        authorsString: "Sample C, Other B",
        fullAuthorsString: "Sample C, Other B",
        wcmAuthors: [CLIENT],
      },
      [clientRow("ccc1003")],
    );
    const name = screen.getByRole("link", { name: "Casey Sample" });
    fireEvent.pointerEnter(name);
    expect(await screen.findByText("Known client of this core")).toBeTruthy();
    expect(screen.queryByText("Core staff")).toBeNull();
  });

  it("gives a client a VISIBLE marking, not only a card a touch user cannot open", () => {
    renderByline(
      { authorsString: "Sample C", fullAuthorsString: "Sample C", wcmAuthors: [CLIENT] },
      [clientRow("ccc1003")],
    );
    const marked = screen.getByRole("link", { name: "Casey Sample" });
    expect(marked.className).toContain("underline");
    expect(marked.className).toContain("decoration-dotted");
  });

  it("a plain WCM co-author is NOT marked as a client — the dotted underline is theirs", async () => {
    // Every resolvable WCM author carries a card now (item 1a), so the card is
    // no longer what distinguishes a client. The MARKING is: a client keeps the
    // dotted underline a touch user can see without hovering, and its card is
    // the only one that says "Known client of this core".
    renderByline({
      authorsString: "Sample C",
      fullAuthorsString: "Sample C",
      wcmAuthors: [CLIENT], // on the byline, but NOT on the clients roster
    });
    const name = screen.getByRole("link", { name: "Casey Sample" });
    fireEvent.pointerEnter(name);
    await Promise.resolve();
    expect(screen.queryByText("Known client of this core")).toBeNull();
    expect(screen.queryByText("Core staff")).toBeNull();
    expect(name.className).not.toContain("decoration-dotted");
  });

  it("staff WINS over client when a person is both — the chip links back to the evidence row", async () => {
    renderByline(
      {
        authorsString: "Testerson A",
        fullAuthorsString: "Testerson A",
        coauthorScholars: [STAFF],
        coauthors: [STAFF.cwid],
        wcmAuthors: [STAFF],
      },
      [clientRow("aaa1001")],
    );
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Alex Testerson" }));
    expect(await screen.findByText("Core staff")).toBeTruthy();
    expect(screen.queryByText("Known client of this core")).toBeNull();
  });

  it("attaches NO card to an AMBIGUOUS surname — it must not assert which colleague this is", async () => {
    // Two scholars share "Kim" AND the first initial, so the byline token cannot
    // be resolved to one person. Asserting a name, CWID, department and role on
    // a coin flip is exactly what the ambiguity guard exists to prevent.
    const kimA = { cwid: "kkk1001", name: "Kelly Kimball", slug: "kelly-kimball", dept: "Genomics" };
    const kimB = { cwid: "kkk1002", name: "Kim Kimball", slug: "kim-kimball", dept: "Pathology" };
    renderByline({
      authorsString: "Kimball K, Other B",
      fullAuthorsString: "Kimball K, Other B",
      coauthorScholars: [kimA],
      coauthors: [kimA.cwid],
      wcmAuthors: [kimA, kimB],
    });
    // Scoped to the BYLINE: "Kelly Kimball" also appears in the evidence strip below
    // ("Staff co-author Kelly Kimball"), which is correct there and would make a
    // document-wide assertion pass for the wrong reason.
    const byline = document.querySelector('[data-slot="core-queue-byline"]') as HTMLElement;
    // The raw PubMed token survives — no rewrite...
    expect(byline.textContent).toContain("Kimball K");
    expect(within(byline).queryByText("Kelly Kimball")).toBeNull();
    // ...and no card: the trigger is a plain span, with nothing to hover.
    expect(byline.querySelector("[data-slot='hover-card-trigger']")).toBeNull();
    expect(screen.queryByText("Core staff")).toBeNull();
  });

  // Round-2 regressions. Each of these renamed a byline token to a DIFFERENT
  // person, then linked and carded them — the failure the ambiguity guard above
  // exists to prevent, and item 1(a) raised its cost by putting that person's
  // CWID and department on screen beside the wrong name. Every assertion is
  // scoped to the byline element: the evidence strip below names people too, so
  // a document-wide query passes for the wrong reason.
  const byline = () => document.querySelector('[data-slot="core-queue-byline"]') as HTMLElement;

  it("does NOT claim a scholar from the FRONT of a longer surname", () => {
    // Keys go into the map as the scholar's TRAILING words, so a token must be
    // matched on its trailing words too. Matched on its leading ones,
    // "Perez Garcia M" fell back to the key "perez" and the byline read
    // "Maria Perez, Maria Perez, Doe J" — one person over two people's tokens.
    renderByline({
      authorsString: "Perez M, Perez Garcia M, Doe J",
      fullAuthorsString: "Perez M, Perez Garcia M, Doe J",
      wcmAuthors: [
        { cwid: "map1001", name: "Maria Perez", slug: "maria-perez", dept: "Neurology" },
      ],
    });
    // The token that IS hers still expands...
    const hers = within(byline()).getByText("Maria Perez");
    expect(hers.closest("a")?.getAttribute("href")).toBe("/maria-perez");
    // ...and the one that is not keeps PubMed's form, unlinked and uncarded.
    expect(byline().textContent).toContain("Perez Garcia M");
    expect(byline().querySelectorAll("a")).toHaveLength(1);
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(1);
  });

  it("reaches a surname behind name particles — 'van der Berg J' is Jan van der Berg", () => {
    // The scholar side is what reaches it: "Jan van der Berg" registers "berg",
    // "der berg" AND "van der berg", so the token's whole surname phrase — the
    // only key it ever looks up — finds him.
    renderByline({
      authorsString: "van der Berg J, Other B",
      fullAuthorsString: "van der Berg J, Other B",
      wcmAuthors: [
        { cwid: "jbe1005", name: "Jan van der Berg", slug: "jan-van-der-berg", dept: "Pathology" },
      ],
    });
    expect(within(byline()).getByText("Jan van der Berg").closest("a")?.getAttribute("href")).toBe(
      "/jan-van-der-berg",
    );
    expect(byline().textContent).not.toContain("van der Berg J");
  });

  // ── The token side does not slice ────────────────────────────────────────
  // Two consecutive rounds widened the match by falling back to the surname
  // phrase's shorter tails, and each time the widening renamed, linked and
  // CARDED a real person who is not the author. A shorter tail of a compound
  // surname is a different surname; these four pin that.

  it("does NOT claim a scholar whose whole surname is the LAST word of a compound token", () => {
    // The round-2 shape, mirrored: keys and token now slice from the same end,
    // so "Perez Garcia M" fell back to "garcia" and rendered as Maria Garcia —
    // her name, her /maria-garcia link, and a card asserting her CWID and
    // department, on a token belonging to someone SPS has never heard of.
    renderByline({
      authorsString: "Perez Garcia M, Other B",
      fullAuthorsString: "Perez Garcia M, Other B",
      wcmAuthors: [
        { cwid: "mga1011", name: "Maria Garcia", slug: "maria-garcia", dept: "Neurology" },
      ],
    });
    expect(byline().textContent).toContain("Perez Garcia M");
    expect(within(byline()).queryByText("Maria Garcia")).toBeNull();
    expect(byline().querySelectorAll("a")).toHaveLength(0);
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  it("does not spread ONE compound token across two different scholars' surnames", () => {
    // Both tails are held, by two different people: "perez" by Maria Perez and
    // "garcia" by Maria Garcia. With a fallback the byline read "Maria Perez,
    // Maria Garcia, Maria Garcia" — the third token is neither of them.
    renderByline({
      authorsString: "Perez M, Garcia M, Perez Garcia M",
      fullAuthorsString: "Perez M, Garcia M, Perez Garcia M",
      wcmAuthors: [
        { cwid: "mpe1010", name: "Maria Perez", slug: "maria-perez", dept: "Surgery" },
        { cwid: "mga1011", name: "Maria Garcia", slug: "maria-garcia", dept: "Neurology" },
      ],
    });
    // The two tokens that ARE theirs expand, once each...
    expect(within(byline()).getByText("Maria Perez").closest("a")?.getAttribute("href")).toBe(
      "/maria-perez",
    );
    expect(within(byline()).getByText("Maria Garcia").closest("a")?.getAttribute("href")).toBe(
      "/maria-garcia",
    );
    // ...and the compound one is left alone.
    expect(byline().textContent).toContain("Perez Garcia M");
    expect(byline().querySelectorAll("a")).toHaveLength(2);
  });

  it("does NOT reach a scholar who holds only a TAIL of the token's surname", () => {
    // "van der Berg J" above resolves because that scholar registers the whole
    // phrase. A scholar recorded as plain "Jan Berg" holds "berg" only, and
    // "berg" is not the surname this token wrote.
    renderByline({
      authorsString: "van der Berg J, Other B",
      fullAuthorsString: "van der Berg J, Other B",
      wcmAuthors: [{ cwid: "jbe1005", name: "Jan Berg", slug: "jan-berg", dept: "Pathology" }],
    });
    expect(byline().textContent).toContain("van der Berg J");
    expect(within(byline()).queryByText("Jan Berg")).toBeNull();
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  it("names ONE person on ONE token only — two tokens claiming a scholar identify neither", () => {
    // `ambiguous` cannot see this and never could: it is built from the row's own
    // scholar lists, and `publication_author` holds rows ONLY for matched WCM
    // authors, so a non-WCM Kim is absent from them by construction. Both tokens
    // therefore resolved to the one WCM Jane Kim and BOTH printed her name, her
    // link and her card — at least one of which states the wrong CWID and
    // department, since two same-surname same-initial tokens are two people.
    renderByline({
      authorsString: "Kim J, Kim J, Doe A",
      fullAuthorsString: "Kim J, Kim J, Doe A",
      wcmAuthors: [{ cwid: "jki1012", name: "Jane Kim", slug: "jane-kim", dept: "Pathology" }],
    });
    expect(byline().textContent).toContain("Kim J, Kim J");
    expect(within(byline()).queryByText("Jane Kim")).toBeNull();
    expect(byline().querySelectorAll("a")).toHaveLength(0);
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  it("fires on a repeated PERSON, not on a byline that merely resolves twice", () => {
    // The guard must not degrade into "more than one name on this byline is
    // suspicious": two DIFFERENT people, one token each, both still expand.
    renderByline({
      authorsString: "Kim J, Park S, Other B",
      fullAuthorsString: "Kim J, Park S, Other B",
      wcmAuthors: [
        { cwid: "jki1012", name: "Jane Kim", slug: "jane-kim", dept: "Pathology" },
        { cwid: "spa1014", name: "Sam Park", slug: "sam-park", dept: "Surgery" },
      ],
    });
    expect(within(byline()).getByText("Jane Kim")).toBeTruthy();
    expect(within(byline()).getByText("Sam Park")).toBeTruthy();
    expect(byline().querySelectorAll("a")).toHaveLength(2);
  });

  it("expands a scholar whose LAST NAME WORD looks like a generational suffix", () => {
    // `NAME_SUFFIXES` counts "V", "VI" and "I" as generational, so running it
    // over the SCHOLAR's name read "Hoang Vi" as the surname "hoang" — one word,
    // from which the key loop registers NONE, and Hoang Vi could never be
    // expanded or carded. Same for Anh V, Tran I and every Nguyen Vi.
    renderByline({
      authorsString: "Vi H, Other B",
      fullAuthorsString: "Vi H, Other B",
      wcmAuthors: [{ cwid: "hvi1013", name: "Hoang Vi", slug: "hoang-vi", dept: "Pediatrics" }],
    });
    const named = within(byline()).getByText("Hoang Vi");
    expect(named.closest("a")?.getAttribute("href")).toBe("/hoang-vi");
    expect(named.getAttribute("data-slot")).toBe("hover-card-trigger");
  });

  it("reads a first initial past a generational suffix, not off it", () => {
    // "Smith AB Jr" is A.B. Smith. Reading the LAST word gave "j", which agrees
    // with a John Smith and renamed, linked and carded the token as him — and
    // with the suffix left inside the name the real A.B. Smith is unreachable
    // too, since her surname key is then "ab".
    const { unmount } = renderByline({
      authorsString: "Smith AB Jr, Other B",
      fullAuthorsString: "Smith AB Jr, Other B",
      wcmAuthors: [{ cwid: "jsm1006", name: "John Smith", slug: "john-smith", dept: "Surgery" }],
    });
    expect(byline().textContent).toContain("Smith AB Jr");
    expect(within(byline()).queryByText("John Smith")).toBeNull();
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
    unmount();
    renderByline({
      authorsString: "Smith AB Jr, Other B",
      fullAuthorsString: "Smith AB Jr, Other B",
      wcmAuthors: [{ cwid: "abs1009", name: "Alice Smith", slug: "alice-smith", dept: "Surgery" }],
    });
    expect(within(byline()).getByText("Alice Smith").closest("a")?.getAttribute("href")).toBe(
      "/alice-smith",
    );
  });

  it("still expands an author whose first initial IS a roman numeral", () => {
    // The suffix strip must not eat the initials group: `NAME_SUFFIXES` counts
    // "I" and "V" as generational, so reusing it here would silently stop
    // expanding every Ivanova and Volkov on the page.
    renderByline({
      authorsString: "Ivanova I, Other B",
      fullAuthorsString: "Ivanova I, Other B",
      wcmAuthors: [
        { cwid: "iiv1007", name: "Irina Ivanova", slug: "irina-ivanova", dept: "Neurology" },
      ],
    });
    expect(within(byline()).getByText("Irina Ivanova")).toBeTruthy();
  });

  it("expands a scholar carrying a curated disambiguation suffix, WITHOUT printing it", async () => {
    // "Alessandro Fichera - Surgery" (#2049) registered "surgery" and
    // "fichera - surgery" as his surname keys — never "fichera" — so his own
    // byline token could never reach him. Same for "Jane Doe (Radiology)".
    // Reachable, the raw preferredName then printed INSIDE the byline
    // ("Alessandro Fichera - Surgery, Other B") and again on the card, where the
    // department already has a line of its own.
    renderByline({
      authorsString: "Fichera A, Other B",
      fullAuthorsString: "Fichera A, Other B",
      wcmAuthors: [
        {
          cwid: "zqf9101",
          name: "Alessandro Fichera - Surgery",
          slug: "alessandro-fichera",
          dept: "Surgery",
        },
      ],
    });
    const named = within(byline()).getByText("Alessandro Fichera");
    expect(named.closest("a")?.getAttribute("href")).toBe("/alessandro-fichera");
    expect(named.getAttribute("data-slot")).toBe("hover-card-trigger");
    expect(byline().textContent).not.toContain("Fichera A,");
    // The suffix is a roster disambiguation device, not part of his name.
    expect(byline().textContent).not.toContain(" - Surgery");
    // ...and the card names him the same way, with the department below it.
    fireEvent.pointerEnter(named);
    await screen.findByText("(zqf9101)");
    const card = document.querySelector('[data-slot="core-queue-person-card"]') as HTMLElement;
    expect(within(card).getByText("Alessandro Fichera")).toBeTruthy();
    expect(card.textContent).not.toContain(" - Surgery");
    expect(within(card).getByText("Surgery")).toBeTruthy();
  });

  it("refuses to name a plain WCM author on a TRUNCATED byline", () => {
    // `wcmAuthors` is capped at WCM_AUTHORS_CAP, so on a truncated row the
    // ambiguity check ran over a prefix of the byline: a second Sample past the
    // cap is invisible, and the card would assert this one's CWID and
    // department on what may be someone else.
    //
    // Core staff are the deliberate exception. NOT because the cap cannot hide a
    // namesake of theirs — it can — but because it does not touch what
    // identifies them: `coauthorScholars` is uncapped and independent of the
    // dropped authors (the loader `continue`s those before they ever reach this
    // component), so the card names someone we know for certain co-authored this
    // paper, and the chip is the byline's only link back to the co-author
    // evidence row. Flip the guard to cover staff and this assertion inverts.
    renderByline({
      authorsString: "Testerson A, Sample C",
      fullAuthorsString: "Testerson A, Sample C",
      coauthorScholars: [STAFF],
      coauthors: [STAFF.cwid],
      wcmAuthors: [CLIENT],
      wcmAuthorsTruncated: true,
    });
    expect(byline().textContent).toContain("Sample C");
    expect(within(byline()).queryByText("Casey Sample")).toBeNull();
    expect(within(byline()).getByText("Alex Testerson").getAttribute("data-slot")).toBe(
      "hover-card-trigger",
    );
  });

  // ── A generational suffix and an initials group differ only by CASE ────────
  // `BYLINE_SUFFIX` used to be tested against an already-lowercased word, so
  // "JR" (the initials J.R.) and "Jr" (the suffix) were the same string by the
  // time it saw them. That single lost signal produced a false positive AND a
  // false negative, one on each side of the strip.

  it("does NOT read an all-caps initials group as a generational suffix", () => {
    // "SR" is S.R., not "Senior". Stripped as a suffix it left ["garcia",
    // "martinez"], which reads the initial off "martinez" ("m") and looks up the
    // LEADING word "garcia" — so the byline printed Maria Garcia's name, her
    // link and a card asserting her CWID and department on a token belonging to
    // someone SPS has never heard of. Verbatim the compound-surname defect the
    // four tests above pin, arriving by a different route.
    renderByline({
      authorsString: "Garcia Martinez SR, Other B",
      fullAuthorsString: "Garcia Martinez SR, Other B",
      wcmAuthors: [
        { cwid: "mga1011", name: "Maria Garcia", slug: "maria-garcia", dept: "Neurology" },
      ],
    });
    expect(byline().textContent).toContain("Garcia Martinez SR");
    expect(within(byline()).queryByText("Maria Garcia")).toBeNull();
    expect(byline().querySelectorAll("a")).toHaveLength(0);
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  it("reads the first initial OFF an all-caps 'JR', which is initials and not 'Junior'", () => {
    // The same bug's other direction: stripping "JR" left the one word "Smith",
    // which carries no initials group at all, so the token could never resolve
    // and James Smith went unexpanded on his own paper.
    const { unmount } = renderByline({
      authorsString: "Smith JR, Other B",
      fullAuthorsString: "Smith JR, Other B",
      wcmAuthors: [{ cwid: "jsm1015", name: "James Smith", slug: "james-smith", dept: "Surgery" }],
    });
    const named = within(byline()).getByText("James Smith");
    expect(named.closest("a")?.getAttribute("href")).toBe("/james-smith");
    expect(named.getAttribute("data-slot")).toBe("hover-card-trigger");
    unmount();
    // ...while the TITLE-CASE suffix is still a suffix, and a surname left with
    // no initials group beside it claims nobody.
    renderByline({
      authorsString: "Smith Jr, Other B",
      fullAuthorsString: "Smith Jr, Other B",
      wcmAuthors: [{ cwid: "jsm1015", name: "James Smith", slug: "james-smith", dept: "Surgery" }],
    });
    expect(byline().textContent).toContain("Smith Jr");
    expect(within(byline()).queryByText("James Smith")).toBeNull();
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  // ── The trailing block has to LOOK like initials ──────────────────────────

  it("does NOT treat a REAL WORD after the surname as an initials group", () => {
    // "Wang Xiaoming" is a whole name in Chinese order, not "Wang X." — but the
    // loop took the last word as initials with no check, read "x" off
    // "xiaoming" and looked up "wang", printing Xin Wang's name, link and card
    // on it. A token with no initials group has no first initial to agree with,
    // so it must claim nobody.
    const { unmount } = renderByline({
      authorsString: "Wang Xiaoming, Other B",
      fullAuthorsString: "Wang Xiaoming, Other B",
      wcmAuthors: [{ cwid: "xwa1110", name: "Xin Wang", slug: "xin-wang", dept: "Biochemistry" }],
    });
    expect(byline().textContent).toContain("Wang Xiaoming");
    expect(within(byline()).queryByText("Xin Wang")).toBeNull();
    expect(byline().querySelectorAll("a")).toHaveLength(0);
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
    unmount();
    // ...and a genuine multi-letter initials group still resolves, so this is a
    // shape test and not a ban on two-word tokens.
    renderByline({
      authorsString: "Wang XY, Other B",
      fullAuthorsString: "Wang XY, Other B",
      wcmAuthors: [{ cwid: "xwa1110", name: "Xin Wang", slug: "xin-wang", dept: "Biochemistry" }],
    });
    expect(within(byline()).getByText("Xin Wang").closest("a")?.getAttribute("href")).toBe(
      "/xin-wang",
    );
  });

  it("does NOT resolve a COLLECTIVE author written as 'Surname Group'", () => {
    // "Kim Group" is a consortium byline, not a person. It reached Gina Kim off
    // the initial "g" of "group" — her name, her link and her card.
    renderByline({
      authorsString: "Kim Group, Other B",
      fullAuthorsString: "Kim Group, Other B",
      wcmAuthors: [{ cwid: "gki1016", name: "Gina Kim", slug: "gina-kim", dept: "Pathology" }],
    });
    expect(byline().textContent).toContain("Kim Group");
    expect(within(byline()).queryByText("Gina Kim")).toBeNull();
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  // ── The duplicate-person guard must see past the preview cut ──────────────

  it("sees a namesake HIDDEN BY THE PREVIEW CUT, not just the visible tokens", () => {
    // `authors_string` is a preview: it drops authors on 68.4% of core 14's
    // rows. The guard was built from that preview, so the second "Kim J" — past
    // the cut, and invisible to `wcmAuthors` too because it is not WCM — was
    // never counted, and the one visible token printed Jane Kim's name, link and
    // card. Whether a real person's identity landed on a stranger's token
    // depended on nothing but where PubMed happened to cut.
    renderByline({
      authorsString: "Kim J, Doe A",
      fullAuthorsString: "Kim J, Doe A, Kim J",
      wcmAuthors: [{ cwid: "jki1012", name: "Jane Kim", slug: "jane-kim", dept: "Pathology" }],
    });
    expect(byline().textContent).toContain("Kim J");
    expect(within(byline()).queryByText("Jane Kim")).toBeNull();
    expect(byline().querySelectorAll("a")).toHaveLength(0);
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
    // The dropped author is still only COUNTED, never printed.
    expect(byline().textContent).toContain(", +1 more");
    expect(byline().textContent).not.toContain("Doe A, Kim J");
  });

  it("sees a namesake VISIBLE TWICE that the full list does not repeat", () => {
    // The first attempt at the guard REPLACED the preview sweep with the full
    // list instead of unioning them, which restored the original defect with
    // cards attached. The two strings come from different producers — an author
    // with a null given name composes to a BARE surname in `full_authors_string`
    // ("Kim"), a one-word token the resolver refuses — so a namesake standing
    // twice ON SCREEN can be absent from the full list.
    renderByline({
      authorsString: "Kim J, Kim J, Doe A",
      fullAuthorsString: "Kim J, Kim, Doe A, Park S",
      wcmAuthors: [{ cwid: "jki1012", name: "Jane Kim", slug: "jane-kim", dept: "Pathology" }],
    });
    expect(within(byline()).queryByText("Jane Kim")).toBeNull();
    expect(byline().querySelectorAll("a")).toHaveLength(0);
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  it("splits the full list the way countAuthorTokens does, not on a literal comma-space", () => {
    // `dropped` counts on /,\s*/ while the sweep split on ", ", so a namesake
    // written without the space merged into its neighbour and went unseen.
    renderByline({
      authorsString: "Kim J, Doe A",
      fullAuthorsString: "Kim J, Doe A,Kim J",
      wcmAuthors: [{ cwid: "jki1012", name: "Jane Kim", slug: "jane-kim", dept: "Pathology" }],
    });
    expect(within(byline()).queryByText("Jane Kim")).toBeNull();
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  it("leaves a >3-letter initials group unexpanded — the accepted cost of the cap", () => {
    // `deriveInitials` emits one letter per given-name part, so "Maria de los
    // Angeles Rodriguez" composes "Rodriguez MDLA" and is NOT expanded here.
    // Widening the cap to reach it was tried and reverted: "Kim JOHN" is the
    // same shape, and the wider class carded the scholar Jane Kim on it. This
    // test pins the miss so the tradeoff is a decision, not a surprise — see
    // BYLINE_INITIALS.
    renderByline({
      authorsString: "Rodriguez MDLA, Other B",
      wcmAuthors: [
        { cwid: "mro1050", name: "Maria Rodriguez", slug: "maria-rodriguez", dept: "Medicine" },
      ],
    });
    expect(within(byline()).queryByText("Maria Rodriguez")).toBeNull();
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });

  it("still expands when the hidden authors are NOT namesakes — a cut is not a veto", () => {
    // The widened sweep must not degrade into "any truncated byline resolves
    // nobody": the guard fires on a REPEATED PERSON, wherever they sit.
    renderByline({
      authorsString: "Kim J, Doe A",
      fullAuthorsString: "Kim J, Doe A, Park S",
      wcmAuthors: [{ cwid: "jki1012", name: "Jane Kim", slug: "jane-kim", dept: "Pathology" }],
    });
    expect(within(byline()).getByText("Jane Kim").closest("a")?.getAttribute("href")).toBe(
      "/jane-kim",
    );
    expect(byline().textContent).toContain(", +1 more");
  });

  // ── One-word names, on either side ────────────────────────────────────────

  it("expands a MONONYMOUS scholar — one word is still a surname", () => {
    // `Math.min(3, words.length - 1)` is 0 for a one-word preferredName, so the
    // key loop never ran and mononymous scholars registered NOTHING: no rename,
    // no link, no card, and no staff chip on their own paper. Master named them.
    renderByline({
      authorsString: "Sukarno S, Other B",
      fullAuthorsString: "Sukarno S, Other B",
      coauthorScholars: [{ cwid: "suk1061", name: "Sukarno", slug: "sukarno", dept: "Medicine" }],
      coauthors: ["suk1061"],
    });
    // Scoped to the byline: the evidence strip below names staff too.
    const named = within(byline()).getByText("Sukarno");
    expect(named.closest("a")?.getAttribute("href")).toBe("/sukarno");
    expect(named.getAttribute("data-slot")).toBe("hover-card-trigger");
  });

  it("reaches a scholar whose diacritics PubMed dropped, without any shorter-tail fallback", () => {
    // Nothing normalised diacritics on either side, so "Nino de Rivera S" — the
    // form PubMed actually publishes — missed "Sara Niño de Rivera" and stayed
    // in its abbreviated form, narrowing "expand EVERY WCM author". Folding is
    // applied to the key map and the lookup alike, so the token still looks up
    // its COMPLETE surname phrase and nothing shorter — a scholar holding only
    // the tail "Rivera" must still not be reached by it.
    const { unmount } = renderByline({
      authorsString: "Nino de Rivera S, Other B",
      fullAuthorsString: "Nino de Rivera S, Other B",
      wcmAuthors: [
        {
          cwid: "snr1017",
          name: "Sara Niño de Rivera",
          slug: "sara-nino-de-rivera",
          dept: "Neurology",
        },
      ],
    });
    expect(
      within(byline()).getByText("Sara Niño de Rivera").closest("a")?.getAttribute("href"),
    ).toBe("/sara-nino-de-rivera");
    unmount();
    renderByline({
      authorsString: "Nino de Rivera S, Other B",
      fullAuthorsString: "Nino de Rivera S, Other B",
      wcmAuthors: [
        { cwid: "sri1018", name: "Sara Rivera", slug: "sara-rivera", dept: "Neurology" },
      ],
    });
    expect(byline().textContent).toContain("Nino de Rivera S");
    expect(within(byline()).queryByText("Sara Rivera")).toBeNull();
    expect(byline().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(0);
  });


  // ── The token-shape table ────────────────────────────────────────────────
  // Every shape the loop can meet, and what it is allowed to do with it. Four
  // rounds of this matcher each shipped a fix that renamed, linked and carded
  // the wrong person on a shape no test covered, so the shapes are enumerated
  // here rather than sampled. A shape that resolves to NOBODY renders PubMed's
  // own text with no link and no card, which is always safe; only a resolved
  // shape can assert a CWID and a department.
  it("resolves each byline TOKEN SHAPE the same way every time", () => {
    const KIM = { cwid: "jki1012", name: "Jane Kim", slug: "jane-kim", dept: "Pathology" };
    const BERG = {
      cwid: "jbe1005",
      name: "Jan van der Berg",
      slug: "jan-van-der-berg",
      dept: "Pathology",
    };
    const HYPHEN = {
      cwid: "asj1020",
      name: "Ann Smith-Jones",
      slug: "ann-smith-jones",
      dept: "Surgery",
    };
    // [token, the scholar on the row, the name the byline ends up printing]
    const shapes: Array<[string, CoreQueueRow["wcmAuthors"][number], string]> = [
      // ONE WORD — a collective author. No initials group, so nobody.
      ["Kim", KIM, "Kim"],
      ["THE CONSORTIUM", KIM, "THE CONSORTIUM"],
      // WORD + INITIALS — the ordinary case, and the only one that resolves.
      ["Kim J", KIM, "Jane Kim"],
      // WORD + WORD — a name in Chinese order, or a collective. Not initials.
      ["Kim Group", KIM, "Kim Group"],
      // ...including an ALL-CAPS given name: upper case alone is not enough,
      // an initials group is also SHORT.
      ["Kim JOHN", KIM, "Kim JOHN"],
      // COMPOUND SURNAME + INITIALS — reached whole, never by a shorter tail.
      ["van der Berg J", BERG, "Jan van der Berg"],
      // COMPOUND + "JR" — upper case, so an initials group, not "Junior".
      ["van der Berg JR", BERG, "Jan van der Berg"],
      // COMPOUND + "Jr" — title case, so the suffix; nothing is left to read an
      // initial off, and the token resolves to nobody.
      ["van der Berg Jr", BERG, "van der Berg Jr"],
      // HYPHENATED SURNAME — one word, matched whole.
      ["Smith-Jones A", HYPHEN, "Ann Smith-Jones"],
      // HYPHENATED INITIALS — deliberately NOT an initials group: no sample in
      // this corpus writes them, and widening on a guess is what the four
      // rounds were. Costs a non-expansion, never a wrong name.
      ["Kim J-H", KIM, "Kim J-H"],
    ];
    for (const [token, scholar, expected] of shapes) {
      const authorsString = `${token}, Other B`;
      const { unmount } = renderByline({
        authorsString,
        fullAuthorsString: authorsString,
        wcmAuthors: [scholar],
      });
      const resolved = expected !== token;
      expect([token, byline().textContent]).toEqual([token, `${expected}, Other B`]);
      expect([token, byline().querySelectorAll("a").length]).toEqual([token, resolved ? 1 : 0]);
      expect([
        token,
        byline().querySelectorAll('[data-slot="hover-card-trigger"]').length,
      ]).toEqual([token, resolved ? 1 : 0]);
      unmount();
    }
  });

  it("renders ', +N more' as its own node in BOTH byline branches", () => {
    // no known names -> the early-return branch
    const { unmount } = renderByline({
      authorsString: "Alpha A, Beta B",
      fullAuthorsString: "Alpha A, Beta B, Gamma C, Delta D",
    });
    expect(document.querySelector('[data-slot="core-queue-byline"]')!.textContent).toContain(", +2 more");
    unmount();
    // a known name -> the mapped branch
    renderByline({
      authorsString: "Testerson A, Beta B",
      fullAuthorsString: "Testerson A, Beta B, Gamma C, Delta D",
      coauthorScholars: [STAFF],
      coauthors: [STAFF.cwid],
    });
    expect(document.querySelector('[data-slot="core-queue-byline"]')!.textContent).toContain(", +2 more");
  });
});

describe("CoreClaimQueue — stale 'Check PMIDs' response", () => {
  it("a check that lands after the paste changed must NOT arm Claim for the new text", async () => {
    // Without the guard the late response re-armed the footer button for a paste
    // that was never checked, and the claim then posted the NEW text.
    let resolveCheck: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveCheck = r;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add PMIDs/ }));
    const paste = screen.getByLabelText("Paste PMIDs");
    fireEvent.change(paste, { target: { value: "111" } });
    fireEvent.click(screen.getByRole("button", { name: "Check PMIDs" }));
    // The reviewer edits while the check is in flight...
    fireEvent.change(paste, { target: { value: "111 222" } });
    // ...and only now does the old check land.
    resolveCheck({
      ok: true,
      json: async () => ({ dryRun: true, wouldWrite: 1, skipped: 0, notFound: [] }),
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const claim = screen.getByRole("button", { name: "Claim publications" }) as HTMLButtonElement;
    expect(claim.disabled).toBe(true);
  });

  it("also drops a check whose BODY parse finished after the paste changed", async () => {
    // The second staleness check earns its keep in this window only: the fetch
    // resolved while the text was still current, and the edit landed during
    // res.json(). One check after the first await cannot see this.
    let resolveJson: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        new Promise((r) => {
          resolveJson = r;
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add PMIDs/ }));
    const paste = screen.getByLabelText("Paste PMIDs");
    fireEvent.change(paste, { target: { value: "111" } });
    fireEvent.click(screen.getByRole("button", { name: "Check PMIDs" }));
    // Let the fetch settle while the text is still "111"...
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // ...then edit, and only now let the body parse finish.
    fireEvent.change(paste, { target: { value: "111 222" } });
    resolveJson({ dryRun: true, wouldWrite: 1, skipped: 0, notFound: [] });
    // Flush the pending microtasks/state before asserting. `waitFor` is wrong
    // here: it passes on its FIRST poll, which happens before the late response
    // could have applied — so it would go green even with the guard removed.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(
      (screen.getByRole("button", { name: "Claim publications" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // And nothing describing the abandoned check is on screen.
    expect(document.querySelector('[data-slot="core-claim-pmid-check"]')).toBeNull();
  });
});
