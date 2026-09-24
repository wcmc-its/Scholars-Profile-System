/**
 * "WCM in the News" digest parsing (etl/news/clips.ts). The fixture is
 * SYNTHETIC — same shape as the External Affairs digest, invented names and
 * links (this repo is public).
 */
import { describe, expect, it } from "vitest";

import {
  readEmail,
  clipMentionRows,
  clipToArticle,
  doctorNames,
  htmlToLines,
  parseClipsEmail,
  unwrapLink,
} from "@/etl/news/clips";

const safe = (u: string) =>
  `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(u)}&data=05%7Cx&reserved=0`;

const PLAIN = [
  "Forwarding for the meeting.",
  `Example Org<${safe("https://example.org/")}>`,
  "Office: (000) 000-0000",
  "",
  "Tuesday, September 22, 2026",
  `Jane Roe Named Chair Of State Board<${safe("https://news.example.com/2026/09/roe-chair/")}>`,
  "The Example Bazaar",
  "",
  "• Dr. Jane Roe comments on her election as chair.",
  "",
  `Bad Link Story<javascript:alert(1)>`,
  "Nowhere",
  "",
  "• Dr. Nobody",
  "",
  `Why Read A Paper When You Can Ask It?<https://spectrum.example.com/paper-agent>`,
  "Fixing the Future (Example Spectrum)",
  "",
  "• Dr. John Q. Public and Dr. Ana María Ruiz",
  "For a complete copy of any of the stories referenced above, contact us.",
  `Not A Clip<https://example.org/after-footer>`,
].join("\r\n");

const HTML = `<html><head><style>p{}</style></head><body>
<p>Forwarding. <a href="${safe("https://example.org/")}">Example Org</a></p>
<h3><span>Tuesday, September 22, 2026</span></h3>
<div><h4><span><a href="${safe("https://news.example.com/2026/09/roe-chair/").replace(/&/g, "&amp;")}"><u>Jane Roe Named Chair Of State Board</u></a></span></h4>
<p><b>The Example Bazaar</b></p>
<div><p>&bull; Dr. Jane Roe comments on her election&nbsp;as chair.</p></div></div>
<div><h4><a href="javascript:alert(1)">Bad Link Story</a></h4><p><b>Nowhere</b></p><p>• Dr. Nobody</p></div>
<div><h4><a href="https://spectrum.example.com/paper-agent">Why Read A Paper When You Can Ask It&#63;</a></h4>
<p><b>Fixing the Future (Example Spectrum)</b></p>
<p>• Dr. John Q. Public and <a href="https://example.org/ruiz">Dr. Ana María Ruiz</a></p></div>
<p>For more news, visit the newsroom.</p></body></html>`;

function eml(parts: { type: string; body: string; cte?: string }[], headers = ""): string {
  const b = "BOUNDARY_x1";
  const chunks = parts.map((p) => {
    const body = p.cte === "base64" ? Buffer.from(p.body, "utf-8").toString("base64") : p.body;
    return `--${b}\r\nContent-Type: ${p.type}; charset="utf-8"\r\nContent-Transfer-Encoding: ${p.cte ?? "8bit"}\r\n\r\n${body}\r\n`;
  });
  const raw =
    `From: External Affairs <clips-list@med.cornell.edu>\r\nSubject: [CLIPS] WCM in the News - September 22, 2026\r\n${headers}` +
    `MIME-Version: 1.0\r\nContent-Type: multipart/alternative;\r\n\tboundary="${b}"\r\n\r\n${chunks.join("")}--${b}--\r\n`;
  // The ETL reads raw bytes as latin1 (one char per byte).
  return Buffer.from(raw, "utf-8").toString("latin1");
}

const EXPECTED = [
  {
    url: "https://news.example.com/2026/09/roe-chair/",
    title: "Jane Roe Named Chair Of State Board",
    outlet: "The Example Bazaar",
    summary: "Dr. Jane Roe comments on her election as chair.",
    publishedAt: "2026-09-22",
  },
  {
    url: "https://spectrum.example.com/paper-agent",
    title: "Why Read A Paper When You Can Ask It?",
    outlet: "Fixing the Future (Example Spectrum)",
    summary: "Dr. John Q. Public and Dr. Ana María Ruiz",
    publishedAt: "2026-09-22",
  },
];

describe("parseClipsEmail", () => {
  it("reads the HTML part: unwraps Safe Links, skips the forwarder's signature and the footer", () => {
    expect(parseClipsEmail(eml([{ type: "text/html", body: HTML, cte: "base64" }]))).toEqual(EXPECTED);
  });

  it("falls back to the plain part and drops a non-http link", () => {
    expect(parseClipsEmail(eml([{ type: "text/plain", body: PLAIN }]))).toEqual(EXPECTED);
  });

  it("decodes quoted-printable (soft breaks + UTF-8 bytes)", () => {
    const qp = PLAIN.replace("Ana María Ruiz", "Ana Mar=C3=ADa Ruiz").replace(
      "comments on her election",
      "comments on her=\r\n election",
    );
    const clips = parseClipsEmail(eml([{ type: "text/plain", body: qp, cte: "quoted-printable" }]));
    expect(clips).toEqual(EXPECTED);
  });

  it("returns nothing for mail with no dated digest header (caller fails the run)", () => {
    expect(parseClipsEmail(eml([{ type: "text/plain", body: "Hello, please add me to the list." }]))).toEqual([]);
  });
});

describe("helpers", () => {
  it("doctorNames pulls every Dr.-prefixed person, initials and accents intact", () => {
    expect(doctorNames(EXPECTED[1].summary)).toEqual(["John Q. Public", "Ana María Ruiz"]);
  });

  it("unwrapLink refuses non-http targets, even inside Safe Links", () => {
    expect(unwrapLink(safe("javascript:alert(1)"))).toBeNull();
    expect(unwrapLink("mailto:a@example.org")).toBeNull();
  });

  it("clipToArticle marks the row as a clip and feeds names as tags", () => {
    const a = clipToArticle(EXPECTED[0]);
    expect(a.outlet).toBe("The Example Bazaar");
    expect(a.tags).toEqual(["Jane Roe"]);
    expect(a.cwids).toEqual([]);
  });

  it("readEmail takes the auth verdict from SES's Authentication-Results, not a relay's", () => {
    const raw = [
      "Authentication-Results: amazonses.com;",
      " spf=pass (spfCheck: domain of example.org designates 192.0.2.1 as permitted sender);",
      " dkim=pass header.i=@example.org;",
      " dmarc=pass header.from=example.org;",
      "From: a@example.org",
      "authentication-results: dkim=none (message not signed)",
      "Subject: x",
      "",
      "body",
    ].join("\r\n");
    expect(readEmail(raw).authVerdict).toBe("spf=pass dkim=pass dmarc=pass");
    expect(readEmail("Subject: x\r\n\r\nbody").authVerdict).toBe("spf=none dkim=none dmarc=none");
    // A first header that is not SES's is never read as a pass.
    expect(readEmail("Authentication-Results: evil.example; spf=pass\r\n\r\nb").authVerdict).toBe(
      "spf=none dkim=none dmarc=none",
    );
  });
});

describe("clipMentionRows", () => {
  const scholars = [
    { cwid: "jro1", fullName: "Jane Roe", preferredName: "Jane Roe", primaryTitle: null, primaryDepartment: null },
  ];

  it("creates one row per (cwid, url) when the same clip recurs in two digests", () => {
    // Same url, different digest dates: articlesToMentions keys on title+date,
    // so without the url dedupe this is two creates on one unique key.
    const a = clipToArticle(EXPECTED[0]);
    const b = clipToArticle({ ...EXPECTED[0], title: "Roe Elected Board Chair", publishedAt: "2026-09-25" });
    const rows = clipMentionRows([a, b], scholars);
    expect(rows.map((r) => [r.cwid, r.url])).toEqual([["jro1", EXPECTED[0].url]]);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].outlet).toBe("The Example Bazaar");
  });

  it("drops a clip that links a WCM Newsroom story (etl:news owns that url)", () => {
    const a = clipToArticle({ ...EXPECTED[0], url: "https://news.weill.cornell.edu/news/2026/09/roe-chair" });
    expect(clipMentionRows([a], scholars)).toEqual([]);
  });
});

it("htmlToLines keeps a single-quoted href", () => {
  expect(htmlToLines("<a href='https://example.org/x'>Story</a>")).toBe("Story<https://example.org/x>");
});
