/**
 * Issue #259 §1.6 — `buildReciterParentTopicIdField` is the small pure
 * helper that derives the doc-level `reciterParentTopicId` field from the
 * joined `publicationTopics` rows. The semantic invariants are:
 *
 *   - Zero rows → field omitted (returns `{}`, not `{ reciterParentTopicId: [] }`).
 *   - Multiple scholars × same topic → one entry per topic (deduped).
 *   - Multiple topics → one entry per topic, all present.
 *   - parentTopicId is non-nullable at the schema level
 *     (prisma/schema.prisma:731, part of composite PK at :744), so no null
 *     handling is needed in the helper.
 */
import { describe, it, expect } from "vitest";
import { buildReciterParentTopicIdField } from "@/etl/search-index/index";

describe("buildReciterParentTopicIdField (§1.6 dedup + omit-on-empty)", () => {
  it("zero rows → omits the field (returns empty object for spreading)", () => {
    const result = buildReciterParentTopicIdField([]);
    expect(result).toEqual({});
    // Spreadable into a doc with no key contribution.
    const doc = { pmid: "1", ...result };
    expect(doc).not.toHaveProperty("reciterParentTopicId");
  });

  it("one topic, one scholar → single-entry array", () => {
    const result = buildReciterParentTopicIdField([
      { parentTopicId: "cardiology" },
    ]);
    expect(result).toEqual({ reciterParentTopicId: ["cardiology"] });
  });

  it("one topic, two scholars → deduped to one entry (post-Prisma-distinct safety)", () => {
    // In production this case is collapsed at the query layer by
    // `distinct: ["parentTopicId"]`; this asserts the JS-side belt-and-
    // braces handles a future relaxation of the distinct clause.
    const result = buildReciterParentTopicIdField([
      { parentTopicId: "cardiology" },
      { parentTopicId: "cardiology" },
    ]);
    expect(result).toEqual({ reciterParentTopicId: ["cardiology"] });
  });

  it("two distinct topics → both present, insertion order preserved", () => {
    const result = buildReciterParentTopicIdField([
      { parentTopicId: "cardiology" },
      { parentTopicId: "oncology" },
    ]);
    expect(result).toEqual({
      reciterParentTopicId: ["cardiology", "oncology"],
    });
  });

  it("interleaved duplicates across topics → each topic once, stable order", () => {
    const result = buildReciterParentTopicIdField([
      { parentTopicId: "cardiology" },
      { parentTopicId: "oncology" },
      { parentTopicId: "cardiology" },
      { parentTopicId: "oncology" },
      { parentTopicId: "neurology" },
    ]);
    expect(result).toEqual({
      reciterParentTopicId: ["cardiology", "oncology", "neurology"],
    });
  });
});
