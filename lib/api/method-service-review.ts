/**
 * Method services, editor side: the numbers under a saved service ("188
 * collaborations on the method page · 231 on your supported list, 167 of them
 * on the page") and its "Review publications" list, read by
 * `GET /api/edit/method-service`.
 *
 * Uses the SAME rule and the same inputs as the public method page
 * (`computeCollaboration`, `loadStaffPmidsByUnit`, the gated page pmids), so
 * the editor's count is the public sentence's count. Two differences, both on
 * purpose: the owning unit's visibility is ignored (a hidden core can prepare
 * its service), and a service attached to several methods is summed over them.
 *
 * "On the method page" means the page's default view (research publication
 * types), which is what the public sentence counts. A marked publication that
 * only shows under "Show all publication types" is still listed for review,
 * flagged `inDefaultView: false`, so the owner can take it off.
 *
 * SERVER-ONLY (imports `@/lib/db`). Types may be imported by a client component.
 */
import {
  loadPagePublicationSets,
  loadStaffPmidsByUnit,
} from "@/lib/api/method-service-collaborations";
import { collectFamilyPmids } from "@/lib/api/methods";
import { loadFamilyOverlayGate } from "@/lib/api/methods-overlay";
import { db } from "@/lib/db";
import {
  computeCollaboration,
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
  /** Why it is marked; `null` on an excluded row. */
  reason: CollaborationReason | null;
  /** The methods of this service whose page lists it. */
  methods: string[];
  /** Listed by the method page's default view. */
  inDefaultView: boolean;
};

export type ServiceReview = {
  /** Marked publications in the default view, across the service's methods. */
  collaborations: number;
  /** PMIDs on the supported list. */
  supportedListed: number;
  /** Of those, the ones a method page lists by default (excluded or not). */
  supportedOnPage: number;
  /** One entry per method, when the service has more than one. */
  perMethod: Array<{ familyLabel: string; collaborations: number; supportedOnPage: number }>;
  /** Every marked publication, newest first. */
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
      const [page, staff] = await Promise.all([
        loadPagePublicationSets(pmids),
        loadStaffPmidsByUnit([service], pmids),
      ]);
      const staffPmids = [...staff.values()][0] ?? new Set<string>();
      const { marked } = computeCollaboration({
        pagePmids: page.all,
        supportedPmids: service.supportedPmids,
        excludedPmids: service.excludedPmids,
        countStaffPapers: service.countStaffPapers,
        staffPmids,
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
    let collaborations = 0;
    for (const [pmid, reason] of m) {
      if (page.research.has(pmid)) collaborations += 1;
      const entry = marked.get(pmid);
      if (entry) {
        entry.methods.push(family.familyLabel);
        if (reason === "supported") entry.reason = "supported";
      } else {
        marked.set(pmid, { reason, methods: [family.familyLabel] });
      }
    }
    let supportedOnPage = 0;
    for (const pmid of supported) if (page.research.has(pmid)) supportedOnPage += 1;
    perMethod.push({ familyLabel: family.familyLabel, collaborations, supportedOnPage });
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
      reason,
      methods,
      inDefaultView: research.has(pmid),
    };
  };

  let supportedOnPage = 0;
  for (const pmid of supported) if (research.has(pmid)) supportedOnPage += 1;

  const markedRows = [...marked].map(([pmid, v]) => row(pmid, v.reason, v.methods)).sort(byNewest);
  return {
    collaborations: markedRows.filter((r) => r.inDefaultView).length,
    supportedListed: supported.size,
    supportedOnPage,
    perMethod: service.families.length > 1 ? perMethod : [],
    marked: markedRows,
    excluded: [...excludedSet].map((pmid) => row(pmid, null, onAnyPage.get(pmid) ?? [])).sort(byNewest),
  };
}
