/**
 * NIH activity-code IC prefix → IC short-name map.
 *
 * The 2-letter prefix on an NIH serial number (e.g. "CA" in "R01 CA245678")
 * identifies the funding Institute or Center. Source of truth for both
 * `lib/grant-meta.ts` (display eyebrow) and `lib/award-number.ts` (ETL
 * mechanism/IC parsing for issue #78).
 */
export const NIH_INSTITUTE_BY_PREFIX: Record<string, string> = {
  AA: "NIAAA",
  AG: "NIA",
  AI: "NIAID",
  AR: "NIAMS",
  AT: "NCCIH",
  CA: "NCI",
  DA: "NIDA",
  DC: "NIDCD",
  DE: "NIDCR",
  DK: "NIDDK",
  EB: "NIBIB",
  ES: "NIEHS",
  EY: "NEI",
  GM: "NIGMS",
  HD: "NICHD",
  HG: "NHGRI",
  HL: "NHLBI",
  LM: "NLM",
  MD: "NIMHD",
  MH: "NIMH",
  NR: "NINR",
  NS: "NINDS",
  OD: "OD",
  RR: "NCRR",
  TR: "NCATS",
  TW: "FIC",
};
