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
import { isActiveTrialStatus, isHiddenTrialStatus } from "@/lib/api/profile";
import { phaseKey, sponsorTypeKey } from "@/lib/edit/clinical-trials-report";
import { PEOPLE_INDEX_WHERE } from "@/lib/search-index-docs";

/** `trials` = one entry per MeSH-tagged trial: its descriptor UIs, for the per-concept
 *  "Clinical research · N trials" count on the People card. */
export type TrialEvidence = { meshUi: string[]; text: string; trials: string[][] };

/** A `scholars-trials` document (`trialsIndexMapping`). */
export type TrialDoc = {
  trialId: string;
  nctNumber: string | null;
  title: string;
  briefSummary: string | null;
  conditions: string;
  meshTerms: string;
  meshDescriptorUi: string[];
  piNames: string;
  piCwids: string[];
  pis: Array<{ cwid: string; name: string; slug: string }>;
  status: string | null;
  statusBucket: "active" | "completed";
  phase: string;
  studyType: string | null;
  sponsorClass: string;
  principalSponsor: string | null;
};

type Resolver = (label: string) => Promise<MeshResolution | null>;

/** Label → descriptor UI, memoized per build. */
function memoResolver(resolve: Resolver) {
  const uiByLabel = new Map<string, string | null>();
  return {
    uiByLabel,
    async ui(label: string): Promise<string | null> {
      if (!uiByLabel.has(label)) uiByLabel.set(label, (await resolve(label))?.descriptorUi ?? null);
      return uiByLabel.get(label) ?? null;
    },
  };
}

// The resolver fails soft to null when the MeSH map can't load; indexing that
// would silently strip every trial's concept evidence, so fail the build instead.
function assertSomeResolved(what: string, uiByLabel: Map<string, string | null>) {
  if (uiByLabel.size > 0 && ![...uiByLabel.values()].some(Boolean)) {
    throw new Error(`${what}: none of ${uiByLabel.size} MeSH labels resolved — MeSH map unavailable?`);
  }
}

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
  resolve: Resolver = resolveMeshDescriptor,
): Promise<Map<string, TrialEvidence>> {
  const rows = await client.personClinicalTrial.findMany({
    where: cwid ? { cwid } : {},
    select: {
      cwid: true,
      trial: { select: { title: true, status: true, conditions: true, meshTerms: true } },
    },
  });

  const mesh = memoResolver(resolve);
  const acc = new Map<string, { ui: Set<string>; text: string[]; trials: string[][] }>();
  for (const r of rows) {
    if (isHiddenTrialStatus(r.trial.status)) continue;
    let e = acc.get(r.cwid);
    if (!e) acc.set(r.cwid, (e = { ui: new Set(), text: [], trials: [] }));
    const labels = splitTrialList(r.trial.meshTerms);
    e.text.push(r.trial.title, ...splitTrialList(r.trial.conditions), ...labels);
    const trialUis = new Set<string>();
    for (const label of labels) {
      const ui = await mesh.ui(label);
      if (ui) trialUis.add(ui);
    }
    for (const ui of trialUis) e.ui.add(ui);
    if (trialUis.size > 0) e.trials.push([...trialUis]);
  }

  assertSomeResolved("trial evidence", mesh.uiByLabel);

  const out = new Map<string, TrialEvidence>();
  for (const [k, e] of acc) out.set(k, { meshUi: [...e.ui], text: e.text.join(" "), trials: e.trials });
  return out;
}

/**
 * Docs for the `scholars-trials` index: public trials with at least one PI who
 * has a public profile, one doc per NCT number (else per protocol number), PIs
 * merged across the protocol rows that share an NCT.
 */
export async function loadTrialDocs(
  client: Pick<PrismaClient, "clinicalTrial">,
  resolve: Resolver = resolveMeshDescriptor,
): Promise<TrialDoc[]> {
  const trials = await client.clinicalTrial.findMany({
    where: { investigators: { some: { scholar: PEOPLE_INDEX_WHERE } } },
    select: {
      protocolNumber: true,
      nctNumber: true,
      title: true,
      status: true,
      phase: true,
      studyType: true,
      sponsorClass: true,
      principalSponsor: true,
      conditions: true,
      meshTerms: true,
      briefSummary: true,
      investigators: {
        where: { scholar: PEOPLE_INDEX_WHERE },
        select: { cwid: true, scholar: { select: { preferredName: true, slug: true } } },
      },
    },
    orderBy: { protocolNumber: "asc" },
  });

  const mesh = memoResolver(resolve);
  const byId = new Map<string, TrialDoc>();
  for (const t of trials) {
    if (isHiddenTrialStatus(t.status)) continue;
    const id = t.nctNumber ?? t.protocolNumber;
    let doc = byId.get(id);
    if (!doc) {
      const labels = splitTrialList(t.meshTerms);
      const uis = new Set<string>();
      for (const label of labels) {
        const ui = await mesh.ui(label);
        if (ui) uis.add(ui);
      }
      doc = {
        trialId: id,
        nctNumber: t.nctNumber,
        title: t.title,
        briefSummary: t.briefSummary,
        conditions: splitTrialList(t.conditions).join("; "),
        meshTerms: labels.join("; "),
        meshDescriptorUi: [...uis],
        piNames: "",
        piCwids: [],
        pis: [],
        status: t.status,
        statusBucket: isActiveTrialStatus(t.status) ? "active" : "completed",
        phase: phaseKey(t.phase),
        studyType: t.studyType,
        sponsorClass: sponsorTypeKey(t.sponsorClass),
        principalSponsor: t.principalSponsor,
      };
      byId.set(id, doc);
    }
    for (const inv of t.investigators) {
      if (doc.piCwids.includes(inv.cwid)) continue;
      doc.piCwids.push(inv.cwid);
      doc.pis.push({ cwid: inv.cwid, name: inv.scholar.preferredName, slug: inv.scholar.slug });
    }
  }
  assertSomeResolved("trial docs", mesh.uiByLabel);
  const docs = [...byId.values()];
  for (const d of docs) d.piNames = d.pis.map((p) => p.name).join("; ");
  return docs;
}
