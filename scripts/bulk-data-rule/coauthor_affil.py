"""Coauthor-affiliation vector: for each depositing paper, pull ALL author affiliations from PubMed and
flag any affiliated in a country of concern. Complements repository-host-country with 'covered person on the paper'.
ponytail: per-affiliation-string regex with Taiwan / South-Korea guards; country token is reliably present in NLM affiliations."""
import os, time, re, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
import pandas as pd

# Durable, non-git output location - see extract_databanks.py's OUT comment.
OUT=os.path.expanduser("~/Dropbox/Projects/Bulk Data Rule/data")
os.makedirs(OUT, exist_ok=True)
API=os.environ.get("PUBMED_API_KEY","")
pmids=sorted(pd.read_csv(f"{OUT}/attributed_deposits.csv")['pmid'].dropna().astype(int).unique().tolist())
print(f"{len(pmids)} depositing pubs -> all-author affiliations", flush=True)

# country-of-concern detection, evaluated per affiliation string
def coc_countries(aff):
    a=aff.lower(); found=set()
    taiwan = "taiwan" in a
    if (re.search(r"\bchina\b|p\.?\s*r\.?\s*china|people'?s republic of china|chinese academy", a) or "hong kong" in a or re.search(r"\bmaca[uo]\b", a)) and not taiwan:
        found.add("China")
    if "hong kong" in a: found.add("China")   # HK/Macau are in-scope regardless of taiwan token
    if re.search(r"\bmaca[uo]\b", a): found.add("China")
    if re.search(r"\brussia\b|russian federation", a): found.add("Russia")
    if re.search(r"\biran\b", a) and "iranian journal" not in a: found.add("Iran")
    if re.search(r"north korea|d\.?p\.?r\.?\s*korea|pyongyang|democratic people'?s republic of korea", a): found.add("North Korea")
    if re.search(r"\bcuba\b|havana", a) and "columbia" not in a: found.add("Cuba")
    if re.search(r"\bvenezuela\b|caracas", a): found.add("Venezuela")
    return found

EFETCH="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
def fetch(batch):
    d={"db":"pubmed","id":",".join(map(str,batch)),"retmode":"xml"}; d.update({"api_key":API} if API else {})
    for k in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(EFETCH,data=urllib.parse.urlencode(d).encode()),timeout=120).read()
        except Exception:
            if k==3: raise
            time.sleep(2*(k+1))

rows=[]
for i in range(0,len(pmids),200):
    root=ET.fromstring(fetch(pmids[i:i+200]))
    for art in root.findall(".//PubmedArticle"):
        pmid=art.findtext(".//MedlineCitation/PMID")
        affs=[ (a.text or "") for a in art.findall(".//AuthorList/Author/AffiliationInfo/Affiliation") ]
        n_auth=len(art.findall(".//AuthorList/Author"))
        countries=set(); examples=[]
        for aff in affs:
            c=coc_countries(aff)
            if c:
                countries|=c
                if len(examples)<3: examples.append(aff.strip()[:180])
        rows.append((int(pmid), n_auth, len(affs), int(bool(countries)), "; ".join(sorted(countries)), " || ".join(examples)))
    time.sleep(0.12 if API else 0.34)
    if (i//200)%3==0: print(f"  {i+200}/{len(pmids)}", flush=True)

ca=pd.DataFrame(rows,columns=["pmid","n_authors","n_affils","coc_coauthor","coc_countries","coc_examples"])
ca.to_csv(f"{OUT}/coauthor_affil.csv",index=False)
print(f"\ndepositing pubs with >=1 country-of-concern-affiliated author: {ca['coc_coauthor'].sum()}/{len(ca)}")
print(f"pubs with NO affiliation data at all: {(ca['n_affils']==0).sum()}")
print("\n=== country breakdown (pubs) ===")
from collections import Counter
cnt=Counter()
for s in ca[ca['coc_coauthor']==1]['coc_countries']:
    for c in s.split("; "): cnt[c]+=1
for c,n in cnt.most_common(): print(f"  {n:4d}  {c}")

# cross with deposit tier/type
dep=pd.read_csv(f"{OUT}/attributed_deposits.csv")[['pmid','tier','sensitive_cats','usgov_funded']].drop_duplicates('pmid')
dep['pmid']=dep['pmid'].astype(int)
m=ca.merge(dep,on='pmid',how='left'); coc=m[m['coc_coauthor']==1]
openomic=coc[(coc['tier'].isin(['US_OPEN','FOREIGN_OPEN'])) & (coc['sensitive_cats'].fillna('').str.contains('genomic|omic_other'))]
print(f"\nCOC-coauthor pubs that ALSO deposit open genomic/omic: {openomic['pmid'].nunique()}")
print(f"  of those, NOT US-federally funded: {(~openomic['usgov_funded'].astype(bool)).sum()}")
