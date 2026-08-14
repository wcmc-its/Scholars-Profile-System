"""Repository-of-repositories: classify a data repository by host country, access model,
bulk-rule data bucket, and risk tier. Keyed on both DataBankName strings and accession-ID prefixes.
Facts for the high-stakes rows (GSA-Human=China/NGDC, dbGaP=US/controlled, EGA=EMBL-EBI/controlled) verified 2026-07.
ponytail: a flat list + two dict lookups. No ORM, no config file — the data IS the module."""
import re

# tier: CONCERN (country-of-concern-hosted) > FOREIGN_OPEN > FOREIGN_CTRL > US_OPEN > US_CTRL > REGISTRY
# For human 'omic data the rule prohibits giving countries of concern *access*; OPEN == access, so
# access model drives risk as much as host country. Report logic combines tier + data bucket.
R = [
  # canonical, aliases(lower), accession_regexes, org, country, access, bucket, tier, note, url
  ("GSA-Human", ["gsa-human","gsa for human","genome sequence archive for human"], [r"^HRA\d"],
     "China National Center for Bioinformation / NGDC (Beijing Inst. of Genomics, CAS)","China","open (request)","human genomic/omic","CONCERN",
     "Country of concern, open-access. Categorical prohibition risk for bulk human omic data.",
     "https://ngdc.cncb.ac.cn/gsa-human/"),
  ("GSA", ["gsa","genome sequence archive"], [r"^CRA\d",r"^PRJC"],
     "NGDC / CNCB (Beijing)","China","open","genomic/omic","CONCERN","Country of concern host.",
     "https://ngdc.cncb.ac.cn/gsa/"),
  ("NGDC/CNCB (other)", ["ngdc","cncb","big data center","omix","gvm","gwh","genome warehouse","node","national omics data encyclopedia"], [r"^OMIX",r"^GWH",r"^GVM"],
     "NGDC / CNCB or SIBCB (China)","China","open","various omic","CONCERN","Country of concern host.",
     "https://ngdc.cncb.ac.cn/"),
  ("iProX", ["iprox","integrated proteome resources"], [r"^IPX\d"],
     "Beijing Proteome Research Center / Nat'l Center for Protein Sciences (Beijing)","China","open","proteomic","CONCERN","Country of concern host (proteomics), fully open-access.",
     "https://www.iprox.cn/"),
  ("CNGB/CNSA", ["cngb","cnsa","china national genebank"], [r"^CNP\d"],
     "China National GeneBank (BGI, Shenzhen)","China","open","genomic/omic","CONCERN","Country of concern host.",
     "https://db.cngb.org/cnsa/"),

  ("dbGaP", ["dbgap","database of genotypes and phenotypes"], [r"^phs\d"],
     "NCBI / NIH","USA","controlled","human genomic/health","US_CTRL",
     "US, controlled-access — the compliant path for bulk human genomic data.",
     "https://www.ncbi.nlm.nih.gov/gap/"),
  ("ImmPort", ["immport"], [], "NIAID / NIH","USA","controlled","clinical/immunology","US_CTRL","US controlled-access.",
     "https://www.immport.org/"),

  ("GEO", ["geo","gene expression omnibus"], [r"^GSE\d",r"^GSM\d",r"^GPL\d"],
     "NCBI / NIH","USA","open","human omic (expression)","US_OPEN",
     "US-hosted but OPEN — human omic data globally downloadable incl. countries of concern.",
     "https://www.ncbi.nlm.nih.gov/geo/"),
  ("SRA", ["sra","sequence read archive"], [r"^SR[APRXS]\d",r"^PRJNA\d"],
     "NCBI / NIH","USA","open (human often via dbGaP)","genomic/omic","US_OPEN",
     "Open raw reads; human-identifiable subsets should route to dbGaP.",
     "https://www.ncbi.nlm.nih.gov/sra"),
  ("BioProject/BioSample", ["bioproject","biosample"], [r"^PRJNA\d",r"^SAMN\d"],
     "NCBI / NIH","USA","open","metadata","US_OPEN","Project/sample metadata.",
     "https://www.ncbi.nlm.nih.gov/bioproject/"),
  ("GenBank", ["genbank","insdc","nucleotide"], [r"^[A-Z]{1,2}\d{5,6}(\.\d)?$"],
     "NCBI / NIH","USA","open","sequence (mostly non-human)","US_OPEN","Mostly non-human; low identifiability.",
     "https://www.ncbi.nlm.nih.gov/genbank/"),
  ("Metabolomics Workbench", ["metabolomics workbench"], [r"^ST\d{6}"],
     "UC San Diego","USA","open","metabolomic","US_OPEN","US open metabolomics.",
     "https://www.metabolomicsworkbench.org/"),
  ("MassIVE", ["massive"], [r"^MSV\d"], "UC San Diego","USA","open","proteomic","US_OPEN","US open proteomics.",
     "https://massive.ucsd.edu/"),
  ("Dryad", ["dryad"], [r"10\.5061/dryad"], "Dryad (US nonprofit)","USA","open","generalist","US_OPEN","Generalist open; check data type.",
     "https://datadryad.org/"),
  ("OSF", ["osf","open science framework"], [], "Center for Open Science (US)","USA","open","generalist","US_OPEN","Generalist open.",
     "https://osf.io/"),
  ("Harvard Dataverse", ["dataverse"], [], "Harvard (US)","USA","open/restricted","generalist","US_OPEN","Options for restricted access.",
     "https://dataverse.harvard.edu/"),
  ("TCIA", ["tcia","cancer imaging archive"], [], "US (NCI-funded)","USA","open/restricted","imaging/biometric","US_OPEN","Imaging; some restricted collections.",
     "https://www.cancerimagingarchive.net/"),

  ("EGA", ["ega","european genome-phenome archive","european genome phenome archive"], [r"^EGA[SDNCP]\d"],
     "EMBL-EBI (UK) + CRG (Spain)","EU/UK","controlled","human genomic/health","FOREIGN_CTRL",
     "Controlled-access but foreign-jurisdiction; onward-transfer governed by EU, not US.",
     "https://ega-archive.org/"),
  ("ArrayExpress/BioStudies", ["arrayexpress","biostudies"], [r"^E-[A-Z]{4}-\d",r"^S-[A-Z]{4}"],
     "EMBL-EBI (UK)","EU/UK","open","omic (expression)","FOREIGN_OPEN","Foreign-hosted, open.",
     "https://www.ebi.ac.uk/biostudies/arrayexpress"),
  ("ENA", ["ena","european nucleotide archive"], [r"^PRJEB\d",r"^ER[RPSX]\d"],
     "EMBL-EBI (UK)","EU/UK","open","sequence","FOREIGN_OPEN","Foreign-hosted, open (INSDC mirror).",
     "https://www.ebi.ac.uk/ena/browser/home"),
  ("PRIDE", ["pride"], [r"^PXD\d"], "EMBL-EBI (UK)","EU/UK","open","proteomic","FOREIGN_OPEN","Foreign-hosted, open (via ProteomeXchange).",
     "https://www.ebi.ac.uk/pride/"),
  ("MetaboLights", ["metabolights"], [r"^MTBLS\d"], "EMBL-EBI (UK)","EU/UK","open","metabolomic","FOREIGN_OPEN","Foreign-hosted, open.",
     "https://www.ebi.ac.uk/metabolights/"),
  ("figshare", ["figshare"], [r"10\.6084/m9\.figshare"], "Digital Science (UK)","EU/UK","open","generalist","FOREIGN_OPEN","Foreign-owned generalist, global CDN; check data type.",
     "https://figshare.com/"),
  ("Zenodo", ["zenodo"], [r"10\.5281/zenodo"], "CERN (Switzerland)","EU","open","generalist","FOREIGN_OPEN","Foreign-hosted generalist open.",
     "https://zenodo.org/"),
  ("Mendeley Data", ["mendeley data"], [], "Elsevier / RELX (NL)","EU","open","generalist","FOREIGN_OPEN","Foreign-owned generalist open.",
     "https://data.mendeley.com/"),
  ("ProteomeXchange", ["proteomexchange","px"], [r"^PXD\d"], "consortium (routes to PRIDE/MassIVE/iProX/jPOST)","multi","open","proteomic","FOREIGN_OPEN","Routing layer — resolve to actual host (iProX=China).",
     "http://www.proteomexchange.org/"),

  # --- non-omic sensitive repositories (health / biometric / imaging) ---
  ("OpenNeuro", ["openneuro"], [r"^ds\d{6}$"],
     "OpenNeuro (Stanford / NIH, US)","USA","open","neuroimaging (biometric-adjacent)","US_OPEN",
     "Open MRI/EEG; defacing reduces but does not eliminate biometric re-identification.",
     "https://openneuro.org/"),
  ("NDA (NIMH Data Archive)", ["nimh data archive","nda collection","national database for autism"], [],
     "NIH / NIMH","USA","controlled","neuro / health / biometric","US_CTRL","US controlled-access.",
     "https://nda.nih.gov/"),
  ("PhysioNet", ["physionet"], [], "MIT (US)","USA","open/credentialed","physiologic / health (e.g. MIMIC)","US_OPEN",
     "Some collections credentialed; health waveforms/EHR.",
     "https://physionet.org/"),
  ("IDR (Image Data Resource)", ["image data resource"], [], "EMBL-EBI (UK)","EU/UK","open","imaging","FOREIGN_OPEN","Foreign-hosted imaging.",
     "https://idr.openmicroscopy.org/"),
  ("Vivli", ["vivli"], [], "Vivli (US nonprofit)","USA","controlled","clinical trial IPD (health)","US_CTRL","Controlled clinical-trial data-sharing platform.",
     "https://vivli.org/"),
  ("BioLINCC", ["biolincc"], [], "NHLBI / NIH","USA","controlled","clinical (health)","US_CTRL","US controlled clinical.",
     "https://biolincc.nhlbi.nih.gov/"),
  ("Synapse", ["sage bionetworks","synapse.org"], [r"^syn\d{6,}"], "Sage Bionetworks (US)","USA","open/controlled","various (health/omic)","US_OPEN","Governance varies per project.",
     "https://www.synapse.org/"),

  ("ClinicalTrials.gov", ["clinicaltrials.gov","clinicaltrials"], [r"^NCT\d"],
     "NLM / NIH","USA","open registry","registration (not microdata)","REGISTRY","Trial registration, not identifiable microdata.",
     "https://clinicaltrials.gov/"),
  ("CTRI", ["ctri","clinical trials registry-india","clinical trials registry india"], [r"^CTRI/"],
     "ICMR (India)","India","open registry","registration (not microdata)","REGISTRY","Trial registry (India); not bulk microdata.",
     "https://ctri.nic.in/"),
  ("PDB", ["pdb","protein data bank","wwpdb","rcsb","pdbe","pdbj"], [r"^[0-9][A-Za-z0-9]{3}$"],
     "wwPDB (US/EU/JP)","multi","open","macromolecular structure","REGISTRY","Structures; not human-identifiable.",
     "https://www.rcsb.org/"),
]

_by_name = {}
for rec in R:
    for a in rec[1]:
        _by_name[a] = rec
_accession_pats = [(re.compile(p, re.I), rec) for rec in R for p in rec[2]]

FIELDS = ["canonical","org","country","access","bucket","tier","note","url"]
def _pack(rec):
    return dict(zip(FIELDS, (rec[0], rec[3], rec[4], rec[5], rec[6], rec[7], rec[8], rec[9])))

def classify_name(name):
    if not name: return None
    n = name.strip().lower()
    if n in _by_name: return _pack(_by_name[n])
    for a, rec in _by_name.items():          # substring fallback
        if a in n or n in a:
            return _pack(rec)
    return None

def classify_accession(acc):
    if not acc: return None
    a = acc.strip()
    for pat, rec in _accession_pats:
        if pat.search(a): return _pack(rec)
    return None

def classify(name=None, accession=None):
    return classify_name(name) or classify_accession(accession) or {
        "canonical": (name or "unknown"), "org":"?","country":"?","access":"?",
        "bucket":"?","tier":"UNKNOWN","note":"unmapped — review","url":None}

if __name__ == "__main__":
    assert classify_accession("HRA000123")["tier"] == "CONCERN"
    assert classify_accession("phs001234.v1.p1")["tier"] == "US_CTRL"
    assert classify_accession("GSE12345")["canonical"] == "GEO"
    assert classify_accession("EGAS00001")["tier"] == "FOREIGN_CTRL"
    assert classify_accession("PXD004567")["bucket"] == "proteomic"
    assert classify_name("dbGaP")["country"] == "USA"
    assert classify_name("Gene Expression Omnibus (GEO)")["canonical"] == "GEO"
    assert classify("Totally Unknown Repo")["tier"] == "UNKNOWN"
    assert classify("Totally Unknown Repo")["url"] is None
    assert all(rec[9].startswith("http") for rec in R), "every catalog repository needs a url"
    assert classify_name("dbGaP")["url"] == "https://www.ncbi.nlm.nih.gov/gap/"
    print("catalog self-check OK —", len(R), "repositories,", len(_accession_pats), "accession patterns")
