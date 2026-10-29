/**
 * #3071 — the queue's decided tabs (Confirmed, Not this person, Unproven):
 * where an award lands, the URL state, the loader's filters and counts, and
 * the board on a decided tab: the detail, its actions, and the URL-driven
 * filters and pager. Fixture people and awards are invented.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: ({ children }: { children: unknown }) => children,
}));

import { GrantAttributionBoard } from "@/components/edit/grant-attribution-board";
import { fromDecidedRow } from "@/lib/edit/grant-attribution-board";
import {
  DECIDED_PAGE_SIZE,
  checkedNothingFound,
  decidedHref,
  decidedTabOf,
  nameParts,
  parseDecidedParams,
  parseQueueTab,
  sortableName,
  type DecidedPage,
  type DecidedRow,
} from "@/lib/edit/grant-attribution-decided";
import { loadDecidedPage } from "@/lib/edit/grant-attribution-decided.server";

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("where an award lands", () => {
  it("lets a curator's decision win, then the band", () => {
    expect(decidedTabOf({ reviewStatus: "confirmed", band: "hide", cues: [] })).toEqual({
      tab: "confirmed",
      by: "curator",
    });
    expect(decidedTabOf({ reviewStatus: "rejected", band: "show", cues: [] })).toEqual({
      tab: "rejected",
      by: "curator",
    });
    expect(decidedTabOf({ reviewStatus: "pending", band: "show", cues: [] })).toBeNull();
    expect(decidedTabOf({ reviewStatus: null, band: "show", cues: [] })).toEqual({
      tab: "confirmed",
      by: "auto",
    });
    expect(decidedTabOf({ reviewStatus: "withdrawn", band: "show", cues: [] })).toEqual({
      tab: "confirmed",
      by: "auto",
    });
  });

  it("splits hidden awards: evidence against is Not this person, nothing found is Unproven", () => {
    expect(
      decidedTabOf({
        reviewStatus: null,
        band: "hide",
        cues: [{ id: "middle_initial_conflict", weight: -4 }],
      })?.tab,
    ).toBe("rejected");
    expect(decidedTabOf({ reviewStatus: null, band: "hide", cues: [] })?.tab).toBe("unproven");
    // A common name alone is not evidence against.
    expect(
      decidedTabOf({ reviewStatus: null, band: "hide", cues: [{ id: "name_common", weight: -1 }] })
        ?.tab,
    ).toBe("unproven");
    // Reviews stored before 2026-10-24 carry the named InfoEd cue at weight 0.
    expect(
      decidedTabOf({
        reviewStatus: null,
        band: "hide",
        cues: [{ id: "infoed_other_wcm_pi_named", weight: 0 }],
      })?.tab,
    ).toBe("rejected");
  });
});

describe("URL state", () => {
  it("parses a tab and round-trips its filters, leaving defaults out", () => {
    expect(parseQueueTab({ tab: "unproven" })).toBe("unproven");
    expect(parseQueueTab({ tab: "nonsense" })).toBe("pending");
    const p = parseDecidedParams(
      { by: "auto", changed: "1", level: "leans-for", sort: "name", q: " lee ", page: "3" },
      "confirmed",
    );
    expect(p).toEqual({
      tab: "confirmed",
      by: "auto",
      changed: true,
      level: "leans-for",
      sort: "name",
      q: "lee",
      page: 3,
      all: false,
    });
    expect(decidedHref(p)).toBe(
      "?tab=confirmed&by=auto&changed=1&level=leans-for&sort=name&q=lee&page=3",
    );
    // Show all replaces the page number and survives a filter change.
    const all = parseDecidedParams({ by: "auto", all: "1", page: "3" }, "confirmed");
    expect(all.all).toBe(true);
    expect(decidedHref(all)).toBe("?tab=confirmed&by=auto&all=1");
    expect(decidedHref(all, { by: "curator", page: 1 })).toBe("?tab=confirmed&by=curator&all=1");
    expect(decidedHref(parseDecidedParams({}, "rejected"))).toBe("?tab=rejected");
  });

  it("reads Confirmed low to high and the rest high to low, and drops unknown values", () => {
    expect(parseDecidedParams({}, "confirmed").sort).toBe("low");
    expect(parseDecidedParams({}, "rejected").sort).toBe("high");
    // An old ?sort=least or ?level=high is not an error, just the default.
    expect(parseDecidedParams({ sort: "least", level: "high" }, "rejected")).toMatchObject({
      sort: "high",
      level: "all",
    });
    expect(decidedHref(parseDecidedParams({ sort: "low" }, "rejected"))).toBe(
      "?tab=rejected&sort=low",
    );
    expect(parseDecidedParams({ changed: "1" }, "rejected").changed).toBe(true);
    expect(parseDecidedParams({ changed: "1" }, "unproven").changed).toBe(false);
  });
});

describe("names and wording", () => {
  it("splits both name orders and marks only a real difference", () => {
    expect(nameParts("SAMPLE, LEE D", "last-first")).toEqual({
      last: "Sample",
      first: "Lee",
      middle: "D",
    });
    // RePORTER sometimes prints "First Last" with no comma.
    expect(nameParts("Pat Other", "last-first")).toEqual({
      last: "Other",
      first: "Pat",
      middle: "",
    });
    expect(nameParts("Lee A. Sample, PhD", "first-last")).toEqual({
      last: "Sample",
      first: "Lee",
      middle: "A",
    });
    expect(sortableName("Lee A. Sample")).toBe("Sample, Lee A");
  });

  it("lists only the checks that found nothing", () => {
    const n = checkedNothingFound(new Set(["pub_linked", "wcm_org_shared_name"]));
    expect(n).not.toContain("No confirmed paper of the scholar cites this award");
    expect(n).not.toContain("Not held at WCM");
    expect(n).toContain("No co-PI co-authors with the scholar");
    expect(n).toContain("Not held at a WCM affiliate");
  });

  it("says a WCM award was withheld, not missed", () => {
    expect(checkedNothingFound(new Set(), true)).toContain(
      "Held at WCM, not counted: the NIH profile came from a WCM grant, and the PI's name doesn't rule out another WCM person",
    );
    expect(checkedNothingFound(new Set(), false)).toContain("Not held at WCM");
    expect(checkedNothingFound(new Set(["affiliate_org"]))).not.toContain(
      "Not held at a WCM affiliate",
    );
  });
});

/** A fake read client over in-memory rows. */
function client(data: {
  scores: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
  supps?: Array<Record<string, unknown>>;
}) {
  const people = [
    {
      cwid: "zza0001",
      fullName: "Lee A. Sample",
      preferredName: null,
      slug: "lee-sample",
      postnominal: "PhD",
      roleCategory: null,
      primaryTitle: "Professor of Medicine",
      primaryDepartment: "Medicine",
    },
    {
      cwid: "zza0002",
      fullName: "Pat D. Example",
      preferredName: null,
      slug: "pat-example",
      postnominal: "MD",
      roleCategory: null,
      primaryDepartment: "Surgery",
    },
  ];
  return {
    grantAttributionScore: { findMany: vi.fn(async () => data.scores) },
    grantAttributionReview: { findMany: vi.fn(async () => data.reviews ?? []) },
    suppression: { findMany: vi.fn(async () => data.supps ?? []) },
    scholar: { findMany: vi.fn(async () => people) },
    education: { findMany: vi.fn(async () => [{ cwid: "zza0001", degree: "PhD", year: 2009 }]) },
    publication: { findMany: vi.fn(async () => []) },
  } as never;
}
const score = (id: string, cwid: string, band: string, s: number, cues: unknown[] = []) => ({
  grantExternalId: id,
  cwid,
  band,
  score: s,
  cues,
  award: {
    title: `Award ${id}`,
    awardNumber: id,
    orgs: [{ name: "Elsewhere University" }],
    piNames: [],
  },
  reporterName: "SAMPLE, LEE D",
  scoredAt: new Date("2026-10-25T10:00:00Z"),
});
const RUNS = [
  {
    ranAt: "2026-10-25T12:00:00Z",
    scholars: 2,
    show: 3,
    hide: 2,
    queue: 0,
    recovered: 1,
    cues: {},
  },
  {
    ranAt: "2026-10-18T12:00:00Z",
    scholars: 2,
    show: 2,
    hide: 3,
    queue: 0,
    recovered: 0,
    cues: {},
  },
];

describe("loadDecidedPage paging", () => {
  it("pages at DECIDED_PAGE_SIZE, and Show all returns every match", async () => {
    const scores = Array.from({ length: DECIDED_PAGE_SIZE + 5 }, (_, i) =>
      score(`P${i}`, "zza0001", "show", 5, [{ id: "pub_linked", weight: 5, reason: "cited" }]),
    );
    const paged = await loadDecidedPage(client({ scores }), parseDecidedParams({}, "confirmed"), RUNS);
    expect(paged.matched).toBe(DECIDED_PAGE_SIZE + 5);
    expect(paged.rows).toHaveLength(DECIDED_PAGE_SIZE);
    const all = await loadDecidedPage(client({ scores }), parseDecidedParams({ all: "1" }, "confirmed"), RUNS);
    expect(all.rows).toHaveLength(DECIDED_PAGE_SIZE + 5);
  });
});

describe("loadDecidedPage", () => {
  const data = {
    scores: [
      score("G1", "zza0001", "show", 2, [{ id: "profile_proven", weight: 4, reason: "linked" }]),
      score("G2", "zza0001", "show", 7, [{ id: "pub_linked", weight: 5, reason: "cited" }]),
      score("G3", "zza0002", "hide", -6, [
        { id: "middle_initial_conflict", weight: -4, reason: "initial" },
      ]),
      score("G4", "zza0002", "hide", -2),
      score("G5", "zza0002", "show", 3),
      score("G6", "zza0001", "hide", -2),
    ],
    reviews: [
      {
        id: "r5",
        grantExternalId: "G5",
        cwid: "zza0002",
        status: "rejected",
        decidedAt: new Date("2026-10-24T00:00:00Z"),
        decidedByCwid: "zza0001",
        rejectionReason: "A different person with the same name",
        score: 3,
        band: "show",
        cues: [],
        award: {},
      },
    ],
    supps: [
      // G1 was hidden, and the check showed it again this run.
      {
        entityId: "G1",
        createdBy: "system-unverified",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        revokedAt: new Date("2026-10-25T11:00:00Z"),
        revokedBy: "system-rescored",
      },
      // G6 is hidden for age: out of scope everywhere.
      {
        entityId: "G6",
        createdBy: "system-recency",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        revokedAt: null,
        revokedBy: null,
      },
    ],
  };

  it("counts every tab, marks what changed this run, and sorts least certain first", async () => {
    const page = await loadDecidedPage(client(data), parseDecidedParams({}, "confirmed"), RUNS);
    expect(page.counts).toEqual({
      confirmed: { all: 2, curator: 0, auto: 2 },
      rejected: { all: 2, curator: 1, auto: 1 },
      unproven: { all: 1, curator: 0, auto: 1 },
    });
    expect(page.changed).toEqual({ confirmed: 1, rejected: 0, unproven: 0 });
    expect(page.rows.map((r) => r.grantId)).toEqual(["G1", "G2"]);
    expect(page.rows[0]).toMatchObject({
      was: "hidden",
      changed: true,
      reason: "linked",
      scholar: { name: "Sample, Lee A", career: "PhD 2009", title: "Professor of Medicine" },
    });
    expect(page.rows[1]!.changed).toBe(false);
  });

  it("marks an award the latest check hid as changed on Not this person", async () => {
    const hid = (at: string) => ({
      ...data,
      supps: [
        ...data.supps,
        {
          entityId: "G3",
          createdBy: "system-unverified",
          createdAt: new Date(at),
          revokedAt: null,
          revokedBy: null,
        },
      ],
    });
    const fresh = await loadDecidedPage(
      client(hid("2026-10-25T11:00:00Z")),
      parseDecidedParams({ changed: "1" }, "rejected"),
      RUNS,
    );
    expect(fresh.changed.rejected).toBe(1);
    expect(fresh.rows.map((r) => r.grantId)).toEqual(["G3"]);
    // Hidden before the previous run ended: not this run's change.
    const old = await loadDecidedPage(
      client(hid("2026-10-10T11:00:00Z")),
      parseDecidedParams({}, "rejected"),
      RUNS,
    );
    expect(old.changed.rejected).toBe(0);
  });

  it("filters by evidence level and sorts by score or scholar", async () => {
    const c = client(data);
    const against = await loadDecidedPage(
      c,
      parseDecidedParams({ level: "against" }, "rejected"),
      RUNS,
    );
    expect(against.rows.map((r) => r.grantId)).toEqual(["G3"]);
    // The curator's rejection scored +3 with no cues: the evidence still supports.
    const supports = await loadDecidedPage(
      c,
      parseDecidedParams({ level: "supports" }, "rejected"),
      RUNS,
    );
    expect(supports.rows.map((r) => r.grantId)).toEqual(["G5"]);
    const high = await loadDecidedPage(c, parseDecidedParams({ sort: "high" }, "confirmed"), RUNS);
    expect(high.rows.map((r) => r.grantId)).toEqual(["G2", "G1"]);
    const byName = await loadDecidedPage(c, parseDecidedParams({ sort: "name" }, "rejected"), RUNS);
    expect(byName.rows.map((r) => r.grantId)).toEqual(["G5", "G3"]);
  });

  it("filters by who decided, what changed and search", async () => {
    const c = client(data);
    expect(
      (await loadDecidedPage(c, parseDecidedParams({ changed: "1" }, "confirmed"), RUNS)).rows.map(
        (r) => r.grantId,
      ),
    ).toEqual(["G1"]);
    const rej = await loadDecidedPage(c, parseDecidedParams({ by: "curator" }, "rejected"), RUNS);
    expect(rej.rows.map((r) => r.grantId)).toEqual(["G5"]);
    expect(rej.rows[0]!.reason).toBe("Curator: A different person with the same name");
    expect(
      (await loadDecidedPage(c, parseDecidedParams({ q: "g4" }, "unproven"), RUNS)).rows.map(
        (r) => r.grantId,
      ),
    ).toEqual(["G4"]);
  });

  it("leaves out a hidden award a person lifted by hand, and keeps a confirmed one the check could not lift yet", async () => {
    const page = await loadDecidedPage(
      client({
        ...data,
        supps: [
          ...data.supps,
          {
            entityId: "G3",
            createdBy: "system-unverified",
            createdAt: new Date(),
            revokedAt: new Date(),
            revokedBy: "zzc0009",
          },
          {
            entityId: "G2",
            createdBy: "system-unverified",
            createdAt: new Date(),
            revokedAt: null,
            revokedBy: null,
          },
        ],
      }),
      parseDecidedParams({}, "confirmed"),
      RUNS,
    );
    expect(page.counts.rejected.auto).toBe(0);
    expect(page.rows.find((r) => r.grantId === "G2")?.stillHidden).toBe(true);
  });

  it("leaves out an auto award whose score row is gone", async () => {
    const page = await loadDecidedPage(
      client({
        scores: [],
        reviews: [
          {
            id: "r1",
            grantExternalId: "G9",
            cwid: "zza0001",
            status: "withdrawn",
            decidedAt: null,
            decidedByCwid: null,
            rejectionReason: null,
            score: 3,
            band: "show",
            cues: [],
            award: {},
          },
        ],
      }),
      parseDecidedParams({}, "confirmed"),
      RUNS,
    );
    expect(page.counts.confirmed.all).toBe(0);
  });

  it("leaves out an auto-confirmed award someone hid outside the queue", async () => {
    const page = await loadDecidedPage(
      client({
        ...data,
        supps: [
          ...data.supps,
          {
            entityId: "G2",
            createdBy: "zzc0009",
            createdAt: new Date(),
            revokedAt: null,
            revokedBy: null,
          },
        ],
      }),
      parseDecidedParams({}, "confirmed"),
      RUNS,
    );
    expect(page.rows.map((r) => r.grantId)).toEqual(["G1"]);
  });
});

const ROW: DecidedRow = {
  grantId: "reporter:zza0001:R01XX000001",
  reviewId: null,
  tab: "confirmed",
  by: "auto",
  was: "hidden",
  changed: true,
  stillHidden: false,
  when: "2026-10-25T11:00:00.000Z",
  decidedByName: null,
  rejectionReason: null,
  score: 3,
  cues: [
    {
      id: "profile_proven",
      weight: 4,
      reason: "2 other awards on the same NIH profile are cited by the scholar's papers",
    },
    {
      id: "copi_coauthor",
      weight: 2,
      reason: "A co-PI on this award co-authored 2 of the scholar's papers",
      coPi: {
        name: "EXAMPLE, PAT D",
        total: 2,
        papers: [
          { pmid: "111", title: "A shared synthetic paper", journal: "J Example", year: 2024 },
          { pmid: "222", title: "Another synthetic paper", journal: "J Example", year: 2023 },
        ],
      },
    },
    {
      id: "middle_initial_conflict",
      weight: -4,
      reason: "The NIH PI's middle initial differs from the scholar's",
    },
  ],
  award: {
    title: "A synthetic study",
    awardNumber: "R01XX000001",
    coreProjectNum: "R01XX000001",
    activityCode: "R01",
    applId: 123,
    startYear: 2014,
    endYear: 2019,
    orgs: [{ name: "Elsewhere University", from: 2014, to: 2019 }],
    piNames: ["SAMPLE, LEE D"],
  },
  reporterName: "SAMPLE, LEE D",
  reason: "2 other awards on the same NIH profile are cited by the scholar's papers",
  scholar: {
    cwid: "zza0001",
    slug: "lee-sample",
    name: "Sample, Lee A",
    displayName: "Lee A. Sample, PhD",
    degrees: "PhD",
    title: null,
    department: "Medicine",
    career: "PhD 2009",
    names: ["Lee A. Sample"],
  },
};
const page = (over: Partial<DecidedPage> = {}): DecidedPage => ({
  params: parseDecidedParams({}, "confirmed"),
  counts: {
    confirmed: { all: 1, curator: 0, auto: 1 },
    rejected: { all: 0, curator: 0, auto: 0 },
    unproven: { all: 0, curator: 0, auto: 0 },
  },
  changed: { confirmed: 1, rejected: 0, unproven: 0 },
  matched: 1,
  rows: [ROW],
  unprovenIds: [],
  ...over,
});

/** The board on a decided tab, as the page renders it. */
function board(p: DecidedPage, readOnly = false) {
  const tab = p.params.tab === "rejected" ? "rejected" : "confirmed";
  return render(
    <GrantAttributionBoard
      tab={tab}
      rows={p.rows.map(fromDecidedRow)}
      counts={{ pending: 5, confirmed: p.counts.confirmed.all, rejected: p.counts.rejected.all }}
      readOnly={readOnly}
      server={{
        params: p.params,
        matched: p.matched,
        byCounts: { curator: p.counts[tab].curator, auto: p.counts[tab].auto },
        changed: p.changed[tab],
      }}
    />,
  );
}

describe("the board on a decided tab", () => {
  const detail = () => within(screen.getByTestId("grant-attribution-detail"));
  const item = () => within(screen.getByTestId(`grant-attribution-item-${ROW.grantId}`));
  const fetchOk = (body: unknown = {}) => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify(body), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("lists the scholar with the evidence chip and who placed it, apart from the evidence", () => {
    board(page());
    expect(item().getByText("Lee A. Sample, PhD")).toBeTruthy();
    expect(item().getByTestId("grant-attribution-level").textContent).toBe("+3Supports");
    expect(item().getByText("Automatic · Oct 25 · was hidden")).toBeTruthy();
    expect(detail().getByTestId("grant-attribution-decision").textContent).toContain(
      "Confirmed automatically · Oct 25",
    );
    expect(detail().getByTestId("grant-attribution-decision").textContent).toContain(
      "Can move if the weekly check finds evidence against.",
    );
    expect(
      detail().getByTestId("grant-attribution-on-award").querySelector("mark")?.textContent,
    ).toBe("D");
    expect(detail().getByText("Medicine · PhD 2009")).toBeTruthy();
    expect(detail().getByText("RePORTER ↗").getAttribute("href")).toContain("123");
  });

  it("shows a curator's decision as a decision, never as score", () => {
    board(
      page({
        rows: [
          {
            ...ROW,
            by: "curator",
            reviewId: "rev-9",
            decidedByName: "Kim Curator",
            when: "2026-10-28T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(item().getByText("Curator · Oct 28")).toBeTruthy();
    expect(item().getByTestId("grant-attribution-level").textContent).toBe("+3Supports");
    expect(detail().getByTestId("grant-attribution-decision").textContent).toContain(
      "Confirmed by Kim Curator · Oct 28",
    );
    expect(detail().getByTestId("grant-attribution-decision").textContent).toContain(
      "Won’t change on its own.",
    );
  });

  it("adds the score up in one ledger: start, each cue, the total on the scale", () => {
    board(page());
    const ev = within(detail().getByTestId("grant-attribution-evidence"));
    expect(ev.getByText("Every award starts here")).toBeTruthy();
    expect(ev.getByText("Main reason")).toBeTruthy();
    expect(ev.getByText("A shared synthetic paper")).toBeTruthy();
    expect(ev.getByText("Score · Supports")).toBeTruthy();
    expect(ev.getByRole("img").getAttribute("aria-label")).toBe(
      "Score +3. Hide at −2 or below, confirm at +2 or above.",
    );
    fireEvent.click(detail().getByTestId("grant-attribution-nothing-toggle"));
    expect(detail().getByText("No confirmed paper of the scholar cites this award")).toBeTruthy();
  });

  it("marks an auto-confirmed award not this person by grant, with a reason, and offers Undo", async () => {
    const fetchMock = fetchOk({ reviews: { [ROW.grantId]: "rev-new" } });
    board(page());
    fireEvent.click(detail().getByRole("button", { name: /^Not this person/ }));
    await act(async () => {
      fireEvent.click(screen.getByText("A different person with the same name"));
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/edit/grant-attribution/decision");
    expect(JSON.parse(init.body as string)).toEqual({
      grant: ROW.grantId,
      decision: "reject",
      reason: "A different person with the same name",
    });
    expect(screen.queryByTestId(`grant-attribution-item-${ROW.grantId}`)).toBeNull();
    expect(screen.getByTestId("grant-attribution-tab-rejected").textContent).toContain("1");
    await act(async () => {
      fireEvent.click(screen.getByTestId("grant-attribution-status-undo"));
    });
    // Undo leaves the award in review.
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({
      id: "rev-new",
      decision: "undo",
    });
    expect(screen.getByTestId("grant-attribution-status").textContent).toContain(
      "Moved the award back to review.",
    );
    // It is in To review now, not back on this tab.
    expect(screen.queryByTestId(`grant-attribution-item-${ROW.grantId}`)).toBeNull();
    expect(screen.getByTestId("grant-attribution-tab-pending").textContent).toContain("6");
  });

  it("confirms a curator's rejection instead by grant, so the route undoes it first", async () => {
    const fetchMock = fetchOk({ reviews: { "g-cur": "rev-9" } });
    const curator = {
      ...ROW,
      tab: "rejected" as const,
      grantId: "g-cur",
      by: "curator" as const,
      reviewId: "rev-9",
    };
    board(page({ params: parseDecidedParams({}, "rejected"), rows: [curator] }));
    await act(async () => {
      fireEvent.click(detail().getByRole("button", { name: /^Confirm instead/ }));
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      grant: "g-cur",
      decision: "confirm",
    });
  });

  it("moves a curator decision to review by undoing it, and an auto one through requeue", async () => {
    const fetchMock = fetchOk();
    const curator = { ...ROW, grantId: "g-cur", by: "curator" as const, reviewId: "rev-9" };
    board(page({ rows: [ROW, curator], matched: 2 }));
    await act(async () => {
      fireEvent.click(detail().getByRole("button", { name: /^Move to review/ }));
    });
    await act(async () => {
      fireEvent.click(detail().getByRole("button", { name: /^Move to review/ }));
    });
    const calls = fetchMock.mock.calls;
    expect(calls[0]![0]).toBe("/api/edit/grant-attribution/requeue");
    expect(calls[1]![0]).toBe("/api/edit/grant-attribution/decision");
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ id: "rev-9", decision: "undo" });
    expect(screen.getByTestId("grant-attribution-empty")).toBeTruthy();
  });

  it("moves several to review from the list header", async () => {
    const fetchMock = fetchOk();
    const curator = { ...ROW, grantId: "g-cur", by: "curator" as const, reviewId: "rev-9" };
    board(page({ rows: [ROW, curator], matched: 2 }));
    fireEvent.click(screen.getByLabelText("Select all shown"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("grant-attribution-bulk-review"));
    });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/edit/grant-attribution/decision",
      "/api/edit/grant-attribution/requeue",
    ]);
    expect(screen.getByTestId("grant-attribution-status").textContent).toContain(
      "Moved to review: 2 awards",
    );
  });

  it("gives a read-only viewer the evidence but no actions", () => {
    board(page(), true);
    expect(screen.queryByRole("button", { name: /^Not this person/ })).toBeNull();
    expect(detail().getByTestId("grant-attribution-evidence")).toBeTruthy();
  });

  it("offers Show all past one page, and a way back to paging", () => {
    board(page({ matched: DECIDED_PAGE_SIZE + 1 }));
    expect(
      screen.getByText(`Showing 1–${DECIDED_PAGE_SIZE} of ${DECIDED_PAGE_SIZE + 1}`),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("grant-attribution-show-all"));
    expect(push).toHaveBeenLastCalledWith("?tab=confirmed&all=1", { scroll: false });
  });

  it("hides the pager when showing all", () => {
    board(
      page({
        matched: DECIDED_PAGE_SIZE + 1,
        params: { ...parseDecidedParams({ all: "1" }, "confirmed") },
      }),
    );
    expect(screen.queryByText("Next")).toBeNull();
    fireEvent.click(screen.getByTestId("grant-attribution-show-paged"));
    expect(push).toHaveBeenLastCalledWith("?tab=confirmed", { scroll: false });
  });

  it("no pager when everything fits on one page", () => {
    board(page());
    expect(screen.queryByTestId("grant-attribution-show-all")).toBeNull();
  });

  it("puts filters and sort in the URL", () => {
    board(page());
    fireEvent.click(screen.getByTestId("grant-attribution-by-auto"));
    expect(push).toHaveBeenCalledWith("?tab=confirmed&by=auto", { scroll: false });
    fireEvent.click(screen.getByTestId("grant-attribution-changed"));
    expect(push).toHaveBeenLastCalledWith("?tab=confirmed&changed=1", { scroll: false });
    fireEvent.change(screen.getByLabelText(/Evidence/), { target: { value: "supports" } });
    expect(push).toHaveBeenLastCalledWith("?tab=confirmed&level=supports", { scroll: false });
    fireEvent.change(screen.getByDisplayValue("Score, low to high"), { target: { value: "name" } });
    expect(push).toHaveBeenLastCalledWith("?tab=confirmed&sort=name", { scroll: false });
  });
});
