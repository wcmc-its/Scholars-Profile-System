/**
 * The ORCID librarian queue page gate, its loader, and the client.
 *
 *   - Page: no session → SSO redirect; flag off → 404 for everyone; a
 *     non-superuser → ForbiddenEditPage; a superuser gets the queue. The tab
 *     predicate is the page gate (flag + isSuperuser).
 *   - Loader: a dismissed or on-file pair is never a row; a scholar holding a
 *     DIFFERENT iD goes to Conflicts; Email verified also lists the ETL's
 *     confirmed iDs; an open sample's rows come first.
 *   - Client: chips, the new-works sample, Confirm / Not this person; the
 *     sample panel's three states.
 *   - v2: one card per scholar (every candidate iD, best first; the card in
 *     its best band's tab; counts are scholars), the filter (person facets +
 *     source) on list and counts, chips that open to their facts, names side
 *     by side, every work linked, Confirm sending the others to dismiss.
 *   - v2.1: each new work's ReCiter status chip and its Publication Manager
 *     link (review for pending / rejected, add for a DOI not in PubMed), the
 *     status split in the preview header, and the https-only PM base URL.
 *
 * Fixture people and iDs are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  rawSession: vi.fn(),
  load: vi.fn(),
  shell: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  facets: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`__REDIRECT__ ${to}`);
  }),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("next/navigation", () => ({
  notFound: h.notFound,
  redirect: h.redirect,
  useRouter: () => ({ refresh: h.refresh, replace: h.replace }),
}));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.session,
  impersonationActive: vi.fn(() => false),
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.rawSession }));
vi.mock("@/lib/api/data-quality", () => ({ loadDataQualityFacets: h.facets }));
vi.mock("@/lib/edit/orcid-queue.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/orcid-queue.server")>()),
  loadOrcidQueue: h.load,
}));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: (props: { children: unknown }) => {
    h.shell(props);
    return null;
  },
}));
vi.mock("@/lib/edit/honor-queue", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/honor-queue")>()),
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn(),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn(),
}));

import OrcidQueuePage from "@/app/edit/orcid-queue/page";
import { OrcidQueue } from "@/components/edit/orcid-queue";
import { TAB_PREDICATES } from "@/lib/edit/console-tabs.server";
import {
  cardTabOf,
  EMPTY_ORCID_QUEUE_FILTER,
  isOrcidQueueTabVisible,
  orcidQueueFilterKey,
  orcidQueueHref,
  pairState,
  parseOrcidQueueFilter,
  pmCurateHref,
  publicationManagerBaseUrl,
  sanitizeOrcidQueueFilter,
  workHref,
  type OrcidEvidenceDetail,
  type OrcidQueueCard,
  type OrcidQueueData,
  type OrcidQueueRow,
} from "@/lib/edit/orcid-queue";

const ORCID = "0000-0002-1825-0097";
const OTHER = "0000-0000-0000-001X";
const SUPER = { cwid: "lib0001", isSuperuser: true };
const STEWARD = { cwid: "cs00001", isSuperuser: false, isCommsSteward: true };

const EMPTY_COUNTS = {
  email_verified: 0,
  strong: 0,
  shared_only: 0,
  moderate: 0,
  weak: 0,
  conflicts: 0,
};
const data = (over: Partial<OrcidQueueData> = {}): OrcidQueueData => ({
  tab: "strong",
  cards: [],
  counts: EMPTY_COUNTS,
  filter: EMPTY_ORCID_QUEUE_FILTER,
  sample: null,
  remaining: null,
  ...over,
});
const DETAIL: OrcidEvidenceDetail = {
  names: {
    orcid: { credit: "J. Doe", given: "Jane", family: "Doe", other: ["Jane Q. Doe"] },
    givenAgrees: true,
    surnameRule: "same",
  },
  institutions: [
    {
      orcid: { name: "Example Medical College", kind: "employment", start: 1996, end: 2001 },
      ours: { name: "Example Medical College of Example University", source: "identity" },
    },
  ],
  institutionEmail: null,
  email: null,
  shared: [
    { pmid: "101", doi: "10.1/a", title: "A shared paper", year: 2020, journal: "J Example" },
    { pmid: "102", doi: null, title: null, year: null, journal: null },
  ],
  competitors: { cwids: [], orcids: [] },
  sources: ["orcid_works", "rpm_inferred"],
  worksDropped: 1,
  workStatus: {
    counts: { pending: 1, rejected: 1, not_in_pubmed: 1 },
    unknown: 0,
    reciterRead: true,
    acceptedInReciter: 2,
    resolvedByDoi: 4,
    resolvedByTitle: 1,
  },
};
const STATUS_SAMPLE = [
  {
    title: "A pending paper",
    year: 2025,
    doi: "10.9/p",
    pmid: "901",
    source: "Crossref",
    url: null,
    status: "pending" as const,
  },
  {
    title: "A rejected paper",
    year: 2024,
    doi: null,
    pmid: "902",
    source: null,
    url: null,
    status: "rejected" as const,
  },
  {
    title: "A paper PubMed lacks",
    year: 2023,
    doi: "10.9/a b<c>",
    pmid: null,
    source: null,
    url: null,
    status: "not_in_pubmed" as const,
  },
  {
    title: "A paper never retrieved",
    year: 2022,
    doi: null,
    pmid: "903",
    source: null,
    url: null,
    status: "not_retrieved" as const,
  },
];
const ROW: OrcidQueueRow = {
  cwid: "jd0001",
  orcid: ORCID,
  band: "strong",
  state: "queue",
  instMatch: false,
  historyMatch: true,
  emailVerified: false,
  nameAgrees: true,
  shared: 7,
  competitor: false,
  competitors: [],
  competitorOrcids: [],
  worksTotal: 12,
  newWorks: 2,
  newWorksSample: [
    { title: "A synthetic study", year: 2025, doi: null, pmid: "999", source: "Crossref" },
    { title: "A DOI-only study", year: 2024, doi: "10.9/x", pmid: null, source: null },
    {
      title: "A link-only work",
      year: 2023,
      doi: null,
      pmid: null,
      source: null,
      url: "https://example.org/w",
    },
  ],
  sources: ["orcid_works", "rpm_inferred"],
  detail: DETAIL,
  onFileOrcid: null,
  autoConfirmed: false,
};
const CARD = (
  over: Partial<OrcidQueueCard> = {},
  rows: OrcidQueueRow[] = [ROW],
): OrcidQueueCard => ({
  cwid: "jd0001",
  slug: "jane-doe",
  name: "Jane Doe, MD",
  scholarNames: ["Jane Q Doe", "Jane Doe"],
  title: "Professor of Medicine",
  department: "Medicine",
  tab: "strong",
  candidates: rows,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ORCID_LIBRARIAN_QUEUE", "on");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.load.mockResolvedValue(data());
  h.rawSession.mockResolvedValue({ cwid: "lib0001" });
  h.facets.mockResolvedValue({
    roleCategories: [],
    departments: [],
    centers: [],
    institutions: [],
  });
});

describe("page gate", () => {
  it("no session → SSO redirect back to the queue", async () => {
    h.session.mockResolvedValue(null);
    await expect(OrcidQueuePage({})).rejects.toThrow(
      "__REDIRECT__ /api/auth/saml/login?return=/edit/orcid-queue",
    );
  });

  it("flag off → 404, even for a superuser", async () => {
    vi.stubEnv("ORCID_LIBRARIAN_QUEUE", "off");
    h.session.mockResolvedValue(SUPER);
    await expect(OrcidQueuePage({})).rejects.toThrow("__NOT_FOUND__");
  });

  it("a non-superuser gets the 403 page and no queue read", async () => {
    h.session.mockResolvedValue(STEWARD);
    render(await OrcidQueuePage({}));
    expect(h.load).not.toHaveBeenCalled();
  });

  it("a superuser gets the queue for the requested tab", async () => {
    h.session.mockResolvedValue(SUPER);
    render(
      await OrcidQueuePage({
        searchParams: Promise.resolve({
          tab: "conflicts",
          type: "faculty",
          unit: ["div:CARD", "center:X"],
          source: ["orcid_works", "bogus"],
        }),
      }),
    );
    expect(h.load).toHaveBeenCalledWith({}, "conflicts", {
      types: ["faculty"],
      units: ["div:CARD"],
      sources: ["orcid_works"],
    });
    expect(h.shell).toHaveBeenCalledWith(expect.objectContaining({ active: "orcid-queue" }));
  });

  it("the tab predicate is the page gate", () => {
    const g = {
      ownerUnitCount: 0,
      manageableUnitCount: 0,
      reportableUnitCount: 0,
      viewerCanViewUsage: true,
      reportAccessCount: 0,
      dashboards: new Set(),
    } as never;
    expect(TAB_PREDICATES.orcidQueue(SUPER as never, g)).toBe(true);
    expect(TAB_PREDICATES.orcidQueue(STEWARD as never, g)).toBe(false);
    vi.stubEnv("ORCID_LIBRARIAN_QUEUE", "off");
    expect(isOrcidQueueTabVisible(SUPER)).toBe(false);
  });
});

describe("loader", () => {
  it("pairState: on file, dismissed, conflict, queue", () => {
    expect(pairState(ORCID, ORCID, false)).toBe("on_file");
    expect(pairState(ORCID, null, true)).toBe("dismissed");
    expect(pairState(ORCID, OTHER, false)).toBe("conflict");
    expect(pairState(ORCID, null, false)).toBe("queue");
  });

  it("cardTabOf: email verified, then conflicts, then the best band", () => {
    expect(
      cardTabOf([
        { band: "weak", state: "queue" },
        { band: "strong", state: "queue" },
      ]),
    ).toBe("strong");
    expect(cardTabOf([{ band: "strong", state: "conflict" }])).toBe("conflicts");
    expect(
      cardTabOf([
        { band: "email_verified", state: "auto_confirmed" },
        { band: "strong", state: "conflict" },
      ]),
    ).toBe("email_verified");
  });

  // The page test mocks the loader; these cases run the real one.
  const realLoad: typeof import("@/lib/edit/orcid-queue.server").loadOrcidQueue = async (c, t, f) =>
    (
      await vi.importActual<typeof import("@/lib/edit/orcid-queue.server")>(
        "@/lib/edit/orcid-queue.server",
      )
    ).loadOrcidQueue(c, t, f);

  const OTHER_2 = "0000-0001-5109-3700";
  const client = (
    opts: {
      sample?: Array<{ cwid: string; orcid: string; decision: string | null }>;
      sampleFilterKey?: string;
      admins?: Array<{ cwid: string; orcid: string }>;
      rescored?: boolean;
      /** Manual division code → its hand-added roster. */
      rosters?: Record<string, string[]>;
    } = {},
  ) => {
    const evidence = [
      { cwid: "a00001", orcid: ORCID, band: "strong", shared: 4 },
      { cwid: "a00001", orcid: OTHER_2, band: "weak", shared: 0 }, // a's second candidate
      { cwid: "b00001", orcid: ORCID, band: "strong", shared: 4 }, // dismissed
      { cwid: "c00001", orcid: ORCID, band: "strong", shared: 4 }, // holds a different iD
      { cwid: "d00001", orcid: OTHER, band: "strong", shared: 9 },
      { cwid: "f00001", orcid: OTHER, band: "moderate", shared: 1 },
    ];
    const held: Record<string, string | null> = {
      a00001: null,
      b00001: null,
      c00001: OTHER,
      d00001: null,
      f00001: null,
    };
    const roles: Record<string, string> = { d00001: "postdoc" };
    const units: Record<
      string,
      { deptCode: string; divCode: string | null; primaryOrgCode: string }
    > = {
      a00001: { deptCode: "MED", divCode: "CARD", primaryOrgCode: "WCM" },
      c00001: { deptCode: "MED", divCode: null, primaryOrgCode: "WCM" },
      d00001: { deptCode: "SURG", divCode: null, primaryOrgCode: "WCM" },
      f00001: { deptCode: "PEDS", divCode: null, primaryOrgCode: "HSS" },
    };
    // personFilterWhere's unit clause: { OR: [{ deptCode: { in } } | { cwid: { in } } | …] }.
    const inUnit = (c: string, w?: { OR?: Array<Record<string, { in: string[] }>> }) =>
      !w?.OR ||
      w.OR.some((o) =>
        Object.entries(o).some(([field, v]) =>
          field === "cwid"
            ? v.in.includes(c)
            : v.in.includes((units[c] as Record<string, string | null> | undefined)?.[field] ?? ""),
        ),
      );
    return {
      orcidCandidateEvidence: {
        findMany: vi.fn(
          async (args: {
            select?: unknown;
            where?: { OR?: Array<{ cwid: string; orcid: string }> };
          }) =>
            args.where?.OR
              ? evidence
                  .filter((e) =>
                    args.where!.OR!.some((o) => o.cwid === e.cwid && o.orcid === e.orcid),
                  )
                  .map((e) => ({
                    ...e,
                    instMatch: true,
                    historyMatch: false,
                    emailVerified: false,
                    nameAgrees: true,
                    competitor: false,
                    competitorCwids: [],
                    competitorOrcids: [],
                    worksTotal: 5,
                    newWorks: 1,
                    newWorksSample:
                      e.cwid === "a00001"
                        ? [...STATUS_SAMPLE, { title: "Old row", year: 2020, status: "bogus" }]
                        : [],
                    evidenceDetail: e.cwid === "a00001" ? DETAIL : null,
                  }))
              : evidence.map((e) => ({ ...e, nameAgrees: true })),
        ),
        findFirst: vi.fn(async () => (opts.rescored ? { cwid: "a00001" } : null)),
      },
      orcidCandidate: {
        findMany: vi.fn(async () => [
          ...(opts.admins ?? []).map((a) => ({ ...a, source: "rpm_admin" })),
          { cwid: "a00001", orcid: ORCID, source: "orcid_works" },
          { cwid: "a00001", orcid: ORCID, source: "rpm_inferred" },
          { cwid: "d00001", orcid: OTHER, source: "rpm_inferred" },
        ]),
      },
      division: {
        findMany: vi.fn(async (args: { where: { code: { in: string[] } } }) =>
          args.where.code.in.filter((c) => opts.rosters?.[c]).map((code) => ({ code })),
        ),
      },
      divisionMembership: {
        findMany: vi.fn(async (args: { where: { divisionCode: { in: string[] } } }) =>
          args.where.divisionCode.in.flatMap((d) =>
            (opts.rosters?.[d] ?? []).map((cwid) => ({ cwid })),
          ),
        ),
      },
      scholar: {
        findMany: vi.fn(
          async (args: {
            where: {
              orcidConfirmMethod?: string;
              cwid?: { in: string[] };
              roleCategory?: { in: string[] };
              AND?: Array<{ OR?: Array<Record<string, { in: string[] }>> }>;
            };
          }) =>
            args.where.orcidConfirmMethod
              ? [{ cwid: "e00001", orcid: ORCID }]
              : (args.where.cwid?.in ?? [])
                  .filter(
                    (c) =>
                      !args.where.roleCategory ||
                      args.where.roleCategory.in.includes(roles[c] ?? "faculty"),
                  )
                  .filter((c) => (args.where.AND ?? []).every((w) => inUnit(c, w)))
                  .map((c) => ({
                    cwid: c,
                    orcid: held[c] ?? null,
                    status: "active",
                    deletedAt: null,
                    slug: c,
                    preferredName: c,
                    fullName: c,
                  })),
        ),
      },
      orcidDismissal: { findMany: vi.fn(async () => [{ cwid: "b00001", orcid: ORCID }]) },
      orcidQueueSample: {
        findFirst: vi.fn(async () =>
          opts.sample
            ? { id: "s1", startedAt: new Date(0), filterKey: opts.sampleFilterKey ?? "" }
            : null,
        ),
        findMany: vi.fn(async () => opts.sample ?? []),
      },
    } as never;
  };

  it("one card per scholar, every candidate best first; dismissed pairs drop; counts are scholars", async () => {
    const q = await realLoad(client(), "strong");
    expect(q.cards.map((c) => c.cwid)).toEqual(["d00001", "a00001"]); // most shared first
    const a = q.cards.find((c) => c.cwid === "a00001")!;
    expect(a.candidates.map((r) => [r.orcid, r.band])).toEqual([
      [ORCID, "strong"],
      [OTHER_2, "weak"],
    ]);
    expect(a.candidates[0]).toMatchObject({
      sources: ["orcid_works", "rpm_inferred"],
      detail: DETAIL,
    });
    // v2.1: each work's status survives the read; an unknown value is dropped.
    expect(a.candidates[0]!.newWorksSample.map((w) => w.status)).toEqual([
      "pending",
      "rejected",
      "not_in_pubmed",
      "not_retrieved",
      undefined,
    ]);
    expect(q.counts).toMatchObject({
      strong: 2,
      moderate: 1,
      weak: 0,
      conflicts: 1,
      email_verified: 1,
    });
    const c = await realLoad(client(), "conflicts");
    expect(c.cards).toEqual([
      expect.objectContaining({
        cwid: "c00001",
        candidates: [expect.objectContaining({ state: "conflict", onFileOrcid: OTHER })],
      }),
    ]);
  });

  it("an rpm_admin iD is on file: that scholar's card goes to Conflicts", async () => {
    const admins = [{ cwid: "a00001", orcid: OTHER }];
    const q = await realLoad(client({ admins }), "strong");
    expect(q.cards.map((r) => r.cwid)).toEqual(["d00001"]);
    const c = await realLoad(client({ admins }), "conflicts");
    expect(c.cards.map((r) => r.cwid).sort()).toEqual(["a00001", "c00001"]);
  });

  it("the filter narrows the cards and the counts: person type, and how discovered", async () => {
    const byType = await realLoad(client(), "strong", {
      types: ["postdoc"],
      units: [],
      sources: [],
    });
    expect(byType.cards.map((c) => c.cwid)).toEqual(["d00001"]);
    expect(byType.counts).toMatchObject({ strong: 1, conflicts: 0, moderate: 0 });
    const bySource = await realLoad(client(), "strong", {
      types: [],
      units: [],
      sources: ["orcid_works"],
    });
    expect(bySource.cards.map((c) => c.cwid)).toEqual(["a00001"]);
    // A card the filter keeps still lists every candidate.
    expect(bySource.cards[0]!.candidates).toHaveLength(2);
  });

  it("the filter narrows the cards and the counts: department, division (with its manual roster), institution", async () => {
    const byDept = client();
    const dept = await realLoad(byDept, "strong", { types: [], units: ["dept:MED"], sources: [] });
    expect(dept.cards.map((c) => c.cwid)).toEqual(["a00001"]);
    expect(dept.counts).toMatchObject({ strong: 1, conflicts: 1, moderate: 0 });
    // The person query carries the unit OR clause.
    const calls = (byDept as unknown as { scholar: { findMany: { mock: { calls: unknown[][] } } } })
      .scholar.findMany.mock.calls;
    expect(calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({ AND: [{ OR: [{ deptCode: { in: ["MED"] } }] }] }),
      }),
    );

    // A manual division: its column members and its hand-added roster.
    const div = await realLoad(client({ rosters: { CARD: ["d00001"] } }), "strong", {
      types: [],
      units: ["div:CARD"],
      sources: [],
    });
    expect(div.cards.map((c) => c.cwid)).toEqual(["d00001", "a00001"]);

    const inst = await realLoad(client(), "moderate", {
      types: [],
      units: ["inst:HSS"],
      sources: [],
    });
    expect(inst.cards.map((c) => c.cwid)).toEqual(["f00001"]);
    expect(inst.counts).toMatchObject({ strong: 0, moderate: 1, conflicts: 0 });
  });

  it("an open sample's pair still undecided but now in another tab stays decidable on the sample's tab", async () => {
    // f00001's only iD is Moderate now: its card sits in Moderate, but the Strong
    // sample drew it. On Strong it shows with its real state and band, stamping the
    // sample. c00001's sampled iD went on file since: shown in place, decided.
    const q = await realLoad(
      client({
        sample: [
          { cwid: "f00001", orcid: OTHER, decision: null },
          { cwid: "c00001", orcid: OTHER, decision: "confirmed" },
        ],
      }),
      "strong",
    );
    expect(q.sample).toMatchObject({ status: "open", total: 2 });
    expect(q.cards.find((c) => c.cwid === "f00001")!.candidates).toEqual([
      expect.objectContaining({
        orcid: OTHER,
        state: "queue",
        band: "moderate",
        sampleDecision: null,
      }),
    ]);
    expect(q.cards.find((c) => c.cwid === "c00001")!.candidates).toEqual([
      expect.objectContaining({ orcid: OTHER, state: "on_file", sampleDecision: "confirmed" }),
    ]);
  });

  it("a passed sample the ETL re-scored since is stale: no Confirm remaining", async () => {
    const sample = [{ cwid: "d00001", orcid: OTHER, decision: "confirmed" }];
    const fresh = await realLoad(client({ sample }), "strong");
    expect(fresh.sample).toMatchObject({ status: "passed" });
    expect(fresh.sample?.stale).toBeUndefined();
    // a00001's second iD is in a weaker band, so it still qualifies (v1 rule: two in the band).
    expect(fresh.remaining).toBe(1);
    const stale = await realLoad(client({ sample, rescored: true }), "strong");
    expect(stale.sample).toMatchObject({ status: "passed", stale: true });
    expect(stale.remaining).toBeNull();
  });

  it("a passed sample drawn under another filter offers no Confirm remaining here", async () => {
    const sample = [{ cwid: "d00001", orcid: OTHER, decision: "confirmed" }];
    const q = await realLoad(client({ sample, sampleFilterKey: "type=postdoc" }), "strong");
    expect(q.sample).toMatchObject({ status: "passed", filterKey: "type=postdoc" });
    expect(q.remaining).toBeNull();
    const same = await realLoad(client({ sample, sampleFilterKey: "type=postdoc" }), "strong", {
      types: ["postdoc"],
      units: [],
      sources: [],
    });
    expect(same.remaining).toBe(0);
  });

  it("Email verified lists the ETL's confirmed iDs, as auto-confirmed", async () => {
    const q = await realLoad(client(), "email_verified");
    expect(q.cards).toEqual([
      expect.objectContaining({
        cwid: "e00001",
        candidates: [expect.objectContaining({ autoConfirmed: true, state: "auto_confirmed" })],
      }),
    ]);
  });

  it("an open sample's cards come first, with their decisions", async () => {
    const q = await realLoad(
      client({ sample: [{ cwid: "a00001", orcid: ORCID, decision: null }] }),
      "strong",
    );
    expect(q.sample).toMatchObject({ id: "s1", status: "open", total: 1 });
    expect(q.cards[0]!.cwid).toBe("a00001");
    expect(q.cards[0]!.candidates[0]).toMatchObject({ orcid: ORCID, sampleDecision: null });
  });
});

describe("filter and link helpers", () => {
  it("sanitizeOrcidQueueFilter sorts, de-duplicates, and refuses what it does not know", () => {
    expect(
      sanitizeOrcidQueueFilter({
        types: ["b", "a", "a"],
        units: ["inst:X", "dept:Y"],
        sources: ["orcid_name"],
      }),
    ).toEqual({ types: ["a", "b"], units: ["dept:Y", "inst:X"], sources: ["orcid_name"] });
    expect(sanitizeOrcidQueueFilter(undefined)).toEqual(EMPTY_ORCID_QUEUE_FILTER);
    expect(sanitizeOrcidQueueFilter({ units: ["center:X"] })).toBeNull();
    expect(sanitizeOrcidQueueFilter({ sources: ["nope"] })).toBeNull();
    expect(sanitizeOrcidQueueFilter([])).toBeNull();
  });

  it("a filter whose key would not fit filter_key (1024) is refused by the routes, trimmed by the page", () => {
    const units = Array.from(
      { length: 50 },
      (_, i) => `dept:${String(i).padStart(2, "0")}${"X".repeat(60)}`,
    );
    expect(sanitizeOrcidQueueFilter({ units })).toBeNull();
    expect(sanitizeOrcidQueueFilter({ units: units.slice(0, 5) })?.units).toHaveLength(5);
    const parsed = parseOrcidQueueFilter({ unit: units, type: "faculty" });
    expect(orcidQueueFilterKey(parsed).length).toBeLessThanOrEqual(1024);
    expect(parsed.types).toEqual(["faculty"]);
    expect(parsed.units.length).toBeGreaterThan(0);
    expect(sanitizeOrcidQueueFilter(parsed)).toEqual(parsed);
  });

  it("the filter key is canonical and empty for no filter", () => {
    expect(orcidQueueFilterKey(EMPTY_ORCID_QUEUE_FILTER)).toBe("");
    expect(orcidQueueFilterKey({ types: ["b", "a"], units: [], sources: ["orcid_works"] })).toBe(
      "type=a&type=b&source=orcid_works",
    );
    expect(orcidQueueHref("/q", "strong", { types: ["a"], units: [], sources: [] })).toBe(
      "/q?tab=strong&type=a",
    );
    expect(parseOrcidQueueFilter({ type: "a", unit: "nope", source: "orcid_email" })).toEqual({
      types: ["a"],
      units: [],
      sources: ["orcid_email"],
    });
  });

  it("workHref: PubMed, else doi.org, else the work's own https URL", () => {
    expect(workHref({ pmid: "123", doi: "10.1/a" })).toBe("https://pubmed.ncbi.nlm.nih.gov/123/");
    expect(workHref({ pmid: null, doi: "10.1/a" })).toBe("https://doi.org/10.1/a");
    expect(workHref({ url: "https://example.org/w" })).toBe("https://example.org/w");
    expect(workHref({ url: "javascript:alert(1)" })).toBeNull();
    expect(workHref({ url: "http://example.org/w" })).toBeNull();
    expect(workHref({ url: "data:text/html,<b>x</b>" })).toBeNull();
    expect(workHref({ url: "https://" })).toBeNull();
    expect(workHref({})).toBeNull();
    // v2.1: the DOI is URL-encoded per path segment.
    expect(workHref({ doi: "10.1002/(SICI)1097<1::AID>3.0.CO;2-#" })).toBe(
      "https://doi.org/10.1002/(SICI)1097%3C1%3A%3AAID%3E3.0.CO%3B2-%23",
    );
  });

  it("pmCurateHref: https base only, uid and DOI URL-encoded", () => {
    const base = "https://pm.example.org";
    expect(pmCurateHref(base, "jd0001")).toBe("https://pm.example.org/curate/jd0001");
    expect(pmCurateHref(`${base}/`, "jd0001", { doi: "10.9/a b&c=d" })).toBe(
      "https://pm.example.org/curate/jd0001?add=external&doi=10.9%2Fa%20b%26c%3Dd",
    );
    expect(pmCurateHref(base, "a/b")).toBe("https://pm.example.org/curate/a%2Fb");
    expect(pmCurateHref("http://pm.example.org", "jd0001")).toBeNull();
    expect(pmCurateHref("javascript:alert(1)", "jd0001")).toBeNull();
    expect(pmCurateHref("https://u:p@pm.example.org", "jd0001")).toBeNull();
    expect(pmCurateHref(null, "jd0001")).toBeNull();
    expect(pmCurateHref(base, " ")).toBeNull();
  });

  it("publicationManagerBaseUrl: the env's https URL, else the SPS-wide default", () => {
    vi.stubEnv("PUBLICATION_MANAGER_URL", "https://pm-staging.example.org/");
    expect(publicationManagerBaseUrl()).toBe("https://pm-staging.example.org");
    vi.stubEnv("PUBLICATION_MANAGER_URL", "http://insecure.example.org");
    expect(publicationManagerBaseUrl()).toBe("https://reciter.weill.cornell.edu");
    vi.stubEnv("PUBLICATION_MANAGER_URL", "");
    expect(publicationManagerBaseUrl()).toBe("https://reciter.weill.cornell.edu");
  });
});

describe("client", () => {
  it("v2.1: each new work shows its ReCiter status and the Publication Manager link that acts on it", () => {
    render(
      <OrcidQueue
        data={data({
          cards: [CARD({}, [{ ...ROW, newWorks: 3, newWorksSample: STATUS_SAMPLE }])],
          counts: { ...EMPTY_COUNTS, strong: 1 },
        })}
        basePath="/edit/orcid-queue"
        readOnly={false}
        pmBaseUrl="https://pm.example.org"
      />,
    );
    const works = screen.getAllByTestId("orcid-queue-work");
    const statusOf = (i: number) =>
      works[i]!.querySelector('[data-testid="orcid-queue-work-status"]')?.textContent;
    const pmOf = (i: number) =>
      works[i]!.querySelector('[data-testid="orcid-queue-work-pm"]') as HTMLAnchorElement | null;
    expect(statusOf(0)).toBe("Pending in ReCiter");
    expect(pmOf(0)?.textContent).toBe("Review in Publication Manager");
    expect(pmOf(0)?.getAttribute("href")).toBe("https://pm.example.org/curate/jd0001");
    expect(statusOf(1)).toBe("Rejected in ReCiter: re-review");
    expect(pmOf(1)?.getAttribute("href")).toBe("https://pm.example.org/curate/jd0001");
    expect(statusOf(2)).toBe("Not in PubMed");
    expect(pmOf(2)?.textContent).toBe("Add in Publication Manager");
    expect(pmOf(2)?.getAttribute("href")).toBe(
      "https://pm.example.org/curate/jd0001?add=external&doi=10.9%2Fa%20b%3Cc%3E",
    );
    expect(statusOf(3)).toBe("Not retrieved by ReCiter");
    expect(pmOf(3)).toBeNull();
    // PubMed for any PMID.
    expect(screen.getByText("A rejected paper").getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/902/",
    );
    expect(screen.getByTestId("orcid-queue-work-status-summary").textContent).toBe(
      "ReCiter: 1 pending · 1 rejected · 1 not in PubMed. 2 accepted in ReCiter counted as shared",
    );
  });

  it("v2.1: no Publication Manager links without an https base; unknown statuses say so", () => {
    render(
      <OrcidQueue
        data={data({
          cards: [
            CARD({}, [
              {
                ...ROW,
                newWorksSample: STATUS_SAMPLE.map((w) => ({ ...w, status: null })),
                detail: {
                  ...DETAIL,
                  workStatus: {
                    ...DETAIL.workStatus!,
                    counts: {},
                    unknown: 3,
                    reciterRead: false,
                    acceptedInReciter: 0,
                    pubmedUnknown: 2,
                  },
                },
              },
            ]),
          ],
        })}
        basePath="/edit/orcid-queue"
        readOnly={false}
        pmBaseUrl="http://pm.example.org"
      />,
    );
    expect(screen.queryAllByTestId("orcid-queue-work-pm")).toHaveLength(0);
    expect(screen.queryAllByTestId("orcid-queue-work-status")).toHaveLength(0);
    expect(screen.getByTestId("orcid-queue-work-status-summary").textContent).toBe(
      "ReCiter: 3 status unknown. ReCiter could not be read on the last run. PubMed lookup unavailable on the last run for 2 DOI-only works",
    );
  });

  it("renders the evidence, the new-works sample and the two decisions", () => {
    render(
      <OrcidQueue
        data={data({ cards: [CARD()], counts: { ...EMPTY_COUNTS, strong: 1 } })}
        basePath="/edit/orcid-queue"
        readOnly={false}
      />,
    );
    expect(screen.getByText("Jane Doe, MD").closest("a")?.getAttribute("href")).toBe("/jane-doe");
    expect(screen.getByText(ORCID).getAttribute("href")).toBe(`https://orcid.org/${ORCID}`);
    expect(screen.getByText("Past institution on record")).toBeTruthy();
    expect(screen.getByText("Shared 7")).toBeTruthy();
    expect(screen.getByText("2 sources agree")).toBeTruthy();
    expect(screen.getByText("A synthetic study").getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/999/",
    );
    expect(screen.getByText("A DOI-only study").getAttribute("href")).toBe(
      "https://doi.org/10.9/x",
    );
    expect(screen.getByText("A link-only work").getAttribute("href")).toBe("https://example.org/w");
    expect(screen.getByTestId("orcid-queue-confirm")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-dismiss")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-start-sample").textContent).toBe(
      "Review a sample of 50",
    );
  });

  it("read-only under View as: no controls", () => {
    render(<OrcidQueue data={data({ cards: [CARD()] })} basePath="/edit/orcid-queue" readOnly />);
    expect(screen.queryByTestId("orcid-queue-confirm")).toBeNull();
    expect(screen.queryByTestId("orcid-queue-start-sample")).toBeNull();
  });

  it("a passed sample offers Confirm remaining N; a locked one says why and offers another sample", () => {
    const passed = {
      id: "s1",
      band: "strong" as const,
      startedAt: "",
      filterKey: "",
      total: 50,
      decided: 50,
      dismissed: 0,
      status: "passed" as const,
    };
    const { unmount } = render(
      <OrcidQueue
        data={data({ sample: passed, remaining: 120 })}
        basePath="/edit/orcid-queue"
        readOnly={false}
      />,
    );
    expect(screen.getByTestId("orcid-queue-bulk-confirm").textContent).toBe(
      "Confirm remaining 120",
    );
    unmount();
    render(
      <OrcidQueue
        data={data({ sample: { ...passed, dismissed: 1, status: "locked" } })}
        basePath="/edit/orcid-queue"
        readOnly={false}
      />,
    );
    expect(screen.getByTestId("orcid-queue-sample-locked")).toBeTruthy();
    expect(screen.queryByTestId("orcid-queue-bulk-confirm")).toBeNull();
    expect(screen.getByTestId("orcid-queue-start-sample").textContent).toBe(
      "Review another sample",
    );
  });

  it("an open sample offers Start a new sample; a passed but re-scored one offers no bulk confirm", () => {
    const base = {
      id: "s1",
      band: "strong" as const,
      startedAt: "",
      filterKey: "",
      total: 50,
      decided: 3,
      dismissed: 0,
      status: "open" as const,
    };
    const { unmount } = render(
      <OrcidQueue data={data({ sample: base })} basePath="/edit/orcid-queue" readOnly={false} />,
    );
    expect(screen.getByTestId("orcid-queue-sample-open")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-start-sample").textContent).toBe("Start a new sample");
    unmount();
    render(
      <OrcidQueue
        data={data({
          sample: { ...base, decided: 50, status: "passed", stale: true },
          remaining: null,
        })}
        basePath="/edit/orcid-queue"
        readOnly={false}
      />,
    );
    expect(screen.getByTestId("orcid-queue-sample-stale")).toBeTruthy();
    expect(screen.queryByTestId("orcid-queue-bulk-confirm")).toBeNull();
    expect(screen.getByTestId("orcid-queue-start-sample").textContent).toBe(
      "Review another sample",
    );
  });

  it("Email verified's confirmed rows show Undo instead of Confirm", () => {
    render(
      <OrcidQueue
        data={data({
          tab: "email_verified",
          cards: [
            CARD({ tab: "email_verified" }, [
              {
                ...ROW,
                band: "email_verified",
                state: "auto_confirmed",
                autoConfirmed: true,
                onFileOrcid: ORCID,
              },
            ]),
          ],
        })}
        basePath="/edit/orcid-queue"
        readOnly={false}
      />,
    );
    expect(screen.getByText("Undo")).toBeTruthy();
    expect(screen.queryByTestId("orcid-queue-confirm")).toBeNull();
  });

  it("names side by side: the scholar's and the ORCID record's, with the rule that matched", () => {
    render(<OrcidQueue data={data({ cards: [CARD()] })} basePath="/q" readOnly={false} />);
    const names = screen.getByTestId("orcid-queue-names").textContent ?? "";
    expect(names).toContain("Jane Q Doe / Jane Doe");
    expect(names).toContain("J. Doe");
    expect(names).toContain("also known as Jane Doe; Jane Q. Doe");
    expect(names).toContain("Agree: same surname, full given name");
  });

  it("chips open in place to their facts: institution pairs, shared papers (linked), sources", () => {
    render(<OrcidQueue data={data({ cards: [CARD()] })} basePath="/q" readOnly={false} />);
    fireEvent.click(screen.getByTestId("orcid-queue-chip-institution"));
    expect(screen.getByTestId("orcid-queue-detail-institution").textContent).toContain(
      "ORCID: Example Medical College, employment 1996–2001 ↔ ReCiter Identity: Example Medical College of Example University",
    );
    fireEvent.click(screen.getByTestId("orcid-queue-chip-shared"));
    expect(screen.getByText("A shared paper").closest("a")?.getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/101/",
    );
    expect(screen.getByText("PMID 102").getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/102/",
    );
    expect(screen.getByText("Showing 2 of 7.")).toBeTruthy();
    expect(screen.getByText("J Example")).toBeTruthy();
    fireEvent.click(screen.getByTestId("orcid-queue-chip-sources"));
    expect(screen.getByTestId("orcid-queue-detail-sources").textContent).toContain(
      "ORCID shared works and Publication Manager inference: 2 sources agree",
    );
  });

  it("a card with two candidates: Confirm on one sends the other to dismiss, unless the box is cleared", async () => {
    const second: OrcidQueueRow = { ...ROW, orcid: OTHER, band: "weak", shared: 0, detail: null };
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(
      <OrcidQueue
        data={data({ cards: [CARD({}, [ROW, second])] })}
        basePath="/q"
        readOnly={false}
      />,
    );
    expect(screen.getByText("2 candidate iDs, best first")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("orcid-queue-confirm")[0]!);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).toMatchObject({
      cwid: "jd0001",
      orcid: ORCID,
      decision: "confirm",
      dismissOthers: [OTHER],
    });
    unmount();
    fetchMock.mockClear();
    render(
      <OrcidQueue
        data={data({ cards: [CARD({}, [ROW, second])] })}
        basePath="/q"
        readOnly={false}
      />,
    );
    fireEvent.click(screen.getByTestId("orcid-queue-also-dismiss"));
    fireEvent.click(screen.getAllByTestId("orcid-queue-confirm")[0]!);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).not.toHaveProperty("dismissOthers");
    vi.unstubAllGlobals();
  });

  it("the sample panel says when the latest sample belongs to another filter", () => {
    render(
      <OrcidQueue
        data={data({
          filter: { types: ["faculty"], units: [], sources: [] },
          sample: {
            id: "s1",
            band: "strong",
            startedAt: "",
            filterKey: "",
            total: 50,
            decided: 50,
            dismissed: 0,
            status: "passed",
          },
          remaining: null,
        })}
        basePath="/q"
        readOnly={false}
      />,
    );
    expect(screen.getByTestId("orcid-queue-sample-other-filter")).toBeTruthy();
    expect(screen.queryByTestId("orcid-queue-bulk-confirm")).toBeNull();
    expect(screen.getByTestId("orcid-queue-tab-weak").getAttribute("href")).toBe(
      "/q?tab=weak&type=faculty",
    );
  });
});
