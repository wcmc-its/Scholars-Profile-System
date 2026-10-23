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
  shell: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`__REDIRECT__ ${to}`);
  }),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("next/navigation", () => ({ notFound: h.notFound, redirect: h.redirect }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.session,
  impersonationActive: h.impersonating,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.rawSession }));
vi.mock("@/lib/edit/grant-attribution-queue.server", () => ({
  loadGrantAttributionQueue: h.load,
  countPendingGrantAttribution: vi.fn(),
  countGrantAttribution: vi.fn(async (_c: unknown, status: string) => (status === "confirmed" ? 321 : 7)),
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
  canViewGrantAttributionQueue,
  isGrantAttributionQueueReadOnly,
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
    await expect(GrantAttributionQueuePage()).rejects.toThrow("__REDIRECT__");
  });

  it("404s for everyone when the flag is off", async () => {
    vi.stubEnv("GRANT_ATTRIBUTION_QUEUE", "off");
    h.session.mockResolvedValue(SUPER);
    await expect(GrantAttributionQueuePage()).rejects.toThrow("__NOT_FOUND__");
    expect(h.load).not.toHaveBeenCalled();
  });

  it("shows a non-reader the forbidden page and loads nothing", async () => {
    h.session.mockResolvedValue(SCHOLAR);
    await GrantAttributionQueuePage();
    expect(h.load).not.toHaveBeenCalled();
  });

  it("loads all three buckets for a reader and hands the shell the pending count", async () => {
    h.session.mockResolvedValue(OBSERVER);
    h.load.mockImplementation(async (_c: unknown, status: string) => (status === "pending" ? [ITEM] : []));
    const el = (await GrantAttributionQueuePage()) as { props: Record<string, unknown> };
    expect(h.load.mock.calls.map((c) => c[1]).sort()).toEqual(["confirmed", "pending", "rejected"]);
    expect(el.props.pendingGrantAttribution).toBe(1);
  });

  it("passes read-only to observers and content editors (synthetic steward), and under View as", async () => {
    const queueProps = (el: { props: { children: unknown } }) => {
      const kids = el.props.children as Array<{ props: Record<string, unknown> }>;
      return kids[kids.length - 1]!.props;
    };
    for (const s of [OBSERVER, EDITOR]) {
      h.session.mockResolvedValue(s);
      expect(queueProps((await GrantAttributionQueuePage()) as never).readOnly).toBe(true);
    }
    h.session.mockResolvedValue(STEWARD);
    expect(queueProps((await GrantAttributionQueuePage()) as never).readOnly).toBe(false);
    h.session.mockResolvedValue(SUPER);
    h.impersonating.mockReturnValue(true);
    const props = queueProps((await GrantAttributionQueuePage()) as never);
    expect(props.readOnly).toBe(true);
    // The decided pills carry the full counts, not the capped list lengths.
    expect(props.confirmedTotal).toBe(321);
    expect(props.rejectedTotal).toBe(7);
  });
});

const COAUTHOR: GrantAttributionItem = {
  ...ITEM,
  id: "rev-2",
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

const queue = (readOnly = false, pending = [ITEM]) =>
  render(<GrantAttributionQueue pending={pending} confirmed={[]} rejected={[]} readOnly={readOnly} />);
const detail = () => within(screen.getByTestId("grant-attribution-detail"));

describe("helpers", () => {
  it("levels: a strong negative rules out, both sides conflict, a link or two cues is high", () => {
    expect(attributionLevel([{ id: "timeline_impossible", weight: -5 }, { id: "pub_linked", weight: 4 }])).toEqual({
      level: "out",
      veto: "timeline_impossible",
    });
    expect(attributionLevel([{ id: "prior_institution", weight: 2 }, { id: "middle_initial_conflict", weight: -1 }]).level).toBe("conflict");
    expect(attributionLevel([{ id: "pub_linked", weight: 4 }]).level).toBe("high");
    expect(attributionLevel([{ id: "copi_coauthor", weight: 2 }, { id: "topic_match", weight: 1 }]).level).toBe("high");
    expect(attributionLevel([{ id: "copi_coauthor", weight: 2 }]).level).toBe("likely");
    expect(attributionLevel([]).level).toBe("unclear");
  });

  it("co-authorship-only is co-PI and topic cues and nothing else", () => {
    expect(isCoauthorshipOnly([{ id: "copi_coauthor" }, { id: "topic_match" }])).toBe(true);
    expect(isCoauthorshipOnly([{ id: "copi_coauthor" }, { id: "wcm_org" }])).toBe(false);
    expect(isCoauthorshipOnly([])).toBe(false);
  });

  it("title-cases RePORTER names and finds the scholar by surname", () => {
    expect(reporterNameForDisplay("REYES-HART, DANIEL L.")).toBe("Daniel L. Reyes-Hart");
    expect(reporterNameForDisplay("PAT Q EXAMPLE")).toBe("Pat Q Example");
    expect(isScholarPi("EXAMPLE, PAT Q", "Example")).toBe(true);
    expect(isScholarPi("Pat Q Example", "Example")).toBe(true);
    expect(isScholarPi("SAMPLE, LEE", "Example")).toBe(false);
    expect(isScholarPi("EXAMPLE, PAT", null)).toBe(false);
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

  it("offers no actions or selection to a read-only viewer", () => {
    queue(true);
    expect(screen.queryByText("Confirm")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeTruthy();
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
