/**
 * #1502 — the tools-ETL sha256 short-circuit must not skip a rebuild when
 * Aurora-side ADR-005 suppression state changed under a byte-identical S3
 * artifact. `publicationSuppressionChangedSince` is that decision:
 *   - unchanged suppression since the last run → false (short-circuit holds);
 *   - a publication suppression CREATED or REVOKED since the last run → true
 *     (force a full rebuild so the stale baked sentences are re-filtered).
 */
import { describe, it, expect, vi } from "vitest";
import { publicationSuppressionChangedSince } from "@/etl/tools/suppression-freshness";

// Fake suppression client: findFirst answers the createdAt probe with `created`
// and the revokedAt probe with `revoked` (the two Promise.all branches).
const clientWith = (created: unknown, revoked: unknown) => {
  const findFirst = vi.fn(
    async ({ where }: { where: Record<string, unknown> }) =>
      "createdAt" in where ? created : revoked,
  );
  return { client: { suppression: { findFirst } }, findFirst };
};

describe("publicationSuppressionChangedSince", () => {
  const since = new Date("2026-07-01T00:00:00Z");

  it("returns true on a null baseline (first run) without querying", async () => {
    const { client, findFirst } = clientWith(null, null);
    expect(await publicationSuppressionChangedSince(client as never, null)).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns false when nothing changed since the last run (short-circuit holds)", async () => {
    const { client } = clientWith(null, null);
    expect(await publicationSuppressionChangedSince(client as never, since)).toBe(false);
  });

  it("returns true when a publication suppression was CREATED since the last run", async () => {
    const { client } = clientWith({ id: "s1" }, null);
    expect(await publicationSuppressionChangedSince(client as never, since)).toBe(true);
  });

  it("returns true when a publication suppression was REVOKED since the last run", async () => {
    const { client } = clientWith(null, { id: "s2" });
    expect(await publicationSuppressionChangedSince(client as never, since)).toBe(true);
  });

  it("scopes both probes to entityType 'publication' on the createdAt/revokedAt columns", async () => {
    const { client, findFirst } = clientWith(null, null);
    await publicationSuppressionChangedSince(client as never, since);
    const wheres = findFirst.mock.calls.map((c) => c[0].where);
    expect(wheres).toContainEqual({ entityType: "publication", createdAt: { gt: since } });
    expect(wheres).toContainEqual({ entityType: "publication", revokedAt: { gt: since } });
  });
});
