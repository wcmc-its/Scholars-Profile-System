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
  methods: [],
  trialCount: 0,
};

function brief(cwid: string, over: Partial<BriefWire> = {}): BriefWire {
  return {
    cwid,
    generated: {
      why: `Generated why for ${cwid}. Second sentence.`,
      angle: `Angle for ${cwid}.`,
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

/** A brief drafted before partnership angles (and roles, and data sources) existed. */
function preAngle(cwid: string): BriefWire {
  const b = brief(cwid);
  delete b.generated.angle;
  return b;
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function stub(opts: {
  candidates: MatchaCandidate[];
  saved?: BriefWire[];
  canEdit?: boolean;
  /** Hold every brief POST until released (to observe concurrency). */
  hold?: boolean;
  /** cwids whose brief POST fails. */
  fail?: string[];
  /** Extra fields on the search POST's response (titleSummary, requester, …). */
  post?: Record<string, unknown>;
  /** The PATCH response body. */
  patch?: Record<string, unknown>;
  /** Records the GET returns for every saved brief (default: empty). */
  records?: BriefRecords;
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
            records: Object.fromEntries(
              (opts.saved ?? []).map((b) => [b.cwid, opts.records ?? EMPTY_RECORDS]),
            ),
            canEdit: opts.canEdit ?? true,
          }),
        };
      }
      if (method === "POST") {
        const cwid = (JSON.parse(init!.body!) as { cwids: string[] }).cwids[0];
        if (opts.hold) await new Promise<void>((resolve) => held.push(resolve));
        if (opts.fail?.includes(cwid)) return { ok: false, json: async () => ({ ok: false }) };
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
    if (method === "PATCH") {
      return { ok: true, json: async () => ({ ok: true, ...(opts.patch ?? {}) }) };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        concepts: CONCEPTS,
        candidates: opts.candidates,
        submissionId: "sub-1",
        titleOverride: null,
        ...(opts.post ?? {}),
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

  it("shows Methods and tools from records, and omits the section when there are none", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    stub({
      candidates: pool(2),
      saved: [brief("p1")],
      records: {
        ...EMPTY_RECORDS,
        methods: [
          { name: "Mouse models", category: "animal model", papers: 14 },
          { name: "Flow cytometry", category: null, papers: 1 },
        ],
        trialCount: 2,
      },
    });
    await search();
    const section = await screen.findByRole("region", { name: "Brief for Person 01" });
    // One collapsed line with the counts; the full list sits inside and opens on click.
    const summary = within(section).getByText("Methods and tools · 2 · 2 clinical trials on record");
    const details = summary.closest("details")!;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getByText("Mouse models · 14 papers")).toBeTruthy();
    expect(within(details).getByText("Flow cytometry · 1 paper")).toBeTruthy();
    cleanup();
    stub({ candidates: pool(2), saved: [brief("p1")] });
    await search();
    const bare = await screen.findByRole("region", { name: "Brief for Person 01" });
    expect(within(bare).queryByText(/Methods and tools/)).toBeNull();
  });

  it("shows the partnership angle under Why and saves an edit of it", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    const saved = brief("p1");
    saved.generated.angle = "Could validate leads in mouse models.";
    const { calls } = stub({
      candidates: pool(2),
      saved: [saved],
      patch: { brief: { ...saved, edited: { angle: "Trial lead." } } },
    });
    await search();
    const section = await screen.findByRole("region", { name: "Brief for Person 01" });
    expect(within(section).getByText("Partnership angle")).toBeTruthy();
    expect(within(section).getByText("Could validate leads in mouse models.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Partnership angle for Person 01" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Partnership angle for Person 01" }), {
      target: { value: "Trial lead." },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.body?.angle === "Trial lead.")).toBe(true),
    );
    expect(await within(section).findByText("Trial lead.")).toBeTruthy();
  });

  it("a brief drafted before angles shows no crash and points to Redraft", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    stub({ candidates: pool(2), saved: [preAngle("p1")] });
    await search();
    const section = await screen.findByRole("region", { name: "Brief for Person 01" });
    expect(
      within(section).getByText("Drafted before partnership angles. Redraft to add one."),
    ).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Redraft brief for Person 01" })).toBeTruthy();
  });

  it("shows the role in bold before the angle, and saves a role edit with the angle", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    const saved = brief("p1");
    saved.generated.angle = "Could run trials on the cohort.";
    saved.generated.angleRole = "Clinical-trial lead";
    const { calls } = stub({
      candidates: pool(2),
      saved: [saved],
      patch: { brief: { ...saved, edited: { angleRole: "Cohort steward" } } },
    });
    await search();
    const section = await screen.findByRole("region", { name: "Brief for Person 01" });
    const role = section.querySelector('[data-slot="matcha-brief-angle-role"]')!;
    expect(role.tagName).toBe("STRONG");
    expect(role.textContent).toBe("Clinical-trial lead.");
    expect(role.parentElement!.textContent).toBe(
      "Clinical-trial lead. Could run trials on the cohort.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Partnership angle for Person 01" }));
    const input = screen.getByRole("textbox", { name: "Partnership role for Person 01" });
    expect((input as HTMLInputElement).value).toBe("Clinical-trial lead");
    fireEvent.change(input, { target: { value: "Cohort steward" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PATCH" &&
            c.body?.angleRole === "Cohort steward" &&
            c.body?.angle === "Could run trials on the cohort.",
        ),
      ).toBe(true),
    );
    expect(await within(section).findByText("Cohort steward.")).toBeTruthy();
  });

  it("an older brief with an angle but no role prints the angle unbolded", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    stub({ candidates: pool(2), saved: [brief("p1")] });
    await search();
    const section = await screen.findByRole("region", { name: "Brief for Person 01" });
    expect(within(section).getByText("Angle for p1.")).toBeTruthy();
    expect(section.querySelector('[data-slot="matcha-brief-angle-role"]')).toBeNull();
  });

  it("splits Methods and tools into Data sources and Methods when the brief labels data sources", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    const saved = brief("p1");
    saved.generated.dataSources = ["Regional stroke registry"];
    const methods = [
      { name: "Regional stroke registry", category: null, papers: 9 },
      { name: "Mouse models", category: "animal model", papers: 7 },
      { name: "mouse  models.", category: null, papers: 2 },
    ];
    stub({ candidates: pool(2), saved: [saved], records: { ...EMPTY_RECORDS, methods } });
    await search();
    const section = await screen.findByRole("region", { name: "Brief for Person 01" });
    // The near-duplicate merges: two rows, not three.
    const summary = within(section).getByText("Methods and tools · 2");
    fireEvent.click(summary);
    const sources = section.querySelector('[data-slot="matcha-brief-data-sources"]') as HTMLElement;
    const rest = section.querySelector('[data-slot="matcha-brief-method-list"]') as HTMLElement;
    expect(within(sources).getByText("Data sources")).toBeTruthy();
    expect(within(sources).getByText("Regional stroke registry · 9 papers")).toBeTruthy();
    expect(within(rest).getByText("Methods")).toBeTruthy();
    expect(within(rest).getByText("Mouse models · 7 papers")).toBeTruthy();
    expect(within(rest).queryByText(/registry/)).toBeNull();
    cleanup();

    // An older brief (no dataSources): one flat list, unchanged.
    stub({ candidates: pool(2), saved: [brief("p1")], records: { ...EMPTY_RECORDS, methods } });
    await search();
    const flat = await screen.findByRole("region", { name: "Brief for Person 01" });
    expect(flat.querySelector('[data-slot="matcha-brief-data-sources"]')).toBeNull();
    expect(within(flat).queryByText("Data sources")).toBeNull();
    expect(within(flat).getByText("Regional stroke registry · 9 papers")).toBeTruthy();
  });

  it("shows the brief's curated method pills in two groups, counting pills", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    const saved = brief("p1");
    saved.generated.angle = "Five trials on record and a cohort of scans.";
    saved.generated.angleRole = "Imaging trial site lead";
    saved.generated.dataSources = ["Regional stroke registry", "Stroke registry (regional)"];
    saved.generated.methodPills = [
      { label: "MRI", kind: "method", from: ["Magnetic resonance imaging (MRI) scanner"] },
      {
        label: "Stroke registry",
        kind: "data",
        from: ["Regional stroke registry", "Stroke registry (regional)"],
      },
      { label: "Mouse models", kind: "method", from: ["Mouse models"] },
    ];
    const methods = [
      { name: "Regional stroke registry", category: null, papers: 9 },
      { name: "Stroke registry (regional)", category: null, papers: 2 },
      { name: "Magnetic resonance imaging (MRI) scanner", category: "imaging", papers: 8 },
      { name: "Mouse models", category: "animal model", papers: 7 },
      { name: "Chi-square test", category: "statistics", papers: 6 },
    ];
    stub({ candidates: pool(2), saved: [saved], records: { ...EMPTY_RECORDS, methods } });
    await search();
    const section = await screen.findByRole("region", { name: "Brief for Person 01" });
    const role = section.querySelector('[data-slot="matcha-brief-angle-role"]')!;
    expect(role.textContent).toBe("Imaging trial site lead.");
    expect(role.parentElement!.textContent).toBe(
      "Imaging trial site lead. Five trials on record and a cohort of scans.",
    );

    fireEvent.click(within(section).getByText("Methods and tools · 3"));
    const sources = section.querySelector('[data-slot="matcha-brief-data-sources"]') as HTMLElement;
    const rest = section.querySelector('[data-slot="matcha-brief-method-list"]') as HTMLElement;
    expect(within(sources).getByText("Stroke registry")).toBeTruthy();
    expect(within(sources).queryByText(/Regional stroke registry/)).toBeNull();
    expect(
      [...rest.querySelectorAll("div")].slice(1).map((d) => d.textContent),
    ).toEqual(["MRI", "Mouse models"]);
    // A raw row the model left out (a generic statistic) is not shown.
    expect(within(section).queryByText(/Chi-square/)).toBeNull();
  });

  it("flag off: no brief request, no brief chrome", async () => {
    const { calls } = stub({ candidates: pool(3), saved: [brief("p1")] });
    await search(false);
    expect(calls.some((c) => c.url.startsWith("/api/edit/matcha/brief"))).toBe(false);
    expect(screen.queryByRole("button", { name: /Draft briefs/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename this search" })).toBeNull();
  });
});

describe("Matcha report (PDF)", () => {
  const tick = (i: number) =>
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Shortlist Person ${String(i).padStart(2, "0")}` }),
    );
  const openSpy = () => {
    const open = vi.fn(() => ({ opener: {} }) as unknown as Window);
    vi.stubGlobal("open", open);
    return open;
  };
  const reportUrl = (cwids: string[]) =>
    `/edit/matcha/report?submissionId=sub-1&cwids=${cwids.join(",")}`;

  it("opens the report straight away when every shortlisted PI has a brief", async () => {
    const open = openSpy();
    stub({ candidates: pool(5), saved: [brief("p1"), brief("p2")] });
    await search();
    await screen.findByText("Generated why for p1.");
    tick(1);
    tick(2);
    fireEvent.click(screen.getByRole("button", { name: "Report (PDF)" }));
    expect(open).toHaveBeenCalledWith(reportUrl(["p1", "p2"]), "_blank", "noopener");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with nothing ticked, covers the view's PIs that have a brief; disabled when none do", async () => {
    const open = openSpy();
    stub({ candidates: pool(5), saved: [brief("p3")] });
    await search();
    await screen.findByText("Generated why for p3.");
    fireEvent.click(screen.getByRole("button", { name: "Report (PDF)" }));
    expect(open).toHaveBeenCalledWith(reportUrl(["p3"]), "_blank", "noopener");
    cleanup();

    stub({ candidates: pool(3) });
    await search();
    const button = await screen.findByRole("button", { name: "Report (PDF)" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("prompts only when some selected PIs lack a brief, and drafts only those", async () => {
    const open = openSpy();
    const { calls } = stub({ candidates: pool(5), saved: [brief("p1")] });
    await search();
    await screen.findByText("Generated why for p1.");
    tick(1);
    tick(2);
    tick(3);
    fireEvent.click(screen.getByRole("button", { name: "Report (PDF)" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("2 of 3 shortlisted researchers have no brief yet."),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Open report without them" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Draft 2 briefs, then open report" }),
    );
    await waitFor(() => expect(open).toHaveBeenCalledWith(reportUrl(["p1", "p2", "p3"]), "_blank"));
    expect(
      briefPosts(calls)
        .map((c) => (c.body as { cwids: string[] }).cwids[0])
        .sort(),
    ).toEqual(["p2", "p3"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("lists a failed draft and offers a link when the tab is blocked", async () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    stub({ candidates: pool(3), fail: ["p2"] });
    await search();
    tick(1);
    tick(2);
    fireEvent.click(screen.getByRole("button", { name: "Report (PDF)" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Draft 2 briefs, then open report" }),
    );
    expect(await within(dialog).findByText(/Could not draft: Person 02/)).toBeTruthy();
    // The link appears once EVERY draft has settled (p1 may still be in flight here).
    const link = await within(dialog).findByRole("link", { name: "Open report" });
    expect(link.getAttribute("href")).toBe(reportUrl(["p1", "p2"]));
  });

  it("an observer gets no Draft option, only open-anyway and cancel", async () => {
    const open = openSpy();
    const { calls } = stub({ candidates: pool(3), canEdit: false, saved: [brief("p1")] });
    await search();
    await screen.findByText("Generated why for p1.");
    tick(1);
    tick(2);
    fireEvent.click(screen.getByRole("button", { name: "Report (PDF)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Ask a Scholars admin to draft them.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /^Draft/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open report without them" }));
    expect(open).toHaveBeenCalledWith(reportUrl(["p1", "p2"]), "_blank", "noopener");
    expect(briefPosts(calls)).toHaveLength(0);
  });

  it("counts a brief drafted before partnership angles as missing, and redrafts it", async () => {
    const open = openSpy();
    const { calls } = stub({ candidates: pool(5), saved: [brief("p1"), preAngle("p2")] });
    await search();
    await screen.findByText("Generated why for p2.");
    tick(1);
    tick(2);
    tick(3);
    fireEvent.click(screen.getByRole("button", { name: "Report (PDF)" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "2 of 3 shortlisted researchers have no brief or one drafted before partnership angles.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Open report as is" })).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Draft 2 briefs, then open report" }),
    );
    await waitFor(() => expect(open).toHaveBeenCalledWith(reportUrl(["p1", "p2", "p3"]), "_blank"));
    expect(
      briefPosts(calls)
        .map((c) => (c.body as { cwids: string[] }).cwids[0])
        .sort(),
    ).toEqual(["p2", "p3"]);
  });

  it("titles a prompt of only angle-less briefs as such", async () => {
    openSpy();
    stub({ candidates: pool(3), saved: [preAngle("p1")] });
    await search();
    await screen.findByText("Generated why for p1.");
    tick(1);
    fireEvent.click(screen.getByRole("button", { name: "Report (PDF)" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "1 of 1 shortlisted researcher has a brief drafted before partnership angles.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Redraft 1 brief, then open report" }),
    ).toBeTruthy();
  });

  it("flag off: no Report button", async () => {
    stub({ candidates: pool(3), saved: [brief("p1")] });
    await search(false);
    expect(screen.queryByRole("button", { name: "Report (PDF)" })).toBeNull();
  });
});

describe("Matcha requester (who is asking)", () => {
  it('titles the search "{requester} — {focus}", and Edit saves the correction into the title', async () => {
    const want = "Quillfin Bio — CAR-T persistence in solid tumors";
    const { calls } = stub({
      candidates: pool(2),
      post: {
        titleSummary: "CAR-T persistence in solid tumors",
        requester: "Northlake Therapeutics",
      },
      patch: {
        title: want,
        titleOverride: want,
        requester: "Northlake Therapeutics",
        requesterOverride: "Quillfin Bio",
      },
    });
    await search();
    const card = () => screen.getByText((_, el) => el?.getAttribute("data-slot") === "matcha-ask");
    expect(card().textContent).toBe("Northlake Therapeutics — CAR-T persistence in solid tumors");
    const line = screen.getByText((_, el) => el?.getAttribute("data-slot") === "matcha-requester");
    expect(line.textContent).toContain("Requester: Northlake Therapeutics");

    fireEvent.click(screen.getByRole("button", { name: "Edit requester" }));
    const input = screen.getByRole("textbox", { name: "Requester (who is asking)" });
    expect((input as HTMLInputElement).value).toBe("Northlake Therapeutics");
    fireEvent.change(input, { target: { value: " Quillfin Bio " } });
    fireEvent.click(within(line).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(card().textContent).toBe(want));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ submissionId: "sub-1", requester: "Quillfin Bio" });
    // A title composed from the officer's requester is still the generated one, not a Rename.
    expect(screen.getByText("Generated title")).toBeTruthy();
    expect(
      screen.getByText((_, el) => el?.getAttribute("data-slot") === "matcha-requester").textContent,
    ).toContain("Requester: Quillfin Bio");
  });

  it("offers Add requester when the model found none; the fallback title is sentence-cased", async () => {
    stub({ candidates: pool(2), post: { titleSummary: undefined } });
    await search();
    expect(
      screen.getByText((_, el) => el?.getAttribute("data-slot") === "matcha-ask").textContent,
    ).toBe("Immuno-oncology, Cancer Metabolism");
    expect(screen.getByRole("button", { name: "Add requester" })).toBeTruthy();
  });

  it("follows Rename's gate: no requester control with the brief flag off", async () => {
    stub({ candidates: pool(2), post: { requester: "Northlake Therapeutics" } });
    await search(false);
    expect(screen.queryByRole("button", { name: "Edit requester" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add requester" })).toBeNull();
  });
});
