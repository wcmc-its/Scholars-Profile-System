/**
 * NCI CCSG Data Table 2A — "Peer-Reviewed" column (DT2A rule #4, CCSG Data
 * Guide p.7): "Only grant and contracts from NCI, NIH, or organizations
 * listed in [PeerReviewFundingOrganizations.pdf] are considered peer-
 * reviewed. All others funding sources should be listed as non-peer
 * reviewed." Fully deterministic — NO Bedrock call, no `source` tracking, no
 * "AI-suggested" badge (same posture `CenterMembership`-sourced program
 * codes already get): this is a lookup, not a judgment.
 *
 * NIH/NCI-ness comes from `nihAward` (OSRA's own "NIH Award" Y/N column,
 * threaded through by `build-2a-skeleton.py`), NOT a string match against
 * `specificFundingSource` — for an NIH award, OSRA's Sponsor field holds the
 * SPECIFIC institute name (e.g. "National Institute of Allergy & Infectious
 * Diseases"), never the literal string "NIH", so a name match alone would
 * silently miss every non-NCI institute.
 *
 * The other 29 orgs are the closed allowlist from
 * `PeerReviewFundingOrganizations.pdf` (updated Aug 3, 2023), matched by a
 * keyword against `specificFundingSource`. That field draws from OSRA's own
 * fixed sponsor picklist (confirmed empirically against the real workbook:
 * a few hundred distinct strings repeat verbatim across 2,039 rows), so a
 * keyword match here is a lookup against a controlled vocabulary, not
 * fragile free-text matching.
 *
 * ponytail: 3 orgs on the list carry a caveat `specificFundingSource` alone
 * can't resolve — ACS "national office only" (vs. a state division), VA
 * "excluding local/regional and block grants", DOD limited to ovarian/
 * breast/prostate special research programs. This classifier does NOT match
 * them, defaulting to the conservative "non-peer-reviewed" read rather than
 * guessing yes on a figure OCC administratively reviews. Upgrade path: a
 * per-award human override column, if these turn out to be common in
 * Meyer's actual awards (measure via `specificFundingSource` before
 * building it — see the handoff doc).
 */

const PEER_REVIEWED_ORG_KEYWORDS = [
  "agency for healthcare research", // AHRQ
  "alex's lemonade stand",
  "alex’s lemonade stand", // ALSF (curly apostrophe variant)
  "american association for cancer research",
  "american association of cancer research", // AACR
  "american foundation for aids research",
  "amfar", // amfAR
  "american institute for cancer research", // AICR
  "california institute for regenerative medicine", // CIRM
  "cancer prevention research institute of texas", // CPRIT
  "centers for disease control",
  "center for disease control", // CDC
  "environmental protection agency", // EPA
  "flight attendant medical research institute", // FAMRI
  "florida biomedical research program", // FBRP
  "food and drug administration", // FDA
  "howard hughes medical institute", // HHMI
  "leukemia & lymphoma society",
  "leukemia and lymphoma society", // LLS
  "melanoma research alliance", // MRA
  "multiple myeloma research foundation", // MMRF
  "national institute for occupational safety", // NIOSH
  "national science foundation", // NSF
  "wadsworth center",
  "nystem", // NYSTEM
  "patient-centered outcomes research institute", // PCORI
  "prevent cancer foundation", // PCF (Prevent)
  "prostate cancer foundation", // PCF (Prostate)
  "st. baldrick's",
  "st baldrick's",
  "st. baldrick’s",
  "st baldrick’s", // St. Baldrick's Foundation (straight + curly apostrophe)
  "stand up to cancer", // SU2C
  "susan g. komen", // Komen
  "california breast cancer research program", // CBCRP
  "california tobacco related disease research program",
  "california tobacco-related disease research program", // TRDRP (space + hyphen)
] as const;

/** DT2A rule #4 — see the module doc for the NIH-flag-vs-name-match reasoning
 *  and the 3 caveated orgs this deliberately does NOT match. */
export function isPeerReviewedFundingSource(specificFundingSource: string, nihAward: boolean): boolean {
  if (nihAward) return true;
  const s = specificFundingSource.toLowerCase();
  return PEER_REVIEWED_ORG_KEYWORDS.some((kw) => s.includes(kw));
}
