import { describe, expect, it, vi } from "vitest";

import { getEffectiveOverview } from "@/lib/api/manual-layer";

type OverrideClient = Parameters<typeof getEffectiveOverview>[2];

/** A client whose `fieldOverride.findUnique` resolves to `row`. */
function client(row: unknown): OverrideClient {
  return {
    fieldOverride: { findUnique: vi.fn().mockResolvedValue(row) },
  } as unknown as OverrideClient;
}

describe("getEffectiveOverview", () => {
  it("returns the field_override value when one exists, ignoring the ETL column", async () => {
    const result = await getEffectiveOverview(
      "cwid1",
      "<p>stale ETL seed</p>",
      client({ value: "<p>my edited bio</p>" }),
    );
    expect(result).toBe("<p>my edited bio</p>");
  });

  it("returns the override value verbatim — it was sanitized on write, not re-cleaned", async () => {
    // A VIVO-artifact string would be altered by sanitizeVIVOHtml; the override
    // branch must not run it, so the value comes back unchanged.
    const stored = "<p>bio with a \\r\\n literal</p>";
    expect(await getEffectiveOverview("cwid1", null, client({ value: stored }))).toBe(stored);
  });

  it("treats an empty override as a deliberately-cleared bio (suppresses the ETL seed)", async () => {
    const result = await getEffectiveOverview(
      "cwid1",
      "<p>stale ETL seed</p>",
      client({ value: "" }),
    );
    expect(result).toBeNull();
  });

  it("falls back to the ETL column when there is no override", async () => {
    expect(await getEffectiveOverview("cwid1", "<p>ETL bio</p>", client(null))).toBe(
      "<p>ETL bio</p>",
    );
  });

  it("returns null when there is neither an override nor an ETL column", async () => {
    expect(await getEffectiveOverview("cwid1", null, client(null))).toBeNull();
  });

  it("looks the override up by the (scholar, cwid, overview) key", async () => {
    const c = client(null);
    await getEffectiveOverview("cwid9", null, c);
    expect(c.fieldOverride.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityType_entityId_fieldName: {
            entityType: "scholar",
            entityId: "cwid9",
            fieldName: "overview",
          },
        },
      }),
    );
  });
});
