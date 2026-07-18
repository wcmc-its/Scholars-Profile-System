/**
 * §2.1 — freshness date semantics, extracted so they are unit-testable without
 * importing a script that runs `main()` on import (the freshness heartbeat and
 * the spotlight/hierarchy loaders all do).
 */

export interface AnchorRow {
  completedAt: Date | null;
  manifestGeneratedAt: Date | null;
}

/**
 * A source's age is measured from its latest successful `etl_run`. Prefer the
 * producer's `manifestGeneratedAt` (the S3 artifact's real publish moment) over
 * `completedAt` (the row's insert time): the spotlight/hierarchy loaders write a
 * fresh success row on an unchanged-sha256 short-circuit, which advances
 * `completedAt` but NOT the artifact — so anchoring on `completedAt` lets a
 * frozen producer read as fresh. Sources with no S3 manifest (ED, ReCiter, …)
 * leave `manifestGeneratedAt` NULL and fall back to `completedAt` (unchanged).
 */
export function freshnessAnchor(row: AnchorRow | null): Date | null {
  if (row === null) return null;
  return row.manifestGeneratedAt ?? row.completedAt;
}

/**
 * Parse a producer's `manifest.generated_at` for storage as the freshness
 * anchor. Returns null — so freshness falls back to `completedAt` — on anything
 * that would make the anchor lie:
 *   - absent / empty / non-ISO  → an Invalid Date's NaN age never exceeds the
 *     SLA, i.e. reads perpetually fresh (fail-open);
 *   - a FUTURE timestamp        → a negative age likewise never exceeds the SLA.
 * A null return on a manifest-bearing source is the caller's cue to WARN, so a
 * broken timestamp does not silently make the anchor inert.
 */
export function parseManifestGeneratedAt(iso: string | undefined, now: number): Date | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || ms > now) return null;
  return new Date(ms);
}
