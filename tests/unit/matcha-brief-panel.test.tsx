/**
 * Matcha Phase 3 — the brief UI in the panel (MATCHA_BRIEF).
 *
 * Pinned here:
 *  - "Draft briefs (top 10)" posts ONE request per PI, only for the current view's top 10 that
 *    lack a brief, at most 4 in flight;
 *  - "Draft briefs (N shortlisted)" drafts the ticked rows, capped at 20;
 *  - a streamed result fills the row (compact one-liner);
 *  - an observer (GET canEdit:false) sees the brief with no draft/edit/revert/retry/note controls;
 *  - flag off ⇒ no brief request and no brief chrome at all.
 * fetch is stubbed and routed by URL + method — no route/engine involvement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MatchaPanel } from "@/components/edit/matcha-panel";
import type { MatchaCandidate, MatchaConcept } from "@/lib/api/matcha-contract";
import type { BriefRecords, BriefWire } from "@/lib/edit/matcha-brief-types";

const CONCEPTS: MatchaConcept[] = [
  {
    term: "Immuno-oncology",
    kind: "concept",
    members: ["Immuno-oncology"],
    centrality: 0.9,
    weightFactor: 1.0,
  },
  {
    term: "Cancer Metabolism",
    kind: "concept",
    members: ["Cancer Metabolism"],
    centrality: 0.9,
    weightFactor: 1.0,
  },
];

/** `n` candidates in fused order, all strong/good (two concepts each so no row falls to "weak"). */
function pool(n: number): MatchaCandidate[] {
  return Array.from({ length: n }, (_, i) => {
    const rank = i + 1;
    return {
      cwid: `p${rank}`,
      name: `Person ${String(rank).padStart(2, "0")}`,
      profileSlug: `slug-p${rank}`,
      title: "Professor",
      department: rank === 3 ? "Surgery" : "Medicine",
      fusedScore: 0,
      contributions: [
        { term: "Immuno-oncology", rank },
        { term: "Cancer Metabolism", rank },
      ],
      technologyCount: 0,
      searchEvidence: [
        {
          term: "__match__",
          evidence: { kind: "publications", strength: "tagged", text: "1 of 10 tagged", count: 1 },
          pubCount: 10,
          keyPaper: { descriptorUis: ["D_x"], contentQuery: "__match__" },
        },
      ],
    } as MatchaCandidate;
  });
}

const EMPTY_RECORDS: BriefRecords = {
  funding: [],
  translation: [],
  secondaryAppointments: [],
  centers: [],
};

function brief(cwid: string, over: Partial<BriefWire> = {}): BriefWire {
  return {
    cwid,
    generated: {
      why: `Generated why for ${cwid}. Second sentence.`,
      topics: [
        {
          concept: "Immuno-oncology",
          text: `Topic for ${cwid}`,
          sources: [{ kind: "pub", pmid: "123", year: 2024, title: "A paper about things" }],
        },
      ],
      removedCount: 1,
    },
    edited: null,
    note: null,
    model: "m",
    draftedAt: "2026-10-03T12:00:00.000Z",
    updatedAt: "2026-10-03T12:00:00.000Z",
    ...over,
  };
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function stub(opts: {
  candidates: MatchaCandidate[];
  saved?: BriefWire[];
  canEdit?: boolean;
  /** Hold every brief POST until released (to observe concurrency). */
  hold?: boolean;
}) {
  const calls: Call[] = [];
  const held: (() => void)[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    if (url.startsWith("/api/edit/matcha/brief")) {
      if (method === "GET") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            briefs: opts.saved ?? [],
            records: Object.fromEntries((opts.saved ?? []).map((b) => [b.cwid, EMPTY_RECORDS])),
            canEdit: opts.canEdit ?? true,
          }),
        };
      }
      if (method === "POST") {
        const cwid = (JSON.parse(init!.body!) as { cwids: string[] }).cwids[0];
        if (opts.hold) await new Promise<void>((resolve) => held.push(resolve));
        // NDJSON as `editOkStream` writes it: a progress line, a whitespace heartbeat, the result.
        const text =
          JSON.stringify({ type: "progress", cwid, ok: true }) +
          "\n   \n" +
          JSON.stringify({
            type: "result",
            ok: true,
            briefs: [
              brief(cwid, {
                generated: { why: `Fresh why ${cwid}. More.`, topics: [], removedCount: 0 },
              }),
            ],
            records: { [cwid]: EMPTY_RECORDS },
            failed: [],
          }) +
          "\n";
        return { ok: true, body: null, text: async () => text };
      }
    }
    if (method === "GET") {
      return { ok: true, json: async () => ({ ok: true, submissions: [], scope: "own" }) };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        concepts: CONCEPTS,
        candidates: opts.candidates,
        submissionId: "sub-1",
        titleOverride: null,
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, held, fetchMock };
}

const briefPosts = (calls: Call[]) =>
  calls.filter((c) => c.url === "/api/edit/matcha/brief" && c.method === "POST");

async function search(matchaBrief = true) {
  render(<MatchaPanel matchaBrief={matchaBrief} />);
  fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "CAR T collaborators" } });
  fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
  await screen.findByText("Person 01");
}

beforeEach(() => {
  window.localStorage.clear(); // compact, the app default
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Matcha brief UI", () => {
  it("drafts only the current view's top 10 that lack a brief, one POST per PI", async () => {
    const { calls } = stub({ candidates: pool(14), saved: [brief("p2")] });
    await search();
    // The saved brief loads with no click (replay) and shows its one-liner.
    expect(await screen.findByText("Generated why for p2.")).toBeTruthy();
    const button = await screen.findByRole("button", { name: "Draft briefs (top 10)" });
    fireEvent.click(button);
    await waitFor(() => expect(briefPosts(calls)).toHaveLength(9));
    const posted = briefPosts(calls).map(
      (c) => c.body as { submissionId: string; cwids: string[] },
    );
    expect(posted.every((b) => b.submissionId === "sub-1" && b.cwids.length === 1)).toBe(true);
    expect(posted.map((b) => b.cwids[0]).sort()).toEqual(
      ["p1", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"].sort(),
    );
    // Rows fill in as each stream's result lands.
    expect(await screen.findByText("Fresh why p1.")).toBeTruthy();
  });

  it("drafts the current FILTERED view, not the whole pool", async () => {
    const { calls } = stub({ candidates: pool(14) });
    await search();
    // Narrow to Surgery (only p3).
    fireEvent.click(screen.getByRole("checkbox", { name: /Surgery/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft briefs (top 10)" }));
    await waitFor(() => expect(briefPosts(calls)).toHaveLength(1));
    expect((briefPosts(calls)[0].body as { cwids: string[] }).cwids).toEqual(["p3"]);
  });

  it("keeps at most 4 drafts in flight", async () => {
    const { calls, held } = stub({ candidates: pool(10), hold: true });
    await search();
    fireEvent.click(await screen.findByRole("button", { name: "Draft briefs (top 10)" }));
    await waitFor(() => expect(briefPosts(calls)).toHaveLength(4));
    held.splice(0, 1).forEach((r) => r());
    await waitFor(() => expect(briefPosts(calls)).toHaveLength(5));
    expect(screen.getByText(/1 drafted · 9 drafting/)).toBeTruthy();
  });

  it("drafts the shortlisted rows, capped at 20", async () => {
    const { calls } = stub({ candidates: pool(25) });
    await search();
    for (let i = 1; i <= 22; i++) {
      fireEvent.click(
        screen.getByRole("checkbox", { name: `Shortlist Person ${String(i).padStart(2, "0")}` }),
      );
    }
    fireEvent.click(await screen.findByRole("button", { name: "Draft briefs (20 shortlisted)" }));
    await waitFor(() => expect(briefPosts(calls)).toHaveLength(20));
    const posted = new Set(briefPosts(calls).map((c) => (c.body as { cwids: string[] }).cwids[0]));
    expect(posted.has("p21")).toBe(false);
    expect(posted.has("p23")).toBe(false);
  });

  it("an observer sees the brief read-only: no draft, redraft, edit, revert, retry or note", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    stub({
      candidates: pool(3),
      canEdit: false,
      saved: [brief("p1", { edited: { why: "Officer text." }, note: "Shared note." })],
    });
    await search();
    const section = await screen.findByRole("region", { name: "Brief for Person 01" });
    expect(within(section).getByText("Officer text.")).toBeTruthy();
    expect(within(section).getByText("Edited by you")).toBeTruthy();
    for (const name of [
      /^Draft brief/,
      /^Draft briefs/,
      /^Redraft/,
      /^Edit (Why|Discussion|note)/,
      /^Revert/,
      /^Retry/,
    ]) {
      expect(screen.queryAllByRole("button", { name })).toHaveLength(0);
    }
    expect(screen.queryByText("Add a note (never exported)")).toBeNull();
    // The shared note itself is readable, never editable.
    expect(screen.getByText("Shared note.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /Note for/ })).toBeNull();
  });

  it("an editor gets the labelled controls, and the note label says who can see it", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    stub({ candidates: pool(2), saved: [brief("p1")] });
    await search();
    expect(
      await screen.findByRole("button", { name: "Edit Why this PI for Person 01" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit Discussion topics for Person 01" }),
    ).toBeTruthy();
    expect(screen.getByText(/1 unsupported statement removed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Draft brief for Person 02" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add a note \(never exported\)/ }));
    expect(
      screen.getByText("Never exported · visible to anyone who opens this search"),
    ).toBeTruthy();
  });

  it("flag off: no brief request, no brief chrome", async () => {
    const { calls } = stub({ candidates: pool(3), saved: [brief("p1")] });
    await search(false);
    expect(calls.some((c) => c.url.startsWith("/api/edit/matcha/brief"))).toBe(false);
    expect(screen.queryByRole("button", { name: /Draft briefs/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename this search" })).toBeNull();
  });
});
