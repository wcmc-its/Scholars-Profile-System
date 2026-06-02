#!/usr/bin/env python3
"""Read-only crawl of the WCM Graduate School faculty site for overview-coverage scoping.

Pipeline steps 1-2 of docs/overview-coverage/gradschool-harvest-scope.md:
enumerate every /faculty/<slug> profile, fetch it, and parse name, title, bio,
research topics, programs, and the VIVO-embedded CWID.

Politeness: honors robots.txt Crawl-delay: 10 (10s between every request),
descriptive UA, IPv4-forced (sandbox IPv6 egress is broken), 30s timeout, one
retry. Resumable: re-running skips slugs already in the JSONL output.

  python3 gradschool-crawl.py            # full crawl -> /tmp/gradschool-crawl/faculty.jsonl
  python3 gradschool-crawl.py --test     # offline parser check on saved sample HTML

This writes NOTHING to the database and republishes nothing to git; raw output
lives in /tmp. Only the aggregate analysis is committed.
"""
import json, re, socket, sys, time, urllib.request
from html.parser import HTMLParser
from pathlib import Path

BASE = "https://gradschool.weill.cornell.edu"
OUT_DIR = Path("/tmp/gradschool-crawl")
OUT = OUT_DIR / "faculty.jsonl"
LOG = OUT_DIR / "crawl.log"
UA = "Mozilla/5.0 (compatible; WCM-Scholars-internal-audit/1.0; overview-coverage scoping)"
DELAY = 10           # robots.txt Crawl-delay (default; override per-run with --delay N)
TIMEOUT = 30
if "--delay" in sys.argv:
    DELAY = float(sys.argv[sys.argv.index("--delay") + 1])
VOID = {"br", "img", "hr", "input", "meta", "link", "source", "area", "base", "col", "wbr"}

# Force IPv4 — the sandbox cannot do outbound IPv6 and v6 attempts hang.
_orig_gai = socket.getaddrinfo
def _ipv4_only(host, *a, **k):
    return [r for r in _orig_gai(host, *a, **k) if r[0] == socket.AF_INET]
socket.getaddrinfo = _ipv4_only


class DivCapture(HTMLParser):
    """Capture the inner content of the FIRST <div> whose class list contains
    `token` as an exact class token (so `field-faculty-biography` matches the
    inner content div, not the outer `pane-node-field-faculty-biography` chrome
    or its `<h4>Bio</h4>` label). Tracks nesting depth (void tags excluded) so
    nested markup closes cleanly, and records plain text, a tag tally, and a
    near-raw inner-HTML reconstruction (entities decoded) for structure
    analysis downstream."""
    def __init__(self, token):
        super().__init__(convert_charrefs=True)
        self.token, self.depth, self.cap, self.done = token, 0, False, False
        self.out, self.html, self.tags = [], [], {}
    def _count(self, tag):
        self.tags[tag] = self.tags.get(tag, 0) + 1
    def handle_starttag(self, tag, attrs):
        if self.done:
            return
        if self.cap:
            self._count(tag)
            self.html.append(self.get_starttag_text() or f"<{tag}>")
            if tag not in VOID:
                self.depth += 1
            return
        if tag == "div" and self.token in (dict(attrs).get("class", "") or "").split():
            self.cap, self.depth = True, 0
    def handle_startendtag(self, tag, attrs):
        if self.cap:
            self._count(tag)
            self.html.append(self.get_starttag_text() or f"<{tag}/>")
    def handle_endtag(self, tag):
        if self.cap and tag not in VOID:
            if self.depth == 0:
                self.cap, self.done = False, True
            else:
                self.depth -= 1
                self.html.append(f"</{tag}>")
    def handle_data(self, data):
        if self.cap:
            self.out.append(data)
            self.html.append(data)
    @property
    def text(self):
        return re.sub(r"\s+", " ", "".join(self.out)).strip()
    @property
    def inner_html(self):
        return "".join(self.html).strip()


def cap(html, token):
    p = DivCapture(token)
    p.feed(html)
    return p.text


def cap_bio(html):
    """Return (plain_text, tag_counts, inner_html) for the biography content."""
    p = DivCapture("field-faculty-biography")
    p.feed(html)
    return p.text, p.tags, p.inner_html


def log(msg):
    line = f"[{int(time.time())}] {msg}"
    print(line, flush=True)
    with LOG.open("a") as f:
        f.write(line + "\n")


def fetch(url):
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - log + retry once
            log(f"  fetch error ({attempt}) {url}: {e}")
            if attempt == 1:
                time.sleep(DELAY)
    return None


SLUG_RE = re.compile(r'href="/faculty/([a-z0-9][a-z0-9-]+)"')   # excludes single-letter A-Z nav
PAGE_RE = re.compile(r"[?&]page=(\d+)")
CWID_RE = re.compile(r"cwid-([a-z0-9]+)", re.I)
NAME_RE = re.compile(r'<h1 class="title">\s*([^<]+)')


def parse_profile(html, slug):
    cwids = CWID_RE.findall(html)
    name = NAME_RE.search(html)
    # Strip the Drupal field-label prefix that leads each pane's text.
    bio, bio_tags, bio_html = cap_bio(html)
    topics = cap(html, "field-research-topics")
    programs = cap(html, "field-faculty-related-programs")
    return {
        "slug": slug,
        "name": (name.group(1).strip() if name else None),
        "title": cap(html, "field-faculty-title") or None,
        "cwid": (cwids[0].lower() if cwids else None),
        "research_topics": topics or None,
        "programs": programs or None,
        "bio": bio or None,
        "bio_words": (len(bio.split()) if bio else 0),
        "bio_tags": bio_tags,
        "bio_html": bio_html or None,
    }


def enumerate_slugs():
    first = fetch(f"{BASE}/faculty")
    time.sleep(DELAY)
    if not first:
        log("FATAL: could not fetch index page 0")
        return []
    max_page = max([int(m) for m in PAGE_RE.findall(first)] + [0])
    slugs = set(SLUG_RE.findall(first))
    log(f"index pages: 0..{max_page}; page0 slugs={len(slugs)}")
    for p in range(1, max_page + 1):
        h = fetch(f"{BASE}/faculty?page={p}")
        time.sleep(DELAY)
        if h:
            new = set(SLUG_RE.findall(h))
            slugs |= new
            log(f"  page {p}: +{len(new)} (total {len(slugs)})")
    # drop non-faculty nav slugs (single letters already excluded by regex; also drop 'all')
    return sorted(s for s in slugs if s not in {"all"} and "-" in s)


def test_offline():
    for f, tok in [("blenis.html", "field-faculty-biography")]:
        p = OUT_DIR / f
        if not p.exists():
            print(f"missing {p}"); continue
        html = p.read_text("utf-8", "replace")
        rec = parse_profile(html, "john-blenis")
        bh = rec.get("bio_html") or ""
        rec["bio"] = (rec["bio"][:160] + "…") if rec["bio"] else None
        rec["bio_html"] = f"<{len(bh)} chars> empty_p={len(re.findall(r'<p>\s*</p>', bh))} img={bh.count('<img')} a={bh.count('<a ')}"
        print(json.dumps(rec, indent=2))
    idx = OUT_DIR / "index0.html"
    if idx.exists():
        s = sorted(set(SLUG_RE.findall(idx.read_text("utf-8", "replace"))))
        s = [x for x in s if "-" in x]
        print(f"\nindex0 faculty slugs ({len(s)}): {s[:6]} …")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if "--test" in sys.argv:
        return test_offline()
    done = set()
    if OUT.exists():
        for line in OUT.read_text().splitlines():
            try:
                done.add(json.loads(line)["slug"])
            except Exception:  # noqa: BLE001
                pass
    log(f"resume: {len(done)} already done")
    slugs = enumerate_slugs()
    log(f"total faculty slugs: {len(slugs)}")
    todo = [s for s in slugs if s not in done]
    log(f"to fetch: {len(todo)}")
    with OUT.open("a") as out:
        for i, slug in enumerate(todo, 1):
            html = fetch(f"{BASE}/faculty/{slug}")
            time.sleep(DELAY)
            if not html:
                log(f"  [{i}/{len(todo)}] FAIL {slug}")
                continue
            rec = parse_profile(html, slug)
            out.write(json.dumps(rec) + "\n")
            out.flush()
            if i % 10 == 0 or i == len(todo):
                log(f"  [{i}/{len(todo)}] {slug} words={rec['bio_words']} cwid={rec['cwid']}")
    log("DONE")


if __name__ == "__main__":
    main()
