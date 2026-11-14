/**
 * Ithaca ORCID plan, step 1: Cornell Ithaca scholar rows and ED's side of the
 * hand-off (ED prunes WCM rows only, claims an Ithaca row when the person joins WCM).
 */
import { describe, expect, it, vi } from "vitest";

const { mockScholarUpdate, mockSlugHistoryUpsert, mockScholarFindUnique } = vi.hoisted(() => ({
  mockScholarUpdate: vi.fn(),
  mockSlugHistoryUpsert: vi.fn(),
  mockScholarFindUnique: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    write: {
      scholar: { findUnique: mockScholarFindUnique, update: mockScholarUpdate },
      slugHistory: { upsert: mockSlugHistoryUpsert },
    },
  },
}));

import { departedWcmScholars, ithacaRowAction, maybeUpdatedSlug } from "@/etl/ed/index";
import { HIDDEN_ROLE_CATEGORIES, ITHACA_ROLES, isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";
import { planRoster, roleOf, toPeople, type RosterRow } from "@/etl/ithaca-roster/plan";

const row = (over: Partial<RosterRow>): RosterRow => ({
  netid: "ab12",
  name: null,
  name_first: "Ann",
  name_last: "Bee",
  email: "ab12@cornell.edu",
  primary_department: "Chemistry",
  primary_job_title: "Professor",
  affiliations_all: null,
  is_active_employee: 1,
  is_faculty: 0,
  is_rte_faculty: 0,
  is_postdoc: 0,
  is_student_grad_all: 0,
  hr_title: null,
  hr_track: null,
  display_name: null,
  given_name: null,
  surname: null,
  ...over,
});

describe("roleOf: the agreed population, first match wins", () => {
  it("assigns each in-scope bucket", () => {
    expect(roleOf(row({ is_faculty: 1 }))).toBe("ithaca_faculty");
    expect(roleOf(row({ is_faculty: 1, is_active_employee: 0, affiliations_all: "emeritusretiree" }))).toBe(
      "ithaca_emeritus",
    );
    expect(roleOf(row({ is_faculty: 1, hr_title: "Professor Emeritus" }))).toBe("ithaca_emeritus");
    expect(roleOf(row({ is_rte_faculty: 1, is_student_grad_all: 1 }))).toBe("ithaca_rte_faculty");
    expect(roleOf(row({ is_postdoc: 1 }))).toBe("ithaca_postdoc");
    expect(roleOf(row({ hr_track: "Non Faculty", hr_title: "Research Associate Sr" }))).toBe("ithaca_researcher");
    expect(roleOf(row({ is_student_grad_all: 1 }))).toBe("ithaca_student_grad");
  });
  it("leaves out departed faculty, extension staff and everyone else", () => {
    expect(roleOf(row({ is_faculty: 1, is_active_employee: 0, affiliations_all: "alumni" }))).toBeNull();
    expect(roleOf(row({ hr_track: "Non Faculty", hr_title: "Extension Associate" }))).toBeNull();
    expect(roleOf(row({}))).toBeNull();
  });
});

describe("toPeople", () => {
  it("falls back to the directory name, keeps Cornell emails only, skips the nameless", () => {
    const { people, nameless } = toPeople([
      row({ netid: "AB12", is_faculty: 1, name_first: null, name_last: null, given_name: "Ann", surname: "Bee", display_name: "Ann B. Bee" }),
      row({ netid: "cd34", is_postdoc: 1, email: "cd34@med.cornell.edu" }),
      row({ netid: "ef56", is_postdoc: 1, name_first: null, name_last: null }),
      row({ netid: "gh78" }),
    ]);
    expect(nameless).toBe(1);
    expect(people.map((p) => [p.cwid, p.preferredName, p.fullName, p.email])).toEqual([
      ["ab12", "Ann Bee", "Ann B. Bee", "ab12@cornell.edu"],
      ["cd34", "Ann Bee", "Ann Bee", null],
    ]);
  });
});

describe("planRoster", () => {
  const { people } = toPeople([
    row({ netid: "new1", is_faculty: 1 }),
    row({ netid: "ith1", is_faculty: 1 }),
    row({ netid: "ith2", is_faculty: 1 }),
    row({ netid: "left1", is_faculty: 1 }),
    row({ netid: "wcm1", is_faculty: 1 }),
  ]);
  const gone = new Date("2026-11-01");
  const plan = planRoster(people, [
    { cwid: "ith1", campus: "ithaca", deletedAt: null },
    { cwid: "ith2", campus: "ithaca", deletedAt: gone },
    { cwid: "left1", campus: "wcm", deletedAt: gone },
    { cwid: "wcm1", campus: "wcm", deletedAt: null },
    { cwid: "old1", campus: "ithaca", deletedAt: null },
    { cwid: "old2", campus: "ithaca", deletedAt: gone },
    { cwid: "wcm2", campus: "wcm", deletedAt: null },
  ]);
  it("creates new people and refreshes Ithaca rows", () => {
    expect(plan.create.map((p) => p.cwid)).toEqual(["new1"]);
    expect(plan.update.map((u) => [u.person.cwid, u.revive])).toEqual([
      ["ith1", false],
      ["ith2", true],
    ]);
  });
  it("never touches a WCM row, live or departed, and prunes only live Ithaca rows", () => {
    expect(plan.wcmOwned).toBe(2);
    expect(plan.prune).toEqual(["old1"]);
  });
});

describe("ED's side", () => {
  it("prunes live WCM rows missing from ED, never Ithaca rows", () => {
    const rows = [
      { cwid: "w1", campus: "wcm", deletedAt: null },
      { cwid: "w2", campus: "wcm", deletedAt: null },
      { cwid: "w3", campus: "wcm", deletedAt: new Date() },
      { cwid: "i1", campus: "ithaca", deletedAt: null },
    ];
    expect(departedWcmScholars(rows, new Set(["w1"])).map((r) => r.cwid)).toEqual(["w2"]);
  });
  it("claims an Ithaca row, except for an alumnus", () => {
    expect(ithacaRowAction({ campus: "ithaca" }, "full_time_faculty")).toBe("claim");
    expect(ithacaRowAction({ campus: "ithaca" }, "affiliate_alumni")).toBe("leave");
    expect(ithacaRowAction({ campus: "wcm" }, "full_time_faculty")).toBeNull();
    expect(ithacaRowAction(undefined, "full_time_faculty")).toBeNull();
  });
  it("re-mints the ithaca- slug of a claimed row from the name", async () => {
    mockScholarUpdate.mockResolvedValue({});
    mockSlugHistoryUpsert.mockResolvedValue({});
    mockScholarFindUnique.mockResolvedValue({ cwid: "ab12", slug: "ithaca-ab12" });
    await maybeUpdatedSlug("ithaca-ab12", "Ann Bee", "ab12", new Set(["ithaca-ab12"]), new Set());
    expect(mockScholarUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cwid: "ab12" }, data: expect.objectContaining({ slug: "ann-bee" }) }),
    );
  });
});

describe("Ithaca roles are hidden", () => {
  it("every Ithaca role fails the public carve", () => {
    for (const r of ITHACA_ROLES) {
      expect(isPubliclyDisplayed(r)).toBe(false);
      expect(HIDDEN_ROLE_CATEGORIES).toContain(r);
    }
    expect(JSON.stringify(publicRoleWhere())).toContain("ithaca_student_grad");
  });
});
