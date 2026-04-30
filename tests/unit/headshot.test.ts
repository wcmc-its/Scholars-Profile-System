import { describe, expect, it } from "vitest";
import { identityImageEndpoint } from "@/lib/headshot";

describe("identityImageEndpoint", () => {
  it("builds the WCM directory URL for a CWID", () => {
    expect(identityImageEndpoint("abc1234")).toBe(
      "https://directory.weill.cornell.edu/api/v1/person/profile/abc1234.png?returnGenericOn404=false"
    );
  });

  it("always uses returnGenericOn404=false (never =true)", () => {
    const url = identityImageEndpoint("xyz9876");
    expect(url).toContain("returnGenericOn404=false");
    expect(url).not.toContain("returnGenericOn404=true");
  });

  it("does not throw on empty CWID", () => {
    expect(() => identityImageEndpoint("")).not.toThrow();
    expect(identityImageEndpoint("")).toContain(".png?returnGenericOn404=false");
  });
});
