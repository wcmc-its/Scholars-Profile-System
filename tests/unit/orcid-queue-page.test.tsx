/**
 * The ORCID librarian queue page gate, its loaders, the scholar route, and the
 * client.
 *
 *   - Page: no session → SSO redirect; flag off → 404 for everyone; a
 *     non-superuser → ForbiddenEditPage; a superuser gets the queue. The tab
 *     predicate is the page gate (flag + isSuperuser).
 *   - Loaders (v3): every scholar in the queue is one summary, candidates best
 *     first; a dismissed or on-file pair is never a candidate; a scholar
 *     holding a DIFFERENT iD is a conflict; the ETL's email-confirmed iDs are
 *     in; the person / source filter narrows the list. The card carries the iD
 *     on file and where it came from, and the publication count.
 *   - Pure rules (v3): meter level, score, gap, competitor rules, search, sort.
 *   - Client (v3): the scholar list with Unassigned by default, search and
 *     Possible errors; the card fetched for the selected scholar; the
 *     candidate table; the evidence; the decision bar, "Also mark the others",
 *     None of these, Undo; a decided scholar stays until you move on.
 *   - v2.1: each new work's ReCiter status chip and its Publication Manager
 *     link, the status split, and the https-only PM base URL.
 *
 * Fixture people and iDs are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  rawSession: vi.fn(),
  load: vi.fn(),
  loadCard: vi.fn(),
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
  loadOrcidQueueCard: h.loadCard,
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
import { GET as scholarRoute } from "@/app/api/edit/orcid-queue/scholar/route";
import { TAB_PREDICATES } from "@/lib/edit/console-tabs.server";
import {
  bandLevel,
  candidateScore,
  compareSummaries,
  competitorRules,
  EMPTY_ORCID_QUEUE_FILTER,
  isOrcidQueueTabVisible,
  matchesQueueSearch,
  orcidQueueFilterKey,
  orcidQueueHref,
  pairState,
  parseOrcidQueueFilter,
  pmCurateHref,
  publicationManagerBaseUrl,
  scholarGap,
  workHref,
  type OrcidEvidenceDetail,
  type OrcidQueueCard,
  type OrcidQueueData,
  type OrcidQueueRow,
  type OrcidQueueSummary,
} from "@/lib/edit/orcid-queue";

const ORCID = "0000-0002-1825-0097";
const OTHER = "0000-0000-0000-001X";
const SUPER = { cwid: "lib0001", isSuperuser: true };
const STEWARD = { cwid: "cs00001", isSuperuser: false, isCommsSteward: true };

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
  byline: {
    papers: [
      { pmid: "101", doi: "10.1/a", title: "A byline paper", year: 2020, journal: "J Example" },
    ],
    total: 1,
    rejected: 0,
    otherHolders: [],
    otherIds: [],
  },
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
  onFile: null,
  reciterTotal: 20,
  candidates: rows,
  ruledOut: [],
  ...over,
});

const summaryOf = (
  c: OrcidQueueCard,
  over: Partial<OrcidQueueSummary> = {},
): OrcidQueueSummary => ({
  cwid: c.cwid,
  name: c.name,
  surname: c.name.split(",")[0]!.split(" ").pop()!.toLowerCase(),
  department: c.department,
  candidates: c.candidates.map(
    ({ orcid, band, shared, worksTotal, nameAgrees, competitor, sources }) => ({
      orcid,
      band,
      shared,
      worksTotal,
      nameAgrees,
      competitor,
      sources,
    }),
  ),
  conflict: c.candidates.some((r) => r.state === "conflict"),
  autoConfirmed: c.candidates.some((r) => r.autoConfirmed),
  firstQueuedAt: null,
  lastQueuedAt: null,
  decisions: null,
  ...over,
});

const data = (summaries: OrcidQueueSummary[] = []): OrcidQueueData => ({
  summaries,
  filter: EMPTY_ORCID_QUEUE_FILTER,
});

type FetchCall = [string, RequestInit | undefined];

/** Renders the queue over `cards`: GET serves the card, POST succeeds. */
function mount(
  cards: OrcidQueueCard[],
  opts: { readOnly?: boolean; pmBaseUrl?: string | null; summaries?: OrcidQueueSummary[] } = {},
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    const cwid = new URL(url, "http://x").searchParams.get("cwid");
    const c = cards.find((x) => x.cwid === cwid);
    return c
      ? new Response(JSON.stringify(c), { status: 200 })
      : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <OrcidQueue
      data={data(opts.summaries ?? cards.map((c) => summaryOf(c)))}
      basePath="/edit/orcid-queue"
      readOnly={opts.readOnly ?? false}
      pmBaseUrl={opts.pmBaseUrl ?? null}
    />,
  );
  const posts = () =>
    (fetchMock.mock.calls as unknown as FetchCall[])
      .filter(([, i]) => i?.method === "POST")
      .map(([, i]) => JSON.parse(i!.body as string) as Record<string, unknown>);
  return { fetchMock, posts };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

  it("a non-superuser deep-linked to one cwid goes to that person's ORCID tab", async () => {
    h.session.mockResolvedValue(STEWARD);
    await expect(
      OrcidQueuePage({ searchParams: Promise.resolve({ q: " ABA4016 " }) }),
    ).rejects.toThrow("__REDIRECT__ /edit/scholar/aba4016?attr=identifiers-profiles");
    expect(h.load).not.toHaveBeenCalled();
  });

  it("a non-superuser with a free-text q still gets the 403 page", async () => {
    h.session.mockResolvedValue(STEWARD);
    render(await OrcidQueuePage({ searchParams: Promise.resolve({ q: "smith jones" }) }));
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.load).not.toHaveBeenCalled();
  });

  it("a superuser gets the queue under the URL's filter (a stray ?tab= is ignored)", async () => {
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
    expect(h.load).toHaveBeenCalledWith(
      {},
      {
        types: ["faculty"],
        units: ["div:CARD"],
        sources: ["orcid_works"],
        campuses: [],
      },
    );
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

describe("scholar route", () => {
  const get = (q = "?cwid=jd0001") =>
    scholarRoute({ nextUrl: new URL(`http://x/api/edit/orcid-queue/scholar${q}`) } as never);

  it("flag off 404, no session 401, a non-superuser 403, before any read", async () => {
    vi.stubEnv("ORCID_LIBRARIAN_QUEUE", "off");
    expect((await get()).status).toBe(404);
    vi.stubEnv("ORCID_LIBRARIAN_QUEUE", "on");
    h.session.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    h.session.mockResolvedValue(STEWARD);
    expect((await get()).status).toBe(403);
    expect(h.loadCard).not.toHaveBeenCalled();
  });

  it("400 without a cwid; 404 when the scholar left the queue; else the card", async () => {
    h.session.mockResolvedValue(SUPER);
    expect((await get("")).status).toBe(400);
    h.loadCard.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    h.loadCard.mockResolvedValue(CARD());
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cwid: "jd0001", reciterTotal: 20 });
    expect(h.loadCard).toHaveBeenLastCalledWith({}, "jd0001");
  });
});

describe("loaders", () => {
  it("pairState: on file, dismissed, conflict, queue", () => {
    expect(pairState(ORCID, ORCID, false)).toBe("on_file");
    expect(pairState(ORCID, null, true)).toBe("dismissed");
    expect(pairState(ORCID, OTHER, false)).toBe("conflict");
    expect(pairState(ORCID, null, false)).toBe("queue");
  });

  // The page test mocks the loaders; these cases run the real ones.
  const actual = () =>
    vi.importActual<typeof import("@/lib/edit/orcid-queue.server")>(
      "@/lib/edit/orcid-queue.server",
    );

  const OTHER_2 = "0000-0001-5109-3700";
  const client = (
    opts: {
      admins?: Array<{ cwid: string; orcid: string }>;
      /** Manual division code → its hand-added roster. */
      rosters?: Record<string, string[]>;
      /** a00001's `evidence_detail`. */
      detail?: unknown;
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
    const full = (e: (typeof evidence)[number]) => ({
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
      evidenceDetail: e.cwid === "a00001" ? (opts.detail ?? DETAIL) : null,
    });
    const held: Record<string, string | null> = {
      a00001: null,
      b00001: null,
      c00001: OTHER,
      d00001: null,
      f00001: null,
      e00001: ORCID,
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
    const person = (c: string) => ({
      cwid: c,
      orcid: held[c] ?? null,
      status: "active",
      deletedAt: null,
      slug: c,
      preferredName: `Pref ${c}`,
      fullName: `Full Name ${c}`,
      postnominal: null,
      roleCategory: roles[c] ?? "faculty",
      primaryTitle: "Professor",
      primaryDepartment: "Medicine",
      orcidConfirmMethod: c === "e00001" ? "email_verified" : null,
      orcidConfirmedAt: c === "e00001" ? new Date("2026-10-20T12:00:00Z") : null,
      orcidConfirmedBy: c === "e00001" ? "ETL" : null,
    });
    return {
      orcidCandidateEvidence: {
        findMany: vi.fn(async (args: { where?: { cwid?: string } } = {}) =>
          evidence.filter((e) => !args.where?.cwid || e.cwid === args.where.cwid).map(full),
        ),
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
      publicationAuthor: { count: vi.fn(async () => 42) },
      scholar: {
        findUnique: vi.fn(async (args: { where: { cwid: string } }) =>
          args.where.cwid in held ? person(args.where.cwid) : null,
        ),
        findMany: vi.fn(
          async (args: {
            where: {
              orcidConfirmMethod?: string;
              cwid?: string | { in: string[] };
              roleCategory?: { in: string[] };
              AND?: Array<{ OR?: Array<Record<string, { in: string[] }>> }>;
            };
          }) => {
            const w = args.where;
            if (w.orcidConfirmMethod === "librarian") return [];
            if (w.orcidConfirmMethod)
              return typeof w.cwid === "string" && w.cwid !== "e00001"
                ? []
                : [{ cwid: "e00001", orcid: ORCID }];
            const cwids = typeof w.cwid === "string" ? [w.cwid] : (w.cwid?.in ?? []);
            return cwids
              .filter((c) => !w.roleCategory || w.roleCategory.in.includes(roles[c] ?? "faculty"))
              .filter((c) => (w.AND ?? []).every((x) => inUnit(c, x)))
              .map(person);
          },
        ),
      },
      orcidDismissal: {
        findMany: vi.fn(async (args: { where?: { cwid: string | { in: string[] } } }) =>
          [
            {
              cwid: "b00001",
              orcid: ORCID,
              dismissedAt: new Date("2026-10-02T00:00:00Z"),
              dismissedBy: null,
              reason: null,
              keptOrcid: null,
              otherCwid: null,
            },
            {
              cwid: "a00001",
              orcid: "0000-0002-0000-0009",
              dismissedAt: new Date("2026-10-03T00:00:00Z"),
              dismissedBy: "lib0001",
              reason: "other_confirmed",
              keptOrcid: ORCID,
              otherCwid: null,
            },
          ].filter((d) =>
            !args.where
              ? true
              : typeof args.where.cwid === "string"
                ? d.cwid === args.where.cwid
                : args.where.cwid.in.includes(d.cwid),
          ),
        ),
      },
      orcidPairSeen: {
        findMany: vi.fn(async () => [
          { cwid: "a00001", orcid: ORCID, firstQueuedAt: new Date("2026-09-01T00:00:00Z") },
          { cwid: "a00001", orcid: OTHER_2, firstQueuedAt: new Date("2026-10-01T00:00:00Z") },
        ]),
      },
    } as never;
  };

  const cwidsOf = (q: OrcidQueueData) => q.summaries.map((s) => s.cwid).sort();

  it("one summary per scholar, candidates best first; a dismissed pair drops; conflicts and the ETL's iDs are flagged", async () => {
    const q = await (await actual()).loadOrcidQueue(client());
    // b00001's only pair is dismissed: listed for that decision alone (v3 B2).
    expect(cwidsOf(q)).toEqual(["a00001", "b00001", "c00001", "d00001", "e00001", "f00001"]);
    expect(q.summaries.find((s) => s.cwid === "b00001")!.candidates).toEqual([]);
    const by = (c: string) => q.summaries.find((s) => s.cwid === c)!;
    expect(by("a00001")).toMatchObject({
      name: "Pref a00001",
      surname: "a00001",
      conflict: false,
      autoConfirmed: false,
    });
    expect(by("a00001").candidates.map((r) => [r.orcid, r.band, r.sources])).toEqual([
      [ORCID, "strong", ["orcid_works", "rpm_inferred"]],
      [OTHER_2, "weak", []],
    ]);
    expect(by("c00001")).toMatchObject({ conflict: true });
    expect(by("e00001")).toMatchObject({ autoConfirmed: true });
    expect(by("e00001").candidates[0]).toMatchObject({ band: "email_verified" });
  });

  it("an rpm_admin iD is a candidate, not on file: that scholar's other candidate is not a conflict", async () => {
    const q = await (
      await actual()
    ).loadOrcidQueue(client({ admins: [{ cwid: "a00001", orcid: OTHER }] }));
    expect(q.summaries.find((s) => s.cwid === "a00001")).toMatchObject({ conflict: false });
  });

  it("the filter narrows the list: person type, how discovered (a kept scholar keeps every candidate)", async () => {
    const { loadOrcidQueue } = await actual();
    const byType = await loadOrcidQueue(client(), {
      types: ["postdoc"],
      units: [],
      sources: [],
      campuses: [],
    });
    expect(cwidsOf(byType)).toEqual(["d00001"]);
    const bySource = await loadOrcidQueue(client(), {
      types: [],
      units: [],
      sources: ["orcid_works"],
      campuses: [],
    });
    expect(cwidsOf(bySource)).toEqual(["a00001"]);
    expect(bySource.summaries[0]!.candidates).toHaveLength(2);
  });

  it("the filter narrows the list: department, division (with its manual roster), institution", async () => {
    const { loadOrcidQueue } = await actual();
    expect(
      cwidsOf(
        await loadOrcidQueue(client(), {
          types: [],
          units: ["dept:MED"],
          sources: [],
          campuses: [],
        }),
      ),
    ).toEqual(["a00001", "c00001"]);
    expect(
      cwidsOf(
        await loadOrcidQueue(client({ rosters: { CARD: ["d00001"] } }), {
          types: [],
          units: ["div:CARD"],
          sources: [],
          campuses: [],
        }),
      ),
    ).toEqual(["a00001", "d00001"]);
    expect(
      cwidsOf(
        await loadOrcidQueue(client(), {
          types: [],
          units: ["inst:HSS"],
          sources: [],
          campuses: [],
        }),
      ),
    ).toEqual(["f00001"]);
  });

  it("evidence_detail.byline: an earlier run's row is kept as it was; the Crossref fields survive", async () => {
    const bylineOf = async (byline: unknown) => {
      const c = client({ detail: { ...DETAIL, byline } });
      const card = (await (await actual()).loadOrcidQueueCard(c, "a00001"))!;
      return card.candidates[0]!.detail!.byline;
    };
    expect(await bylineOf(DETAIL.byline)).toEqual(DETAIL.byline);
    expect(await bylineOf(DETAIL.byline)).not.toHaveProperty("uncounted");
    const papers = [{ ...DETAIL.byline!.papers[0]!, sources: ["crossref"] }];
    const off = { ...DETAIL.byline!, papers, total: 0, uncounted: 1 };
    expect(await bylineOf(off)).toEqual(off);
    expect(await bylineOf({ ...off, uncounted: "1" })).not.toHaveProperty("uncounted");
    const contested = {
      ...off,
      uncountedContests: { rejected: 2, otherHolders: ["xy0002"], otherIds: [OTHER] },
    };
    expect(await bylineOf(contested)).toEqual(contested);
    expect(await bylineOf({ ...off, uncountedContests: "x" })).not.toHaveProperty(
      "uncountedContests",
    );
  });

  it("the card: every candidate with its evidence, sources and work statuses; the publication count", async () => {
    const card = (await (await actual()).loadOrcidQueueCard(client(), "a00001"))!;
    expect(card).toMatchObject({
      cwid: "a00001",
      name: "Pref a00001",
      scholarNames: ["Full Name a00001", "Pref a00001"],
      onFile: null,
      reciterTotal: 42,
    });
    expect(card.candidates.map((r) => r.orcid)).toEqual([ORCID, OTHER_2]);
    expect(card.candidates[0]).toMatchObject({
      sources: ["orcid_works", "rpm_inferred"],
      detail: DETAIL,
      state: "queue",
    });
    // v2.1: each work's status survives the read; an unknown value is dropped.
    expect(card.candidates[0]!.newWorksSample.map((w) => w.status)).toEqual([
      "pending",
      "rejected",
      "not_in_pubmed",
      "not_retrieved",
      undefined,
    ]);
  });

  it("the card: the iD on file and where it came from (WCM Identity; the ETL's email confirm)", async () => {
    const { loadOrcidQueueCard } = await actual();
    // The on-file iD's public name is read live from pub.orcid.org.
    const orcidApi = vi.fn(async (url: string) =>
      url.endsWith(`${OTHER}/personal-details`)
        ? new Response(
            JSON.stringify({
              name: { "given-names": { value: "Cara" }, "family-name": { value: "Dee" } },
            }),
          )
        : new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", orcidApi);
    const c = (await loadOrcidQueueCard(client(), "c00001"))!;
    expect(c.onFile).toEqual({
      orcid: OTHER,
      how: "identity",
      at: null,
      by: null,
      byName: null,
      name: "Cara Dee",
    });
    expect(c.candidates[0]).toMatchObject({ state: "conflict", onFileOrcid: OTHER });
    const e = (await loadOrcidQueueCard(client(), "e00001"))!;
    expect(e.onFile).toMatchObject({
      orcid: ORCID,
      how: "email_verified",
      by: "ETL",
      byName: null,
      name: null,
    });
    expect(e.candidates).toEqual([
      expect.objectContaining({ autoConfirmed: true, state: "auto_confirmed" }),
    ]);
  });

  it("v3 B1: queue age from orcid_pair_seen; null when no pair is recorded", async () => {
    const q = await (await actual()).loadOrcidQueue(client());
    const by = (c: string) => q.summaries.find((s) => s.cwid === c)!;
    expect(by("a00001")).toMatchObject({
      firstQueuedAt: "2026-09-01T00:00:00.000Z",
      lastQueuedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(by("c00001")).toMatchObject({ firstQueuedAt: null, lastQueuedAt: null });
  });

  it("v3 B1: the card lists ruled-out iDs with who and why", async () => {
    const card = (await (await actual()).loadOrcidQueueCard(client(), "a00001"))!;
    expect(card.ruledOut).toEqual([
      {
        orcid: "0000-0002-0000-0009",
        reason: "other_confirmed",
        keptOrcid: ORCID,
        otherCwid: null,
        otherName: null,
        by: "lib0001",
        byName: "Pref lib0001",
        at: "2026-10-03T00:00:00.000Z",
      },
    ]);
  });

  it("the card is null for a scholar with nothing in the queue and no decision", async () => {
    expect(await (await actual()).loadOrcidQueueCard(client(), "z00001")).toBeNull();
  });

  it("v3 B2: a scholar with nothing open but a decision lists (Decision filter) and gets a header-only card", async () => {
    const { loadOrcidQueue, loadOrcidQueueCard } = await actual();
    const q = await loadOrcidQueue(client());
    const b = q.summaries.find((s) => s.cwid === "b00001")!;
    expect(b).toMatchObject({
      candidates: [],
      decisions: {
        byScholar: false,
        byStaff: true,
        librarian: false,
        at: "2026-10-02T00:00:00.000Z",
      },
    });
    expect(q.summaries.find((s) => s.cwid === "a00001")!.decisions).toMatchObject({
      byStaff: true,
    });
    expect(q.summaries.find((s) => s.cwid === "c00001")!.decisions).toBeNull();
    // A source filter keeps no decided-only scholar.
    const bySource = await loadOrcidQueue(client(), {
      types: [],
      units: [],
      sources: ["orcid_works"],
      campuses: [],
    });
    expect(bySource.summaries.map((s) => s.cwid)).not.toContain("b00001");
    const card = (await loadOrcidQueueCard(client(), "b00001"))!;
    expect(card.candidates).toEqual([]);
    expect(card.ruledOut.map((d) => d.orcid)).toEqual([ORCID]);
  });
});

describe("v3 pure rules", () => {
  const sum = (
    bands: Array<[OrcidQueueRow["band"], number, number]>,
    over: Partial<OrcidQueueSummary> = {},
  ) =>
    ({
      cwid: "x",
      name: "X",
      surname: "x",
      department: null,
      conflict: false,
      autoConfirmed: false,
      candidates: bands.map(([band, shared, worksTotal], i) => ({
        orcid: `0000-0000-0000-000${i}`,
        band,
        shared,
        worksTotal,
        nameAgrees: true,
        competitor: false,
        sources: [],
      })),
      ...over,
    }) as OrcidQueueSummary;

  it("v3 B1 sorts: Oldest in queue (missing date last), Newest found", () => {
    const a = sum([["weak", 0, 0]], {
      cwid: "a",
      firstQueuedAt: "2026-01-01T00:00:00.000Z",
      lastQueuedAt: "2026-05-01T00:00:00.000Z",
    });
    const b = sum([["weak", 0, 0]], {
      cwid: "b",
      firstQueuedAt: "2026-02-01T00:00:00.000Z",
      lastQueuedAt: "2026-03-01T00:00:00.000Z",
    });
    const n = sum([["weak", 0, 0]], { cwid: "n", firstQueuedAt: null, lastQueuedAt: null });
    expect([n, b, a].sort(compareSummaries("oldest")).map((s) => s.cwid)).toEqual(["a", "b", "n"]);
    expect([n, b, a].sort(compareSummaries("newest")).map((s) => s.cwid)).toEqual(["a", "b", "n"]);
    expect([n, a, b].sort(compareSummaries("newest")).map((s) => s.cwid)).toEqual(["a", "b", "n"]);
  });

  it("meter level, score and gap", () => {
    expect(bandLevel("weak")).toBe(1);
    expect(bandLevel("email_verified")).toBe(5);
    expect(candidateScore({ band: "moderate", shared: 5, worksTotal: 10 })).toBe(2.5);
    expect(candidateScore({ band: "moderate", shared: 0, worksTotal: 0 })).toBe(2);
    expect(scholarGap(sum([["strong", 0, 0]]))).toBe(9);
    expect(
      scholarGap(
        sum([
          ["strong", 0, 0],
          ["weak", 0, 0],
        ]),
      ),
    ).toBe(3);
  });

  it("competitor rules from the row's detail", () => {
    const base = { competitor: true, competitors: [], competitorOrcids: [] };
    expect(competitorRules({ ...base, competitor: false })).toEqual([]);
    expect(
      competitorRules({
        ...base,
        competitors: [
          { cwid: "a", name: "A", shared: 3, reason: "same_surname" },
          { cwid: "b", name: "B", shared: 4, reason: "same_id" },
        ],
        competitorOrcids: [{ orcid: OTHER, shared: null }],
      }),
    ).toEqual([1, 2, 3]);
  });

  it("search: name, CWID, or an iD with or without dashes", () => {
    const s = sum([["weak", 0, 0]], { name: "Jane Doe, MD", cwid: "jd0001" });
    expect(matchesQueueSearch(s, "")).toBe(true);
    expect(matchesQueueSearch(s, "doe")).toBe(true);
    expect(matchesQueueSearch(s, "JD0001")).toBe(true);
    expect(matchesQueueSearch(s, "0000-0000-0000-0000")).toBe(true);
    expect(matchesQueueSearch(s, "0000000000000000")).toBe(true);
    expect(matchesQueueSearch(s, "zzz")).toBe(false);
  });

  it("sorts: strongest, clearest winner, department then name, name, cwid", () => {
    const a = sum(
      [
        ["strong", 1, 10],
        ["strong", 1, 10],
      ],
      { cwid: "c3", surname: "b", name: "B", department: "Z" },
    );
    const b = sum([["moderate", 9, 10]], { cwid: "c1", surname: "c", name: "C", department: "A" });
    const c = sum([["weak", 0, 1]], { cwid: "c2", surname: "a", name: "A", department: null });
    const order = (k: Parameters<typeof compareSummaries>[0]) =>
      [a, b, c].sort(compareSummaries(k)).map((s) => s.cwid);
    expect(order("strong")).toEqual(["c3", "c1", "c2"]);
    expect(order("gap")).toEqual(["c1", "c2", "c3"]);
    expect(order("dept")).toEqual(["c1", "c3", "c2"]);
    expect(order("name")).toEqual(["c2", "c3", "c1"]);
    expect(order("cwid")).toEqual(["c1", "c2", "c3"]);
  });
});

describe("filter and link helpers", () => {
  it("the filter key is canonical and empty for no filter; the href carries no tab", () => {
    expect(orcidQueueFilterKey(EMPTY_ORCID_QUEUE_FILTER)).toBe("");
    expect(
      orcidQueueFilterKey({ types: ["b", "a"], units: [], sources: ["orcid_works"], campuses: [] }),
    ).toBe("type=a&type=b&source=orcid_works");
    expect(orcidQueueHref("/q", { types: ["a"], units: [], sources: [], campuses: [] })).toBe(
      "/q?type=a",
    );
    expect(orcidQueueHref("/q", EMPTY_ORCID_QUEUE_FILTER)).toBe("/q");
    expect(parseOrcidQueueFilter({ type: "a", unit: "nope", source: "orcid_email" })).toEqual({
      types: ["a"],
      units: [],
      sources: ["orcid_email"],
      campuses: [],
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

  it("pmCurateHref: a pmid opens the PubMed Add tab; a non-numeric one is dropped; a DOI wins", () => {
    const base = "https://pm.example.org";
    expect(pmCurateHref(base, "jd0001", { pmid: "41032574" })).toBe(
      "https://pm.example.org/curate/jd0001?add=pubmed&pmid=41032574",
    );
    expect(pmCurateHref(base, "jd0001", { pmid: "1&x=2" })).toBe(
      "https://pm.example.org/curate/jd0001",
    );
    expect(pmCurateHref(base, "jd0001", { doi: "10.9/a", pmid: "5" })).toContain("add=external");
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
  const SECOND: OrcidQueueRow = {
    ...ROW,
    orcid: OTHER,
    band: "weak",
    shared: 0,
    nameAgrees: false,
    detail: null,
    sources: ["orcid_name"],
  };
  const JOHN = CARD(
    { cwid: "js0002", slug: "john-smith", name: "John Smith, PhD", department: "Surgery" },
    [{ ...ROW, cwid: "js0002", band: "moderate", orcid: "0000-0001-5109-3700" }],
  );

  it("lists every scholar strongest first and loads the first one's card", async () => {
    mount([JOHN, CARD()]);
    const items = within(screen.getByTestId("orcid-queue-list")).getAllByRole("option");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Jane Doe, MD"),
      expect.stringContaining("John Smith, PhD"),
    ]);
    expect(screen.getByTestId("orcid-queue-count").textContent).toBe("2 left");
    const card = await screen.findByTestId("orcid-queue-card-jd0001");
    expect(within(card).getByText("View profile ↗").getAttribute("href")).toBe("/jane-doe");
    expect(within(card).getByTestId("orcid-queue-evidence").textContent).toContain(
      "From its one iD: 2 sources agree; 7 of the 12 works on the ORCID record are also in ReCiter; name agrees; iD printed on 1 accepted paper.",
    );
    expect(screen.getByTestId("orcid-queue-record-link").getAttribute("href")).toBe(
      `https://orcid.org/${ORCID}`,
    );
  });

  it("J / K move through the list; clicking a scholar loads theirs", async () => {
    mount([JOHN, CARD()]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    act(() => {
      fireEvent.keyDown(window, { key: "j" });
    });
    expect(await screen.findByTestId("orcid-queue-card-js0002")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "k" });
    });
    expect(await screen.findByTestId("orcid-queue-card-jd0001")).toBeTruthy();
    fireEvent.click(screen.getByTestId("orcid-queue-item-js0002"));
    expect(await screen.findByTestId("orcid-queue-card-js0002")).toBeTruthy();
  });

  it("search by an iD without dashes, and Possible errors, narrow the list", async () => {
    const conflict = CARD({ cwid: "cf0003", name: "Carl Field" }, [
      { ...ROW, cwid: "cf0003", orcid: OTHER, state: "conflict", onFileOrcid: ORCID },
    ]);
    mount([JOHN, CARD(), conflict]);
    fireEvent.change(screen.getByTestId("orcid-queue-search"), {
      target: { value: "0000000151093700" },
    });
    expect(screen.getByTestId("orcid-queue-count").textContent).toBe("1 left");
    fireEvent.change(screen.getByTestId("orcid-queue-search"), { target: { value: "" } });
    expect(screen.getByTestId("orcid-queue-filter-errors").textContent).toBe(
      "Different iD on file · 1",
    );
    fireEvent.click(screen.getByTestId("orcid-queue-filter-errors"));
    expect(screen.getByTestId("orcid-queue-count").textContent).toBe("1 left");
    expect(screen.getByTestId("orcid-queue-item-cf0003")).toBeTruthy();
  });

  it("How discovered counts scholars with an iD found each way", async () => {
    mount([JOHN, CARD({}, [ROW, SECOND])]);
    fireEvent.click(screen.getByTestId("orcid-queue-filter-source"));
    const opt = (label: string) =>
      screen.getByRole("checkbox", { name: new RegExp(`^${label}`) }).textContent;
    // ROW's sources are orcid_works + rpm_inferred (both scholars); SECOND's orcid_name (Jane only).
    expect(opt("ORCID shared works")).toMatch(/2$/);
    expect(opt("ORCID name only")).toMatch(/1$/);
    expect(opt("Crossref deposit")).toMatch(/0$/);
  });

  it("v2.1: each new work shows its ReCiter status and the Publication Manager link that acts on it", async () => {
    mount([CARD({}, [{ ...ROW, newWorks: 3, newWorksSample: STATUS_SAMPLE }])], {
      pmBaseUrl: "https://pm.example.org",
    });
    await screen.findByTestId("orcid-queue-card-jd0001");
    const works = screen.getAllByTestId("orcid-queue-work");
    const statusOf = (i: number) =>
      works[i]!.querySelector('[data-testid="orcid-queue-work-status"]')?.textContent;
    const pmOf = (i: number) =>
      works[i]!.querySelector('[data-testid="orcid-queue-work-pm"]') as HTMLAnchorElement | null;
    expect(statusOf(0)).toBe("Pending in ReCiter");
    expect(pmOf(0)?.textContent).toBe("Review in Publication Manager");
    expect(pmOf(0)?.getAttribute("href")).toBe("https://pm.example.org/curate/jd0001");
    expect(statusOf(1)).toBe("Rejected in ReCiter: re-review");
    expect(statusOf(2)).toBe("Not in PubMed");
    expect(pmOf(2)?.textContent).toBe("Add in Publication Manager");
    expect(pmOf(2)?.getAttribute("href")).toBe(
      "https://pm.example.org/curate/jd0001?add=external&doi=10.9%2Fa%20b%3Cc%3E",
    );
    expect(statusOf(3)).toBe("Not retrieved by ReCiter");
    expect(pmOf(3)).toBeNull();
    expect(screen.getByTestId("orcid-queue-work-status-summary").textContent).toBe(
      "ReCiter: 1 pending · 1 rejected · 1 not in PubMed. 2 accepted in ReCiter counted as shared",
    );
    // A work row opens to its identifiers and its link.
    fireEvent.click(within(works[1]!).getByRole("button", { name: /A rejected paper/ }));
    expect(within(works[1]!).getByText("902")).toBeTruthy();
    expect(within(works[1]!).getByText("Open the work ↗").getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/902/",
    );
  });

  it("v2.1: no Publication Manager links without an https base; unknown statuses say so", async () => {
    mount(
      [
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
      { pmBaseUrl: "http://pm.example.org" },
    );
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.queryAllByTestId("orcid-queue-work-pm")).toHaveLength(0);
    expect(screen.queryAllByTestId("orcid-queue-work-status")).toHaveLength(0);
    expect(screen.getByTestId("orcid-queue-work-status-summary").textContent).toBe(
      "ReCiter: 3 status unknown. ReCiter could not be read on the last run. PubMed lookup unavailable on the last run for 2 DOI-only works",
    );
  });

  it("byline papers: an empty record opens on them, with a link to the paper", async () => {
    mount([
      CARD({}, [
        { ...ROW, band: "moderate", shared: 0, worksTotal: 0, newWorks: 0, newWorksSample: [] },
      ]),
    ]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-evidence").textContent).toContain(
      "name agrees; iD printed on 1 accepted paper.",
    );
    expect(screen.getByTestId("orcid-queue-byline-count").textContent).toBe("On 1 byline");
    expect(screen.getByTestId("orcid-queue-pubs-byline").getAttribute("aria-selected")).toBe("true");
    const pubs = screen.getByTestId("orcid-queue-pubs");
    expect(pubs.textContent).toContain(
      "1 accepted paper prints this iD next to the scholar's name",
    );
    // An earlier run's paper names no source: it read PubMed alone.
    expect(within(pubs).getByTestId("orcid-queue-work").textContent).toContain("in PubMed");
    expect(screen.queryByTestId("orcid-queue-byline-uncounted")).toBeNull();
    expect(screen.queryByTestId("orcid-queue-byline-caveats")).toBeNull();
    const work = within(pubs).getByTestId("orcid-queue-work");
    fireEvent.click(within(work).getByRole("button", { name: /A byline paper/ }));
    expect(within(work).getByText("Open the work ↗").getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/101/",
    );
  });

  it("byline papers: what points the other way is said, and that it keeps them out of the rating", async () => {
    mount([
      CARD({}, [
        {
          ...ROW,
          detail: {
            ...DETAIL,
            byline: {
              ...DETAIL.byline!,
              total: 3,
              rejected: 2,
              otherHolders: ["xy0002"],
              otherIds: [OTHER],
            },
          },
        },
      ]),
    ]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-evidence").textContent).toContain(
      "iD printed on 3 accepted papers (contested).",
    );
    expect(screen.getByTestId("orcid-queue-byline-count").textContent).toBe(
      "On 3 bylines (contested)",
    );
    fireEvent.click(screen.getByTestId("orcid-queue-pubs-byline"));
    expect(screen.getByTestId("orcid-queue-byline-caveats").textContent).toBe(
      `Also tied to xy0002: on their accepted papers, or on file for them. The scholar's accepted papers also print ${OTHER}. 2 rejected papers print this iD there too. The byline papers don’t raise the match strength.`,
    );
    expect(screen.getByTestId("orcid-queue-pubs").textContent).toContain("Showing 1 of 3.");
  });

  const PAPER = DETAIL.byline!.papers[0]!;
  const BYLINE_3: NonNullable<OrcidEvidenceDetail["byline"]> = {
    ...DETAIL.byline!,
    papers: [
      { ...PAPER, pmid: "301", sources: ["pubmed"] },
      { ...PAPER, pmid: "302", sources: ["crossref"] },
      { ...PAPER, pmid: "303", sources: ["pubmed", "crossref"] },
    ],
  };

  it("byline papers: each names its source, and all count when none is left out", async () => {
    mount([CARD({}, [{ ...ROW, detail: { ...DETAIL, byline: { ...BYLINE_3, total: 3 } } }])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-byline-count").textContent).toBe("On 3 bylines");
    fireEvent.click(screen.getByTestId("orcid-queue-pubs-byline"));
    const works = within(screen.getByTestId("orcid-queue-pubs")).getAllByTestId("orcid-queue-work");
    expect(works.map((w) => /in (PubMed|Crossref).*$/.exec(w.textContent ?? "")?.[0])).toEqual([
      "in PubMed",
      "in Crossref",
      "in PubMed and Crossref",
    ]);
    expect(screen.queryByTestId("orcid-queue-byline-uncounted")).toBeNull();
  });

  it("byline papers: Crossref-only ones that don't count are listed, not counted, not contested", async () => {
    mount([
      CARD({}, [{ ...ROW, detail: { ...DETAIL, byline: { ...BYLINE_3, total: 2, uncounted: 1 } } }]),
    ]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-evidence").textContent).toContain(
      "iD printed on 2 accepted papers.",
    );
    expect(screen.getByTestId("orcid-queue-byline-count").textContent).toBe("On 2 bylines");
    expect(screen.getByTestId("orcid-queue-pubs-byline").textContent).toContain("3");
    fireEvent.click(screen.getByTestId("orcid-queue-pubs-byline"));
    expect(screen.getByTestId("orcid-queue-byline-uncounted").textContent).toBe(
      "1 is only in Crossref and doesn't count toward the match strength.",
    );
    expect(screen.queryByTestId("orcid-queue-byline-caveats")).toBeNull();
  });

  it("byline papers: what contests the iD only in Crossref is said, and that it changes nothing", async () => {
    const byline = {
      ...BYLINE_3,
      total: 2,
      uncounted: 1,
      uncountedContests: { rejected: 2, otherHolders: ["xy0002"], otherIds: [OTHER] },
    };
    mount([CARD({}, [{ ...ROW, detail: { ...DETAIL, byline } }])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-byline-count").textContent).toBe("On 2 bylines");
    fireEvent.click(screen.getByTestId("orcid-queue-pubs-byline"));
    expect(screen.getByTestId("orcid-queue-byline-crossref-caveats").textContent).toBe(
      `Only in Crossref: Also tied to xy0002: on their accepted papers, or on file for them. The scholar's accepted papers also print ${OTHER}. 2 rejected papers print this iD there too. This doesn’t change the match strength. Check it before confirming.`,
    );
    expect(screen.queryByTestId("orcid-queue-byline-caveats")).toBeNull();
  });

  it("byline papers: an empty record with only uncounted ones opens on them, with no count", async () => {
    const byline = { ...BYLINE_3, papers: BYLINE_3.papers.slice(1, 2), total: 0, uncounted: 2 };
    mount([
      CARD({}, [
        {
          ...ROW,
          shared: 0,
          worksTotal: 0,
          newWorks: 0,
          newWorksSample: [],
          detail: { ...DETAIL, byline },
        },
      ]),
    ]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-evidence").textContent).toContain("name agrees.");
    expect(screen.queryByTestId("orcid-queue-byline-count")).toBeNull();
    expect(screen.getByTestId("orcid-queue-pubs-byline").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("orcid-queue-byline-uncounted").textContent).toBe(
      "2 are only in Crossref and don't count toward the match strength.",
    );
    expect(screen.getByTestId("orcid-queue-pubs").textContent).toContain("Showing 1 of 2.");
  });

  it("byline papers: an earlier run's row has no tab and no count", async () => {
    mount([CARD({}, [{ ...ROW, detail: { ...DETAIL, byline: undefined } }])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.queryByTestId("orcid-queue-pubs-byline")).toBeNull();
    expect(screen.queryByTestId("orcid-queue-byline-count")).toBeNull();
    expect(screen.getByTestId("orcid-queue-evidence").textContent).toContain("name agrees.");
  });

  it("publications: In both lists the shared papers; Only in ReCiter counts the rest", async () => {
    mount([CARD()]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    fireEvent.click(screen.getByTestId("orcid-queue-pubs-both"));
    const pubs = screen.getByTestId("orcid-queue-pubs");
    expect(within(pubs).getByText("A shared paper")).toBeTruthy();
    expect(within(pubs).getByText("PMID 102")).toBeTruthy();
    expect(within(pubs).getByText("Showing 2 of 7.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("orcid-queue-pubs-rec"));
    expect(pubs.textContent).toContain(
      "13 of the scholar's 20 ReCiter publications aren't on this ORCID record",
    );
  });

  it("publications open on the first non-empty list", async () => {
    mount([CARD({}, [{ ...ROW, newWorks: 0, newWorksSample: [] }])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-pubs-both").getAttribute("aria-selected")).toBe("true");
  });

  it("names side by side and the signals with their facts", async () => {
    mount([CARD()]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    const names = screen.getByTestId("orcid-queue-names").textContent ?? "";
    expect(names).toContain("Jane Q Doe / Jane Doe");
    expect(names).toContain("J. Doe");
    expect(names).toContain("Also known as Jane Doe; Jane Q. Doe");
    expect(names).toContain("Agree: same surname, full given name");
    expect(names).toContain(
      "Example Medical College 1996–2001↔ ReCiter Identity: Example Medical College of Example University",
    );
    expect(names).toContain("No verified email");
    expect(names).toContain("Found by: 2 sources agree");
  });

  it("a competitor opens to the rule that fired and who; Open this iD jumps to that row", async () => {
    const best: OrcidQueueRow = {
      ...ROW,
      competitor: true,
      competitorOrcids: [{ orcid: OTHER, shared: 4 }],
      competitors: [{ cwid: "zz0009", name: "Zed Doe", shared: 5, reason: "same_surname" }],
    };
    mount([CARD({}, [best, SECOND])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    const callout = screen.getByTestId("orcid-queue-competitor");
    expect(callout.textContent).toContain("Rule 1 · Same-surname scholar");
    expect(callout.textContent).toContain("Zed Doe zz0009");
    expect(callout.textContent).toContain("Rule 2 · Another plausible iD");
    expect(callout.textContent).toContain("Candidate 2 · Weak · 0 of 12 shared");
    fireEvent.click(within(callout).getByText("Open this iD"));
    expect(
      screen
        .getByTestId(`orcid-queue-row-jd0001-${OTHER}`)
        .querySelector("[aria-expanded]")!
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("Confirm also marks the others, unless the box is cleared; then moves to the next scholar", async () => {
    const { posts } = mount([CARD({}, [ROW, SECOND]), JOHN]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    // The decision bar sits at the top of the panel and acts on the best open iD.
    const bar = screen.getByTestId("orcid-queue-decision-bar");
    expect(within(bar).getByTestId("orcid-queue-target").textContent).toBe(ORCID);
    expect(bar.textContent).toContain("Best match");
    expect(bar.textContent).toContain("Also mark the other iD");
    fireEvent.click(screen.getByTestId("orcid-queue-confirm"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      cwid: "jd0001",
      orcid: ORCID,
      decision: "confirm",
      dismissOthers: [OTHER],
    });
    // Decided: the queue moves on by itself, and the toast says what happened.
    expect(await screen.findByTestId("orcid-queue-card-js0002")).toBeTruthy();
    // The decided scholar stays in the list, greyed, and counts as progress.
    expect(
      within(screen.getByTestId("orcid-queue-item-jd0001")).getByTestId("orcid-queue-item-outcome")
        .textContent,
    ).toContain("Confirmed");
    expect(screen.getByTestId("orcid-queue-count").textContent).toBe("1 left");
    expect(screen.getByTestId("orcid-queue-decided").textContent).toBe("1 decided this session");
    expect(screen.getByTestId("orcid-queue-status").textContent).toContain(
      "Confirmed. The iD is on file and reaches WCM Identity overnight.",
    );
  });

  it("with the box cleared, Confirm sends no dismissOthers", async () => {
    const { posts } = mount([CARD({}, [ROW, SECOND])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    fireEvent.click(screen.getByTestId("orcid-queue-also-dismiss"));
    fireEvent.click(screen.getByTestId("orcid-queue-confirm"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).not.toHaveProperty("dismissOthers");
  });

  it("v3 B2: the others can be retired as the scholar's duplicate records", async () => {
    const { posts } = mount([CARD({}, [ROW, SECOND])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    fireEvent.change(screen.getByTestId("orcid-queue-others-as"), { target: { value: "retire" } });
    fireEvent.click(screen.getByTestId("orcid-queue-confirm"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      decision: "confirm",
      dismissOthers: [OTHER],
      retireOthers: true,
    });
  });

  it("v3 B2: an iD shared with another scholar offers Belongs to X and Not either", async () => {
    const shared: OrcidQueueRow = {
      ...ROW,
      competitor: true,
      competitors: [{ cwid: "zz0009", name: "Zed Doe", shared: 5, reason: "same_id" }],
    };
    const { posts } = mount([CARD({}, [shared])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    const callout = screen.getByTestId("orcid-queue-competitor");
    expect(within(callout).getByText("Not either")).toBeTruthy();
    fireEvent.click(within(callout).getByText("Belongs to Zed Doe"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      cwid: "jd0001",
      orcid: ORCID,
      decision: "dismiss",
      shared: { cwid: "zz0009", belongs: true },
    });
  });

  it("v3 B2: a decided scholar with no candidates shows a header-only card", async () => {
    const card = CARD(
      {
        ruledOut: [
          {
            orcid: OTHER,
            reason: "belongs_to_other",
            keptOrcid: null,
            otherCwid: "zz0009",
            otherName: "Zed Doe",
            by: "lib0001",
            byName: "Lib Rarian",
            at: "2026-10-28T12:00:00.000Z",
          },
        ],
      },
      [],
    );
    mount([card], {
      summaries: [
        summaryOf(card, {
          decisions: {
            byScholar: false,
            byStaff: true,
            librarian: false,
            at: "2026-10-28T12:00:00.000Z",
          },
        }),
      ],
    });
    // Unassigned (the default) hides it: nothing is open.
    expect(screen.queryByTestId("orcid-queue-item-jd0001")).toBeNull();
    fireEvent.click(screen.getByTestId("orcid-queue-filter-dec"));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    const shown = await screen.findByTestId("orcid-queue-card-jd0001");
    expect(within(shown).getByTestId("orcid-queue-ruled-out").textContent).toContain(
      "Belongs to another scholar (Zed Doe zz0009) by Lib Rarian lib0001",
    );
    expect(within(shown).queryByTestId("orcid-queue-evidence")).toBeNull();
  });

  it("Not this person opens the next open iD", async () => {
    const { posts } = mount([CARD({}, [ROW, SECOND])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    fireEvent.click(screen.getByTestId("orcid-queue-dismiss"));
    await vi.waitFor(() =>
      expect(
        screen
          .getByTestId(`orcid-queue-row-jd0001-${OTHER}`)
          .querySelector("[aria-expanded]")!
          .getAttribute("aria-expanded"),
      ).toBe("true"),
    );
    expect(posts()[0]).toMatchObject({ orcid: ORCID, decision: "dismiss" });
    expect(screen.getByTestId(`orcid-queue-row-jd0001-${ORCID}`).textContent).toContain(
      "Not this person",
    );
  });

  it("None of these marks every open iD in one request", async () => {
    const { posts } = mount([CARD({}, [ROW, SECOND])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    fireEvent.click(screen.getByTestId("orcid-queue-none"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({
      cwid: "jd0001",
      orcid: ORCID,
      decision: "dismiss",
      dismissOthers: [OTHER],
      noneOfThese: true,
    });
    expect((await screen.findByTestId("orcid-queue-decision")).textContent).toContain(
      "None of the candidates",
    );
  });

  it("a different iD on file: the provenance shows, and Confirm is Replace", async () => {
    const card = CARD(
      {
        onFile: {
          orcid: OTHER,
          how: "librarian",
          at: "2026-03-12T15:00:00Z",
          by: "dw0002",
          byName: "Dana Whit",
          name: "Cara Dee",
        },
      },
      [{ ...ROW, state: "conflict", onFileOrcid: OTHER }],
    );
    const { posts } = mount([card]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-on-file").textContent).toContain(
      "Confirmed by a librarian (Dana Whit dw0002) on Mar 12, 2026",
    );
    // The on-file iD's name, to compare against the candidate's; both iDs link out.
    expect(screen.getByTestId("orcid-queue-on-file").textContent).toContain("Cara Dee");
    const row = screen.getByTestId(`orcid-queue-row-jd0001-${ROW.orcid}`);
    expect(within(row).getByRole("link", { name: ROW.orcid }).getAttribute("href")).toContain(
      ROW.orcid,
    );
    expect(screen.getByTestId("orcid-queue-confirm").textContent).toContain("Replace with this iD");
    fireEvent.click(screen.getByTestId("orcid-queue-confirm"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ decision: "confirm", replace: true });
  });

  it("Unassigned is the default: an email auto-confirmed scholar shows once the Decision pill is removed, with Undo", async () => {
    const auto = CARD(
      {
        onFile: {
          orcid: ORCID,
          how: "email_verified",
          at: null,
          by: "ETL",
          byName: null,
          name: null,
        },
      },
      [
        {
          ...ROW,
          band: "email_verified",
          state: "auto_confirmed",
          autoConfirmed: true,
          onFileOrcid: ORCID,
        },
      ],
    );
    const { posts } = mount([auto]);
    expect(screen.getByTestId("orcid-queue-count").textContent).toBe("0 left");
    fireEvent.click(screen.getByTestId("orcid-queue-filter-dec"));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-decision").textContent).toContain(
      "Automatically, from a verified email",
    );
    expect(screen.queryByTestId("orcid-queue-confirm")).toBeNull();
    fireEvent.click(screen.getByTestId("orcid-queue-undo"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ decision: "dismiss", orcid: ORCID });
  });

  it("read-only under View as: no controls", async () => {
    mount([CARD({}, [ROW, SECOND])], { readOnly: true });
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.queryByTestId("orcid-queue-confirm")).toBeNull();
    expect(screen.queryByTestId("orcid-queue-none")).toBeNull();
  });

  it("a scholar who left the queue since the page loaded says so", async () => {
    mount([], { summaries: [summaryOf(CARD())] });
    expect(await screen.findByTestId("orcid-queue-gone")).toBeTruthy();
  });
});

describe("throughput: keyboard, undo, list summaries, Weak split, bulk review", () => {
  const SECOND: OrcidQueueRow = {
    ...ROW,
    orcid: OTHER,
    band: "weak",
    shared: 0,
    nameAgrees: false,
    detail: null,
    sources: ["orcid_name"],
  };
  const JOHN = CARD(
    { cwid: "js0002", slug: "john-smith", name: "John Smith, PhD", department: "Surgery" },
    [{ ...ROW, cwid: "js0002", band: "moderate", orcid: "0000-0001-5109-3700" }],
  );

  /** `mount`, with the per-item routes answering `{ results }`. */
  function mountWith(
    cards: OrcidQueueCard[],
    summaries?: OrcidQueueSummary[],
    bulkOk: (cwid: string) => boolean = () => true,
    /** The server floor's dry-run verdict (`dryRun: true`). */
    floorOk: (cwid: string) => boolean = () => true,
  ) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string) as {
          items?: Array<{ cwid: string }>;
          pairs?: Array<{ cwid: string; orcid: string }>;
          dryRun?: boolean;
        };
        const ok = body.dryRun ? floorOk : bulkOk;
        if (url.endsWith("/undo"))
          return Response.json({ results: body.items!.map((i) => ({ cwid: i.cwid, ok: true })) });
        if (url.endsWith("/bulk-confirm"))
          return Response.json({
            results: body.pairs!.map((p) =>
              ok(p.cwid)
                ? {
                    ...p,
                    ok: true,
                    // A dry run's extras: the name on ORCID, a verified email (aa0001 only).
                    ...(body.dryRun
                      ? {
                          orcidName: `ORCID ${p.cwid}`,
                          verifiedEmail: p.cwid === "aa0001",
                          hasPublications: !p.cwid.startsWith("ith"),
                        }
                      : {}),
                  }
                : { ...p, ok: false, code: "not_bulk_eligible", blocker: "institution" },
            ),
          });
        return Response.json({ ok: true });
      }
      const cwid = new URL(url, "http://x").searchParams.get("cwid");
      const c = cards.find((x) => x.cwid === cwid);
      return c ? Response.json(c) : new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <OrcidQueue
        data={data(summaries ?? cards.map((c) => summaryOf(c)))}
        basePath="/edit/orcid-queue"
        readOnly={false}
      />,
    );
    const posts = () =>
      (fetchMock.mock.calls as unknown as FetchCall[])
        .filter(([, i]) => i?.method === "POST")
        .map(([u, i]) => ({
          url: u,
          body: JSON.parse(i!.body as string) as Record<string, unknown>,
        }))
        // The Bulk review's eligibility dry run writes nothing.
        .filter((p) => p.body.dryRun !== true);
    return { posts };
  }

  it("each list row shows its tier and a one-line evidence summary; Weak splits into Thin and Conflicting", () => {
    const thin = CARD({ cwid: "tn0001", name: "Tia Thin" }, [
      { ...ROW, cwid: "tn0001", band: "weak", shared: 1, worksTotal: 1 },
    ]);
    const conflicting = CARD({ cwid: "cf0001", name: "Cal Conflict" }, [
      { ...ROW, cwid: "cf0001", band: "weak", shared: 0, worksTotal: 0, nameAgrees: false },
    ]);
    mountWith([CARD(), thin, conflicting]);
    const item = (cwid: string) => screen.getByTestId(`orcid-queue-item-${cwid}`);
    expect(within(item("jd0001")).getByTestId("orcid-queue-item-summary").textContent).toBe(
      "7/12 shared · 1 iD",
    );
    expect(item("jd0001").textContent).toContain("Strong");
    expect(item("tn0001").textContent).toContain("Thin evidence");
    expect(within(item("cf0001")).getByTestId("orcid-queue-item-summary").textContent).toBe(
      "No works on ORCID · 1 iD",
    );
    expect(item("cf0001").textContent).toContain("Conflicting");
  });

  it("C confirms the open iD and marks the others, the queue moves on, and Z undoes it", async () => {
    const { posts } = mountWith([CARD({}, [ROW, SECOND]), JOHN]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    fireEvent.keyDown(window, { key: "c" });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      url: "/api/edit/orcid-queue/decide",
      body: { cwid: "jd0001", orcid: ORCID, decision: "confirm", dismissOthers: [OTHER] },
    });
    expect(await screen.findByTestId("orcid-queue-card-js0002")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-status-undo")).toBeTruthy();

    fireEvent.keyDown(window, { key: "z" });
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toEqual({
      url: "/api/edit/orcid-queue/undo",
      body: { items: [{ cwid: "jd0001", confirmed: ORCID, dismissed: [OTHER] }] },
    });
    // Back on the scholar, undecided again.
    expect(await screen.findByTestId("orcid-queue-card-jd0001")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-item-jd0001")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-status").textContent).toContain("Undone");
    expect(screen.getByTestId("orcid-queue-confirm")).toBeTruthy();
  });

  it("X marks the open iD Not this person and stays while iDs are open; N rules out the rest", async () => {
    const { posts } = mountWith([CARD({}, [ROW, SECOND]), JOHN]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    fireEvent.keyDown(window, { key: "x" });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toMatchObject({ cwid: "jd0001", orcid: ORCID, decision: "dismiss" });
    // One iD still open: stays on Jane, with the first marked.
    await vi.waitFor(() => expect(screen.getAllByTestId("orcid-queue-outcome")).toHaveLength(1));
    expect(screen.getByTestId("orcid-queue-card-jd0001")).toBeTruthy();
    fireEvent.keyDown(window, { key: "n" });
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.body).toMatchObject({
      cwid: "jd0001",
      orcid: OTHER,
      decision: "dismiss",
      noneOfThese: true,
    });
    expect(await screen.findByTestId("orcid-queue-card-js0002")).toBeTruthy();
  });

  it("shortcuts do nothing while typing in a field", async () => {
    const { posts } = mountWith([CARD()]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    const search = screen.getByRole("searchbox");
    fireEvent.keyDown(search, { key: "c" });
    await new Promise((r) => setTimeout(r, 20));
    expect(posts()).toHaveLength(0);
  });

  it("no works on the ORCID record says so instead of 0 of 0", async () => {
    mountWith([CARD({}, [{ ...ROW, shared: 0, worksTotal: 0, newWorks: 0 }])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-no-works").textContent).toBe("No works on ORCID");
  });

  it("Bulk review lists scholars under the rule, tints any with works only on ORCID, and confirms after asking", async () => {
    const mk = (cwid: string, over: Partial<OrcidQueueRow>) =>
      CARD({ cwid, name: `Scholar ${cwid}` }, [{ ...ROW, cwid, orcid: ORCID, ...over }]);
    const clean = mk("aa0001", { shared: 7, worksTotal: 7, newWorks: 0 });
    const oneExtra = mk("bb0002", { shared: 7, worksTotal: 8, newWorks: 1 });
    const moderate = mk("cc0003", { band: "moderate", shared: 7, worksTotal: 7, newWorks: 0 });
    // Passes the client rule but not the server floor (e.g. no institution match).
    const floorFail = mk("dd0004", { shared: 7, worksTotal: 7, newWorks: 0 });
    const withNew = (c: OrcidQueueCard) =>
      summaryOf(c, {
        candidates: c.candidates.map((r) => ({
          orcid: r.orcid,
          band: r.band,
          shared: r.shared,
          worksTotal: r.worksTotal,
          newWorks: r.newWorks,
          nameAgrees: r.nameAgrees,
          competitor: r.competitor,
          sources: r.sources,
        })),
      });
    const { posts } = mountWith(
      [clean, oneExtra, moderate, floorFail],
      [clean, oneExtra, moderate, floorFail].map(withNew),
      (cwid) => cwid === "aa0001",
      (cwid) => cwid !== "dd0004",
    );
    fireEvent.click(screen.getByTestId("orcid-queue-mode-bulk"));
    expect((await screen.findByTestId("orcid-bulk-count")).textContent).toBe(
      "2 of 3 Strong or Email verified scholars match",
    );
    // Everyone else is counted under the first check they fail; folded while anyone matches.
    const why = () => screen.getByTestId("orcid-bulk-why") as HTMLDetailsElement;
    expect(why().open).toBe(false);
    expect(why().textContent).toContain("Why the other 2 in this view don’t match");
    expect(why().textContent).toContain("1Moderate: reviewed one at a time");
    expect(why().textContent).toContain(
      "1No Cornell or WCM affiliation or email on the ORCID record",
    );
    expect(screen.queryByTestId("orcid-bulk-row-cc0003")).toBeNull();
    expect(screen.queryByTestId("orcid-bulk-row-dd0004")).toBeNull();
    expect(screen.getByTestId("orcid-bulk-row-bb0002").className).toContain("bg-apollo-coral-tint");
    expect(screen.getByTestId("orcid-bulk-footer").textContent).toContain(
      "1 tinted row still checked",
    );
    // The mode toggle carries the count; each row shows the name on the ORCID record.
    expect((await screen.findByTestId("orcid-queue-bulk-count")).textContent).toBe("2");
    expect(screen.getByTestId("orcid-bulk-row-aa0001").textContent).toContain("ORCID aa0001");

    // Verified email narrows to rows whose record lists the scholar's email.
    fireEvent.click(screen.getByTestId("orcid-bulk-rule-email"));
    expect(screen.getByTestId("orcid-bulk-count").textContent).toBe(
      "1 of 3 Strong or Email verified scholars match",
    );
    expect(why().textContent).toContain("1Doesn't meet the boxes checked above");
    expect(screen.queryByTestId("orcid-bulk-row-bb0002")).toBeNull();
    fireEvent.click(screen.getByTestId("orcid-bulk-rule-email"));

    // Unchecking a threshold stops applying it; checking it restores the default.
    fireEvent.click(screen.getByTestId("orcid-bulk-rule-minSources-on"));
    expect((screen.getByTestId("orcid-bulk-rule-minSources") as HTMLSelectElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByTestId("orcid-bulk-rule-minSources-on"));
    expect((screen.getByTestId("orcid-bulk-rule-minSources") as HTMLSelectElement).value).toBe("2");

    // Tighten the rule: nothing only on ORCID.
    fireEvent.change(screen.getByTestId("orcid-bulk-rule-maxOnlyOrcid"), {
      target: { value: "0" },
    });
    expect(screen.queryByTestId("orcid-bulk-row-bb0002")).toBeNull();
    fireEvent.change(screen.getByTestId("orcid-bulk-rule-maxOnlyOrcid"), {
      target: { value: "1" },
    });

    fireEvent.click(screen.getByTestId("orcid-bulk-confirm"));
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("orcid-bulk-confirm-yes"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({
      url: "/api/edit/orcid-queue/bulk-confirm",
      body: {
        pairs: [
          { cwid: "aa0001", orcid: ORCID },
          { cwid: "bb0002", orcid: ORCID },
        ],
        rule: { minShared: 5, maxOnlyOrcid: 1, minSources: 2 },
      },
    });
    expect((await screen.findByTestId("orcid-queue-status")).textContent).toContain(
      "Confirmed 1 iD. They reach WCM Identity overnight. 1 scholar no longer qualified and stayed in the queue.",
    );
    // The confirmed scholar drops out; the skipped one stays.
    expect(screen.queryByTestId("orcid-bulk-row-aa0001")).toBeNull();
    expect(screen.getByTestId("orcid-bulk-row-bb0002")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-status-undo")).toBeTruthy();
  });

  it("Bulk review compares an Ithaca scholar's works once Scholars has their publications", async () => {
    const c = CARD({ cwid: "cu0001", name: "Scholar cu0001" }, [
      {
        ...ROW,
        cwid: "cu0001",
        orcid: ORCID,
        shared: 7,
        worksTotal: 9,
        newWorks: 2,
        sources: ["web_page_seed"],
      },
    ]);
    mountWith([c], [{ ...summaryOf(c), campus: "ithaca" as const }]);
    fireEvent.click(screen.getByTestId("orcid-queue-mode-bulk"));
    const row = await screen.findByTestId("orcid-bulk-row-cu0001");
    expect(row.className).toContain("coral");
    expect(row.textContent).toContain("7 of 92");
    expect(row.textContent).not.toContain("check");
  });

  it("Bulk review opens the reasons when nobody matches, whatever the boxes say", async () => {
    const c = CARD({ cwid: "dd0004", name: "Scholar dd0004" }, [
      { ...ROW, cwid: "dd0004", orcid: ORCID, shared: 7, worksTotal: 7, newWorks: 0 },
    ]);
    mountWith([c], undefined, undefined, () => false);
    fireEvent.click(screen.getByTestId("orcid-queue-mode-bulk"));
    expect((await screen.findByTestId("orcid-bulk-count")).textContent).toBe(
      "0 of 1 Strong or Email verified scholar matches",
    );
    const why = (await screen.findByTestId("orcid-bulk-why")) as HTMLDetailsElement;
    expect(why.open).toBe(true);
    fireEvent.click(screen.getByTestId("orcid-bulk-rule-minShared-on"));
    expect(screen.getByTestId("orcid-bulk-why").textContent).toContain(
      "1No Cornell or WCM affiliation or email on the ORCID record",
    );
  });

  it("Bulk review takes Cornell Ithaca Strong pairs without the thresholds, at most 100 per batch", async () => {
    const cards = Array.from({ length: 102 }, (_, i) => {
      const cwid = `ith${String(i).padStart(4, "0")}`;
      return CARD({ cwid, name: `Scholar ${cwid}` }, [
        { ...ROW, cwid, orcid: ORCID, shared: 0, worksTotal: 9, newWorks: 9, sources: ["cornell_affiliation_manager"] },
      ]);
    });
    const { posts } = mountWith(
      cards,
      cards.map((c) => ({ ...summaryOf(c), campus: "ithaca" as const })),
    );
    fireEvent.click(screen.getByTestId("orcid-queue-mode-bulk"));
    expect((await screen.findByTestId("orcid-bulk-count")).textContent).toBe(
      "102 of 102 Strong or Email verified scholars match",
    );
    expect(screen.getByTestId("orcid-bulk-ithaca-cap").textContent).toContain(
      "2 more after this one",
    );
    // No publications here: nothing to compare, so no tint and no warning count.
    const row = screen.getByTestId("orcid-bulk-row-ith0000");
    expect(row.className).not.toContain("coral");
    expect(row.textContent).toContain("9 on ORCIDNot compared");
    expect(row.innerHTML).not.toContain("coral");
    expect(screen.getByTestId("orcid-bulk").textContent).toContain(
      "Not compared means Scholars has no publications for this person yet.",
    );
    fireEvent.click(screen.getByTestId("orcid-bulk-confirm"));
    fireEvent.click(screen.getByTestId("orcid-bulk-confirm-yes"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect((posts()[0]!.body.pairs as unknown[]).length).toBe(100);
    expect((await screen.findByTestId("orcid-queue-status")).textContent).toContain(
      "Confirmed 100 iDs. Cornell Ithaca iDs stay in Scholars.",
    );
  });
});
