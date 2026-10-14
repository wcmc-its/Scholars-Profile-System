/**
 * ED volunteers → the faculty member they worked with (2026-10-14): the
 * pairing rule (`pairVolunteers`) and the affiliate role-record projection
 * (`fetchAllVolunteerRoleRecords`, the option-tagged `manager;sponsor` /
 * `manager;manager` DNs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ search: vi.fn(), bind: vi.fn(), unbind: vi.fn() }));
vi.mock("ldapts", () => ({
  Client: vi.fn().mockImplementation(() => ({ bind: h.bind, search: h.search, unbind: h.unbind })),
}));

import { pairVolunteers } from "@/etl/ed/volunteers";
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
