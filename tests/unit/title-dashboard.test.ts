/**
 * The display-titles report's listing rules (`lib/edit/title-dashboard.ts`).
 * Options come from the real `buildTitleOptions`, so a ladder change that
 * shifts who is listed shows up here.
 */
import { describe, expect, it, vi } from "vitest";

import {
  classifyTitleRow,
  findRoleConflicts,
  formatConflict,
  filterTitleDashboard,
  parseTitleDashboardParams,
} from "@/lib/edit/title-dashboard";
import { loadChairedDepartments } from "@/lib/edit/title-picker";
import { buildTitleOptions, type TitleInputs } from "@/lib/scholar-title";

const NO_ROLES = { chair: false, chief: false, centerDirector: false };

function row(inputs: Partial<TitleInputs>, opts: { override?: string; roles?: Partial<typeof NO_ROLES> } = {}) {
  const options = buildTitleOptions({
    workingTitle: null,
    chiefTitle: null,
    centerHeadTitle: null,
    edPrimaryTitle: null,
    ...inputs,
  });
  const texts = [inputs.workingTitle, inputs.edPrimaryTitle]
    .filter((t): t is string => Boolean(t))
    .map((title) => ({ title }))
    .concat(inputs.appointmentTitles ?? []);
  return classifyTitleRow(
    { cwid: "abc1234", primaryTitle: options[0]?.value ?? null, override: opts.override ?? null, options, texts, workingTitle: inputs.workingTitle ?? null },
    { ...NO_ROLES, ...opts.roles },
    "Test Person",
  );
}

describe("classifyTitleRow", () => {
  it("does not list a plain professor", () => {
    expect(row({ edPrimaryTitle: "Professor of Medicine" })).toBeNull();
  });

  it("lists a chair as leadership, with the runner-up", () => {
    const r = row(
      { edPrimaryTitle: "Professor of Surgery", appointmentTitles: [{ title: "Chair of Surgery" }] },
      { roles: { chair: true } },
    );
    expect(r?.reasons).toEqual(["leadership"]);
    expect(r?.winner?.value).toBe("Chair of Surgery");
    expect(r?.runnerUp?.value).toBe("Professor of Surgery");
  });

  it("flags two leadership candidates as contested", () => {
    const r = row(
      { edPrimaryTitle: "Associate Dean for Research", chiefTitle: "Chief, Cardiology" },
      { roles: { chief: true } },
    );
    expect(r?.reasons).toContain("contested");
  });

  it("flags a director title beaten by an endowed title as leadership lost", () => {
    const r = row({
      edPrimaryTitle: "Jane Doe Professor of Neuroscience",
      appointmentTitles: [{ title: "Director, Feil Family Institute" }],
    });
    expect(r?.reasons).toEqual(["leadershipLost"]);
  });

  it("flags a pin that drops a chair as pinned + leadership lost", () => {
    const r = row(
      { edPrimaryTitle: "Professor of Surgery", appointmentTitles: [{ title: "Chair of Surgery" }] },
      { override: "Professor of Surgery", roles: { chair: true } },
    );
    expect(r?.reasons).toEqual(["leadership", "pinned", "leadershipLost"]);
    expect(r?.pinRedundant).toBe(false);
  });

  it("marks a pin equal to the ladder's winner as redundant; an empty pin is no pin", () => {
    const inputs = { edPrimaryTitle: "Professor of Medicine", appointmentTitles: [{ title: "Chair of Medicine" }] };
    expect(row(inputs, { override: "Chair of Medicine", roles: { chair: true } })?.pinRedundant).toBe(true);
    expect(row(inputs, { override: "", roles: { chair: true } })?.pin).toBeNull();
  });

  it("flags chair text with no role, and a chair role with no chair text", () => {
    expect(row({ edPrimaryTitle: "Chair of Medicine" })?.mismatchNotes).toEqual(["Chair title, no Chair role"]);
    expect(row({ edPrimaryTitle: "Professor of Medicine" }, { roles: { chair: true } })?.mismatchNotes).toEqual([
      "Chair role, no Chair title",
    ]);
  });

  it("does not flag a chief role without chief text: the chief tier titles them", () => {
    const r = row({ edPrimaryTitle: "Professor of Medicine", chiefTitle: "Chief, Cardiology" }, { roles: { chief: true } });
    expect(r?.mismatchNotes).toEqual([]);
  });

  it("finds a chair's text in a NON-best appointment (a Dean who is also Chair)", () => {
    const r = row(
      { edPrimaryTitle: "Professor of Medicine", appointmentTitles: [{ title: "Dean of the Medical College" }, { title: "Chair of Medicine" }] },
      { roles: { chair: true } },
    );
    expect(r?.winner?.value).toBe("Dean of the Medical College");
    expect(r?.mismatchNotes).toEqual([]);
  });

  it("flags a working title claiming Chief or Chair with no role as unverified, not a mismatch", () => {
    const chief = row({ workingTitle: "Chief, Example Neurology", edPrimaryTitle: "Professor of Clinical Neurology" });
    expect(chief?.reasons).toEqual(["leadership", "unverifiedWorkingTitle"]);
    expect(chief?.mismatchNotes).toEqual([]);
    expect(chief?.unverifiedNotes).toEqual(['Working title "Chief, Example Neurology" claims Chief; no chief role']);

    // A stale "Chair of Surgery" no longer displays (the ladder ignores it),
    // but the row still surfaces so someone fixes the Web Directory.
    const chair = row({
      workingTitle: "Chair of Surgery",
      edPrimaryTitle: "Professor of Surgery",
      appointmentTitles: [{ title: "The Example Family Professor of Surgery" }],
    });
    expect(chair?.winner?.value).toBe("The Example Family Professor of Surgery");
    expect(chair?.reasons).toEqual(["unverifiedWorkingTitle"]);
  });

  it("does not flag a working-title claim the role confirms", () => {
    expect(row({ workingTitle: "Chief, Cardiology", chiefTitle: "Chief, Cardiology" }, { roles: { chief: true } })?.unverifiedNotes).toEqual([]);
    expect(row({ workingTitle: "Chair of Surgery" }, { roles: { chair: true } })?.unverifiedNotes).toEqual([]);
  });

  it("does not call a director of their own department (BMRI) a mismatch", () => {
    const r = row({
      appointmentTitles: [{ title: "Director of the Brain and Mind Research Institute", department: "Brain and Mind Research" }],
    });
    expect(r?.reasons).toEqual(["leadership"]);
  });
});

describe("filterTitleDashboard", () => {
  const chair = row({ appointmentTitles: [{ title: "Chair of Surgery" }] }, { roles: { chair: true } })!;
  const working = row({ workingTitle: "Associate Dean for Admissions", edPrimaryTitle: "Professor of Medicine" })!;
  const pinned = row({ edPrimaryTitle: "Chair of Medicine" }, { override: "Chair of Medicine", roles: { chair: true } })!;

  it("filters by winning rule, including working title and pins", () => {
    const p = (q: string) => parseTitleDashboardParams(new URLSearchParams(q));
    expect(filterTitleDashboard([chair, working, pinned], p("rule=working"))).toEqual([working]);
    expect(filterTitleDashboard([chair, working, pinned], p("rule=override"))).toEqual([pinned]);
    expect(filterTitleDashboard([chair, working, pinned], p("pinned=no"))).toEqual([chair, working]);
    expect(filterTitleDashboard([chair, working, pinned], p("reason=bogus&band=leadership"))).toHaveLength(3);
  });

  it("bands a pinned row by the pin's rank, not the ladder winner's", () => {
    const pinnedDown = row(
      { edPrimaryTitle: "Professor of Surgery", appointmentTitles: [{ title: "Chair of Surgery" }] },
      { override: "Professor of Surgery", roles: { chair: true } },
    )!;
    const p = (q: string) => parseTitleDashboardParams(new URLSearchParams(q));
    expect(filterTitleDashboard([pinnedDown], p("band=other"))).toEqual([pinnedDown]);
    expect(filterTitleDashboard([pinnedDown], p("band=leadership"))).toEqual([]);
  });
});

describe("loadChairedDepartments", () => {
  it("drops non-academic units (Graduate School, MD-PhD) and roles whose department row is gone", async () => {
    const client = {
      orgUnitRoleAssignment: {
        findMany: vi.fn(async () => [
          { cwid: "zzc0001", entityId: "D-SURG" },
          { cwid: "zzc0002", entityId: "D-GRAD" },
          { cwid: "zzc0003", entityId: "D-MDPHD" },
          { cwid: "zzc0004", entityId: "D-GONE" },
        ]),
      },
      department: {
        findMany: vi.fn(async () => [
          { code: "D-SURG", name: "Surgery" },
          { code: "D-GRAD", name: "Weill Cornell Graduate School" },
          { code: "D-MDPHD", name: "MD-PhD Program" },
        ]),
      },
    };
    const out = await loadChairedDepartments(client as never);
    expect([...out.entries()]).toEqual([["zzc0001", ["Surgery"]]]);
  });
});

describe("findRoleConflicts", () => {
  const units = [
    { entityType: "department", code: "D-SURG", name: "Surgery" },
    { entityType: "department", code: "D-NSURG", name: "Neurological Surgery" },
    { entityType: "division", code: "V-CARD1", name: "Cardiology" },
    { entityType: "division", code: "V-CARD2", name: "Cardiology" },
    { entityType: "center", code: "C-EX", name: "Example Cancer Center" },
  ];
  const a = (entityType: string, entityId: string, cwid: string, interim = false) => ({ entityType, entityId, cwid, interim });

  it("flags two holders of one unit's role on both, including interim beside permanent", () => {
    const out = findRoleConflicts({
      assignments: [a("department", "D-SURG", "zzx0001"), a("department", "D-SURG", "zzx0002", true)],
      units,
      claims: [],
    });
    expect(out.get("zzx0001")).toEqual([{ kind: "shared", role: "Chair", unit: "Surgery", others: ["zzx0002"] }]);
    expect(out.get("zzx0002")?.[0].others).toEqual(["zzx0001"]);
  });

  it("flags a stale 'Chair of Surgery' on the claimant and the current chair", () => {
    const out = findRoleConflicts({
      assignments: [a("department", "D-SURG", "zzx0002")],
      units,
      claims: [{ cwid: "zzx0001", title: "Chair of Surgery" }],
    });
    expect(out.get("zzx0001")?.[0]).toMatchObject({ kind: "claimed", unit: "Surgery", others: ["zzx0002"] });
    expect(out.get("zzx0002")?.[0]).toMatchObject({ kind: "claimedBy", others: ["zzx0001"] });
    expect(formatConflict(out.get("zzx0001")![0], (c) => `Name ${c}`)).toBe(
      'Title "Chair of Surgery" names Surgery, whose chair role is held by Name zzx0002',
    );
  });

  it("does not read 'Chair of Neurological Surgery' as a claim on Surgery, nor a holder's own title", () => {
    const out = findRoleConflicts({
      assignments: [a("department", "D-SURG", "zzx0002"), a("department", "D-NSURG", "zzx0003")],
      units,
      claims: [
        { cwid: "zzx0003", title: "Chair of Neurological Surgery" },
        { cwid: "zzx0002", title: "Chair of Surgery" },
      ],
    });
    expect(out.size).toBe(0);
  });

  it("does not flag a chief who holds the role on EITHER same-named division", () => {
    const out = findRoleConflicts({
      assignments: [a("division", "V-CARD1", "zzx0004"), a("division", "V-CARD2", "zzx0005")],
      units,
      claims: [{ cwid: "zzx0004", title: "Chief, Cardiology" }],
    });
    expect(out.size).toBe(0);
  });

  it("flags a center director claim, but never an associate director's", () => {
    const out = findRoleConflicts({
      assignments: [a("center", "C-EX", "zzx0006")],
      units,
      claims: [
        { cwid: "zzx0007", title: "Associate Director, Example Cancer Center" },
        { cwid: "zzx0008", title: "Director, Example Cancer Center" },
      ],
    });
    expect([...out.keys()].sort()).toEqual(["zzx0006", "zzx0008"]);
  });
});
