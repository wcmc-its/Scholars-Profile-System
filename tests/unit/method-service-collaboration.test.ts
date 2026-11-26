/**
 * `lib/method-services/collaboration.ts`: which of a method page's
 * publications are counted for a unit's service (excluded always wins, and
 * only the page's own publications count), whether each is a collaboration or
 * support and why, the public sentence and filter label, and when a service is
 * shown at all. Pure; made-up PMIDs and units only.
 */
import { describe, expect, it } from "vitest";

import {
  compareServicesForBlock,
  computeCollaboration,
  countKinds,
  isServiceUnitVisible,
  parseServiceParam,
  serviceCoversFamily,
  serviceBadgeLabel,
  serviceDisplayLabels,
  serviceFilterLabel,
  serviceSentence,
  serviceSentenceParts,
  withArticle,
} from "@/lib/method-services/collaboration";

const PAGE = new Set(["101", "102", "103", "104", "105"]);

const base = {
  pagePmids: PAGE,
  supportedPmids: [] as string[],
  excludedPmids: [] as string[],
  coauthoredPmids: [] as string[],
  nameMatchedPmids: [] as string[],
  countStaffPapers: false,
  staffPmids: new Set<string>(),
  confirmedPmids: undefined as Set<string> | undefined,
};

/** pmid -> the reason it is counted. */
const marked = (input: Partial<typeof base>) =>
  Object.fromEntries(
    [...computeCollaboration({ ...base, ...input }).marked].map(([pmid, m]) => [pmid, m.reason]),
  );
/** pmid -> "collaboration" | "support". */
const kinds = (input: Partial<typeof base>) =>
  Object.fromEntries(
    [...computeCollaboration({ ...base, ...input }).marked].map(([pmid, m]) => [pmid, m.kind]),
  );

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

  it("a supported pmid a unit member authored is counted once, as that member's collaboration", () => {
    const r = computeCollaboration({
      ...base,
      supportedPmids: ["101"],
      countStaffPapers: true,
      staffPmids: new Set(["101", "102"]),
    });
    expect(Object.fromEntries(r.marked)).toEqual({
      "101": { kind: "collaboration", reason: "staff" },
      "102": { kind: "collaboration", reason: "staff" },
    });
    expect(r.marked.size).toBe(2);
  });

  it("supported still marks with automatic counting off", () => {
    expect(marked({ supportedPmids: ["101"], countStaffPapers: false })).toEqual({
      "101": "supported",
    });
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

  it("the reason is staff, then affiliation, then supported, then confirmed", () => {
    expect(
      marked({
        supportedPmids: ["101", "102", "103"],
        coauthoredPmids: ["101", "102"],
        confirmedPmids: new Set(["101", "102", "103", "104"]),
        countStaffPapers: true,
        staffPmids: new Set(["101"]),
      }),
    ).toEqual({ "101": "staff", "102": "affiliation", "103": "supported", "104": "confirmed" });
  });

  it("a confirmed pmid that is not on the page marks nothing", () => {
    expect(marked({ confirmedPmids: new Set(["999"]) })).toEqual({});
  });
});

describe("computeCollaboration: collaboration or support", () => {
  it("staff: a current unit member in Scholars is an author, so it is a collaboration", () => {
    expect(kinds({ countStaffPapers: true, staffPmids: new Set(["101"]) })).toEqual({
      "101": "collaboration",
    });
    expect(marked({ countStaffPapers: true, staffPmids: new Set(["101"]) })).toEqual({
      "101": "staff",
    });
  });

  it("affiliation: on the supported list with a matching PubMed author, so it is a collaboration", () => {
    const input = { supportedPmids: ["101"], coauthoredPmids: ["101"] };
    expect(kinds(input)).toEqual({ "101": "collaboration" });
    expect(marked(input)).toEqual({ "101": "affiliation" });
  });

  it("author_name: a match found by a named author is a collaboration with its own reason", () => {
    const input = {
      supportedPmids: ["101", "102"],
      coauthoredPmids: ["101", "102"],
      nameMatchedPmids: ["102"],
    };
    expect(kinds(input)).toEqual({ "101": "collaboration", "102": "collaboration" });
    expect(marked(input)).toEqual({ "101": "affiliation", "102": "author_name" });
  });

  it("author_name: a unit member in Scholars still wins, and a pmid off the supported list is not marked", () => {
    expect(
      marked({
        supportedPmids: ["101"],
        coauthoredPmids: ["101", "102"],
        nameMatchedPmids: ["101", "102"],
        staffPmids: new Set(["101"]),
      }),
    ).toEqual({ "101": "staff" });
    // Not in the stored matches at all: the name list alone decides nothing.
    expect(marked({ supportedPmids: ["101"], nameMatchedPmids: ["101"] })).toEqual({ "101": "supported" });
  });

  it("supported: on the supported list with no matching author, so it is support", () => {
    const input = { supportedPmids: ["101", "102"], coauthoredPmids: ["102"] };
    expect(kinds(input)).toEqual({ "101": "support", "102": "collaboration" });
    expect(marked(input)).toEqual({ "101": "supported", "102": "affiliation" });
  });

  it("confirmed: a core's confirmed publication with no unit author is support", () => {
    const input = { confirmedPmids: new Set(["103"]) };
    expect(kinds(input)).toEqual({ "103": "support" });
    expect(marked(input)).toEqual({ "103": "confirmed" });
  });

  it("a core's confirmed publication a unit member authored is a collaboration", () => {
    expect(
      kinds({
        confirmedPmids: new Set(["103"]),
        countStaffPapers: true,
        staffPmids: new Set(["103"]),
      }),
    ).toEqual({ "103": "collaboration" });
  });

  it("excluded wins over every reason", () => {
    expect(
      kinds({
        supportedPmids: ["101", "102"],
        coauthoredPmids: ["101"],
        confirmedPmids: new Set(["103"]),
        countStaffPapers: true,
        staffPmids: new Set(["104"]),
        excludedPmids: ["101", "102", "103", "104"],
      }),
    ).toEqual({});
  });

  it("toggle off: a unit member's authorship does not count a paper, but makes a counted one a collaboration", () => {
    const input = {
      supportedPmids: ["101"],
      confirmedPmids: new Set(["103"]),
      countStaffPapers: false,
      staffPmids: new Set(["101", "102", "103"]),
    };
    // 102 is by a unit member only: not counted. 101 (supported list) and 103
    // (the core's confirmed) are counted anyway and have a unit author.
    expect(kinds(input)).toEqual({ "101": "collaboration", "103": "collaboration" });
    expect(marked(input)).toEqual({ "101": "staff", "103": "staff" });
  });

  it("the toggle never changes what an already counted paper is called", () => {
    const input = { supportedPmids: ["101"], staffPmids: new Set(["101"]) };
    expect(kinds({ ...input, countStaffPapers: false })).toEqual(
      kinds({ ...input, countStaffPapers: true }),
    );
  });

  it("toggle off: an excluded paper with a unit author stays uncounted", () => {
    expect(
      kinds({
        supportedPmids: ["101"],
        excludedPmids: ["101"],
        countStaffPapers: false,
        staffPmids: new Set(["101"]),
      }),
    ).toEqual({});
  });

  it("toggle off: the PubMed affiliation still makes a supported paper a collaboration", () => {
    expect(
      kinds({
        supportedPmids: ["101"],
        coauthoredPmids: ["101"],
        countStaffPapers: false,
        staffPmids: new Set(["101"]),
      }),
    ).toEqual({ "101": "collaboration" });
  });

  it("a stored co-authored pmid that is no longer on the supported list counts for nothing", () => {
    expect(kinds({ supportedPmids: ["101"], coauthoredPmids: ["101", "102"] })).toEqual({
      "101": "collaboration",
    });
    // Still counted when the core confirmed it, but as support.
    expect(kinds({ coauthoredPmids: ["103"], confirmedPmids: new Set(["103"]) })).toEqual({
      "103": "support",
    });
  });

  it("no coauthoredPmids given: everything on the supported list is support", () => {
    const { coauthoredPmids: _omit, ...withoutIt } = base;
    void _omit;
    const r = computeCollaboration({ ...withoutIt, supportedPmids: ["101"] });
    expect(r.marked.get("101")).toEqual({ kind: "support", reason: "supported" });
  });

  it("countKinds splits the counted set, over everything or within a view", () => {
    const { marked: m } = computeCollaboration({
      ...base,
      supportedPmids: ["101", "102", "103"],
      coauthoredPmids: ["101"],
      countStaffPapers: true,
      staffPmids: new Set(["104"]),
    });
    expect(countKinds(m)).toEqual({ collaborations: 2, support: 2 });
    expect(countKinds(m, new Set(["101", "102"]))).toEqual({ collaborations: 1, support: 1 });
    expect(countKinds(new Map())).toEqual({ collaborations: 0, support: 0 });
  });
});

describe("the public sentence, filter label and badge", () => {
  const UNIT = "Example Library";

  it("N and S: collaborated on N and supported S of the M", () => {
    expect(serviceSentence(UNIT, 12, 1340, 5210)).toBe(
      "The Example Library collaborated on 12 and supported 1,340 of the 5,210 publications listed here.",
    );
  });

  it("S is 0: collaborated on N of the M", () => {
    expect(serviceSentence(UNIT, 12, 0, 40)).toBe(
      "The Example Library collaborated on 12 of the 40 publications listed here.",
    );
  });

  it("N is 0: supported S of the M", () => {
    expect(serviceSentence(UNIT, 0, 7, 40)).toBe(
      "The Example Library supported 7 of the 40 publications listed here.",
    );
  });

  it("both 0: no sentence", () => {
    expect(serviceSentence(UNIT, 0, 0, 40)).toBeNull();
    expect(serviceSentenceParts(UNIT, 0, 0, 40)).toBeNull();
  });

  it("the numbers are the bold runs", () => {
    const bold = (n: number, s: number) =>
      serviceSentenceParts(UNIT, n, s, 40)!
        .filter((p) => p.bold)
        .map((p) => p.text);
    expect(bold(12, 7)).toEqual(["12", "7 of the 40"]);
    expect(bold(12, 0)).toEqual(["12 of the 40"]);
    expect(bold(0, 7)).toEqual(["7 of the 40"]);
  });

  it("the filter is named for what it selects", () => {
    expect(serviceFilterLabel(UNIT, 12, 0)).toBe("Example Library collaborations");
    expect(serviceFilterLabel(UNIT, 0, 7)).toBe("Example Library support");
    expect(serviceFilterLabel(UNIT, 12, 7)).toBe("Example Library collaborations and support");
    // Nothing counted (a filter reached by a link): the plain name.
    expect(serviceFilterLabel(UNIT, 0, 0)).toBe("Example Library collaborations");
  });

  it("the badge says which it is", () => {
    expect(serviceBadgeLabel(UNIT, "collaboration")).toBe("Example Library collaboration");
    expect(serviceBadgeLabel(UNIT, "support")).toBe("Example Library support");
  });
});

describe("computeCollaboration: the automatic toggle", () => {
  it("off: a staff-authored pmid is not marked", () => {
    expect(marked({ countStaffPapers: false, staffPmids: new Set(["102", "103"]) })).toEqual({});
  });

  it("off: only the supported list counts", () => {
    // 102 has a unit author and is on no list: still not counted.
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
