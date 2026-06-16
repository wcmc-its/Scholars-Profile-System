/**
 * Shared #800 suppression / #801 sensitivity overlay gate for the Methods lens.
 *
 * The family overlays — `FamilySuppressionOverlay` (#800, unconditional) and
 * `FamilySensitivityOverlay` (#801, applied only when the sensitivity gate is on)
 * — both key on the STABLE `(supercategory, family_label)` identity (the family
 * `@@id`), never the re-mintable `family_id`. The per-scholar Methods lens already
 * applies this gate inline in `partitionScholarFamilies` (`lib/api/profile.ts`);
 * the standalone cross-scholar Method pages and their search surfacing must apply
 * the SAME gate to every roster, count, and candidate set. Extracting it here gives
 * both surfaces ONE implementation so suppression/sensitivity can never diverge
 * between the per-profile lens and the cross-scholar pages.
 *
 * Server-only (reads the flag + queries the overlays via Prisma); never import
 * into a client component.
 */
import { prisma } from "@/lib/db";
import { isMethodsLensSensitiveGateOn } from "@/lib/profile/methods-lens-flags";

/**
 * Stable composite key for the #800/#801 overlays. "::" is collision-proof
 * because A2 supercategory ids are snake_case and never contain a colon.
 * (Moved verbatim from `lib/api/profile.ts` so both surfaces share one key fn.)
 */
export const familyOverlayKey = (supercategory: string, familyLabel: string): string =>
  `${supercategory}::${familyLabel}`;

/**
 * The resolved overlay gate for one request: the set of `(supercategory,
 * family_label)` keys that are #800-suppressed (always hidden) and the set that
 * are #801-sensitive (hidden publicly only when `METHODS_LENS_SENSITIVE_GATE=on`).
 *
 * `sensitive` is EMPTY when the sensitivity gate is off — mirroring the
 * per-profile `partitionScholarFamilies` behavior, where the gate-off path never
 * queries `FamilySensitivityOverlay` and treats every non-suppressed family as
 * public. Callers pass this object to {@link isFamilyPubliclyVisible}.
 */
export type FamilyOverlayGate = {
  /** `(sc,label)` keys with an active #800 suppression — always hidden. */
  suppressed: Set<string>;
  /** `(sc,label)` keys with an active #801 sensitivity overlay — hidden publicly
   *  only when the sensitivity gate is on; empty otherwise. */
  sensitive: Set<string>;
};

/**
 * Load the request-scoped overlay gate. One query for the suppression overlay
 * (always), plus a second for the sensitivity overlay ONLY when the sensitivity
 * gate is on (skipped otherwise, so `sensitive` stays empty — same query economy
 * as `partitionScholarFamilies`). Per-request, never cached: the overlays are an
 * Aurora query-time merge (reversible with no rebuild), so caching would
 * reintroduce the staleness window the overlay exists to close.
 *
 * `opts.forceSensitive` (#824 §4c) ALWAYS loads the `FamilySensitivityOverlay`,
 * ignoring `isMethodsLensSensitiveGateOn()`. The people search index is a PUBLIC
 * surface, so it must exclude sensitive families regardless of the runtime
 * sensitivity flag — otherwise a #801-sensitive family would leak into public
 * search ranking the moment the gate flag is off. The index builders pass this
 * option; no other caller does, so the DEFAULT (no `opts`) is BYTE-IDENTICAL to
 * today's gate-conditional behavior the per-profile lens relies on.
 */
export async function loadFamilyOverlayGate(
  opts?: { forceSensitive?: boolean },
): Promise<FamilyOverlayGate> {
  const suppression = await prisma.familySuppressionOverlay.findMany({
    select: { supercategory: true, familyLabel: true },
  });
  const suppressed = new Set(
    suppression.map((o) => familyOverlayKey(o.supercategory, o.familyLabel)),
  );

  if (!opts?.forceSensitive && !isMethodsLensSensitiveGateOn()) {
    return { suppressed, sensitive: new Set<string>() };
  }

  const sensitivity = await prisma.familySensitivityOverlay.findMany({
    select: { supercategory: true, familyLabel: true },
  });
  const sensitive = new Set(
    sensitivity.map((o) => familyOverlayKey(o.supercategory, o.familyLabel)),
  );
  return { suppressed, sensitive };
}

/**
 * Whether a family identified by `(supercategory, family_label)` may be shown on
 * a PUBLIC cross-scholar surface, given a loaded {@link FamilyOverlayGate}. False
 * when the family is #800-suppressed OR #801-sensitive (and the sensitivity gate
 * is on — `gate.sensitive` is empty when off, so the sensitivity clause is a
 * no-op then). There is NO public reveal of a sensitive family on cross-scholar
 * pages; the only reveal stays per-profile.
 */
export function isFamilyPubliclyVisible(
  supercategory: string,
  familyLabel: string,
  gate: FamilyOverlayGate,
): boolean {
  const key = familyOverlayKey(supercategory, familyLabel);
  return !gate.suppressed.has(key) && !gate.sensitive.has(key);
}
