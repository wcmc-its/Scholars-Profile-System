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
    expect(soonEl.className).toContain("text-amber-700");
    unmount();

    vi.stubGlobal("fetch", routedFetch([{ ...OPP, dueDate: far }]));
    render(<GrantRecsCard cwid="thc2015" />);
    const farEl = await screen.findByText(/^Due /);
    expect(farEl.className).not.toContain("text-amber-700");
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
