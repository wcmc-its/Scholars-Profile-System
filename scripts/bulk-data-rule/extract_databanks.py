"""Structured deposition backbone: PubMed <DataBankList> for a department's WCM-authored pubs.
Deterministic, no LLM. Classifies + deposit-vs-use tags each row before it can auto-ship (see S-Index
spec, Architecture) and records PMC availability for a later full-text pass.
ponytail: submitter-declared databank metadata is free and high-precision; full-text parse only fills the gap it leaves."""
import os, time
import urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
import pandas as pd
from sqlalchemy import create_engine, text
import catalog, scan2

API = os.environ.get("PUBMED_API_KEY", "")
OUT = os.path.dirname(os.path.abspath(__file__))

engine = create_engine(
    f"mysql+pymysql://{os.environ['DB_USERNAME']}:{os.environ['DB_PASSWORD']}@{os.environ['DB_HOST']}/{os.environ['DB_NAME']}"
)
# Same engine, different filter (S-Index spec, Background): set PILOT_DEPARTMENT to scope to one
# department, all WCM co-authors, any position (S-Index spec, Scope). Unset preserves the original
# Bulk Data Rule scope (full-time faculty, first/last author only) so that report stays reproducible.
DEPT = os.environ.get("PILOT_DEPARTMENT")
if DEPT:
    where, params = "i.primaryAcademicDepartment = :dept", {"dept": DEPT}
else:
    where, params = "i.fullTimeFaculty = 'yes' AND a.authorPosition IN ('first','last')", {}
q = f"""
SELECT DISTINCT r.pmid AS pmid, r.articleYear AS yr
FROM analysis_summary_author a
JOIN analysis_summary_article r ON r.pmid = a.pmid
JOIN identity i ON i.cwid = a.personIdentifier
WHERE {where}
  AND r.publicationTypeCanonical = 'Academic Article'
"""
with engine.connect() as conn:
    pubs = pd.read_sql(text(q), conn, params=params)
pubs = pubs[pubs['pmid'].notna()].copy()
pubs['pmid'] = pubs['pmid'].astype(int).astype(str)
yr = dict(zip(pubs['pmid'], pubs['yr']))
pmids = pubs['pmid'].tolist()
print(f"{DEPT or 'FT faculty, first/last author (default Bulk Data Rule scope)'}: {len(pmids)} PMIDs to fetch", flush=True)

EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"

def fetch(batch):
    data = {"db": "pubmed", "id": ",".join(batch), "retmode": "xml"}
    if API:
        data["api_key"] = API
    req = urllib.request.Request(EFETCH, data=urllib.parse.urlencode(data).encode())
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))

rows = []          # pmid, yr, databank, accession
pmc_rows = []      # pmid, yr, pmcid, has_databank  (for gap analysis / full-text pass)
pmcid_of = {}      # pmid -> pmcid, reused below for the deposit-vs-use pass
B = 200
for i in range(0, len(pmids), B):
    batch = pmids[i:i+B]
    xml = fetch(batch)
    root = ET.fromstring(xml)
    for art in root.findall(".//PubmedArticle"):
        pmid = art.findtext(".//MedlineCitation/PMID")
        pmcid = None
        for aid in art.findall(".//PubmedData/ArticleIdList/ArticleId"):
            if aid.get("IdType") == "pmc":
                pmcid = aid.text
        pmcid_of[pmid] = pmcid
        banks = art.findall(".//Article/DataBankList/DataBank")
        has_bank = False
        for db in banks:
            name = db.findtext("DataBankName")
            accs = [a.text for a in db.findall("AccessionNumberList/AccessionNumber")]
            if not accs:
                accs = [None]
            for acc in accs:
                has_bank = True
                rows.append((pmid, yr.get(pmid), name, acc))
        pmc_rows.append((pmid, yr.get(pmid), pmcid, int(has_bank)))
    if (i // B) % 10 == 0:
        print(f"  {i+len(batch)}/{len(pmids)} done, {len(rows)} databank rows so far", flush=True)
    time.sleep(0.12 if API else 0.34)

dep = pd.DataFrame(rows, columns=["pmid", "year", "databank", "accession"])
cov = pd.DataFrame(pmc_rows, columns=["pmid", "year", "pmcid", "has_databank"])

# --- registry exclusion + deposit-vs-use pass (spec, Architecture): DataBankList gets no free pass
# on either just because NLM structured it. Registry tier is a lookup (catalog.py already tags it);
# deposit-vs-use reuses scan2's own fetch + context-window regexes verbatim, so both sources are
# judged by the same rule.
def _classify_row(r):
    name = r['databank'] if isinstance(r['databank'], str) else None
    acc = r['accession'] if isinstance(r['accession'], str) else None
    return pd.Series(catalog.classify(name=name, accession=acc))
cls = dep.apply(_classify_row, axis=1)
dep['canonical'], dep['tier'] = cls['canonical'], cls['tier']

_fulltext_cache = {}  # pmcid -> raw xml bytes; benign race across threads, worst case a few dup fetches
def context_for(row):
    if row['tier'] == 'REGISTRY':
        return 'excluded'  # excluded on tier alone, no need to fetch full text
        # ponytail: was 'n/a' — pandas' read_csv treats that string as a missing-value token
        # and silently turns it back into NaN on the next load. 'excluded' isn't in that list.
    pmcid = pmcid_of.get(row['pmid'])
    val = row['accession'] if isinstance(row['accession'], str) else row['databank']
    if not pmcid or not isinstance(val, str):
        return 'unclear'  # nothing to check against; not auto-dropped, just not auto-shippable
    if pmcid not in _fulltext_cache:
        _fulltext_cache[pmcid] = scan2.ft(pmcid)
    xml = _fulltext_cache[pmcid]
    if not xml:
        return 'unclear'
    try:
        full = "".join(ET.fromstring(xml).itertext())
    except ET.ParseError:
        return 'unclear'
    idx = full.lower().find(val.lower())
    if idx < 0:
        return 'unclear'
    w = full[max(0, idx - 160): idx + len(val) + 160]
    d, u = bool(scan2.DEP.search(w)), bool(scan2.USE.search(w))
    return 'deposit' if d and not u else 'use' if u and not d else 'unclear'

with ThreadPoolExecutor(max_workers=8) as ex:
    dep['context'] = list(ex.map(context_for, [r for _, r in dep.iterrows()]))

dep.to_csv(f"{OUT}/deposits_databank.csv", index=False)
cov.to_csv(f"{OUT}/coverage.csv", index=False)

eligible = dep[(dep['tier'] != 'REGISTRY') & (dep['context'] != 'use')]
print(f"\n=== registry/use exclusion ===")
print(f"raw databank rows: {len(dep)}  registry-tier (excluded): {(dep['tier']=='REGISTRY').sum()}  "
      f"use-context (excluded): {(dep['context']=='use').sum()}  eligible: {len(eligible)}")

print("\n=== DataBank name -> #pubs, #accessions (eligible only) ===", flush=True)
if len(eligible):
    g = eligible.groupby("databank").agg(pubs=("pmid", "nunique"), accessions=("accession", "count")).sort_values("pubs", ascending=False)
    print(g.to_string())
print(f"\nPubs with >=1 databank: {cov['has_databank'].sum()} / {len(cov)}", flush=True)
print(f"Pubs in PMC (full text available): {cov['pmcid'].notna().sum()} / {len(cov)}", flush=True)
print(f"Pubs in PMC but NO databank metadata (full-text-pass candidates): "
      f"{((cov['pmcid'].notna()) & (cov['has_databank']==0)).sum()}", flush=True)
