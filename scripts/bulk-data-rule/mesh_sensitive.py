"""Sensitive-AREA denominator: tag the since-2020 corpus by bulk-rule category from MeSH terms.
Answers 'what fraction is in each sensitive category regardless of deposition' -> surfaces non-omic
categories (health/biometric/geolocation) that rarely get a signature-repo deposit.
CAVEAT: MeSH = study topic, a coarse UPPER BOUND on sensitive-data generation, not proof bulk identifiable data was shared.
ponytail: high-precision MeSH term lists + set membership, no classifier to train."""
import os, time, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
import pandas as pd

OUT=os.path.dirname(os.path.abspath(__file__)); API=os.environ.get("PUBMED_API_KEY","")
cov=pd.read_csv(f"{OUT}/coverage.csv"); cov=cov[cov['year']>=2020].copy()
pmids=cov['pmid'].astype(int).astype(str).tolist()
print(f"MeSH pass over {len(pmids)} since-2020 pubs", flush=True)

# category -> set of MeSH descriptor substrings (lowercased, high precision). Human categories also require 'humans'.
CAT = {
 "genomic": ["genomics","genome-wide association","whole genome sequencing","exome sequencing",
   "whole exome","high-throughput nucleotide sequencing","polymorphism, single nucleotide","dna mutational analysis","genotyping techniques"],
 "omic_other": ["transcriptome","gene expression profiling","proteomics","proteome","metabolomics","metabolome",
   "epigenomics","epigenesis, genetic","rna-seq","sequence analysis, rna","single-cell analysis","chromatin immunoprecipitation"],
 "health": ["electronic health records","medical records systems, computerized","medical records","registries",
   "insurance claim review","comparative effectiveness research","patient-reported outcome"],
 "biometric": ["neuroimaging","functional neuroimaging","face","biometric identification","dermatoglyphics","retina","voice","gait"],
 "geolocation": ["geographic information systems","spatial analysis","geographic mapping","residence characteristics","small-area analysis"],
}
EFETCH="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
def fetch(batch):
    d={"db":"pubmed","id":",".join(batch),"retmode":"xml"}; d.update({"api_key":API} if API else {})
    for a in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(EFETCH,data=urllib.parse.urlencode(d).encode()),timeout=120).read()
        except Exception:
            if a==3: raise
            time.sleep(2*(a+1))

rows=[]; B=200
for i in range(0,len(pmids),B):
    root=ET.fromstring(fetch(pmids[i:i+B]))
    for art in root.findall(".//PubmedArticle"):
        pmid=art.findtext(".//MedlineCitation/PMID")
        mesh=[ (d.findtext("DescriptorName") or "").lower() for d in art.findall(".//MeshHeading") ]
        mesh=[m for m in mesh if m]
        human = any("humans"==m for m in mesh)
        cats=set()
        for cat,terms in CAT.items():
            if any(any(t in m for t in terms) for m in mesh):
                if cat in ("genomic","omic_other","health","biometric") and not human:  # require human subjects
                    continue
                cats.add(cat)
        rows.append((pmid, int(human), "|".join(sorted(cats))))
    if (i//B)%10==0: print(f"  {i+B}/{len(pmids)}", flush=True)
    time.sleep(0.12 if API else 0.34)

m=pd.DataFrame(rows,columns=["pmid","human","sensitive_cats"])
m.to_csv(f"{OUT}/mesh_sensitive.csv",index=False)
m['pmid']=m['pmid'].astype(int)
print(f"\nsince-2020 pubs tagged: {len(m)}   human-subjects: {m['human'].sum()}")
print("\n=== sensitive-area category -> #pubs (MeSH upper bound) ===")
for cat in CAT:
    n=m['sensitive_cats'].str.contains(cat).sum()
    print(f"  {cat:12s} {n}")
print(f"\nany sensitive category: {(m['sensitive_cats']!='').sum()}")
print(f"NO sensitive category flagged: {(m['sensitive_cats']=='').sum()}")
