import { describe, expect, it } from "vitest";

import { nicknamesEquivalent, nicknameVariants } from "@/lib/names/nicknames";

describe("nicknamesEquivalent", () => {
  it("pairs a formal name with its diminutives, and diminutives with each other", () => {
    expect(nicknamesEquivalent("Rob", "Robert")).toBe(true);
    expect(nicknamesEquivalent("bobby", "ROB")).toBe(true);
    expect(nicknamesEquivalent("Liz", "Elizabeth")).toBe(true);
    expect(nicknamesEquivalent("Bill", "William")).toBe(true);
  });

  it("is pairwise within a group, never transitive across groups", () => {
    expect(nicknamesEquivalent("Ted", "Edward")).toBe(true);
    expect(nicknamesEquivalent("Ted", "Theodore")).toBe(true);
    expect(nicknamesEquivalent("Edward", "Theodore")).toBe(false);
  });

  it("an identical name is not a nickname match", () => {
    expect(nicknamesEquivalent("Robert", "robert")).toBe(false);
  });

  it("leaves out transliteration short forms and cross-gender diminutives", () => {
    expect(nicknamesEquivalent("Effie", "Eftychia")).toBe(false);
    expect(nicknamesEquivalent("Amir", "Amirhossein")).toBe(false);
    expect(nicknamesEquivalent("Chris", "Christine")).toBe(false);
    expect(nicknamesEquivalent("Chris", "Christopher")).toBe(false);
    expect(nicknamesEquivalent("Alex", "Alexandra")).toBe(false);
    expect(nicknamesEquivalent("Robert", "Roberta")).toBe(false);
  });

  it("unknown names and empties are never equivalent", () => {
    expect(nicknamesEquivalent("Zorblat", "Robert")).toBe(false);
    expect(nicknamesEquivalent("", "")).toBe(false);
  });
});

describe("nicknameVariants", () => {
  it("lists every other member of the name's groups", () => {
    expect(nicknameVariants("Bob").sort()).toEqual(["bobby", "rob", "robbie", "robert"]);
    expect(nicknameVariants("ted")).toEqual(expect.arrayContaining(["edward", "theodore"]));
    expect(nicknameVariants("Zorblat")).toEqual([]);
  });
});
