import { NextResponse, type NextRequest } from "next/server";

import { resolveSearchPeopleTrialEvidence } from "@/lib/api/search-flags";
import { conceptSubtreeUis } from "@/lib/api/search-taxonomy";
import type { EvidenceTrial } from "@/lib/api/result-evidence";
import { searchClient, TRIALS_INDEX } from "@/lib/search";
import { TRIAL_STATUS_LABEL } from "@/components/search/trial-result-row";
import type { TrialDoc } from "@/lib/search-trial-evidence";

/**
 * GET /api/scholar/[cwid]/trials?conceptUi=<root>|descriptorUis=<a,b>
 *
 * Lazy per-scholar trials for a Matcha evidence block: the scholar's PI trials whose
 * ClinicalTrials.gov MeSH falls in the concept subtree, from `scholars-trials`.
 * Concept-only (no text arm), like the grants route's `matchedConcept` filter.
 * Mirrors the grants route: flag off or no concept ⇒ empty; never 500, a failure
 * answers 200 with `error: "search_failed"`.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const EMPTY: { trials: EvidenceTrial[]; total: number } = { trials: [], total: 0 };
const TRIAL_CAP = 3;

type Hit = Pick<TrialDoc, "trialId" | "nctNumber" | "title" | "statusKey" | "statusBucket" | "startYear">;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  if (!resolveSearchPeopleTrialEvidence()) return NextResponse.json(EMPTY, { headers: NO_STORE });
  const { cwid } = await params;
  const sp = request.nextUrl.searchParams;
  const conceptUi = sp.get("conceptUi") ?? "";
  const uis = conceptUi
    ? await conceptSubtreeUis(conceptUi)
    : (sp.get("descriptorUis") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (uis.length === 0) return NextResponse.json(EMPTY, { headers: NO_STORE });

  try {
    const r = await searchClient().search({
      index: TRIALS_INDEX,
      body: {
        size: TRIAL_CAP,
        track_total_hits: true,
        query: { bool: { filter: [{ term: { piCwids: cwid } }, { terms: { meshDescriptorUi: uis } }] } },
        // Recruiting first, then newest.
        sort: [
          { statusRank: { order: "asc", unmapped_type: "integer" } },
          { startDate: { order: "desc", missing: "_last", unmapped_type: "keyword" } },
          { trialId: "asc" },
        ],
        _source: ["trialId", "nctNumber", "title", "statusKey", "statusBucket", "startYear"],
      },
    });
    const body = r.body as unknown as { hits: { total: { value: number }; hits: Array<{ _source: Hit }> } };
    const trials: EvidenceTrial[] = body.hits.hits.map(({ _source: t }) => ({
      trialId: t.trialId,
      nctNumber: t.nctNumber,
      title: t.title,
      status: t.statusKey ? (TRIAL_STATUS_LABEL[t.statusKey] ?? null) : null,
      isActive: t.statusBucket === "active",
      startYear: t.startYear ?? null,
    }));
    return NextResponse.json({ trials, total: body.hits.total.value }, { headers: NO_STORE });
  } catch (err) {
    console.error("[trials-evidence] search failed", { cwid, err });
    return NextResponse.json({ ...EMPTY, error: "search_failed" }, { headers: NO_STORE });
  }
}
