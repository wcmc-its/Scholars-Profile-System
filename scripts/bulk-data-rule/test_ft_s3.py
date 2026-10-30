"""Self-check for scan2.ft()'s optional S3 tier. Offline: fake S3 client + stubbed live fetch.
Run: python3 test_ft_s3.py"""
import os, tempfile
os.environ["HOME"] = tempfile.mkdtemp()  # scan2's OUT hangs off HOME; keep the real cache untouched
os.environ.pop("FULLTEXT_S3_BUCKET", None)
import scan2

class Miss(Exception):
    response = {"Error": {"Code": "NoSuchKey"}}

class FakeS3:
    def __init__(self, objs=None, boom=False): self.objs, self.boom, self.calls = dict(objs or {}), boom, 0
    def get_object(self, Bucket, Key):
        self.calls += 1
        if self.boom: raise RuntimeError("AccessDenied")
        if Key not in self.objs: raise Miss()
        body = self.objs[Key]
        return {"Body": type("B", (), {"read": lambda _s: body})()}
    def put_object(self, Bucket, Key, Body, ContentType):
        self.calls += 1
        if self.boom: raise RuntimeError("AccessDenied")
        self.objs[Key] = Body

def reset(bucket, s3, live):
    for f in os.listdir(os.path.join(scan2.OUT, "xml_cache")): os.remove(os.path.join(scan2.OUT, "xml_cache", f))
    scan2.S3_BUCKET, scan2._s3 = bucket, s3
    scan2._fetch_live = lambda pid: live
def disk(pid): return open(os.path.join(scan2.OUT, "xml_cache", f"{pid}.xml"), "rb").read()

# S3 hit: returns bytes, writes disk, no live fetch
s3 = FakeS3({"fulltext/pmc/PMC1.xml": b"<s3/>"}); reset("b", s3, None)
assert scan2.ft("PMC1", 11) == b"<s3/>" and disk("PMC1") == b"<s3/>"

# S3 miss -> live: writes disk + pmc object + pmid map (PMCID, no newline)
s3 = FakeS3(); reset("b", s3, b"<live/>")
assert scan2.ft("2", 22) == b"<live/>" and disk("PMC2") == b"<live/>"
assert s3.objs == {"fulltext/pmc/PMC2.xml": b"<live/>", "fulltext/pmid/22": b"PMC2"}, s3.objs

# no pmid -> no map object
s3 = FakeS3(); reset("b", s3, b"<live/>")
scan2.ft("PMC3"); assert list(s3.objs) == ["fulltext/pmc/PMC3.xml"]

# S3 errors on read AND write -> falls back to live, never raises
s3 = FakeS3(boom=True); reset("b", s3, b"<live/>")
assert scan2.ft("PMC4", 44) == b"<live/>" and disk("PMC4") == b"<live/>"

# env unset -> S3 never touched
s3 = FakeS3({"fulltext/pmc/PMC5.xml": b"<s3/>"}); reset("", s3, b"<live/>")
assert scan2.ft("PMC5", 55) == b"<live/>" and s3.calls == 0

# disk hit short-circuits S3
s3 = FakeS3(); reset("b", s3, None)
open(os.path.join(scan2.OUT, "xml_cache", "PMC6.xml"), "wb").write(b"<disk/>")
assert scan2.ft("PMC6", 66) == b"<disk/>" and s3.calls == 0

print("test_ft_s3: all checks passed")
