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
  /** Fine-grained status (Status facet + pill): CT.gov's overallStatus, else OnCore's mapped. */
  statusKey: TrialStatusKey;
  /** Recruiting first sort: 0 recruiting, 1 active not recruiting, 2 the rest. */
  statusRank: number;
  /** "YYYY-MM" (CT.gov start, else OnCore's first open-to-accrual date); null = unknown. */
  startDate: string | null;
  startYear: number | null;
  startEstimated: boolean;
  /** "YYYY-MM" primary completion; null = unknown. */
  endDate: string | null;
  endEstimated: boolean;
  /** '; '-joined "Type: Name". */
  interventions: string | null;
  /** Raw CT.gov enums (DRUG, BIOLOGICAL, …), the Intervention type facet. */
  interventionTypes: string[];
  hasResults: boolean;
  phase: string;
  studyType: string | null;
  /** Study type facet keys: normalized CT.gov study type, plus `not_ctgov` for OnCore-only protocols. */
  studyTypeKeys: string[];
  /** Distinct primary departments of the listed PIs. */
  departments: string[];
  /** MeSH condition labels as keywords (the Condition facet). */
  meshLabels: string[];
  sponsorClass: string;
  principalSponsor: string | null;
};

export type TrialStatusKey =
  | "recruiting"
  | "not_yet_recruiting"
  | "enrolling_by_invitation"
  | "active_not_recruiting"
  | "completed"
  | "terminated";
const CTGOV_STATUS = new Set<string>([
  "recruiting", "not_yet_recruiting", "enrolling_by_invitation", "active_not_recruiting", "completed", "terminated",
]);

/** CT.gov's overallStatus when it's one we show; else OnCore's institutional
 *  status (open to accrual → recruiting, closed to accrual → active not
 *  recruiting, anything else → completed). Withdrawn / suspended never get
 *  here: they are hidden upstream by the OnCore status, like the profile (D2). */
export function trialStatusKey(ctgovStatus: string | null, oncoreStatus: string | null): TrialStatusKey {
  const c = (ctgovStatus ?? "").toLowerCase();
  if (CTGOV_STATUS.has(c)) return c as TrialStatusKey;
  const o = (oncoreStatus ?? "").toLowerCase();
  if (o.includes("open to accrual")) return "recruiting";
  if (o.includes("closed to accrual")) return "active_not_recruiting";
  return isActiveTrialStatus(oncoreStatus) ? "recruiting" : "completed";
}

const month = (d: string | null) => (d && /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : null);

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

/** "INTERVENTIONAL" / "Interventional" / "Expanded Access" → "interventional" / "expanded_access". */
export function studyTypeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
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

function trialStatusFields(statusKey: TrialStatusKey) {
  const active = ["recruiting", "not_yet_recruiting", "enrolling_by_invitation", "active_not_recruiting"];
  return {
    statusKey,
    statusBucket: (active.includes(statusKey) ? "active" : "completed") as TrialDoc["statusBucket"],
    statusRank: statusKey === "recruiting" || statusKey === "enrolling_by_invitation" ? 0 : statusKey === "active_not_recruiting" ? 1 : 2,
  };
}

/** CT.gov dates; a trial without them (no NCT) starts at OnCore's first open-to-accrual date. */
function trialDates(t: {
  startDate: string | null;
  startDateType: string | null;
  primaryCompletionDate: string | null;
  primaryCompletionDateType: string | null;
  firstOtaDate: Date | null;
}) {
  const startDate = month(t.startDate) ?? (t.firstOtaDate ? t.firstOtaDate.toISOString().slice(0, 7) : null);
  return {
    startDate,
    startYear: startDate ? Number(startDate.slice(0, 4)) : null,
    startEstimated: month(t.startDate) !== null && t.startDateType === "ESTIMATED",
    endDate: month(t.primaryCompletionDate),
    endEstimated: t.primaryCompletionDateType === "ESTIMATED",
  };
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
      ctgovStatus: true,
      startDate: true,
      startDateType: true,
      primaryCompletionDate: true,
      primaryCompletionDateType: true,
      hasResults: true,
      interventions: true,
      interventionTypes: true,
      firstOtaDate: true,
      investigators: {
        where: { scholar: PEOPLE_INDEX_WHERE },
        select: { cwid: true, scholar: { select: { preferredName: true, slug: true, primaryDepartment: true } } },
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
        ...trialStatusFields(trialStatusKey(t.ctgovStatus, t.status)),
        ...trialDates(t),
        interventions: t.interventions,
        interventionTypes: splitTrialList(t.interventionTypes),
        hasResults: t.hasResults === true,
        phase: phaseKey(t.phase),
        studyType: t.studyType,
        studyTypeKeys: [
          ...(t.studyType ? [studyTypeKey(t.studyType)] : []),
          ...(t.nctNumber ? [] : ["not_ctgov"]),
        ],
        departments: [],
        meshLabels: labels,
        sponsorClass: sponsorTypeKey(t.sponsorClass),
        principalSponsor: t.principalSponsor,
      };
      byId.set(id, doc);
    }
    for (const inv of t.investigators) {
      if (doc.piCwids.includes(inv.cwid)) continue;
      doc.piCwids.push(inv.cwid);
      doc.pis.push({ cwid: inv.cwid, name: inv.scholar.preferredName, slug: inv.scholar.slug });
      const dept = inv.scholar.primaryDepartment;
      if (dept && !doc.departments.includes(dept)) doc.departments.push(dept);
    }
  }
  assertSomeResolved("trial docs", mesh.uiByLabel);
  const docs = [...byId.values()];
  for (const d of docs) d.piNames = d.pis.map((p) => p.name).join("; ");
  return docs;
}
