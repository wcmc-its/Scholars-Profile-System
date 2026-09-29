/**
 * "All cores" (`center=all&kind=core`, core reports index picker plan PR 2):
 * the data layer and the download gate. Protects: the roll-up's PMIDs are the
 * DEDUPED union of every catalog core's confirmed set; report 11's known
 * clients read `coreId IN (…)`; report 12's merge rule (a paper under several
 * cores takes the STRONGEST bucket any core it is confirmed for gives it —
 * Acknowledgment > Core-staff co-author > Other signals > Manually added —
 * and a core it is NOT confirmed for never lends it evidence); the download
 * gate admits a superuser only; the Criteria "Core: All N" row and the
 * `all-cores-…` file name; and single-core calls keep their exact query shape.
 * Core ids and PMIDs are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  read: {
    core: { findMany: vi.fn() },
    publicationCore: { findMany: vi.fn() },
    coreClaim: { findMany: vi.fn() },
    publication: { findMany: vi.fn() },
    coreClient: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
  identity: vi.fn(),
  ctx: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { read: h.read, write: {} }, prisma: {} }));
vi.mock("@/lib/edit/request", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/request")>()),
  resolveEditIdentity: h.identity,
}));
vi.mock("@/lib/edit/cancer-center-reports", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/cancer-center-reports")>()),
  loadReportsContext: h.ctx,
}));

import {
  ALL_CORES_COUNTING_NOTE,
  coreCriteriaHead,
  coreXlsxName,
  gateCoreReportDownload,
  loadCoreConfirmedPmids,
  loadCoreScope,
  unionPmids,
} from "@/lib/edit/core-report-common";
import { loadCoreOutputPubs, mergeEvidence, paperEvidence } from "@/lib/edit/core-output-report";
import {
  loadActiveClientCwids,
  loadCoreUsersReport,
  parseCoreUsersParams,
} from "@/lib/edit/core-users-report";

const SUPERUSER = { cwid: "adm0001", isSuperuser: true, isCommsSteward: false };
const STEWARD = { cwid: "cs00001", isSuperuser: false, isCommsSteward: true };
const OWNER = { cwid: "own0001", isSuperuser: false, isCommsSteward: false };

/** Engine rows / claims keyed by core, as `loadConfirmedCorePmidsByCore` reads them. */
function catalog(
  engine: Array<{ coreId: string; pmid: string; status?: string }>,
  claims: Array<{ coreId: string; pmid: string; status: "claimed" | "rejected" }> = [],
) {
  h.read.core.findMany.mockResolvedValue([{ id: "1" }, { id: "2" }, { id: "3" }]);
  h.read.publicationCore.findMany.mockImplementation(
    async ({ where }: { where: { coreId: { in: string[] }; status: string } }) =>
      engine
        .filter((r) => where.coreId.in.includes(r.coreId))
        .map((r) => ({ ...r, status: r.status ?? "confirmed" }))
        .filter((r) => r.status === where.status),
  );
  h.read.coreClaim.findMany.mockImplementation(
    async ({ where }: { where: { coreId: { in: string[] } } }) =>
      claims.filter((c) => where.coreId.in.includes(c.coreId)),
  );
}

beforeEach(() => vi.clearAllMocks());

describe("the roll-up's PMIDs: the deduped union", () => {
  it("unionPmids keeps each PMID once", () => {
    expect(
      unionPmids(
        new Map([
          ["1", ["100", "200"]],
          ["2", ["200", "300"]],
          ["3", []],
        ]),
      ),
    ).toEqual(["100", "200", "300"]);
  });

  it("all → every catalog core, a PMID confirmed for two cores once, a rejected pair dropped", async () => {
    catalog(
      [
        { coreId: "1", pmid: "100" },
        { coreId: "2", pmid: "100" },
        { coreId: "2", pmid: "200" },
        { coreId: "3", pmid: "300" },
      ],
      [
        { coreId: "3", pmid: "300", status: "rejected" },
        { coreId: "1", pmid: "400", status: "claimed" },
      ],
    );
    const scope = await loadCoreScope("all");
    expect(scope.coreIds).toEqual(["1", "2", "3"]);
    expect([...scope.pmids].sort()).toEqual(["100", "200", "400"]);
    expect(scope.byCore.get("1")!.sort()).toEqual(["100", "400"]);
    expect(await loadCoreConfirmedPmids("all")).toHaveLength(3);
  });

  it("one core never reads the catalog and asks for that core only", async () => {
    catalog([{ coreId: "2", pmid: "200" }]);
    expect(await loadCoreConfirmedPmids("2")).toEqual(["200"]);
    expect(h.read.core.findMany).not.toHaveBeenCalled();
    expect(h.read.publicationCore.findMany.mock.calls[0][0].where.coreId).toEqual({ in: ["2"] });
  });
});

describe("report 12 — the merge rule for a paper under several cores", () => {
  const ACK = { signalAck: true, signalCoauthors: null };
  const COAUTHOR = { signalAck: false, signalCoauthors: ["x"] };
  const OTHER = { signalAck: false, signalCoauthors: null };

  it("mergeEvidence: Acknowledgment > Core-staff co-author > Other signals > Manually added", () => {
    expect(mergeEvidence(["manual", "other", "coauthor", "ack"])).toBe("ack");
    expect(mergeEvidence(["manual", "coauthor", "other"])).toBe("coauthor");
    expect(mergeEvidence(["manual", "other"])).toBe("other");
    expect(mergeEvidence(["manual"])).toBe("manual");
  });

  it("paperEvidence reads only the cores the paper is confirmed for", () => {
    const confirmed = new Map([
      ["100", new Set(["1", "2"])],
      ["200", new Set(["1"])],
    ]);
    const engine = new Map([
      ["2|100", ACK], // core 2 acknowledged 100; core 1 has no row (a manual add)
      ["1|200", OTHER],
      ["2|200", ACK], // core 2 is NOT confirmed for 200 — must not lend its ack
    ]);
    expect(paperEvidence("100", confirmed, engine)).toBe("ack");
    expect(paperEvidence("200", confirmed, engine)).toBe("other");
    // One core reduces to the single-core bucket.
    expect(paperEvidence("100", new Map([["100", new Set(["1"])]]), engine)).toBe("manual");
  });

  it("loadCoreOutputPubs over byCore buckets each paper once, strongest wins", async () => {
    h.read.publication.findMany.mockResolvedValue([
      { pmid: "100", title: "T1", journal: null, year: 2024, dateAddedToEntrez: null },
      { pmid: "200", title: "T2", journal: null, year: 2025, dateAddedToEntrez: null },
    ]);
    h.read.publicationCore.findMany.mockResolvedValue([
      { coreId: "1", pmid: "100", ...OTHER },
      { coreId: "2", pmid: "100", ...COAUTHOR },
      { coreId: "3", pmid: "200", ...ACK }, // 200 isn't confirmed for core 3
    ]);
    const byCore = new Map([
      ["1", ["100", "200"]],
      ["2", ["100"]],
      ["3", []],
    ]);
    const pubs = await loadCoreOutputPubs("all", ["100", "200"], byCore);
    expect(pubs.map((p) => [p.pmid, p.evidence])).toEqual([
      ["100", "coauthor"],
      ["200", "manual"],
    ]);
    expect(h.read.publicationCore.findMany.mock.calls[0][0].where.coreId).toEqual({
      in: ["1", "2", "3"],
    });
  });

  it("one core keeps the single-core query shape (coreId equality) and buckets", async () => {
    h.read.publication.findMany.mockResolvedValue([
      { pmid: "100", title: "T1", journal: null, year: 2024, dateAddedToEntrez: null },
    ]);
    h.read.publicationCore.findMany.mockResolvedValue([{ coreId: "14", pmid: "100", ...ACK }]);
    const pubs = await loadCoreOutputPubs("14", ["100"]);
    expect(pubs[0].evidence).toBe("ack");
    expect(h.read.publicationCore.findMany.mock.calls[0][0].where).toEqual({
      coreId: "14",
      pmid: { in: ["100"] },
    });
  });
});

describe("report 11 — known clients across cores", () => {
  it("several core ids → coreId IN (…); one → coreId equality", async () => {
    h.read.coreClient.findMany.mockResolvedValue([{ cwid: "ABC1001" }, { cwid: null }]);
    expect([...(await loadActiveClientCwids(["1", "2"]))]).toEqual(["abc1001"]);
    expect(h.read.coreClient.findMany.mock.calls[0][0].where.coreId).toEqual({ in: ["1", "2"] });
    await loadActiveClientCwids("14");
    expect(h.read.coreClient.findMany.mock.calls[1][0].where.coreId).toBe("14");
  });

  it("loadCoreUsersReport('all') reads every catalog core's clients", async () => {
    h.read.core.findMany.mockResolvedValue([{ id: "1" }, { id: "2" }]);
    h.read.coreClient.findMany.mockResolvedValue([]);
    await loadCoreUsersReport("all", [], parseCoreUsersParams(new URLSearchParams()));
    expect(h.read.coreClient.findMany.mock.calls[0][0].where.coreId).toEqual({ in: ["1", "2"] });
  });
});

describe("gateCoreReportDownload — center=all", () => {
  const sp = (center: string) => new URLSearchParams({ center, kind: "core" });

  it("a superuser passes without the single-core gate, as 'All cores'", async () => {
    h.identity.mockResolvedValue({ session: SUPERUSER });
    const gate = await gateCoreReportDownload(sp("all"));
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.coreId).toBe("all");
      expect(gate.ctx.unit.name).toBe("All cores");
    }
    expect(h.ctx).not.toHaveBeenCalled();
  });

  it.each([
    ["a comms steward", STEWARD],
    ["a core owner", OWNER],
  ])("%s gets 403", async (_w, session) => {
    h.identity.mockResolvedValue({ session });
    const gate = await gateCoreReportDownload(sp("all"));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(403);
    expect(h.ctx).not.toHaveBeenCalled();
  });

  it("one core still runs the page's own gate", async () => {
    h.identity.mockResolvedValue({ session: OWNER });
    h.ctx.mockResolvedValue({ unit: { name: "Alpha Core" } });
    const gate = await gateCoreReportDownload(sp("14"));
    expect(gate.ok).toBe(true);
    expect(h.ctx).toHaveBeenCalledWith("14", OWNER, expect.anything(), "core");
  });
});

describe("the workbook's Criteria and file name", () => {
  const at = new Date("2026-09-29T12:00:00.000Z");

  it("one core: Report, Core, Generated — unchanged", () => {
    expect(coreCriteriaHead("12. Output over time", "Alpha Core", at)).toEqual([
      ["Report", "12. Output over time"],
      ["Core", "Alpha Core"],
      ["Generated", "2026-09-29T12:00:00.000Z"],
    ]);
    expect(coreXlsxName("14", "Alpha Core", "grants 2026-09-29")).toBe(
      "Alpha Core grants 2026-09-29.xlsx",
    );
  });

  it("all cores: 'Core: All N' plus the counts-once note, and an all-cores-… name", () => {
    expect(coreCriteriaHead("11. Core users", { allCount: 16 }, at)).toEqual([
      ["Report", "11. Core users"],
      ["Core", "All 16"],
      ["Roll-up", ALL_CORES_COUNTING_NOTE],
      ["Generated", "2026-09-29T12:00:00.000Z"],
    ]);
    expect(coreXlsxName("all", "All cores", "output 2018-2026 2026-09-29")).toBe(
      "all-cores-output-2018-2026-2026-09-29.xlsx",
    );
  });
});
