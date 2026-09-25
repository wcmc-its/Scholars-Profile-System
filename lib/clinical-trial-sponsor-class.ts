/**
 * Clinical-trial sponsor type (`ClinicalTrial.sponsorClass`): one of six
 * buckets, stored as the short key and shown by its label. Null means unknown.
 *
 * Two sources, in this order (the clinical-trials ETL, `etl/clinical-trials/shared.ts`):
 *
 * 1. ClinicalTrials.gov `LeadSponsorClass`, for a registered (NCT) trial:
 *      INDUSTRY  → industry          NIH       → nih
 *      FED       → federal           NETWORK   → network
 *      OTHER     → academic (CT.gov's catch-all for universities, hospitals
 *                  and foundations; at a cancer center that is mostly academic)
 *      OTHER_GOV → other (state, local or non-US government)
 *      INDIV     → other (an individual)
 *      AMBIG, UNKNOWN, missing → no class from CT.gov; fall through to 2.
 *
 * 2. Best effort from OnCore's `principalSponsor` name, for a trial with no
 *    NCT, or when CT.gov gave no class (a failed fetch, or the S3 bridge
 *    import, which does not call CT.gov). Keyword rules, first match wins:
 *      NIH, NCI or another NIH institute        → nih
 *      another US federal agency (DoD, VA, ...) → federal
 *      a cooperative group or network           → network
 *      a company (Inc, LLC, Pharma, ...)         → industry
 *      a university, college, hospital, medical
 *        center or Weill Cornell                 → academic
 *      a foundation, society or association     → other
 *      anything else, or no name                → null (shown as Unknown)
 *
 * Pure: no DB, safe in the client bundle (report 5's results import it).
 */

export type SponsorClass = "industry" | "nih" | "federal" | "academic" | "network" | "other";

/** Every class, in the order the filter lists them. "network" is labelled
 *  "Cooperative group", the mockup's name for it (NRG, Alliance, SWOG...). */
export const SPONSOR_CLASS_OPTIONS: ReadonlyArray<{ value: SponsorClass; label: string }> = [
  { value: "industry", label: "Industry" },
  { value: "network", label: "Cooperative group" },
  { value: "nih", label: "NIH" },
  { value: "federal", label: "Other federal" },
  { value: "academic", label: "Other academic" },
  { value: "other", label: "Other" },
];

export const UNKNOWN_SPONSOR_LABEL = "Unknown";

export function isSponsorClass(v: unknown): v is SponsorClass {
  return SPONSOR_CLASS_OPTIONS.some((o) => o.value === v);
}

/** The label for a stored value; null or anything unrecognised is "Unknown". */
export function sponsorClassLabel(v: string | null | undefined): string {
  return SPONSOR_CLASS_OPTIONS.find((o) => o.value === v)?.label ?? UNKNOWN_SPONSOR_LABEL;
}

const CTGOV_CLASS: Record<string, SponsorClass> = {
  INDUSTRY: "industry",
  NIH: "nih",
  FED: "federal",
  NETWORK: "network",
  OTHER: "academic",
  OTHER_GOV: "other",
  INDIV: "other",
};

/** ClinicalTrials.gov v2 `leadSponsor.class` → class; AMBIG / UNKNOWN / none → null. */
export function sponsorClassFromCtgov(cls: string | null | undefined): SponsorClass | null {
  return CTGOV_CLASS[(cls ?? "").trim().toUpperCase()] ?? null;
}

const ONCORE_RULES: ReadonlyArray<[RegExp, SponsorClass]> = [
  [
    /\b(NIH|NCI|NHLBI|NIAID|NIDDK|NIMH|NIA|NICHD|NINDS|NIDA|NIAAA|NHGRI|NIEHS|NCATS|NIBIB|NINR|NIAMS|NIDCR|NEI)\b|national cancer institute|national institutes? (of|on)/i,
    "nih",
  ],
  [
    /department of (defense|veterans|health and human)|\b(DOD|CDMRP|VA|FDA|CDC|AHRQ|HRSA|DARPA|BARDA|NSF)\b|veterans affairs|food and drug administration|centers for disease control|national science foundation/i,
    "federal",
  ],
  [
    /cooperative|oncology group|\b(NRG|SWOG|ECOG|ACRIN|NSABP|RTOG|GOG|CALGB|ACOSOG|COG|NCTN|ETCTN)\b|\balliance for clinical|children'?s oncology|consortium|\bnetwork\b|(study|trials) group/i,
    "network",
  ],
  [
    /\b(inc|llc|ltd|corp|corporation|gmbh|plc)\b|pharma|therapeutics|bioscience|biotech|biologics|diagnostics|medical devices?|genentech|novartis|pfizer|merck|astrazeneca|bristol|lilly|janssen|amgen|roche|sanofi|bayer|abbvie|gilead|regeneron|seagen|takeda|daiichi|eisai|incyte|beigene|genmab|boehringer|glaxo|\bGSK\b/i,
    "industry",
  ],
  [
    /universit|college|hospital|medical cent(er|re)|health system|cancer cent(er|re)|weill|cornell|\b(WCM|WCMC|MSKCC)\b|memorial sloan|dana[- ]farber|md anderson|mayo clinic|institute|school of medicine/i,
    "academic",
  ],
  [/foundation|society|association|\bfund\b|\btrust\b/i, "other"],
];

/** Best-effort class from OnCore's free-text principal sponsor name, or null. */
export function sponsorClassFromOncore(name: string | null | undefined): SponsorClass | null {
  const s = (name ?? "").trim();
  if (!s) return null;
  for (const [re, cls] of ONCORE_RULES) if (re.test(s)) return cls;
  return null;
}
