import { describe, expect, it } from "vitest";

import { nicknamesEquivalent, nicknameVariants } from "@/lib/names/nicknames";

describe("nicknamesEquivalent", () => {
  it("pairs a formal name with its diminutives", () => {
    expect(nicknamesEquivalent("Rob", "Robert")).toBe(true);
    expect(nicknamesEquivalent("ROBERT", "bobby")).toBe(true);
    expect(nicknamesEquivalent("Liz", "Elizabeth")).toBe(true);
    expect(nicknamesEquivalent("Bill", "William")).toBe(true);
    expect(nicknamesEquivalent("Stephen", "Steven")).toBe(true);
    expect(nicknamesEquivalent("Steve", "Steven")).toBe(true);
  });

  it("never pairs two diminutives, even of the same formal name", () => {
    expect(nicknamesEquivalent("bobby", "rob")).toBe(false);
    expect(nicknamesEquivalent("Hank", "Harry")).toBe(false);
    expect(nicknamesEquivalent("Ned", "Ted")).toBe(false);
    expect(nicknamesEquivalent("Cat", "Kate")).toBe(false);
    expect(nicknamesEquivalent("Henry", "Harold")).toBe(false);
  });

  it("leaves out short forms that are now given names in their own right", () => {
    for (const [a, b] of [
      ["Jack", "John"],
      ["Max", "Maxwell"],
      ["Max", "Maximilian"],
      ["Tessa", "Theresa"],
      ["Lily", "Lillian"],
      ["Eliza", "Elizabeth"],
      ["Liza", "Elizabeth"],
      ["Molly", "Mary"],
      ["Polly", "Mary"],
      ["Sadie", "Sarah"],
      ["Sally", "Sarah"],
      ["Theo", "Theodore"],
      ["Tori", "Victoria"],
      ["Evie", "Evelyn"],
    ]) {
      expect(nicknamesEquivalent(a, b), `${a}|${b}`).toBe(false);
    }
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
  it("lists the formal name of a diminutive, and the diminutives of a formal name", () => {
    expect(nicknameVariants("Bob")).toEqual(["robert"]);
    expect(nicknameVariants("Robert").sort()).toEqual(["bob", "bobby", "rob", "robbie"]);
    expect(nicknameVariants("ted")).toEqual(expect.arrayContaining(["edward", "theodore"]));
    expect(nicknameVariants("Zorblat")).toEqual([]);
  });
});
