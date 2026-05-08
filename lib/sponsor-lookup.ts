/**
 * Canonical sponsor lookup. Used by:
 *   - <SponsorAbbr> tooltip rendering (issue #78 F4)
 *   - Funding-tab Funder facet (issue #78 F3, F5)
 *   - Profile Funding section eyebrow line (issue #78 Wave C)
 *
 * Single source of truth for short-name ↔ full-name ↔ category mappings.
 * Sponsors not in this table fall through: callers render the raw name as
 * both short and full with no tooltip (per spec F5).
 *
 * Seed contents:
 *   - NIH ICs (~27)
 *   - Other federal agencies
 *   - Curated foundations (top by WCM volume; refine with OSR input)
 *   - Curated industry sponsors (top by WCM volume)
 */

export type SponsorCategory = "NIH IC" | "Federal" | "Foundation" | "Industry" | "Other";

export interface Sponsor {
  /** Canonical short name (uppercase preserved as in conventional usage). */
  short: string;
  full: string;
  category: SponsorCategory;
  url?: string;
  /** Lowercase alternate names that should resolve to this canonical record. */
  aliases?: string[];
}

const NIH_ICS: Sponsor[] = [
  { short: "NCI", full: "National Cancer Institute", category: "NIH IC", url: "https://www.cancer.gov/" },
  { short: "NHLBI", full: "National Heart, Lung, and Blood Institute", category: "NIH IC", url: "https://www.nhlbi.nih.gov/" },
  { short: "NIA", full: "National Institute on Aging", category: "NIH IC", url: "https://www.nia.nih.gov/" },
  { short: "NIAAA", full: "National Institute on Alcohol Abuse and Alcoholism", category: "NIH IC", url: "https://www.niaaa.nih.gov/" },
  { short: "NIAID", full: "National Institute of Allergy and Infectious Diseases", category: "NIH IC", url: "https://www.niaid.nih.gov/" },
  { short: "NIAMS", full: "National Institute of Arthritis and Musculoskeletal and Skin Diseases", category: "NIH IC", url: "https://www.niams.nih.gov/" },
  { short: "NIBIB", full: "National Institute of Biomedical Imaging and Bioengineering", category: "NIH IC", url: "https://www.nibib.nih.gov/" },
  { short: "NICHD", full: "Eunice Kennedy Shriver National Institute of Child Health and Human Development", category: "NIH IC", url: "https://www.nichd.nih.gov/" },
  { short: "NIDA", full: "National Institute on Drug Abuse", category: "NIH IC", url: "https://nida.nih.gov/" },
  { short: "NIDCD", full: "National Institute on Deafness and Other Communication Disorders", category: "NIH IC", url: "https://www.nidcd.nih.gov/" },
  { short: "NIDCR", full: "National Institute of Dental and Craniofacial Research", category: "NIH IC", url: "https://www.nidcr.nih.gov/" },
  { short: "NIDDK", full: "National Institute of Diabetes and Digestive and Kidney Diseases", category: "NIH IC", url: "https://www.niddk.nih.gov/" },
  { short: "NIEHS", full: "National Institute of Environmental Health Sciences", category: "NIH IC", url: "https://www.niehs.nih.gov/" },
  { short: "NEI", full: "National Eye Institute", category: "NIH IC", url: "https://www.nei.nih.gov/" },
  { short: "NIGMS", full: "National Institute of General Medical Sciences", category: "NIH IC", url: "https://www.nigms.nih.gov/" },
  { short: "NHGRI", full: "National Human Genome Research Institute", category: "NIH IC", url: "https://www.genome.gov/" },
  { short: "NIMH", full: "National Institute of Mental Health", category: "NIH IC", url: "https://www.nimh.nih.gov/" },
  { short: "NIMHD", full: "National Institute on Minority Health and Health Disparities", category: "NIH IC", url: "https://www.nimhd.nih.gov/" },
  { short: "NINDS", full: "National Institute of Neurological Disorders and Stroke", category: "NIH IC", url: "https://www.ninds.nih.gov/" },
  { short: "NINR", full: "National Institute of Nursing Research", category: "NIH IC", url: "https://www.ninr.nih.gov/" },
  { short: "NLM", full: "National Library of Medicine", category: "NIH IC", url: "https://www.nlm.nih.gov/" },
  { short: "NCATS", full: "National Center for Advancing Translational Sciences", category: "NIH IC", url: "https://ncats.nih.gov/" },
  { short: "NCCIH", full: "National Center for Complementary and Integrative Health", category: "NIH IC", url: "https://www.nccih.nih.gov/" },
  { short: "FIC", full: "Fogarty International Center", category: "NIH IC", url: "https://www.fic.nih.gov/" },
  { short: "OD", full: "Office of the Director, NIH", category: "NIH IC", url: "https://www.nih.gov/institutes-nih/office-director" },
  { short: "NCRR", full: "National Center for Research Resources", category: "NIH IC" },
  { short: "CIT", full: "Center for Information Technology", category: "NIH IC", url: "https://www.cit.nih.gov/" },
];

const FEDERAL: Sponsor[] = [
  { short: "NIH", full: "National Institutes of Health", category: "Federal", url: "https://www.nih.gov/" },
  { short: "NSF", full: "National Science Foundation", category: "Federal", url: "https://www.nsf.gov/" },
  { short: "DOD", full: "U.S. Department of Defense", category: "Federal", url: "https://www.defense.gov/", aliases: ["dept of defense", "department of defense"] },
  { short: "CDMRP", full: "Congressionally Directed Medical Research Programs", category: "Federal", url: "https://cdmrp.health.mil/" },
  { short: "DOE", full: "U.S. Department of Energy", category: "Federal", url: "https://www.energy.gov/" },
  { short: "EPA", full: "U.S. Environmental Protection Agency", category: "Federal", url: "https://www.epa.gov/" },
  { short: "USDA", full: "U.S. Department of Agriculture", category: "Federal", url: "https://www.usda.gov/" },
  { short: "VA", full: "U.S. Department of Veterans Affairs", category: "Federal", url: "https://www.va.gov/" },
  { short: "AHRQ", full: "Agency for Healthcare Research and Quality", category: "Federal", url: "https://www.ahrq.gov/" },
  { short: "CDC", full: "Centers for Disease Control and Prevention", category: "Federal", url: "https://www.cdc.gov/" },
  { short: "NASA", full: "National Aeronautics and Space Administration", category: "Federal", url: "https://www.nasa.gov/" },
  { short: "FDA", full: "U.S. Food and Drug Administration", category: "Federal", url: "https://www.fda.gov/" },
  { short: "HRSA", full: "Health Resources and Services Administration", category: "Federal", url: "https://www.hrsa.gov/" },
  { short: "SAMHSA", full: "Substance Abuse and Mental Health Services Administration", category: "Federal", url: "https://www.samhsa.gov/" },
  { short: "PCORI", full: "Patient-Centered Outcomes Research Institute", category: "Federal", url: "https://www.pcori.org/" },
];

const FOUNDATIONS: Sponsor[] = [
  { short: "ACS", full: "American Cancer Society", category: "Foundation", url: "https://www.cancer.org/" },
  { short: "AHA", full: "American Heart Association", category: "Foundation", url: "https://www.heart.org/" },
  { short: "OCRA", full: "Ovarian Cancer Research Alliance", category: "Foundation", url: "https://ocrahope.org/" },
  { short: "BCRF", full: "Breast Cancer Research Foundation", category: "Foundation", url: "https://www.bcrf.org/" },
  { short: "LLS", full: "Leukemia & Lymphoma Society", category: "Foundation", url: "https://www.lls.org/" },
  { short: "PCF", full: "Prostate Cancer Foundation", category: "Foundation", url: "https://www.pcf.org/" },
  { short: "BWF", full: "Burroughs Wellcome Fund", category: "Foundation", url: "https://www.bwfund.org/" },
  { short: "DRCRF", full: "Damon Runyon Cancer Research Foundation", category: "Foundation", url: "https://www.damonrunyon.org/", aliases: ["damon runyon"] },
  { short: "HHMI", full: "Howard Hughes Medical Institute", category: "Foundation", url: "https://www.hhmi.org/" },
  { short: "Wellcome", full: "Wellcome Trust", category: "Foundation", url: "https://wellcome.org/", aliases: ["wellcome trust"] },
  { short: "Gates Foundation", full: "Bill & Melinda Gates Foundation", category: "Foundation", url: "https://www.gatesfoundation.org/", aliases: ["bill & melinda gates foundation", "bmgf"] },
  { short: "RWJF", full: "Robert Wood Johnson Foundation", category: "Foundation", url: "https://www.rwjf.org/" },
  { short: "Doris Duke", full: "Doris Duke Charitable Foundation", category: "Foundation", url: "https://www.dorisduke.org/", aliases: ["doris duke charitable foundation", "ddcf"] },
  { short: "JDRF", full: "Juvenile Diabetes Research Foundation", category: "Foundation", url: "https://www.jdrf.org/" },
  { short: "ADA", full: "American Diabetes Association", category: "Foundation", url: "https://diabetes.org/" },
  { short: "MJFF", full: "Michael J. Fox Foundation for Parkinson's Research", category: "Foundation", url: "https://www.michaeljfox.org/" },
  { short: "ALSF", full: "Alex's Lemonade Stand Foundation", category: "Foundation", url: "https://www.alexslemonade.org/" },
  { short: "St. Baldrick's", full: "St. Baldrick's Foundation", category: "Foundation", url: "https://www.stbaldricks.org/" },
  { short: "Susan G. Komen", full: "Susan G. Komen", category: "Foundation", url: "https://www.komen.org/", aliases: ["komen foundation"] },
  { short: "MMRF", full: "Multiple Myeloma Research Foundation", category: "Foundation", url: "https://themmrf.org/" },
  { short: "MSCRF", full: "Maryland Stem Cell Research Fund", category: "Foundation" },
  { short: "Simons Foundation", full: "Simons Foundation", category: "Foundation", url: "https://www.simonsfoundation.org/" },
  { short: "Alzheimer's Association", full: "Alzheimer's Association", category: "Foundation", url: "https://www.alz.org/" },
  { short: "AACR", full: "American Association for Cancer Research", category: "Foundation", url: "https://www.aacr.org/" },
  { short: "ASCO", full: "American Society of Clinical Oncology", category: "Foundation", url: "https://www.asco.org/" },
  { short: "Mark Foundation", full: "The Mark Foundation for Cancer Research", category: "Foundation", url: "https://themarkfoundation.org/" },
  { short: "V Foundation", full: "The V Foundation for Cancer Research", category: "Foundation", url: "https://www.v.org/" },
  { short: "Pew", full: "Pew Charitable Trusts", category: "Foundation", url: "https://www.pewtrusts.org/" },
  { short: "Searle Scholars", full: "Searle Scholars Program", category: "Foundation", url: "https://www.searlescholars.net/" },
];

const INDUSTRY: Sponsor[] = [
  { short: "AstraZeneca", full: "AstraZeneca PLC", category: "Industry", url: "https://www.astrazeneca.com/", aliases: ["astrazeneca plc"] },
  { short: "Pfizer", full: "Pfizer Inc.", category: "Industry", url: "https://www.pfizer.com/" },
  { short: "BMS", full: "Bristol-Myers Squibb", category: "Industry", url: "https://www.bms.com/", aliases: ["bristol-myers squibb", "bristol myers squibb"] },
  { short: "Merck", full: "Merck & Co., Inc.", category: "Industry", url: "https://www.merck.com/", aliases: ["merck & co", "merck and co"] },
  { short: "Genentech", full: "Genentech, Inc.", category: "Industry", url: "https://www.gene.com/" },
  { short: "Novartis", full: "Novartis AG", category: "Industry", url: "https://www.novartis.com/" },
  { short: "Roche", full: "F. Hoffmann-La Roche Ltd.", category: "Industry", url: "https://www.roche.com/" },
  { short: "GSK", full: "GlaxoSmithKline plc", category: "Industry", url: "https://www.gsk.com/", aliases: ["glaxosmithkline"] },
  { short: "Eli Lilly", full: "Eli Lilly and Company", category: "Industry", url: "https://www.lilly.com/", aliases: ["lilly", "eli lilly and company"] },
  { short: "Sanofi", full: "Sanofi S.A.", category: "Industry", url: "https://www.sanofi.com/" },
  { short: "AbbVie", full: "AbbVie Inc.", category: "Industry", url: "https://www.abbvie.com/" },
  { short: "Johnson & Johnson", full: "Johnson & Johnson", category: "Industry", url: "https://www.jnj.com/", aliases: ["j&j", "jnj"] },
  { short: "Janssen", full: "Janssen Pharmaceuticals", category: "Industry", url: "https://www.janssen.com/" },
  { short: "Bayer", full: "Bayer AG", category: "Industry", url: "https://www.bayer.com/" },
  { short: "Boehringer Ingelheim", full: "Boehringer Ingelheim", category: "Industry", url: "https://www.boehringer-ingelheim.com/" },
  { short: "Takeda", full: "Takeda Pharmaceutical Company", category: "Industry", url: "https://www.takeda.com/" },
  { short: "Amgen", full: "Amgen Inc.", category: "Industry", url: "https://www.amgen.com/" },
  { short: "Gilead", full: "Gilead Sciences, Inc.", category: "Industry", url: "https://www.gilead.com/", aliases: ["gilead sciences"] },
  { short: "Regeneron", full: "Regeneron Pharmaceuticals", category: "Industry", url: "https://www.regeneron.com/" },
  { short: "Moderna", full: "Moderna, Inc.", category: "Industry", url: "https://www.modernatx.com/" },
  { short: "BioNTech", full: "BioNTech SE", category: "Industry", url: "https://www.biontech.com/" },
  { short: "Vertex", full: "Vertex Pharmaceuticals", category: "Industry", url: "https://www.vrtx.com/" },
  { short: "Biogen", full: "Biogen Inc.", category: "Industry", url: "https://www.biogen.com/" },
  { short: "Incyte", full: "Incyte Corporation", category: "Industry", url: "https://www.incyte.com/" },
  { short: "Seagen", full: "Seagen Inc.", category: "Industry", url: "https://www.seagen.com/" },
  { short: "Servier", full: "Servier", category: "Industry", url: "https://www.servier.com/" },
  { short: "Daiichi Sankyo", full: "Daiichi Sankyo Co., Ltd.", category: "Industry", url: "https://www.daiichisankyo.com/" },
  { short: "Astellas", full: "Astellas Pharma Inc.", category: "Industry", url: "https://www.astellas.com/" },
  { short: "Eisai", full: "Eisai Co., Ltd.", category: "Industry", url: "https://www.eisai.com/" },
  { short: "Tempus", full: "Tempus AI, Inc.", category: "Industry", url: "https://www.tempus.com/" },
];

const ALL_SPONSORS: Sponsor[] = [...NIH_ICS, ...FEDERAL, ...FOUNDATIONS, ...INDUSTRY];

const BY_KEY: Map<string, Sponsor> = (() => {
  const m = new Map<string, Sponsor>();
  for (const s of ALL_SPONSORS) {
    m.set(s.short.toLowerCase(), s);
    if (s.aliases) {
      for (const a of s.aliases) m.set(a.toLowerCase(), s);
    }
  }
  return m;
})();

export function getSponsor(short: string | null | undefined): Sponsor | null {
  if (!short) return null;
  return BY_KEY.get(short.trim().toLowerCase()) ?? null;
}

export function expandSponsor(short: string | null | undefined): string | null {
  return getSponsor(short)?.full ?? null;
}

export function listSponsors(): readonly Sponsor[] {
  return ALL_SPONSORS;
}
