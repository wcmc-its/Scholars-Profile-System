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
};
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
                    newWorksSample: [],
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
      division: { findMany: vi.fn(async () => []) },
      divisionMembership: { findMany: vi.fn(async () => []) },
      scholar: {
        findMany: vi.fn(
          async (args: {
            where: {
              orcidConfirmMethod?: string;
              cwid?: { in: string[] };
              roleCategory?: { in: string[] };
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

  it("workHref: PubMed, else doi.org, else the work's own http(s) URL", () => {
    expect(workHref({ pmid: "123", doi: "10.1/a" })).toBe("https://pubmed.ncbi.nlm.nih.gov/123/");
    expect(workHref({ pmid: null, doi: "10.1/a" })).toBe("https://doi.org/10.1/a");
    expect(workHref({ url: "https://example.org/w" })).toBe("https://example.org/w");
    expect(workHref({ url: "javascript:alert(1)" })).toBeNull();
    expect(workHref({})).toBeNull();
  });
});

describe("client", () => {
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
