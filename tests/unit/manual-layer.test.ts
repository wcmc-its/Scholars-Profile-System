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

  it("does not apply the VIVO cleanup to an override value", async () => {
    // The override branch must not run sanitizeVIVOHtml — that ETL-artifact
    // cleanup is for the ETL column, not a value the scholar deliberately wrote.
    const stored = "<p>bio with allowed <strong>emphasis</strong></p>";
    expect(await getEffectiveOverview("cwid1", null, client({ value: stored }))).toBe(stored);
  });

  it("re-sanitizes the override value at read as defense-in-depth", async () => {
    // The write path sanitizes, but the public profile renders this value via
    // raw dangerouslySetInnerHTML — re-sanitizing on read is a second net
    // against a value that reached the column unsanitized. (Security review, #356.)
    const result = await getEffectiveOverview(
      "cwid1",
      null,
      client({ value: "<p>safe</p><script>alert(1)</script>" }),
    );
    expect(result).not.toContain("<script");
    expect(result).toContain("<p>safe</p>");
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
