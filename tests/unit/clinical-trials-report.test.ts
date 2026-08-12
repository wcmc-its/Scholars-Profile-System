/**
 * `lib/center-collaboration/clinical-trials-report.ts` — the `/edit/reports/5`
 * query. `loadClinicalTrialsReport` takes its Prisma client as a parameter (no
 * `@/lib/db` import at module scope), so the fake client is passed straight in
 * rather than mocked via `vi.mock`, matching this module's own DB-free-helper
 * posture (only the query function itself does I/O).
 */
import { describe, expect, it, vi } from "vitest";

import {
  loadClinicalTrialsReport,
  type ClinicalTrialsReportClient,
} from "@/lib/center-collaboration/clinical-trials-report";

const CENTER = "TEST_CENTER";

/** A minimal fake client — only the three tables the query touches. */
function fakeClient(overrides: {
  memberships?: Array<{ cwid: string; startDate: Date | null; endDate: Date | null }>;
  scholars?: Array<{ cwid: string; preferredName: string }>;
  links?: Array<{
    cwid: string;
    protocolNumber: string;
    role: string;
    trial: {
      nctNumber: string | null;
      title: string;
      status: string | null;
      phase: string | null;
      principalSponsor: string | null;
    };
  }>;
}): ClinicalTrialsReportClient {
  return {
    centerMembership: {
      findMany: vi.fn(async () => overrides.memberships ?? []),
    },
    scholar: {
      findMany: vi.fn(async () => overrides.scholars ?? []),
    },
    personClinicalTrial: {
      findMany: vi.fn(async () => overrides.links ?? []),
    },
  } as unknown as ClinicalTrialsReportClient;
}

function trial(over: Partial<{
  nctNumber: string | null;
  title: string;
  status: string | null;
  phase: string | null;
  principalSponsor: string | null;
}> = {}) {
  return {
    nctNumber: null,
    title: "Untitled trial",
    status: null,
    phase: null,
    principalSponsor: null,
    ...over,
  };
}

describe("loadClinicalTrialsReport", () => {
  it("returns [] when the center has no active members", async () => {
    const client = fakeClient({
      memberships: [
        { cwid: "aaa1001", startDate: null, endDate: new Date("2020-01-01") }, // lapsed
      ],
    });
    const rows = await loadClinicalTrialsReport(client, CENTER);
    expect(rows).toEqual([]);
    expect(client.personClinicalTrial.findMany).not.toHaveBeenCalled();
  });

  it("returns [] when active members have no trial links", async () => {
    const client = fakeClient({
      memberships: [{ cwid: "aaa1001", startDate: null, endDate: null }],
      scholars: [{ cwid: "aaa1001", preferredName: "Ada Faculty" }],
      links: [],
    });
    const rows = await loadClinicalTrialsReport(client, CENTER);
    expect(rows).toEqual([]);
  });

  it("joins membership, scholar name, and trial detail into one row per link", async () => {
    const client = fakeClient({
      memberships: [{ cwid: "aaa1001", startDate: null, endDate: null }],
      scholars: [{ cwid: "aaa1001", preferredName: "Ada Faculty" }],
      links: [
        {
          cwid: "aaa1001",
          protocolNumber: "P-1",
          role: "Principal Investigator",
          trial: trial({
            nctNumber: "NCT00000001",
            title: "A Study of Widgets",
            status: "Recruiting",
            phase: "Phase 2",
            principalSponsor: "Acme Pharma",
          }),
        },
      ],
    });
    const rows = await loadClinicalTrialsReport(client, CENTER);
    expect(rows).toEqual([
      {
        cwid: "aaa1001",
        personName: "Ada Faculty",
        role: "Principal Investigator",
        protocolNumber: "P-1",
        nctNumber: "NCT00000001",
        title: "A Study of Widgets",
        phase: "Phase 2",
        principalSponsor: "Acme Pharma",
        status: "Recruiting",
        isActive: true,
      },
    ]);
  });

  it("excludes a lapsed member's trial links even if PersonClinicalTrial still has a row", async () => {
    const client = fakeClient({
      memberships: [
        { cwid: "aaa1001", startDate: null, endDate: new Date("2020-01-01") },
      ],
    });
    const rows = await loadClinicalTrialsReport(client, CENTER);
    expect(rows).toEqual([]);
  });

  it("sorts active-first, then by the person's surname, then by trial title", async () => {
    const client = fakeClient({
      memberships: [
        { cwid: "aaa1001", startDate: null, endDate: null },
        { cwid: "bbb2002", startDate: null, endDate: null },
      ],
      scholars: [
        { cwid: "aaa1001", preferredName: "Zed Zimmer" }, // surname "zimmer"
        { cwid: "bbb2002", preferredName: "Ada Anders" }, // surname "anders"
      ],
      links: [
        {
          cwid: "aaa1001",
          protocolNumber: "P-completed",
          role: "Investigator",
          trial: trial({ title: "Zimmer completed trial", status: "Completed" }),
        },
        {
          cwid: "bbb2002",
          protocolNumber: "P-active-b",
          role: "Principal Investigator",
          trial: trial({ title: "B second active trial", status: "Recruiting" }),
        },
        {
          cwid: "bbb2002",
          protocolNumber: "P-active-a",
          role: "Investigator",
          trial: trial({ title: "A first active trial", status: "Recruiting" }),
        },
      ],
    });
    const rows = await loadClinicalTrialsReport(client, CENTER);
    expect(rows.map((r) => r.protocolNumber)).toEqual([
      "P-active-a", // Anders, active, "A first..."
      "P-active-b", // Anders, active, "B second..."
      "P-completed", // Zimmer, not active
    ]);
  });

  it("keeps withdrawn trials (unlike the public profile section) — no status filtering", async () => {
    const client = fakeClient({
      memberships: [{ cwid: "aaa1001", startDate: null, endDate: null }],
      scholars: [{ cwid: "aaa1001", preferredName: "Ada Faculty" }],
      links: [
        {
          cwid: "aaa1001",
          protocolNumber: "P-withdrawn",
          role: "Investigator",
          trial: trial({ title: "Withdrawn study", status: "Withdrawn" }),
        },
      ],
    });
    const rows = await loadClinicalTrialsReport(client, CENTER);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Withdrawn");
    expect(rows[0].isActive).toBe(false);
  });
});
