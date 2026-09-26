/**
 * The Titles queue's gate and nav count (`lib/edit/titles-queue.ts`), and the
 * page / export gating (`app/edit/titles-queue/page.tsx`,
 * `app/edit/titles-queue/export/route.ts`).
 *
 *   - `canReviewTitles` is exactly the display-title pin gate
 *     (`authorizeFieldEdit` on `primaryTitle`): superuser OR comms steward.
 *   - The page: no session → SSO redirect; anyone else → 404 (like News and
 *     Media highlights); a reviewer gets the queue with the exact Needs
 *     review count handed to the shell as the pill.
 *   - The export: no session → 401; anyone else → 404; a reviewer → .xlsx.
 *   - The count: memoized on success, NOT on failure (null, no throw), and
 *     dropped by `invalidateTitlesPendingCount`.
 *
 * Fixture people are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  load: vi.fn(),
  session: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`__REDIRECT__ ${to}`);
  }),
  shell: vi.fn(),
  workbook: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("next/navigation", () => ({ notFound: h.notFound, redirect: h.redirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/edit/title-dashboard", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/title-dashboard")>()),
  loadTitleDashboard: h.load,
}));
vi.mock("@/lib/edit/title-dashboard-xlsx", () => ({ buildTitleDashboardWorkbook: h.workbook }));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: (props: unknown) => {
    h.shell(props);
    return null;
  },
}));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn(),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn(),
}));

import TitlesQueuePage from "@/app/edit/titles-queue/page";
import { GET as exportTitles } from "@/app/edit/titles-queue/export/route";
import { authorizeFieldEdit } from "@/lib/edit/authz";
import {
  canReviewTitles,
  countTitlesNeedingReview,
  invalidateTitlesPendingCount,
  TITLES_PENDING_TTL_MS,
} from "@/lib/edit/titles-queue";
import type { TitleDashboardRow } from "@/lib/edit/title-dashboard";

const SUPER = { cwid: "zzs0001", isSuperuser: true, isCommsSteward: false };
const STEWARD = { cwid: "zzc0001", isSuperuser: false, isCommsSteward: true };
const NEITHER = { cwid: "zzn0001", isSuperuser: false, isCommsSteward: false };

/** Minimal rows: the tab is decided by `reasons` alone (`titleTabOf`). */
const row = (cwid: string, reasons: string[]) =>
  ({ cwid, name: cwid, reasons, pin: null, options: [] }) as unknown as TitleDashboardRow;
const ROWS = [
  row("zza0001", ["leadership", "mismatch"]),
  row("zza0002", ["leadership", "contested"]),
  row("zza0003", ["leadership", "pinned"]),
  row("zza0004", ["leadership"]),
];

beforeEach(() => {
  invalidateTitlesPendingCount();
  h.load.mockReset().mockResolvedValue(ROWS);
  h.session.mockReset();
  h.notFound.mockClear();
  h.redirect.mockClear();
  h.shell.mockClear();
  h.workbook.mockReset().mockResolvedValue(Buffer.from("xlsx"));
});

afterEach(() => vi.restoreAllMocks());

describe("canReviewTitles — the pin gate, exactly", () => {
  it("admits superuser and comms steward, nobody else", () => {
    expect(canReviewTitles(SUPER)).toBe(true);
    expect(canReviewTitles(STEWARD)).toBe(true);
    expect(canReviewTitles(NEITHER)).toBe(false);
  });

  it("agrees with authorizeFieldEdit on primaryTitle for every shape", () => {
    for (const s of [SUPER, STEWARD, NEITHER]) {
      const pin = authorizeFieldEdit(s as never, { entityId: "zzx0001", fieldName: "primaryTitle" });
      expect(canReviewTitles(s)).toBe(pin.ok);
    }
  });
});

describe("countTitlesNeedingReview", () => {
  it("counts the Needs review rows and reuses a success within the TTL", async () => {
    expect(await countTitlesNeedingReview({} as never, 1_000)).toBe(2);
    expect(await countTitlesNeedingReview({} as never, 1_000 + TITLES_PENDING_TTL_MS - 1)).toBe(2);
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(await countTitlesNeedingReview({} as never, 1_000 + TITLES_PENDING_TTL_MS)).toBe(2);
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("a failure is null, never a throw, and is not memoized", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.load.mockRejectedValueOnce(new Error("db down"));
    expect(await countTitlesNeedingReview({} as never, 5_000)).toBeNull();
    expect(await countTitlesNeedingReview({} as never, 5_001)).toBe(2);
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("invalidate drops the memo so the next read recounts", async () => {
    await countTitlesNeedingReview({} as never, 9_000);
    h.load.mockResolvedValue(ROWS.slice(1));
    invalidateTitlesPendingCount();
    expect(await countTitlesNeedingReview({} as never, 9_001)).toBe(1);
  });
});

describe("/edit/titles-queue page gate", () => {
  it("no session → SSO redirect back to the queue", async () => {
    h.session.mockResolvedValue(null);
    await expect(TitlesQueuePage({})).rejects.toThrow(
      "__REDIRECT__ /api/auth/saml/login?return=/edit/titles-queue",
    );
    expect(h.load).not.toHaveBeenCalled();
  });

  it("neither superuser nor comms steward → 404 before any data read", async () => {
    h.session.mockResolvedValue(NEITHER);
    await expect(TitlesQueuePage({})).rejects.toThrow("__NOT_FOUND__");
    expect(h.load).not.toHaveBeenCalled();
  });

  it.each([
    ["superuser", SUPER],
    ["comms steward", STEWARD],
  ])("%s → the queue, the shell active on titles-queue with the exact Needs review pill", async (_n, s) => {
    h.session.mockResolvedValue(s);
    const { render } = await import("@testing-library/react");
    render(await TitlesQueuePage({ searchParams: Promise.resolve({}) }));
    expect(h.notFound).not.toHaveBeenCalled();
    const props = h.shell.mock.calls.at(-1)![0] as { active: string; pendingTitles: number };
    expect(props.active).toBe("titles-queue");
    expect(props.pendingTitles).toBe(2);
    // The page's count seeds the memo the other console pages read.
    h.load.mockClear();
    expect(await countTitlesNeedingReview({} as never)).toBe(2);
    expect(h.load).not.toHaveBeenCalled();
  });
});

describe("/edit/titles-queue/export gate", () => {
  const req = (qs = "") => new Request(`http://localhost/edit/titles-queue/export${qs}`);

  it("no session → 401", async () => {
    h.session.mockResolvedValue(null);
    expect((await exportTitles(req())).status).toBe(401);
  });

  it("neither superuser nor comms steward → 404, nothing loaded", async () => {
    h.session.mockResolvedValue(NEITHER);
    expect((await exportTitles(req())).status).toBe(404);
    expect(h.load).not.toHaveBeenCalled();
  });

  it("a comms steward gets the filtered .xlsx", async () => {
    h.session.mockResolvedValue(STEWARD);
    const res = await exportTitles(req("?tab=review"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    const [rows, , total] = h.workbook.mock.calls[0]!;
    expect((rows as TitleDashboardRow[]).map((r) => r.cwid)).toEqual(["zza0001", "zza0002"]);
    expect(total).toBe(4);
  });
});
