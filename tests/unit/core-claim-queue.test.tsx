/**
 * The per-core review queue client component (components/edit/core-claim-queue).
 * Renders candidate evidence and posts confirm/reject to /api/edit/core-claim with
 * optimistic local state. fetch is mocked — no DB/network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CoreClaimQueue } from "@/components/edit/core-claim-queue";
import type { CoreQueueRow } from "@/lib/api/core-queue";

function row(over: Partial<CoreQueueRow> = {}): CoreQueueRow {
  return {
    pmid: "30418319",
    title: "Advanced MRI of the brain",
    journal: "NeuroImage",
    year: 2021,
    authorsString: "Ballon D, Dyke J",
    fullAuthorsString: "Ballon D, Dyke J, Xiang J",
    abstract: "We imaged the brain in detail.",
    synopsis: "A faster MRI sequence.",
    likelihood: 0.82,
    status: "candidate",
    coauthors: ["djb2001"],
    coauthorScholars: [{ cwid: "djb2001", name: "Doug Ballon", slug: "doug-ballon", dept: "Radiology" }],
    wcmAuthors: [{ cwid: "jx2001", name: "Jenny Xiang", slug: "jenny-xiang", dept: "Genomics" }],
    signalAck: true,
    ackAlias: "CBIC",
    ackSnippet: "processed at the Citigroup Biomedical Imaging Center",
    llmScore: 7,
    llmRationale: "Acknowledges the imaging core for confocal microscopy.",
    authorAffinity: 0.42,
    citationCount: 12,
    pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/30418319/",
    doi: "10.1016/j.neuroimage.2021.001",
    ...over,
  };
}

const CORE = { id: "2", name: "Biomedical Imaging" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoreClaimQueue", () => {
  it("renders a candidate with its per-signal evidence breakdown", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.getByText("Advanced MRI of the brain")).toBeTruthy();
    expect(screen.getByText("82% likely")).toBeTruthy();
    expect(screen.getByText("Repeat-user 42%")).toBeTruthy();
    expect(screen.getByText("Named: CBIC")).toBeTruthy();
    expect(screen.getByText("1 core-staff co-author")).toBeTruthy();
    expect(screen.getByText("LLM 7/10")).toBeTruthy();
  });

  it("renders the LLM rationale, citation count, and PubMed/DOI links", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(
      screen.getByText("Acknowledges the imaging core for confocal microscopy."),
    ).toBeTruthy();
    expect(screen.getByText("12 citations")).toBeTruthy();
    const pubmed = screen.getByRole("link", { name: /pubmed/i });
    expect(pubmed.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/30418319/");
    const doi = screen.getByRole("link", { name: /doi/i });
    expect(doi.getAttribute("href")).toBe("https://doi.org/10.1016/j.neuroimage.2021.001");
  });

  it("falls back to a generic ack chip when signalAck is set without an alias", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ ackAlias: null, signalAck: true })]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText("Acknowledged in text")).toBeTruthy();
  });

  it("omits a signal chip when its signal did not fire", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ authorAffinity: null, coauthors: [], signalAck: false, ackAlias: null })]}
        confirmed={[]}
      />,
    );
    expect(screen.queryByText(/Repeat-user/)).toBeNull();
    expect(screen.queryByText(/co-author/)).toBeNull();
    expect(screen.queryByText(/Named:|Acknowledged/)).toBeNull();
  });

  it("renders the synopsis and links resolved core-staff co-authors to their profile (Tier 2)", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.getByText("A faster MRI sequence.")).toBeTruthy();
    const staff = screen.getByRole("link", { name: "Doug Ballon" });
    expect(staff.getAttribute("href")).toBe("/doug-ballon");
    expect(screen.getByText(/\(Radiology\)/)).toBeTruthy();
  });

  it("shows an unresolved core-staff CWID as bare text (Tier 2 fallback)", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ coauthors: ["djb2001", "zzz9999"], coauthorScholars: row().coauthorScholars })]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText(/zzz9999/)).toBeTruthy();
  });

  it("exposes abstract, full author list, and linked WCM authors in the details expander (Tier 2)", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.getByText("We imaged the brain in detail.")).toBeTruthy();
    expect(screen.getByText(/Ballon D, Dyke J, Xiang J/)).toBeTruthy();
    const wcm = screen.getByRole("link", { name: "Jenny Xiang" });
    expect(wcm.getAttribute("href")).toBe("/jenny-xiang");
  });

  it("posts a claim and moves the row out of the review list on Confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/edit/core-claim");
    expect(JSON.parse(init.body)).toEqual({ pmid: "30418319", coreId: "2", status: "claimed" });

    // the confirmed row leaves "To review" (its Confirm button is gone)
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull(),
    );
  });

  it("surfaces an error and keeps the row when the POST is refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "not_core_owner" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("not_core_owner"),
    );
    // still reviewable — the Confirm button is still present
    expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();
  });
});
