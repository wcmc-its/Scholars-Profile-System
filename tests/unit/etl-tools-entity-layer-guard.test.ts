/**
 * #1166 regression — the entity layer (family_entity + family_entity_usage) must be
 * left UNTOUCHED unless the manifest ships BOTH sidecars. The tools ETL previously ran
 * the entity `deleteMany` unconditionally, so a manifest missing one sidecar silently
 * wiped ~4k rows on a run that still reported success. `entityLayerComplete` is the
 * single predicate both the load- and write-side guards consult; this locks the `||`
 * semantics (missing EITHER sidecar ⇒ not complete ⇒ skip the wipe).
 */
import { describe, expect, it } from "vitest";

import { entityLayerComplete } from "@/etl/tools/entity-layer-guard";

const obj = (key: string) => ({ key, bytes: 1, sha256: "x" });

describe("entityLayerComplete", () => {
  it("is true only when BOTH sidecars are present", () => {
    expect(
      entityLayerComplete({
        objects: { "entities.json": obj("tools/latest/entities.json"), "entity_context.json": obj("tools/latest/entity_context.json") },
      }),
    ).toBe(true);
  });

  it("is false when entities.json is missing (partial manifest ⇒ skip the wipe)", () => {
    expect(
      entityLayerComplete({ objects: { "entity_context.json": obj("tools/latest/entity_context.json") } }),
    ).toBe(false);
  });

  it("is false when entity_context.json is missing", () => {
    expect(
      entityLayerComplete({ objects: { "entities.json": obj("tools/latest/entities.json") } }),
    ).toBe(false);
  });

  it("is false for a pre-v4 manifest with neither sidecar", () => {
    expect(entityLayerComplete({ objects: { "tools.json": obj("tools/latest/tools.json") } })).toBe(false);
  });

  it("is false when an object is declared but its key is empty/absent", () => {
    // A manifest that lists the object with no usable key must not trigger the wipe.
    expect(
      entityLayerComplete({
        objects: { "entities.json": { key: "" }, "entity_context.json": obj("tools/latest/entity_context.json") },
      }),
    ).toBe(false);
  });

  it("is false when the objects map is absent entirely", () => {
    expect(entityLayerComplete({})).toBe(false);
  });
});
