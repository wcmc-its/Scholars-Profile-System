/**
 * lib/analytics/referrer-category — the TypeScript classifier and the SQL CASE
 * it emits must agree. The CASE is evaluated here by reading its arms back in
 * order and applying each `regexp_like` pattern as a JS RegExp, which is what
 * Athena does with the same (Java-compatible) patterns.
 */
import { describe, expect, it } from "vitest";

import {
  REFERRER_CATEGORIES,
  REFERRER_CATEGORY_DISPLAY_ORDER,
  classifyHost,
  toSqlCase,
} from "@/lib/analytics/referrer-category";

const SAMPLES: Array<[string, string]> = [
  ["www.google.edu", "Fake"],
  ["www.bing.edu", "Fake"],
  ["www.yandex.edu", "Fake"],
  ["vivo.weill.cornell.edu", "Old VIVO"],
  ["vivo.med.cornell.edu", "Old VIVO"],
  ["qatar-weill.cornell.edu", "WCM-Q"],
  ["www.qatar.weill.cornell.edu", "WCM-Q"],
  ["news.weill.cornell.edu", "WCM"],
  ["weill.cornell.edu", "WCM"],
  ["dept.weill.cornell.edu", "WCM"],
  ["med.cornell.edu", "WCM"],
  ["weillcornell.org", "WCM clinical"],
  ["www.weillcornell.org", "WCM clinical"],
  ["www.cornell.edu", "Cornell (Ithaca)"],
  ["cornell.edu", "Cornell (Ithaca)"],
  ["www.nyp.org", "NYP"],
  ["chatgpt.com", "AI assistants"],
  ["chat.openai.com", "AI assistants"],
  ["claude.ai", "AI assistants"],
  ["www.perplexity.ai", "AI assistants"],
  ["gemini.google.com", "AI assistants"],
  ["copilot.microsoft.com", "AI assistants"],
  ["chat.deepseek.com", "AI assistants"],
  ["grok.com", "AI assistants"],
  ["www.google.com", "Search engines"],
  ["www.google.co.uk", "Search engines"],
  ["scholar.google.com", "Search engines"],
  ["www.bing.com", "Search engines"],
  ["cn.bing.com", "Search engines"],
  ["duckduckgo.com", "Search engines"],
  ["search.brave.com", "Search engines"],
  ["search.yahoo.com", "Search engines"],
  ["m.baidu.com", "Search engines"],
  ["yandex.ru", "Search engines"],
  ["www.ecosia.org", "Search engines"],
  ["www.facebook.com", "Social"],
  ["l.facebook.com", "Social"],
  ["www.linkedin.com", "Social"],
  ["lnkd.in", "Social"],
  ["t.co", "Social"],
  ["x.com", "Social"],
  ["bsky.app", "Social"],
  ["old.reddit.com", "Social"],
  ["teams.public.onecdn.static.microsoft", "Other"],
  ["example.org", "Other"],
  ["notcornell.edu", "Other"],
  ["fakechatgpt.com", "Other"],
  ["", "Other"],
];

/** Evaluate the emitted CASE for one host the way Athena would. */
function evalSqlCase(sql: string, host: string): string {
  const arm = /WHEN regexp_like\(h, '([^']*)'\) THEN '([^']*)'/g;
  for (const m of sql.matchAll(arm)) {
    if (new RegExp(m[1]).test(host)) return m[2];
  }
  const fallback = /ELSE '([^']*)' END$/.exec(sql);
  return fallback ? fallback[1] : "<none>";
}

describe("classifyHost", () => {
  it.each(SAMPLES)("%s -> %s", (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });

  it("lower-cases and trims before matching", () => {
    expect(classifyHost("  WWW.Google.COM ")).toBe("Search engines");
  });

  it("tests AI assistants before search engines (gemini.google.com)", () => {
    expect(classifyHost("gemini.google.com")).toBe("AI assistants");
    expect(classifyHost("www.google.com")).toBe("Search engines");
  });
});

describe("toSqlCase", () => {
  const sql = toSqlCase("h");

  it.each(SAMPLES)("agrees with classifyHost on %s", (host) => {
    expect(evalSqlCase(sql, host)).toBe(classifyHost(host));
  });

  it("is one CASE with an arm per rule, in order, and an Other fallback", () => {
    expect(sql.startsWith("CASE WHEN regexp_like(h, '^www")).toBe(true);
    expect(sql.endsWith("ELSE 'Other' END")).toBe(true);
    expect(sql.match(/WHEN /g)).toHaveLength(REFERRER_CATEGORIES.length - 1);
    expect(sql).not.toContain(";");
  });

  it("accepts the builders' host expressions and rejects anything else", () => {
    expect(() => toSqlCase("split_part(dimension, '/', 1)")).not.toThrow();
    expect(() => toSqlCase("split_part(dimension, '|', 1)")).not.toThrow();
    expect(() => toSqlCase("h; DROP TABLE x")).toThrow(/invalid_host_expr/);
    expect(() => toSqlCase("h -- x")).toThrow(/invalid_host_expr/);
    expect(() => toSqlCase("h\nOR 1=1")).toThrow(/invalid_host_expr/);
  });
});

it("lists every category exactly once in the display order", () => {
  expect([...REFERRER_CATEGORY_DISPLAY_ORDER].sort()).toEqual([...REFERRER_CATEGORIES].sort());
});
