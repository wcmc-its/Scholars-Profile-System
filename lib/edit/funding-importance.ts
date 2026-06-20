/**
 * A pure importance score for an active funding award (#742 overview facts).
 *
 * Active funding is sorted by this score (descending) in `loadActiveFunding`, so
 * the most important awards win the selection cap and lead the candidate list.
 * The score is a TYPE base (what kind of award it is) plus a ROLE bonus (how
 * central the scholar is to it). Higher = more important.
 *
 * There is deliberately NO dollar amount in the schema, so "importance" is a
 * proxy from award kind + role: NIH research grants outrank NIH center/training
 * awards, all of which outrank a non-NIH industry contract / equipment buy.
 *
 * `mechanism != null` already means NIH-funded (NIH activity code, NIH-only). The
 * `awardNumber` activity-code parse is only a last-resort fallback for the rare
 * NIH row whose `mechanism` failed to populate. Pure — tolerates null/undefined.
 */

export type FundingImportanceInput = {
  role: string;
  funder: string;
  title: string;
  programType: string;
  mechanism: string | null;
  nihIc: string | null;
  awardNumber: string | null;
  isSubaward: boolean;
};

/** A leading NIH activity code in an award number — e.g. "5R01CA123456-03" → "R01". */
const NIH_AWARD_CODE = /^\d*([A-Z]\d{2})/;
/** NIH major research mechanisms (the highest-value research awards). */
const NIH_MAJOR = /^(R01|R37|R35|RM1|DP[12]|U01|UM1|P01)/i;
/** NIH center / large multi-project mechanisms. */
const NIH_CENTER = /^(P30|P50|P20|P2C|U54|UG3|UH3)/i;
/** NIH training / career mechanisms. */
const NIH_TRAINING = /^(K|T|F|R25|R90|TL|FL)/i;
/** Industry / company funder names (matched on the funder display string). */
const COMPANY_FUNDER =
  /\b(inc|llc|ltd|corp|co|therapeutics|biosciences|biotech|bio|pharma|pharmaceutical|sciences|laboratories)\b/i;
/** Contract / agreement language in the title (an industry service deal). */
const CONTRACT_TITLE =
  /\b(MSA|master service agreement|clinical trial agreement|service agreement|agreement|contract)\b/i;

/** Resolve the NIH activity code: the explicit `mechanism`, else parsed from the
 *  award number as a fallback. Returns null when the award is not NIH-identifiable. */
function nihMechanism(g: FundingImportanceInput): string | null {
  if (g.mechanism) return g.mechanism;
  const num = g.awardNumber ?? "";
  const match = NIH_AWARD_CODE.exec(num);
  return match ? match[1] : null;
}

/** The TYPE base — what kind of award this is (see the doc comment's ordering). */
function typeBase(g: FundingImportanceInput): number {
  // 1. NIH (mechanism present, or an activity code parsed from the award number).
  const mech = nihMechanism(g);
  if (mech) {
    if (NIH_MAJOR.test(mech)) return 600;
    if (NIH_CENTER.test(mech)) return 500;
    if (NIH_TRAINING.test(mech)) return 350;
    return 450; // any other NIH mechanism (R21, R03, R34, R56, …)
  }

  // 2. Non-NIH industry / contract — the lowest research-relevant tier.
  const programType = g.programType ?? "";
  const funder = g.funder ?? "";
  const title = g.title ?? "";
  if (
    programType === "BioPharma Alliance Agreement" ||
    programType === "Contract with funding" ||
    COMPANY_FUNDER.test(funder) ||
    CONTRACT_TITLE.test(title)
  ) {
    return 100;
  }

  // 3. Equipment purchases.
  if (programType === "Equipment") return 50;

  // 4. Otherwise — a foundation / other-federal grant, fellowship, or career award
  //    from a non-company funder.
  return 300;
}

/** The ROLE bonus — how central the scholar is to the award. */
function roleBonus(role: string): number {
  const r = (role ?? "").trim().toLowerCase();
  if (r === "pi") return 50;
  if (r === "pi-subaward") return 35;
  if (r === "co-pi") return 30;
  if (r === "co-i") return 15;
  return 5; // Key Personnel / unknown
}

/** Importance score for one active funding award. Higher = more important. */
export function scoreFundingImportance(g: FundingImportanceInput): number {
  if (!g) return 0;
  return typeBase(g) + roleBonus(g.role);
}
