import { describe, expect, it } from "vitest";
import { reciterDbConfigWarning } from "@/lib/sources/reciterdb";

describe("reciterDbConfigWarning", () => {
  it("is silent when ReciterDB is configured", () => {
    expect(reciterDbConfigWarning({ SCHOLARS_RECITERDB_HOST: "h" })).toBeNull();
  });
  it("is silent when both bridges are on (staging/prod shape)", () => {
    expect(
      reciterDbConfigWarning({ MENTORING_COPUB_BRIDGE: "on", PUBLICATION_CITING_BRIDGE: "on" }),
    ).toBeNull();
  });
  it("names only the bridges still on the live path", () => {
    const w = reciterDbConfigWarning({ MENTORING_COPUB_BRIDGE: "on" });
    expect(w).toContain("PUBLICATION_CITING_BRIDGE");
    expect(w).not.toContain("MENTORING_COPUB_BRIDGE");
  });
});
