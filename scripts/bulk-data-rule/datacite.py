"""DataCite resourceType lookup for DOI repositories (Zenodo/figshare/OSF/Dryad/Mendeley/Dataverse).
Typing, not filtering (S-Index spec, Data sources): every DOI gets classified and stored; the
Dataset-only cut is a query filter applied downstream at display/metric time, not here.
ponytail: one public REST call, one dict lookup. No client library, no retry framework."""
import json, urllib.error, urllib.request

API = "https://api.datacite.org/dois/{}"

# Software is a reliable exclude (Zenodo's GitHub-release integration stamps it consistently).
# Dataset/Collection are the reliable includes. Everything else (Other, Text, OSF's often-inconsistent
# project-level DOIs, ...) is unmeasured — Phase 0's ground-truth sample decides those, not this list
# (see spec, Data sources).
INCLUDE = {"Dataset", "Collection"}
EXCLUDE = {"Software"}

def resource_type(doi):
    """Look up one DOI. Returns (resourceTypeGeneral or None, bucket), bucket in
    'dataset'|'software'|'residual'|'unknown' (unknown = lookup failed, not a type judgment)."""
    doi = doi.strip().lower().removeprefix("https://doi.org/").removeprefix("doi:")
    try:
        with urllib.request.urlopen(API.format(doi), timeout=20) as r:
            rt = json.load(r)["data"]["attributes"]["types"].get("resourceTypeGeneral")
    except (urllib.error.URLError, KeyError, json.JSONDecodeError):
        return None, "unknown"
    if rt in INCLUDE:
        return rt, "dataset"
    if rt in EXCLUDE:
        return rt, "software"
    return rt, "residual"

if __name__ == "__main__":
    assert resource_type("10.5281/zenodo.3509134") == ("Software", "software")   # pandas source-code release
    assert resource_type("10.5281/zenodo.1211768") == ("Dataset", "dataset")     # soil/leaching DOC dataset
    assert resource_type("10.0000/not-a-real-doi-xyz")[1] == "unknown"
    print("datacite self-check OK")
