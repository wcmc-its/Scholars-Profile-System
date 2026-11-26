/**
 * Method services: which of a method page's publications a unit collaborated
 * on, and whether a service is shown at all. Pure, with no imports from
 * `@/lib/db`: the public loader (`lib/api/method-service-collaborations.ts`),
 * the editor's review loader and the client components all share it.
 *
 * The rule, for ONE service on ONE method family, in strict precedence:
 *   1. a pmid on the service's excluded list is never marked;
 *   2. a pmid on its supported list is marked;
 *   3. otherwise it is marked when automatic counting is on and one of the
 *      unit's people is a confirmed author.
 * A core has one more source, which sits with its supported list at step 2:
 * the publications already confirmed as the core's own (the engine's confirmed
 * matches and the owner's claims). That is the core's record of what it
 * supported, so it does not depend on the automatic toggle, and "Not ours"
 * (step 1) still takes a paper off.
 * And in every case only a publication already on the method page can be
 * marked: neither list adds a paper to the page.
 */
import { methodFamilyKey, type MethodServiceFamily } from "@/lib/method-services/validation";

/** Why a publication is marked. When several apply: `supported`, then
 *  `confirmed`, then `staff`. */
export type CollaborationReason = "supported" | "confirmed" | "staff";

export type CollaborationInput = {
  /** The publications on the method page. */
  pagePmids: ReadonlySet<string>;
  supportedPmids: ReadonlyArray<string>;
  excludedPmids: ReadonlyArray<string>;
  /** The service's automatic co-authorship toggle. */
  countStaffPapers: boolean;
  /** Publications with at least one confirmed author who belongs to the unit.
   *  Need not be limited to the page; it is intersected here. */
  staffPmids: ReadonlySet<string>;
  /** A core's confirmed publications. Absent or empty for a department. Need
   *  not be limited to the page; it is intersected here. */
  confirmedPmids?: ReadonlySet<string>;
};

export type CollaborationResult = {
  /** The marked publications, each with the reason it is marked. */
  marked: Map<string, CollaborationReason>;
  /** Supported-list pmids that are on the page, excluded or not: the editor's
   *  "231 on your supported list, 167 of them on the page". */
  supportedOnPage: number;
};

export function computeCollaboration(input: CollaborationInput): CollaborationResult {
  const { pagePmids } = input;
  const excluded = new Set(input.excludedPmids);
  const marked = new Map<string, CollaborationReason>();
  let supportedOnPage = 0;
  for (const pmid of new Set(input.supportedPmids)) {
    if (!pagePmids.has(pmid)) continue;
    supportedOnPage += 1;
    if (!excluded.has(pmid)) marked.set(pmid, "supported");
  }
  for (const pmid of input.confirmedPmids ?? []) {
    if (!pagePmids.has(pmid) || excluded.has(pmid) || marked.has(pmid)) continue;
    marked.set(pmid, "confirmed");
  }
  if (input.countStaffPapers) {
    for (const pmid of input.staffPmids) {
      if (!pagePmids.has(pmid) || excluded.has(pmid) || marked.has(pmid)) continue;
      marked.set(pmid, "staff");
    }
  }
  return { marked, supportedOnPage };
}

/** Whether a service is attached to this method family (exact key match, the
 *  same `(supercategory, familyLabel)` a method page resolves on). */
export function serviceCoversFamily(
  service: { families: ReadonlyArray<MethodServiceFamily> },
  family: MethodServiceFamily,
): boolean {
  const key = methodFamilyKey(family);
  return service.families.some((f) => methodFamilyKey(f) === key);
}

/** What is known about a service's owning unit when deciding to show it. */
export type ServiceUnitFacts =
  | {
      entityType: "department";
      /** The department row exists. */
      exists: boolean;
      /** An active whole-unit suppression (a retired department: its page 404s). */
      suppressed: boolean;
    }
  | {
      entityType: "core";
      /** The core row exists. */
      exists: boolean;
      /** The per-core `Core.visible` toggle. */
      visible: boolean;
      /** The global `CORE_PAGES` flag. */
      corePagesOn: boolean;
    };

/**
 * A service is public only while its unit is: a department that exists and is
 * not suppressed, or a core that is visible with core pages on (the two things
 * `/browse` requires before it lists a core). Anything else, including a unit
 * kind that cannot own a service, is not shown at all: no block entry, no
 * filter, no badge.
 */
export function isServiceUnitVisible(facts: ServiceUnitFacts | null | undefined): boolean {
  if (!facts || !facts.exists) return false;
  if (facts.entityType === "department") return !facts.suppressed;
  if (facts.entityType === "core") return facts.visible && facts.corePagesOn;
  return false;
}

/**
 * The name each service's filter and badge carry: the unit's name, plus the
 * service's own name only when the same unit has more than one service on the
 * page (otherwise two controls would read identically).
 */
export function serviceDisplayLabels(
  services: ReadonlyArray<{ id: number; name: string; unitName: string }>,
): Map<number, string> {
  const perUnit = new Map<string, number>();
  for (const s of services) perUnit.set(s.unitName, (perUnit.get(s.unitName) ?? 0) + 1);
  return new Map(
    services.map((s) => [
      s.id,
      (perUnit.get(s.unitName) ?? 0) > 1 ? `${s.unitName} (${s.name})` : s.unitName,
    ]),
  );
}

/** Public block order: most collaborations first, then by name. */
export function compareServicesForBlock(
  a: { count: number; name: string; id: number },
  b: { count: number; name: string; id: number },
): number {
  return b.count - a.count || a.name.localeCompare(b.name) || a.id - b.id;
}

/** "the Example Library", never "the The Example Library". */
export function withArticle(unitName: string): string {
  return `the ${unitName.replace(/^the\s+/i, "")}`;
}

/** The `?service=` value: a positive service id, at most 9 digits. */
export function parseServiceParam(raw: string | null | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,8}$/.test(raw)) return null;
  return Number(raw);
}
