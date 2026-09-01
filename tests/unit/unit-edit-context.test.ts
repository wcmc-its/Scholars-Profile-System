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
// 2026-08-26 policy widening (decision #3) — full access-management parity,
// with NO unit_admin row of their own.
const STEWARD = { cwid: "stw001", isSuperuser: false, isCommsSteward: true };

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
  }>;
  /** #2558 — a program's leaders, now `OrgUnitRoleAssignment` rows
   *  (`entityType: "center_program"`, `entityId: "{centerCode}:{programCode}"`),
   *  not a nested `CenterProgram.leaders` relation (the retired per-program
   *  leader table this migrated off of). */
  programAssignments?: Array<{
    entityId: string;
    cwid: string;
    interim: boolean;
    roleKey?: string;
    sortOrder: number;
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
    /** null for a manual add (no backing assignment row to snapshot). */
    scoreAtDecision: number | null;
    confidenceAtDecision: string | null;
  }>;
  /** #2542 — the center's director assignment, from its own query. */
  leaderAssignment?: { cwid: string; interim: boolean } | null;
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
    // #2542 / #2558 — leadership is an `OrgUnitRoleAssignment` row fetched with
    // its own query; it used to be a nested `leaders` relation on `center` /
    // `centerProgram`. `findMany` dispatches by `where.entityType`: the
    // director query (`findFirst`) is separate, so `findMany` here only ever
    // serves the `center_program` program-leadership query.
    orgUnitRoleAssignment: {
      findFirst: vi.fn(async () => o.leaderAssignment ?? null),
      findMany: vi.fn(async (args?: { where?: { entityType?: string } }) =>
        args?.where?.entityType === "center_program" ? (o.programAssignments ?? []) : [],
      ),
    },
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

  // 2026-08-26 policy widening (decision #3) — a comms_steward with NO
  // unit_admin row of their own still sees the access array (full grant
  // parity, uniform across unit kinds); `actorRole` still floors at
  // "curator" for content-editing rail filtering, which is a separate signal
  // from access management (`components/edit/unit-edit-page.tsx` gates the
  // Access tab on `ctx.access !== null`, not on `actorRole`).
  it("a comms_steward with no unit_admin row still sees the access array", async () => {
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      STEWARD,
      asClient(
        fakeClient({
          department: DEPT,
          roleRows: [],
          accessRows: [
            { cwid: "own001", role: "owner", grantedBy: "sup001", createdAt: new Date("2026-05-02") },
          ],
        }),
      ),
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.actorRole).toBe("curator");
    expect(ctx!.access).toHaveLength(1);
    expect(ctx!.access![0]).toMatchObject({ cwid: "own001", role: "owner" });
  });

  it("resolves the leader chip from Scholar", async () => {
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      SUPERUSER,
      asClient(
        fakeClient({
          department: DEPT,
          // #2542 contract A — the department's chair/director assignment,
          // from its own query (was `Department.chairCwid`).
          leaderAssignment: { cwid: "chr001", interim: false },
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

  // #2542 contract A — dept/div carry no `leaderInterim` column; the assignment
  // row's own `interim` flag is the fallback, exactly as `resolveUnitLeader`
  // (`lib/api/unit-leader.ts`) documents.
  it("an interim assignment renders interim when no leaderInterim override exists", async () => {
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      SUPERUSER,
      asClient(
        fakeClient({
          department: DEPT,
          leaderAssignment: { cwid: "chr001", interim: true },
          scholars: [{ cwid: "chr001", preferredName: "Dana Chair", primaryTitle: "MD, PhD" }],
        }),
      ),
    );
    expect(ctx!.unit.leader.interim).toBe(true);
  });

  it("a leaderInterim override wins over the assignment row's own interim flag", async () => {
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      SUPERUSER,
      asClient(
        fakeClient({
          department: DEPT,
          leaderAssignment: { cwid: "chr001", interim: true },
          overrides: [{ fieldName: "leaderInterim", value: "false" }],
          scholars: [{ cwid: "chr001", preferredName: "Dana Chair", primaryTitle: "MD, PhD" }],
        }),
      ),
    );
    expect(ctx!.unit.leader.interim).toBe(false);
  });
});

describe("loadUnitEditContext — roster scholarState (#2324)", () => {
  const manualDivision = {
    code: "N9001",
    name: "New Division",
    description: null,
    slug: "new-division",
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
      centerType: "institute",
    };
    // #2542 — leadership is an `OrgUnitRoleAssignment` row from its own query.
    const ctx = await loadUnitEditContext(
      "center",
      "man-abc12345",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          leaderAssignment: { cwid: "dir001", interim: true },
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
          // each program carries its description; leaders are a separate
          // `OrgUnitRoleAssignment` query (#2558), grouped by `entityId` below.
          centerPrograms: [
            { code: "CB", label: "Cancer Biology", sortOrder: 10, description: "Cancer biology." },
            { code: "CT", label: "Cancer Therapeutics", sortOrder: 40, description: null },
          ],
          // #1570 — an explicit liaison, plus a pre-#1570 row with no `roleKey`.
          programAssignments: [
            { entityId: "man-abc12345:CB", cwid: "dir001", interim: false, sortOrder: 0 },
            {
              entityId: "man-abc12345:CB",
              cwid: "liai001",
              interim: false,
              roleKey: "coe_liaison",
              sortOrder: 0,
            },
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
    // each program's description + resolved leaders (#2558 — grouped from the
    // `OrgUnitRoleAssignment` query by `entityId`). #1570 — each leader carries
    // its `role`; a row with no `roleKey` narrows to "leader".
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
    centerType: "center",
    leaders: [],
  };
  // A stand-in `CenterProgram` taxonomy — the gate these tests all run under
  // (bug fix, staging report 2026-08-26): `diseases` only ever populates for a
  // center that has one, see the dedicated describe block below.
  const PROGRAMS: NonNullable<Opts["centerPrograms"]> = [
    { code: "BR", label: "Breast", sortOrder: 1, description: null },
  ];
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
          centerPrograms: PROGRAMS,
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
          centerPrograms: PROGRAMS,
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
          centerPrograms: PROGRAMS,
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
          centerPrograms: PROGRAMS,
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
          centerPrograms: PROGRAMS,
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
          centerPrograms: PROGRAMS,
          diseaseAssignments: [assignment({ diseaseCode: "LUNG", rank: 1 }), assignment({ diseaseCode: "GYN", rank: 2 })],
          diseaseDecisions: [decision({ diseaseCode: "BREAST" })], // orphaned — no assignment row
        }),
      ),
    );
    expect(ctx!.roster![0].diseases!.map((d) => d.diseaseCode)).toEqual(["LUNG", "GYN", "BREAST"]);
  });

  it("manual add (plan's manual-add extension): a decision with NO matching assignment row still produces a diseases entry — assignment null, decision populated with a null score/confidence snapshot", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [{ cwid: "mem1", source: "manual" }],
          centerPrograms: PROGRAMS,
          // No assignment rows at all for this member — the generator never
          // suggested BREAST for them — only a curator's manual-add decision.
          diseaseAssignments: [],
          diseaseDecisions: [
            decision({ scoreAtDecision: null, confidenceAtDecision: null }),
          ],
        }),
      ),
    );
    expect(ctx!.roster![0].diseases).toEqual([
      {
        diseaseCode: "BREAST",
        assignment: null,
        decision: expect.objectContaining({
          decision: "confirmed",
          scoreAtDecision: null,
          confidenceAtDecision: null,
        }),
        // NOT drifted: a manual add never had an assignment row to lose —
        // `confidenceAtDecision: null` is the "never had evidence" signal
        // `isDiseaseDecisionDrifted` uses to tell this apart from a real
        // confirmed decision whose evidence later disappeared (§6).
        drifted: false,
      },
    ]);
  });

  it("bug fix (staging report 2026-08-26): a center with NO CenterProgram taxonomy gets an empty diseases list even though its roster members DO have assignment/decision rows — a Cancer-Center-adjacent center (e.g. Health Equity) must not inherit shared members' disease data", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [{ cwid: "mem1", source: "manual" }],
          centerPrograms: [], // no program taxonomy — not the Cancer Center
          diseaseAssignments: [assignment()],
          diseaseDecisions: [decision()],
        }),
      ),
    );
    expect(ctx!.roster![0].diseases).toEqual([]);
  });

  it("control: a center WITH a CenterProgram taxonomy still gets its diseases populated", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerMembers: [{ cwid: "mem1", source: "manual" }],
          centerPrograms: PROGRAMS,
          diseaseAssignments: [assignment()],
          diseaseDecisions: [decision()],
        }),
      ),
    );
    expect(ctx!.roster![0].diseases).not.toEqual([]);
  });
});

describe("loadUnitEditContext — diseaseOptions (manual-add extension)", () => {
  const center = {
    code: "meyer",
    name: "Meyer Cancer Center",
    description: null,
    url: null,
    slug: "meyer",
    centerType: "center",
    leaders: [],
  };

  it("a center WITH a CenterProgram taxonomy carries the canonical disease-code -> label list, sorted by label", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(
        fakeClient({
          center,
          centerPrograms: [{ code: "BR", label: "Breast", sortOrder: 1, description: null }],
        }),
      ),
    );
    expect(ctx!.diseaseOptions).not.toBeNull();
    expect(ctx!.diseaseOptions!.length).toBeGreaterThan(0);
    // One real, known code from `docs/cancer-center-person-rollup.csv`.
    expect(ctx!.diseaseOptions).toContainEqual({ code: "BREAST", label: "Breast Cancer" });
    // Sorted by label — every entry's label is <= the next one's.
    const labels = ctx!.diseaseOptions!.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("bug fix (staging report 2026-08-26): a center with NO CenterProgram taxonomy gets no manual-add picker payload — diseaseOptions is null", async () => {
    const ctx = await loadUnitEditContext(
      "center",
      "meyer",
      SUPERUSER,
      asClient(fakeClient({ center, centerPrograms: [] })),
    );
    expect(ctx!.diseaseOptions).toBeNull();
  });

  it("is null for a department/division — not a center", async () => {
    const dept = {
      code: "N1280",
      name: "Medicine",
      description: null,
      url: null,
      slug: "medicine",
      source: "ED",
    };
    const ctx = await loadUnitEditContext(
      "department",
      "N1280",
      SUPERUSER,
      asClient(fakeClient({ department: dept })),
    );
    expect(ctx!.diseaseOptions).toBeNull();
  });
});
