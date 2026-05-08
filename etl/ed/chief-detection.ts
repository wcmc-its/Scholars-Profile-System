/**
 * Path B chief-detection logic — shared between the production ETL
 * (etl/ed/index.ts) and the read-only probe (etl/ed/probe-divisions.ts).
 *
 * The two were drifting apart while developing the verdict-threshold rule;
 * extracting here keeps "what the ETL will write" identical to "what the
 * probe predicts."
 */
import type { EdFacultyAppointment } from "@/lib/sources/ldap";

export type ChiefVerdict = "HIGH" | "MEDIUM" | "LOW" | "NONE" | "GAP";

export type ChiefCandidate = {
  cwid: string;
  reportees: number;
  primaryCount: number;
  apptCount: number;
  earliest: number;
};

export type ChiefDetectionResult = {
  /** Top-ranked candidate, regardless of verdict. Useful for diagnostics. */
  topPick: string | null;
  verdict: ChiefVerdict;
  candidates: ChiefCandidate[];
  /** What the ETL should write to Division.chiefCwid. Null for any verdict
   *  weaker than MEDIUM — the override file (Path C) is the escape hatch.
   *  HIGH and MEDIUM are auto-written; LOW/NONE/GAP all clear to null. */
  valueToWrite: string | null;
};

/** Standalone-phrase match for "Chair of {dept name}". Catches direct,
 *  prefix, suffix, endowed ("Sanford I. Weill Chair of Medicine"), and
 *  acting ("Acting Chair of Cell and Developmental Biology") forms.
 *  Excludes vice/associate/deputy/assistant chairs. */
export function isChairTitleFor(title: string, deptName: string): boolean {
  if (/Vice[- ]Chair|Associate Chair|Deputy Chair|Assistant Chair/i.test(title)) {
    return false;
  }
  const target = `Chair of ${deptName}`;
  if (title === target) return true;
  if (title.startsWith(`${target} `) || title.startsWith(`${target},`)) return true;
  if (title.endsWith(` ${target}`)) return true;
  if (title.includes(` ${target} `) || title.includes(` ${target},`)) return true;
  return false;
}

export function detectDivisionChief(opts: {
  divCode: string;
  /** CWIDs of all faculty with an active appointment in this division. */
  members: string[];
  /** Parent department's chair CWID. Null when chair detection failed. */
  parentChairCwid: string | null;
  /** CWID → manager CWID, from collapsed employee SOR records. */
  managerByCwid: Map<string, string | null>;
  /** CWID → all active faculty appointments. */
  appointmentsByCwid: Map<string, EdFacultyAppointment[]>;
}): ChiefDetectionResult {
  const {
    divCode,
    members,
    parentChairCwid,
    managerByCwid,
    appointmentsByCwid,
  } = opts;

  if (!parentChairCwid || members.length === 0) {
    return { topPick: null, verdict: "GAP", candidates: [], valueToWrite: null };
  }

  const candidateCwids = members.filter(
    (m) => m !== parentChairCwid && managerByCwid.get(m) === parentChairCwid,
  );
  if (candidateCwids.length === 0) {
    return { topPick: null, verdict: "NONE", candidates: [], valueToWrite: null };
  }

  const ranked: ChiefCandidate[] = candidateCwids.map((c) => {
    const reportees = members.filter(
      (m) => m !== c && managerByCwid.get(m) === c,
    ).length;
    const appts = appointmentsByCwid.get(c) ?? [];
    const inDiv = appts.filter((a) => a.divCode === divCode);
    const primaryCount = inDiv.filter((a) => a.isPrimary).length;
    const dates = inDiv
      .map((a) => a.startDate?.getTime())
      .filter((t): t is number => typeof t === "number");
    const earliest = dates.length > 0 ? Math.min(...dates) : Infinity;
    return { cwid: c, reportees, primaryCount, apptCount: inDiv.length, earliest };
  });
  ranked.sort((a, b) => {
    if (b.reportees !== a.reportees) return b.reportees - a.reportees;
    if (b.primaryCount !== a.primaryCount) return b.primaryCount - a.primaryCount;
    return a.earliest - b.earliest;
  });

  const top = ranked[0];
  let verdict: ChiefVerdict;
  if (ranked.length === 1) {
    if (top.primaryCount >= 1 && top.reportees >= 1) verdict = "HIGH";
    else if (top.primaryCount >= 1 || top.reportees >= 1) verdict = "MEDIUM";
    else verdict = "LOW";
  } else {
    const second = ranked[1];
    const dominantReportees = top.reportees - second.reportees >= 2;
    const dominantPrimary = top.primaryCount > second.primaryCount;
    if ((dominantReportees || dominantPrimary) && top.primaryCount >= 1) {
      verdict = "HIGH";
    } else if (dominantReportees || dominantPrimary || top.reportees >= 2) {
      verdict = "MEDIUM";
    } else {
      verdict = "LOW";
    }
  }

  const valueToWrite = verdict === "HIGH" || verdict === "MEDIUM" ? top.cwid : null;
  return { topPick: top.cwid, verdict, candidates: ranked, valueToWrite };
}
