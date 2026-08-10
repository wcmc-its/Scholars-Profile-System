"""Sensitivity taxonomy: coarse bulk-rule categories + granular sub-types, from MeSH descriptors.
Single source of truth for the sensitive-area tagging. ponytail: substring sets, no classifier."""

# coarse categories (kept consistent with the original mesh_sensitive denominator)
CAT = {
 "genomic": ["genomics","genome-wide association","whole genome sequencing","exome sequencing","whole exome",
   "high-throughput nucleotide sequencing","polymorphism, single nucleotide","dna mutational analysis","genotyping techniques"],
 "omic_other": ["transcriptome","gene expression profiling","proteomics","proteome","metabolomics","metabolome",
   "epigenomics","epigenesis, genetic","rna-seq","sequence analysis, rna","single-cell analysis","chromatin immunoprecipitation"],
 "health": ["electronic health records","medical records systems, computerized","medical records","registries",
   "insurance claim review","comparative effectiveness research","patient-reported outcome"],
 "biometric": ["neuroimaging","functional neuroimaging","face","biometric identification","dermatoglyphics","retina","voice","gait"],
 "geolocation": ["geographic information systems","spatial analysis","geographic mapping","residence characteristics","small-area analysis"],
}
# granular sub-types (label -> MeSH substrings); each sub belongs to a coarse parent
SUB = {
 "genomic": {
   "WGS/WES": ["whole genome sequencing","whole exome","exome sequencing"],
   "GWAS": ["genome-wide association"],
   "germline variants": ["polymorphism, single nucleotide","germ-line mutation","dna mutational analysis","genotyping techniques"],
   "sequencing (unspecified)": ["high-throughput nucleotide sequencing","genomics"],
 },
 "omic_other": {
   "transcriptomic": ["transcriptome","gene expression profiling","sequence analysis, rna","rna-seq"],
   "single-cell": ["single-cell analysis","single cell"],
   "epigenomic": ["epigenomics","epigenesis, genetic","dna methylation","chromatin immunoprecipitation","histone code"],
   "proteomic": ["proteomics","proteome","mass spectrometry"],
   "metabolomic": ["metabolomics","metabolome"],
 },
 "health": {
   "EHR": ["electronic health records","medical records systems, computerized","medical records"],
   "registry": ["registries"],
   "claims": ["insurance claim review"],
   "observational/cohort": ["comparative effectiveness research","cohort studies","patient-reported outcome"],
 },
 "biometric": {
   "neuroimaging": ["neuroimaging","functional neuroimaging","magnetic resonance imaging","electroencephalography"],
   "facial": ["face"],
   "voice/gait": ["voice","gait"],
 },
 "geolocation": {
   "GIS/spatial": ["geographic information systems","spatial analysis","geographic mapping","residence characteristics","small-area analysis"],
 },
}
HUMAN_REQUIRED = {"genomic","omic_other","health","biometric"}  # geolocation may be non-human

def tag(mesh_terms, human):
    """mesh_terms: list of lowercased MeSH descriptors. Returns (coarse set, sub set)."""
    ms = [m.lower() for m in mesh_terms if m]
    coarse, subs = set(), set()
    for cat, terms in CAT.items():
        if any(any(t in m for t in terms) for m in ms):
            if cat in HUMAN_REQUIRED and not human: continue
            coarse.add(cat)
    for cat, subd in SUB.items():
        if cat in HUMAN_REQUIRED and not human: continue
        for sub, terms in subd.items():
            if any(any(t in m for t in terms) for m in ms):
                subs.add(f"{cat}:{sub}")
    return coarse, subs

def resolve_repo(repo, subs, human):
    """Repository-detail granularity: resolve broad repos using data sub-type + human flag."""
    sub_str = " ".join(subs)
    if repo == "SRA":
        return "SRA (human raw reads — dbGaP-eligible)" if human else "SRA (non-human/other)"
    if repo == "GEO":
        if "omic_other:single-cell" in subs: return "GEO (single-cell)"
        if "omic_other:epigenomic" in subs: return "GEO (methylation/ChIP/epigenomic)"
        return "GEO (expression/transcriptomic)"
    if repo == "ProteomeXchange":
        return "ProteomeXchange (host unresolved — likely PRIDE/EU)"
    return repo

if __name__=="__main__":
    c,s = tag(["Genomics","Whole Exome Sequencing","Humans","Single-Cell Analysis"], True)
    assert "genomic" in c and "omic_other" in c
    assert "genomic:WGS/WES" in s and "omic_other:single-cell" in s
    assert tag(["Genomics"], False)[0] == set()   # human required
    assert resolve_repo("SRA", set(), True).startswith("SRA (human")
    assert resolve_repo("GEO", {"omic_other:single-cell"}, True) == "GEO (single-cell)"
    print("taxonomy self-check OK")
