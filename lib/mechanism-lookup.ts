/**
 * NIH activity-code (mechanism) lookup. Used by:
 *   - <MechanismAbbr> tooltip rendering (issue #78 F4)
 *   - Funding-tab Mechanism (NIH) facet (issue #78 F3)
 *
 * Source: NIH Activity Code list — https://grants.nih.gov/grants/funding/ac_search_results.htm
 *
 * Codes not in this table fall through (returns null); UI renders the bare
 * code without a tooltip. Phase 2 covers research-grant, career, training,
 * fellowship, cooperative-agreement, program-project, and resource codes
 * that are common at WCM. Codes with broader scope (Y, X, etc.) are
 * intentionally omitted; add as they appear in the data.
 */

export interface Mechanism {
  /** NIH activity code, e.g. "R01". */
  code: string;
  full: string;
}

const MECHANISMS: Mechanism[] = [
  { code: "R01", full: "Research Project Grant (R01)" },
  { code: "R03", full: "Small Research Grant (R03)" },
  { code: "R13", full: "Conference Grant (R13)" },
  { code: "R15", full: "Academic Research Enhancement Award (R15)" },
  { code: "R21", full: "Exploratory / Developmental Research Grant (R21)" },
  { code: "R33", full: "Phase II of Exploratory / Developmental Research (R33)" },
  { code: "R34", full: "Planning Grant (R34)" },
  { code: "R35", full: "Outstanding Investigator Award (R35)" },
  { code: "R37", full: "Method to Extend Research in Time / MERIT (R37)" },
  { code: "R56", full: "High Priority, Short-Term Project Award (R56)" },
  { code: "R61", full: "Phase I of Exploratory / Developmental Cooperative (R61)" },

  { code: "K01", full: "Mentored Research Scientist Career Development Award (K01)" },
  { code: "K02", full: "Independent Scientist Award (K02)" },
  { code: "K07", full: "Academic / Research Career Development Award (K07)" },
  { code: "K08", full: "Mentored Clinical Scientist Research Career Development Award (K08)" },
  { code: "K12", full: "Mentored Clinical Scientist Development Program Award (K12)" },
  { code: "K22", full: "Career Transition Award (K22)" },
  { code: "K23", full: "Mentored Patient-Oriented Research Career Development Award (K23)" },
  { code: "K24", full: "Midcareer Investigator Award in Patient-Oriented Research (K24)" },
  { code: "K25", full: "Mentored Quantitative Research Career Development Award (K25)" },
  { code: "K43", full: "International Research Scientist Development Award (K43)" },
  { code: "K76", full: "Emerging Leaders Career Development Award (K76)" },
  { code: "K99", full: "Pathway to Independence Award (K99)" },

  { code: "F30", full: "Predoctoral MD/PhD Fellowship (F30)" },
  { code: "F31", full: "Predoctoral Fellowship (F31)" },
  { code: "F32", full: "Postdoctoral Fellowship (F32)" },
  { code: "F33", full: "Senior Postdoctoral Fellowship (F33)" },

  { code: "T15", full: "Continuing Education Training Grant (T15)" },
  { code: "T32", full: "Institutional National Research Service Award (T32)" },
  { code: "T34", full: "Undergraduate NRSA Institutional Research Training Grant (T34)" },
  { code: "T35", full: "Short-Term Institutional Research Training Grant (T35)" },
  { code: "T90", full: "Interdisciplinary Research Training Award (T90)" },

  { code: "U01", full: "Research Project Cooperative Agreement (U01)" },
  { code: "U10", full: "Cooperative Clinical Research (U10)" },
  { code: "U19", full: "Research Program Cooperative Agreement (U19)" },
  { code: "U24", full: "Resource-Related Research Project Cooperative Agreement (U24)" },
  { code: "U2C", full: "Resource-Related Research Multi-Component Cooperative Agreement (U2C)" },
  { code: "U54", full: "Specialized Center Cooperative Agreement (U54)" },
  { code: "UG1", full: "Clinical Research Cooperative Agreement (UG1)" },
  { code: "UG3", full: "Phase I Exploratory / Developmental Cooperative Agreement (UG3)" },
  { code: "UH3", full: "Phase II Exploratory / Developmental Cooperative Agreement (UH3)" },
  { code: "UM1", full: "Multi-Component Research Project Cooperative Agreement (UM1)" },
  { code: "R44", full: "Small Business Innovation Research Phase II (R44)" },
  { code: "R43", full: "Small Business Innovation Research Phase I (R43)" },
  { code: "R42", full: "Small Business Technology Transfer Phase II (R42)" },
  { code: "R41", full: "Small Business Technology Transfer Phase I (R41)" },

  { code: "P01", full: "Research Program Project (P01)" },
  { code: "P20", full: "Exploratory Grants (P20)" },
  { code: "P30", full: "Center Core Grant (P30)" },
  { code: "P50", full: "Specialized Center (P50)" },

  { code: "S10", full: "Biomedical Research Support Shared Instrumentation Grant (S10)" },

  { code: "D43", full: "International Research Training Grant (D43)" },
  { code: "D71", full: "International Research Training Planning Grant (D71)" },

  { code: "G08", full: "Resources Grant for Information Resources (G08)" },

  { code: "DP1", full: "NIH Director's Pioneer Award (DP1)" },
  { code: "DP2", full: "NIH Director's New Innovator Award (DP2)" },
  { code: "DP5", full: "NIH Director's Early Independence Award (DP5)" },
];

const BY_CODE: Map<string, Mechanism> = (() => {
  const m = new Map<string, Mechanism>();
  for (const x of MECHANISMS) m.set(x.code.toUpperCase(), x);
  return m;
})();

export function getMechanism(code: string | null | undefined): Mechanism | null {
  if (!code) return null;
  return BY_CODE.get(code.trim().toUpperCase()) ?? null;
}

export function expandMechanism(code: string | null | undefined): string | null {
  return getMechanism(code)?.full ?? null;
}

/** Verbose display form for sidebar / chip use: `{code} - {label}` with
 *  the trailing `(code)` suffix stripped (it would just repeat the code).
 *  e.g. "R01" → "R01 - Research Project Grant". Falls back to the bare
 *  code when the mechanism isn't in the lookup. */
export function mechanismVerbose(code: string | null | undefined): string {
  if (!code) return "";
  const m = getMechanism(code);
  if (!m) return code;
  const stripped = m.full.replace(/\s*\([^)]+\)\s*$/, "").trim();
  return `${m.code} - ${stripped}`;
}

export function listMechanisms(): readonly Mechanism[] {
  return MECHANISMS;
}
