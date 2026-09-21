/** `normalizeOrcid` — shape, check digit, and input forms (Identifiers & Profiles tab). */
import { describe, expect, it } from "vitest";

import { normalizeOrcid } from "@/lib/edit/orcid";

describe("normalizeOrcid", () => {
  it("accepts the dashed iD, the bare digits, and the orcid.org URL, returning the dashed form", () => {
    for (const input of [
      "0000-0002-1825-0097",
      "0000000218250097",
      "https://orcid.org/0000-0002-1825-0097",
      "http://www.orcid.org/0000-0002-1825-0097 ",
    ]) {
      expect(normalizeOrcid(input)).toBe("0000-0002-1825-0097");
    }
  });

  it("keeps an X check digit, upper-cased", () => {
    expect(normalizeOrcid("0000-0002-1694-233x")).toBe("0000-0002-1694-233X");
  });

  it("refuses a wrong check digit (a one-digit typo), a short iD, and junk", () => {
    expect(normalizeOrcid("0000-0002-1825-0098")).toBeNull();
    expect(normalizeOrcid("0000-0002-1825-009")).toBeNull();
    expect(normalizeOrcid("not an orcid")).toBeNull();
    expect(normalizeOrcid("")).toBeNull();
  });
});
