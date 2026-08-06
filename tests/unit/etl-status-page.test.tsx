/**
 * `/edit/etl-status` — the superuser-only ETL status board.
 *
 * Two layers, both here on purpose:
 *  1. `toSourceRow` / `loadEtlStatus`, pure — the six states and their
 *     precedence, and the freshness anchor. These need no DOM and no clock.
 *  2. the page itself, driven through the REAL loader against a fake Prisma
 *     client, so an anchoring or gating regression fails here rather than in
 *     prod. `@/lib/db` is mocked, so nothing constructs a connection.
 *
 * The three regressions this file exists to catch:
 *  - the "Never ran" row silently disappearing (it is the ONLY thing that
 *    separates "the chain aborted before this step" from "not deployed here");
 *  - an acknowledged staleness rendering as green or red instead of its own
 *    state;
 *  - freshness drifting back onto `completedAt` and letting a frozen artifact
 *    read as fresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const {
  mockSession,
  mockDenial,
  mockFindFirst,
  mockRedirect,
  mockPendingHonors,
  mockHonorsTabVisible,
} = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockDenial: vi.fn(),
  mockFindFirst: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  mockPendingHonors: vi.fn(),
  mockHonorsTabVisible: vi.fn(() => false),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockDenial }));
vi.mock("@/lib/edit/slug-request", () => ({
  countPendingSlugRequests: vi.fn(),
  isSlugRequestEnabled: () => false,
}));
vi.mock("@/lib/edit/honor-queue", () => ({
  countPendingHonors: mockPendingHonors,
  isHonorsQueueTabVisible: mockHonorsTabVisible,
}));
vi.mock("@/lib/db", () => ({ db: { read: { etlRun: { findFirst: mockFindFirst } } } }));
// The shell mounts the account menu (a client island that probes
// /api/auth/session) and the whole tab strip; the page owns only its body.
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({
  ForbiddenEditPage: () => <div data-testid="forbidden" />,
}));

import Page from "@/app/edit/etl-status/page";
import {
  type EtlAttemptRow,
  type EtlStatusClient,
  type EtlSuccessRow,
  RUNNING_TIMEOUT_HOURS,
  loadEtlStatus,
  needsAttention,
  toSourceRow,
} from "@/lib/api/etl-status";
import { TRACKED, type TrackedSpec } from "@/lib/etl/freshness-policy";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A fixed instant so nothing in this file can start failing on a calendar day. */
const NOW = Date.parse("2026-08-06T12:00:00Z");

type Fixture = { success?: EtlSuccessRow | null; attempt?: EtlAttemptRow | null };
let fixtures: Record<string, Fixture> = {};

const success = (anchor: EtlSuccessRow, at = anchor.completedAt): Fixture => ({
  success: anchor,
  attempt: {
    status: "success",
    startedAt: at ?? new Date(NOW),
    completedAt: at,
    errorMessage: null,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // The env var the APP task def actually carries (cdk/lib/app-stack.ts).
  // SCHOLARS_ENV lives on the ETL task defs only, so stubbing that one here
  // would let a page that reads the wrong variable in prod stay green.
  vi.stubEnv("SPS_ENV", "prod");
  fixtures = {};
  // clearAllMocks() clears CALLS, not implementations — re-assert the default
  // shape of the honors gate so a per-test override cannot leak sideways.
  mockHonorsTabVisible.mockReturnValue(false);
  mockPendingHonors.mockResolvedValue(0);
  mockSession.mockResolvedValue({ cwid: "edt1", isSuperuser: true, isCommsSteward: false });
  mockFindFirst.mockImplementation((args: { where: { source: string; status?: string } }) => {
    const f = fixtures[args.where.source];
    // The loader issues exactly two shapes: the newest SUCCESS, and the newest
    // attempt of any outcome.
    return Promise.resolve(
      args.where.status === "success" ? (f?.success ?? null) : (f?.attempt ?? null),
    );
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Every source this env is responsible for — InfoEd is prod-only. */
const expectedSources = () =>
  Object.entries(TRACKED)
    .filter(([, spec]) => spec.envs === undefined || spec.envs.includes("prod"))
    .map(([source]) => source);

const nightly: TrackedSpec = { cadence: "nightly" };
/** Hierarchy's real cadence — one of the two genuinely manifest-anchored sources. */
const annual: TrackedSpec = { cadence: "annual" };

/** The loader needs exactly one Prisma model, so the fake is one method. */
const fakeClient = () => ({ etlRun: { findFirst: mockFindFirst } }) as unknown as EtlStatusClient;

describe("etl-status state mapping", () => {
  it("grades a recent success as up to date and an old one as late", () => {
    const fresh = toSourceRow(
      "ED",
      nightly,
      { completedAt: new Date(NOW - 2 * HOUR), manifestGeneratedAt: null },
      {
        status: "success",
        startedAt: new Date(NOW - 3 * HOUR),
        completedAt: new Date(NOW - 2 * HOUR),
        errorMessage: null,
      },
      NOW,
    );
    expect(fresh.state).toBe("up-to-date");
    // The nightly ceiling is 30h, so 2 days of silence is past it.
    const old = toSourceRow(
      "ED",
      nightly,
      { completedAt: new Date(NOW - 2 * DAY), manifestGeneratedAt: null },
      {
        status: "success",
        startedAt: new Date(NOW - 2 * DAY),
        completedAt: new Date(NOW - 2 * DAY),
        errorMessage: null,
      },
      NOW,
    );
    expect(old.state).toBe("late");
  });

  // 🔴 The single most important rule on this page. The Spotlight and Hierarchy
  // loaders write a fresh SUCCESS row when the artifact's sha256 is unchanged, so
  // `completedAt` advances while the data underneath is frozen. Anchoring on
  // completedAt would paint a dead producer green. Those two are also the ONLY
  // sources that write `manifestGeneratedAt` (`grep -rn manifestGeneratedAt etl/`)
  // — Tools short-circuits identically but stays completedAt-anchored on purpose,
  // so a Tools fixture with a manifest timestamp would test a row production
  // cannot produce.
  it("anchors freshness on the producer's manifest timestamp, not the row's completion time", () => {
    const row = toSourceRow(
      "Hierarchy",
      annual,
      // Finished an hour ago; the artifact it re-read is well past the annual ceiling.
      { completedAt: new Date(NOW - 1 * HOUR), manifestGeneratedAt: new Date(NOW - 500 * DAY) },
      {
        status: "success",
        startedAt: new Date(NOW - 2 * HOUR),
        completedAt: new Date(NOW - 1 * HOUR),
        errorMessage: null,
      },
      NOW,
    );
    expect(row.state).toBe("late");
    expect(row.lastSuccessAt).toEqual(new Date(NOW - 500 * DAY));
  });

  it("falls back to completedAt for a source with no manifest", () => {
    const row = toSourceRow(
      "ED",
      nightly,
      { completedAt: new Date(NOW - 4 * HOUR), manifestGeneratedAt: null },
      null,
      NOW,
    );
    expect(row.lastSuccessAt).toEqual(new Date(NOW - 4 * HOUR));
    expect(row.state).toBe("up-to-date");
  });

  it("reports a source with no row at all as never ran", () => {
    expect(toSourceRow("ED", nightly, null, null, NOW).state).toBe("never-ran");
  });

  it("carries the error text and the timestamp for a failed attempt", () => {
    const row = toSourceRow(
      "ASMS",
      nightly,
      { completedAt: new Date(NOW - 26 * HOUR), manifestGeneratedAt: null },
      {
        status: "failed",
        startedAt: new Date(NOW - 3 * HOUR),
        completedAt: new Date(NOW - 2 * HOUR),
        errorMessage: "connect ETIMEDOUT",
      },
      NOW,
    );
    // A fresh-enough last SUCCESS must not mask the failure that came after it —
    // freshness alone ignores failed rows entirely, which is the gap this closes.
    expect(row.state).toBe("failed");
    expect(row.errorMessage).toBe("connect ETIMEDOUT");
    expect(row.lastAttemptEndedAt).toEqual(new Date(NOW - 2 * HOUR));
  });

  it("calls a `running` row older than the task timeout stopped, and a younger one nothing", () => {
    const at = (hoursAgo: number): EtlAttemptRow => ({
      status: "running",
      startedAt: new Date(NOW - hoursAgo * HOUR),
      completedAt: null,
      errorMessage: null,
    });
    const fresh: EtlSuccessRow = {
      completedAt: new Date(NOW - 2 * HOUR),
      manifestGeneratedAt: null,
    };
    expect(toSourceRow("ED", nightly, fresh, at(RUNNING_TIMEOUT_HOURS + 1), NOW).state).toBe(
      "stopped",
    );
    // Still inside its cap: genuinely in flight, and the data is fresh.
    expect(toSourceRow("ED", nightly, fresh, at(1), NOW).state).toBe("up-to-date");
  });

  it("gives an ACKNOWLEDGED staleness its own state — never up to date, never late", () => {
    const spec: TrackedSpec = {
      cadence: "monthly",
      ack: { until: "2026-12-31", reason: "producer not deployed" },
    };
    const acked = toSourceRow(
      "Spotlight",
      spec,
      { completedAt: new Date(NOW - 60 * DAY), manifestGeneratedAt: new Date(NOW - 60 * DAY) },
      {
        status: "success",
        startedAt: new Date(NOW - 1 * HOUR),
        completedAt: new Date(NOW - 1 * HOUR),
        errorMessage: null,
      },
      NOW,
    );
    expect(acked.state).toBe("known-issue");
    expect(acked.ack?.until).toBe("2026-12-31");
    expect(acked.ackExpired).toBe(false);
  });

  it("stops acknowledging once the date passes — the expiry IS the safety property", () => {
    const spec: TrackedSpec = {
      cadence: "monthly",
      ack: { until: "2026-01-01", reason: "producer not deployed" },
    };
    const row = toSourceRow(
      "Spotlight",
      spec,
      { completedAt: new Date(NOW - 60 * DAY), manifestGeneratedAt: new Date(NOW - 60 * DAY) },
      null,
      NOW,
    );
    expect(row.state).toBe("late");
    expect(row.ackExpired).toBe(true);
  });

  // An acked source with NO row at all: the missing row wins the state (nothing
  // on record is a real gap, not an accepted staleness), but losing the ack there
  // is how the page ends up red, counted, and silent about the one fact that
  // explains it — that somebody already decided to live with this.
  it("keeps a never-ran source red but still carries its live acknowledgement", () => {
    const spec: TrackedSpec = {
      cadence: "monthly",
      ack: { until: "2026-12-31", reason: "producer not deployed" },
    };
    const row = toSourceRow("Spotlight", spec, null, null, NOW);
    expect(row.state).toBe("never-ran");
    expect(row.ackActive).toBe(true);
    expect(row.ack?.reason).toBe("producer not deployed");
    // …and it is not one of the rows an operator is being asked to chase.
    expect(needsAttention(row)).toBe(false);
  });

  it("still counts a crash and a vanished task even under a live ack", () => {
    const spec: TrackedSpec = {
      cadence: "monthly",
      ack: { until: "2026-12-31", reason: "producer not deployed" },
    };
    const stale: EtlSuccessRow = {
      completedAt: new Date(NOW - 60 * DAY),
      manifestGeneratedAt: new Date(NOW - 60 * DAY),
    };
    const failed = toSourceRow(
      "Spotlight",
      spec,
      stale,
      {
        status: "failed",
        startedAt: new Date(NOW - 2 * HOUR),
        completedAt: new Date(NOW - HOUR),
        errorMessage: "S3 403",
      },
      NOW,
    );
    expect(needsAttention(failed)).toBe(true);
    const stopped = toSourceRow(
      "Spotlight",
      spec,
      stale,
      {
        status: "running",
        startedAt: new Date(NOW - (RUNNING_TIMEOUT_HOURS + 1) * HOUR),
        completedAt: null,
        errorMessage: null,
      },
      NOW,
    );
    expect(needsAttention(stopped)).toBe(true);
  });

  it("does not let an acknowledgement swallow a crash", () => {
    const spec: TrackedSpec = {
      cadence: "monthly",
      ack: { until: "2026-12-31", reason: "producer not deployed" },
    };
    const row = toSourceRow(
      "Spotlight",
      spec,
      { completedAt: new Date(NOW - 60 * DAY), manifestGeneratedAt: new Date(NOW - 60 * DAY) },
      {
        status: "failed",
        startedAt: new Date(NOW - 2 * HOUR),
        completedAt: new Date(NOW - 1 * HOUR),
        errorMessage: "S3 403",
      },
      NOW,
    );
    expect(row.state).toBe("failed");
  });
});

describe("loadEtlStatus", () => {
  it("returns a row for EVERY expected source, including ones with no etl_run row", async () => {
    fixtures = {
      ED: success({ completedAt: new Date(NOW - 2 * HOUR), manifestGeneratedAt: null }),
    };
    const summary = await loadEtlStatus(fakeClient(), new Date(NOW), "prod");
    expect(summary.sources.map((s) => s.source).sort()).toEqual(expectedSources().sort());
    expect(summary.sources.find((s) => s.source === "ED")?.state).toBe("up-to-date");
    expect(summary.sources.find((s) => s.source === "Hierarchy")?.state).toBe("never-ran");
    // An acknowledged source is NOT counted as needing attention — that is the
    // decision the ack records — whether its ack shows up as the "known issue"
    // state or is outranked by a rowless "never ran". Only ED is current here,
    // so the count is everything else minus whatever is live-acked.
    const liveAcked = summary.sources.filter((s) => s.ackActive).length;
    expect(summary.needsAttention).toBe(summary.sources.length - 1 - liveAcked);
  });

  // 🔴 The deployed page calls loadEtlStatus with NO env argument, so the DEFAULT
  // is the only code path prod ever takes. `SCHOLARS_ENV` is set on the ETL task
  // defs (cdk/lib/etl-stack.ts) and NOWHERE on the app task def, which carries
  // `SPS_ENV` (cdk/lib/app-stack.ts). Defaulting to the ETL variable left `env`
  // undefined in the running app, so every env-scoped source was filtered out —
  // dropping InfoEd, the prod-only import whose failure this page was built for.
  it("defaults to the env var the APP task def carries, so prod keeps its prod-only sources", async () => {
    vi.stubEnv("SCHOLARS_ENV", undefined);
    vi.stubEnv("SPS_ENV", "prod");
    const summary = await loadEtlStatus(fakeClient(), new Date(NOW));
    expect(summary.sources.map((s) => s.source)).toContain("InfoEd");
  });

  it("skips a source scoped to another env rather than reporting it missing", async () => {
    const staging = await loadEtlStatus(fakeClient(), new Date(NOW), "staging");
    // InfoEd is excluded from the staging nightly; showing "never ran" there
    // would send a superuser chasing an import that is not supposed to exist.
    expect(staging.sources.some((s) => s.source === "InfoEd")).toBe(false);
    expect(TRACKED.InfoEd?.envs).toEqual(["prod"]);
  });

  it("sorts problems to the top", async () => {
    fixtures = {
      ED: {
        success: { completedAt: new Date(NOW - 2 * HOUR), manifestGeneratedAt: null },
        attempt: {
          status: "failed",
          startedAt: new Date(NOW - 1 * HOUR),
          completedAt: new Date(NOW - 30 * 60 * 1000),
          errorMessage: "boom",
        },
      },
    };
    const summary = await loadEtlStatus(fakeClient(), new Date(NOW), "prod");
    expect(summary.sources[0].source).toBe("ED");
    expect(summary.sources[0].state).toBe("failed");
  });
});

describe("/edit/etl-status page", () => {
  it("sends a signed-out visitor to SAML login", async () => {
    mockSession.mockResolvedValue(null);
    await expect(Page()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("shows the forbidden page to a non-superuser and never reads etl_run", async () => {
    mockSession.mockResolvedValue({ cwid: "sch1", isSuperuser: false, isCommsSteward: true });
    render(await Page());
    expect(screen.getByTestId("forbidden")).toBeTruthy();
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockDenial).toHaveBeenCalledOnce();
  });

  it("renders a real row for every expected source — a source that never ran is not a blank", async () => {
    const { container } = render(await Page());
    const rows = container.querySelectorAll("[data-testid^='etl-status-row-']");
    expect(rows.length).toBe(expectedSources().length);
    // Nothing in `fixtures`, so every source has no etl_run row at all.
    const hierarchy = screen.getByTestId("etl-status-row-Hierarchy");
    expect(hierarchy.getAttribute("data-state")).toBe("never-ran");
    expect(hierarchy.textContent).toContain("Never ran");
  });

  // Hierarchy, not Tools: Hierarchy is one of the two loaders that actually
  // writes `manifestGeneratedAt` (the other is Spotlight, which carries an ack
  // and so grades to "known issue" here). Tools is completedAt-anchored by
  // design, so a Tools fixture would assert on a row prod cannot emit.
  it("paints a frozen artifact as late even though the import finished minutes ago", async () => {
    fixtures = {
      Hierarchy: {
        success: {
          completedAt: new Date(NOW - 5 * 60 * 1000),
          manifestGeneratedAt: new Date(NOW - 500 * DAY),
        },
        attempt: {
          status: "success",
          startedAt: new Date(NOW - 10 * 60 * 1000),
          completedAt: new Date(NOW - 5 * 60 * 1000),
          errorMessage: null,
        },
      },
      ED: success({ completedAt: new Date(NOW - 2 * HOUR), manifestGeneratedAt: null }),
    };
    render(await Page());
    const frozen = screen.getByTestId("etl-status-row-Hierarchy");
    expect(frozen.getAttribute("data-state")).toBe("late");
    expect(frozen.textContent).toContain("Late");
    // The control: a source with no manifest and a fresh completion is green,
    // so the assertion above is about the anchor and not about the whole page.
    expect(screen.getByTestId("etl-status-row-ED").getAttribute("data-state")).toBe("up-to-date");
  });

  it("renders a live acknowledgement as its own state, neither green nor red", async () => {
    const acked = Object.entries(TRACKED).find(([, s]) => s.ack !== undefined);
    // If the last ack is ever removed, this must be a deliberate act — the same
    // posture tests/unit/freshness-sla.test.ts already takes on Spotlight.
    expect(acked?.[1].ack, "no source carries an ack any more").toBeDefined();
    const [source, spec] = acked!;
    const ack = spec.ack!;
    const until = Date.parse(ack.until);
    vi.setSystemTime(until - DAY);
    fixtures = {
      [source]: {
        success: {
          completedAt: new Date(until - DAY - 60 * DAY),
          manifestGeneratedAt: new Date(until - DAY - 60 * DAY),
        },
        attempt: {
          status: "success",
          startedAt: new Date(until - DAY - HOUR),
          completedAt: new Date(until - DAY - HOUR),
          errorMessage: null,
        },
      },
    };
    render(await Page());
    const row = screen.getByTestId(`etl-status-row-${source}`);
    expect(row.getAttribute("data-state")).toBe("known-issue");
    expect(row.textContent).toContain("Known issue");
    // Not the green state and not either red one.
    expect(row.textContent).not.toContain("Up to date");
    expect(row.textContent).not.toContain("Failed");
    expect(row.textContent).toContain(ack.until);
    // The COLOUR, not just the word: a status board that paints an accepted
    // staleness green lies, and one that paints it red cries wolf nightly. The
    // label alone would survive a repaint, so pin the palette too.
    const pill = row.querySelector("[data-testid='etl-status-pill']");
    expect(pill?.className).not.toMatch(/emerald|green|red/);
    // …and it is not counted against the operator.
    expect(screen.getByTestId("etl-status-headline").textContent).not.toContain("Known issue");
  });

  it("shows the error text and when it happened for a failed import", async () => {
    fixtures = {
      ASMS: {
        success: { completedAt: new Date(NOW - 26 * HOUR), manifestGeneratedAt: null },
        attempt: {
          status: "failed",
          startedAt: new Date(NOW - 3 * HOUR),
          completedAt: new Date(NOW - 2 * HOUR),
          errorMessage: "connect ETIMEDOUT",
        },
      },
    };
    render(await Page());
    const row = screen.getByTestId("etl-status-row-ASMS");
    expect(row.getAttribute("data-state")).toBe("failed");
    expect(row.textContent).toContain("connect ETIMEDOUT");
    expect(row.textContent).toContain("The last attempt failed on");
  });

  it("calls out a run that started and never reported back", async () => {
    fixtures = {
      ReCiter: {
        success: { completedAt: new Date(NOW - 2 * HOUR), manifestGeneratedAt: null },
        attempt: {
          status: "running",
          startedAt: new Date(NOW - (RUNNING_TIMEOUT_HOURS + 2) * HOUR),
          completedAt: null,
          errorMessage: null,
        },
      },
    };
    render(await Page());
    const row = screen.getByTestId("etl-status-row-ReCiter");
    expect(row.getAttribute("data-state")).toBe("stopped");
    expect(row.textContent).toContain("Stopped unexpectedly");
  });

  it("names whoever accepted a never-ran source, and stops counting it against the operator", async () => {
    const acked = Object.entries(TRACKED).find(([, s]) => s.ack !== undefined);
    expect(acked?.[1].ack, "no source carries an ack any more").toBeDefined();
    const [source, spec] = acked!;
    const ack = spec.ack!;
    vi.setSystemTime(Date.parse(ack.until) - DAY);
    // `fixtures` stays empty, so EVERY source — the acked one included — has no
    // etl_run row at all. Precedence keeps it red; the ack has to be visible
    // anyway, or the page sends someone chasing an already-accepted gap.
    render(await Page());
    const row = screen.getByTestId(`etl-status-row-${source}`);
    expect(row.getAttribute("data-state")).toBe("never-ran");
    expect(row.textContent).toContain(ack.until);
    expect(row.textContent).toContain(ack.reason);
    // Every other source is never-ran too, so this one is the single exclusion.
    const total = expectedSources().length;
    expect(screen.getByTestId("etl-status-headline").textContent).toContain(
      `${total - 1} of ${total} imports need attention`,
    );
  });

  it("keeps the copy free of internal jargon", async () => {
    fixtures = {
      ED: success({ completedAt: new Date(NOW - 2 * HOUR), manifestGeneratedAt: null }),
    };
    // The WHOLE rendered page, not just the table: the heading and the notices
    // around it are copy a superuser reads too, and a table-only guard cannot
    // see a word that leaks into them.
    const { container } = render(await Page());
    const text = container.textContent ?? "";
    for (const jargon of ["DegradedRun", "SLA", "manifestSha256", "manifestGeneratedAt", "etl_run"])
      expect(text, `"${jargon}" leaked into the page copy`).not.toContain(jargon);
  });

  // The badge counts hit the SAME database as etl_run. Read outside the try, a
  // DB outage 500s the page instead of rendering the notice below — on exactly
  // the page an operator opens when the database is unhappy.
  // A badge is decoration; the board is the point. Losing the former must not
  // take the latter with it — this page's whole job is to still work when the
  // database is unhappy.
  it("still renders the board when only a tab-badge count fails", async () => {
    mockHonorsTabVisible.mockReturnValue(true);
    mockPendingHonors.mockRejectedValue(new Error("SELECT command denied"));
    const { container } = render(await Page());
    expect(container.querySelector("[data-testid='etl-status-unavailable']")).toBeNull();
    expect(screen.getByTestId("etl-status-table")).toBeTruthy();
  });

  it("falls soft to an unavailable notice when etl_run cannot be read", async () => {
    mockFindFirst.mockRejectedValue(new Error("SELECT command denied"));
    const { container } = render(await Page());
    expect(screen.getByTestId("etl-status-unavailable")).toBeTruthy();
    expect(container.querySelector("[data-testid='etl-status-table']")).toBeNull();
  });
});
