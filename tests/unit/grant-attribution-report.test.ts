/**
 * Report 14 (Grant attribution, #3071) — the loader and its params: the
 * department roll-up, the outcome filter (including "recovered", the awards
 * the check showed again on its own), search, and when "Send to review"
 * applies. Fixture people and awards are invented.
 */
import { describe, expect, it, vi } from "vitest";

import {
  loadGrantAttributionReport,
  parseGrantAttributionParams,
} from "@/lib/edit/grant-attribution-report";

const score = (id: string, cwid: string, band: string, cues: unknown[] = []) => ({
  grantExternalId: id,
  cwid,
  band,
  cues,
  award: { title: `Award ${id}`, awardNumber: id, orgs: [], piNames: [] },
  reporterName: null,
});

function client() {
  return {
    grantAttributionRun: {
      findMany: vi.fn(async () => [
        {
          ranAt: new Date("2026-10-23T14:00:00Z"),
          scholars: 2,
          show: 2,
          hide: 1,
          queue: 1,
          recovered: 1,
          cues: { pub_linked: 1 },
        },
      ]),
    },
    grantAttributionScore: {
      findMany: vi.fn(async (args?: { where?: { band?: string } }) =>
        [
          score("A", "zza0001", "show", [{ id: "profile_proven", weight: 3, reason: "proven" }]),
          score("B", "zza0001", "hide"),
          score("C", "zzb0001", "show", [{ id: "pub_linked", weight: 4, reason: "cited" }]),
          score("D", "zzb0001", "queue"),
        ].filter((s) => !args?.where?.band || s.band === args.where.band),
      ),
    },
    grantAttributionReview: {
      findMany: vi.fn(async () => [
        { grantExternalId: "A", status: "withdrawn" },
        { grantExternalId: "C", status: "confirmed" },
        { grantExternalId: "D", status: "pending" },
      ]),
    },
    suppression: {
      // A's hide was lifted by the scorer; nothing is active.
      findMany: vi.fn(async (args: { where: { revokedAt?: null } }) =>
        "revokedAt" in args.where
          ? []
          : [{ entityId: "A", revokedAt: new Date("2026-10-23T14:00:00Z") }],
      ),
    },
    scholar: {
      findMany: vi.fn(async () => [
        {
          cwid: "zza0001",
          slug: "a",
          preferredName: "Pat Example",
          fullName: null,
          postnominal: null,
          roleCategory: null,
          primaryDepartment: "Medicine",
        },
        {
          cwid: "zzb0001",
          slug: "b",
          preferredName: "Lee Sample",
          fullName: null,
          postnominal: null,
          roleCategory: null,
          primaryDepartment: null,
        },
      ]),
    },
  };
}

describe("parseGrantAttributionParams", () => {
  it("defaults to hidden awards and refuses an unknown outcome", () => {
    expect(parseGrantAttributionParams({})).toEqual({ outcome: "hide", q: "", dept: null });
    expect(parseGrantAttributionParams({ outcome: "bogus", q: "  x ", dept: "Medicine" })).toEqual({
      outcome: "hide",
      q: "x",
      dept: "Medicine",
    });
  });
});

describe("loadGrantAttributionReport", () => {
  it("rolls up by department, scholars counted once", async () => {
    const r = await loadGrantAttributionReport(client() as never, parseGrantAttributionParams({}));
    expect(r.depts).toEqual([
      { name: "Medicine", scholars: 1, awards: 2, show: 1, hide: 1, queue: 0 },
      { name: "No department", scholars: 1, awards: 2, show: 1, hide: 0, queue: 1 },
    ]);
    expect(r.curatorDecisions).toBe(1);
    expect(r.runs[0]!.recovered).toBe(1);
  });

  it("lists hidden awards with their reason, sendable to review", async () => {
    const r = await loadGrantAttributionReport(client() as never, parseGrantAttributionParams({}));
    expect(r.rows.map((x) => [x.id, x.requeueable])).toEqual([["B", true]]);
    expect(r.rows[0]!.why).toMatch(/Nothing ties it/);
  });

  it("recovered means shown again by the check, not every shown award", async () => {
    const r = await loadGrantAttributionReport(
      client() as never,
      parseGrantAttributionParams({ outcome: "recovered" }),
    );
    expect(r.rows.map((x) => x.id)).toEqual(["A"]);
    expect(r.rows[0]!.why).toBe("proven");
  });

  it("never offers to requeue a curator decision or a queued award; filters by department and search", async () => {
    const shown = await loadGrantAttributionReport(
      client() as never,
      parseGrantAttributionParams({ outcome: "show" }),
    );
    expect(Object.fromEntries(shown.rows.map((x) => [x.id, x.requeueable]))).toEqual({
      A: true,
      C: false,
    });
    const queued = await loadGrantAttributionReport(
      client() as never,
      parseGrantAttributionParams({ outcome: "queue" }),
    );
    expect(queued.rows.map((x) => x.requeueable)).toEqual([false]);
    const med = await loadGrantAttributionReport(
      client() as never,
      parseGrantAttributionParams({ outcome: "show", dept: "Medicine" }),
    );
    expect(med.rows.map((x) => x.id)).toEqual(["A"]);
    const q = await loadGrantAttributionReport(
      client() as never,
      parseGrantAttributionParams({ outcome: "show", q: "lee" }),
    );
    expect(q.rows.map((x) => x.id)).toEqual(["C"]);
  });
});
