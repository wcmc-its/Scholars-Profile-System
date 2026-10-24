/**
 * ED volunteers → the faculty member they worked with (2026-10-14): the
 * pairing rule (`pairVolunteers`) and the affiliate role-record projection
 * (`fetchAllVolunteerRoleRecords`, the option-tagged `manager;sponsor` /
 * `manager;manager` DNs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ search: vi.fn(), bind: vi.fn(), unbind: vi.fn() }));
vi.mock("ldapts", () => ({
  Client: vi.fn().mockImplementation(function () {
    return { bind: h.bind, search: h.search, unbind: h.unbind };
  }),
}));

import { pairVolunteers, syncVolunteerMentors, VOLUNTEER_MENTOR_ROLES } from "@/etl/ed/volunteers";
import { DEFAULT_AFFILIATE_SOR_BASE, fetchAllVolunteerRoleRecords, VOLUNTEER_ROLE_FILTER } from "@/lib/sources/ldap";

const rec = (o: Partial<Parameters<typeof pairVolunteers>[0][number]> & { cwid: string; sorId: string }) => ({
  status: null,
  sponsorCwid: null,
  managerCwid: null,
  startDate: null,
  endDate: null,
  ...o,
});

describe("pairVolunteers", () => {
  const FACULTY = new Set(["fac0001", "fac0002", "fac0003"]);

  it("faculty sponsor, else faculty manager; an admin sponsor or manager makes no pair; a faculty volunteer is not a mentee", () => {
    const { pairs, facultyVolunteers, noFacultyMentor } = pairVolunteers(
      [
        rec({ cwid: "vol0001", sorId: "S1", sponsorCwid: "fac0001", managerCwid: "fac0002" }),
        rec({ cwid: "vol0002", sorId: "S2", sponsorCwid: "adm0001", managerCwid: "fac0002" }),
        rec({ cwid: "vol0003", sorId: "S3", sponsorCwid: null, managerCwid: "fac0003" }),
        rec({ cwid: "vol0004", sorId: "S4", sponsorCwid: "adm0001", managerCwid: "adm0002" }),
        rec({ cwid: "vol0005", sorId: "S5" }),
        rec({ cwid: "fac0002", sorId: "S6", sponsorCwid: "fac0001" }),
      ],
      FACULTY,
    );
    expect(pairs.map((p) => [p.cwid, p.mentorCwid, p.mentorRole])).toEqual([
      ["vol0001", "fac0001", "sponsor"],
      ["vol0002", "fac0002", "manager"],
      ["vol0003", "fac0003", "manager"],
    ]);
    expect(noFacultyMentor).toBe(2);
    expect(facultyVolunteers).toBe(1);
  });
});

describe("fetchAllVolunteerRoleRecords", () => {
  const env = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SCHOLARS_LDAP_URL = "ldaps://ldap.test";
    process.env.SCHOLARS_LDAP_BIND_PASSWORD = "x";
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("searches the affiliates SOR for volunteer role records and reads the option-tagged sponsor and manager DNs", async () => {
    h.search.mockResolvedValue({
      searchEntries: [
        {
          weillCornellEduCWID: "VOL0001",
          weillCornellEduSORID: "S1",
          weillCornellEduStatus: "affiliate:active",
          "manager;sponsor": "uid=fac0001,ou=people,dc=weill,dc=cornell,dc=edu",
          "manager;manager": "uid=Fac0002,ou=people,dc=weill,dc=cornell,dc=edu",
          "manager;requester": "uid=req0001,ou=people,dc=weill,dc=cornell,dc=edu",
          weillCornellEduStartDate: "20250601000000Z",
          weillCornellEduEndDate: "20990101000000Z",
        },
        { weillCornellEduSORID: "S2" }, // no CWID: skipped
      ],
    });
    const got = await fetchAllVolunteerRoleRecords();
    expect(h.search).toHaveBeenCalledWith(
      DEFAULT_AFFILIATE_SOR_BASE,
      expect.objectContaining({ filter: VOLUNTEER_ROLE_FILTER, attributes: expect.arrayContaining(["manager"]) }),
    );
    expect(got).toEqual([
      {
        cwid: "vol0001",
        sorId: "S1",
        status: "affiliate:active",
        sponsorCwid: "fac0001",
        managerCwid: "fac0002",
        startDate: new Date("2025-06-01T00:00:00Z"),
        endDate: null, // the 2099 open-ended sentinel
      },
    ]);
    expect(h.unbind).toHaveBeenCalledTimes(1);
  });
});

describe("syncVolunteerMentors — the nightly pass never fails the ED run", () => {
  const quiet = { log: vi.fn(), warn: vi.fn() };
  const fakeDb = (o: { existing?: string[]; upsert?: () => Promise<unknown> } = {}) => ({
    scholar: { findMany: vi.fn(async () => [{ cwid: "fac0001" }, { cwid: "FAC0002" }]) },
    volunteerMentorRelationship: {
      upsert: vi.fn(o.upsert ?? (async () => ({}))),
      findMany: vi.fn(async () => (o.existing ?? []).map((externalId) => ({ externalId }))),
      deleteMany: vi.fn(async ({ where }: { where: { externalId: { in: string[] } } }) => ({ count: where.externalId.in.length })),
    },
  });
  const RECORDS = [
    rec({ cwid: "vol0001", sorId: "S1", sponsorCwid: "fac0001", status: "affiliate:active" }),
    rec({ cwid: "vol0002", sorId: "S2", sponsorCwid: "adm0001", managerCwid: "fac0002" }),
  ];
  const names = async () =>
    new Map([["vol0001", { firstName: "Val", lastName: "x".repeat(80) }]]);
  type UpsertArg = { where: { externalId: string }; create: Record<string, unknown>; update: Record<string, unknown> };
  const upserts = (db: ReturnType<typeof fakeDb>) =>
    db.volunteerMentorRelationship.upsert.mock.calls.map((c) => (c as unknown as [UpsertArg])[0]);

  beforeEach(() => vi.clearAllMocks());

  it("pairs against faculty INCLUDING former faculty (no deletedAt / status filter), upserts by SORID, tombstones what ED dropped", async () => {
    // Ten more records ED still returns, so one stale row is under the 20% cap.
    const more = Array.from({ length: 10 }, (_, i) => rec({ cwid: `vok000${i}`, sorId: `K${i}`, sponsorCwid: "fac0001" }));
    const db = fakeDb({
      existing: ["ED-VOLUNTEER-S1", "ED-VOLUNTEER-S2", ...more.map((r) => `ED-VOLUNTEER-${r.sorId}`), "ED-VOLUNTEER-GONE"],
    });
    await syncVolunteerMentors({ db: db as never, fetchRecords: async () => [...RECORDS, ...more], fetchNames: names, log: quiet });
    expect(db.scholar.findMany).toHaveBeenCalledWith({
      where: { roleCategory: { in: [...VOLUNTEER_MENTOR_ROLES] } },
      select: { cwid: true },
    });
    const [first, second] = upserts(db);
    expect(first.where).toEqual({ externalId: "ED-VOLUNTEER-S1" });
    expect(first.create).toMatchObject({ mentorCwid: "fac0001", menteeCwid: "vol0001", mentorRole: "sponsor", menteeFirstName: "Val", status: "affiliate:active" });
    expect((first.create.menteeLastName as string).length).toBe(64); // clipped to the column
    // A former-faculty manager still counts (the Scholar row's cwid is matched case-insensitively).
    expect(second.create).toMatchObject({ mentorCwid: "fac0002", mentorRole: "manager" });
    expect(db.volunteerMentorRelationship.deleteMany).toHaveBeenCalledWith({
      where: { externalId: { in: ["ED-VOLUNTEER-GONE"] } },
    });
  });

  it("a name the lookup did not return is never written over — a failed lookup keeps every stored name", async () => {
    const db = fakeDb();
    await syncVolunteerMentors({ db: db as never, fetchRecords: async () => RECORDS, fetchNames: names, log: quiet });
    const second = upserts(db)[1]; // vol0002: not in the lookup result
    expect(second.update).not.toHaveProperty("menteeFirstName");
    expect(second.update).not.toHaveProperty("menteeLastName");

    const db2 = fakeDb();
    await syncVolunteerMentors({
      db: db2 as never,
      fetchRecords: async () => RECORDS,
      fetchNames: async () => {
        throw new Error("0x20");
      },
      log: quiet,
    });
    for (const u of upserts(db2)) expect(u.update).not.toHaveProperty("menteeFirstName");
  });

  it("a failed or empty fetch changes nothing", async () => {
    for (const fetchRecords of [async () => [], async () => Promise.reject(new Error("ldap down"))]) {
      const db = fakeDb({ existing: ["ED-VOLUNTEER-S1"] });
      await expect(syncVolunteerMentors({ db: db as never, fetchRecords, fetchNames: names, log: quiet })).resolves.toBeUndefined();
      expect(db.scholar.findMany).not.toHaveBeenCalled();
      expect(db.volunteerMentorRelationship.deleteMany).not.toHaveBeenCalled();
    }
  });

  it("a row error (the table missing on a night the migration has not run) ends the pass before its tombstone — never a throw", async () => {
    const db = fakeDb({
      existing: ["ED-VOLUNTEER-OLD"],
      upsert: async () => {
        throw new Error("P2021 table does not exist");
      },
    });
    await expect(
      syncVolunteerMentors({ db: db as never, fetchRecords: async () => RECORDS, fetchNames: names, log: quiet }),
    ).resolves.toBeUndefined();
    expect(db.volunteerMentorRelationship.upsert).toHaveBeenCalledTimes(1);
    expect(db.volunteerMentorRelationship.deleteMany).not.toHaveBeenCalled();
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining("volunteer pass skipped"));
  });

  it("a tombstone over 20% of rows (a feed scoped to active records) is skipped, not run", async () => {
    const db = fakeDb({ existing: ["ED-VOLUNTEER-S1", "ED-VOLUNTEER-S2", "ED-VOLUNTEER-A", "ED-VOLUNTEER-B"] });
    await syncVolunteerMentors({ db: db as never, fetchRecords: async () => RECORDS, fetchNames: names, log: quiet });
    expect(db.volunteerMentorRelationship.deleteMany).not.toHaveBeenCalled();
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining("tombstone skipped"));
  });
});

