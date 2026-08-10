"""Robust deposition scan v2: distinctive accessions + repo URL domains + word-bounded names,
gated by Data-Availability-section membership and deposit-vs-use context. Fixes v1 substring false positives
(liproxstatin!=iProX, CNGB3!=CNGB, journal-code!=cncb) and adds non-omic sensitive repos.
ponytail: window context (+-160 chars) instead of a fragile sentence splitter on messy JATS text."""
import os, re, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
import pandas as pd
import catalog

OUT = os.path.dirname(os.path.abspath(__file__)); API=os.environ.get("PUBMED_API_KEY","")
CANON = {rec[0]: dict(zip(["canonical","org","country","access","bucket","tier","note"],
                         (rec[0],rec[3],rec[4],rec[5],rec[6],rec[7],rec[8]))) for rec in catalog.R}

def rx(l): return [re.compile(p, re.I) for p in l]
# canonical: (accession patterns, url patterns, word-bounded name patterns)
SIG = {
 "GSA-Human":        (rx([r"\bHRA\d{6}\b"]), rx([r"ngdc\.cncb\.ac\.cn/gsa-human", r"bigd\.big\.ac\.cn/gsa-human"]), rx([r"\bgsa[- ]human\b", r"genome sequence archive for human"])),
 "GSA":              (rx([r"\bCRA\d{5,}\b"]), rx([r"ngdc\.cncb\.ac\.cn/gsa\b", r"bigd\.big\.ac\.cn/gsa\b"]), rx([r"\bgenome sequence archive\b"])),
 "NGDC/CNCB (other)":(rx([r"\bOMIX\d+\b", r"\bGWH[A-Z]{5}\d+\b"]), rx([r"ngdc\.cncb\.ac\.cn", r"bigd\.big\.ac\.cn"]), rx([r"national omics data encyclopedia", r"national genomics data center", r"china national center for bioinformation"])),
 "iProX":            (rx([r"\bIPX\d{7,}\b"]), rx([r"\biprox\.cn\b", r"iprox\.org"]), rx([r"\biprox\b"])),
 "CNGB/CNSA":        (rx([r"\bCNP\d{6,}\b"]), rx([r"db\.cngb\.org", r"\bcngb\.org\b"]), rx([r"china national genebank", r"\bcnsa\b"])),

 "GEO":              (rx([r"\bGSE\d{3,}\b"]), rx([r"ncbi\.nlm\.nih\.gov/geo", r"/geo/query"]), rx([r"gene expression omnibus"])),
 "SRA":              (rx([r"\bSR[PRXS]\d{5,}\b", r"\bPRJNA\d{4,}\b"]), rx([r"ncbi\.nlm\.nih\.gov/sra"]), rx([r"sequence read archive"])),
 "dbGaP":            (rx([r"\bphs\d{6}\b"]), rx([r"ncbi\.nlm\.nih\.gov/(gap|projects/gap)", r"\bdbgap\b"]), rx([r"\bdbgap\b", r"database of genotypes and phenotypes"])),
 "EGA":              (rx([r"\bEGA[SD]\d{6,}\b"]), rx([r"ega-archive\.org", r"ebi\.ac\.uk/ega"]), rx([r"european genome[- ]phenome archive"])),
 "ProteomeXchange":  (rx([r"\bPXD\d{6}\b"]), rx([r"proteomecentral", r"proteomexchange"]), rx([r"proteomexchange"])),
 "PRIDE":            ([], rx([r"ebi\.ac\.uk/pride"]), rx([r"\bpride\b\s*(database|archive|repositor|partner)"])),
 "MassIVE":          (rx([r"\bMSV\d{6,}\b"]), rx([r"massive\.ucsd\.edu"]), rx([r"\bmassive\b\s*(repositor|proteom|ucsd|database)"])),
 "MetaboLights":     (rx([r"\bMTBLS\d+\b"]), rx([r"ebi\.ac\.uk/metabolights"]), rx([r"metabolights"])),
 "Metabolomics Workbench":(rx([r"\bST\d{6}\b"]), rx([r"metabolomicsworkbench"]), rx([r"metabolomics workbench"])),
 "ArrayExpress/BioStudies":(rx([r"\bE-[A-Z]{4}-\d+\b", r"\bS-[A-Z]{4}\d+\b"]), rx([r"ebi\.ac\.uk/(arrayexpress|biostudies)"]), rx([r"arrayexpress"])),
 "ENA":              (rx([r"\bPRJEB\d+\b", r"\bER[RPSX]\d{5,}\b"]), rx([r"ebi\.ac\.uk/ena"]), rx([r"european nucleotide archive"])),

 "Zenodo":           ([], rx([r"zenodo\.org", r"10\.5281/zenodo"]), rx([r"\bzenodo\b"])),
 "figshare":         ([], rx([r"figshare\.com", r"10\.6084/m9\.figshare"]), rx([r"\bfigshare\b"])),
 "Dryad":            ([], rx([r"datadryad\.org", r"10\.5061/dryad"]), rx([r"\bdryad\b"])),
 "OSF":              ([], rx([r"osf\.io"]), rx([r"open science framework"])),
 "Mendeley Data":    ([], rx([r"data\.mendeley\.com"]), rx([r"mendeley data"])),
 "Harvard Dataverse":([], rx([r"dataverse\.harvard"]), rx([r"harvard dataverse"])),

 "OpenNeuro":        (rx([r"\bds\d{6}\b"]), rx([r"openneuro\.org"]), rx([r"openneuro"])),
 "NDA (NIMH Data Archive)":([], rx([r"nda\.nih\.gov"]), rx([r"nimh data archive", r"national database for autism"])),
 "TCIA":             ([], rx([r"cancerimagingarchive\.net"]), rx([r"cancer imaging archive"])),
 "IDR (Image Data Resource)":([], rx([r"idr\.openmicroscopy"]), rx([r"image data resource"])),
 "Vivli":            ([], rx([r"vivli\.org"]), rx([r"\bvivli\b"])),
 "BioLINCC":         ([], rx([r"biolincc\.nhlbi"]), rx([r"biolincc"])),
 "PhysioNet":        ([], rx([r"physionet\.org"]), rx([r"physionet"])),
 "ImmPort":          ([], rx([r"immport\.org"]), rx([r"\bimmport\b"])),
 "Synapse":          (rx([r"\bsyn\d{7,}\b"]), rx([r"synapse\.org"]), rx([r"sage bionetworks"])),
 "ClinicalTrials.gov":(rx([r"\bNCT\d{8}\b"]), rx([r"clinicaltrials\.gov"]), rx([r"clinicaltrials\.gov"])),
}
DEP = re.compile(r"deposit|submitted to|were made available|are available (in|at|from|through|via|under)|uploaded|accession|archived in|stored in|can be found (in|at)|have been deposited|available for download", re.I)
USE = re.compile(r"download|obtained from|retrieved from|acquired from|we (used|obtained|retrieved|downloaded)|collected from|sourced from|accessed (from|via|on|at)|were obtained", re.I)

EFETCH="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
def ft(pmcid):
    pid=pmcid if pmcid.upper().startswith("PMC") else "PMC"+pmcid
    try:
        return urllib.request.urlopen(urllib.request.Request(f"https://www.ebi.ac.uk/europepmc/webservices/rest/{pid}/fullTextXML",headers={"User-Agent":"x"}),timeout=60).read()
    except Exception: pass
    d={"db":"pmc","id":re.sub(r"\D","",pid),"rettype":"xml"};  d.update({"api_key":API} if API else {})
    try: return urllib.request.urlopen(urllib.request.Request(EFETCH,data=urllib.parse.urlencode(d).encode()),timeout=60).read()
    except Exception: return None
def das_text(root):
    out=[]
    for sec in root.iter():
        st=(sec.get("sec-type") or sec.get("notes-type") or "").lower()
        title=(sec.findtext("title") or "").lower() if sec.tag.lower() in ("sec","notes") else ""
        if "data-availability" in st or "data availability" in title or "data sharing" in title or "availability of data" in title or "code availability" in title:
            out.append("".join(sec.itertext()))
    return " ".join(out)

def scan(row):
    xml=ft(row['pmcid'])
    if not xml: return (row['pmid'],row['year'],row['pmcid'],0,0,[])
    try: root=ET.fromstring(xml)
    except Exception: return (row['pmid'],row['year'],row['pmcid'],1,0,[])
    full="".join(root.itertext()); das=das_text(root); haddas=int(bool(das.strip()))
    hits=[]
    for canon,(accs,urls,names) in SIG.items():
        best=None
        for kind,pats in (("acc",accs),("url",urls),("name",names)):
            for p in pats:
                for m in p.finditer(full):
                    val=m.group(); w=full[max(0,m.start()-160):m.end()+160].lower()
                    in_das = 1 if (das and val.lower() in das.lower()) else 0
                    dep=bool(DEP.search(w)); use=bool(USE.search(w))
                    ctx = "deposit" if (dep and not use) or in_das else "use" if (use and not dep) else "unclear"
                    if kind in ("acc","url"): conf="high"
                    else: conf="high" if in_das else "low"
                    cand=(kind,val,in_das,ctx,conf)
                    rank={"high":2,"low":0}.get(conf,1)+ (1 if ctx=="deposit" else 0)
                    if best is None or rank>best[0]: best=(rank,cand)
                    break  # one match per pattern is enough
        if best: hits.append((canon,)+best[1])
    return (row['pmid'],row['year'],row['pmcid'],1,haddas,hits)

def scan_corpus(cov, out_dep, out_status):
    """Scan a corpus dataframe (cols pmid,year,pmcid). Reusable for academic + preprint runs."""
    rows=list(cov.to_dict("records")); dep=[]; status=[]; done=0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for f in as_completed([ex.submit(scan,r) for r in rows]):
            pmid,yr,pmcid,ftok,haddas,hits=f.result()
            for canon,kind,val,in_das,ctx,conf in hits:
                c=CANON.get(canon,{"canonical":canon,"country":"?","access":"?","bucket":"?","tier":"UNKNOWN"})
                dep.append((pmid,yr,pmcid,canon,c["tier"],c["country"],c["access"],c["bucket"],kind,val,in_das,ctx,conf))
            status.append((pmid,yr,pmcid,ftok,haddas,int(bool(hits))))
            done+=1
            if done%1000==0: print(f"  {done}/{len(rows)}", flush=True)
    d=pd.DataFrame(dep,columns=["pmid","year","pmcid","repo","tier","country","access","bucket","kind","matched_val","in_das","context","confidence"])
    s=pd.DataFrame(status,columns=["pmid","year","pmcid","has_fulltext","has_das","has_hit"])
    d.to_csv(out_dep,index=False); s.to_csv(out_status,index=False)
    return d,s

if __name__=="__main__":
    cov = pd.read_csv(f"{OUT}/coverage.csv"); cov=cov[(cov['year']>=2020)&(cov['pmcid'].notna())].copy(); cov['pmcid']=cov['pmcid'].astype(str)
    print(f"scanning {len(cov)} pubs (v2)", flush=True)
    d,s=scan_corpus(cov, f"{OUT}/deposits_v2.csv", f"{OUT}/status_v2.csv")
    dep_ok = d[(d['context']!='use') & (d['confidence']=='high')]
    print(f"\nfull-text={s['has_fulltext'].sum()}/{len(s)}  DAS={s['has_das'].sum()}")
    print(f"raw repo matches={len(d)}  counted deposits (high-conf, not-use)={len(dep_ok)}  pubs={dep_ok['pmid'].nunique()}")
    print(dep_ok.groupby(["repo","tier","country"])['pmid'].nunique().sort_values(ascending=False).to_string())
