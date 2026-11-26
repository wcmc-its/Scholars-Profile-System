/**
 * Method services, editor side: the numbers under a saved service ("120
 * collaborations and 68 supported on the method page · 231 on the supported
 * list, 167 of them on the page") and its "Review publications" list, read by
 * `GET /api/edit/method-service`.
 *
 * Uses the SAME rule and the same inputs as the public method page
 * (`computeCollaboration`, `loadStaffPmidsByUnit`,
 * `loadCoreConfirmedPmidsByUnit`, the gated page pmids), so the editor's counts
 * are the public sentence's counts. It reads them directly, never through the
 * public page's cache, so a change shows at once. Two differences, both on
 * purpose: the owning unit's visibility is ignored (a hidden core's service can
 * be prepared), and a service attached to several methods is summed over them.
 *
 * "On the method page" means the page's default view (research publication
 * types), which is what the public sentence counts. A counted publication that
 * only shows under "Show all publication types" is still listed for review,
 * flagged `inDefaultView: false`, so it can be taken off.
 *
 * SERVER-ONLY (imports `@/lib/db`). Types may be imported by a client component.
 */
import {
  loadCoreConfirmedPmidsByUnit,
  loadPagePublicationSets,
  loadStaffPmidsByUnit,
} from "@/lib/api/method-service-collaborations";
import { collectFamilyPmids } from "@/lib/api/methods";
import { loadFamilyOverlayGate } from "@/lib/api/methods-overlay";
import { db } from "@/lib/db";
import {
  COLLABORATION_REASON_RANK,
  computeCollaboration,
  countKinds,
  kindOfReason,
  type CollaborationKind,
  type CollaborationReason,
} from "@/lib/method-services/collaboration";
import type { MethodServiceView } from "@/lib/method-services/validation";
import { isMethodsLensEnabled } from "@/lib/profile/methods-lens-flags";

export type ServiceReviewPublication = {
  pmid: string;
  /** `null` when Scholars holds no record of the PMID. */
  title: string | null;
  journal: string | null;
  year: number | null;
  /** Collaboration or support; `null` on an excluded row. */
  kind: CollaborationKind | null;
  /** Why it is counted; `null` on an excluded row. */
  reason: CollaborationReason | null;
  /** The methods of this service whose page lists it. */
  methods: string[];
  /** Listed by the method page's default view. */
  inDefaultView: boolean;
};

export type ServiceReview = {
  /** Counted publications in the default view with an author from the unit,
   *  across the service's methods. */
  collaborations: number;
  /** Counted publications in the default view the unit supported without
   *  authorship, across the service's methods. */
  support: number;
  /** PMIDs on the supported list. */
  supportedListed: number;
  /** Of those, the ones a method page lists by default (excluded or not). */
  supportedOnPage: number;
  /** One entry per method, when the service has more than one. */
  perMethod: Array<{
    familyLabel: string;
    collaborations: number;
    support: number;
    supportedOnPage: number;
  }>;
  /** Every counted publication, newest first. */
  marked: ServiceReviewPublication[];
  /** The excluded list ("Not ours"), newest first, for the undo. */
  excluded: ServiceReviewPublication[];
};

const byNewest = (a: ServiceReviewPublication, b: ServiceReviewPublication) =>
  (b.year ?? 0) - (a.year ?? 0) || Number(b.pmid) - Number(a.pmid);

export async function loadServiceReview(service: MethodServiceView): Promise<ServiceReview> {
  const supported = new Set(service.supportedPmids);
  const excludedSet = new Set(service.excludedPmids);

  const gate = isMethodsLensEnabled() ? await loadFamilyOverlayGate() : null;
  const pages = await Promise.all(
    service.families.map(async (family) => {
      // A gated family (suppressed, sensitive) has no page: it marks nothing.
      const pmids = gate
        ? await collectFamilyPmids(family.supercategory, family.familyLabel, gate)
        : [];
      const [page, staff, confirmed] = await Promise.all([
        loadPagePublicationSets(pmids),
        loadStaffPmidsByUnit([service], pmids),
        loadCoreConfirmedPmidsByUnit([service], pmids),
      ]);
      const staffPmids = [...staff.values()][0] ?? new Set<string>();
      const { marked } = computeCollaboration({
        pagePmids: page.all,
        supportedPmids: service.supportedPmids,
        excludedPmids: service.excludedPmids,
        coauthoredPmids: service.coauthoredPmids,
        countStaffPapers: service.countStaffPapers,
        staffPmids,
        confirmedPmids: [...confirmed.values()][0],
      });
      return { family, page, marked };
    }),
  );

  const marked = new Map<string, { reason: CollaborationReason; methods: string[] }>();
  const research = new Set<string>();
  const onAnyPage = new Map<string, string[]>();
  const perMethod: ServiceReview["perMethod"] = [];
  for (const { family, page, marked: m } of pages) {
    for (const pmid of page.research) research.add(pmid);
    for (const pmid of page.all) {
      onAnyPage.set(pmid, [...(onAnyPage.get(pmid) ?? []), family.familyLabel]);
    }
    const { collaborations, support } = countKinds(m, page.research);
    for (const [pmid, { reason }] of m) {
      const entry = marked.get(pmid);
      if (entry) {
        entry.methods.push(family.familyLabel);
        // The reason a publication on several of the service's methods shows.
        if (COLLABORATION_REASON_RANK[reason] < COLLABORATION_REASON_RANK[entry.reason]) {
          entry.reason = reason;
        }
      } else {
        marked.set(pmid, { reason, methods: [family.familyLabel] });
      }
    }
    let supportedOnPage = 0;
    for (const pmid of supported) if (page.research.has(pmid)) supportedOnPage += 1;
    perMethod.push({ familyLabel: family.familyLabel, collaborations, support, supportedOnPage });
  }

  const wanted = [...new Set([...marked.keys(), ...excludedSet])];
  const pubs =
    wanted.length === 0
      ? []
      : await db.read.publication.findMany({
          where: { pmid: { in: wanted } },
          select: { pmid: true, title: true, journal: true, year: true },
        });
  const pubByPmid = new Map(pubs.map((p) => [p.pmid, p]));
  const row = (
    pmid: string,
    reason: CollaborationReason | null,
    methods: string[],
  ): ServiceReviewPublication => {
    const p = pubByPmid.get(pmid);
    return {
      pmid,
      title: p?.title ?? null,
      journal: p?.journal ?? null,
      year: p?.year ?? null,
      kind: reason ? kindOfReason(reason) : null,
      reason,
      methods,
      inDefaultView: research.has(pmid),
    };
  };

  let supportedOnPage = 0;
  for (const pmid of supported) if (research.has(pmid)) supportedOnPage += 1;

  const markedRows = [...marked].map(([pmid, v]) => row(pmid, v.reason, v.methods)).sort(byNewest);
  return {
    collaborations: markedRows.filter((r) => r.inDefaultView && r.kind === "collaboration").length,
    support: markedRows.filter((r) => r.inDefaultView && r.kind === "support").length,
    supportedListed: supported.size,
    supportedOnPage,
    perMethod: service.families.length > 1 ? perMethod : [],
    marked: markedRows,
    excluded: [...excludedSet].map((pmid) => row(pmid, null, onAnyPage.get(pmid) ?? [])).sort(byNewest),
  };
}
