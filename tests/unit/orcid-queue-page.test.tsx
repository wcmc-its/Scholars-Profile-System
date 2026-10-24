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
 *
 * Fixture people and iDs are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  rawSession: vi.fn(),
  load: vi.fn(),
  shell: vi.fn(),
  refresh: vi.fn(),
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
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.session,
  impersonationActive: vi.fn(() => false),
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.rawSession }));
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
  isOrcidQueueTabVisible,
  pairState,
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
  rows: [],
  counts: EMPTY_COUNTS,
  sample: null,
  remaining: null,
  ...over,
});
const ROW: OrcidQueueRow = {
  cwid: "jd0001",
  orcid: ORCID,
  slug: "jane-doe",
  name: "Jane Doe, MD",
  title: "Professor of Medicine",
  department: "Medicine",
  band: "strong",
  instMatch: true,
  emailVerified: false,
  nameAgrees: true,
  shared: 7,
  competitor: false,
  competitors: [],
  competitorOrcids: [],
  worksTotal: 12,
  newWorks: 2,
  newWorksSample: [
    { title: "A synthetic study", year: 2025, doi: null, pmid: null, source: "Crossref" },
  ],
  onFileOrcid: null,
  autoConfirmed: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ORCID_LIBRARIAN_QUEUE", "on");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.load.mockResolvedValue(data());
  h.rawSession.mockResolvedValue({ cwid: "lib0001" });
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
    render(await OrcidQueuePage({ searchParams: Promise.resolve({ tab: "conflicts" }) }));
    expect(h.load).toHaveBeenCalledWith({}, "conflicts");
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

  // The page test mocks the loader; these cases run the real one.
  const realLoad: typeof import("@/lib/edit/orcid-queue.server").loadOrcidQueue = async (c, t) =>
    (
      await vi.importActual<typeof import("@/lib/edit/orcid-queue.server")>(
        "@/lib/edit/orcid-queue.server",
      )
    ).loadOrcidQueue(c, t);

  const client = (
    opts: {
      sample?: Array<{ cwid: string; orcid: string; decision: string | null }>;
      admins?: Array<{ cwid: string; orcid: string }>;
      rescored?: boolean;
    } = {},
  ) => {
    const evidence = [
      { cwid: "a00001", orcid: ORCID, band: "strong" },
      { cwid: "b00001", orcid: ORCID, band: "strong" }, // dismissed
      { cwid: "c00001", orcid: ORCID, band: "strong" }, // holds a different iD
      { cwid: "d00001", orcid: OTHER, band: "strong" },
    ];
    const held: Record<string, string | null> = {
      a00001: null,
      b00001: null,
      c00001: OTHER,
      d00001: null,
    };
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
                    emailVerified: false,
                    nameAgrees: true,
                    shared: 4,
                    competitor: false,
                    competitorCwids: [],
                    competitorOrcids: [],
                    worksTotal: 5,
                    newWorks: 1,
                    newWorksSample: [],
                  }))
              : evidence,
        ),
        findFirst: vi.fn(async () => (opts.rescored ? { cwid: "a00001" } : null)),
      },
      orcidCandidate: { findMany: vi.fn(async () => opts.admins ?? []) },
      scholar: {
        findMany: vi.fn(
          async (args: { where: { orcidConfirmMethod?: string; cwid?: { in: string[] } } }) =>
            args.where.orcidConfirmMethod
              ? [{ cwid: "e00001", orcid: ORCID }]
              : (args.where.cwid?.in ?? []).map((c) => ({
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
        findFirst: vi.fn(async () => (opts.sample ? { id: "s1", startedAt: new Date(0) } : null)),
        findMany: vi.fn(async () => opts.sample ?? []),
      },
    } as never;
  };

  it("drops dismissed pairs, sends a held-different-iD scholar to Conflicts, counts every tab", async () => {
    const q = await realLoad(client(), "strong");
    expect(q.rows.map((r) => r.cwid).sort()).toEqual(["a00001", "d00001"]);
    expect(q.counts).toMatchObject({ strong: 2, conflicts: 1, email_verified: 1 });
    const c = await realLoad(client(), "conflicts");
    expect(c.rows).toEqual([expect.objectContaining({ cwid: "c00001", onFileOrcid: OTHER })]);
  });

  it("an rpm_admin iD is on file: that scholar's other candidate goes to Conflicts", async () => {
    const admins = [{ cwid: "a00001", orcid: OTHER }];
    const q = await realLoad(client({ admins }), "strong");
    expect(q.rows.map((r) => r.cwid)).toEqual(["d00001"]);
    const c = await realLoad(client({ admins }), "conflicts");
    expect(c.rows.map((r) => [r.cwid, r.onFileOrcid]).sort()).toEqual([
      ["a00001", OTHER],
      ["c00001", OTHER],
    ]);
  });

  it("a passed sample the ETL re-scored since is stale: no Confirm remaining", async () => {
    const sample = [{ cwid: "d00001", orcid: OTHER, decision: "confirmed" }];
    const fresh = await realLoad(client({ sample }), "strong");
    expect(fresh.sample).toMatchObject({ status: "passed" });
    expect(fresh.sample?.stale).toBeUndefined();
    expect(fresh.remaining).toBe(1);
    const stale = await realLoad(client({ sample, rescored: true }), "strong");
    expect(stale.sample).toMatchObject({ status: "passed", stale: true });
    expect(stale.remaining).toBeNull();
  });

  it("Email verified lists the ETL's confirmed iDs, as auto-confirmed", async () => {
    const q = await realLoad(client(), "email_verified");
    expect(q.rows).toEqual([expect.objectContaining({ cwid: "e00001", autoConfirmed: true })]);
  });

  it("an open sample's rows come first, with their decisions", async () => {
    const q = await realLoad(
      client({ sample: [{ cwid: "d00001", orcid: OTHER, decision: null }] }),
      "strong",
    );
    expect(q.sample).toMatchObject({ id: "s1", status: "open", total: 1 });
    expect(q.rows[0]).toMatchObject({ cwid: "d00001", sampleDecision: null });
  });
});

describe("client", () => {
  it("renders the evidence, the new-works sample and the two decisions", () => {
    render(
      <OrcidQueue
        data={data({ rows: [ROW], counts: { ...EMPTY_COUNTS, strong: 1 } })}
        basePath="/edit/orcid-queue"
        readOnly={false}
      />,
    );
    expect(screen.getByText("Jane Doe, MD").closest("a")?.getAttribute("href")).toBe("/jane-doe");
    expect(screen.getByText(ORCID).getAttribute("href")).toBe(`https://orcid.org/${ORCID}`);
    expect(screen.getByText("Institution on record")).toBeTruthy();
    expect(screen.getByText("Shared 7")).toBeTruthy();
    expect(screen.getByText("A synthetic study")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-confirm")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-dismiss")).toBeTruthy();
    expect(screen.getByTestId("orcid-queue-start-sample").textContent).toBe(
      "Review a sample of 50",
    );
  });

  it("read-only under View as: no controls", () => {
    render(<OrcidQueue data={data({ rows: [ROW] })} basePath="/edit/orcid-queue" readOnly />);
    expect(screen.queryByTestId("orcid-queue-confirm")).toBeNull();
    expect(screen.queryByTestId("orcid-queue-start-sample")).toBeNull();
  });

  it("a passed sample offers Confirm remaining N; a locked one says why and offers another sample", () => {
    const passed = {
      id: "s1",
      band: "strong" as const,
      startedAt: "",
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
          rows: [{ ...ROW, band: "email_verified", autoConfirmed: true, onFileOrcid: ORCID }],
        })}
        basePath="/edit/orcid-queue"
        readOnly={false}
      />,
    );
    expect(screen.getByText("Undo")).toBeTruthy();
    expect(screen.queryByTestId("orcid-queue-confirm")).toBeNull();
  });
});
