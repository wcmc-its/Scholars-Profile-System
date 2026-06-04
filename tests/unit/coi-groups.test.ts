/**
 * `lib/coi-groups.ts` — the shared COI disclosure grouping + ordering used by
 * both the public profile's "External relationships" section and the /edit
 * read-only Conflicts of Interest panel. The contract is that both surfaces
 * render in the SAME order (`COI_GROUP_ORDER`), so this is tested once here.
 */
import { describe, expect, it } from "vitest";

import { COI_GROUP_ORDER, groupCoiDisclosures } from "@/lib/coi-groups";

describe("groupCoiDisclosures", () => {
  it("groups by activityGroup and dedups + alpha-sorts entities within a group", () => {
    const groups = groupCoiDisclosures([
      { entity: "Zeta Co", activityGroup: "Ownership" },
      { entity: "Alpha Co", activityGroup: "Ownership" },
      { entity: "Alpha Co", activityGroup: "Ownership" }, // duplicate
    ]);
    expect(groups).toEqual([{ group: "Ownership", entities: ["Alpha Co", "Zeta Co"] }]);
  });

  it("orders known groups by COI_GROUP_ORDER (mockup order)", () => {
    // Provide groups deliberately out of order.
    const groups = groupCoiDisclosures([
      { entity: "A", activityGroup: "Speaker/Lecturer" },
      { entity: "B", activityGroup: "Leadership Roles" },
      { entity: "C", activityGroup: "Ownership" },
    ]);
    expect(groups.map((g) => g.group)).toEqual([
      "Leadership Roles",
      "Ownership",
      "Speaker/Lecturer",
    ]);
    // And those are in COI_GROUP_ORDER relative position.
    const idx = (g: string) => COI_GROUP_ORDER.indexOf(g as (typeof COI_GROUP_ORDER)[number]);
    expect(idx("Leadership Roles")).toBeLessThan(idx("Ownership"));
    expect(idx("Ownership")).toBeLessThan(idx("Speaker/Lecturer"));
  });

  it("sorts unknown groups alpha after known ones, with 'Other' last", () => {
    const groups = groupCoiDisclosures([
      { entity: "A", activityGroup: "Other" },
      { entity: "B", activityGroup: "Zebra Group" }, // unknown
      { entity: "C", activityGroup: "Apple Group" }, // unknown
      { entity: "D", activityGroup: "Ownership" }, // known
    ]);
    expect(groups.map((g) => g.group)).toEqual([
      "Ownership", // known first
      "Apple Group", // then unknown alpha
      "Zebra Group",
      "Other", // last
    ]);
  });

  it("buckets a null activityGroup to 'Other' and drops disclosures with no entity", () => {
    const groups = groupCoiDisclosures([
      { entity: "Has Entity", activityGroup: null },
      { entity: null, activityGroup: "Ownership" }, // dropped — no entity
    ]);
    expect(groups).toEqual([{ group: "Other", entities: ["Has Entity"] }]);
  });

  it("returns an empty array for no disclosures", () => {
    expect(groupCoiDisclosures([])).toEqual([]);
  });
});
