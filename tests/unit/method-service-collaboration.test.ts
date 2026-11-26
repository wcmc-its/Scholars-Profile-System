/**
 * `lib/method-services/collaboration.ts`: which of a method page's
 * publications a unit collaborated on (excluded beats supported beats
 * automatic, and only the page's own publications count), and when a service
 * is shown at all. Pure; made-up PMIDs and units only.
 */
import { describe, expect, it } from "vitest";

import {
  compareServicesForBlock,
  computeCollaboration,
  isServiceUnitVisible,
  parseServiceParam,
  serviceCoversFamily,
  serviceDisplayLabels,
  withArticle,
} from "@/lib/method-services/collaboration";

const PAGE = new Set(["101", "102", "103", "104", "105"]);

const base = {
  pagePmids: PAGE,
  supportedPmids: [] as string[],
  excludedPmids: [] as string[],
  countStaffPapers: false,
  staffPmids: new Set<string>(),
  confirmedPmids: undefined as Set<string> | undefined,
};

const marked = (input: Partial<typeof base>) =>
  Object.fromEntries(computeCollaboration({ ...base, ...input }).marked);

describe("computeCollaboration: precedence", () => {
  it("marks a supported pmid that is on the page", () => {
    expect(marked({ supportedPmids: ["101"] })).toEqual({ "101": "supported" });
  });

  it("marks a staff-authored pmid when automatic counting is on", () => {
    expect(marked({ countStaffPapers: true, staffPmids: new Set(["102"]) })).toEqual({
      "102": "staff",
    });
  });

  it("excluded beats supported", () => {
    expect(marked({ supportedPmids: ["101", "102"], excludedPmids: ["101"] })).toEqual({
      "102": "supported",
    });
  });

  it("excluded beats automatic", () => {
    expect(
      marked({
        countStaffPapers: true,
        staffPmids: new Set(["102", "103"]),
        excludedPmids: ["102"],
      }),
    ).toEqual({ "103": "staff" });
  });

  it("excluded beats a pmid that is both supported and staff-authored", () => {
    expect(
      marked({
        supportedPmids: ["101"],
        countStaffPapers: true,
        staffPmids: new Set(["101"]),
        excludedPmids: ["101"],
      }),
    ).toEqual({});
  });

  it("supported beats automatic: the reason is the owner's list, once", () => {
    const r = computeCollaboration({
      ...base,
      supportedPmids: ["101"],
      countStaffPapers: true,
      staffPmids: new Set(["101", "102"]),
    });
    expect(Object.fromEntries(r.marked)).toEqual({ "101": "supported", "102": "staff" });
    expect(r.marked.size).toBe(2);
  });

  it("supported still marks with automatic counting off", () => {
    expect(
      marked({ supportedPmids: ["101"], countStaffPapers: false, staffPmids: new Set(["101"]) }),
    ).toEqual({ "101": "supported" });
  });
});

describe("computeCollaboration: a core's confirmed publications", () => {
  it("marks a confirmed pmid with automatic counting off and no staff author", () => {
    expect(marked({ confirmedPmids: new Set(["103"]) })).toEqual({ "103": "confirmed" });
  });

  it("excluded beats confirmed", () => {
    expect(marked({ confirmedPmids: new Set(["103", "104"]), excludedPmids: ["103"] })).toEqual({
      "104": "confirmed",
    });
  });

  it("the reason is supported, then confirmed, then staff", () => {
    expect(
      marked({
        supportedPmids: ["101"],
        confirmedPmids: new Set(["101", "102"]),
        countStaffPapers: true,
        staffPmids: new Set(["101", "102", "103"]),
      }),
    ).toEqual({ "101": "supported", "102": "confirmed", "103": "staff" });
  });

  it("a confirmed pmid that is not on the page marks nothing", () => {
    expect(marked({ confirmedPmids: new Set(["999"]) })).toEqual({});
  });
});

describe("computeCollaboration: the automatic toggle", () => {
  it("off: a staff-authored pmid is not marked", () => {
    expect(marked({ countStaffPapers: false, staffPmids: new Set(["102", "103"]) })).toEqual({});
  });

  it("off: only the supported list counts", () => {
    expect(
      marked({
        supportedPmids: ["104"],
        countStaffPapers: false,
        staffPmids: new Set(["102"]),
      }),
    ).toEqual({ "104": "supported" });
  });
});

describe("computeCollaboration: only the page's publications count", () => {
  it("a supported pmid that is not on the page marks nothing", () => {
    expect(marked({ supportedPmids: ["999", "101"] })).toEqual({ "101": "supported" });
  });

  it("a staff-authored pmid that is not on the page marks nothing", () => {
    expect(marked({ countStaffPapers: true, staffPmids: new Set(["999"]) })).toEqual({});
  });

  it("an empty page marks nothing", () => {
    expect(
      marked({
        pagePmids: new Set(),
        supportedPmids: ["101"],
        countStaffPapers: true,
        staffPmids: new Set(["102"]),
      }),
    ).toEqual({});
  });

  it("counts supported pmids on the page, excluded or not, and ignores duplicates", () => {
    const r = computeCollaboration({
      ...base,
      supportedPmids: ["101", "101", "102", "998", "999"],
      excludedPmids: ["102"],
    });
    expect(r.supportedOnPage).toBe(2);
    expect([...r.marked.keys()]).toEqual(["101"]);
  });

  it("an excluded pmid that was never marked changes nothing", () => {
    expect(marked({ supportedPmids: ["101"], excludedPmids: ["105", "999"] })).toEqual({
      "101": "supported",
    });
  });
});

describe("two units on one method", () => {
  it("each gets its own set; a shared paper is marked for both; one unit's exclusion is its own", () => {
    const library = computeCollaboration({
      ...base,
      supportedPmids: ["101", "103"],
      countStaffPapers: true,
      staffPmids: new Set(["102"]),
      excludedPmids: ["103"],
    });
    const core = computeCollaboration({
      ...base,
      countStaffPapers: true,
      staffPmids: new Set(["102", "103", "104"]),
    });
    expect([...library.marked.keys()].sort()).toEqual(["101", "102"]);
    expect([...core.marked.keys()].sort()).toEqual(["102", "103", "104"]);
    // 102: both badges. 103: the library took it off its own count only.
    expect(library.marked.has("102") && core.marked.has("102")).toBe(true);
    expect(library.marked.has("103")).toBe(false);
    expect(core.marked.has("103")).toBe(true);
  });
});

describe("isServiceUnitVisible", () => {
  it("a department that exists and is not suppressed is visible", () => {
    expect(isServiceUnitVisible({ entityType: "department", exists: true, suppressed: false })).toBe(true);
  });

  it("a suppressed (retired) department is not", () => {
    expect(isServiceUnitVisible({ entityType: "department", exists: true, suppressed: true })).toBe(false);
  });

  it("a visible core with core pages on is visible", () => {
    expect(
      isServiceUnitVisible({ entityType: "core", exists: true, visible: true, corePagesOn: true }),
    ).toBe(true);
  });

  it("a hidden core is not, even with core pages on", () => {
    expect(
      isServiceUnitVisible({ entityType: "core", exists: true, visible: false, corePagesOn: true }),
    ).toBe(false);
  });

  it("no core is while core pages are off", () => {
    expect(
      isServiceUnitVisible({ entityType: "core", exists: true, visible: true, corePagesOn: false }),
    ).toBe(false);
  });

  it("a unit that no longer exists, or is unknown, is not", () => {
    expect(isServiceUnitVisible({ entityType: "department", exists: false, suppressed: false })).toBe(false);
    expect(
      isServiceUnitVisible({ entityType: "core", exists: false, visible: true, corePagesOn: true }),
    ).toBe(false);
    expect(isServiceUnitVisible(null)).toBe(false);
    expect(isServiceUnitVisible(undefined)).toBe(false);
  });
});

describe("helpers", () => {
  const FAM = { supercategory: "evidence_synthesis", familyLabel: "Example review methods" };

  it("serviceCoversFamily matches the exact (supercategory, label) key", () => {
    const service = { families: [FAM] };
    expect(serviceCoversFamily(service, { ...FAM })).toBe(true);
    expect(serviceCoversFamily(service, { ...FAM, familyLabel: "example review methods" })).toBe(false);
    expect(serviceCoversFamily(service, { ...FAM, supercategory: "other" })).toBe(false);
  });

  it("labels a service by its unit, adding the service name only when a unit has two", () => {
    const labels = serviceDisplayLabels([
      { id: 1, name: "Review service", unitName: "Example Library" },
      { id: 2, name: "Search service", unitName: "Example Library" },
      { id: 3, name: "Imaging help", unitName: "Example Core" },
    ]);
    expect(labels.get(1)).toBe("Example Library (Review service)");
    expect(labels.get(2)).toBe("Example Library (Search service)");
    expect(labels.get(3)).toBe("Example Core");
  });

  it("orders the block by collaboration count, then name", () => {
    const rows = [
      { id: 1, name: "B service", count: 3 },
      { id: 2, name: "A service", count: 3 },
      { id: 3, name: "C service", count: 9 },
    ];
    expect(rows.sort(compareServicesForBlock).map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("withArticle never doubles the article", () => {
    expect(withArticle("Example Library")).toBe("the Example Library");
    expect(withArticle("The Example Core")).toBe("the Example Core");
  });

  it("parseServiceParam takes a positive integer of at most 9 digits", () => {
    expect(parseServiceParam("12")).toBe(12);
    for (const bad of [null, "", "0", "012", "-1", "1.5", "abc", "1234567890", "1 OR 1"]) {
      expect(parseServiceParam(bad)).toBeNull();
    }
  });
});
