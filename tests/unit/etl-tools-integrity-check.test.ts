/**
 * #2117 — the tools ETL's three sha256 manifest-object checks (primary
 * tools.json, tool_context.json sidecar, entities.json/entity_context.json
 * entity layer) previously used `if (expected && digest !== expected)`,
 * which short-circuited to false — and silently skipped verification — when
 * the manifest object's sha256 field was itself absent. `shaIntegrityFailed`
 * is the single predicate all three sites now share; this locks the
 * fail-CLOSED semantics (absent sha256 ⇒ integrity check fails, matching
 * etl/hierarchy/index.ts and etl/spotlight/index.ts).
 */
import { describe, expect, it } from "vitest";

import { shaIntegrityFailed } from "@/etl/tools/integrity-check";

const DIGEST = "aeb0a8f1a5a48ec502de341a817d4a6fe07699fbf40e8bb66d6382dff798fc5";

describe("shaIntegrityFailed", () => {
  it("fails when the manifest object's sha256 is absent (undefined) — tools.json site", () => {
    expect(shaIntegrityFailed(undefined, DIGEST)).toBe(true);
  });

  it("fails when the manifest object's sha256 is absent (undefined) — tool_context.json site", () => {
    // Same predicate, exercised with the ctxObj.sha256 call-site shape.
    const ctxObj: { sha256?: string } = { sha256: undefined };
    expect(shaIntegrityFailed(ctxObj.sha256, DIGEST)).toBe(true);
  });

  it("fails when the manifest object's sha256 is absent (undefined) — entity-layer site", () => {
    // Same predicate, exercised with the entities.json/entity_context.json loop's obj.sha256 shape.
    const obj: { sha256?: string } = {};
    expect(shaIntegrityFailed(obj.sha256, DIGEST)).toBe(true);
  });

  it("fails when the manifest object's sha256 is an empty string", () => {
    expect(shaIntegrityFailed("", DIGEST)).toBe(true);
  });

  it("fails when a present sha256 does not match the fetched digest", () => {
    expect(shaIntegrityFailed("some-other-sha", DIGEST)).toBe(true);
  });

  it("passes when a present sha256 matches the fetched digest", () => {
    expect(shaIntegrityFailed(DIGEST, DIGEST)).toBe(false);
  });
});
