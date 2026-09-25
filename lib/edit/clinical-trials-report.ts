/**
 * Report 5 — "Clinical Trials" (reports redesign, mockup `Clinical Trials
 * Redesign.dc.html`): the pure half. The page body, its client results and
 * the `.xlsx` route (`/api/edit/reports/clinical-trials`) all read the same
 * query string through {@link parseClinicalTrialsParams} and narrow the same
 * trial list through {@link filterTrials}, so the tabs, the headline numbers
 * and the download always agree.
 *
 * The rows come from `loadClinicalTrialsReport`
 * (`lib/center-collaboration/clinical-trials-report.ts`), one per
 * (member, trial) link; {@link groupTrials} folds them into one trial per
 * OnCore protocol number. Since #2769 every link is the trial's Principal
 * Investigator (OnCore lists the active PI only), so there is no role filter
 * and no "As investigator" count.
 *
 * Sponsor type is `ClinicalTrial.sponsorClass` (CT.gov LeadSponsorClass, else
 * a best-effort read of OnCore's sponsor name; `lib/clinical-trial-sponsor-class.ts`).
 * A null class is "Unknown", and is a filter value of its own.
 *
 * No `@/lib/db`, no Prisma value import: the client results component
 * imports this module.
 */
import type { ClinicalTrialsReportRow } from "@/lib/center-collaboration/clinical-trials-report";
import {
  isSponsorClass,
  SPONSOR_CLASS_OPTIONS,
  sponsorClassLabel,
  UNKNOWN_SPONSOR_LABEL,
  type SponsorClass,
} from "@/lib/clinical-trial-sponsor-class";

/** The sponsor-type filter's values: the seven classes, then Unknown (null). */
export type SponsorTypeKey = SponsorClass | "unknown";

export const SPONSOR_TYPE_OPTIONS: ReadonlyArray<{ value: SponsorTypeKey; label: string }> = [
  ...SPONSOR_CLASS_OPTIONS,
  { value: "unknown", label: UNKNOWN_SPONSOR_LABEL },
];

export function sponsorTypeKey(sponsorClass: string | null): SponsorTypeKey {
  return isSponsorClass(sponsorClass) ? sponsorClass : "unknown";
}

export function sponsorTypeLabel(key: SponsorTypeKey): string {
  return sponsorClassLabel(key);
}

/** The four OnCore statuses, plus a bucket for anything else (or none). */
export type TrialStatusKey = "open" | "closed" | "irb" | "suspended" | "other";

export const STATUS_OPTIONS: ReadonlyArray<{
  value: Exclude<TrialStatusKey, "other">;
  label: string;
}> = [
  { value: "open", label: "Open to accrual" },
  { value: "closed", label: "Closed to accrual" },
  { value: "irb", label: "Closed (IRB study closure)" },
  { value: "suspended", label: "Temporarily suspended" },
];

const STATUS_BY_ONCORE: Record<string, Exclude<TrialStatusKey, "other">> = {
  "OPEN TO ACCRUAL": "open",
  "CLOSED TO ACCRUAL": "closed",
  "IRB STUDY CLOSURE": "irb",
  SUSPENDED: "suspended",
};

export function trialStatusKey(status: string | null): TrialStatusKey {
  return STATUS_BY_ONCORE[(status ?? "").trim().toUpperCase()] ?? "other";
}

export function trialStatusLabel(status: string | null): string {
  const key = trialStatusKey(status);
  if (key === "other") return status?.trim() || "Status not reported";
  return STATUS_OPTIONS.find((o) => o.value === key)!.label;
}

/** Phase buckets. The mockup lists 1, 1/2, 2, 3, not applicable and not
 *  reported; CT.gov also carries early phase 1, 2/3 and 4, so those are
 *  options too rather than being folded into a neighbour. */
export const PHASE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "early1", label: "Early phase 1" },
  { value: "1", label: "Phase 1" },
  { value: "1/2", label: "Phase 1/2" },
  { value: "2", label: "Phase 2" },
  { value: "2/3", label: "Phase 2/3" },
  { value: "3", label: "Phase 3" },
  { value: "4", label: "Phase 4" },
  { value: "na", label: "Not applicable" },
  { value: "nr", label: "Not reported" },
];

/**
 * The phase bucket for a stored `ClinicalTrial.phase`: CT.gov enums joined by
 * the ETL (`PHASE1; PHASE2`, `EARLY_PHASE1`, `NA`) or an older enriched
 * string (`Phase 1/Phase 2`, `N/A`). Null (no NCT, or CT.gov gave none) is
 * "nr". An unusual combination (`PHASE1; PHASE3`) keys as its digits joined
 * ("1/3") and is labelled as such; no filter option matches it.
 */
export function phaseKey(phase: string | null): string {
  const s = (phase ?? "").toUpperCase();
  if (!s.trim()) return "nr";
  if (/EARLY[\s_-]*PHASE/.test(s)) return "early1";
  const digits = [...new Set([...s.matchAll(/[1-4]/g)].map((m) => m[0]))].sort();
  if (digits.length > 0) return digits.join("/");
  if (/\bN\/?A\b|NOT APPLICABLE/.test(s)) return "na";
  return "nr";
}

export function phaseLabel(key: string): string {
  return PHASE_OPTIONS.find((o) => o.value === key)?.label ?? `Phase ${key}`;
}

export type ClinicalTrialsView = "trials" | "members";

export type ClinicalTrialsParams = {
  view: ClinicalTrialsView;
  /** Title / NCT / sponsor / protocol number / member name, case-insensitive. */
  q: string;
  status: TrialStatusKey | "";
  phase: string;
  sponsorType: SponsorTypeKey | "";
};

export const CLINICAL_TRIALS_DEFAULTS: ClinicalTrialsParams = {
  view: "trials",
  q: "",
  status: "",
  phase: "",
  sponsorType: "",
};

/** One parser for the page and the download. Unknown values read as "any". */
export function parseClinicalTrialsParams(sp: URLSearchParams): ClinicalTrialsParams {
  const status = sp.get("status") ?? "";
  const phase = sp.get("phase") ?? "";
  const sponsorType = sp.get("sponsorType") ?? "";
  return {
    view: sp.get("view") === "members" ? "members" : "trials",
    q: (sp.get("q") ?? "").trim().slice(0, 200),
    status: STATUS_OPTIONS.some((o) => o.value === status) ? (status as TrialStatusKey) : "",
    phase: PHASE_OPTIONS.some((o) => o.value === phase) ? phase : "",
    sponsorType: SPONSOR_TYPE_OPTIONS.some((o) => o.value === sponsorType)
      ? (sponsorType as SponsorTypeKey)
      : "",
  };
}

/** The query string for `p`, defaults left out. `withView` false for the
 *  download, whose sheets don't depend on the tab. */
export function clinicalTrialsQueryString(p: ClinicalTrialsParams, withView = true): string {
  const sp = new URLSearchParams();
  if (withView && p.view !== "trials") sp.set("view", p.view);
  if (p.q) sp.set("q", p.q);
  if (p.status) sp.set("status", p.status);
  if (p.phase) sp.set("phase", p.phase);
  if (p.sponsorType) sp.set("sponsorType", p.sponsorType);
  return sp.toString();
}

export type TrialMember = { cwid: string; name: string; department: string | null; role: string };

/** One trial (one OnCore protocol number) with the members on it. */
export type TrialGroup = {
  protocolNumber: string;
  nctNumber: string | null;
  title: string;
  sponsor: string | null;
  sponsorType: SponsorTypeKey;
  phaseKey: string;
  status: string | null;
  statusKey: TrialStatusKey;
  members: TrialMember[];
};

const STATUS_ORDER: Record<TrialStatusKey, number> = {
  open: 0,
  suspended: 1,
  closed: 2,
  irb: 3,
  other: 4,
};

/** Fold the per-link rows into one trial per protocol number, open to
 *  accrual first, then by title. Members keep the loader's order. */
export function groupTrials(rows: ReadonlyArray<ClinicalTrialsReportRow>): TrialGroup[] {
  const byProtocol = new Map<string, TrialGroup>();
  for (const r of rows) {
    let t = byProtocol.get(r.protocolNumber);
    if (!t) {
      t = {
        protocolNumber: r.protocolNumber,
        nctNumber: r.nctNumber,
        title: r.title,
        sponsor: r.principalSponsor,
        sponsorType: sponsorTypeKey(r.sponsorClass),
        phaseKey: phaseKey(r.phase),
        status: r.status,
        statusKey: trialStatusKey(r.status),
        members: [],
      };
      byProtocol.set(r.protocolNumber, t);
    }
    if (!t.members.some((m) => m.cwid === r.cwid)) {
      t.members.push({ cwid: r.cwid, name: r.personName, department: r.department, role: r.role });
    }
  }
  return [...byProtocol.values()].sort(
    (a, b) =>
      STATUS_ORDER[a.statusKey] - STATUS_ORDER[b.statusKey] ||
      a.title.localeCompare(b.title) ||
      a.protocolNumber.localeCompare(b.protocolNumber),
  );
}

/** The trials the filters keep (the view is not a filter). */
export function filterTrials(
  trials: ReadonlyArray<TrialGroup>,
  p: ClinicalTrialsParams,
): TrialGroup[] {
  const q = p.q.trim().toLowerCase();
  return trials.filter(
    (t) =>
      (!p.status || t.statusKey === p.status) &&
      (!p.phase || t.phaseKey === p.phase) &&
      (!p.sponsorType || t.sponsorType === p.sponsorType) &&
      (!q ||
        [t.title, t.nctNumber, t.sponsor, t.protocolNumber, ...t.members.map((m) => m.name)]
          .join(" ")
          .toLowerCase()
          .includes(q)),
  );
}

const PI = "principal investigator";

/** One member on the By member tab (and the Investigators sheet). */
export type MemberSummary = {
  cwid: string;
  name: string;
  department: string | null;
  /** Trials this member is Principal Investigator on. */
  asPi: number;
  /** Their trials that are open to accrual. */
  open: number;
  trials: TrialGroup[];
};

/** Roll the (filtered) trials up per member: most trials as PI first. */
export function summarizeMembers(trials: ReadonlyArray<TrialGroup>): MemberSummary[] {
  const byCwid = new Map<string, MemberSummary>();
  for (const t of trials) {
    for (const m of t.members) {
      let g = byCwid.get(m.cwid);
      if (!g) {
        g = { cwid: m.cwid, name: m.name, department: m.department, asPi: 0, open: 0, trials: [] };
        byCwid.set(m.cwid, g);
      }
      if (m.role.toLowerCase() === PI) g.asPi++;
      if (t.statusKey === "open") g.open++;
      g.trials.push(t);
    }
  }
  return [...byCwid.values()].sort((a, b) => b.asPi - a.asPi || a.name.localeCompare(b.name));
}

export type ClinicalTrialsTotals = {
  trials: number;
  members: number;
  links: number;
  open: number;
  registered: number;
};

export function clinicalTrialsTotals(trials: ReadonlyArray<TrialGroup>): ClinicalTrialsTotals {
  const members = new Set<string>();
  let links = 0;
  for (const t of trials) {
    links += t.members.length;
    for (const m of t.members) members.add(m.cwid);
  }
  return {
    trials: trials.length,
    members: members.size,
    links,
    open: trials.filter((t) => t.statusKey === "open").length,
    registered: trials.filter((t) => t.nctNumber !== null).length,
  };
}

/** The download button's note: which sheets this filter set gets. The
 *  Investigators sheet is a scholar list, so it is left out (never
 *  truncated) above `cap` members. */
export function clinicalTrialsDownloadNote(
  members: number,
  cap: number,
): { text: string; withheld: boolean } {
  if (members > cap) {
    return {
      text: `Includes the Trials and Criteria sheets. The Investigators sheet is left out above ${cap} people (${members.toLocaleString()} match); narrow the filters to include it.`,
      withheld: true,
    };
  }
  return { text: "Trials, Investigators and Criteria sheets, current filters.", withheld: false };
}

/** The Criteria sheet's rows: every filter, "All" when unset. */
export function describeClinicalTrialsCriteria(
  p: ClinicalTrialsParams,
  centerName: string,
  generatedAt: Date,
): Array<[string, string]> {
  return [
    ["Report", "Clinical Trials (report 5)"],
    ["Center", centerName],
    ["Generated", generatedAt.toISOString()],
    ["Search", p.q || "All"],
    ["Status", STATUS_OPTIONS.find((o) => o.value === p.status)?.label ?? "All"],
    ["Phase", p.phase ? phaseLabel(p.phase) : "All"],
    ["Sponsor type", p.sponsorType ? sponsorTypeLabel(p.sponsorType) : "All"],
    [
      "Scope",
      "Trials from the WCM clinical trials management system (OnCore) whose Principal Investigator is a current center member, matched by CWID. Suspended trials are included.",
    ],
    [
      "Sponsor type source",
      "Registered trials (with an NCT) use the ClinicalTrials.gov lead sponsor class: Industry; NIH; Other federal (FED); Cooperative group (NETWORK); WCM (investigator-initiated) when the class is OTHER and the lead sponsor is Weill Cornell; Other academic (the rest of OTHER, which also covers hospitals and foundations); Other (non-US, state or local government, or an individual). If ClinicalTrials.gov could not be read that week, the trial keeps its last class. Trials with no NCT use a best-effort reading of the OnCore principal sponsor name: NIH institutes; federal agencies; cooperative groups (including the Canadian Cancer Trials Group); Weill Cornell; foundations, societies and charities (as Other academic, like ClinicalTrials.gov); companies; universities and hospitals. Unknown when the source does not say.",
    ],
  ];
}
