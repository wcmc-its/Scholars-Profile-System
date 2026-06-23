/**
 * The per-core review queue client component (components/edit/core-claim-queue).
 * Renders candidate evidence and posts confirm/reject to /api/edit/core-claim with
 * optimistic local state. fetch is mocked — no DB/network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { buildSignals, compareBySort, CoreClaimQueue } from "@/components/edit/core-claim-queue";
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
    claimed: false,
    relativeCitationRatio: null,
    nihPercentile: null,
    ...over,
  };
}

const CORE = { id: "2", name: "Biomedical Imaging" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoreClaimQueue", () => {
  it("renders a candidate with its combined-likelihood bar and per-signal rows", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    expect(screen.getByText("Advanced MRI of the brain")).toBeTruthy();
    // combined-likelihood bar
    expect(screen.getByText("Combined likelihood")).toBeTruthy();
    expect(screen.getByText("82%")).toBeTruthy();
    expect(screen.getByText(/4 of 4 signals fired/)).toBeTruthy();
    // one row per fired signal, with fixed-per-type tiers + raw readout in the meter
    expect(screen.getByText("Named in the acknowledgments")).toBeTruthy();
    expect(screen.getByText("Direct")).toBeTruthy(); // ack tier
    expect(screen.getByRole("link", { name: "Doug Ballon" })).toBeTruthy(); // co-author row
    expect(screen.getByText("LLM triage")).toBeTruthy();
    expect(screen.getByText("Moderate")).toBeTruthy(); // LLM is Moderate regardless of 7/10
    expect(screen.getByText("7/10")).toBeTruthy(); // raw score still shown
    expect(screen.getByText("Repeat user of this core")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy(); // affinity readout
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
    expect(screen.queryByText(/Repeat user of this core/)).toBeNull();
    expect(screen.queryByText(/Co-authored with/)).toBeNull();
    expect(screen.queryByText(/Named in the acknowledgments|Acknowledged in text/)).toBeNull();
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

  // --- Tier 3: undo / keyboard / filter / sort ---

  it("undo posts a revoke and restores the actionable card (Tier 3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    const undo = await screen.findByRole("button", { name: /undo/i });
    fireEvent.click(undo);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body)).toEqual({
      pmid: "30418319",
      coreId: "2",
      status: "revoked",
    });
    // the card is actionable again
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy());
  });

  it("confirms via the 'a' keyboard shortcut on the focused card (Tier 3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    fireEvent.keyDown(container.querySelector("[data-card]") as HTMLElement, { key: "a" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).status).toBe(
      "claimed",
    );
  });

  it("filters the visible candidates (Tier 3)", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Acknowledged" }));
    expect(screen.getByText("Acked paper")).toBeTruthy();
    expect(screen.queryByText("Bare paper")).toBeNull();
  });

  it("re-sorts by LLM score when selected (Tier 3)", () => {
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
    const titles = () =>
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    // default is uncertain-first; pin a likelihood baseline before testing LLM sort
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "likelihood" } });
    expect(titles()).toEqual(["High likelihood, low LLM", "Low likelihood, high LLM"]);

    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "llm" } });
    expect(titles()).toEqual(["Low likelihood, high LLM", "High likelihood, low LLM"]);
  });

  it("defaults to uncertain-first ordering", () => {
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
    expect(titles).toEqual(["Borderline", "Near-certain"]); // closest to 0.5 first
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
    const titles = () =>
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "likelihood" } });
    expect(titles()).toEqual(["Very confident", "Coin-flip"]);
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "uncertain" } });
    expect(titles()).toEqual(["Coin-flip", "Very confident"]);
  });

  it("announces the outcome politely for screen readers (Tier 3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    const live = screen.getByTestId("core-claim-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe(""); // silent until an action

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() =>
      expect(live.textContent).toBe("Confirmed Advanced MRI of the brain."),
    );
  });

  it("rejects via the 'r' shortcut and undoes via 'u' on the decided card (Tier 3)", async () => {
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

  it("ArrowDown moves roving focus to the next card (Tier 3)", () => {
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

  it("does NOT fire a shortcut typed into a child control (the shell-only guard) (Tier 3)", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);

    // 'a' typed while the Confirm button (a child) is focused must NOT claim.
    fireEvent.keyDown(screen.getByRole("button", { name: /confirm/i }), { key: "a" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a just-decided row visible under a filter that would exclude it, so undo stays reachable (Tier 3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    // a candidate that does NOT match the "Acknowledged" filter
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ signalAck: false, ackAlias: null })]}
        confirmed={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await screen.findByRole("button", { name: /undo/i });

    fireEvent.click(screen.getByRole("button", { name: "Acknowledged" }));
    // still shown via the decided-row override, so its Undo is reachable
    expect(screen.getByRole("button", { name: /undo/i })).toBeTruthy();
  });

  // --- bulk confirm / Confirmed-list revoke / verify-in-expander ---

  it("bulk-confirms the high-confidence band (≥0.90) in one click", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true)); // accept the guard dialog
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[
          row({ pmid: "1", title: "High A", likelihood: 0.96 }),
          row({ pmid: "2", title: "High B", likelihood: 0.91 }),
          row({ pmid: "3", title: "Uncertain", likelihood: 0.6 }),
        ]}
        confirmed={[]}
      />,
    );
    const bulk = screen.getByRole("button", { name: /Confirm 2 high-confidence/ });
    fireEvent.click(bulk);
    // only the two ≥0.90 rows are posted, each as a claim
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const posted = fetchMock.mock.calls.map(
      (c) => JSON.parse((c as [string, { body: string }])[1].body) as { pmid: string; status: string },
    );
    expect(posted.every((p) => p.status === "claimed")).toBe(true);
    expect(posted.map((p) => p.pmid).sort()).toEqual(["1", "2"]);
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
    expect(await screen.findByText(/Revoked — Claimed pub/)).toBeTruthy();
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
    expect(
      JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).status,
    ).toBe("rejected");
  });

  it("suppresses a 0 on a just-published paper as 'No citations yet'", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ citationCount: 0, year: 9999 })]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText(/No citations yet · published 9999/)).toBeTruthy();
  });

  it("shows RCR and percentile when present", () => {
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ relativeCitationRatio: 2.1, nihPercentile: 89 })]}
        confirmed={[]}
      />,
    );
    expect(screen.getByText(/RCR 2.1 \(89th pct\)/)).toBeTruthy();
  });

  it("renders abstract inline markup as real subscript, not escaped text", () => {
    const { container } = render(
      <CoreClaimQueue
        core={CORE}
        candidates={[row({ abstract: "We used NaN<sub>3</sub> in buffer." })]}
        confirmed={[]}
      />,
    );
    expect(container.querySelector("sub")?.textContent).toBe("3");
  });

  it("highlights the core-staff author inline in the byline (best-effort)", () => {
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    // "Ballon D" token links to Doug Ballon's profile
    const chip = screen.getByText("Ballon D");
    expect(chip.closest("a")?.getAttribute("href")).toBe("/doug-ballon");
  });
});

describe("buildSignals", () => {
  it("returns only fired signals, scored and ordered strongest-first", () => {
    const signals = buildSignals(row()); // all four fire
    expect(signals.map((s) => s.kind)).toEqual(["ack", "coauthor", "llm", "affinity"]);
    expect(signals[0]).toMatchObject({ kind: "ack", dots: 4, strength: "Direct" });
    expect(signals.at(-1)).toMatchObject({ kind: "affinity", dots: 1, strength: "Weak" });
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
});
