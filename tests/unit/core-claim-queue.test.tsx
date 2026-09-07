/**
 * The per-core review queue client component (components/edit/core-claim-queue).
 * Renders candidate evidence and posts confirm/reject to /api/edit/core-claim with
 * optimistic local state. fetch is mocked — no DB/network.
 *
 * Every fixture value here is synthetic: made-up names, made-up CWIDs, made-up
 * PMIDs. Nothing in this file is a real person or a real record.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
  likelihoodBand,
  llmVerdict,
  matchesFilters,
  matchesQuery,
  parsePmidBlock,
  searchBlob,
  CSV_HEADERS,
  csvRow,
} from "@/components/edit/core-claim-queue";
import type { FilterKey } from "@/components/edit/core-claim-queue";
import type { CoreQueueRow } from "@/lib/api/core-queue";

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
    expect(screen.getByText(/4 of 5 signals/)).toBeTruthy();
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
    expect(list.getByText("42%")).toBeTruthy(); // affinity readout
    // the readout is a RATE post-ReciterAI #382, and the copy has to say so
    expect(
      list.getByText(
        "The largest share of any byline author's own publications that are work with this core",
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

  it("reads the header meta as one middot line: abbreviated journal, PubMed date, PMID", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />,
    );
    expect(metaLine(container)).toBe(
      "Synth J Core Imaging Sci·Added to PubMed Feb 18, 2026·PMID 30418319",
    );
    // the full journal title is NOT what the card shows
    expect(screen.queryByText("Synthetic Journal of Core Imaging Science")).toBeNull();
  });

  it("falls back to the full journal title when no abbreviation is on file", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[row({ journalAbbrev: null })]} confirmed={[]} />,
    );
    expect(metaLine(container)).toBe(
      "Synthetic Journal of Core Imaging Science·Added to PubMed Feb 18, 2026·PMID 30418319",
    );
  });

  it("falls back to the publication year when PubMed never indexed a date", () => {
    const { container } = render(
      <CoreClaimQueue core={CORE} candidates={[row({ dateAddedToEntrez: null })]} confirmed={[]} />,
    );
    expect(metaLine(container)).toBe("Synth J Core Imaging Sci·2021·PMID 30418319");
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

  it("does not claim a MeSH descriptor on an author-only prefilter prior", () => {
    // The bug this pins: every prefilter_prior rendered "The paper carries a MeSH
    // descriptor under this core's technique branch". On prod 2026-09-04 that was
    // false on 7,332 of 9,352 live chips, and core 14's entire backfill is 0.60
    // (author-only, MeSH membership zero) — so it would have been false on every
    // row of the queue that actually gets reviewed.
    render(<CoreClaimQueue core={CORE} candidates={[row({ topicalPrior: 0.6 })]} confirmed={[]} />);
    showEvidence();
    expect(screen.queryByText(/MeSH descriptor under this core's technique branch/)).toBeNull();
    expect(screen.getByText(/Prefilter prior — repeat user, no MeSH match/)).toBeTruthy();
  });

  it("keeps the MeSH wording when the MeSH signal actually fired", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row({ topicalPrior: 0.4 })]} confirmed={[]} />);
    showEvidence();
    expect(screen.getByText("Topical MeSH match")).toBeTruthy();
  });

  it("names both signals when the prior is the noisy-OR of the two", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row({ topicalPrior: 0.76 })]} confirmed={[]} />);
    showEvidence();
    expect(screen.getByText("MeSH match + repeat user")).toBeTruthy();
  });

  it("counts all five signals, so the numerator can reach its own denominator", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row({ topicalPrior: 0.76 })]} confirmed={[]} />);
    expect(screen.getByText("5 of 5 signals")).toBeTruthy();
  });

  it("renders the synopsis and links resolved core-staff co-authors to their profile", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.getByText("A faster MRI sequence.")).toBeTruthy();
    showEvidence();
    const staff = within(evidence()).getByRole("link", { name: "Alex Testerson" });
    expect(staff.getAttribute("href")).toBe("/alex-testerson");
    expect(screen.getByText(/\(Radiology\)/)).toBeTruthy();
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
    expect(screen.getByText(/0 of 5 signals/)).toBeTruthy();
    // the collapsed strip says so too, before anything is opened
    expect(screen.getByText("No labelled signal.")).toBeTruthy();
    showEvidence();
    expect(screen.getByText(/The score moved on engine inputs this queue doesn’t show/)).toBeTruthy();
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
            cwid: "ccc1003",
            name: "Casey Sample",
            slug: "casey-sample",
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

  it("labels a group with no evidence kinds 'no labelled signal'", () => {
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
    expect(screen.getByText("1 paper · no labelled signal")).toBeTruthy();
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ written: 2, skipped: 0, notFound: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add PMIDs/ }));
    fireEvent.change(screen.getByLabelText("Claim known PMIDs directly"), {
      target: { value: "111, 222\n222" }, // dupe collapses client-side
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/edit/core-claim/bulk");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", pmids: ["111", "222"], status: "claimed" });
    // "Claimed 2." lands in both the result line and the aria-live announcer —
    // scope to the status paragraph specifically.
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Claimed 2."));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("reports skipped/not-found pmids and does NOT refresh when nothing new was written", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ written: 0, skipped: 1, notFound: ["999"] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add PMIDs/ }));
    fireEvent.change(screen.getByLabelText("Claim known PMIDs directly"), {
      target: { value: "1 999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
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
    fireEvent.change(screen.getByLabelText("Claim known PMIDs directly"), {
      target: { value: "abc, def" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    expect(screen.getByText(/No valid PMIDs found \(ignored: abc, def\)\./)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
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

  it("highlights the core-staff author inline in the byline (best-effort)", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    // the "Testerson A" token links to the staff profile
    const chip = screen.getByText("Testerson A");
    expect(chip.closest("a")?.getAttribute("href")).toBe("/alex-testerson");
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
});

describe("evidenceGroupKey / evidenceGroupLabel / bandRange", () => {
  it("keys a row by which evidence kinds fired, prior excluded", () => {
    expect(evidenceGroupKey(row())).toBe("ack+coauthor+llm+affinity");
    // the prefilter prior restates the repeat-user prior, so it never splits a pile
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
    expect(evidenceGroupLabel("none", 2)).toBe("2 papers · no labelled signal");
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

  it("adds the prefilter prior as a fifth signal, ordered after affinity", () => {
    const signals = buildSignals(row({ topicalPrior: 0.4 }));
    expect(signals.map((s) => s.kind)).toEqual(["ack", "coauthor", "llm", "affinity", "topic"]);
    expect(signals.at(-1)).toMatchObject({ kind: "topic", dots: 1, strength: "Weak" });
  });

  it("leaves the four-signal behavior unchanged when topicalPrior is null", () => {
    const signals = buildSignals(row({ topicalPrior: null }));
    expect(signals.map((s) => s.kind)).toEqual(["ack", "coauthor", "llm", "affinity"]);
    expect(signals).toHaveLength(4);
  });

  it("does not render a chip for a prior of 0 (neither prefilter signal fired)", () => {
    // Absent evidence, not weak evidence — a "0%" chip claims a readout it has none of.
    const signals = buildSignals(row({ topicalPrior: 0 }));
    expect(signals.map((s) => s.kind)).toEqual(["ack", "coauthor", "llm", "affinity"]);
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
describe("CoreClaimQueue — Known clients toolbar wiring", () => {
  it("renders Known clients with a PARENTHESISED count, first of the three header buttons", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[]}
        clients={[
          {
            cwid: "aaa1001",
            name: "Alex Testerson",
            slug: "alex-testerson",
            addedAt: new Date("2026-01-01"),
            addedBy: "rev01",
          },
        ]}
      />,
    );
    const knownClients = screen.getByRole("button", { name: /Known clients/ });
    const addPmids = screen.getByRole("button", { name: /Add PMIDs/ });
    const reporting = screen.getByRole("button", { name: /Reporting/ });
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

  it("ships 'Reporting...' DISABLED with the reason on it — there is no reporting route", () => {
    // An enabled control that no-ops is the failure this codebase keeps hitting.
    // The button is drawn because the mockup draws it; it is inert and SAYS so.
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const reporting = screen.getByRole("button", { name: /Reporting/ }) as HTMLButtonElement;
    expect(reporting.textContent).toContain("Reporting...");
    expect(reporting.getAttribute("aria-disabled")).toBe("true");
    // NOT the native `disabled` attribute: that drops it from the tab order, which
    // would hide the reason from exactly the keyboard and screen-reader users most
    // likely to wonder why the button does nothing.
    expect(reporting.disabled).toBe(false);
    expect(reporting.getAttribute("title")).toBe("Reporting view is not built yet");
    // the reason is in the accessibility tree, not only in a hover tooltip
    const why = document.getElementById(reporting.getAttribute("aria-describedby") ?? "");
    expect(why?.textContent).toBe("Reporting view is not built yet");
    // and NOT a link: /edit/reports 404s for a scoped Owner/Curator whose only
    // unit is a core, which is exactly who reads this page. `feat/core-reports-
    // access` makes cores reportable and deep-links this control; until then a
    // link here is worse than a button that says it is not built.
    expect(screen.queryByRole("link", { name: /Reporting/ })).toBeNull();
  });

  it("draws the three buttons as text-only rounded rectangles — no icons, no pills", () => {
    // The mockup's toolbar is plain rectangles with labels; the shipped pills
    // carried a lucide glyph each (Users / Plus / FileText). Only the SHAPE
    // changed on "Reporting..." — its inert treatment is asserted above, and the
    // three still have to MATCH on height, border and text size or the group
    // stops reading as one.
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    for (const name of [/Known clients/, /Add PMIDs/, /Reporting/]) {
      const button = screen.getByRole("button", { name });
      expect(button.querySelector("svg")).toBeNull();
      expect(button.className).toContain("rounded-md");
      expect(button.className).not.toContain("rounded-full");
      expect(button.className).toContain("h-8");
      expect(button.className).toContain("text-sm");
      expect(button.className).toContain("border");
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
    // FULL journal, not the abbreviation the card now shows
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

  it("opens the panel body as a sibling of the toolbar (not nested inside it) on click", () => {
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={[]} />);
    // absent before the click
    expect(screen.queryByLabelText("CWIDs")).toBeNull();

    const toggle = screen.getByRole("button", { name: /Known clients/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);

    // present after, and NOT a descendant of the toolbar row the button lives in
    const textarea = screen.getByLabelText("CWIDs");
    expect(textarea).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    // The OUTER toolbar row is the justify-between container holding the staff
    // chip and the three header buttons — not just the inner "flex flex-wrap
    // items-center gap-2" button group. `toggle.closest("div")` alone would
    // only find that inner group and miss a regression that nests the panel
    // inside the outer row.
    const outerRow = toggle.closest('[data-slot="core-queue-toolbar"]');
    expect(outerRow).toBeTruthy();
    expect(outerRow?.className).toContain("justify-between");
    expect(outerRow?.contains(textarea)).toBe(false);

    // And the panel body is a later sibling in the same parent as the
    // Add PMIDs block sits in — not merely "somewhere outside" the toolbar.
    const addPmids = screen.getByRole("button", { name: /Add PMIDs/ });
    const commonParent = outerRow?.parentElement;
    expect(commonParent?.contains(addPmids)).toBe(true);
    expect(commonParent?.contains(textarea)).toBe(true);
    const position = outerRow?.compareDocumentPosition(textarea) ?? 0;
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
