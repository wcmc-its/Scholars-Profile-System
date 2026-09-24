/** Media highlights story grouping: the ETL's auto-grouping (`assignGroups`),
 *  the profile's "Also in …" line (`alsoIn`, `toClipStories`), and the digest's
 *  syndication credit (`parseClipsEmail`). */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import { toClipStories } from "@/lib/api/profile";
import { alsoIn, assignGroups, type GroupableClip } from "@/lib/edit/clip-repeats";
import { parseClipsEmail } from "@/etl/news/clips";

const HEADLINE = "Her Son Was Dying, But His Rare Cancer Made It Difficult";
const clip = (over: Partial<GroupableClip>): GroupableClip => ({
  id: "x",
  cwid: "abc1234",
  url: "https://a.example/story",
  title: HEADLINE,
  publishedAt: "2026-09-21",
  outlet: "CBS News",
  duplicateOf: null,
  creditedOutlet: null,
  ...over,
});

describe("assignGroups", () => {
  it("a new copy (other outlet, same headline, within 14 days) joins the stored story's lead", () => {
    const lead = clip({ id: "lead" });
    const stored = clip({ id: "copy1", outlet: "MSN", duplicateOf: "lead" });
    const fresh = clip({ id: "new", outlet: "Yahoo", publishedAt: "2026-09-22", url: "https://y.example/s" });
    expect(assignGroups([fresh], [lead, stored])).toEqual(new Map([["new", "lead"]]));
  });

  it("never groups: a generic headline, the same outlet, >14 days apart, another scholar", () => {
    const stored = clip({ id: "s" });
    const cases = [
      clip({ id: "a", title: "At A Glance", outlet: "Yahoo" }),
      clip({ id: "b", outlet: "CBS News", url: "https://cbs.example/other" }),
      clip({ id: "c", outlet: "Yahoo", publishedAt: "2026-10-20" }),
      clip({ id: "d", outlet: "Yahoo", cwid: "zzz9999" }),
    ];
    const generic = clip({ id: "g", title: "At A Glance", outlet: "Crain's" });
    expect(assignGroups(cases, [stored, generic]).size).toBe(0);
  });

  it("a story formed only of new rows: the credited original leads, else the earliest", () => {
    const cbs = clip({ id: "cbs", creditedOutlet: "KFF Health News" });
    const kff = clip({ id: "kff", outlet: "KFF Health News", publishedAt: "2026-09-22" });
    const yahoo = clip({ id: "yahoo", outlet: "Yahoo", publishedAt: "2026-09-23" });
    expect(assignGroups([cbs, kff, yahoo], [])).toEqual(
      new Map([
        ["cbs", "kff"],
        ["yahoo", "kff"],
      ]),
    );
    expect(assignGroups([clip({ id: "one" }), clip({ id: "two", outlet: "Yahoo", publishedAt: "2026-09-22" })], []))
      .toEqual(new Map([["two", "one"]]));
  });

  it("never regroups a stored row (a reviewer's Ungroup stands)", () => {
    const a = clip({ id: "a" });
    const b = clip({ id: "b", outlet: "Yahoo" }); // stored, ungrouped on purpose
    expect(assignGroups([], [a, b]).size).toBe(0);
  });
});

describe("alsoIn", () => {
  it("one per outlet, the lead's outlet excluded, first seen first, capped with a count", () => {
    const p = (outlet: string) => ({ outlet, url: `https://${outlet.toLowerCase().replace(/\W/g, "")}.example/s` });
    const r = alsoIn("CBS News", [p("Yahoo"), p("cbs news"), p("Yahoo"), p("MSN"), p("AOL"), p("Newsweek")]);
    expect(r.shown.map((x) => x.outlet)).toEqual(["Yahoo", "MSN", "AOL"]);
    expect(r.more).toBe(1);
  });

  it("links each copy, except a saved broadcast clip", () => {
    const r = alsoIn("CBS News", [
      { outlet: "Yahoo", url: "https://yahoo.example/s" },
      { outlet: "Business First AM", url: "https://muckrack.com/broadcast/savedclips/view/abc" },
    ]);
    expect(r.shown).toEqual([
      { outlet: "Yahoo", url: "https://yahoo.example/s" },
      { outlet: "Business First AM", url: null },
    ]);
  });
});

describe("toClipStories", () => {
  const row = (id: string, outlet: string, duplicateOf: string | null, day: string) => ({
    id,
    outlet,
    duplicateOf,
    url: `https://${id}.example/s`,
    title: HEADLINE,
    publishedAt: new Date(`${day}T00:00:00Z`),
    excerpt: "Dr. Jane Doe",
    thumbnailUrl: null,
  });

  it("one entry per story, copies as Also in; no excerpt", () => {
    const stories = toClipStories([
      row("lead", "KFF Health News", null, "2026-09-21"),
      row("y", "Yahoo", "lead", "2026-09-23"),
      row("c", "CBS News", "lead", "2026-09-22"),
    ]);
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ outlet: "KFF Health News", excerpt: null });
    expect(stories[0].alsoIn.shown.map((x) => x.outlet)).toEqual(["CBS News", "Yahoo"]);
  });

  it("a copy whose lead is hidden (not visible) is not shown: hiding the lead hides the story", () => {
    expect(toClipStories([row("y", "Yahoo", "hidden-lead", "2026-09-23")])).toEqual([]);
  });
});

describe("parseClipsEmail credit line", () => {
  it("captures \"(This article originally appeared in X)\" as the clip's credited outlet", () => {
    const raw = [
      "Subject: FW: WCM in the News",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Monday, September 21, 2026",
      "Her Son Was Dying<https://news.example.com/s>",
      "Yahoo",
      "• Dr. Jane Doe",
      "(This article originally appeared in KFF Health News)",
      "Another Story Headline Here<https://news.example.com/t>",
      "Other Outlet",
      "• Dr. John Q. Public",
    ].join("\r\n");
    const clips = parseClipsEmail(raw);
    expect(clips[0]).toMatchObject({ outlet: "Yahoo", creditedOutlet: "KFF Health News" });
    expect(clips[1].creditedOutlet).toBeUndefined();
  });
});
