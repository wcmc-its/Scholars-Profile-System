import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("sanity", () => {
  it("imports work and the test runner is wired up", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("tailwind-merge resolves conflicting classes", () => {
    expect(cn("px-2 px-4")).toBe("px-4");
  });
});
