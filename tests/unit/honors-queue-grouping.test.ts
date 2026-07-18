/**
 * #1762 round 4 — the group-by control's bucketing. The one invariant that must
 * not break: a CONTESTED line (several scholars, one award) stays a single unit
 * under every mode, and under "person" it can't be filed under any one person, so
 * it lands in a shared "multiple candidates" bucket. All names are synthetic.
 */
import { describe, expect, it } from "vitest";

import { buildSections, type GroupBy } from "@/components/edit/honors-queue";
import type { HonorQueueGroup, HonorQueueRow } from "@/lib/edit/honor-queue";

function mkRow(over: Partial<HonorQueueRow>): HonorQueueRow {
  return {
    id: "r",
    cwid: "aaa1001",
    slug: null,
    scholarName: "Ada Lovelace",
    roleLabel: "Full-time faculty",
    roleCategory: "full_time_faculty",
    title: null,
    department: null,
    category: "PRIZE",
    name: "Member",
    organization: "National Academy of Sciences",
    year: 2020,
    prestige: 100,
    source: "SEED",
    sourceRef: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:00.000Z",
    competingCwids: [],
    ...over,
  };
}

function grp(key: string, rows: HonorQueueRow[]): HonorQueueGroup {
  return { key, rows, rosterMatchedName: null, contested: new Set(rows.map((r) => r.cwid)).size > 1 };
}

const single = grp("g1", [mkRow({ cwid: "aaa1001", scholarName: "Ada", organization: "NAS" })]);
const alsoAda = grp("g2", [mkRow({ id: "r2", cwid: "aaa1001", scholarName: "Ada", organization: "HHMI" })]);
const contested = grp("g3", [
  mkRow({ id: "r3", cwid: "bbb2002", scholarName: "Bo", organization: "Sloan" }),
  mkRow({ id: "r4", cwid: "ccc3003", scholarName: "Cy", organization: "Sloan" }),
]);

describe("buildSections", () => {
  it("none → one flat, unheaded section holding every group", () => {
    const secs = buildSections([single, alsoAda, contested], "none");
    expect(secs).toHaveLength(1);
    expect(secs[0].heading).toBeNull();
    expect(secs[0].groups).toHaveLength(3);
  });

  it("person → clusters one scholar's groups; contested goes to its own bucket, unsplit", () => {
    const secs = buildSections([single, alsoAda, contested], "person");
    const ada = secs.find((s) => s.heading === "Ada");
    expect(ada?.groups.map((g) => g.key)).toEqual(["g1", "g2"]);
    const multi = secs.find((s) => s.heading === "Multiple candidates for one award");
    expect(multi?.groups).toHaveLength(1); // the contested group, still one unit
    expect(multi?.groups[0].rows).toHaveLength(2);
  });

  it("award → clusters by organization, contested included under its award", () => {
    const secs = buildSections([single, alsoAda, contested], "award");
    expect(new Set(secs.map((s) => s.heading))).toEqual(new Set(["NAS", "HHMI", "Sloan"]));
    expect(secs.find((s) => s.heading === "Sloan")?.groups[0].contested).toBe(true);
  });

  it.each(["none", "person", "award"] as GroupBy[])("never splits a contested group (%s)", (mode) => {
    const secs = buildSections([contested], mode);
    const contestedGroups = secs.flatMap((s) => s.groups).filter((g) => g.contested);
    expect(contestedGroups).toHaveLength(1);
    expect(contestedGroups[0].rows).toHaveLength(2);
  });
});
