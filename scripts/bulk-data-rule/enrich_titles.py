"""Backfills title/description/creators/publisher (DataCite DOI repos) and
trial_phase/trial_status/trial_conditions (ClinicalTrials.gov) on
reciterdb.dataset_deposit, branching on accession_or_doi shape. Standalone and
additive -- does not touch attribute.py/scan2.py/datacite.py/catalog.py or the
CSV pipeline. Reads/writes dataset_deposit directly by its natural key
(repository, accession_or_doi): SELECT DISTINCT over that pair, never a
per-row loop -- the table's grain is (cwid, repository, accession_or_doi,
pmid), so a naive per-row loop would refetch/rewrite the same dataset up to N
times for N co-authors/citing pmids. Re-runnable by construction
(WHERE title IS NULL picks up only what's still missing).

Requires Phase A's ReCiterDB migration (the 7 new columns below) to have
landed first -- see 2026-08-11-dataset-title-enrichment-plan.md.

ponytail: two live-API branches + one free-lookup join against an
already-live table, plain pymysql + urllib, no retry framework, no ORM --
same conventions as the rest of this directory."""
import json, os, re, time, urllib.error, urllib.request
import pymysql

NCT_RE = re.compile(r"^NCT\d")  # ClinicalTrials.gov accession shape -- catalog.py's own regex
DOI_RE = re.compile(r"^10\.\d{4,9}/")  # DataCite-registered DOI shape

CTGOV_API = "https://clinicaltrials.gov/api/v2/studies/{}?fields=BriefTitle,OverallStatus,Condition,Phase"
DATACITE_API = "https://api.datacite.org/dois/{}"

SLEEP = 0.4  # conservative per-call throttle; mirrors attribute.py's efetch pacing (0.12-0.34s)

COLUMNS = ["title", "description", "creators", "publisher", "trial_phase", "trial_status", "trial_conditions"]


def _clean_doi(doi):
    # Mirrors datacite.py's resource_type() DOI-clean step exactly (strip/lower,
    # drop "https://doi.org/" and "doi:" prefixes). Duplicated rather than
    # imported: that step is inlined inside resource_type() there, and this
    # script's scope explicitly excludes touching datacite.py to pull it out.
    return doi.strip().lower().removeprefix("https://doi.org/").removeprefix("doi:")


def _get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "wcm-sps-enrich-titles"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def split_conditions(raw):
    """clinical_trials_enriched.conditions is a free-text `; `-joined string
    (TEXT column, not JSON -- see docs/clinical-trials-source-spec.md).
    Normalize to the same array shape CT.gov's own API returns, so
    trial_conditions is always a JSON array regardless of which of the two
    sources answered."""
    if not raw:
        return None
    parts = [c.strip() for c in raw.split(";") if c.strip()]
    return parts or None


def extract_creator_names(creators):
    """DataCite's creators is an array of objects (name/nameType/givenName/
    familyName/affiliation/nameIdentifiers) -- keep just the name strings, a
    string[], per the plan (nothing downstream needs affiliation/identifiers;
    storing the full objects would just be unused JSON weight)."""
    return [c["name"] for c in creators if c.get("name")]


def parse_ctgov(data):
    """Pure: map a CT.gov v2 `studies/{nctId}?fields=...` payload (confirmed
    live shape: {protocolSection: {identificationModule, statusModule,
    conditionsModule, designModule}}) to our column dict."""
    proto = (data or {}).get("protocolSection") or {}
    phases = proto.get("designModule", {}).get("phases") or []
    return {
        "title": proto.get("identificationModule", {}).get("briefTitle"),
        "trial_status": proto.get("statusModule", {}).get("overallStatus"),
        "trial_conditions": proto.get("conditionsModule", {}).get("conditions") or None,
        "trial_phase": phases[0] if phases else None,
    }


def parse_datacite(data):
    """Pure: map a DataCite `dois/{doi}` payload (data.attributes.{titles,
    descriptions, publisher, creators}) to our column dict."""
    attrs = ((data or {}).get("data") or {}).get("attributes") or {}
    titles = attrs.get("titles") or []
    descriptions = attrs.get("descriptions") or []
    creators = attrs.get("creators") or []
    return {
        "title": titles[0].get("title") if titles else None,
        "description": descriptions[0].get("description") if descriptions else None,
        "publisher": attrs.get("publisher"),
        "creators": extract_creator_names(creators) or None,
    }


def fetch_ctgov(nct):
    try:
        data = _get_json(CTGOV_API.format(nct))
    except (urllib.error.URLError, json.JSONDecodeError):
        return None
    return parse_ctgov(data)


def fetch_datacite(doi):
    try:
        data = _get_json(DATACITE_API.format(_clean_doi(doi)))
    except (urllib.error.URLError, json.JSONDecodeError):
        return None
    return parse_datacite(data)


def lookup_clinical_trials_enriched(cur, nct):
    """Free lookup against the already-live reciterdb.clinical_trials_enriched
    (built for the unrelated institutional Clinical Trials feature) -- same DB
    instance, no cross-service call. Covers ~20% of NCT accessions today."""
    cur.execute(
        "SELECT briefTitle, phases, overallStatus, conditions FROM clinical_trials_enriched WHERE nctNumber = %s",
        (nct,),
    )
    row = cur.fetchone()
    if not row:
        return None
    briefTitle, phases, overallStatus, conditions = row
    return {
        "title": briefTitle,
        "trial_phase": phases,
        "trial_status": overallStatus,
        "trial_conditions": split_conditions(conditions),
    }


def to_row(fields):
    """Map a lookup dict (any subset of COLUMNS) to the full 7-tuple the
    UPDATE needs, JSON-encoding the two array fields, None for anything
    absent."""
    out = []
    for col in COLUMNS:
        v = fields.get(col)
        if col in ("creators", "trial_conditions") and v is not None:
            v = json.dumps(v)
        out.append(v)
    return tuple(out)


def main():
    conn = pymysql.connect(
        host=os.environ["DB_HOST"],
        user=os.environ["DB_USERNAME"],
        password=os.environ["DB_PASSWORD"],
        database=os.environ["DB_NAME"],
    )
    cur = conn.cursor()
    cur.execute("SELECT DISTINCT repository, accession_or_doi FROM dataset_deposit WHERE title IS NULL")
    pairs = cur.fetchall()
    print(f"{len(pairs)} distinct (repository, accession_or_doi) pairs missing a title", flush=True)

    updated = skipped = ctgov_calls = datacite_calls = free_lookups = 0
    for i, (repository, accession) in enumerate(pairs):
        fields = None
        if NCT_RE.match(accession):
            fields = lookup_clinical_trials_enriched(cur, accession)
            if fields is not None:
                free_lookups += 1
            else:
                fields = fetch_ctgov(accession)
                ctgov_calls += 1
                time.sleep(SLEEP)
        elif DOI_RE.match(accession):
            fields = fetch_datacite(accession)
            datacite_calls += 1
            time.sleep(SLEEP)
        else:
            skipped += 1
            continue  # no per-record title source for this repo (plan's "Not in this plan")

        if not fields or not fields.get("title"):
            skipped += 1
            continue

        cur.execute(
            """UPDATE dataset_deposit SET title=%s, description=%s, creators=%s,
               publisher=%s, trial_phase=%s, trial_status=%s, trial_conditions=%s
               WHERE repository=%s AND accession_or_doi=%s""",
            to_row(fields) + (repository, accession),
        )
        updated += 1
        if (i + 1) % 50 == 0:
            conn.commit()
            print(f"  {i + 1}/{len(pairs)}", flush=True)

    conn.commit()
    conn.close()
    print(f"\nupdated {updated}, skipped {skipped} (no source or lookup miss)")
    print(
        f"live calls: {ctgov_calls} CT.gov, {datacite_calls} DataCite "
        f"({free_lookups} NCT titles came free from clinical_trials_enriched)"
    )


def _self_check():
    # Pure-logic only -- no live network/DB calls, matching datacite.py/
    # catalog.py's own self-check style of fixed sample inputs.
    assert bool(NCT_RE.match("NCT03815682"))
    assert not bool(NCT_RE.match("10.5281/zenodo.1211768"))
    assert bool(DOI_RE.match("10.5281/zenodo.1211768"))
    assert not bool(DOI_RE.match("NCT03815682"))
    assert not bool(DOI_RE.match("GSE12345"))  # accession-only repo, no per-record title source

    assert _clean_doi("HTTPS://DOI.ORG/10.5281/Zenodo.1211768") == "10.5281/zenodo.1211768"
    assert _clean_doi("doi:10.5281/ZENODO.1211768") == "10.5281/zenodo.1211768"
    assert _clean_doi("10.5281/zenodo.1211768") == "10.5281/zenodo.1211768"

    assert split_conditions("Solid Tumor; Lymphoma") == ["Solid Tumor", "Lymphoma"]
    assert split_conditions(None) is None
    assert split_conditions("") is None

    assert extract_creator_names(
        [
            {
                "name": "Nakhavali, Mahdi",
                "nameType": "Personal",
                "givenName": "Mahdi",
                "familyName": "Nakhavali",
                "affiliation": [],
                "nameIdentifiers": [],
            }
        ]
    ) == ["Nakhavali, Mahdi"]
    assert extract_creator_names([]) == []

    # Fixed sample mirroring the live-confirmed CT.gov v2 shape (NCT03815682).
    sample_ctgov = {
        "protocolSection": {
            "identificationModule": {
                "nctId": "NCT03815682",
                "briefTitle": "RPTR-147 in Patients With Selected Solid Tumors and Lymphomas",
            },
            "statusModule": {"overallStatus": "TERMINATED"},
            "conditionsModule": {"conditions": ["Solid Tumor", "Lymphoma"]},
            "designModule": {"phases": ["PHASE1"]},
        }
    }
    parsed = parse_ctgov(sample_ctgov)
    assert parsed["title"] == "RPTR-147 in Patients With Selected Solid Tumors and Lymphomas"
    assert parsed["trial_phase"] == "PHASE1"
    assert parsed["trial_status"] == "TERMINATED"
    assert parsed["trial_conditions"] == ["Solid Tumor", "Lymphoma"]
    assert parse_ctgov({"protocolSection": {}})["title"] is None
    assert parse_ctgov({})["trial_phase"] is None

    # Fixed sample mirroring the live-confirmed DataCite shape (10.5281/zenodo.1211768).
    sample_datacite = {
        "data": {
            "attributes": {
                "titles": [{"title": "A global distribution of dissolved organic carbon"}],
                "descriptions": [{"description": "Current global carbon models...", "descriptionType": "Abstract"}],
                "publisher": "Zenodo",
                "creators": [{"name": "Nakhavali, Mahdi", "nameType": "Personal"}],
            }
        }
    }
    parsed = parse_datacite(sample_datacite)
    assert parsed["title"] == "A global distribution of dissolved organic carbon"
    assert parsed["description"] == "Current global carbon models..."
    assert parsed["publisher"] == "Zenodo"
    assert parsed["creators"] == ["Nakhavali, Mahdi"]
    assert parse_datacite({"data": {"attributes": {}}})["creators"] is None
    assert parse_datacite({})["title"] is None

    row = to_row(parse_ctgov(sample_ctgov))
    assert row[0] == "RPTR-147 in Patients With Selected Solid Tumors and Lymphomas"
    assert row[4] == "PHASE1"
    assert row[5] == "TERMINATED"
    assert json.loads(row[6]) == ["Solid Tumor", "Lymphoma"]

    print("enrich_titles self-check OK")


if __name__ == "__main__":
    _self_check()
    main()
