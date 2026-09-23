/**
 * Research Dean funding digest → opportunity submissions
 * (etl/opportunities/funding-digest.ts). SYNTHETIC fixture in the digest's
 * shape — invented sponsors and links (this repo is public).
 */
import { describe, expect, it } from "vitest";

import {
  digestNote,
  newSubmissions,
  parseDigestLines,
  parseFundingDigest,
} from "@/etl/opportunities/funding-digest";

const safe = (u: string) =>
  `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(u)}&data=05%7Cx&reserved=0`;

const PLAIN = [
  "Major Funding Digest for the Week of August 17 - 21, 2026",
  "NIH Policy Updates",
  `NIH is Changing Something<${safe("https://grants.example.gov/policy-news")}>`,
  "",
  "Federal Limited Submission Opportunities",
  "Please email Dr. Example (lead@example.org<mailto:lead@example.org>) to express your intention to apply:",
  `Example Research Fellowship<${safe("https://fellowships.example.org/apply")}>`,
  "Nomination Limit: 3 per Department",
  "Internal Deadline: Please contact your department for details",
  "External Deadline: September 15, 2026",
  "NIH Funding Opportunities",
  `Additional currently active NIH opportunities can be found here<${safe("https://grants.example.gov/list")}>.`,
  `Example Transition Award (PA-27-000)<${safe("https://grants.example.gov/pa-27-000")}>`,
  "Deadline: October 2, 2026",
  "Department of War Opportunities",
  "Please click on the program link for a list of all open awards.",
  `  *   Example Research Program<${safe("http://programs.example.mil/insecure")}> - Deadline: October 7, 2026`,
  `  *   Other Research Program<${safe("https://programs.example.mil/other")}> - Deadline: September 4, 2026`,
  "Industry Open Submission Programs",
  `Click here for additional non-federal funding opportunities.<https://example.sharepoint.com/sheet>`,
  "Cancer Research",
  "Example Pharma",
  `Discovery <${safe("https://pharma.example.com/rfp?utm_source=digest")}> Research<${safe("https://pharma.example.com/rfp")}> Grants<${safe("https://pharma.example.com/rfp")}>`,
  "Deadline: August 26, 2026",
  `Duplicate Link Again<${safe("https://pharma.example.com/rfp")}>`,
  "Webinars, Courses, & Events",
  `Webinar: Tips for Applying<${safe("https://events.example.org/webinar")}>`,
].join("\r\n");

function eml(body: string, type = "text/plain"): string {
  return Buffer.from(
    `From: Office of the Research Dean <dean@med.cornell.edu>\r\nSubject: [LIST] Major Funding Digest for the Week of August 17 -21, 2026\r\n` +
      `Date: Mon, 17 Aug 2026 15:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: ${type}; charset="utf-8"\r\n\r\n${body}\r\n`,
    "utf-8",
  ).toString("latin1");
}

describe("parseDigestLines", () => {
  const items = parseDigestLines(PLAIN);

  it("keeps opportunities only: skips policy news, list/SharePoint/mailto links, http links and events", () => {
    expect(items.map((i) => i.normalizedUrl)).toEqual([
      "https://fellowships.example.org/apply",
      "https://grants.example.gov/pa-27-000",
      "https://programs.example.mil/other",
      "https://pharma.example.com/rfp",
    ]);
  });

  it("keeps limited-submission context and prefers the EXTERNAL deadline", () => {
    expect(items[0]).toMatchObject({
      title: "Example Research Fellowship",
      section: "Federal Limited Submission Opportunities",
      deadline: "September 15, 2026",
      nominationLimit: "3 per Department",
    });
  });

  it("reads an inline bullet deadline, and never takes an instruction sentence as the sponsor", () => {
    expect(items[2]).toMatchObject({ title: "Other Research Program", deadline: "September 4, 2026", sponsor: null });
  });

  it("joins a title split across links, keeps the sponsor heading, and dedupes the url", () => {
    expect(items[3]).toMatchObject({
      title: "Discovery Research Grants",
      sponsor: "Example Pharma",
      deadline: "August 26, 2026",
    });
  });
});

describe("parseFundingDigest", () => {
  it("reads the HTML part the same way", () => {
    const html = PLAIN.split("\r\n")
      .map((l) => `<p>${l.replace(/<(https?:\/\/[^>]+)>/g, (_, u: string) => ` <a href="${u.replace(/&/g, "&amp;")}">link</a>`)}</p>`)
      .join("\n");
    // Link text differs ("link"), so compare urls only.
    expect(parseFundingDigest(eml(html, "text/html")).map((i) => i.normalizedUrl)).toEqual(
      parseDigestLines(PLAIN).map((i) => i.normalizedUrl),
    );
  });

  it("returns nothing for a digest-less email (caller fails the run)", () => {
    expect(parseFundingDigest(eml("Please unsubscribe me."))).toEqual([]);
  });
});

describe("newSubmissions", () => {
  const items = parseDigestLines(PLAIN);

  it("skips a url already in the corpus (raw corpus url is normalized first)", () => {
    const fresh = newSubmissions(items, ["https://Fellowships.example.org/apply/"], []);
    expect(fresh.map((i) => i.normalizedUrl)).not.toContain("https://fellowships.example.org/apply");
  });

  it("skips a url with ANY queue item, rejected and suppressed included", () => {
    const fresh = newSubmissions(items, [], [
      { normalizedUrl: "https://grants.example.gov/pa-27-000" }, // e.g. status rejected
      { normalizedUrl: "https://programs.example.mil/other" }, // e.g. status suppressed
    ]);
    expect(fresh.map((i) => i.normalizedUrl)).toEqual([
      "https://fellowships.example.org/apply",
      "https://pharma.example.com/rfp",
    ]);
  });

  it("submits a link once even when two digests carry it", () => {
    expect(newSubmissions([...items, ...items], [], [])).toHaveLength(items.length);
  });
});

it("digestNote carries section, sponsor, deadline and nomination limit within 500 chars", () => {
  const [first] = parseDigestLines(PLAIN);
  expect(digestNote(first, "2026-08-17")).toBe(
    "Research Dean funding digest 2026-08-17 · Federal Limited Submission Opportunities · Deadline: September 15, 2026 · Nomination limit: 3 per Department",
  );
  expect(digestNote({ ...first, title: "x", sponsor: "y".repeat(900) }, "2026-08-17").length).toBe(500);
});
