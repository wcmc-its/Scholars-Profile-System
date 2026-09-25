/**
 * The display-titles report's listing rules (`lib/edit/title-dashboard.ts`).
 * Options come from the real `buildTitleOptions`, so a ladder change that
 * shifts who is listed shows up here.
 */
import { describe, expect, it } from "vitest";

import {
  classifyTitleRow,
  filterTitleDashboard,
  parseTitleDashboardParams,
} from "@/lib/edit/title-dashboard";
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
  return classifyTitleRow(
    { cwid: "abc1234", primaryTitle: options[0]?.value ?? null, override: opts.override ?? null, options },
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

  it("flags a chief role with no chief text, and chair text with no role", () => {
    expect(row({ edPrimaryTitle: "Professor of Medicine", chiefTitle: "Chief, Cardiology" }, { roles: { chief: true } })?.mismatchNotes).toEqual([
      "Chief role, no Chief title",
    ]);
    expect(row({ edPrimaryTitle: "Chair of Medicine" })?.mismatchNotes).toEqual(["Chair title, no Chair role"]);
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
