#!/usr/bin/env python3
"""Analyze the crawled Grad School faculty bios for STRUCTURE and VOICE issues,
and join to the Scholars DB to size the net-new overview gap they could fill.

Input : /tmp/gradschool-crawl/faculty.jsonl  (from gradschool-crawl.py)
Output: prints a full report; writes a metadata CSV (no full bio text) to
        /tmp/gradschool-crawl/bio-metadata.csv for spot-checking.

Read-only. The DB join runs SELECTs only (host MariaDB socket).
"""
import csv, json, re, subprocess
from pathlib import Path

JSONL = Path("/tmp/gradschool-crawl/faculty.jsonl")
META = Path("/tmp/gradschool-crawl/bio-metadata.csv")
SOCK = "/tmp/mysql.sock"

FIRST_SING = re.compile(r"\b(I|I'm|I've|I'll|my|myself|mine)\b")
FIRST_PLUR = re.compile(r"\b(we|our|ours|us)\b", re.I)
THIRD_PRON = re.compile(r"\b(he|she|they|his|her|hers|their|theirs|him|them)\b", re.I)
LAB_FRAME = re.compile(r"\b(lab|laboratory|our group|the group|our team)\b", re.I)
DR_TITLE = re.compile(r"\b(Dr\.|Professor|Prof\.)\b")


def load():
    recs = []
    for line in JSONL.read_text().splitlines():
        line = line.strip()
        if line:
            recs.append(json.loads(line))
    return recs


def voice_class(bio, surname):
    """Heuristic voice classification of a bio paragraph."""
    if not bio:
        return "no_bio"
    fs = len(FIRST_SING.findall(bio))
    fp = len(FIRST_PLUR.findall(bio))
    tp = len(THIRD_PRON.findall(bio))
    lab = bool(LAB_FRAME.search(bio))
    dr = bool(DR_TITLE.search(bio))
    surname_lab = bool(surname and re.search(rf"\b{re.escape(surname)}\b.{{0,15}}\blab", bio, re.I))
    head = " ".join(bio.split()[:6]).lower()
    if fs >= 2 or head.startswith("i ") or head.startswith("my "):
        return "first_singular"
    if (lab or surname_lab) and fs == 0:
        # "The X lab studies…" / "<Surname> lab" — lab-centric third person
        if fp >= 2 and not (dr or tp):
            return "first_plural_lab"   # "we/our" lab voice
        return "third_lab"
    if dr or tp >= 1:
        return "third_named"
    if fp >= 2:
        return "first_plural"
    return "ambiguous"


def starts_with(bio, name):
    if not bio:
        return "no_bio"
    head = " ".join(bio.split()[:8])
    low = head.lower()
    first = (name or "").split()[0].lower() if name else ""
    last = (name or "").split()[-1].lower() if name else ""
    if re.match(r"(?i)^the\b.{0,40}\blab", head) or re.match(r"(?i)^\w+\s+lab\b", head):
        return "the_lab"
    if low.startswith("dr.") or low.startswith("professor") or low.startswith("prof."):
        return "title"
    if first and (low.startswith(first) or (last and low.startswith(last))):
        return "name"
    if re.match(r"(?i)^(my|our|the)?\s*research\b", head) or "research" in low.split()[:3]:
        return "research"
    if low.startswith("i ") or low.startswith("i'"):
        return "first_person"
    return "other"


def struct(rec):
    h = rec.get("bio_html") or ""
    empty_p = len(re.findall(r"<p>\s*</p>", h)) + len(re.findall(r"<p>(?:\s|&nbsp;|<br\s*/?>)*</p>", h))
    total_p = h.count("<p>") + h.count("<p ")
    return {
        "empty_p": empty_p,
        "real_p": max(total_p - empty_p, 0),
        "img": h.count("<img"),
        "links": h.count("<a "),
        "lists": h.count("<ul") + h.count("<ol"),
        "list_items": h.count("<li"),
        "spans": h.count("<span"),
        "headings": sum(h.count(f"<h{n}") for n in range(2, 7)),
        "caption_wrap": int("caption" in h or "panopoly" in h),
        "html_len": len(h),
    }


def db_join(cwids):
    cwids = sorted({c for c in cwids if c})
    if not cwids:
        return {}
    inlist = ",".join("'" + c.replace("'", "") + "'" for c in cwids)
    sql = (
        "SELECT cwid, COALESCE(role_category,''), "
        "CASE WHEN overview IS NOT NULL AND TRIM(overview)<>'' THEN 1 ELSE 0 END, "
        "CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END "
        f"FROM scholar WHERE cwid IN ({inlist});"
    )
    out = subprocess.run(
        ["mysql", "--no-defaults", f"--socket={SOCK}", "-u", "paulalbert", "scholars", "-N", "-B", "-e", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        print("DB JOIN ERROR:", out.stderr[:300])
        return {}
    d = {}
    for line in out.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) == 4:
            d[parts[0]] = {"role": parts[1], "has_ov": parts[2] == "1", "active": parts[3] == "1"}
    return d


def pct(n, d):
    return f"{(100.0*n/d):.1f}%" if d else "n/a"


def bar(title):
    print("\n" + "=" * 4, title, "=" * 4)


def main():
    recs = load()
    n = len(recs)
    with_bio = [r for r in recs if r.get("bio")]
    with_cwid = [r for r in recs if r.get("cwid")]
    print(f"crawled faculty profiles: {n}")
    print(f"  with a bio:  {len(with_bio)} ({pct(len(with_bio), n)})")
    print(f"  with a cwid: {len(with_cwid)} ({pct(len(with_cwid), n)})")
    print(f"  no bio:      {n - len(with_bio)}")

    # ---- word-count distribution ----
    bar("BIO LENGTH (words)")
    words = sorted(r["bio_words"] for r in with_bio)
    if words:
        import statistics as st
        print(f"  min={words[0]} median={int(st.median(words))} mean={int(st.mean(words))} max={words[-1]}")
        buckets = [("<50", 0, 50), ("50-99", 50, 100), ("100-199", 100, 200),
                   ("200-349", 200, 350), ("350+", 350, 10**9)]
        for lbl, lo, hi in buckets:
            c = sum(1 for w in words if lo <= w < hi)
            print(f"    {lbl:8} {c:4}  {pct(c, len(words))}")

    # ---- voice ----
    bar("VOICE")
    vc = {}
    sw = {}
    for r in with_bio:
        sn = (r.get("name") or "").split()[-1] if r.get("name") else ""
        v = voice_class(r["bio"], sn)
        r["_voice"] = v
        vc[v] = vc.get(v, 0) + 1
        s = starts_with(r["bio"], r.get("name"))
        r["_starts"] = s
        sw[s] = sw.get(s, 0) + 1
    for k, c in sorted(vc.items(), key=lambda x: -x[1]):
        print(f"  voice {k:16} {c:4}  {pct(c, len(with_bio))}")
    print("  --- opening pattern ---")
    for k, c in sorted(sw.items(), key=lambda x: -x[1]):
        print(f"  starts {k:14} {c:4}  {pct(c, len(with_bio))}")

    # ---- structure ----
    bar("STRUCTURE (from bio HTML)")
    agg = {}
    issues = {"has_empty_p": 0, "has_img": 0, "has_links": 0, "has_lists": 0,
              "has_headings": 0, "has_caption": 0, "multi_real_p": 0, "single_p": 0}
    for r in with_bio:
        s = struct(r)
        r["_struct"] = s
        for k, v in s.items():
            agg[k] = agg.get(k, 0) + v
        issues["has_empty_p"] += s["empty_p"] > 0
        issues["has_img"] += s["img"] > 0
        issues["has_links"] += s["links"] > 0
        issues["has_lists"] += s["lists"] > 0
        issues["has_headings"] += s["headings"] > 0
        issues["has_caption"] += s["caption_wrap"] > 0
        issues["multi_real_p"] += s["real_p"] > 1
        issues["single_p"] += s["real_p"] <= 1
    nb = len(with_bio)
    print("  bios with…")
    for k, c in issues.items():
        print(f"    {k:16} {c:4}  {pct(c, nb)}")
    print("  totals across all bios:")
    for k in ("empty_p", "img", "links", "lists", "headings"):
        print(f"    total {k:10} {agg.get(k,0)}")

    # ---- DB join: net-new ----
    bar("DB JOIN — net-new overview gap")
    db = db_join([r.get("cwid") for r in with_cwid])
    mapped = [r for r in with_cwid if r["cwid"] in db]
    ft = [r for r in mapped if db[r["cwid"]]["role"] == "full_time_faculty"]
    ft_no_ov = [r for r in ft if not db[r["cwid"]]["has_ov"]]
    ft_no_ov_bio = [r for r in ft_no_ov if r.get("bio")]
    print(f"  crawled with cwid:                 {len(with_cwid)}")
    print(f"  cwid resolves to a scholar:        {len(mapped)} ({pct(len(mapped), len(with_cwid))})")
    print(f"  …that is full_time_faculty:        {len(ft)}")
    print(f"  …FT and LACKS an overview:         {len(ft_no_ov)}")
    print(f"  …AND has a Grad School bio (NET-NEW seed candidates): {len(ft_no_ov_bio)}")
    already = sum(1 for r in ft if db[r["cwid"]]["has_ov"])
    print(f"  (FT already covered — overlap w/ existing VIVO seed): {already}")

    # ---- metadata CSV (no full bio text) ----
    with META.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["cwid", "slug", "name", "title", "bio_words", "voice", "starts",
                    "empty_p", "real_p", "img", "links", "lists", "headings",
                    "db_role", "db_has_overview", "net_new"])
        for r in recs:
            c = r.get("cwid") or ""
            info = db.get(c, {})
            s = r.get("_struct", {})
            net_new = (info.get("role") == "full_time_faculty" and not info.get("has_ov", True) and bool(r.get("bio")))
            w.writerow([c, r.get("slug"), r.get("name"), r.get("title"), r.get("bio_words", 0),
                        r.get("_voice", ""), r.get("_starts", ""),
                        s.get("empty_p", ""), s.get("real_p", ""), s.get("img", ""),
                        s.get("links", ""), s.get("lists", ""), s.get("headings", ""),
                        info.get("role", ""), info.get("has_ov", ""), int(net_new)])
    print(f"\nwrote {META}")


if __name__ == "__main__":
    main()
