"""Fold preprints into the corpus: fetch PMCIDs + DataBankList, run the same full-text deposition scan.
ponytail: reuse scan2.scan_corpus; only the 325 new PMIDs, not a full re-run."""
import os, time, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
import pandas as pd
from sqlalchemy import create_engine, text
import scan2

# Durable, non-git output location - see extract_databanks.py's OUT comment.
OUT=os.path.expanduser("~/Dropbox/Projects/Bulk Data Rule/data")
os.makedirs(OUT, exist_ok=True)
API=os.environ.get("PUBMED_API_KEY","")
engine=create_engine(f"mysql+pymysql://{os.environ['DB_USERNAME']}:{os.environ['DB_PASSWORD']}@{os.environ['DB_HOST']}/{os.environ['DB_NAME']}")
q="""SELECT DISTINCT r.pmid pmid, r.articleYear yr FROM analysis_summary_author a
     JOIN analysis_summary_article r ON r.pmid=a.pmid JOIN identity i ON i.cwid=a.personIdentifier
     WHERE i.fullTimeFaculty='yes' AND a.authorPosition IN ('first','last')
     AND r.publicationTypeCanonical='Preprint' AND r.articleYear>=2020"""
with engine.connect() as c: pubs=pd.read_sql(text(q), c)
pubs=pubs[pubs['pmid'].notna()].copy(); pubs['pmid']=pubs['pmid'].astype(int).astype(str)
yr=dict(zip(pubs['pmid'],pubs['yr'])); pmids=pubs['pmid'].tolist()
print(f"{len(pmids)} preprint PMIDs", flush=True)

EFETCH="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
def fetch(batch):
    d={"db":"pubmed","id":",".join(batch),"retmode":"xml"}; d.update({"api_key":API} if API else {})
    for a in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(EFETCH,data=urllib.parse.urlencode(d).encode()),timeout=120).read()
        except Exception:
            if a==3: raise
            time.sleep(2*(a+1))

dbrows=[]; covrows=[]
for i in range(0,len(pmids),200):
    root=ET.fromstring(fetch(pmids[i:i+200]))
    for art in root.findall(".//PubmedArticle"):
        pmid=art.findtext(".//MedlineCitation/PMID"); pmcid=None
        for aid in art.findall(".//PubmedData/ArticleIdList/ArticleId"):
            if aid.get("IdType")=="pmc": pmcid=aid.text
        hasdb=0
        for db in art.findall(".//Article/DataBankList/DataBank"):
            name=db.findtext("DataBankName"); accs=[a.text for a in db.findall("AccessionNumberList/AccessionNumber")] or [None]
            for acc in accs: hasdb=1; dbrows.append((pmid,yr.get(pmid),name,acc))
        covrows.append((pmid,yr.get(pmid),pmcid,hasdb))
    time.sleep(0.12 if API else 0.34)

cov=pd.DataFrame(covrows,columns=["pmid","year","pmcid","has_databank"])
pd.DataFrame(dbrows,columns=["pmid","year","databank","accession"]).to_csv(f"{OUT}/preprint_databank.csv",index=False)
cov.to_csv(f"{OUT}/preprint_coverage.csv",index=False)
print(f"preprints with PMC full text: {cov['pmcid'].notna().sum()}/{len(cov)}", flush=True)

scov=cov[cov['pmcid'].notna()].copy(); scov['pmcid']=scov['pmcid'].astype(str)
d,s=scan2.scan_corpus(scov, f"{OUT}/preprint_deposits_v2.csv", f"{OUT}/preprint_status_v2.csv")
dep_ok=d[(d['context']!='use')&(d['confidence']=='high')]
print(f"preprint counted deposits: {dep_ok['pmid'].nunique()} pubs, {len(dep_ok)} deposits")
print(dep_ok.groupby(["repo","tier"])['pmid'].nunique().sort_values(ascending=False).to_string() if len(dep_ok) else "  none")
