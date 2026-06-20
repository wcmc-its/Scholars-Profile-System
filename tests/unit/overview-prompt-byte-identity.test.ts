import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  OVERVIEW_SYSTEM_PROMPT,
  OVERVIEW_SYSTEM_PROMPT_V3,
  OVERVIEW_SYSTEM_PROMPT_V4,
  resolveOverviewPromptImpl,
} from "@/lib/edit/overview-generator";
import {
  ENTITY_PROVENANCE_FLOOR,
  VERBATIM_STRINGS,
} from "@/lib/edit/overview-prompt-fragments";

/**
 * Byte-identity pins for the LIVE overview system prompts (#917 / v5 prep).
 *
 * The v5 (NIH-biosketch) work extracted `ENTITY_PROVENANCE_FLOOR` and
 * `VERBATIM_STRINGS` out of the inline v3/v4 prompt strings into a shared module so
 * the biosketch prompt reuses the SAME floor (the handoff §1 "kill drift" goal).
 * The current tests assert phrase-containment only and would NOT catch a dropped
 * newline at a block boundary, so these sha256 pins guard the assembled contracts.
 *
 * If you intentionally change an overview prompt, regenerate the hash below. If a
 * change to `overview-prompt-fragments.ts` flips one of these UNINTENTIONALLY, that
 * is the drift this test exists to stop — revert it.
 */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("overview system prompts — byte-identity pins", () => {
  it("v2 (OVERVIEW_SYSTEM_PROMPT) is unchanged", () => {
    expect(sha(OVERVIEW_SYSTEM_PROMPT)).toBe(
      "cc8f0f223b6c123c5d09ae5362d6c22b5c22830d6725c56a14c8633204d5d076",
    );
  });

  it("v3 (OVERVIEW_SYSTEM_PROMPT_V3) is unchanged after fragment extraction", () => {
    expect(sha(OVERVIEW_SYSTEM_PROMPT_V3)).toBe(
      "c80b9f250a3ba012a92c6e6cc35fd9cfa88e89d1772df708c9cbc553b9dc5d74",
    );
  });

  it("v4 (OVERVIEW_SYSTEM_PROMPT_V4) is unchanged after fragment extraction", () => {
    expect(sha(OVERVIEW_SYSTEM_PROMPT_V4)).toBe(
      "0899f62fb144ea9fcd4d86c23143acb19f8d2191286be0e40c5cd6bb861dcb30",
    );
  });

  it("the shared fragments are actually used by both v3 and v4", () => {
    const floor = ENTITY_PROVENANCE_FLOOR.join("\n");
    const verbatim = VERBATIM_STRINGS.join("\n");
    for (const prompt of [OVERVIEW_SYSTEM_PROMPT_V3, OVERVIEW_SYSTEM_PROMPT_V4]) {
      expect(prompt).toContain(floor);
      expect(prompt).toContain(verbatim);
    }
  });

  it("the v4 word band equals the v3 word band (v4 reuses V3_LENGTH_BANDS)", () => {
    expect(resolveOverviewPromptImpl("v4").lengthBands).toEqual(
      resolveOverviewPromptImpl("v3").lengthBands,
    );
  });
});
