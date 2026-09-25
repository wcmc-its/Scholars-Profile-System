/**
 * Clinical-trial sponsor type (`ClinicalTrial.sponsorClass`): one of seven
 * buckets, stored as the short key and shown by its label. Null means unknown.
 *
 * Which source (the clinical-trials ETL, `etl/clinical-trials/shared.ts`):
 *
 * 1. A registered (NCT) trial: ClinicalTrials.gov `LeadSponsorClass`, with
 *    `LeadSponsorName` only to pick WCM's own trials out of OTHER:
 *      INDUSTRY  → industry          NIH       → nih
 *      FED       → federal           NETWORK   → network
 *      OTHER, lead sponsor is Weill Cornell → wcm
 *      OTHER     → academic (CT.gov's catch-all for universities, hospitals
 *                  and foundations; at a cancer center that is mostly academic)
 *      OTHER_GOV → other (state, local or non-US government)
 *      INDIV     → other (an individual)
 *      AMBIG, UNKNOWN, missing → null (Unknown).
 *    When the week's CT.gov fetch failed for the trial (or on the S3 bridge
 *    import, which never calls CT.gov) the ETL keeps the class the trial
 *    already had, so a registered trial's type does not flip with the fetch.
 *
 * 2. A trial with no NCT: best effort from OnCore's `principalSponsor` name.
 *    Keyword rules, first match wins:
 *      NCI of Canada / NCIC / Canadian Cancer Trials Group → network
 *      NIH, NCI or another NIH institute        → nih
 *      another US federal agency (DoD, VA, ...) → federal
 *      a cooperative group or network           → network
 *      Weill Cornell (Weill, WCM, WCMC)         → wcm
 *      a foundation, society, association, fund,
 *        trust or charity                       → academic (as CT.gov OTHER
 *        files them; checked BEFORE the company rule so "American Cancer
 *        Society, Inc." is not a company)
 *      a company (Inc, LLC, Pharma(ceuticals), ...) → industry
 *      a university, college, hospital, medical
 *        center or institute                    → academic
 *      anything else, or no name                → null (shown as Unknown)
 *
 * Pure: no DB, safe in the client bundle (report 5's results import it).
 */

export type SponsorClass =
  | "industry"
  | "nih"
  | "federal"
  | "wcm"
  | "academic"
  | "network"
  | "other";

/** Every class, in the order the filter lists them. "network" is labelled
 *  "Cooperative group", the mockup's name for it (NRG, Alliance, SWOG...). */
export const SPONSOR_CLASS_OPTIONS: ReadonlyArray<{ value: SponsorClass; label: string }> = [
  { value: "industry", label: "Industry" },
  { value: "network", label: "Cooperative group" },
  { value: "nih", label: "NIH" },
  { value: "federal", label: "Other federal" },
  { value: "wcm", label: "WCM (investigator-initiated)" },
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

/** Weill Cornell as a sponsor name ("Weill Medical College of Cornell
 *  University", "Weill Cornell Medicine", "WCMC"). Plain "Cornell University"
 *  (Ithaca) is not WCM. */
const WCM_NAME = /\bweill\b|\bWCMC?\b|cornell medic/i;

/** ClinicalTrials.gov v2 `leadSponsor.class` (+ `.name`, to find WCM in
 *  OTHER) → class; AMBIG / UNKNOWN / none → null. */
export function sponsorClassFromCtgov(
  cls: string | null | undefined,
  leadSponsorName?: string | null,
): SponsorClass | null {
  const c = CTGOV_CLASS[(cls ?? "").trim().toUpperCase()] ?? null;
  return c === "academic" && WCM_NAME.test(leadSponsorName ?? "") ? "wcm" : c;
}

const ONCORE_RULES: ReadonlyArray<[RegExp, SponsorClass]> = [
  [/national cancer institute of canada|\bNCIC\b|canadian cancer trials/i, "network"],
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
  [WCM_NAME, "wcm"],
  [/foundation|society|association|\bfund\b|\btrust\b|charit/i, "academic"],
  [
    /\b(inc|llc|ltd|corp|corporation|gmbh|plc)\b|\bpharma\b|pharmaceutical|therapeutics|bioscience|biotech|biologics|diagnostics|medical devices?|genentech|novartis|pfizer|merck|astrazeneca|bristol|lilly|janssen|amgen|roche|sanofi|bayer|abbvie|gilead|regeneron|seagen|takeda|daiichi|eisai|incyte|beigene|genmab|boehringer|glaxo|\bGSK\b/i,
    "industry",
  ],
  [
    /universit|college|hospital|medical cent(er|re)|health system|cancer cent(er|re)|cornell|memorial sloan|\bMSKCC\b|dana[- ]farber|md anderson|mayo clinic|institute|school of medicine/i,
    "academic",
  ],
];

/** Best-effort class from OnCore's free-text principal sponsor name, or null. */
export function sponsorClassFromOncore(name: string | null | undefined): SponsorClass | null {
  const s = (name ?? "").trim();
  if (!s) return null;
  for (const [re, cls] of ONCORE_RULES) if (re.test(s)) return cls;
  return null;
}
