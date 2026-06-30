/**
 * Issue #308 / SPEC §6.1.1 + §10 — unit tests for the People-tab query-shape
 * classifier. Pure function, no mocks. Asserts the classifier shape only;
 * query-body shape and function_score wrapping are SPEC PR-2 through PR-4.
 */
import { describe, expect, it } from "vitest";

import {
  classifyPeopleQuery,
  type PeopleQueryShape,
} from "@/lib/api/people-query-shape";

// Fixture sets — lowercased, as the real cached sets will be.
const SURNAMES: ReadonlySet<string> = new Set(["cantley", "wong", "smith"]);
const CWIDS: ReadonlySet<string> = new Set(["lcc2010", "rgcryst"]);
const DEPARTMENTS: ReadonlySet<string> = new Set([
  "cardiology",
  "pediatrics",
  "population health sciences",
]);

function classify(query: string, meshResolved = false): PeopleQueryShape {
  return classifyPeopleQuery({
    query,
    meshResolved,
    knownCwids: CWIDS,
    knownSurnames: SURNAMES,
    knownDepartments: DEPARTMENTS,
  });
}

describe("classifyPeopleQuery — SPEC §10 matrix", () => {
  it("1. lastname only -> name", () => {
    expect(classify("cantley")).toBe("name");
  });

  it("2. forward full name -> name (last token is the surname)", () => {
    expect(classify("lewis cantley")).toBe("name");
  });

  it("3. multi-term MeSH-resolvable topic -> topic", () => {
    expect(classify("ras signaling pancreatic cancer", true)).toBe("topic");
  });

  it("4. surname + resolvable topic -> hybrid", () => {
    // The hybrid outcome here depends on the taxonomy resolving "ras" (#308
    // open dependency); meshResolved is true in this case.
    expect(classify("cantley ras", true)).toBe("hybrid");
  });

  it("5. department -> department", () => {
    expect(classify("cardiology")).toBe("department");
  });

  it("7. two-term MeSH topic -> topic", () => {
    expect(classify("tau alzheimer", true)).toBe("topic");
  });

  it("8. invented id -> unclassified", () => {
    expect(classify("xj9k")).toBe("unclassified");
  });

  it("11. institutional-name query, no matching dept/surname -> topic", () => {
    expect(classify("weill cornell medicine pediatric oncology")).toBe("topic");
  });

  it("12. CWID -> cwid", () => {
    expect(classify("lcc2010")).toBe("cwid");
  });

  it("all-letter CWID (e.g. rgcryst) is detected by set membership -> cwid", () => {
    expect(classify("rgcryst")).toBe("cwid");
  });

  it("a cwid-shaped token that is not a known CWID -> not cwid", () => {
    expect(classify("zzz9999")).toBe("unclassified");
  });

  it("9-10. empty and whitespace-only -> empty", () => {
    expect(classify("")).toBe("empty");
    expect(classify("   ")).toBe("empty");
  });
});

describe("classifyPeopleQuery — review-driven cases (#308)", () => {
  it("13. department + topic modifier -> hybrid (non-empty leftover)", () => {
    expect(classify("cardiology research")).toBe("hybrid");
  });

  it("14. surname + long topic -> hybrid, not topic", () => {
    // The surname anchor must not be lost just because the query is long.
    expect(classify("cantley ras signaling pancreatic cancer")).toBe("hybrid");
  });

  it("15. department + a noise word -> department (leftover empties out)", () => {
    expect(classify("cardiology department")).toBe("department");
  });
});

describe("classifyPeopleQuery — surname-anchor edge cases", () => {
  it("matches a surname in the last position (Western order)", () => {
    expect(classify("olivier cantley")).toBe("name");
  });

  it("matches a surname in the first position (directory order)", () => {
    expect(classify("cantley olivier")).toBe("name");
  });

  it("does NOT fire on a surname in the middle of a long query", () => {
    // "wong" is a known surname but sits mid-query — the anchor check, which
    // only inspects the first and last token, skips it.
    expect(classify("signaling pathways wong analysis")).toBe("topic");
  });

  it("a long non-surname non-MeSH query is topic via the >=4-token rule", () => {
    expect(classify("regulation of cellular metabolism pathways")).toBe("topic");
  });

  it("a short non-surname non-MeSH query is unclassified", () => {
    expect(classify("foo bar")).toBe("unclassified");
  });
});

describe("classifyPeopleQuery — department phrase matching", () => {
  it("matches a multi-word department exactly -> department", () => {
    expect(classify("population health sciences")).toBe("department");
  });

  it("matches a multi-word department with a leftover -> hybrid", () => {
    expect(classify("population health sciences methods")).toBe("hybrid");
  });
});

describe("classifyPeopleQuery — #528 dept/surname collisions", () => {
  // In production, `lastNameSort` contains surnames that collide with
  // department tokens — e.g. scholars surnamed "Sciences" or "Pediatrics".
  // The classifier must still route a pure-department query to `department`.
  const COLLIDING_SURNAMES: ReadonlySet<string> = new Set([
    "cantley",
    "wong",
    "smith",
    "sciences",
    "pediatrics",
  ]);

  function classifyWithCollision(
    query: string,
    meshResolved = false,
  ): PeopleQueryShape {
    return classifyPeopleQuery({
      query,
      meshResolved,
      knownCwids: CWIDS,
      knownSurnames: COLLIDING_SURNAMES,
      knownDepartments: DEPARTMENTS,
    });
  }

  it("multi-word dept whose tail token is also a surname -> department", () => {
    // "sciences" is a known surname; without the #528 fix this misrouted to
    // `name` via the surname-anchor (last-token) rule.
    expect(classifyWithCollision("population health sciences")).toBe(
      "department",
    );
  });

  it("single-word dept that is also a surname AND MeSH-resolvable -> department", () => {
    // "pediatrics" is a known surname AND resolves to a MeSH descriptor;
    // without the #528 fix this misrouted to `hybrid` via surname+topic.
    expect(classifyWithCollision("pediatrics", true)).toBe("department");
  });

  it("dept-name plus extra tokens still routes to hybrid (collision case)", () => {
    // The #528 promotion only fires when the leftover is empty. A
    // department-prefix-plus-extra-tokens query keeps its hybrid routing.
    expect(classifyWithCollision("pediatrics oncology research", true)).toBe(
      "hybrid",
    );
  });
});

// #1347 — clinical-division names (NOT a primaryDepartment) route to the department
// shape only when the division-shape flag has populated `knownDivisions`.
describe("classifyPeopleQuery — division-shape routing (#1347)", () => {
  // "hematology" is a Division of Medicine, never a primaryDepartment — so it is
  // absent from DEPARTMENTS, exactly as in prod.
  const DIVISIONS: ReadonlySet<string> = new Set(["hematology"]);

  it("flag-off (no knownDivisions): a bare division name does NOT reach department", () => {
    expect(classify("hematology")).toBe("unclassified");
  });

  it("with knownDivisions: a bare division name routes to department", () => {
    expect(
      classifyPeopleQuery({
        query: "hematology",
        meshResolved: false,
        knownCwids: CWIDS,
        knownSurnames: SURNAMES,
        knownDepartments: DEPARTMENTS,
        knownDivisions: DIVISIONS,
      }),
    ).toBe("department");
  });

  it("with knownDivisions: division name + extra tokens routes to hybrid", () => {
    expect(
      classifyPeopleQuery({
        query: "hematology research",
        meshResolved: false,
        knownCwids: CWIDS,
        knownSurnames: SURNAMES,
        knownDepartments: DEPARTMENTS,
        knownDivisions: DIVISIONS,
      }),
    ).toBe("hybrid");
  });

  it("empty knownDivisions is byte-identical to omitting it (off-path)", () => {
    const omitted = classify("cardiology"); // cardiology IS in DEPARTMENTS here
    const empty = classifyPeopleQuery({
      query: "cardiology",
      meshResolved: false,
      knownCwids: CWIDS,
      knownSurnames: SURNAMES,
      knownDepartments: DEPARTMENTS,
      knownDivisions: new Set(),
    });
    expect(empty).toBe(omitted);
  });
});
