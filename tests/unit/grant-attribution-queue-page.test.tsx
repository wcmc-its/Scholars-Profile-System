/**
 * #3071 — the grant attribution queue page gate, its predicates, and the card.
 *
 *   - Predicates: decide = superuser || comms_steward; read = those plus
 *     observer and content editor; never the scholar or a unit admin. The tab
 *     predicate is the page gate (same function, I2 parity).
 *   - Page: no session → SSO redirect; flag off → 404 for everyone; a viewer
 *     who cannot read → ForbiddenEditPage; a reader gets the queue.
 *   - Review: a list beside the focused award's detail; every cue with its
 *     reason, the co-PI co-author named with the shared papers, the scholar
 *     marked in the PI list; actions only for a decider; a rejection takes a
 *     reason; bulk select and filters.
 *   - Helpers: confidence levels and RePORTER name handling.
 *
 * Fixture people and awards are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  rawSession: vi.fn(),
  impersonating: vi.fn(() => false),
  load: vi.fn(),
  decided: vi.fn(async (_c: unknown, params: unknown, _runs?: unknown, _opts?: unknown) => ({
    params,
    counts: {
      confirmed: { all: 321, curator: 1, auto: 320 },
      rejected: { all: 7, curator: 2, auto: 5 },
      unproven: { all: 4, curator: 0, auto: 4 },
    },
    changed: 0,
    matched: 0,
    rows: [],
    groups: null,
    unprovenIds: ["reporter:zzb0002:R21YY000002"],
  })),
  unproven: vi.fn<(c: unknown, ids: string[]) => Promise<unknown[]>>(async () => []),
  shell: vi.fn(),
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
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.session,
  impersonationActive: h.impersonating,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.rawSession }));
vi.mock("@/lib/edit/grant-attribution-queue.server", () => ({
  loadGrantAttributionQueue: h.load,
  countPendingGrantAttribution: vi.fn(),
  countGrantAttribution: vi.fn(async (_c: unknown, status: string) => (status === "confirmed" ? 321 : 7)),
  loadAutoConfirmed: vi.fn(async () => ({ items: [], total: 0 })),
  loadGrantAttributionRuns: vi.fn(async () => []),
  loadUnprovenQueueItems: h.unproven,
}));
vi.mock("@/lib/edit/grant-attribution-decided.server", () => ({
  loadDecidedPage: h.decided,
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
vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: ({ children }: { children: unknown }) => children,
}));

import GrantAttributionQueuePage from "@/app/edit/grant-attribution-queue/page";
import { GrantAttributionQueue } from "@/components/edit/grant-attribution-queue";
import { TAB_PREDICATES } from "@/lib/edit/console-tabs.server";
import {
  attributionLevel,
  canDecideGrantAttribution,
  isCoauthorshipOnly,
  isScholarPi,
  reporterNameForDisplay,
  reporterNameParts,
  decidingReason,
  canViewGrantAttributionQueue,
  isGrantAttributionQueueReadOnly,
  asRejectedPapers,
  type GrantAttributionItem,
} from "@/lib/edit/grant-attribution-queue";

const SUPER = { cwid: "zzs0001", isSuperuser: true };
const STEWARD = { cwid: "zzc0001", isSuperuser: false, isCommsSteward: true };
// The real READ-session shapes: both roles carry a SYNTHETIC steward grant
// (lib/auth/observer-view.ts), which must not make them deciders.
const OBSERVER = { cwid: "zzo0001", isSuperuser: false, isCommsSteward: true, isObserver: true };
const EDITOR = { cwid: "zze0001", isSuperuser: false, isCommsSteward: true, isContentEditor: true };
const SCHOLAR = { cwid: "zzn0001", isSuperuser: false };

const ITEM: GrantAttributionItem = {
  id: "rev-1",
  grantId: "reporter:zza0001:R01XX000001",
  unproven: false,
  cwid: "zza0001",
  slug: "pat-example",
  scholarName: "Pat Example, MD",
  scholarSurname: "Example",
  title: "Professor of Medicine",
  department: "Medicine",
  score: 0,
  band: "queue",
  cues: [
    { id: "prior_institution", weight: 2, reason: "Held at an institution the scholar trained at (Example University)" },
    { id: "middle_initial_conflict", weight: -1, reason: "The NIH PI's middle initial differs from the scholar's" },
  ],
  award: {
    title: "A synthetic study",
    awardNumber: "5R01XX000001-02",
    coreProjectNum: "R01XX000001",
    activityCode: "R01",
    applId: 123,
    startYear: 2001,
    endYear: 2005,
    orgs: [{ name: "EXAMPLE UNIVERSITY", from: 2001, to: 2005 }],
    piNames: ["EXAMPLE, PAT Q", "SAMPLE, LEE"],
  },
  status: "pending",
  firstSeenAt: "2026-10-19T00:00:00.000Z",
  reopenedAt: null,
  decidedAt: null,
  decidedByName: null,
  rejectionReason: null,
  reporterName: "EXAMPLE, PAT Q",
  scholarNames: ["Pat Example", "Example, Pat Q"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("GRANT_ATTRIBUTION_QUEUE", "on");
  h.load.mockResolvedValue([]);
  h.rawSession.mockResolvedValue({ cwid: "zzs0001" });
  h.impersonating.mockReturnValue(false);
});

describe("predicates", () => {
  it("decide: superuser or comms_steward only", () => {
    expect(canDecideGrantAttribution(SUPER)).toBe(true);
    expect(canDecideGrantAttribution(STEWARD)).toBe(true);
    for (const s of [OBSERVER, EDITOR, SCHOLAR]) expect(canDecideGrantAttribution(s)).toBe(false);
  });

  it("read: deciders plus observers and content editors, read-only", () => {
    for (const s of [SUPER, STEWARD, OBSERVER, EDITOR]) expect(canViewGrantAttributionQueue(s)).toBe(true);
    expect(canViewGrantAttributionQueue(SCHOLAR)).toBe(false);
    expect(isGrantAttributionQueueReadOnly(OBSERVER)).toBe(true);
    expect(isGrantAttributionQueueReadOnly(EDITOR)).toBe(true);
    expect(isGrantAttributionQueueReadOnly(STEWARD)).toBe(false);
    // Under View as, read-only even for a superuser: the route refuses it.
    expect(isGrantAttributionQueueReadOnly(SUPER, true)).toBe(true);
  });

  it("the tab predicate admits exactly whom the page admits, and the flag gates both", () => {
    const g = {} as never;
    for (const s of [SUPER, STEWARD, OBSERVER, EDITOR, SCHOLAR]) {
      expect(TAB_PREDICATES.grantAttribution(s as never, g)).toBe(canViewGrantAttributionQueue(s));
    }
    vi.stubEnv("GRANT_ATTRIBUTION_QUEUE", "off");
    expect(TAB_PREDICATES.grantAttribution(SUPER as never, g)).toBe(false);
  });
});

describe("page gate", () => {
  it("redirects with no session", async () => {
    h.session.mockResolvedValue(null);
    await expect(GrantAttributionQueuePage({ searchParams: Promise.resolve({}) })).rejects.toThrow("__REDIRECT__");
  });

  it("404s for everyone when the flag is off", async () => {
    vi.stubEnv("GRANT_ATTRIBUTION_QUEUE", "off");
    h.session.mockResolvedValue(SUPER);
    await expect(GrantAttributionQueuePage({ searchParams: Promise.resolve({}) })).rejects.toThrow("__NOT_FOUND__");
    expect(h.load).not.toHaveBeenCalled();
  });

  it("shows a non-reader the forbidden page and loads nothing", async () => {
    h.session.mockResolvedValue(SCHOLAR);
    await GrantAttributionQueuePage({ searchParams: Promise.resolve({}) });
    expect(h.load).not.toHaveBeenCalled();
  });

  it("loads the pending list and the decided counts for a reader, and hands the shell the pending count", async () => {
    h.session.mockResolvedValue(OBSERVER);
    h.load.mockImplementation(async (_c: unknown, status: string) => (status === "pending" ? [ITEM] : []));
    const el = (await GrantAttributionQueuePage({ searchParams: Promise.resolve({}) })) as { props: Record<string, unknown> };
    expect(h.load.mock.calls.map((c) => c[1])).toEqual(["pending"]);
    // On To review the decided pass only counts: no rows hydrated.
    expect(h.decided.mock.calls[0]![3]).toEqual({ hydrate: false });
    expect(el.props.pendingGrantAttribution).toBe(1);
  });

  it("lists Unproven awards in To review, with no Unproven tab", async () => {
    h.session.mockResolvedValue(STEWARD);
    h.load.mockImplementation(async (_c: unknown, status: string) => (status === "pending" ? [ITEM] : []));
    h.unproven.mockResolvedValue([UNPROVEN]);
    const el = (await GrantAttributionQueuePage({ searchParams: Promise.resolve({}) })) as { props: { children: unknown } };
    render(el.props.children as React.ReactElement);
    expect(h.unproven.mock.calls[0]![1]).toEqual(["reporter:zzb0002:R21YY000002"]);
    expect(screen.queryByTestId("grant-attribution-tab-unproven")).toBeNull();
    // 1 pending review + the decided pass's 4 Unproven.
    expect(screen.getByTestId("grant-attribution-tab-pending").textContent).toContain("5");
    const list = within(screen.getByTestId("grant-attribution-list"));
    expect(list.getByText("Pat Example, MD")).toBeTruthy();
    expect(list.getByText("Lee Sample, PhD")).toBeTruthy();
  });

  it("sends an old ?tab=unproven link to To review", async () => {
    h.session.mockResolvedValue(STEWARD);
    h.load.mockResolvedValue([]);
    h.unproven.mockResolvedValue([UNPROVEN]);
    await GrantAttributionQueuePage({ searchParams: Promise.resolve({ tab: "unproven" }) });
    expect(h.decided.mock.calls[0]![3]).toEqual({ hydrate: false });
    expect(h.unproven).toHaveBeenCalled();
  });

  it("loads one hydrated page of a decided tab from the URL", async () => {
    h.session.mockResolvedValue(STEWARD);
    h.load.mockResolvedValue([]);
    await GrantAttributionQueuePage({ searchParams: Promise.resolve({ tab: "rejected", by: "auto", page: "2" }) });
    const [, params, , opts] = h.decided.mock.calls[0]!;
    expect(params).toMatchObject({ tab: "rejected", by: "auto", page: 2 });
    expect(opts).toEqual({ hydrate: true });
  });

  it("passes read-only to observers and content editors (synthetic steward), and under View as", async () => {
    const queueProps = (el: { props: { children: unknown } }) => {
      const kids = el.props.children as Array<{ props: Record<string, unknown> }>;
      return kids[kids.length - 1]!.props;
    };
    for (const s of [OBSERVER, EDITOR]) {
      h.session.mockResolvedValue(s);
      expect(queueProps((await GrantAttributionQueuePage({ searchParams: Promise.resolve({}) })) as never).readOnly).toBe(true);
    }
    h.session.mockResolvedValue(STEWARD);
    expect(queueProps((await GrantAttributionQueuePage({ searchParams: Promise.resolve({}) })) as never).readOnly).toBe(false);
    h.session.mockResolvedValue(SUPER);
    h.impersonating.mockReturnValue(true);
    const props = queueProps((await GrantAttributionQueuePage({ searchParams: Promise.resolve({}) })) as never);
    expect(props.readOnly).toBe(true);
  });
});

const COAUTHOR: GrantAttributionItem = {
  ...ITEM,
  id: "rev-2",
  grantId: "reporter:zza0001:R01XX000009",
  cues: [
    {
      id: "copi_coauthor",
      weight: 2,
      reason: "A co-PI on this award co-authored 5 of the scholar's papers",
      coPi: {
        name: "SAMPLE, LEE",
        total: 5,
        papers: [{ pmid: "111", title: "A shared synthetic paper", journal: "J Example", year: 2024 }],
      },
    },
  ],
  award: { ...ITEM.award, title: "A second synthetic study", applId: 456 },
};

/** An award the check found nothing on: no review, so its id is the grant's. */
const UNPROVEN: GrantAttributionItem = {
  ...ITEM,
  id: "reporter:zzb0002:R21YY000002",
  grantId: "reporter:zzb0002:R21YY000002",
  unproven: true,
  cwid: "zzb0002",
  scholarName: "Lee Sample, PhD",
  score: -1,
  band: "hide",
  cues: [],
  award: { ...ITEM.award, title: "A third synthetic study", applId: 789 },
};

const queue = (readOnly = false, pending = [ITEM]) =>
  render(<GrantAttributionQueue pending={pending} readOnly={readOnly} />);
const detail = () => within(screen.getByTestId("grant-attribution-detail"));

describe("helpers", () => {
  it("reads a stored cue's rejected papers, dropping an empty or malformed list", () => {
    expect(asRejectedPapers([{ pmid: "1", title: "T" }, { pmid: "2", title: null }])).toEqual([
      { pmid: "1", title: "T" },
      { pmid: "2", title: null },
    ]);
    expect(asRejectedPapers(undefined)).toBeUndefined();
    expect(asRejectedPapers([])).toBeUndefined();
    expect(asRejectedPapers([{ pmid: 1, title: "T" }])).toBeUndefined();
    expect(asRejectedPapers([{ pmid: "1" }])).toBeUndefined();
  });

  it("levels: a strong negative rules out, both sides conflict, a link or two cues is high", () => {
    expect(attributionLevel([{ id: "timeline_impossible", weight: -5 }, { id: "prior_institution", weight: 2 }])).toEqual({
      level: "out",
      veto: "timeline_impossible",
    });
    // A strong tie the other way makes it a conflict, not a ruling.
    expect(attributionLevel([{ id: "timeline_impossible", weight: -5 }, { id: "pub_linked", weight: 5 }])).toEqual({
      level: "conflict",
      veto: null,
    });
    // Reviews stored before 2026-10-24 carry the named InfoEd cue at weight 0.
    expect(attributionLevel([{ id: "infoed_other_wcm_pi_named", weight: 0 }]).level).toBe("out");
    expect(attributionLevel([{ id: "prior_institution", weight: 2 }, { id: "middle_initial_conflict", weight: -1 }]).level).toBe("conflict");
    expect(attributionLevel([{ id: "pub_linked", weight: 4 }]).level).toBe("high");
    expect(attributionLevel([{ id: "copi_coauthor", weight: 2 }, { id: "topic_match", weight: 1 }]).level).toBe("high");
    expect(attributionLevel([{ id: "copi_coauthor", weight: 2 }]).level).toBe("likely");
    expect(attributionLevel([]).level).toBe("unclear");
    // Name rarity never counts as a cue of its own.
    expect(attributionLevel([{ id: "copi_coauthor", weight: 2 }, { id: "name_rare", weight: 1 }]).level).toBe("likely");
    expect(attributionLevel([{ id: "copi_coauthor", weight: 2 }, { id: "name_common", weight: -1 }]).level).toBe("likely");
  });

  it("co-authorship-only is co-PI and topic cues and nothing else", () => {
    expect(isCoauthorshipOnly([{ id: "copi_coauthor" }, { id: "topic_match" }])).toBe(true);
    expect(isCoauthorshipOnly([{ id: "copi_coauthor" }, { id: "wcm_org" }])).toBe(false);
    expect(isCoauthorshipOnly([])).toBe(false);
    // Name rarity is a modifier: it neither makes nor breaks co-authorship-only.
    expect(isCoauthorshipOnly([{ id: "copi_coauthor" }, { id: "name_rare" }])).toBe(true);
    expect(isCoauthorshipOnly([{ id: "name_rare" }])).toBe(false);
  });

  it("title-cases RePORTER names and finds the scholar by surname", () => {
    expect(reporterNameForDisplay("REYES-HART, DANIEL L.")).toBe("Daniel L. Reyes-Hart");
    expect(reporterNameForDisplay("PAT Q EXAMPLE")).toBe("Pat Q Example");
    expect(isScholarPi("EXAMPLE, PAT Q", "Example")).toBe(true);
    expect(isScholarPi("Pat Q Example", "Example")).toBe(true);
    expect(isScholarPi("SAMPLE, LEE", "Example")).toBe(false);
    expect(isScholarPi("EXAMPLE, PAT", null)).toBe(false);
  });

  it("marks only the RePORTER words the scholar's names have no match for", () => {
    const parts = (raw: string, names: string[]) =>
      reporterNameParts(raw, names).map((p) => (p.differs ? `[${p.text}]` : p.text)).join(" ");
    expect(parts("EXAMPLE, PAT D", ["Pat Q. Example"])).toBe("Pat [D] Example");
    expect(parts("EXAMPLE, PAT Q", ["Example, Pat Quinn"])).toBe("Pat Q Example");
    expect(parts("REYES-HART, DANIEL", ["Daniel L. Reyes-Hart"])).toBe("Daniel Reyes-Hart");
    expect(parts("SAMPLE, LEE", ["Pat Example"])).toBe("[Lee] [Sample]");
    // An initial matches a given name only, never the surname.
    expect(parts("EXAMPLE, PAT E", ["Pat Example"])).toBe("Pat [E] Example");
    // Each half of a hyphenated surname must match.
    expect(parts("REYES-COLE, DANIEL", ["Daniel Reyes-Hart"])).toBe("Daniel [Reyes-Cole]");
  });

  it("gives the deciding reason for each band", () => {
    const cues = [
      { id: "profile_proven", weight: 3, reason: "proven" },
      { id: "middle_initial_conflict", weight: -1, reason: "initial" },
    ];
    expect(decidingReason("show", cues)).toBe("proven");
    expect(decidingReason("hide", cues)).toBe("initial");
    expect(decidingReason("hide", [])).toMatch(/Nothing ties it/);
    expect(decidingReason("queue", cues)).toMatch(/weak or points both ways/);
  });
});

describe("the review", () => {
  it("shows the focused award beside the list, with every cue and the scholar marked", () => {
    queue();
    expect(within(screen.getByTestId("grant-attribution-list")).getByText("Pat Example, MD")).toBeTruthy();
    expect(detail().getByText("A synthetic study")).toBeTruthy();
    expect(detail().getByText("Pat Q Example").tagName).toBe("MARK");
    expect(detail().getByTestId("grant-attribution-cue-prior_institution").textContent).toContain("✓");
    expect(detail().getByTestId("grant-attribution-cue-middle_initial_conflict").textContent).toContain("✕");
    expect(detail().getByText(/middle initial differs from/)).toBeTruthy();
    expect(detail().getByText("Evidence points both ways")).toBeTruthy();
    expect(detail().getByText("RePORTER ↗").getAttribute("href")).toBe("https://reporter.nih.gov/project-details/123");
    expect(detail().getByText("Confirm")).toBeTruthy();
  });

  it("names the co-author co-PI and lists the shared papers", () => {
    queue(false, [COAUTHOR]);
    expect(detail().getByText("Lee Sample, a co-PI on this award, co-authored 5 of the scholar's papers.")).toBeTruthy();
    expect(detail().getByText("co-author")).toBeTruthy();
    expect(detail().getByText(/A shared synthetic paper/).closest("a")?.getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/111/",
    );
    expect(detail().getByText("+ 4 more")).toBeTruthy();
  });

  it("lists the rejected papers under their cue, by PubMed title or by PMID", () => {
    const rejected: GrantAttributionItem = {
      ...ITEM,
      cues: [
        {
          id: "rejected_pmids",
          weight: -4,
          reason: "2 of the 16 papers RePORTER links to this award were rejected in ReCiter as not the scholar's",
          rejected: [
            { pmid: "333", title: "A rejected synthetic paper" },
            { pmid: "444", title: null },
          ],
        },
      ],
    };
    queue(false, [rejected]);
    const list = within(detail().getByTestId("grant-attribution-rejected-papers"));
    expect(list.getByText("A rejected synthetic paper").closest("a")?.getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/333/",
    );
    expect(list.getByText("· PMID 333")).toBeTruthy();
    expect(list.getByText("PMID 444").closest("a")?.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/444/");
  });

  it("offers no actions or selection to a read-only viewer", () => {
    queue(true);
    expect(screen.queryByText("Confirm")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // The page, not the queue, says it is read-only.
    expect(screen.queryByText(/Read-only/)).toBeNull();
  });

  it("Not this person asks for a reason and has no reasonless submit", () => {
    queue();
    fireEvent.click(detail().getByText("Not this person"));
    const box = within(screen.getByTestId("grant-attribution-reasons"));
    expect(box.getByText("A reason is required.")).toBeTruthy();
    expect(box.getByText("A different person with the same name")).toBeTruthy();
    expect(screen.queryByText("Hide as not this person")).toBeNull();
  });

  it("posts the picked reason with the rejection", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    queue();
    fireEvent.click(detail().getByText("Not this person"));
    await act(async () => {
      fireEvent.click(screen.getByText("Outside the scholar's career"));
    });
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      id: "rev-1",
      decision: "reject",
      reason: "Outside the scholar's career",
    });
    vi.unstubAllGlobals();
  });

  it("sorts strongest evidence first by default, and weakest first on request", () => {
    const strong: GrantAttributionItem = { ...COAUTHOR, id: "rev-3", score: 6, scholarName: "Strong Example" };
    // Level first, then score: this conflict (score 9) still follows both likelies.
    const conflict: GrantAttributionItem = { ...ITEM, score: 9 };
    const likely: GrantAttributionItem = { ...COAUTHOR, score: 1, scholarName: "Likely Example" };
    queue(false, [UNPROVEN, likely, conflict, strong]);
    const names = () =>
      [...screen.getByTestId("grant-attribution-list").querySelectorAll("[data-row] span.truncate.font-semibold")].map(
        (n) => n.textContent,
      );
    expect(names()).toEqual(["Strong Example", "Likely Example", "Pat Example, MD", "Lee Sample, PhD"]);
    fireEvent.change(screen.getByDisplayValue("Strongest evidence first"), { target: { value: "weak" } });
    expect(names()).toEqual(["Lee Sample, PhD", "Pat Example, MD", "Likely Example", "Strong Example"]);
  });

  it("decides an Unproven award by grant, and undoes it by the review the route opened", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          JSON.stringify(
            JSON.parse(init.body as string).grant ? { reviews: { "reporter:zzb0002:R21YY000002": "rev-new" } } : {},
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    queue(false, [UNPROVEN]);
    await act(async () => {
      fireEvent.click(detail().getByText("Confirm"));
    });
    const body = (i: number) => JSON.parse((fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body as string);
    expect(body(0)).toEqual({ grant: "reporter:zzb0002:R21YY000002", decision: "confirm" });
    await act(async () => {
      fireEvent.click(detail().getByText("Undo"));
    });
    expect(body(1)).toEqual({ id: "rev-new", decision: "undo" });
    vi.unstubAllGlobals();
  });

  it("decides reviews and Unproven awards together in one bulk call", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ reviews: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    queue(false, [ITEM, UNPROVEN]);
    for (const cb of screen.getAllByRole("checkbox").slice(-2)) fireEvent.click(cb);
    await act(async () => {
      fireEvent.click(screen.getByTestId("grant-attribution-bulk-confirm"));
    });
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      grants: ["reporter:zzb0002:R21YY000002"],
      ids: ["rev-1"],
      decision: "confirm",
    });
    vi.unstubAllGlobals();
  });

  it("filters by evidence and selects in bulk", () => {
    queue(false, [ITEM, COAUTHOR]);
    fireEvent.change(screen.getByLabelText(/Evidence/), { target: { value: "co" } });
    expect(screen.getByText(/Showing 1 of 2/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Evidence/), { target: { value: "all" } });
    fireEvent.click(screen.getByText("Select 1 co-authorship-only"));
    expect(screen.getByText("1 award selected")).toBeTruthy();
    expect((screen.getByTestId("grant-attribution-bulk-reject") as HTMLButtonElement).disabled).toBe(true);
  });

  it("links the profile at its canonical path", () => {
    queue(true);
    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/pat-example");
    expect(hrefs).not.toContain("/scholars/pat-example");
  });
});


