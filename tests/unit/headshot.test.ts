import { describe, expect, it } from "vitest";
import { identityImageEndpoint } from "@/lib/headshot";
import { FIXTURE_CWID, EXPECTED_HEADSHOT_URL } from "../fixtures/scholar";

describe("identityImageEndpoint", () => {
  it("returns the WCM directory URL with returnGenericOn404=false for a valid CWID", () => {
    expect(identityImageEndpoint(FIXTURE_CWID)).toBe(EXPECTED_HEADSHOT_URL);
  });

  it("hardcodes returnGenericOn404=false (not =true)", () => {
    const url = identityImageEndpoint(FIXTURE_CWID);
    expect(url).toContain("returnGenericOn404=false");
    expect(url).not.toContain("returnGenericOn404=true");
  });

  it("uses .png extension and the cwid in the path segment", () => {
    expect(identityImageEndpoint("xyz9999")).toContain("/xyz9999.png?");
  });
});
