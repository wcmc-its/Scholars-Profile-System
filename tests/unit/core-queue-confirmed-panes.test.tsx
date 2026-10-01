/**
 * The core review queue's Confirmed tab as three panes (Core publication queue
 * mockup refresh, PR 4): the rail (By evidence / By person, off the same
 * builders as To review), the list with each paper's four-cell signal strip,
 * the sort pills, and the paper pane ("Why this was confirmed", Revoke/Undo).
 * The pure helpers first, then the tab as rendered.
 *
 * Every fixture value here is synthetic: made-up titles, names, CWIDs and PMIDs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  ADDED_GROUP,
  buildEvidenceGroups,
  buildRailPeople,
  confirmedEvidence,
  CoreClaimQueue,
  evidenceGroupKey,
  signalStrip,
  withoutOwnPaper,
} from "@/components/edit/core-claim-queue";
import type { CoreQueueRow } from "@/lib/api/core-queue";

const PAT = { cwid: "zzz9001", name: "Pat Example", slug: "pat-example", dept: "Medicine" };
const SAM = { cwid: "zzz9002", name: "Sam Sample", slug: "sam-sample", dept: null };

function row(over: Partial<CoreQueueRow> = {}): CoreQueueRow {
  return {
    pmid: "90000001",
    title: "Synthetic paper",
    journal: "Synthetic Journal",
    journalAbbrev: "Synth J",
    year: 2021,
    dateAddedToEntrez: "2026-02-18",
    authorsString: "Example P",
    fullAuthorsString: "Example P",
    abstract: null,
    synopsis: null,
    likelihood: 0.95,
    status: "confirmed",
    coauthors: [],
    coauthorScholars: [],
    wcmAuthors: [],
    signalAck: false,
    ackAlias: null,
    ackSnippet: null,
    llmScore: 8,
    llmRationale: "Synthetic rationale.",
    authorAffinity: null,
    topicalPrior: null,
    methodTier: null,
    methodEvidence: [],
    citationCount: 0,
    pubmedUrl: null,
    doi: null,
    claimed: true,
    isManual: false,
    relativeCitationRatio: null,
    nihPercentile: null,
    meshTerms: [],
    ...over,
  };
}

const CORE = { id: "2", name: "Synthetic Core", staffCount: 4, staffTrackedCount: 1 };

/** Pat has three confirmed papers here, so on any one of them two came before. */
const COUNTS = { zzz9001: { papers: 3, recent: 1, total: 20 } };

const ackRow = row({
  pmid: "90000011",
  title: "Acknowledged alpha",
  year: 2019,
  likelihood: 0.99,
  signalAck: true,
  ackAlias: "Synthetic Core Facility",
  ackSnippet: "We thank the Synthetic Core Facility for support.",
});
const repeatRow = row({
  pmid: "90000012",
  title: "Repeat beta",
  year: 2024,
  likelihood: 0.9,
  wcmAuthors: [PAT],
  authorAffinity: 0.3,
});
const llmOnly = row({
  pmid: "90000013",
  title: "Model gamma",
  year: 2022,
  likelihood: 0.86,
  llmScore: 6,
  llmRationale: null,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signalStrip", () => {
  it("lists all four signals strongest first, marking the ones that fired", () => {
    expect(signalStrip(ackRow)).toEqual([
      { kind: "ack", label: "Ack", name: "Acknowledgment", fired: true },
      { kind: "coauthor", label: "Staff", name: "Staff co-author", fired: false },
      { kind: "llm", label: "LLM", name: "LLM read", fired: true },
      { kind: "affinity", label: "Repeat", name: "Repeat user", fired: false },
    ]);
  });

  it("does not fire Repeat when the row is the person's only confirmed paper", () => {
    const only = { zzz9001: { papers: 1, recent: 1, total: 20 } };
    const fired = (counts: typeof only) =>
      signalStrip(repeatRow, withoutOwnPaper(repeatRow, counts)).find((c) => c.kind === "affinity")
        ?.fired;
    expect(fired(only)).toBe(false);
    expect(fired(COUNTS)).toBe(true);
  });
});

describe("confirmedEvidence", () => {
  it("says what fired and what did not, in the queue's own sentences", () => {
    const ev = confirmedEvidence(repeatRow, withoutOwnPaper(repeatRow, COUNTS));
    expect(ev.map((e) => [e.kind, e.fired, e.head])).toEqual([
      ["ack", false, "Did not fire: no core alias in the acknowledgments"],
      ["coauthor", false, "Did not fire: no core staff on the byline"],
      ["llm", true, "8/10 · Reads as core work"],
      [
        "affinity",
        true,
        "Pat Example has used the core on 2 previous occasions (out of 19 publications).",
      ],
    ]);
    expect(ev[2].body).toBe("Synthetic rationale.");
  });

  it("quotes the acknowledgment and names the core staff", () => {
    const ev = confirmedEvidence(
      row({ ...ackRow, coauthors: ["zzz9001", "zzz9003"], coauthorScholars: [PAT] }),
      {},
    );
    expect(ev[0].head).toBe("Named in the acknowledgments as “Synthetic Core Facility”");
    expect(ev[0].quote).toBe("We thank the Synthetic Core Facility for support.");
    expect(ev[1].head).toBe("Pat Example, zzz9003, core staff, are on the byline");
  });

  it("never claims a confirmation trains the engine", () => {
    const text = confirmedEvidence(repeatRow, COUNTS)
      .map((e) => `${e.head} ${e.body ?? ""}`)
      .join(" ");
    expect(text).not.toMatch(/train|teach|next run/i);
  });
});

describe("the rail builders take any row list", () => {
  it("groups confirmed rows on their own-paper counts and counts revoked rows as not open", () => {
    const rows = [ackRow, repeatRow, llmOnly];
    const groups = buildEvidenceGroups(rows, new Set([llmOnly.pmid]), (r) =>
      withoutOwnPaper(r, COUNTS),
    );
    expect(groups.map((g) => [g.key, g.rows.length, g.open])).toEqual([
      ["ack+llm", 1, 1],
      ["llm+affinity", 1, 1],
      ["llm", 1, 0],
    ]);
    // With Pat's only paper being this one, the repeat-user pile folds into LLM.
    const only = { zzz9001: { papers: 1, recent: 1, total: 20 } };
    const folded = buildEvidenceGroups([repeatRow], new Set(), (r) => withoutOwnPaper(r, only));
    expect(folded.map((g) => g.key)).toEqual(["llm"]);
  });

  it("lists every byline person with a confirmed paper, and a revoked row is not open", () => {
    const rows = [repeatRow, row({ pmid: "90000014", wcmAuthors: [PAT, SAM] })];
    const people = buildRailPeople(rows, new Set(["90000014"]), {
      ...COUNTS,
      zzz9002: { papers: 1, recent: 0, total: 5 },
    });
    expect(people.map((p) => [p.scholar.cwid, p.rows.length, p.open])).toEqual([
      ["zzz9001", 2, 1],
      ["zzz9002", 1, 0],
    ]);
  });

  it("files a manual add under Added by you, not under 'no counted signal'", () => {
    expect(evidenceGroupKey(row({ isManual: true, llmScore: null }))).toBe(ADDED_GROUP);
  });
});

function renderConfirmed(confirmed: CoreQueueRow[], extra: Record<string, unknown> = {}) {
  return render(
    <CoreClaimQueue
      core={CORE}
      candidates={[]}
      confirmed={confirmed}
      paperCounts={COUNTS}
      {...extra}
    />,
  );
}
const list = () => screen.getByRole("list", { name: "Confirmed papers" });
const titles = () =>
  [...list().querySelectorAll('[data-slot="core-queue-confirmed-row"]')].map(
    (li) => li.querySelector("span.line-clamp-2")?.textContent,
  );
const pane = () =>
  document.querySelector('[data-slot="core-queue-confirmed-focus"]') as HTMLElement;

describe("Confirmed tab as rendered", () => {
  it("draws the three panes: rail, list with signal strips, and the first paper", () => {
    renderConfirmed([ackRow, repeatRow, llmOnly]);
    const rail = document.querySelector('[data-slot="core-queue-rail"]') as HTMLElement;
    expect(within(rail).getByRole("group", { name: "Group confirmed papers" })).toBeTruthy();
    expect(
      within(rail)
        .getAllByRole("button")
        .filter((b) => b.getAttribute("data-slot") === "core-queue-rail-item")
        .map((b) => b.textContent),
    ).toEqual([
      "All confirmed3 evidence groups3",
      "Acknowledgment + LLM readStrong band1",
      "LLM read + repeat userStrong band1",
      "LLM readStrong band1",
    ]);
    // The live staff line, as on To review.
    expect(rail.textContent).toContain("1 of 4");
    const strip = list().querySelector('[data-slot="core-queue-strip"]') as HTMLElement;
    expect(
      [...strip.querySelectorAll("[data-fired]")].map(
        (c) => `${c.firstChild?.textContent}:${c.getAttribute("data-fired")}`,
      ),
    ).toEqual(["Ack:true", "Staff:false", "LLM:true", "Repeat:false"]);
    expect(pane().textContent).toContain("1 of 3 shown");
    expect(pane().textContent).toContain("2 of 4 signals fired · on the public core page");
    expect(pane().textContent).toContain("Why this was confirmed");
    // Slate spine on the focused row only; no band spine on Confirmed (mockup).
    const rows = list().querySelectorAll('[data-slot="core-queue-confirmed-row"]');
    expect(rows[0].className).toContain("border-l-apollo-slate");
    expect(rows[1].className).toContain("border-l-transparent");
  });

  it("groups a person's only confirmed paper under its other evidence, not as repeat use", () => {
    renderConfirmed([repeatRow], { paperCounts: { zzz9001: { papers: 1, recent: 1, total: 20 } } });
    const items = [...document.querySelectorAll('[data-slot="core-queue-rail-item"]')].map(
      (b) => b.textContent,
    );
    expect(items).toEqual(["All confirmed1 evidence group1", "LLM readStrong band1"]);
  });

  it("sorts Strongest first by default, and Newest by year", () => {
    renderConfirmed([llmOnly, repeatRow, ackRow]);
    expect(titles()).toEqual(["Acknowledged alpha", "Repeat beta", "Model gamma"]);
    fireEvent.click(screen.getByRole("button", { name: "Newest" }));
    expect(titles()).toEqual(["Repeat beta", "Model gamma", "Acknowledged alpha"]);
  });

  it("narrows the list to a rail group, and By person to one person", () => {
    renderConfirmed([ackRow, repeatRow, llmOnly]);
    fireEvent.click(screen.getByRole("button", { name: /^LLM read \+ repeat user/ }));
    expect(titles()).toEqual(["Repeat beta"]);

    fireEvent.click(screen.getByRole("button", { name: "By person" }));
    expect(titles()).toHaveLength(3); // Everyone
    // The rail's entry; the summary strip has a person chip by the same name.
    const rail = document.querySelector('[data-slot="core-queue-rail"]') as HTMLElement;
    fireEvent.click(within(rail).getByRole("button", { name: /^Pat Example/ }));
    expect(titles()).toEqual(["Repeat beta"]);
    expect(screen.getByRole("heading", { name: "Confirmed with Pat Example" })).toBeTruthy();
  });

  it("steps through the list with Previous and Next, and a row click opens it", () => {
    renderConfirmed([ackRow, repeatRow, llmOnly]);
    fireEvent.click(within(pane()).getByRole("button", { name: "Next" }));
    expect(pane().getAttribute("data-pmid")).toBe(repeatRow.pmid);
    expect(pane().textContent).toContain("2 of 3 shown");
    fireEvent.click(within(pane()).getByRole("button", { name: "Previous" }));
    expect(pane().getAttribute("data-pmid")).toBe(ackRow.pmid);
    fireEvent.click(within(list()).getByText("Model gamma"));
    expect(pane().getAttribute("data-pmid")).toBe(llmOnly.pmid);
    expect(within(pane()).getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("jumps from the repeat-user row to that person's confirmed papers, keeping the paper", () => {
    renderConfirmed([ackRow, repeatRow, row({ ...llmOnly, wcmAuthors: [PAT] })]);
    fireEvent.click(within(list()).getByText("Repeat beta"));
    fireEvent.click(
      within(pane()).getByRole("button", { name: "Review all 2 confirmed papers by Pat Example" }),
    );
    expect(titles()).toEqual(["Repeat beta", "Model gamma"]);
    expect(pane().getAttribute("data-pmid")).toBe(repeatRow.pmid);
    // Already that person's list: no link back to itself.
    expect(within(pane()).queryByRole("button", { name: /^Review all/ })).toBeNull();
  });

  it("revokes an engine-only confirmation with 'rejected', and Undo puts it back", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    renderConfirmed([row({ ...ackRow, claimed: false })]);
    fireEvent.click(within(pane()).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(pane().textContent).toContain("Revoked, re-files on next load"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).status).toBe("rejected");
    expect(within(list()).getByText(/· Revoked$/)).toBeTruthy();
    // A revoked row is not selectable for the bulk Revoke.
    expect(within(list()).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(pane()).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(pane().textContent).toContain("on the public core page"));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).status).toBe("revoked");
  });

  it("keeps known-client evidence: a quiet list chip and an uncounted pane row", () => {
    renderConfirmed([repeatRow], {
      clients: [
        {
          id: "client-zzz9001",
          cwid: "zzz9001",
          name: "Pat Example",
          slug: "pat-example",
          affiliation: null,
          addedByName: null,
          addedAt: new Date("2026-01-01"),
          addedBy: "zzz9999",
        },
      ],
    });
    expect(within(list()).getByText("Client co-author").getAttribute("data-tone")).toBe("quiet");
    const client = pane().querySelector('[data-slot="core-queue-client-row"]') as HTMLElement;
    expect(client.textContent).toContain("Known client · not counted");
    expect(client.textContent).toContain("Pat Example, 3 papers, 1 recent");
  });

  it("marks a manual add in the list and gives it no score or strip", () => {
    renderConfirmed([row({ isManual: true, likelihood: 0, llmScore: null })]);
    expect(within(list()).getByText("Manually added")).toBeTruthy();
    expect(list().querySelector('[data-slot="core-queue-strip"]')).toBeNull();
    expect(pane().textContent).toContain("Not scored by the engine · on the public core page");
    expect(pane().querySelector('[data-slot="core-queue-confirmed-evidence"]')).toBeNull();
  });

  it("opens the pane as a sheet on a row tap and Escape closes it (phone layout)", () => {
    renderConfirmed([ackRow, repeatRow]);
    expect(pane().className).toContain("hidden");
    fireEvent.click(within(list()).getByText("Repeat beta"));
    expect(pane().className).toContain("fixed inset-0");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(pane().className).not.toContain("fixed inset-0");
  });
});
