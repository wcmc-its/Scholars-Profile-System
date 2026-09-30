/**
 * Core Review Queue v2 PR B, client side (components/edit/core-claim-queue):
 * bulk Revoke / Restore on the Confirmed / Rejected tabs behind the inline
 * guard, their search + Filters, Add PMIDs' "Send to review" mode, and the
 * unscored "Added by you" rail group. fetch is mocked — no DB/network.
 *
 * Every fixture value is synthetic: made-up names, CWIDs and PMIDs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

import {
  ADDED_GROUP,
  buildEvidenceGroups,
  CoreClaimQueue,
  evidenceGroupKey,
  evidenceGroupName,
  historyGuardText,
  revokeStatusFor,
  undoDestination,
} from "@/components/edit/core-claim-queue";
import type { CoreQueueRow } from "@/lib/api/core-queue";

function row(over: Partial<CoreQueueRow> = {}): CoreQueueRow {
  return {
    pmid: "30000001",
    title: "A synthetic imaging paper",
    journal: "Synthetic Journal of Core Science",
    journalAbbrev: "Synth J Core Sci",
    year: 2022,
    dateAddedToEntrez: "2026-02-18",
    authorsString: "Testerson A, Fixture B",
    fullAuthorsString: "Testerson A, Fixture B",
    abstract: null,
    synopsis: null,
    likelihood: 0.82,
    status: "candidate",
    coauthors: [],
    coauthorScholars: [],
    wcmAuthors: [],
    signalAck: true,
    ackAlias: "SYNCORE",
    ackSnippet: "imaged at the SYNCORE facility",
    llmScore: 7,
    llmRationale: "Acknowledges the core.",
    authorAffinity: 0.2,
    topicalPrior: null,
    methodTier: null,
    methodEvidence: [],
    citationCount: 0,
    pubmedUrl: null,
    doi: null,
    claimed: false,
    isManual: false,
    relativeCitationRatio: null,
    nihPercentile: null,
    meshTerms: [],
    ...over,
  };
}

const CORE = { id: "2", name: "Synthetic Imaging", staffCount: null, staffTrackedCount: null };

/** A manual row the engine never scored, sent to review by PMID. */
const queuedRow = (pmid: string, title: string) =>
  row({
    pmid,
    title,
    likelihood: 0,
    status: "unscored",
    isManual: true,
    queued: true,
    signalAck: false,
    ackAlias: null,
    ackSnippet: null,
    llmScore: null,
    llmRationale: null,
    authorAffinity: null,
  });

function okFetch(body: unknown = { ok: true }) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => body });
}

function bodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: url as string,
    body: JSON.parse((init as { body: string }).body),
  }));
}

function historyGuard(): HTMLElement | null {
  return document.querySelector('[data-slot="core-queue-history-guard"]');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mockRefresh.mockReset();
});

describe("bulk Revoke on the Confirmed tab", () => {
  const confirmed = [
    row({ pmid: "31", title: "Claimed alpha", claimed: true }),
    row({ pmid: "32", title: "Claimed beta", claimed: true }),
    // The engine confirmed this one on its own: a revoke has to post `rejected`.
    row({ pmid: "33", title: "Engine gamma", claimed: false, status: "confirmed" }),
  ];

  it("arms an inline guard first and posts NOTHING until the guard is confirmed", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={confirmed} />);
    fireEvent.click(screen.getByLabelText("Select Claimed alpha"));
    fireEvent.click(screen.getByLabelText("Select Claimed beta"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke 2 selected" }));
    // the delta's copy, verbatim
    expect(historyGuard()?.textContent).toContain(
      "Revoke 2 confirmed papers? They return to review. Each gets its own audit row.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // Cancel backs out with nothing written
    fireEvent.click(within(historyGuard()!).getByRole("button", { name: "Cancel" }));
    expect(historyGuard()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirmed guard posts one bulk request per write kind, and each row keeps its Undo", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={confirmed} />);
    fireEvent.click(screen.getByLabelText(/^Select all 3/));
    fireEvent.click(screen.getByRole("button", { name: "Revoke 3 selected" }));
    // not every row returns to review, and the guard says so
    expect(historyGuard()?.textContent).toContain(
      "Revoke 3 confirmed papers? 2 return to review, 1 moves to Rejected (the engine confirmed it on its own). Each gets its own audit row.",
    );
    fireEvent.click(within(historyGuard()!).getByRole("button", { name: "Revoke 3" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodies(fetchMock)).toEqual([
      {
        url: "/api/edit/core-claim/bulk",
        body: { coreId: "2", pmids: ["31", "32"], status: "revoked" },
      },
      {
        url: "/api/edit/core-claim/bulk",
        body: { coreId: "2", pmids: ["33"], status: "rejected" },
      },
    ]);
    await waitFor(() =>
      expect(screen.getAllByText(/— Revoked, re-files on next load/)).toHaveLength(3),
    );
    expect(screen.getAllByRole("button", { name: /^undo$/i })).toHaveLength(3);
    // the bar is back to nothing selected
    expect(screen.getByRole("button", { name: "Revoke selected" })).toBeTruthy();
  });

  it("marks the rows of a failed chunk and does not show them revoked", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={confirmed.slice(0, 2)} />);
    fireEvent.click(screen.getByLabelText(/^Select all 2/));
    fireEvent.click(screen.getByRole("button", { name: "Revoke 2 selected" }));
    fireEvent.click(within(historyGuard()!).getByRole("button", { name: "Revoke 2" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.queryByText(/re-files on next load/)).toBeNull();
  });

  it("single-row Revoke stays unguarded (posts at once)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={confirmed.slice(0, 1)} />);
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(historyGuard()).toBeNull();
  });

  it("a claim on top of an ENGINE confirmation revokes with 'rejected' (a soft revoke would leave it confirmed)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[row({ pmid: "34", title: "Both", claimed: true, status: "confirmed" })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodies(fetchMock)[0].body.status).toBe("rejected");
    // and its Undo restores the claim
    fireEvent.click(await screen.findByRole("button", { name: /^undo$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodies(fetchMock)[1].body.status).toBe("claimed");
  });

  it("the search narrows the Confirmed list, and Select all acts on what is shown", () => {
    vi.stubGlobal("fetch", okFetch());
    render(<CoreClaimQueue core={CORE} candidates={[]} confirmed={confirmed} />);
    fireEvent.change(screen.getByLabelText("Filter confirmed papers"), {
      target: { value: "gamma" },
    });
    const list = screen.getByRole("list", { name: "Confirmed papers" });
    expect(within(list).getByText("Engine gamma")).toBeTruthy();
    expect(within(list).queryByText("Claimed alpha")).toBeNull();
    fireEvent.click(screen.getByLabelText(/^Select all 1 matching/));
    expect(screen.getByRole("button", { name: "Revoke 1 selected" })).toBeTruthy();
  });
});

describe("bulk Restore on the Rejected tab", () => {
  it("guards, then soft-revokes every selected rejection in one request", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoreClaimQueue
        core={CORE}
        candidates={[]}
        confirmed={[]}
        rejected={[
          row({ pmid: "41", title: "Rejected one", claimed: true }),
          row({ pmid: "42", title: "Rejected two", claimed: true }),
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText(/^Select all 2/));
    fireEvent.click(screen.getByRole("button", { name: "Restore 2 selected" }));
    expect(historyGuard()?.textContent).toContain(
      "Restore 2 rejected papers? They return to review. Each gets its own audit row.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(historyGuard()!).getByRole("button", { name: "Restore 2" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodies(fetchMock)[0]).toEqual({
      url: "/api/edit/core-claim/bulk",
      body: { coreId: "2", pmids: ["41", "42"], status: "revoked" },
    });
    await waitFor(() =>
      expect(screen.getAllByText(/— Restored, re-files on next load/)).toHaveLength(2),
    );
  });
});

describe('"Added by you" (Send to review) on the To review tab', () => {
  const candidates = [
    row({ pmid: "51", title: "Engine candidate" }),
    queuedRow("52", "Sent by hand"),
  ];

  it("leads the rail as an unscored group, and its rows carry no band", () => {
    render(<CoreClaimQueue core={CORE} candidates={candidates} confirmed={[]} />);
    const items = [...document.querySelectorAll('[data-slot="core-queue-rail-item"]')].map((b) =>
      b.textContent?.replace(/\s+/g, " ").trim(),
    );
    // "All candidates" first, then "Added by you" ahead of the engine groups
    expect(items[1]).toBe("Added by youUnscored · added by PMID1");
    const sent = document.querySelector(
      '[data-slot="core-queue-row"][data-pmid="52"]',
    ) as HTMLElement;
    expect(sent.textContent).toContain("Added by you");
    expect(sent.textContent).not.toMatch(/\d+%/);
    const engine = document.querySelector(
      '[data-slot="core-queue-row"][data-pmid="51"]',
    ) as HTMLElement;
    expect(engine.textContent).toContain("82%");
  });

  it("the focused paper says it was added by PMID, not that the engine found nothing", () => {
    render(
      <CoreClaimQueue core={CORE} candidates={[queuedRow("52", "Sent by hand")]} confirmed={[]} />,
    );
    const pane = document.querySelector('[data-slot="core-queue-focus"]') as HTMLElement;
    expect(within(pane).getByText("Added by you")).toBeTruthy();
    expect(within(pane).getByText("Not scored by the engine · added by PMID")).toBeTruthy();
    expect(pane.querySelector('[data-slot="core-queue-added-note"]')).toBeTruthy();
    expect(pane.textContent).not.toContain("No prior core usage anywhere on this byline");
    expect(pane.textContent).not.toContain("No counted signal");
  });

  it("choosing the group narrows the list to it", () => {
    render(<CoreClaimQueue core={CORE} candidates={candidates} confirmed={[]} />);
    const added = [...document.querySelectorAll('[data-slot="core-queue-rail-item"]')].find((b) =>
      b.textContent?.startsWith("Added by you"),
    ) as HTMLElement;
    fireEvent.click(added);
    expect(document.querySelector('[data-slot="core-queue-row"][data-pmid="51"]')).toBeNull();
    expect(document.querySelector('[data-slot="core-queue-row"][data-pmid="52"]')).toBeTruthy();
  });
});

describe('Add PMIDs → "Send to review"', () => {
  it("checks on the queue-add route, then adds, refreshes, and lands on Added by you", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dryRun: true,
          added: 0,
          wouldAdd: 2,
          inQueue: 1,
          decided: 1,
          notFound: ["99"],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ added: 2, inQueue: 1, decided: 1, notFound: ["99"] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row({ pmid: "51" })]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add PMIDs/ }));
    const dialog = document.querySelector('[data-slot="core-claim-pmid-dialog"]') as HTMLElement;
    // "Confirm now" is the default; switch modes
    expect(
      within(dialog)
        .getByRole("radio", { name: /Confirm now/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(dialog).getByRole("radio", { name: /Send to review/ }));
    fireEvent.change(within(dialog).getByLabelText("Paste PMIDs"), {
      target: { value: "61 62 63 64 99 abc" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Check PMIDs" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodies(fetchMock)[0]).toEqual({
      url: "/api/edit/core-queue-add",
      body: { coreId: "2", pmids: ["61", "62", "63", "64", "99"], dryRun: true },
    });
    const check = await waitFor(() => {
      const el = dialog.querySelector('[data-slot="core-claim-pmid-check"]');
      if (!el) throw new Error("no check yet");
      return el as HTMLElement;
    });
    expect(check.textContent).toContain("2 ready to add to review.");
    expect(check.textContent).toContain("1 already in this core's To review list.");
    expect(check.textContent).toContain("1 already decided for this core");
    expect(check.textContent).toContain("Not in Scholars, will be skipped: 99.");
    expect(check.textContent).toContain("Not a PMID: abc.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Add 2 to review" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodies(fetchMock)[1]).toEqual({
      url: "/api/edit/core-queue-add",
      body: { coreId: "2", pmids: ["61", "62", "63", "64", "99"] },
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByRole("status").textContent).toContain("Added 2 to review.");
  });

  it("a mode change drops the previous mode's check (the commit re-disables)", async () => {
    const fetchMock = okFetch({ dryRun: true, wouldWrite: 1, skipped: 0, notFound: [] });
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreClaimQueue core={CORE} candidates={[row()]} confirmed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add PMIDs/ }));
    fireEvent.change(screen.getByLabelText("Paste PMIDs"), { target: { value: "61" } });
    fireEvent.click(screen.getByRole("button", { name: "Check PMIDs" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Claim publications" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("radio", { name: /Send to review/ }));
    expect(
      (screen.getByRole("button", { name: "Add to review" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("PR B pure helpers", () => {
  it("revokeStatusFor: soft revoke only when a claim is all that confirms the paper", () => {
    expect(revokeStatusFor(row({ claimed: true }))).toBe("revoked");
    expect(revokeStatusFor(row({ claimed: false, status: "confirmed" }))).toBe("rejected");
    expect(revokeStatusFor(row({ claimed: true, status: "confirmed" }))).toBe("rejected");
    // a manual add's "confirmed" is the loader's placeholder, not an engine verdict
    expect(revokeStatusFor(row({ claimed: true, status: "confirmed", isManual: true }))).toBe(
      "revoked",
    );
  });

  it("undoDestination / historyGuardText name where rows go", () => {
    const manual = row({ claimed: true, status: "confirmed", isManual: true });
    expect(undoDestination(manual, "confirmed")).toBe("gone");
    expect(undoDestination({ ...manual, queued: true }, "confirmed")).toBe("review");
    expect(undoDestination(row({ claimed: true, status: "confirmed" }), "rejected")).toBe(
      "confirmed",
    );
    expect(historyGuardText("confirmed", [row({ claimed: true })])).toBe(
      "Revoke 1 confirmed paper? It returns to review. Each gets its own audit row.",
    );
    expect(
      historyGuardText("rejected", [row({ claimed: true, status: "confirmed" }), manual]),
    ).toBe(
      "Restore 2 rejected papers? 1 goes back to Confirmed (the engine confirmed it on its own), 1 leaves the queue. Each gets its own audit row.",
    );
  });

  it("a queued row is its own evidence group, listed first", () => {
    const q = queuedRow("52", "Sent");
    expect(evidenceGroupKey(q)).toBe(ADDED_GROUP);
    expect(evidenceGroupName(ADDED_GROUP)).toBe("Added by you");
    const groups = buildEvidenceGroups([row({ pmid: "51" }), q], new Map());
    expect(groups.map((g) => g.key)[0]).toBe(ADDED_GROUP);
    expect(groups).toHaveLength(2);
  });
});
