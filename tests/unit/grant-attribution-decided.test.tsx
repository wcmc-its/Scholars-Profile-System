/**
 * #3071 — the queue's decided tabs (Confirmed, Not this person, Unproven):
 * where an award lands, the URL state, the loader's filters and counts, and
 * the rows, evidence panel and actions. Fixture people and awards are invented.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

import { DecidedAwards } from "@/components/edit/grant-attribution-decided";
import {
  checkedNothingFound,
  decidedHref,
  decidedTabOf,
  marginText,
  nameParts,
  parseDecidedParams,
  parseQueueTab,
  partsDiffer,
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
      { by: "auto", changed: "1", group: "1", sort: "recent", q: " lee ", page: "3" },
      "confirmed",
    );
    expect(p).toEqual({
      tab: "confirmed",
      by: "auto",
      changed: true,
      group: true,
      sort: "recent",
      q: "lee",
      page: 3,
    });
    expect(decidedHref(p)).toBe(
      "?tab=confirmed&by=auto&changed=1&group=1&sort=recent&q=lee&page=3",
    );
    expect(decidedHref(parseDecidedParams({}, "rejected"))).toBe("?tab=rejected");
    // "Changed this run" only exists on Confirmed; Unproven defaults to most recent.
    expect(parseDecidedParams({ changed: "1" }, "rejected").changed).toBe(false);
    expect(parseDecidedParams({}, "unproven").sort).toBe("recent");
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
    expect(partsDiffer("D", "A")).toBe(true);
    expect(partsDiffer("L", "Lee")).toBe(false);
    expect(partsDiffer("", "A")).toBe(false);
  });

  it("says how far a score sits from its line", () => {
    expect(marginText("confirmed", 2, "auto")).toBe("confirms at +2");
    expect(marginText("confirmed", 4, "auto")).toBe("2 over the line");
    expect(marginText("rejected", -8, "auto")).toBe("6 under the line");
    expect(marginText("rejected", -8, "curator")).toBe("curator decided");
  });

  it("lists only the checks that found nothing", () => {
    const n = checkedNothingFound(new Set(["pub_linked", "wcm_org_shared_name"]));
    expect(n).not.toContain("No confirmed paper of the scholar cites this award");
    expect(n).not.toContain("Not held at WCM");
    expect(n).toContain("No co-PI co-authors with the scholar");
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
    expect(page.changed).toBe(1);
    expect(page.rows.map((r) => r.grantId)).toEqual(["G1", "G2"]);
    expect(page.rows[0]).toMatchObject({
      was: "hidden",
      reason: "linked",
      scholar: { name: "Sample, Lee A", career: "PhD 2009" },
    });
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

  it("groups by scholar, with what they have on the other tabs", async () => {
    const page = await loadDecidedPage(
      client(data),
      parseDecidedParams({ group: "1" }, "rejected"),
      RUNS,
    );
    expect(page.rows).toEqual([]);
    expect(page.groups).toHaveLength(1);
    expect(page.groups![0]).toMatchObject({
      cwid: "zza0002",
      here: 2,
      elsewhere: { unproven: 1 },
      total: 3,
    });
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
    degrees: "PhD",
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
  changed: 1,
  matched: 1,
  rows: [ROW],
  groups: null,
  ...over,
});

describe("DecidedAwards", () => {
  const row = () => within(screen.getByTestId(`grant-attribution-row-${ROW.grantId}`));

  it("shows the scholar, the name on the award with its difference marked, the score and why", () => {
    render(<DecidedAwards page={page()} readOnly={false} />);
    expect(row().getByText("Sample, Lee A")).toBeTruthy();
    expect(row().getByTestId("grant-attribution-on-award").querySelector("mark")?.textContent).toBe(
      "D",
    );
    expect(row().getByText("+3")).toBeTruthy();
    expect(row().getByText("1 over the line")).toBeTruthy();
    expect(row().getByText(/Auto-confirmed · was hidden/)).toBeTruthy();
    expect(
      row()
        .getByRole("link", { name: /R01XX000001 in NIH RePORTER/ })
        .getAttribute("href"),
    ).toContain("123");
  });

  it("opens the evidence ledger: start, each cue with its weight, the total and what was not found", () => {
    render(<DecidedAwards page={page()} readOnly={false} />);
    fireEvent.click(row().getByTestId(`grant-attribution-evidence-${ROW.grantId}`));
    const ev = within(screen.getAllByTestId("grant-attribution-evidence")[0]!);
    expect(ev.getByText("Every award starts here")).toBeTruthy();
    expect(ev.getByText("Main reason")).toBeTruthy();
    expect(ev.getByText("A shared synthetic paper")).toBeTruthy();
    expect(ev.getByRole("button", { name: "Copy 2 PMIDs: 111, 222" })).toBeTruthy();
    expect(ev.getByText("Score: confirmed")).toBeTruthy();
    // Once as the names verdict, once as the ledger item.
    expect(ev.getAllByText(/^Middle initial differs/).length).toBe(2);
    expect(ev.getByText("No confirmed paper of the scholar cites this award")).toBeTruthy();
  });

  it("marks an auto-confirmed award not this person by grant, with a reason", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DecidedAwards page={page()} readOnly={false} />);
    fireEvent.click(row().getByRole("button", { name: "Not this person" }));
    fireEvent.change(row().getByLabelText("Rejection reason"), {
      target: { value: "A different person with the same name" },
    });
    await act(async () => {
      fireEvent.click(row().getByRole("button", { name: "Not this person" }));
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/edit/grant-attribution/decision");
    expect(JSON.parse(init.body as string)).toEqual({
      grant: ROW.grantId,
      decision: "reject",
      reason: "A different person with the same name",
    });
    expect(row().getByText("Marked not this person.")).toBeTruthy();
  });

  it("moves a curator decision to review by undoing it, and an auto one through requeue", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const curator = { ...ROW, grantId: "g-cur", by: "curator" as const, reviewId: "rev-9" };
    render(<DecidedAwards page={page({ rows: [ROW, curator], matched: 2 })} readOnly={false} />);
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("grant-attribution-row-g-cur")).getByRole("button", {
          name: "Move to review",
        }),
      );
    });
    await act(async () => {
      fireEvent.click(row().getByRole("button", { name: "Move to review" }));
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe("/api/edit/grant-attribution/decision");
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ id: "rev-9", decision: "undo" });
    expect(calls[1]![0]).toBe("/api/edit/grant-attribution/requeue");
  });

  it("gives a read-only viewer the evidence but no actions", () => {
    render(<DecidedAwards page={page()} readOnly />);
    expect(row().queryByRole("button", { name: "Not this person" })).toBeNull();
    expect(row().getByTestId(`grant-attribution-evidence-${ROW.grantId}`)).toBeTruthy();
  });

  it("puts filters in the URL", () => {
    render(<DecidedAwards page={page()} readOnly={false} />);
    fireEvent.click(screen.getByTestId("grant-attribution-by-auto"));
    expect(push).toHaveBeenCalledWith("?tab=confirmed&by=auto", { scroll: false });
    fireEvent.click(screen.getByTestId("grant-attribution-changed"));
    expect(push).toHaveBeenLastCalledWith("?tab=confirmed&changed=1", { scroll: false });
  });
});
