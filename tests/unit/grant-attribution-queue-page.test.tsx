/**
 * #3071 — the grant attribution queue page gate, its predicates, and the card.
 *
 *   - Predicates: decide = superuser || comms_steward; read = those plus
 *     observer and content editor; never the scholar or a unit admin. The tab
 *     predicate is the page gate (same function, I2 parity).
 *   - Page: no session → SSO redirect; flag off → 404 for everyone; a viewer
 *     who cannot read → ForbiddenEditPage; a reader gets the queue.
 *   - Card: scholar and award side by side, every cue with its reason, actions
 *     only for a decider.
 *
 * Fixture people and awards are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: vi.fn(),
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
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/edit/grant-attribution-queue.server", () => ({
  loadGrantAttributionQueue: h.load,
  countPendingGrantAttribution: vi.fn(),
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
  canDecideGrantAttribution,
  canViewGrantAttributionQueue,
  isGrantAttributionQueueReadOnly,
  type GrantAttributionItem,
} from "@/lib/edit/grant-attribution-queue";

const SUPER = { cwid: "zzs0001", isSuperuser: true };
const STEWARD = { cwid: "zzc0001", isSuperuser: false, isCommsSteward: true };
const OBSERVER = { cwid: "zzo0001", isSuperuser: false, isObserver: true };
const EDITOR = { cwid: "zze0001", isSuperuser: false, isContentEditor: true };
const SCHOLAR = { cwid: "zzn0001", isSuperuser: false };

const ITEM: GrantAttributionItem = {
  id: "rev-1",
  cwid: "zza0001",
  slug: "pat-example",
  scholarName: "Pat Example, MD",
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
    piNames: ["PAT Q EXAMPLE"],
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
    expect(isGrantAttributionQueueReadOnly(STEWARD)).toBe(false);
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
});

describe("the card", () => {
  it("puts scholar and award side by side and lists every cue with its reason", () => {
    render(<GrantAttributionQueue pending={[ITEM]} confirmed={[]} rejected={[]} readOnly={false} />);
    expect(screen.getByText("Pat Example, MD")).toBeTruthy();
    expect(screen.getByText("A synthetic study")).toBeTruthy();
    expect(screen.getByText("PI: PAT Q EXAMPLE")).toBeTruthy();
    expect(screen.getByTestId("grant-attribution-cue-prior_institution").className).toContain("green");
    expect(screen.getByTestId("grant-attribution-cue-middle_initial_conflict").className).toContain("red");
    expect(screen.getByText(/middle initial differs from/)).toBeTruthy();
    expect(screen.getByText("RePORTER ↗").getAttribute("href")).toBe("https://reporter.nih.gov/project-details/123");
    expect(screen.getByText("Confirm")).toBeTruthy();
  });

  it("offers no actions to a read-only viewer", () => {
    render(<GrantAttributionQueue pending={[ITEM]} confirmed={[]} rejected={[]} readOnly />);
    expect(screen.queryByText("Confirm")).toBeNull();
    expect(screen.queryByText("Not this person")).toBeTruthy(); // the tab label only
  });

  it("Not this person opens the reason choices first", () => {
    render(<GrantAttributionQueue pending={[ITEM]} confirmed={[]} rejected={[]} readOnly={false} />);
    fireEvent.click(screen.getAllByText("Not this person").at(-1)!);
    expect(screen.getByText("Hide as not this person")).toBeTruthy();
    expect(screen.getByLabelText("Rejection reason")).toBeTruthy();
  });
});
