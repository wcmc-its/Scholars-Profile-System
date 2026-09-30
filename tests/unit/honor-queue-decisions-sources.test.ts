/**
 * Honors queue loader: the decision metadata (who decided, why it was rejected)
 * the Known / Rejected tabs render, and the Sources tab's roster rollup.
 * All names, CWIDs and URLs are invented.
 */
import { describe, expect, it } from "vitest";

import {
  buildListStatuses,
  loadHonorQueue,
  loadHonorSources,
  rosterKey,
  SUPERSEDED_REASON,
} from "@/lib/edit/honor-queue";
import { HONOR_LISTS, HONOR_LIST_RUN_STALE_MS } from "@/lib/honors/lists";

const T0 = new Date("2026-07-17T00:00:00Z");

function honorRow(over: Record<string, unknown>) {
  return {
    id: "h",
    cwid: "zzz1001",
    category: "PRIZE",
    name: "Member",
    organization: "Invented Academy",
    year: 2020,
    source: "SEED",
    sourceRef: null,
    createdAt: T0,
    updatedAt: T0,
    decidedByCwid: null,
    decidedAt: null,
    rejectionReason: null,
    supersededById: null,
    ...over,
  };
}

function queueClient(rows: unknown[], scholars: Array<{ cwid: string; preferredName: string }>) {
  return {
    honor: { findMany: async () => rows },
    scholar: {
      findMany: async ({ where }: { where: { cwid: { in: string[] } } }) =>
        scholars
          .filter((s) => where.cwid.in.includes(s.cwid))
          .map((s) => ({
            cwid: s.cwid,
            slug: null,
            preferredName: s.preferredName,
            postnominal: null,
            fullName: s.preferredName,
            roleCategory: "full_time_faculty",
            primaryTitle: null,
            primaryDepartment: null,
          })),
    },
  } as unknown as Parameters<typeof loadHonorQueue>[0];
}

describe("loadHonorQueue — decision metadata", () => {
  it("names the decider from the scholar table, and prefers decidedAt over updatedAt", async () => {
    const decided = new Date("2026-09-20T10:00:00Z");
    const groups = await loadHonorQueue(
      queueClient(
        [
          honorRow({
            id: "a",
            decidedByCwid: "cur9001",
            decidedAt: decided,
            updatedAt: new Date("2026-09-21T00:00:00Z"),
          }),
        ],
        [
          { cwid: "zzz1001", preferredName: "Ada Example" },
          { cwid: "cur9001", preferredName: "Cora Curator" },
        ],
      ),
      "published",
    );
    const row = groups[0].rows[0];
    expect(row.decidedByName).toBe("Cora Curator");
    expect(row.decidedAt).toBe(decided.toISOString());
  });

  it("falls back to the decider's CWID when they have no scholar row", async () => {
    const groups = await loadHonorQueue(
      queueClient(
        [honorRow({ id: "a", decidedByCwid: "cur9002", decidedAt: T0 })],
        [{ cwid: "zzz1001", preferredName: "Ada Example" }],
      ),
      "published",
    );
    expect(groups[0].rows[0].decidedByName).toBe("cur9002");
  });

  it("a row with no recorded decider shows none, and uses updatedAt", async () => {
    const groups = await loadHonorQueue(
      queueClient([honorRow({ id: "a" })], [{ cwid: "zzz1001", preferredName: "Ada Example" }]),
      "published",
    );
    expect(groups[0].rows[0].decidedByName).toBeNull();
    expect(groups[0].rows[0].decidedAt).toBe(T0.toISOString());
  });

  it("rejection reason: the curator's, else a fixed line for an auto-rejected sibling", async () => {
    const groups = await loadHonorQueue(
      queueClient(
        [
          honorRow({ id: "a", cwid: "zzz1001", rejectionReason: "Name collision" }),
          honorRow({ id: "b", cwid: "zzz1002", supersededById: "x" }),
          honorRow({ id: "c", cwid: "zzz1003" }),
        ],
        [
          { cwid: "zzz1001", preferredName: "Ada Example" },
          { cwid: "zzz1002", preferredName: "Bea Example" },
          { cwid: "zzz1003", preferredName: "Cy Example" },
        ],
      ),
      "rejected",
    );
    const byId = Object.fromEntries(groups.flatMap((g) => g.rows).map((r) => [r.id, r]));
    expect(byId.a.rejectionReason).toBe("Name collision");
    expect(byId.a.superseded).toBe(false);
    expect(byId.b.rejectionReason).toBe(SUPERSEDED_REASON);
    expect(byId.b.superseded).toBe(true);
    expect(byId.c.rejectionReason).toBeNull();
  });
});

describe("rosterKey", () => {
  it("takes the roster segment of a 3-part ref", () => {
    expect(rosterKey("https://example.org/fellows|A. Person|2020")).toBe(
      "https://example.org/fellows",
    );
  });
  it("drops a #fragment line id", () => {
    expect(rosterKey("https://example.org/fellows#line-42")).toBe("https://example.org/fellows");
  });
  it("keeps an opaque roster id", () => {
    expect(rosterKey("invented-list|A. Person|2020")).toBe("invented-list");
  });
});

describe("loadHonorSources", () => {
  function sourcesClient(rows: unknown[], runs: unknown[], listRuns: unknown[] = []) {
    const calls: { honor?: unknown; etlRun?: unknown; honorListRun?: unknown } = {};
    const client = {
      honor: { findMany: async (args: unknown) => ((calls.honor = args), rows) },
      etlRun: { findMany: async (args: unknown) => ((calls.etlRun = args), runs) },
      honorListRun: {
        findMany: async (args: unknown) => ((calls.honorListRun = args), listRuns),
      },
    } as unknown as Parameters<typeof loadHonorSources>[0];
    return { client, calls };
  }
  const R1 = "https://www.example.org/members";
  const R2 = "invented-list";

  it("rolls rows up per roster: lines, waiting lines, approved, rejected", async () => {
    const { client } = sourcesClient(
      [
        // Roster 1: a contested line (one approved, one rejected), a pending line.
        {
          name: "Member",
          organization: "Invented Academy",
          status: "published",
          sourceRef: `${R1}|A. One|2020`,
        },
        {
          name: "Member",
          organization: "Invented Academy",
          status: "rejected",
          sourceRef: `${R1}|A. One|2020`,
        },
        {
          name: "Member",
          organization: "Invented Academy",
          status: "pending",
          sourceRef: `${R1}|B. Two|2021`,
        },
        // Roster 2: opaque id, one pending line with two candidates.
        {
          name: "Fellow",
          organization: "Made-up Society",
          status: "pending",
          sourceRef: `${R2}|C. Three|2019`,
        },
        {
          name: "Fellow",
          organization: "Made-up Society",
          status: "pending",
          sourceRef: `${R2}|C. Three|2019`,
        },
      ],
      [],
    );
    const { sources, runs } = await loadHonorSources(client);
    expect(runs).toEqual([]);
    const byKey = Object.fromEntries(sources.map((s) => [s.key, s]));
    expect(byKey[R1]).toMatchObject({
      name: "Member",
      organization: "Invented Academy",
      url: R1,
      host: "example.org",
      lines: 2,
      pendingLines: 1,
      approved: 1,
      rejected: 1,
    });
    expect(byKey[R2]).toMatchObject({
      url: null,
      host: null,
      lines: 1,
      pendingLines: 1,
      approved: 0,
    });
  });

  it("excludes hand-entered and self-asserted rows, and reads only honors runs", async () => {
    const { client, calls } = sourcesClient([], []);
    await loadHonorSources(client);
    expect(calls.honor).toMatchObject({
      where: { sourceRef: { not: null }, source: { notIn: ["CURATOR", "SELF"] } },
    });
    expect(calls.etlRun).toMatchObject({
      where: { source: { startsWith: "Honors" } },
      orderBy: { startedAt: "desc" },
    });
  });

  it("serializes runs newest first as returned", async () => {
    const started = new Date("2026-09-01T15:00:00Z");
    const { client } = sourcesClient(
      [],
      [
        {
          source: "HonorsSeed-Import",
          startedAt: started,
          completedAt: null,
          status: "failed",
          rowsProcessed: 0,
          errorMessage: "invented failure",
        },
      ],
    );
    const { runs } = await loadHonorSources(client);
    expect(runs).toEqual([
      {
        source: "HonorsSeed-Import",
        startedAt: started.toISOString(),
        completedAt: null,
        status: "failed",
        rowsProcessed: 0,
        errorMessage: "invented failure",
      },
    ]);
  });
});

describe("buildListStatuses — the Sources tab's per-list runs", () => {
  const NOW = Date.parse("2026-09-25T12:00:00Z");
  const LIST = HONOR_LISTS[0].id;
  function listRun(over: Record<string, unknown>) {
    return {
      id: "r",
      listId: LIST,
      trigger: "schedule",
      status: "success",
      createdAt: new Date(NOW - 60_000),
      finishedAt: new Date(NOW - 30_000),
      onListTotal: 100,
      matched: 3,
      newCandidates: 1,
      errorMessage: null,
      ...over,
    };
  }

  it("covers every registry list, in registry order, never-run lists included", () => {
    const out = buildListStatuses([], NOW);
    expect(out.map((l) => l.id)).toEqual(HONOR_LISTS.map((l) => l.id));
    expect(out.every((l) => l.latest === null && !l.active)).toBe(true);
    expect(out[0].schedule).toBe("Weekly");
  });

  it("latest is the newest run; lastFinished skips a queued/running one", () => {
    const [l] = buildListStatuses(
      [
        listRun({ id: "new", status: "queued", finishedAt: null, onListTotal: null }),
        listRun({ id: "old", createdAt: new Date(NOW - 86_400_000) }),
      ],
      NOW,
    );
    expect(l.latest?.id).toBe("new");
    expect(l.latest?.status).toBe("queued");
    expect(l.active).toBe(true);
    expect(l.lastFinished?.id).toBe("old");
    expect(l.lastFinished?.onListTotal).toBe(100);
  });

  it("a queued/running row past the stale window reads stalled and is not active", () => {
    const [l] = buildListStatuses(
      [
        listRun({
          status: "running",
          finishedAt: null,
          createdAt: new Date(NOW - HONOR_LIST_RUN_STALE_MS - 1000),
        }),
      ],
      NOW,
    );
    expect(l.latest?.status).toBe("stalled");
    expect(l.active).toBe(false);
  });

  it("loadHonorSources reads the run log newest first and attaches the lists", async () => {
    const calls: Record<string, unknown> = {};
    const client = {
      honor: { findMany: async () => [] },
      etlRun: { findMany: async () => [] },
      honorListRun: {
        findMany: async (args: unknown) => (
          (calls.args = args),
          [listRun({ id: "x", status: "failed", errorMessage: "HTTP 403 on https://example.org" })]
        ),
      },
    } as unknown as Parameters<typeof loadHonorSources>[0];
    const summary = await loadHonorSources(client);
    expect(calls.args).toMatchObject({ orderBy: { createdAt: "desc" } });
    const first = summary.lists.find((l) => l.id === LIST);
    expect(first?.latest?.status).toBe("failed");
    expect(first?.latest?.errorMessage).toBe("HTTP 403 on https://example.org");
  });
});
