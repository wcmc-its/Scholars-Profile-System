import { describe, expect, it } from "vitest";

import { buildStewardDisplayName, parseStewardNameRows } from "@/etl/ed/steward-names";

describe("buildStewardDisplayName", () => {
  it("joins first + last", () => {
    expect(buildStewardDisplayName({ firstName: "David", lastName: "Doe" })).toBe("David Doe");
  });

  it("tolerates a missing component", () => {
    expect(buildStewardDisplayName({ firstName: "David", lastName: null })).toBe("David");
    expect(buildStewardDisplayName({ firstName: null, lastName: "Doe" })).toBe("Doe");
  });

  it("returns '' when neither is usable (so the export skips, never writes blank)", () => {
    expect(buildStewardDisplayName({ firstName: null, lastName: null })).toBe("");
    expect(buildStewardDisplayName({ firstName: "  ", lastName: "" })).toBe("");
  });
});

describe("parseStewardNameRows", () => {
  it("parses valid NDJSON, lower-casing the CWID", () => {
    const text = '{"cwid":"DWD2001","displayName":"David Doe"}\n{"cwid":"abc1234","displayName":"Ann B"}\n';
    const { rows, skipped } = parseStewardNameRows(text);
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      { cwid: "dwd2001", displayName: "David Doe" },
      { cwid: "abc1234", displayName: "Ann B" },
    ]);
  });

  it("drops blank lines silently and counts unparseable / missing-field lines", () => {
    const text = [
      "", // blank — ignored, NOT counted
      "not json", // counted
      '{"cwid":"x1"}', // missing displayName — counted
      '{"displayName":"No Cwid"}', // missing cwid — counted
      '{"cwid":"good1","displayName":"Good One"}',
    ].join("\n");
    const { rows, skipped } = parseStewardNameRows(text);
    expect(rows).toEqual([{ cwid: "good1", displayName: "Good One" }]);
    expect(skipped).toBe(3);
  });

  it("last value wins per CWID", () => {
    const text = '{"cwid":"d1","displayName":"Old"}\n{"cwid":"d1","displayName":"New"}\n';
    const { rows } = parseStewardNameRows(text);
    expect(rows).toEqual([{ cwid: "d1", displayName: "New" }]);
  });
});
