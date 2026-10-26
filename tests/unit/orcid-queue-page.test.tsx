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
  candidates: c.candidates.map(({ orcid, band, shared, worksTotal, nameAgrees, competitor }) => ({
    orcid,
    band,
    shared,
    worksTotal,
    nameAgrees,
    competitor,
  })),
  conflict: c.candidates.some((r) => r.state === "conflict"),
  autoConfirmed: c.candidates.some((r) => r.autoConfirmed),
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
      evidenceDetail: e.cwid === "a00001" ? DETAIL : null,
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
        findMany: vi.fn(async () => [{ cwid: "b00001", orcid: ORCID }]),
      },
    } as never;
  };

  const cwidsOf = (q: OrcidQueueData) => q.summaries.map((s) => s.cwid).sort();

  it("one summary per scholar, candidates best first; a dismissed pair drops; conflicts and the ETL's iDs are flagged", async () => {
    const q = await (await actual()).loadOrcidQueue(client());
    expect(cwidsOf(q)).toEqual(["a00001", "c00001", "d00001", "e00001", "f00001"]);
    const by = (c: string) => q.summaries.find((s) => s.cwid === c)!;
    expect(by("a00001")).toMatchObject({
      name: "Pref a00001",
      surname: "a00001",
      conflict: false,
      autoConfirmed: false,
    });
    expect(by("a00001").candidates.map((r) => [r.orcid, r.band])).toEqual([
      [ORCID, "strong"],
      [OTHER_2, "weak"],
    ]);
    expect(by("c00001")).toMatchObject({ conflict: true });
    expect(by("e00001")).toMatchObject({ autoConfirmed: true });
    expect(by("e00001").candidates[0]).toMatchObject({ band: "email_verified" });
  });

  it("an rpm_admin iD is on file: that scholar's other candidate is a conflict", async () => {
    const q = await (
      await actual()
    ).loadOrcidQueue(client({ admins: [{ cwid: "a00001", orcid: OTHER }] }));
    expect(q.summaries.find((s) => s.cwid === "a00001")).toMatchObject({ conflict: true });
  });

  it("the filter narrows the list: person type, how discovered (a kept scholar keeps every candidate)", async () => {
    const { loadOrcidQueue } = await actual();
    const byType = await loadOrcidQueue(client(), { types: ["postdoc"], units: [], sources: [] });
    expect(cwidsOf(byType)).toEqual(["d00001"]);
    const bySource = await loadOrcidQueue(client(), {
      types: [],
      units: [],
      sources: ["orcid_works"],
    });
    expect(cwidsOf(bySource)).toEqual(["a00001"]);
    expect(bySource.summaries[0]!.candidates).toHaveLength(2);
  });

  it("the filter narrows the list: department, division (with its manual roster), institution", async () => {
    const { loadOrcidQueue } = await actual();
    expect(
      cwidsOf(await loadOrcidQueue(client(), { types: [], units: ["dept:MED"], sources: [] })),
    ).toEqual(["a00001", "c00001"]);
    expect(
      cwidsOf(
        await loadOrcidQueue(client({ rosters: { CARD: ["d00001"] } }), {
          types: [],
          units: ["div:CARD"],
          sources: [],
        }),
      ),
    ).toEqual(["a00001", "d00001"]);
    expect(
      cwidsOf(await loadOrcidQueue(client(), { types: [], units: ["inst:HSS"], sources: [] })),
    ).toEqual(["f00001"]);
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
    const c = (await loadOrcidQueueCard(client(), "c00001"))!;
    expect(c.onFile).toEqual({ orcid: OTHER, how: "identity", at: null, by: null, byName: null });
    expect(c.candidates[0]).toMatchObject({ state: "conflict", onFileOrcid: OTHER });
    const e = (await loadOrcidQueueCard(client(), "e00001"))!;
    expect(e.onFile).toMatchObject({
      orcid: ORCID,
      how: "email_verified",
      by: "ETL",
      byName: null,
    });
    expect(e.candidates).toEqual([
      expect.objectContaining({ autoConfirmed: true, state: "auto_confirmed" }),
    ]);
  });

  it("the card is null for a scholar with nothing in the queue", async () => {
    expect(await (await actual()).loadOrcidQueueCard(client(), "b00001")).toBeNull();
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
      })),
      ...over,
    }) as OrcidQueueSummary;

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
    expect(orcidQueueFilterKey({ types: ["b", "a"], units: [], sources: ["orcid_works"] })).toBe(
      "type=a&type=b&source=orcid_works",
    );
    expect(orcidQueueHref("/q", { types: ["a"], units: [], sources: [] })).toBe("/q?type=a");
    expect(orcidQueueHref("/q", EMPTY_ORCID_QUEUE_FILTER)).toBe("/q");
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
    expect(screen.getByTestId("orcid-queue-count").textContent).toBe("2 scholars");
    const card = await screen.findByTestId("orcid-queue-card-jd0001");
    expect(within(card).getByText("View profile ↗").getAttribute("href")).toBe("/jane-doe");
    expect(within(card).getByTestId("orcid-queue-evidence").textContent).toContain(
      "From its one iD: 2 sources agree; 7 of the 12 works on the ORCID record are also in ReCiter; name agrees.",
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
    expect(screen.getByTestId("orcid-queue-count").textContent).toBe("1 scholar");
    fireEvent.change(screen.getByTestId("orcid-queue-search"), { target: { value: "" } });
    expect(screen.getByTestId("orcid-queue-filter-errors").textContent).toBe("Possible errors · 1");
    fireEvent.click(screen.getByTestId("orcid-queue-filter-errors"));
    expect(screen.getByTestId("orcid-queue-count").textContent).toBe("1 scholar");
    expect(screen.getByTestId("orcid-queue-item-cf0003")).toBeTruthy();
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

  it("names side by side and the signals with their facts", async () => {
    mount([CARD()]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    const names = screen.getByTestId("orcid-queue-names").textContent ?? "";
    expect(names).toContain("Jane Q Doe / Jane Doe");
    expect(names).toContain("J. Doe");
    expect(names).toContain("Also known as Jane Doe; Jane Q. Doe");
    expect(names).toContain("Agree: same surname, full given name");
    expect(names).toContain(
      "Example Medical College 1996–2001 ↔ ReCiter Identity: Example Medical College of Example University",
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

  it("Confirm also marks the others, unless the box is cleared; the scholar stays, decided", async () => {
    const { posts } = mount([CARD({}, [ROW, SECOND]), JOHN]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByText("2 candidate iDs, best first")).toBeTruthy();
    fireEvent.click(screen.getByTestId("orcid-queue-confirm"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      cwid: "jd0001",
      orcid: ORCID,
      decision: "confirm",
      dismissOthers: [OTHER],
    });
    // Decided, but still listed until you move on.
    expect(await screen.findByTestId("orcid-queue-decision")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-item-jd0001")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-resolved").textContent).toBe(
      `Confirmed ${ORCID}. Reaches WCM Identity overnight.`,
    );
    fireEvent.click(screen.getByText("Next scholar"));
    expect(await screen.findByTestId("orcid-queue-card-js0002")).toBeTruthy();
    expect(screen.queryByTestId("orcid-queue-item-jd0001")).toBeNull();
  });

  it("with the box cleared, Confirm sends no dismissOthers", async () => {
    const { posts } = mount([CARD({}, [ROW, SECOND])]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    fireEvent.click(screen.getByTestId("orcid-queue-also-dismiss"));
    fireEvent.click(screen.getByTestId("orcid-queue-confirm"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).not.toHaveProperty("dismissOthers");
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
        },
      },
      [{ ...ROW, state: "conflict", onFileOrcid: OTHER }],
    );
    const { posts } = mount([card]);
    await screen.findByTestId("orcid-queue-card-jd0001");
    expect(screen.getByTestId("orcid-queue-on-file").textContent).toContain(
      "Confirmed by a librarian (Dana Whit dw0002) on Mar 12, 2026",
    );
    expect(screen.getByTestId("orcid-queue-confirm").textContent).toBe("Replace with this iD");
    fireEvent.click(screen.getByTestId("orcid-queue-confirm"));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ decision: "confirm", replace: true });
  });

  it("Unassigned is the default: an email auto-confirmed scholar shows once the Decision pill is removed, with Undo", async () => {
    const auto = CARD(
      { onFile: { orcid: ORCID, how: "email_verified", at: null, by: "ETL", byName: null } },
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
    expect(screen.getByTestId("orcid-queue-count").textContent).toBe("0 scholars");
    fireEvent.click(screen.getByLabelText("Remove Decision: Unassigned"));
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
