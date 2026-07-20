/**
 * The upsert-preserve discipline (etl/news/index.ts) — the load-bearing
 * divergence from scholar_technology, which truncate-rebuilds. A re-scrape must
 * never revert a human's approve/reject/hide or resurrect a rejected row. Pure
 * `reconcile` + `articlesToMentions`, no DB.
 */
import { describe, expect, it } from "vitest";

import { articlesToMentions, reconcile, type ExistingMention } from "@/etl/news/index";
import type { ScrapedArticle } from "@/etl/news/seed";

const ORIGIN = "https://research.weill.cornell.edu";
const URL = `${ORIGIN}/about-us/news-updates/some-article`;

const existing = (over: Partial<ExistingMention>): ExistingMention => ({
  status: "pending",
  source: "NAME",
  enteredByCwid: null,
  title: "Old title",
  publishedAt: new Date("2026-07-16T00:00:00Z"),
  excerpt: "old",
  thumbnailUrl: null,
  detectedName: "Jane Roe",
  likelihood: "HIGH",
  sourceRef: `${URL}|jane roe`,
  ...over,
});

const incomingName = {
  cwid: "jro1",
  url: URL,
  title: "Old title",
  publishedAt: new Date("2026-07-16T00:00:00Z"),
  excerpt: "old",
  thumbnailUrl: null,
  status: "pending" as const,
  source: "NAME" as const,
  detectedName: "Jane Roe",
  likelihood: "HIGH",
  sourceRef: `${URL}|jane roe`,
};

describe("reconcile — review state", () => {
  it("preserves a human-REJECTED row unchanged when the same name re-scrapes", () => {
    const patch = reconcile(existing({ status: "rejected", enteredByCwid: "curator1" }), incomingName);
    expect(patch).toEqual({}); // no status/source churn, nothing to update
  });

  it("preserves a human-APPROVED (published) row; a later NAME re-scrape can't demote it", () => {
    const patch = reconcile(
      existing({ status: "published", source: "NAME", enteredByCwid: "curator1" }),
      incomingName,
    );
    expect(patch).toEqual({});
  });

  it("does NOT resurrect an ETL-owned REJECTED row even when VIVO now links it", () => {
    const patch = reconcile(
      existing({ status: "rejected", source: "NAME", enteredByCwid: null }),
      { ...incomingName, source: "VIVO", status: "published", detectedName: null, likelihood: null, sourceRef: null },
    );
    expect(patch).toEqual({});
  });

  it("upgrades an ETL-owned pending NAME row to VIVO when the article gains the link", () => {
    const patch = reconcile(existing({ status: "pending", source: "NAME", enteredByCwid: null }), {
      ...incomingName,
      source: "VIVO",
      status: "published",
      detectedName: null,
      likelihood: null,
      sourceRef: null,
    });
    expect(patch).toMatchObject({ source: "VIVO", status: "published", detectedName: null, sourceRef: null });
  });

  it("never downgrades an existing VIVO row when only a NAME match arrives", () => {
    const patch = reconcile(existing({ status: "published", source: "VIVO", enteredByCwid: null }), incomingName);
    expect(patch.status).toBeUndefined();
    expect(patch.source).toBeUndefined();
  });

  it("always refreshes changed article metadata, even on a human-touched row", () => {
    const patch = reconcile(
      existing({ status: "published", enteredByCwid: "curator1", title: "Old title" }),
      { ...incomingName, title: "New title" },
    );
    expect(patch).toEqual({ title: "New title" });
  });
});

describe("articlesToMentions", () => {
  const scholars = [
    { cwid: "xim2002", fullName: "Xiaojing Ma", preferredName: "Xiaojing Ma", primaryTitle: null, primaryDepartment: null },
    { cwid: "jro1", fullName: "Jane Roe", preferredName: "Jane Roe", primaryTitle: null, primaryDepartment: null },
  ];
  const article: ScrapedArticle = {
    url: URL,
    title: "A study",
    excerpt: null,
    thumbnailUrl: null,
    publishedAt: "2026-07-16",
    cwids: ["xim2002"], // VIVO-linked
    bodyText: "Work by Xiaojing Ma with collaborator Jane Roe.",
  };

  it("makes a published VIVO row + a pending NAME row, never both for one scholar", () => {
    const rows = articlesToMentions([article], scholars);
    const byCwid = Object.fromEntries(rows.map((r) => [r.cwid, r]));
    expect(byCwid.xim2002).toMatchObject({ status: "published", source: "VIVO" });
    expect(byCwid.jro1).toMatchObject({ status: "pending", source: "NAME", detectedName: "Jane Roe" });
    expect(rows.length).toBe(2);
  });

  it("drops a VIVO cwid with no scholar row", () => {
    const rows = articlesToMentions([{ ...article, cwids: ["ghost99"] }], scholars);
    // ghost99 has no scholar row -> no VIVO row; Jane Roe still name-matched.
    expect(rows.find((r) => r.cwid === "ghost99")).toBeUndefined();
    expect(rows.find((r) => r.cwid === "jro1")).toBeTruthy();
  });
});
