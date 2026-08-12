/**
 * `lib/api/unit-edit-context.ts` — the suppression-OFF read for the
 * unit-curation `/edit/*` pages (#540 Phase 7). Exercises the override-merge,
 * the role + retire gates, the access/roster gating, and the department
 * sibling-divisions block. `getEffectiveUnitRole` (Phase 2) is NOT mocked —
 * the fake client's `unitAdmin.findMany` serves both it and the access query,
 * branching on the `where.cwid` discriminator.
 */
import { describe, expect, it, vi } from "vitest";

import { loadUnitEditContext } from "@/lib/api/unit-edit-context";

type AnyMock = ReturnType<typeof vi.fn>;
type Client = Parameters<typeof loadUnitEditContext>[3];

const CURATOR = { cwid: "cur001", isSuperuser: false, isCommsSteward: false };
const OWNER = { cwid: "own001", isSuperuser: false, isCommsSteward: false };
const NONADMIN = { cwid: "non001", isSuperuser: false, isCommsSteward: false };
const SUPERUSER = { cwid: "sup001", isSuperuser: true, isCommsSteward: false };

type Opts = {
  department?: unknown;
  division?: unknown;
  center?: unknown;
  /** Role rows keyed by the actor (returned by getEffectiveUnitRole's findMany). */
  roleRows?: Array<{ entityType: string; entityId: string; role: "owner" | "curator" }>;
  accessRows?: Array<{ cwid: string; role: "owner" | "curator"; grantedBy: string | null; createdAt: Date }>;
  overrides?: Array<{ fieldName: string; value: string }>;
  suppression?: { id: string; createdAt: Date; createdBy: string } | null;
  /** `deletedAt` mirrors the real `resolveScholarNames` select — omit it for a
   *  currently-employed scholar, set a Date for one the ED ETL soft-deleted. */
  scholars?: Array<{
    cwid: string;
    preferredName: string;
    primaryTitle: string | null;
    deletedAt?: Date | null;
  }>;
  siblings?: Array<{ code: string; name: string; slug: string }>;
  centerMembers?: Array<{
    cwid: string;
    source: string;
    membershipType?: "research" | "clinical" | null;
    programCode?: string | null;
    startDate?: Date | null;
    endDate?: Date | null;
  }>;
  centerPrograms?: Array<{
    code: string;
    label: string;
    sortOrder: number;
    description: string | null;
    leaders: Array<{ cwid: string; interim: boolean; role?: string; sortOrder: number }>;
  }>;
  divisionMembers?: Array<{ cwid: string; source: string }>;
  diseaseAssignments?: Array<{
    cwid: string;
    diseaseCode: string;
    rank: number;
    focus: string;
    confidence: string;
    leadPubs: number;
    secondPubs: number;
    middlePubs: number;
    grantsLed: number;
    grantsSupport: number;
    trialsLed: number;
    trialsSupport: number;
    pubScore: number;
    score: number;
    firstYear: number | null;
    lastYear: number | null;
    recentPubs: number;
    specialtyStatus: string;
  }>;
  diseaseDecisions?: Array<{
    cwid: string;
    diseaseCode: string;
    decision: string;
    decidedBy: string;
    decidedAt: Date;
    scoreAtDecision: number;
    confidenceAtDecision: string;
  }>;
};

function fakeClient(o: Opts) {
  const unitAdminFindMany: AnyMock = vi.fn((args: { where: { cwid?: string } }) =>
    // getEffectiveUnitRole passes `where.cwid`; the access query does not.
    Promise.resolve(args.where.cwid !== undefined ? (o.roleRows ?? []) : (o.accessRows ?? [])),
  );
  return {
    department: { findUnique: vi.fn().mockResolvedValue(o.department ?? null) },
    division: {
      findUnique: vi.fn().mockResolvedValue(o.division ?? null),
      findMany: vi.fn().mockResolvedValue(o.siblings ?? []),
    },
    center: { findUnique: vi.fn().mockResolvedValue(o.center ?? null) },
    unitAdmin: { findMany: unitAdminFindMany },
    fieldOverride: { findMany: vi.fn().mockResolvedValue(o.overrides ?? []) },
    suppression: { findFirst: vi.fn().mockResolvedValue(o.suppression ?? null) },
    scholar: { findMany: vi.fn().mockResolvedValue(o.scholars ?? []) },
    centerMembership: { findMany: vi.fn().mockResolvedValue(o.centerMembers ?? []) },
    centerProgram: { findMany: vi.fn().mockResolvedValue(o.centerPrograms ?? []) },
    divisionMembership: { findMany: vi.fn().mockResolvedValue(o.divisionMembers ?? []) },
    cancerCenterDiseaseAssignment: { findMany: vi.fn().mockResolvedValue(o.diseaseAssignments ?? []) },
    cancerCenterDiseaseDecision: { findMany: vi.fn().mockResolvedValue(o.diseaseDecisions ?? []) },
  };
}

const asClient = (c: ReturnType<typeof fakeClient>) => c as unknown as Client;

const DEPT = {
  code: "N1280",
  name: "Medicine",
  description: "ETL blurb",
  url: null,
  slug: "medicine",
  chairCwid: "chr001",
  source: "ED",
};

describe("loadUnitEditContext — existence + gates", () => {
  it("returns null when the unit does not exist", async () => {
    const ctx = await loadUnitEditContext("department", "nope", SUPERUSER, asClient(fakeClient({})));
    expect(ctx).toBeNull();
  });

  it("returns null when a non-admin (non-superuser) has no role", async () => {
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      NONADMIN,
      asClient(fakeClient({ department: DEPT, roleRows: [] })),
    );
    expect(ctx).toBeNull();
  });

  it("a retired unit is hidden from a non-superuser but visible to a superuser", async () => {
    const suppression = { id: "s1", createdAt: new Date("2026-05-01"), createdBy: "sup001" };
    const hidden = await loadUnitEditContext(
      "department",
      "N1280",
      OWNER,
      asClient(
        fakeClient({ department: DEPT, roleRows: [{ entityType: "department", entityId: "N1280", role: "owner" }], suppression }),
      ),
    );
    expect(hidden).toBeNull();

    const seen = await loadUnitEditContext(
      "department",
      "N1280",
      SUPERUSER,
      asClient(fakeClient({ department: DEPT, suppression })),
    );
    expect(seen).not.toBeNull();
    expect(seen!.unit.suppression).toEqual({
      id: "s1",
      suppressedAt: suppression.createdAt,
      actorCwid: "sup001",
    });
  });
});

describe("loadUnitEditContext — department", () => {
  it("merges a description override and lists sibling divisions", async () => {
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      CURATOR,
      asClient(
        fakeClient({
          department: DEPT,
          roleRows: [{ entityType: "department", entityId: "N1280", role: "curator" }],
          overrides: [
            { fieldName: "description", value: "Curated blurb" },
            { fieldName: "url", value: "https://medicine.weill.cornell.edu" },
            { fieldName: "slug", value: "internal-med" },
          ],
          siblings: [{ code: "N2856", name: "Cardiology", slug: "cardiology" }],
        }),
      ),
    );
    expect(ctx!.unit.description).toBe("Curated blurb");
    expect(ctx!.unit.overriddenFields).toContain("description");
    // #1021 — the url override merges through and is listed as overridden.
    expect(ctx!.unit.url).toBe("https://medicine.weill.cornell.edu");
    expect(ctx!.unit.overriddenFields).toContain("url");
    // slug override is surfaced separately (and excluded from overriddenFields —
    // it is not runtime-merged into the live slug; the ETL consults it).
    expect(ctx!.unit.slug).toBe("medicine");
    expect(ctx!.unit.slugOverride).toBe("internal-med");
    expect(ctx!.unit.overriddenFields).not.toContain("slug");
    expect(ctx!.actorRole).toBe("curator");
    expect(ctx!.siblingDivisions).toEqual([{ code: "N2856", name: "Cardiology", slug: "cardiology" }]);
    // roster + access are not available to a curator on a department.
    expect(ctx!.roster).toBeNull();
    expect(ctx!.access).toBeNull();
  });

  it("an Owner sees the access array; resolves grantee names from Scholar", async () => {
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      OWNER,
      asClient(
        fakeClient({
          department: DEPT,
          roleRows: [{ entityType: "department", entityId: "N1280", role: "owner" }],
          accessRows: [
            { cwid: "cur001", role: "curator", grantedBy: "own001", createdAt: new Date("2026-05-02") },
            { cwid: "staff9", role: "curator", grantedBy: "own001", createdAt: new Date("2026-05-03") },
          ],
          scholars: [{ cwid: "cur001", preferredName: "Casey Curator", primaryTitle: "MD" }],
        }),
      ),
    );
    expect(ctx!.actorRole).toBe("owner");
    expect(ctx!.access).toHaveLength(2);
    // resolved from Scholar
    expect(ctx!.access![0]).toMatchObject({ cwid: "cur001", name: "Casey Curator", title: "MD", role: "curator" });
    // a non-Scholar grantee falls back to the cwid (the access card re-resolves it).
    expect(ctx!.access![1]).toMatchObject({ cwid: "staff9", name: "staff9", title: null });
  });

  it("resolves the leader chip from Scholar", async () => {
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      SUPERUSER,
      asClient(
        fakeClient({
          department: DEPT,
          scholars: [{ cwid: "chr001", preferredName: "Dana Chair", primaryTitle: "MD, PhD" }],
        }),
      ),
    );
    expect(ctx!.unit.leader).toMatchObject({ cwid: "chr001", name: "Dana Chair", title: "MD, PhD", interim: false });
    expect(ctx!.unit.leader.explicitVacancy).toBe(false);
  });

  it("an explicit-vacancy override yields a null leader cwid + explicitVacancy", async () => {
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      SUPERUSER,
      asClient(fakeClient({ department: DEPT, overrides: [{ fieldName: "leaderCwid", value: "" }] })),
    );
    expect(ctx!.unit.leader.cwid).toBeNull();
    expect(ctx!.unit.leader.explicitVacancy).toBe(true);
  });
});

describe("loadUnitEditContext — roster scholarState (#2324)", () => {
  const manualDivision = {
    code: "N9001",
    name: "New Division",
    description: null,
    slug: "new-division",
    chiefCwid: null,
    source: "manual",
    deptCode: "N1280",
    department: { name: "Medicine", slug: "medicine" },
  };

  async function rosterFor(
    members: Array<{ cwid: string; source: string }>,
    scholars: Array<{
      cwid: string;
      preferredName: string;
      primaryTitle: string | null;
      deletedAt: Date | null;
    }>,
  ) {
    const ctx = await loadUnitEditContext(
      "division",
      "N9001",
      SUPERUSER,
      asClient(
        fakeClient({ division: manualDivision, divisionMembers: members, scholars }),
      ),
    );
    return ctx!.roster!;
  }

  it("a soft-deleted scholar is `departed` and KEEPS their name", async () => {
    // The bug this fixes: the ED ETL soft-deletes departures (deletedAt), and
    // resolveScholarNames does not filter on it — so before this, a person who
    // left WCM rendered as an ordinary member with no signal whatsoever. The
    // name must survive (the roster is a historical record) while the STATE
    // changes.
    const roster = await rosterFor(
      [{ cwid: "gone1", source: "manual-ui" }],
      [
        {
          cwid: "gone1",
          preferredName: "Gone Person",
          primaryTitle: "Professor",
          deletedAt: new Date("2026-01-15"),
        },
      ],
    );
    expect(roster[0].scholarState).toBe("departed");
    expect(roster[0].name).toBe("Gone Person");
    expect(roster[0].title).toBe("Professor");
  });

  it("a cwid with NO scholar row is `unknown`, and the name still falls back to the cwid", async () => {
    const roster = await rosterFor([{ cwid: "ghost1", source: "manual-ui" }], []);
    expect(roster[0].scholarState).toBe("unknown");
    expect(roster[0].name).toBe("ghost1");
  });

  it("distinguishes departed from unknown in one roster", async () => {
    // These were indistinguishable before: one showed a name, one showed a bare
    // cwid, and neither said why.
    const roster = await rosterFor(
      [
        { cwid: "here1", source: "manual-ui" },
        { cwid: "gone1", source: "manual-ui" },
        { cwid: "ghost1", source: "manual-ui" },
      ],
      [
        { cwid: "here1", preferredName: "Here Person", primaryTitle: null, deletedAt: null },
        {
          cwid: "gone1",
          preferredName: "Gone Person",
          primaryTitle: null,
          deletedAt: new Date("2026-01-15"),
        },
      ],
    );
    expect(roster.map((r) => [r.cwid, r.scholarState])).toEqual([
      ["here1", "active"],
      ["gone1", "departed"],
      ["ghost1", "unknown"],
    ]);
  });

  it("the scholar lookup does NOT filter on deletedAt", async () => {
    // Guard: adding `deletedAt: null` to that where-clause would turn every
    // departure into a bare-cwid `unknown` row and destroy the history.
    const client = fakeClient({
      division: manualDivision,
      divisionMembers: [{ cwid: "gone1", source: "manual-ui" }],
      scholars: [],
    });
    await loadUnitEditContext("division", "N9001", SUPERUSER, asClient(client));
    for (const call of client.scholar.findMany.mock.calls) {
      expect(call[0].where).not.toHaveProperty("deletedAt");
    }
  });
});

describe("loadUnitEditContext — manual division roster", () => {
  it("a manual division carries a roster; an ED division does not", async () => {
    const manual = {
      code: "N9001",
      name: "New Division",
      description: null,
      slug: "new-division",
      chiefCwid: null,
      source: "manual",
      deptCode: "N1280",
      department: { name: "Medicine", slug: "medicine" },
    };
    const ctx = await loadUnitEditContext(
      "division",
      "N9001",
      SUPERUSER,
      asClient(
        fakeClient({
          division: manual,
          divisionMembers: [{ cwid: "mem001", source: "manual-ui" }],
          scholars: [
            { cwid: "mem001", preferredName: "Morgan Member", primaryTitle: null, deletedAt: null },
          ],
        }),
      ),
    );
    // A division's extended membership fields are always null (no such columns).
    expect(ctx!.roster).toEqual([
      {
        cwid: "mem001",
        name: "Morgan Member",
        title: null,
        source: "manual-ui",
        membershipType: null,
        programCode: null,
        startDate: null,
        endDate: null,
        scholarState: "active",
        diseases: [],
      },
    ]);
    expect(ctx!.unit.deptName).toBe("Medicine");
    expect(ctx!.unit.deptSlug).toBe("medicine"); // drives the division preview URL
    expect(ctx!.programs).toBeNull(); // programs are center-only
    expect(ctx!.siblingDivisions).toBeNull();

    const edDivision = { ...manual, source: "ED" };
    const edCtx = await loadUnitEditContext(
      "division",
      "N9001",
      SUPERUSER,
      asClient(fakeClient({ division: edDivision })),
    );
    expect(edCtx!.roster).toBeNull();
  });
});

describe("loadUnitEditContext — center", () => {
  it("a center reads source=manual, in-row centerType + interim, and a roster", async () => {
    const center = {
      code: "man-abc12345",
      name: "Precision Institute",
      description: "Institute blurb",
      url: "https://precision.weill.cornell.edu",
      slug: "precision-institute",
      directorCwid: "dir001",
      centerType: "institute",
      leaderInterim: true,
    };
    const ctx = await loadUnitEditContext(
      "center",
      "man-abc12345",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [
            {
              cwid: "mem9",
              source: "manual",
              membershipType: "research",
              programCode: "CT",
              startDate: new Date("2024-07-01T00:00:00.000Z"),
              endDate: null,
            },
          ],
          // Provided in DB-sorted order (the mock doesn't apply orderBy). #1117 —
          // each program carries its description + leader join rows.
          centerPrograms: [
            {
              code: "CB",
              label: "Cancer Biology",
              sortOrder: 10,
              description: "Cancer biology.",
              leaders: [
                // #1570 — an explicit liaison, plus a pre-#1570 row with no `role`.
                { cwid: "dir001", interim: false, sortOrder: 0 },
                { cwid: "liai001", interim: false, role: "coe_liaison", sortOrder: 0 },
              ],
            },
            { code: "CT", label: "Cancer Therapeutics", sortOrder: 40, description: null, leaders: [] },
          ],
          scholars: [
            { cwid: "dir001", preferredName: "Dr Director", primaryTitle: "MD" },
            { cwid: "liai001", preferredName: "Dr Liaison", primaryTitle: null },
          ],
        }),
      ),
    );
    expect(ctx!.unit.source).toBe("manual");
    expect(ctx!.unit.url).toBe("https://precision.weill.cornell.edu"); // #1021 in-row
    expect(ctx!.unit.centerType).toBe("institute");
    expect(ctx!.unit.leader).toMatchObject({ cwid: "dir001", interim: true });
    expect(ctx!.unit.overriddenFields).toEqual([]); // centers never carry field_override
    expect(ctx!.unit.slugOverride).toBeNull(); // centers edit slug in-row, no override
    // #552 — extended fields surface; dates as YYYY-MM-DD strings.
    expect(ctx!.roster).toEqual([
      {
        cwid: "mem9",
        // No scholar row in this fixture, so the name falls back to the raw cwid
        // — which is exactly the `unknown` state, now labelled instead of left
        // looking like someone whose name we simply failed to render.
        name: "mem9",
        title: null,
        source: "manual",
        membershipType: "research",
        programCode: "CT",
        startDate: "2024-07-01",
        endDate: null,
        scholarState: "unknown",
        diseases: [],
      },
    ]);
    // #552/#1117 — the program taxonomy rides along (sorted by sortOrder) with
    // each program's description + resolved leaders. #1570 — each leader carries
    // its `role`; a row written before #1570 (no `role`) narrows to "leader".
    expect(ctx!.programs).toEqual([
      {
        code: "CB",
        label: "Cancer Biology",
        sortOrder: 10,
        description: "Cancer biology.",
        leaders: [
          {
            cwid: "dir001",
            name: "Dr Director",
            title: "MD",
            interim: false,
            role: "leader",
            sortOrder: 0,
          },
          {
            cwid: "liai001",
            name: "Dr Liaison",
            title: null,
            interim: false,
            role: "coe_liaison",
            sortOrder: 0,
          },
        ],
      },
      { code: "CT", label: "Cancer Therapeutics", sortOrder: 40, description: null, leaders: [] },
    ]);
  });
});

describe("loadUnitEditContext — center disease assignments (plan §5/§6)", () => {
  const center = {
    code: "meyer",
    name: "Meyer Cancer Center",
    description: null,
    url: null,
    slug: "meyer",
    directorCwid: null,
    centerType: "center",
    leaderInterim: false,
  };
  const assignment = (over: Partial<NonNullable<Opts["diseaseAssignments"]>[number]> = {}) => ({
    cwid: "mem1",
    diseaseCode: "BREAST",
    rank: 1,
    focus: "primary",
    confidence: "medium",
    leadPubs: 5,
    secondPubs: 2,
    middlePubs: 1,
    grantsLed: 1,
    grantsSupport: 0,
    trialsLed: 0,
    trialsSupport: 1,
    pubScore: 40,
    score: 50,
    firstYear: 2019,
    lastYear: 2025,
    recentPubs: 3,
    specialtyStatus: "matched",
    ...over,
  });
  const decision = (over: Partial<NonNullable<Opts["diseaseDecisions"]>[number]> = {}) => ({
    cwid: "mem1",
    diseaseCode: "BREAST",
    decision: "confirmed",
    decidedBy: "cur001",
    decidedAt: new Date("2026-08-01"),
    scoreAtDecision: 50,
    confidenceAtDecision: "medium",
    ...over,
  });

  it("an unreviewed assignment carries a null decision and no drift", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [{ cwid: "mem1", source: "manual" }],
          diseaseAssignments: [assignment()],
        }),
      ),
    );
    expect(ctx!.roster![0].diseases).toEqual([
      { diseaseCode: "BREAST", assignment: expect.objectContaining({ rank: 1 }), decision: null, drifted: false },
    ]);
  });

  it("a rejected decision flags drift once the current row is high-confidence", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [{ cwid: "mem1", source: "manual" }],
          diseaseAssignments: [assignment({ confidence: "high" })],
          diseaseDecisions: [decision({ decision: "rejected", confidenceAtDecision: "medium" })],
        }),
      ),
    );
    expect(ctx!.roster![0].diseases![0].drifted).toBe(true);
  });

  it("a rejected decision does NOT flag when confidence stayed below high", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [{ cwid: "mem1", source: "manual" }],
          diseaseAssignments: [assignment({ confidence: "medium" })],
          diseaseDecisions: [decision({ decision: "rejected", confidenceAtDecision: "low" })],
        }),
      ),
    );
    expect(ctx!.roster![0].diseases![0].drifted).toBe(false);
  });

  it("a confirmed decision flags drift once its assignment row disappears entirely", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [{ cwid: "mem1", source: "manual" }],
          diseaseAssignments: [], // the ETL's latest full-replace dropped this pair
          diseaseDecisions: [decision({ decision: "confirmed" })],
        }),
      ),
    );
    expect(ctx!.roster![0].diseases).toEqual([
      { diseaseCode: "BREAST", assignment: null, decision: expect.objectContaining({ decision: "confirmed" }), drifted: true },
    ]);
  });

  it("a confirmed decision does NOT flag while its assignment row still exists", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [{ cwid: "mem1", source: "manual" }],
          diseaseAssignments: [assignment()],
          diseaseDecisions: [decision()],
        }),
      ),
    );
    expect(ctx!.roster![0].diseases![0].drifted).toBe(false);
  });

  it("ranks live assignments first, trailing decision-only rows by code", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [{ cwid: "mem1", source: "manual" }],
          diseaseAssignments: [assignment({ diseaseCode: "LUNG", rank: 1 }), assignment({ diseaseCode: "GYN", rank: 2 })],
          diseaseDecisions: [decision({ diseaseCode: "BREAST" })], // orphaned — no assignment row
        }),
      ),
    );
    expect(ctx!.roster![0].diseases!.map((d) => d.diseaseCode)).toEqual(["LUNG", "GYN", "BREAST"]);
  });
});
