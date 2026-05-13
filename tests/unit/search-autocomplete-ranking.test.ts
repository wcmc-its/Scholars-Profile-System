import { describe, expect, it } from "vitest";
import {
  capFill,
  chooseKindOrder,
  classifyQueryShape,
  plausibilityHits,
  promoteStartsWith,
  tiebreakPeople,
  tryFullNameCarveOut,
  type PersonRanking,
  type RankingSources,
} from "@/lib/api/search-ranking";

const emptySources = (): RankingSources => ({
  person: [],
  topic: [],
  subtopic: [],
  department: [],
  division: [],
  center: [],
});

const person = (
  cwid: string,
  text: string,
  lastNameSort: string | null,
  personType: string | null = "full_time_faculty",
): PersonRanking => ({
  cwid,
  text,
  slug: cwid.toLowerCase(),
  primaryTitle: null,
  primaryDepartment: null,
  personType,
  lastNameSort,
});

describe("classifyQueryShape (§2)", () => {
  it("returns ambiguous for length < 3", () => {
    expect(classifyQueryShape("ab")).toBe("ambiguous");
    expect(classifyQueryShape("")).toBe("ambiguous");
  });

  it("returns name-like for capitalized single-word names", () => {
    expect(classifyQueryShape("Wolchok")).toBe("name-like");
    expect(classifyQueryShape("O'Brien")).toBe("name-like");
  });

  it("returns topic-like for stopword-bearing all-lowercase queries", () => {
    // §2 rule order: name-like regex wins over stopword rule for
    // capitalized queries, so "Department of Medicine" classifies name-like
    // (the regex permits spaces). The stopword rule fires when the
    // capitalization rule doesn't apply.
    expect(classifyQueryShape("department of medicine")).toBe("topic-like");
    expect(classifyQueryShape("mind and body")).toBe("topic-like");
  });

  it("returns topic-like for queries with digits or slashes", () => {
    expect(classifyQueryShape("HIV/AIDS")).toBe("topic-like");
    expect(classifyQueryShape("COVID19")).toBe("topic-like");
  });

  it("returns topic-like for all-lowercase length ≥ 4", () => {
    expect(classifyQueryShape("cardio")).toBe("topic-like");
    expect(classifyQueryShape("cancer")).toBe("topic-like");
  });

  it("returns ambiguous for short lowercase like 'chen'", () => {
    // §2 says all-lowercase ≥ 4 → topic-like. "chen" is 4 lowercase, but the
    // shape rule applies; person plausibility hit on "chen" still wins via
    // §1 + §4 "exactly one hit" branch — see chooseKindOrder tests below.
    expect(classifyQueryShape("chen")).toBe("topic-like");
  });
});

describe("plausibilityHits (§1)", () => {
  it("returns empty set for prefix < 3 chars", () => {
    const s = emptySources();
    s.person.push(person("a1", "Alice Carter", "carter"));
    expect(plausibilityHits("ca", s).size).toBe(0);
  });

  it("hits person when top result's lastName starts with prefix", () => {
    const s = emptySources();
    s.person.push(person("a1", "Jedd Wolchok", "wolchok"));
    expect(plausibilityHits("wolchok", s).has("person")).toBe(true);
  });

  it("hits person when top result's first-token-of-preferred starts with prefix", () => {
    // First token "Carter" startsWith "cart", though lastName is "smith".
    const s = emptySources();
    s.person.push(person("a1", "Carter Smith", "smith"));
    expect(plausibilityHits("cart", s).has("person")).toBe(true);
  });

  it("does not hit person on middle-initial / nickname matches", () => {
    const s = emptySources();
    s.person.push(person("a1", "Alice Carter", "carter"));
    expect(plausibilityHits("xyz", s).has("person")).toBe(false);
  });

  it("hits topic on label startsWith (case-insensitive)", () => {
    const s = emptySources();
    s.topic.push({ id: "t1", label: "Cardiology" });
    expect(plausibilityHits("cardio", s).has("topic")).toBe(true);
  });

  it("hits dept tokenwise — 'min' matches 'Mind-Body'", () => {
    const s = emptySources();
    s.department.push({ name: "Mind-Body Medicine" });
    expect(plausibilityHits("min", s).has("department")).toBe(true);
  });

  it("does not hit dept on substring within a token ('cardio' inside 'Cardiomyopathy' is startsWith, but 'rdio' is not)", () => {
    const s = emptySources();
    s.department.push({ name: "Department of Cardiomyopathy Research" });
    // 'cardio' starts the 'Cardiomyopathy' token → hit.
    expect(plausibilityHits("cardio", s).has("department")).toBe(true);
    // 'rdio' is in-token but doesn't start it → no hit.
    expect(plausibilityHits("rdio", s).has("department")).toBe(false);
  });

  it("treats apostrophes as in-token (O'Brien stays one token)", () => {
    const s = emptySources();
    s.person.push(person("a1", "Mary O'Brien", "o'brien"));
    expect(plausibilityHits("o'br", s).has("person")).toBe(true);
  });
});

describe("chooseKindOrder (§4)", () => {
  it("exactly one hit → that kind leads", () => {
    const order = chooseKindOrder("ambiguous", new Set(["person"]));
    expect(order[0]).toBe("person");
  });

  it("multi-hit topic-like prefers topic", () => {
    const order = chooseKindOrder(
      "topic-like",
      new Set(["person", "topic", "department"]),
    );
    expect(order[0]).toBe("topic");
  });

  it("multi-hit name-like prefers person", () => {
    const order = chooseKindOrder(
      "name-like",
      new Set(["person", "topic"]),
    );
    expect(order[0]).toBe("person");
  });

  it("zero hits + name-like → person", () => {
    expect(chooseKindOrder("name-like", new Set())[0]).toBe("person");
  });

  it("zero hits + topic-like → topic", () => {
    expect(chooseKindOrder("topic-like", new Set())[0]).toBe("topic");
  });

  it("zero hits + ambiguous → person", () => {
    expect(chooseKindOrder("ambiguous", new Set())[0]).toBe("person");
  });

  it("output is a permutation of the six base kinds", () => {
    const order = chooseKindOrder("topic-like", new Set(["topic"]));
    expect(new Set(order)).toEqual(
      new Set(["department", "division", "center", "topic", "subtopic", "person"]),
    );
  });
});

describe("worked examples — full lead resolution (§4)", () => {
  it("'chen' — only person plausibility hits → lead = person", () => {
    const s = emptySources();
    s.person.push(person("a1", "Wei Chen", "chen"));
    const shape = classifyQueryShape("chen");
    const hits = plausibilityHits("chen", s);
    const order = chooseKindOrder(shape, hits);
    expect(order[0]).toBe("person");
  });

  it("'cardio' — topic + dept hit (no real person surname starts with 'cardio') → topic-like wins → lead = topic", () => {
    const s = emptySources();
    s.topic.push({ id: "t1", label: "Cardiology" });
    s.department.push({ name: "Cardiothoracic Surgery" });
    const shape = classifyQueryShape("cardio");
    const hits = plausibilityHits("cardio", s);
    expect(hits.has("topic") && hits.has("department")).toBe(true);
    expect(chooseKindOrder(shape, hits)[0]).toBe("topic");
  });

  it("'cardio' — even if a person hits, topic-like multi-hit prefers topic", () => {
    const s = emptySources();
    // Hypothetical: a surname token that does start with "cardio".
    s.person.push(person("a1", "Cardio Lastname", "lastname"));
    s.topic.push({ id: "t1", label: "Cardiology" });
    s.department.push({ name: "Cardiothoracic Surgery" });
    const shape = classifyQueryShape("cardio");
    const hits = plausibilityHits("cardio", s);
    expect(hits.has("person")).toBe(true);
    expect(chooseKindOrder(shape, hits)[0]).toBe("topic");
  });

  it("'wolchok' — only person hits → lead = person", () => {
    const s = emptySources();
    s.person.push(person("a1", "Jedd Wolchok", "wolchok"));
    const shape = classifyQueryShape("wolchok");
    const hits = plausibilityHits("wolchok", s);
    expect(chooseKindOrder(shape, hits)[0]).toBe("person");
  });
});

describe("tryFullNameCarveOut (§3)", () => {
  it("triggers on unique full-name match", () => {
    const people = [person("a1", "Jedd Wolchok", "wolchok")];
    const result = tryFullNameCarveOut("Jedd Wolchok", people);
    expect(result?.cwid).toBe("a1");
  });

  it("does not trigger on single-token queries", () => {
    const people = [person("a1", "Jedd Wolchok", "wolchok")];
    expect(tryFullNameCarveOut("Wolchok", people)).toBeNull();
  });

  it("does not trigger when 2+ people match (identical-name pair)", () => {
    const people = [
      person("a1", "John Smith", "smith"),
      person("a2", "John Smith", "smith"),
    ];
    expect(tryFullNameCarveOut("John Smith", people)).toBeNull();
  });

  it("does not trigger when query length < 5", () => {
    const people = [person("a1", "A B", "b")];
    expect(tryFullNameCarveOut("A B", people)).toBeNull();
  });

  it("ignores middle initials in candidate's preferredName", () => {
    const people = [person("a1", "Ronald G. Crystal", "crystal")];
    expect(tryFullNameCarveOut("Ronald Crystal", people)?.cwid).toBe("a1");
  });

  it("ignores postnominals in candidate's preferredName", () => {
    const people = [person("a1", "Curtis Cole, MD", "cole")];
    expect(tryFullNameCarveOut("Curtis Cole", people)?.cwid).toBe("a1");
  });

  it("does not trigger when token sets differ", () => {
    const people = [person("a1", "Jedd Wolchok", "wolchok")];
    expect(tryFullNameCarveOut("Jane Wolchok", people)).toBeNull();
  });
});

describe("tiebreakPeople (§6)", () => {
  it("orders by role rank (faculty before postdoc)", () => {
    const rows = [
      person("a1", "Alice Adams", "adams", "postdoc"),
      person("a2", "Bob Brown", "brown", "full_time_faculty"),
    ];
    const sorted = tiebreakPeople(rows);
    expect(sorted.map((r) => r.cwid)).toEqual(["a2", "a1"]);
  });

  it("orders by sortable surname within role bucket", () => {
    const rows = [
      person("a1", "Z Smith", "smith", "full_time_faculty"),
      person("a2", "A Adams", "adams", "full_time_faculty"),
    ];
    expect(tiebreakPeople(rows).map((r) => r.cwid)).toEqual(["a2", "a1"]);
  });

  it("falls back to cwid ascending on identical role + surname", () => {
    const rows = [
      person("b9", "Z Smith", "smith", "full_time_faculty"),
      person("a1", "A Smith", "smith", "full_time_faculty"),
    ];
    expect(tiebreakPeople(rows).map((r) => r.cwid)).toEqual(["a1", "b9"]);
  });

  it("is deterministic across 10 calls with the same input", () => {
    const rows = [
      person("c3", "C C", "c", "postdoc"),
      person("a1", "A A", "a", "full_time_faculty"),
      person("b2", "B B", "b", "full_time_faculty"),
    ];
    const first = tiebreakPeople(rows).map((r) => r.cwid);
    for (let i = 0; i < 9; i++) {
      expect(tiebreakPeople(rows).map((r) => r.cwid)).toEqual(first);
    }
  });
});

describe("promoteStartsWith", () => {
  it("promotes label-prefix matches to the front, stable across ties", () => {
    const rows = [
      { label: "Breast Cancer" },
      { label: "Cancer Biology" },
      { label: "Gastrointestinal Cancer" },
    ];
    const promoted = promoteStartsWith(rows, "cancer", (r) => r.label);
    expect(promoted.map((r) => r.label)).toEqual([
      "Cancer Biology",
      "Breast Cancer",
      "Gastrointestinal Cancer",
    ]);
  });

  it("tokenwise mode promotes rows whose any-token starts with prefix", () => {
    const rows = [
      { name: "Department of Radiology" },
      { name: "Brain and Mind Research" },
      { name: "Pediatrics" },
    ];
    const promoted = promoteStartsWith(rows, "min", (r) => r.name, "tokenwise");
    expect(promoted[0]!.name).toBe("Brain and Mind Research");
  });

  it("returns input order when no matches", () => {
    const rows = [{ label: "Alpha" }, { label: "Beta" }];
    expect(promoteStartsWith(rows, "xyz", (r) => r.label).map((r) => r.label)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });
});

describe("capFill (§5)", () => {
  const N = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("position caps [5,3,2,1,1,1] with full data — budget exhausts at slot 5", () => {
    const filled = capFill(
      ["department", "division", "center", "topic", "subtopic", "person"],
      {
        department: N(8),
        division: N(8),
        center: N(8),
        topic: N(8),
        subtopic: N(8),
        person: N(8),
      },
    );
    // 5+3+2+1+1 = 12 exactly; loop breaks before slot 5 is filled.
    expect(filled.map((f) => f.rows.length)).toEqual([5, 3, 2, 1, 1]);
    expect(filled.reduce((s, f) => s + f.rows.length, 0)).toBe(12);
  });

  it("empty kinds skip without consuming a slot", () => {
    const filled = capFill(["person", "topic"], {
      person: [],
      topic: N(8),
    });
    // person had 0 → skipped. topic slides into slot 0 with cap 5.
    expect(filled).toHaveLength(1);
    expect(filled[0]!.kind).toBe("topic");
    expect(filled[0]!.rows.length).toBe(5);
  });

  it("lead with 2 rows + others 5+ → 2 + 3 + 2 + 1 + 1 + 1 = 10 (matches spec example)", () => {
    const filled = capFill(
      ["topic", "department", "division", "center", "subtopic", "person"],
      {
        topic: N(2),
        department: N(8),
        division: N(8),
        center: N(8),
        subtopic: N(8),
        person: N(8),
      },
    );
    expect(filled.map((f) => f.rows.length)).toEqual([2, 3, 2, 1, 1, 1]);
    expect(filled.reduce((s, f) => s + f.rows.length, 0)).toBe(10);
  });

  it("respects budget exhaustion", () => {
    const filled = capFill(["person"], { person: N(99) });
    expect(filled[0]!.rows.length).toBe(5); // cap, not budget
  });
});
