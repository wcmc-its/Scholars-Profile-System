/**
 * "WCM in the News" digest parsing (etl/news/clips.ts). The fixture is
 * SYNTHETIC — same shape as the External Affairs digest, invented names and
 * links (this repo is public).
 */
import { describe, expect, it } from "vitest";

import { clipToArticle, doctorNames, parseClipsEmail, unwrapLink } from "@/etl/news/clips";

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
});
