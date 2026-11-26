/**
 * Method services: which of a method page's publications are counted for a
 * unit's service, whether each is a collaboration or support, and whether a
 * service is shown at all. Pure, with no imports from `@/lib/db`: the public
 * loader (`lib/api/method-service-collaborations.ts`), the editor's review
 * loader and the client components all share it.
 *
 * Whether a publication is COUNTED, for ONE service on ONE method family:
 *   1. a pmid on the service's excluded list is never counted;
 *   2. a pmid on its supported list is counted;
 *   3. a core's confirmed publication (the engine's confirmed matches and the
 *      owner's claims) is counted, whatever the automatic toggle says;
 *   4. otherwise it is counted when automatic counting is on and a current
 *      member of the unit in Scholars is a confirmed author.
 * And in every case only a publication already on the method page can be
 * counted: neither list adds a paper to the page.
 *
 * What a counted publication IS:
 *   - a "collaboration" when someone from the unit is an author: a current
 *     unit member in Scholars (reason `staff`), or the pmid is on the
 *     supported list AND in the service's stored `coauthoredPmids`, the
 *     supported pmids with an author whose PubMed affiliation matches one of
 *     the service's phrases (reason `affiliation`);
 *   - "support" otherwise: on the supported list with no matching author
 *     (reason `supported`), or a core's confirmed publication with no unit
 *     author (reason `confirmed`).
 * The automatic toggle only decides whether a publication is counted (rule 4).
 * It never decides what a counted publication is called: a supported or
 * confirmed publication with a unit member as an author is a collaboration
 * with the toggle off too.
 */
import { methodFamilyKey, type MethodServiceFamily } from "@/lib/method-services/validation";

export type CollaborationKind = "collaboration" | "support";

/** Why a publication is counted. When several apply: `staff`, then
 *  `affiliation`, then `supported`, then `confirmed`. The first two make it a
 *  collaboration, the last two support. */
export type CollaborationReason = "staff" | "affiliation" | "supported" | "confirmed";

export type CollaborationMark = { kind: CollaborationKind; reason: CollaborationReason };

/** Which reason wins when several apply (lower first). */
export const COLLABORATION_REASON_RANK: Record<CollaborationReason, number> = {
  staff: 0,
  affiliation: 1,
  supported: 2,
  confirmed: 3,
};

export function kindOfReason(reason: CollaborationReason): CollaborationKind {
  return reason === "staff" || reason === "affiliation" ? "collaboration" : "support";
}

export type CollaborationInput = {
  /** The publications on the method page. */
  pagePmids: ReadonlySet<string>;
  supportedPmids: ReadonlyArray<string>;
  excludedPmids: ReadonlyArray<string>;
  /** The supported pmids with an author whose PubMed affiliation matches the
   *  unit (server-computed on save). Only counts for a pmid that is still on
   *  the supported list. */
  coauthoredPmids?: ReadonlyArray<string>;
  /** The service's automatic co-authorship toggle: whether a publication is
   *  counted on a unit member's authorship alone. */
  countStaffPapers: boolean;
  /** Publications with at least one confirmed author who belongs to the unit,
   *  whatever the toggle says. Need not be limited to the page; it is
   *  intersected here. */
  staffPmids: ReadonlySet<string>;
  /** A core's confirmed publications. Absent or empty for a department. Need
   *  not be limited to the page; it is intersected here. */
  confirmedPmids?: ReadonlySet<string>;
};

export type CollaborationResult = {
  /** The counted publications, each with what it is and why. */
  marked: Map<string, CollaborationMark>;
  /** Supported-list pmids that are on the page, excluded or not: the editor's
   *  "231 on the supported list, 167 of them on the page". */
  supportedOnPage: number;
};

export function computeCollaboration(input: CollaborationInput): CollaborationResult {
  const { pagePmids } = input;
  const excluded = new Set(input.excludedPmids);
  const coauthored = new Set(input.coauthoredPmids ?? []);
  const reasons = new Map<string, CollaborationReason>();
  const offer = (pmid: string, reason: CollaborationReason) => {
    if (!pagePmids.has(pmid) || excluded.has(pmid)) return;
    const current = reasons.get(pmid);
    if (
      current === undefined ||
      COLLABORATION_REASON_RANK[reason] < COLLABORATION_REASON_RANK[current]
    ) {
      reasons.set(pmid, reason);
    }
  };
  let supportedOnPage = 0;
  for (const pmid of new Set(input.supportedPmids)) {
    if (pagePmids.has(pmid)) supportedOnPage += 1;
    offer(pmid, coauthored.has(pmid) ? "affiliation" : "supported");
  }
  for (const pmid of input.confirmedPmids ?? []) offer(pmid, "confirmed");
  // Last, so "already counted" below means by the list or the core's record.
  for (const pmid of input.staffPmids) {
    // Toggle on: a unit author is enough to count it. Toggle off: a unit
    // author only turns an already counted publication into a collaboration.
    if (input.countStaffPapers || reasons.has(pmid)) offer(pmid, "staff");
  }
  const marked = new Map<string, CollaborationMark>();
  for (const [pmid, reason] of reasons) marked.set(pmid, { kind: kindOfReason(reason), reason });
  return { marked, supportedOnPage };
}

/** How many of `marked` (optionally only those in `within`) are each kind. */
export function countKinds(
  marked: ReadonlyMap<string, CollaborationMark>,
  within?: ReadonlySet<string>,
): { collaborations: number; support: number } {
  let collaborations = 0;
  let support = 0;
  for (const [pmid, mark] of marked) {
    if (within && !within.has(pmid)) continue;
    if (mark.kind === "collaboration") collaborations += 1;
    else support += 1;
  }
  return { collaborations, support };
}

/**
 * The public sentence under a service, as runs of text (`bold` for the
 * numbers), or `null` when the unit neither collaborated on nor supported any
 * of the listed publications. `unitName` carries no leading "the".
 *   N and S: "The {unit} collaborated on N and supported S of the M publications listed here."
 *   S = 0:   "The {unit} collaborated on N of the M publications listed here."
 *   N = 0:   "The {unit} supported S of the M publications listed here."
 */
export function serviceSentenceParts(
  unitName: string,
  collaborations: number,
  support: number,
  total: number,
): Array<{ text: string; bold?: true }> | null {
  if (collaborations <= 0 && support <= 0) return null;
  const n = collaborations.toLocaleString("en-US");
  const s = support.toLocaleString("en-US");
  const m = total.toLocaleString("en-US");
  const tail = { text: " publications listed here." };
  if (support <= 0) {
    return [{ text: `The ${unitName} collaborated on ` }, { text: `${n} of the ${m}`, bold: true }, tail];
  }
  if (collaborations <= 0) {
    return [{ text: `The ${unitName} supported ` }, { text: `${s} of the ${m}`, bold: true }, tail];
  }
  return [
    { text: `The ${unitName} collaborated on ` },
    { text: n, bold: true },
    { text: " and supported " },
    { text: `${s} of the ${m}`, bold: true },
    tail,
  ];
}

/** {@link serviceSentenceParts} as one string. */
export function serviceSentence(
  unitName: string,
  collaborations: number,
  support: number,
  total: number,
): string | null {
  return (
    serviceSentenceParts(unitName, collaborations, support, total)
      ?.map((p) => p.text)
      .join("") ?? null
  );
}

/**
 * What a service's filter is called. It always selects everything counted for
 * the service: "{Unit} collaborations" when nothing is support, "{Unit}
 * support" when nothing is a collaboration, otherwise "{Unit} collaborations
 * and support".
 */
export function serviceFilterLabel(label: string, collaborations: number, support: number): string {
  if (support <= 0) return `${label} collaborations`;
  if (collaborations <= 0) return `${label} support`;
  return `${label} collaborations and support`;
}

/** The badge on one publication row: "{Unit} collaboration" or "{Unit} support". */
export function serviceBadgeLabel(label: string, kind: CollaborationKind): string {
  return `${label} ${kind}`;
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

/** Public block order: most counted publications first, then by name. */
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
