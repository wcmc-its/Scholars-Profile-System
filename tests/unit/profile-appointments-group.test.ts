/**
 * #1568 — public-profile grouping for self-asserted `profile_appointment` rows.
 *
 * Covers the two behaviors the profile view relies on: partitioning by category
 * (WCM_LEADERSHIP → roles/leadership, EXTERNAL → previous/other) and dropping
 * rows the scholar has hidden (`showOnProfile === false`), while preserving the
 * loader's row order within each group.
 */
import { describe, expect, it } from "vitest";

import {
  groupProfileAppointments,
  type ProfileAppointmentEntry,
} from "@/lib/profile/profile-appointments";

function entry(overrides: Partial<ProfileAppointmentEntry>): ProfileAppointmentEntry {
  return {
    category: "WCM_LEADERSHIP",
    title: "Role",
    organization: "Weill Cornell Medicine",
    unit: null,
    location: null,
    startDate: null,
    endDate: null,
    showOnProfile: true,
    ...overrides,
  };
}

describe("groupProfileAppointments — category split", () => {
  it("partitions rows into leadership (WCM) and external groups", () => {
    const rows = [
      entry({ category: "WCM_LEADERSHIP", title: "Program Director" }),
      entry({ category: "EXTERNAL", title: "Assistant Professor", organization: "Johns Hopkins" }),
      entry({ category: "WCM_LEADERSHIP", title: "Head of Section" }),
    ];

    const grouped = groupProfileAppointments(rows);

    expect(grouped.leadership.map((r) => r.title)).toEqual(["Program Director", "Head of Section"]);
    expect(grouped.external.map((r) => r.title)).toEqual(["Assistant Professor"]);
  });

  it("preserves the input order within each group", () => {
    const rows = [
      entry({ category: "EXTERNAL", title: "First external" }),
      entry({ category: "WCM_LEADERSHIP", title: "First WCM" }),
      entry({ category: "EXTERNAL", title: "Second external" }),
      entry({ category: "WCM_LEADERSHIP", title: "Second WCM" }),
    ];

    const grouped = groupProfileAppointments(rows);

    expect(grouped.leadership.map((r) => r.title)).toEqual(["First WCM", "Second WCM"]);
    expect(grouped.external.map((r) => r.title)).toEqual(["First external", "Second external"]);
  });

  it("returns two empty groups for empty input", () => {
    const grouped = groupProfileAppointments([]);
    expect(grouped.leadership).toEqual([]);
    expect(grouped.external).toEqual([]);
  });
});

describe("groupProfileAppointments — showOnProfile filtering", () => {
  it("drops hidden rows from both groups", () => {
    const rows = [
      entry({ category: "WCM_LEADERSHIP", title: "Shown WCM", showOnProfile: true }),
      entry({ category: "WCM_LEADERSHIP", title: "Hidden WCM", showOnProfile: false }),
      entry({ category: "EXTERNAL", title: "Shown external", showOnProfile: true }),
      entry({ category: "EXTERNAL", title: "Hidden external", showOnProfile: false }),
    ];

    const grouped = groupProfileAppointments(rows);

    expect(grouped.leadership.map((r) => r.title)).toEqual(["Shown WCM"]);
    expect(grouped.external.map((r) => r.title)).toEqual(["Shown external"]);
  });

  it("yields empty groups when every row is hidden", () => {
    const rows = [
      entry({ category: "WCM_LEADERSHIP", showOnProfile: false }),
      entry({ category: "EXTERNAL", showOnProfile: false }),
    ];

    const grouped = groupProfileAppointments(rows);

    expect(grouped.leadership).toEqual([]);
    expect(grouped.external).toEqual([]);
  });
});
