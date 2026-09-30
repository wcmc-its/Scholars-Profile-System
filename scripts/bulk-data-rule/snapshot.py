"""Freeze a live reciterdb query so a pipeline rerun reads the same input instead of drifting.
reciterdb is a live, growing corpus, and analysis_summary_author.authorPosition /
identity.fullTimeFaculty are mutable - so re-querying live on every run silently changes which
cwid a deposit attributes to, and dataset_deposit accumulates instead of converging (see the
2026-08-14 containerization design doc). Manual clear = delete the CSV, or set SNAPSHOT_REFRESH=1
to force a fresh pull (e.g. deliberately picking up corpus growth).
ponytail: one function, a CSV on disk, no expiry - this pipeline is manually triggered, not
scheduled, so "stale until someone asks for fresh" is the right default, not a TTL.
"""
import os
import pandas as pd
from sqlalchemy import text


def snapshot_query(engine, query, path, params=None):
    """Read `path` if it exists (unless SNAPSHOT_REFRESH is set); else run `query` and cache the
    result there. `path` should be scope-specific if the caller's scope (e.g. PILOT_DEPARTMENT)
    can vary - this pipeline's other intermediate CSVs are already single-filename/scope-blind
    (operator's job to know they switched scope), so this matches that existing convention."""
    if os.path.exists(path) and not os.environ.get("SNAPSHOT_REFRESH"):
        print(f"  snapshot: reusing {path}", flush=True)
        return pd.read_csv(path)
    with engine.connect() as conn:
        df = pd.read_sql(text(query), conn, params=params or {})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    df.to_csv(path, index=False)
    print(f"  snapshot: wrote {path} ({len(df)} rows)", flush=True)
    return df


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "x.csv")
        pd.DataFrame({"a": [1, 2, 3]}).to_csv(path, index=False)
        # cache-hit path: file exists, SNAPSHOT_REFRESH unset -> must read the CSV back, not query
        got = snapshot_query(None, "SELECT 1", path)
        assert list(got["a"]) == [1, 2, 3], "cache-hit path should read the CSV back untouched"
        # SNAPSHOT_REFRESH forces the live-query path even with a cache file present
        os.environ["SNAPSHOT_REFRESH"] = "1"
        raised = False
        try:
            snapshot_query(None, "SELECT 1", path)
        except AttributeError:
            raised = True  # expected: None has no .connect() - proves it took the live-query path
        finally:
            del os.environ["SNAPSHOT_REFRESH"]
        assert raised, "SNAPSHOT_REFRESH should force the live-query path, not the cache"
    print("snapshot.py self-check OK")
