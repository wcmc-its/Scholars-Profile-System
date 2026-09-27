/**
 * Clinical trials as People-search evidence (SEARCH_PEOPLE_TRIAL_EVIDENCE).
 *
 * Every `person_clinical_trial` row is a PI link (#2769). A trial's MeSH comes
 * from ClinicalTrials.gov's `conditionBrowseModule` (NLM-assigned), stored as
 * '; '-joined LABELS; this resolves them to descriptor UIs through the same
 * resolver the RePORTER grant keywords use (`etl/reporter/mesh.ts`), so the
 * concept query can match `trialMeshUi` like `publicationMeshUi`. Non-NCT
 * trials carry no MeSH and contribute title text only.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { resolveMeshDescriptor, type MeshResolution } from "@/lib/api/search-taxonomy";
import { isHiddenTrialStatus } from "@/lib/api/profile";

export type TrialEvidence = { meshUi: string[]; text: string };

export function splitTrialList(raw: string | null): string[] {
  return (raw ?? "").split(";").map((s) => s.trim()).filter(Boolean);
}

/**
 * Per-cwid trial evidence for the people doc. `cwid` scopes the read to one
 * scholar (the single-doc fast path); omitted, it loads every PI link (the ETL).
 * Trials the public profile hides (withdrawn / suspended) are excluded.
 */
export async function loadTrialEvidenceByCwid(
  client: Pick<PrismaClient, "personClinicalTrial">,
  cwid?: string,
  resolve: (label: string) => Promise<MeshResolution | null> = resolveMeshDescriptor,
): Promise<Map<string, TrialEvidence>> {
  const rows = await client.personClinicalTrial.findMany({
    where: cwid ? { cwid } : {},
    select: {
      cwid: true,
      trial: { select: { title: true, status: true, conditions: true, meshTerms: true } },
    },
  });

  const uiByLabel = new Map<string, string | null>();
  const acc = new Map<string, { ui: Set<string>; text: string[] }>();
  for (const r of rows) {
    if (isHiddenTrialStatus(r.trial.status)) continue;
    let e = acc.get(r.cwid);
    if (!e) acc.set(r.cwid, (e = { ui: new Set(), text: [] }));
    const labels = splitTrialList(r.trial.meshTerms);
    e.text.push(r.trial.title, ...splitTrialList(r.trial.conditions), ...labels);
    for (const label of labels) {
      if (!uiByLabel.has(label)) uiByLabel.set(label, (await resolve(label))?.descriptorUi ?? null);
      const ui = uiByLabel.get(label);
      if (ui) e.ui.add(ui);
    }
  }

  // The resolver fails soft to null when the MeSH map can't load; indexing that
  // would silently strip every trial's concept evidence, so fail the build instead.
  if (uiByLabel.size > 0 && ![...uiByLabel.values()].some(Boolean)) {
    throw new Error(`trial evidence: none of ${uiByLabel.size} MeSH labels resolved — MeSH map unavailable?`);
  }

  const out = new Map<string, TrialEvidence>();
  for (const [k, e] of acc) out.set(k, { meshUi: [...e.ui], text: e.text.join(" ") });
  return out;
}
