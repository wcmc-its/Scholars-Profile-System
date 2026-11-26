/**
 * Method services on the PUBLIC method page: for one method family, the
 * services attached to it whose unit is publicly visible, each with the
 * publications of that page the unit collaborated on.
 *
 * The rule itself is `computeCollaboration` (`lib/method-services/
 * collaboration.ts`); this module only supplies its inputs:
 *   - the services: `method_service` is small (dozens of rows), so it is read
 *     whole and filtered in memory. Not cached: an owner's "Not ours" should
 *     show on the page straight away;
 *   - who the unit's people are, by the same sources the unit's own pages use:
 *     a department's active scholars (`Scholar.deptCode`, the predicate its
 *     Publications tab uses) and a core's curated staff list (`core_staff`);
 *   - which page publications one of them is a CONFIRMED author of, minus an
 *     authorship that person has hidden (ADR-005).
 *
 * The caller passes the page's pmids (`collectFamilyPmids`, already overlay
 * gated and dark-filtered), so nothing here can mark a paper that is not on
 * the page. Returns `[]` while `isMethodServicesEnabled()` is false, before
 * any query. SERVER-ONLY (imports `@/lib/db`).
 */
import { METHOD_SERVICE_SELECT, toMethodServiceView } from "@/lib/api/method-services";
import { loadPublicationSuppressions } from "@/lib/api/manual-layer";
import { corePath } from "@/lib/core-url";
import { db } from "@/lib/db";
import {
  compareServicesForBlock,
  computeCollaboration,
  isServiceUnitVisible,
  serviceCoversFamily,
  serviceDisplayLabels,
  type CollaborationReason,
  type ServiceUnitFacts,
} from "@/lib/method-services/collaboration";
import { isMethodServicesEnabled } from "@/lib/method-services/flags";
import type {
  MethodServiceEntityType,
  MethodServiceFamily,
  MethodServiceView,
} from "@/lib/method-services/validation";
import { officialUnitName } from "@/lib/org-unit-names";
import { isCorePagesEnabled } from "@/lib/profile/cores-flags";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";

const HARD_EXCLUDE_TYPES: ReadonlyArray<string> = FEED_EXCLUDED_TYPES;

/** A service's owning unit, resolved for display. */
export type ServiceUnit = {
  /** Fully resolved name: a department's official name, a core's name. */
  name: string;
  /** The unit's public page, or `null` when it has none. */
  href: string | null;
  visible: boolean;
};

/** One visible service on one method page. */
export type FamilyServiceCollaboration = {
  id: number;
  name: string;
  url: string;
  unitName: string;
  unitHref: string | null;
  /** What the filter and the badge call it: the unit's name (see
   *  `serviceDisplayLabels`). */
  label: string;
  /** Marked publications of the page, any publication type. */
  marked: Map<string, CollaborationReason>;
  /** Of those, the ones in the page's default view (research types). This is
   *  the N of "collaborated on N of the M publications listed here". */
  researchCount: number;
  /** Of those, the ones under "Show all publication types". */
  allCount: number;
};

const unitKey = (entityType: string, entityId: string) => `${entityType}:${entityId}`;

/** Resolve the owning units of `services`: name, public link, visibility. */
export async function loadServiceUnits(
  services: ReadonlyArray<{ entityType: MethodServiceEntityType; entityId: string }>,
): Promise<Map<string, ServiceUnit>> {
  const ids = (type: MethodServiceEntityType) => [
    ...new Set(services.filter((s) => s.entityType === type).map((s) => s.entityId)),
  ];
  const deptCodes = ids("department");
  const coreIds = ids("core");
  const corePagesOn = isCorePagesEnabled();

  const [departments, suppressions, cores] = await Promise.all([
    deptCodes.length === 0
      ? []
      : db.read.department.findMany({
          where: { code: { in: deptCodes } },
          select: { code: true, name: true, officialName: true, slug: true },
        }),
    deptCodes.length === 0
      ? []
      : db.read.suppression.findMany({
          where: { entityType: "department", entityId: { in: deptCodes }, revokedAt: null },
          select: { entityId: true },
        }),
    coreIds.length === 0
      ? []
      : db.read.core.findMany({
          where: { id: { in: coreIds } },
          select: { id: true, name: true, visible: true },
        }),
  ]);

  const out = new Map<string, ServiceUnit>();
  const suppressed = new Set(suppressions.map((s) => s.entityId));
  for (const d of departments) {
    const facts: ServiceUnitFacts = {
      entityType: "department",
      exists: true,
      suppressed: suppressed.has(d.code),
    };
    out.set(unitKey("department", d.code), {
      name: officialUnitName(d),
      href: `/departments/${d.slug}`,
      visible: isServiceUnitVisible(facts),
    });
  }
  for (const c of cores) {
    const facts: ServiceUnitFacts = {
      entityType: "core",
      exists: true,
      visible: c.visible,
      corePagesOn,
    };
    out.set(unitKey("core", c.id), {
      name: c.name,
      href: corePath(c.id),
      visible: isServiceUnitVisible(facts),
    });
  }
  return out;
}

/**
 * For each service, the subset of `pagePmids` with at least one confirmed
 * author who belongs to the service's unit. One member query per unit kind and
 * one authorship query in all. A service with automatic counting off is not
 * looked up (its entry is an empty set).
 */
export async function loadStaffPmidsByUnit(
  services: ReadonlyArray<{
    entityType: MethodServiceEntityType;
    entityId: string;
    countStaffPapers: boolean;
  }>,
  pagePmids: ReadonlyArray<string>,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const counting = services.filter((s) => s.countStaffPapers);
  if (counting.length === 0 || pagePmids.length === 0) return out;

  const deptCodes = [
    ...new Set(counting.filter((s) => s.entityType === "department").map((s) => s.entityId)),
  ];
  const coreIds = [
    ...new Set(counting.filter((s) => s.entityType === "core").map((s) => s.entityId)),
  ];
  const [deptMembers, coreStaff] = await Promise.all([
    deptCodes.length === 0
      ? []
      : db.read.scholar.findMany({
          where: { deptCode: { in: deptCodes }, deletedAt: null, status: "active" },
          select: { cwid: true, deptCode: true },
        }),
    coreIds.length === 0
      ? []
      : db.read.coreStaff.findMany({
          where: { coreId: { in: coreIds } },
          select: { cwid: true, coreId: true },
        }),
  ]);

  // cwid (lowercased: `core_staff` stores it so, a Scholar row may not) -> units.
  const unitsByCwid = new Map<string, Set<string>>();
  const add = (cwid: string, key: string) => {
    const k = cwid.toLowerCase();
    const set = unitsByCwid.get(k) ?? new Set<string>();
    set.add(key);
    unitsByCwid.set(k, set);
  };
  for (const m of deptMembers) if (m.deptCode) add(m.cwid, unitKey("department", m.deptCode));
  for (const s of coreStaff) add(s.cwid, unitKey("core", s.coreId));
  if (unitsByCwid.size === 0) return out;

  const authorships = await db.read.publicationAuthor.findMany({
    where: {
      pmid: { in: [...pagePmids] },
      isConfirmed: true,
      cwid: { in: [...unitsByCwid.keys()] },
    },
    select: { pmid: true, cwid: true },
  });
  if (authorships.length === 0) return out;

  // ADR-005: an authorship its author has hidden must not mark the paper.
  const { hiddenAuthorsByPmid } = await loadPublicationSuppressions(
    [...new Set(authorships.map((a) => a.pmid))],
    db.read,
  );
  for (const a of authorships) {
    if (!a.cwid) continue;
    const hidden = hiddenAuthorsByPmid.get(a.pmid);
    if (hidden && [...hidden].some((c) => c.toLowerCase() === a.cwid!.toLowerCase())) continue;
    for (const key of unitsByCwid.get(a.cwid.toLowerCase()) ?? []) {
      const set = out.get(key) ?? new Set<string>();
      set.add(a.pmid);
      out.set(key, set);
    }
  }
  return out;
}

/** Every stored service, as a view. Rows with a bad owner kind are dropped. */
export async function loadAllMethodServices(): Promise<MethodServiceView[]> {
  const rows = await db.read.methodService.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: METHOD_SERVICE_SELECT,
  });
  return rows.flatMap((r) => toMethodServiceView(r) ?? []);
}

/**
 * The page's publications, split by whether they are in the default view.
 * A family pmid with no `publication` row is not listed by the feed, so it is
 * not "on the page" and is left out of both sets.
 */
export async function loadPagePublicationSets(
  pagePmids: ReadonlyArray<string>,
): Promise<{ all: Set<string>; research: Set<string> }> {
  const all = new Set<string>();
  const research = new Set<string>();
  if (pagePmids.length === 0) return { all, research };
  const rows = await db.read.publication.findMany({
    where: { pmid: { in: [...pagePmids] } },
    select: { pmid: true, publicationType: true },
  });
  for (const r of rows) {
    all.add(r.pmid);
    // Same predicate as the feed's `notIn`, which a NULL type does not pass.
    if (r.publicationType !== null && !HARD_EXCLUDE_TYPES.includes(r.publicationType)) {
      research.add(r.pmid);
    }
  }
  return { all, research };
}

/**
 * The visible services for one method family with their collaborations, in
 * block order (most collaborations in the default view first, then name).
 * `pagePmids` is the family's gated pmid union (`collectFamilyPmids`).
 */
export async function loadFamilyServiceCollaborations(
  family: MethodServiceFamily,
  pagePmids: ReadonlyArray<string>,
): Promise<FamilyServiceCollaboration[]> {
  if (!isMethodServicesEnabled()) return [];
  const attached = (await loadAllMethodServices()).filter((s) => serviceCoversFamily(s, family));
  if (attached.length === 0) return [];

  const units = await loadServiceUnits(attached);
  const visible = attached.filter(
    (s) => units.get(unitKey(s.entityType, s.entityId))?.visible === true,
  );
  if (visible.length === 0) return [];

  const [page, staffByUnit] = await Promise.all([
    loadPagePublicationSets(pagePmids),
    loadStaffPmidsByUnit(visible, pagePmids),
  ]);

  const named = visible.map((s) => ({
    service: s,
    unit: units.get(unitKey(s.entityType, s.entityId))!,
  }));
  const labels = serviceDisplayLabels(
    named.map(({ service, unit }) => ({ id: service.id, name: service.name, unitName: unit.name })),
  );

  return named
    .map(({ service, unit }) => {
      const { marked } = computeCollaboration({
        pagePmids: page.all,
        supportedPmids: service.supportedPmids,
        excludedPmids: service.excludedPmids,
        countStaffPapers: service.countStaffPapers,
        staffPmids: staffByUnit.get(unitKey(service.entityType, service.entityId)) ?? new Set(),
      });
      let researchCount = 0;
      for (const pmid of marked.keys()) if (page.research.has(pmid)) researchCount += 1;
      return {
        id: service.id,
        name: service.name,
        url: service.url,
        unitName: unit.name,
        unitHref: unit.href,
        label: labels.get(service.id) ?? unit.name,
        marked,
        researchCount,
        allCount: marked.size,
      };
    })
    .sort((a, b) =>
      compareServicesForBlock(
        { count: a.researchCount, name: a.name, id: a.id },
        { count: b.researchCount, name: b.name, id: b.id },
      ),
    );
}
