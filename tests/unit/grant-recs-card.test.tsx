/**
 * GrantRecs Phase 3 — the "Grants for me" `/edit` rail item + panel.
 *
 * Covers (1) the `SELF_EDIT_GRANT_RECS` flag, (2) the rail-gating rule in
 * `visibleAttrKeys` (self/superuser only, flag-gated — mirrors the coi-gap /
 * highlights gating), and (3) the `GrantRecsCard` render states: explanation
 * chips + qualitative fit tier (raw blend never renders, #1608/#1610), the
 * UTC-rendered deadline, header count honesty, urgency toning, loading/error
 * roles, per-axis meters demoted into Details, empty, error, and the sort
 * re-query (browser-cacheable — no `no-store`).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { isGrantRecsEnabled } from "@/lib/edit/grant-recs";
import { visibleAttrKeys } from "@/components/edit/edit-page";
import { GrantRecsCard } from "@/components/edit/grant-recs-card";

const OPP = {
  opportunityId: "DEMO-1",
  title: "Biomedical Informatics Research",
  sponsor: "NIH NLM",
  dueDate: "2026-08-01",
  status: "open",
  axes: { topicAffinity: 0.7, stageAppeal: 0.8, meshOverlap: 0.1, deadlineProximity: 0.9 },
  defaultScore: 1.05,
  mechanism: "R01",
  awardCeiling: 500_000,
  matchedTopics: [
    { topicId: "t-informatics", label: "Clinical informatics", pubCount: 12 },
    { topicId: "t-nlp", label: "Clinical natural language processing", pubCount: 1 },
  ],
};

const DETAIL = {
  synopsis: "Methods and tools for biomedical informatics and clinical data science.",
  sourceUrl: "https://www.grants.gov/x",
  eligibilityRaw: "Open to U.S. faculty",
  numberOfAwards: 5,
};

/** Route both the list fetch and the per-card detail fetch off one mock. */
const routedFetch = (results: unknown[], detail: unknown = DETAIL) =>
  vi.fn().mockImplementation((url: string) =>
    Promise.resolve(
      String(url).includes("/api/opportunities/")
        ? okJson(detail)
        : okJson({ results }),
    ),
  );

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

describe("isGrantRecsEnabled — SELF_EDIT_GRANT_RECS", () => {
  const prev = process.env.SELF_EDIT_GRANT_RECS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SELF_EDIT_GRANT_RECS;
    else process.env.SELF_EDIT_GRANT_RECS = prev;
  });

  it("is on only for the literal 'on'", () => {
    process.env.SELF_EDIT_GRANT_RECS = "on";
    expect(isGrantRecsEnabled()).toBe(true);
    process.env.SELF_EDIT_GRANT_RECS = "true"; // not the magic value
    expect(isGrantRecsEnabled()).toBe(false);
    delete process.env.SELF_EDIT_GRANT_RECS;
    expect(isGrantRecsEnabled()).toBe(false);
  });
});

describe("visibleAttrKeys — grant-recs rail gating", () => {
  it("hides grant-recs from self / comms_steward when the flag is off", () => {
    expect(visibleAttrKeys("self", false, false, false, false)).not.toContain("grant-recs");
    expect(visibleAttrKeys("comms_steward", false, false, false, false)).not.toContain(
      "grant-recs",
    );
  });
  it("shows grant-recs to a superuser even when the flag is off (QA lens)", () => {
    // A genuine superuser always sees "Grants for me" so the recommendations can be
    // inspected per scholar before SELF_EDIT_GRANT_RECS is flipped on for users.
    expect(visibleAttrKeys("superuser", false, false, false, false)).toContain("grant-recs");
  });
  it("shows grant-recs on self + superuser when the flag is on", () => {
    expect(visibleAttrKeys("self", false, false, false, true)).toContain("grant-recs");
    expect(visibleAttrKeys("superuser", false, false, false, true)).toContain("grant-recs");
  });
  it("never shows grant-recs to a proxy / unit-admin even with the flag on", () => {
    expect(visibleAttrKeys("proxy", false, false, false, true)).not.toContain("grant-recs");
    expect(visibleAttrKeys("unit-admin", false, false, false, true)).not.toContain("grant-recs");
  });
});

describe("GrantRecsCard", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("renders ranked opportunities: explanation chips + fit tier + UTC deadline (never the raw blend)", async () => {
    vi.stubGlobal("fetch", routedFetch([OPP]));
    render(<GrantRecsCard cwid="thc2015" />);
    // loading state announces itself to assistive tech (#1608)
    expect(screen.getByRole("status")).toBeTruthy();

    expect(await screen.findByText("Biomedical Informatics Research")).toBeTruthy();
    // #1608: due dates are midnight-UTC instants — a local format in
    // US-Eastern would render "Due Jul 31, 2026" for this stamp.
    expect(screen.getByText(/Due Aug 1, 2026/)).toBeTruthy();
    // #1608: the raw internal blend never renders; the qualitative tier does.
    expect(screen.queryByText("1.05")).toBeNull();
    expect(screen.getByText("Strong match")).toBeTruthy();
    // #1610: explanation chips lead — topic label + pub count (singular pluralizes)
    expect(
      screen.getByText("Matches your work on Clinical informatics (12 pubs)"),
    ).toBeTruthy();
    expect(
      screen.getByText("Matches your work on Clinical natural language processing (1 pub)"),
    ).toBeTruthy();
    // inline at-a-glance facts: mechanism + award ceiling on the facts line
    expect(screen.getByText(/R01/)).toBeTruthy();
    expect(screen.getByText(/up to \$500K/)).toBeTruthy();
    // header count honesty: one result ≠ a full page → "1 recommended"
    expect(screen.getByText("1 recommended")).toBeTruthy();
    // the per-axis meters are demoted into the Details disclosure (#1610)
    expect(screen.queryAllByRole("meter")).toHaveLength(0);
    expect(screen.queryByText("topic")).toBeNull();
    // sort chips re-query
    expect(screen.getByText("Fit")).toBeTruthy();
    expect(screen.getByText("Deadline")).toBeTruthy();
    expect(screen.getByText("Stage")).toBeTruthy();
  });

  it("labels the header 'Top N' when the response fills the requested limit", async () => {
    const page = Array.from({ length: 25 }, (_, i) => ({ ...OPP, opportunityId: `DEMO-${i}` }));
    vi.stubGlobal("fetch", routedFetch(page));
    render(<GrantRecsCard cwid="thc2015" />);
    expect(await screen.findByText("Top 25")).toBeTruthy();
    expect(screen.queryByText(/recommended$/)).toBeNull();
  });

  it("labels a forecasted item without a date 'Forecasted · date TBD', not rolling (#1608)", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { ...OPP, opportunityId: "F1", dueDate: null, status: "forecasted" },
        { ...OPP, opportunityId: "C1", dueDate: null, status: "continuous" },
      ]),
    );
    render(<GrantRecsCard cwid="thc2015" />);
    expect(await screen.findByText("Forecasted · date TBD")).toBeTruthy();
    expect(screen.getByText("Rolling · continuous")).toBeTruthy();
  });

  it("tones a ≤30-day deadline amber; far-out deadlines stay plain (#1608)", async () => {
    const day = 86_400_000;
    const soon = new Date(Date.now() + 10 * day).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 90 * day).toISOString().slice(0, 10);

    vi.stubGlobal("fetch", routedFetch([{ ...OPP, dueDate: soon }]));
    const { unmount } = render(<GrantRecsCard cwid="thc2015" />);
    const soonEl = await screen.findByText(/^Due /);
    expect(soonEl.className).toContain("text-apollo-amber");
    unmount();

    vi.stubGlobal("fetch", routedFetch([{ ...OPP, dueDate: far }]));
    render(<GrantRecsCard cwid="thc2015" />);
    const farEl = await screen.findByText(/^Due /);
    expect(farEl.className).not.toContain("text-apollo-amber");
  });

  it("lazily loads the detail route on expand: synopsis, award count, link out + demoted meters", async () => {
    const fetchMock = routedFetch([OPP]);
    vi.stubGlobal("fetch", fetchMock);
    render(<GrantRecsCard cwid="thc2015" />);
    await screen.findByText("Biomedical Informatics Research");

    // no detail fetch until expanded
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/opportunities/"))).toBe(false);
    fireEvent.click(screen.getByText("Details"));

    expect(await screen.findByText(DETAIL.synopsis)).toBeTruthy();
    expect(screen.getByText(/5 awards/)).toBeTruthy();
    const link = screen.getByText("View opportunity ↗") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(DETAIL.sourceUrl);
    // the four per-axis meters live in Details now, as real a11y meters (#1608/#1610)
    expect(screen.getAllByRole("meter")).toHaveLength(4);
    for (const axis of ["topic", "stage", "mesh", "deadline"]) {
      expect(screen.getByText(axis)).toBeTruthy();
    }
  });

  it("re-fetches with the chosen sort — browser-cacheable (no cache:'no-store' on the list)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ results: [OPP] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GrantRecsCard cwid="thc2015" />);
    await screen.findByText("Biomedical Informatics Research");

    fireEvent.click(screen.getByText("Deadline"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sort=deadline"))).toBe(true),
    );
    // #1608: chip toggles ride the route's max-age=300 browser cache — the
    // list fetch must not opt out with `no-store`.
    const listCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/opportunities?"));
    expect(listCalls.length).toBeGreaterThan(0);
    for (const [, init] of listCalls) {
      expect((init as RequestInit | undefined)?.cache).toBeUndefined();
    }
  });

  it("renders an empty state when there are no matches (never an empty heading flash for the owner)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ results: [] })));
    render(<GrantRecsCard cwid="nobody" />);
    expect(await screen.findByText(/No matching opportunities yet/i)).toBeTruthy();
  });

  it("renders an error state (role=alert) when the route fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 } as unknown as Response));
    render(<GrantRecsCard cwid="thc2015" />);
    expect(await screen.findByText(/unavailable right now/i)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("GrantRecsCard — feedback loop + beacons (#1609)", () => {
  const A = { ...OPP, opportunityId: "A", title: "Alpha award" };
  const B = { ...OPP, opportunityId: "B", title: "Bravo award" };
  const C = { ...OPP, opportunityId: "C", title: "Charlie award" };

  type Handler = (url: string, init?: RequestInit) => Response;
  /** One fetch mock routing the feedback read / write, the list, and details. */
  function wire(opts: { feedback?: unknown[]; results?: unknown[]; post?: Handler }) {
    const post: Handler = opts.post ?? (() => okJson({ ok: true }));
    return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("/api/edit/grant-recs/feedback")) {
        return Promise.resolve(
          init?.method === "POST"
            ? post(u, init)
            : okJson({ ok: true, feedback: opts.feedback ?? [] }),
        );
      }
      if (u.includes("/api/opportunities/")) return Promise.resolve(okJson(DETAIL));
      return Promise.resolve(okJson({ results: opts.results ?? [A, B, C] }));
    });
  }
  const beaconMock = () => navigator.sendBeacon as unknown as ReturnType<typeof vi.fn>;
  // jsdom's Blob has no `.text()`; read it the FileReader way.
  const readBlob = (blob: Blob) =>
    new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(blob);
    });
  const beacons = () =>
    Promise.all(
      beaconMock().mock.calls.map(async ([, blob]) => JSON.parse(await readBlob(blob as Blob))),
    );
  const posts = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue(true),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
  });

  it("without feedbackEnabled: read-only rows, no feedback read", async () => {
    const f = wire({});
    vi.stubGlobal("fetch", f);
    render(<GrantRecsCard cwid="thc2015" />);
    await screen.findByText("Alpha award");
    expect(screen.queryByRole("button", { name: /^Save:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Not relevant:/ })).toBeNull();
    expect(f.mock.calls.some(([u]) => String(u).includes("grant-recs/feedback"))).toBe(false);
  });

  it("drops not-relevant items, pins + badges saved ones, and over-fetches to keep the page full", async () => {
    const f = wire({
      feedback: [
        { opportunityId: "B", status: "not_relevant", reason: null, updatedAt: "x" },
        { opportunityId: "C", status: "saved", reason: null, updatedAt: "x" },
      ],
    });
    vi.stubGlobal("fetch", f);
    render(<GrantRecsCard cwid="thc2015" feedbackEnabled />);
    await screen.findByText("Alpha award");
    expect(screen.queryByText("Bravo award")).toBeNull();
    const titles = screen.getAllByText(/award$/).map((e) => e.textContent);
    expect(titles).toEqual(["Charlie award", "Alpha award"]);
    expect(screen.getByText("Saved")).toBeTruthy();
    const pressed = (name: string) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed("Save: Charlie award")).toBe("true");
    expect(pressed("Save: Alpha award")).toBe("false");
    // The feedback read lands first (a dismissed item never flashes in), and the
    // list asks for LIMIT + 1 so dropping the one hidden item keeps the page full.
    const listUrl = f.mock.calls.map(([u]) => String(u)).find((u) => u.includes("/opportunities?"));
    expect(listUrl).toContain("limit=26");
  });

  it("Save is optimistic and POSTs; clicking again clears it (status null)", async () => {
    const f = wire({});
    vi.stubGlobal("fetch", f);
    render(<GrantRecsCard cwid="thc2015" feedbackEnabled />);
    const save = await screen.findByRole("button", { name: "Save: Alpha award" });
    fireEvent.click(save);
    expect(save.getAttribute("aria-pressed")).toBe("true"); // before the POST resolves
    await waitFor(() =>
      expect(posts(f)).toEqual([
        { cwid: "thc2015", opportunityId: "A", status: "saved", reason: null },
      ]),
    );
    fireEvent.click(save);
    await waitFor(() => expect(posts(f)[1]).toMatchObject({ opportunityId: "A", status: null }));
    expect(save.getAttribute("aria-pressed")).toBe("false");
  });

  it("rolls back and shows an inline alert when the write fails", async () => {
    const f = wire({
      post: () => ({ ok: false, status: 500, json: async () => ({ ok: false }) }) as unknown as Response,
    });
    vi.stubGlobal("fetch", f);
    render(<GrantRecsCard cwid="thc2015" feedbackEnabled />);
    const save = await screen.findByRole("button", { name: "Save: Alpha award" });
    fireEvent.click(save);
    expect(await screen.findByText(/couldn’t save that/i)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/try again/i);
    expect(save.getAttribute("aria-pressed")).toBe("false");
  });

  it("Not relevant collapses the row in place (focus → Undo), takes an optional reason, and Undo restores it", async () => {
    const f = wire({});
    vi.stubGlobal("fetch", f);
    render(<GrantRecsCard cwid="thc2015" feedbackEnabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Not relevant: Bravo award" }));
    const undo = await screen.findByRole("button", { name: "Undo not relevant: Bravo award" });
    expect(document.activeElement).toBe(undo);
    expect(screen.getByText(/marked not relevant/i)).toBeTruthy();
    // the optional reason chips are pressed-state toggles
    const why = screen.getByRole("button", { name: "I'm not eligible" });
    expect(why.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(why);
    expect(why.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(posts(f)).toHaveLength(2));
    expect(posts(f)[0]).toMatchObject({ opportunityId: "B", status: "not_relevant", reason: null });
    expect(posts(f)[1]).toMatchObject({ status: "not_relevant", reason: "not_eligible" });

    fireEvent.click(undo);
    expect(await screen.findByRole("button", { name: "Not relevant: Bravo award" })).toBeTruthy();
    await waitFor(() => expect(posts(f)[2]).toMatchObject({ opportunityId: "B", status: null }));
  });

  it("fires impression / details / outbound / sort beacons tagged with the surface", async () => {
    vi.stubGlobal("fetch", wire({}));
    render(<GrantRecsCard cwid="thc2015" surface="superuser" />);
    await screen.findByText("Alpha award");
    await waitFor(() => expect(beaconMock()).toHaveBeenCalled());
    expect(beaconMock().mock.calls[0][0]).toBe("/api/analytics");
    expect((await beacons())[0]).toMatchObject({
      event: "grant_rec_impression",
      cwid: "thc2015",
      surface: "superuser",
      mode: "fit",
      resultCount: 3,
      opportunityIds: ["A", "B", "C"],
    });

    fireEvent.click(screen.getAllByText("Details")[1]);
    fireEvent.click(await screen.findByText("View opportunity ↗"));
    fireEvent.click(screen.getByText("Deadline"));
    await waitFor(() => expect(beaconMock().mock.calls.length).toBeGreaterThanOrEqual(4));
    const sent = await beacons();
    expect(sent.find((b) => b.event === "grant_rec_details_open")).toMatchObject({
      opportunityId: "B",
      position: 1,
      surface: "superuser",
    });
    expect(sent.find((b) => b.event === "grant_rec_outbound_click")).toMatchObject({
      opportunityId: "B",
      position: 1,
    });
    expect(sent.find((b) => b.event === "grant_rec_sort")).toMatchObject({ mode: "deadline" });
  });
});
