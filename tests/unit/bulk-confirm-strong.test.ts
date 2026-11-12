/**
 * etl/bulk-confirm-strong: the operator job that confirms STRONG pending
 * matches in four /edit queues through the routes' own decision cores.
 *
 * Load-bearing: a dry run writes nothing at all (no transaction, no refresh);
 * --apply needs a real actor CWID; the selection is the verified SQL with no
 * LIMIT; a row decided since selection is skipped, not failed; a decision
 * that would sweep a sibling rolls back and stops that queue only; the CDN
 * gets ONE purge per run, not one per item.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  decideHonor: vi.fn(),
  decideNewsMention: vi.fn(),
  decideGrantReview: vi.fn(),
  confirmPair: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {}, disconnect: vi.fn() }));
vi.mock("@/etl/revalidate", () => ({ requestRevalidate: vi.fn(), enqueueEdgePurgeAll: vi.fn() }));
vi.mock("@/lib/edit/search-suppression", () => ({ reflectGrantSuppressions: vi.fn() }));
vi.mock("@/lib/edit/honor-decision", () => ({ decideHonor: h.decideHonor }));
vi.mock("@/lib/edit/news-mention-decision", () => ({ decideNewsMention: h.decideNewsMention }));
vi.mock("@/lib/edit/grant-attribution-decision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/grant-attribution-decision")>()),
  decideGrantReview: h.decideGrantReview,
}));
vi.mock("@/lib/edit/orcid-queue.server", async () => {
  class OrcidQueueRefused extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
    ) {
      super(code);
    }
  }
  return { confirmPair: h.confirmPair, OrcidQueueRefused };
});

import {
  parseArgs,
  QUEUES,
  runBulkConfirm,
  strongSql,
  toCandidate,
  type Deps,
} from "@/etl/bulk-confirm-strong";
import { GrantAttributionRefused } from "@/lib/edit/grant-attribution-decision";
import { OrcidQueueRefused } from "@/lib/edit/orcid-queue.server";

describe("parseArgs", () => {
  it("defaults to a dry run over every queue, no limit", () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      queues: ["grant", "honors", "news", "orcid"],
      limit: null,
      actor: null,
      pauseMs: 100,
    });
  });

  it("parses --apply with an actor, a queue subset (in fixed order), a limit and a pause", () => {
    expect(
      parseArgs([
        "--apply",
        "--actor=ABC1001",
        "--queues=orcid,honors",
        "--limit=5",
        "--pause-ms=0",
      ]),
    ).toEqual({ apply: true, queues: ["honors", "orcid"], limit: 5, actor: "abc1001", pauseMs: 0 });
  });

  it("refuses --apply without an actor", () => {
    expect(() => parseArgs(["--apply"])).toThrow(/--actor/);
  });

  it.each([
    [["--actor=system-bulk"]],
    [["--actor=1abc"]],
    [["--queues=media"]],
    [["--queues="]],
    [["--limit=0"]],
    [["--limit=x"]],
    [["--pause-ms=-1"]],
    [["--yes"]],
  ])("refuses %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe("selection SQL", () => {
  // One load-bearing predicate of each verified rule, so a swapped or truncated
  // file fails here rather than in prod.
  const MARKER: Record<(typeof QUEUES)[number], RegExp> = {
    grant: /r\.status = 'pending'[\s\S]*any_against = 0/,
    honors: /h\.status = 'pending'[\s\S]*NOT c\.near_dup/,
    news: /nm\.status = 'pending'[\s\S]*nm\.outlet IS NULL/,
    orcid: /o\.band = 'strong'[\s\S]*ad\.cwid IS NULL/,
  };
  it.each(QUEUES)("%s: the verified LIST query, uncapped", (q) => {
    const sql = strongSql(q);
    expect(sql).toMatch(/\bSELECT\b/);
    expect(sql).toMatch(MARKER[q]);
    expect(sql).not.toMatch(/\bLIMIT\b/i);
  });

  it("maps each queue's row to the id its core decides by", () => {
    expect(
      toCandidate("honors", {
        id: "h1",
        cwid: "a",
        organization: "O",
        name: "N",
        year: 2020,
        evidence_kind: "seed-name-only",
      }),
    ).toMatchObject({ key: "h1", cwid: "a" });
    expect(toCandidate("news", { id: "n1", cwid: "a", article_title: "T" })).toMatchObject({
      key: "n1",
      label: "T",
    });
    expect(
      toCandidate("grant", { review_id: "r1", cwid: "a", core_project_num: "R01X" }),
    ).toMatchObject({ key: "r1" });
    expect(toCandidate("orcid", { cwid: "a", orcid: "0000-0002-1825-0097" })).toEqual({
      queue: "orcid",
      key: "a|0000-0002-1825-0097",
      cwid: "a",
      orcid: "0000-0002-1825-0097",
      label: "0000-0002-1825-0097",
    });
  });
});

/** A fake writer: LIST rows per queue (by the SQL's leading comment), and a
 *  transaction that hands over `tx`. */
function harness(rows: Partial<Record<(typeof QUEUES)[number], Array<Record<string, unknown>>>>) {
  const tx = {
    newsMention: { findUnique: vi.fn(async () => ({ status: "pending" })) },
    grantAttributionReview: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        cwid: "g000001",
        status: "pending",
      })),
    },
    scholar: { findFirst: vi.fn(async () => null) },
  };
  const write = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      for (const q of QUEUES) if (sql === strongSql(q)) return rows[q] ?? [];
      throw new Error("unexpected SQL");
    }),
    $transaction: vi.fn(async (fn: (t: never) => Promise<unknown>) => fn(tx as never)),
    etlRun: { findFirst: vi.fn(async () => null) },
    scholar: {
      findMany: vi.fn(async ({ where }: { where: { cwid: { in: string[] } } }) =>
        where.cwid.in.map((c) => ({ slug: `slug-${c}` })),
      ),
    },
  };
  const log: string[] = [];
  const deps = {
    write,
    revalidate: vi.fn<(path: string) => Promise<void>>(async () => {}),
    enqueuePurgeAll: vi.fn(async () => {}),
    reflectGrants: vi.fn(async () => []),
    sleep: vi.fn(async () => {}),
    log: (l: string) => log.push(l),
    now: () => new Date("2026-11-12T15:00:00.000Z"),
  };
  return { tx, write, deps: deps as unknown as Deps & typeof deps, log };
}

const ROWS = {
  grant: [{ review_id: "r1", cwid: "g000001" }],
  honors: [
    { id: "h1", cwid: "a000001" },
    { id: "h2", cwid: "a000002" },
  ],
  news: [{ id: "n1", cwid: "b000001" }],
  orcid: [{ cwid: "c000001", orcid: "0000-0002-1825-0097" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.decideHonor.mockImplementation(async (_tx: unknown, a: { id: string }) => ({
    kind: "ok",
    status: "published",
    siblingsRejected: 0,
    affectedCwids: [a.id === "h1" ? "a000001" : "a000002"],
  }));
  h.decideNewsMention.mockResolvedValue({
    kind: "ok",
    status: "published",
    showOnProfile: true,
    siblingsRejected: 0,
    reassigned: null,
    affectedCwids: ["b000001"],
  });
  h.decideGrantReview.mockResolvedValue({
    entityId: "reporter:g000001:R01X",
    suppressions: [{ suppressionId: "s1", entityId: "reporter:g000001:R01X" }],
  });
  h.confirmPair.mockResolvedValue(undefined);
});

describe("dry run", () => {
  it("selects and lists every queue, and writes NOTHING", async () => {
    const { write, deps, log } = harness(ROWS);
    const tallies = await runBulkConfirm(parseArgs([]), deps);
    expect(tallies.map((t) => [t.queue, t.selected, t.decided])).toEqual([
      ["grant", 1, 0],
      ["honors", 2, 0],
      ["news", 1, 0],
      ["orcid", 1, 0],
    ]);
    expect(write.$queryRawUnsafe).toHaveBeenCalledTimes(4);
    expect(write.$transaction).not.toHaveBeenCalled();
    expect(write.etlRun.findFirst).not.toHaveBeenCalled();
    expect(deps.revalidate).not.toHaveBeenCalled();
    expect(deps.enqueuePurgeAll).not.toHaveBeenCalled();
    expect(deps.reflectGrants).not.toHaveBeenCalled();
    for (const f of [h.decideHonor, h.decideNewsMention, h.decideGrantReview, h.confirmPair]) {
      expect(f).not.toHaveBeenCalled();
    }
    expect(log.some((l) => l.includes("would approve h2 cwid=a000002"))).toBe(true);
  });
});

describe("apply", () => {
  const APPLY = ["--apply", "--actor=cur1001", "--pause-ms=0"];

  it("decides every strong item through its core as the actor, under one request id", async () => {
    const { deps } = harness(ROWS);
    const tallies = await runBulkConfirm(parseArgs(APPLY), deps);
    expect(tallies.map((t) => t.decided)).toEqual([1, 2, 1, 1]);
    expect(h.decideHonor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "h1",
        decision: "approve",
        reason: null,
        realCwid: "cur1001",
        impersonatedCwid: null,
        requestId: "bulk-strong-2026-11-12T15:00:00.000Z",
      }),
    );
    expect(h.decideNewsMention).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mentionId: "n1",
        decision: "approve",
        reassignCwid: null,
        realCwid: "cur1001",
      }),
    );
    expect(h.decideGrantReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "r1" }),
      expect.objectContaining({ decision: "confirm", realCwid: "cur1001" }),
    );
    expect(h.confirmPair).toHaveBeenCalledWith(
      expect.anything(),
      { cwid: "c000001", orcid: "0000-0002-1825-0097" },
      expect.objectContaining({
        actor: "cur1001",
        impersonatedCwid: null,
        requestId: "bulk-strong-2026-11-12T15:00:00.000Z",
      }),
    );
  });

  it("refreshes once after the writes: /browse + each touched profile, ONE edge purge, grant search reflect", async () => {
    const { deps } = harness(ROWS);
    await runBulkConfirm(parseArgs(APPLY), deps);
    expect(deps.enqueuePurgeAll).toHaveBeenCalledTimes(1);
    const paths = deps.revalidate.mock.calls.map((c) => c[0]);
    expect(paths[0]).toBe("/browse");
    expect(new Set(paths)).toEqual(
      new Set([
        "/browse",
        "/slug-g000001",
        "/slug-a000001",
        "/slug-a000002",
        "/slug-b000001",
        "/slug-c000001",
      ]),
    );
    expect(deps.reflectGrants).toHaveBeenCalledWith([
      { suppressionId: "s1", entityId: "reporter:g000001:R01X" },
    ]);
  });

  it("skips (not fails) items decided since selection, in every queue", async () => {
    const { tx, deps } = harness(ROWS);
    h.decideHonor.mockResolvedValue({ kind: "not_pending", status: "published" });
    tx.newsMention.findUnique.mockResolvedValue({ status: "rejected" });
    tx.grantAttributionReview.findUnique.mockResolvedValue({
      id: "r1",
      cwid: "g000001",
      status: "confirmed",
    } as never);
    h.confirmPair.mockRejectedValue(
      new OrcidQueueRefused(409 as never, "already_on_file" as never),
    );
    const tallies = await runBulkConfirm(parseArgs(APPLY), deps);
    expect(tallies.map((t) => [t.queue, t.decided, t.skipped, t.stopped])).toEqual([
      ["grant", 0, { not_pending: 1 }, null],
      ["honors", 0, { not_pending: 2 }, null],
      ["news", 0, { not_pending: 1 }, null],
      ["orcid", 0, { already_on_file: 1 }, null],
    ]);
    // A rejected news row is never approved by the bulk run (the core's un-reject path).
    expect(h.decideNewsMention).not.toHaveBeenCalled();
    expect(h.decideGrantReview).not.toHaveBeenCalled();
    expect(deps.enqueuePurgeAll).not.toHaveBeenCalled();
  });

  it("skips a grant the route would refuse (an age hide appeared)", async () => {
    const { deps } = harness({ grant: ROWS.grant });
    h.decideGrantReview.mockRejectedValue(new GrantAttributionRefused(409, "hidden_by_age"));
    const [t] = await runBulkConfirm(parseArgs([...APPLY, "--queues=grant"]), deps);
    expect(t).toMatchObject({ decided: 0, skipped: { hidden_by_age: 1 }, stopped: null });
  });

  it("skips an ORCID iD another scholar now holds, without calling confirmPair", async () => {
    const { tx, deps } = harness({ orcid: ROWS.orcid });
    tx.scholar.findFirst.mockResolvedValue({ cwid: "z000009" } as never);
    const [t] = await runBulkConfirm(parseArgs([...APPLY, "--queues=orcid"]), deps);
    expect(t.skipped).toEqual({ held_by_other: 1 });
    expect(h.confirmPair).not.toHaveBeenCalled();
  });

  it("stops ONLY that queue when a decision would sweep a sibling, and still refreshes what committed", async () => {
    const { deps } = harness(ROWS);
    h.decideHonor.mockImplementation(async (_tx: unknown, a: { id: string }) =>
      a.id === "h1"
        ? { kind: "ok", status: "published", siblingsRejected: 0, affectedCwids: ["a000001"] }
        : {
            kind: "ok",
            status: "published",
            siblingsRejected: 1,
            affectedCwids: ["a000002", "x000001"],
          },
    );
    const tallies = await runBulkConfirm(parseArgs(APPLY), deps);
    const honors = tallies.find((t) => t.queue === "honors")!;
    expect(honors.decided).toBe(1);
    expect(honors.stopped).toMatch(/h2: .*sibling/);
    // The later queues still ran.
    expect(tallies.find((t) => t.queue === "orcid")!.decided).toBe(1);
    const paths = deps.revalidate.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/slug-a000001");
    expect(paths).not.toContain("/slug-a000002");
  });

  it("stops the queue on an unexpected error", async () => {
    const { deps } = harness({ honors: ROWS.honors });
    h.decideHonor.mockRejectedValueOnce(new Error("Deadlock found"));
    const [t] = await runBulkConfirm(parseArgs([...APPLY, "--queues=honors"]), deps);
    expect(t.stopped).toMatch(/h1: Deadlock/);
    expect(h.decideHonor).toHaveBeenCalledTimes(1);
  });

  it("stops a queue whose selection fails, and runs the rest", async () => {
    const { write, deps } = harness(ROWS);
    const real = write.$queryRawUnsafe.getMockImplementation()!;
    write.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql === strongSql("grant")) throw new Error("Unknown column");
      return real(sql);
    });
    const tallies = await runBulkConfirm(parseArgs(APPLY), deps);
    expect(tallies[0]).toMatchObject({ queue: "grant", decided: 0 });
    expect(tallies[0].stopped).toMatch(/selection failed: Unknown column/);
    expect(tallies.slice(1).map((t) => t.decided)).toEqual([2, 1, 1]);
  });

  it("caps each queue at --limit", async () => {
    const { deps } = harness({ honors: ROWS.honors });
    const [t] = await runBulkConfirm(parseArgs([...APPLY, "--queues=honors", "--limit=1"]), deps);
    expect(t).toMatchObject({ selected: 2, decided: 1 });
  });

  it("sits a queue out while its own ETL is running", async () => {
    const { write, deps } = harness({ orcid: ROWS.orcid });
    write.etlRun.findFirst.mockResolvedValue({
      startedAt: new Date("2026-11-12T14:00:00.000Z"),
    } as never);
    const [t] = await runBulkConfirm(parseArgs([...APPLY, "--queues=orcid"]), deps);
    expect(t.heldBy).toMatch(/ORCID-evidence running/);
    expect(write.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(h.confirmPair).not.toHaveBeenCalled();
  });
});
