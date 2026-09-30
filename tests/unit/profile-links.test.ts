import { describe, expect, it } from "vitest";

import {
  canonicalProfileLink,
  profileLinkHandle,
  profileLinkInput,
  validateProfileLinks,
} from "@/lib/edit/profile-links";

describe("canonicalProfileLink", () => {
  it.each([
    ["x", "@paul_albert", "https://x.com/paul_albert"],
    ["x", "https://twitter.com/paul_albert?s=21", "https://x.com/paul_albert"],
    ["x", "x.com/paul_albert/status/123", "https://x.com/paul_albert"],
    [
      "linkedin",
      "https://www.linkedin.com/in/paul-albert-123/",
      "https://www.linkedin.com/in/paul-albert-123",
    ],
    ["linkedin", "paul-albert", "https://www.linkedin.com/in/paul-albert"],
    [
      "linkedin",
      "https://uk.linkedin.com/in/paul-albert",
      "https://www.linkedin.com/in/paul-albert",
    ],
    ["x", "https://mobile.twitter.com/paul_albert", "https://x.com/paul_albert"],
    ["bluesky", "@paul.bsky.social", "https://bsky.app/profile/paul.bsky.social"],
    ["bluesky", "paul", "https://bsky.app/profile/paul.bsky.social"],
    [
      "bluesky",
      "https://bsky.app/profile/paul.bsky.social/post/abc",
      "https://bsky.app/profile/paul.bsky.social",
    ],
    [
      "googleScholar",
      "https://scholar.google.com/citations?hl=en&user=AbCdEfGhIjKl&view_op=list_works",
      "https://scholar.google.com/citations?user=AbCdEfGhIjKl",
    ],
    [
      "googleScholar",
      "scholar.google.co.uk/citations?user=AbCdEfGhIjKl",
      "https://scholar.google.com/citations?user=AbCdEfGhIjKl",
    ],
    ["googleScholar", "AbCdEfGhIjKl", "https://scholar.google.com/citations?user=AbCdEfGhIjKl"],
    [
      "researchGate",
      "http://researchgate.net/profile/Paul-Albert-3?ev=hdr",
      "https://www.researchgate.net/profile/Paul-Albert-3",
    ],
  ] as const)("%s: %s → %s", (platform, input, expected) => {
    expect(canonicalProfileLink(platform, input)).toBe(expected);
  });

  it.each([
    ["x", "javascript:alert(1)"],
    ["x", "https://evil.example/x.com/paul"],
    ["x", "https://x.com.evil.example/paul"],
    ["x", "https://x.com/"],
    ["linkedin", "https://linkedin.com"],
    ["linkedin", "https://linkedin.com//"],
    ["googleScholar", "https://scholar.google.evil.example/citations?user=AbCdEfGhIjKl"],
    ["linkedin", "https://x.com/paul"],
    ["bluesky", "https://bsky.app/paul"],
    ["googleScholar", "https://scholar.google.com/citations?hl=en"],
    ["googleScholar", "https://scholar.google.com/citations?user=<script>"],
    ["researchGate", "https://www.researchgate.net/publication/123"],
    ["x", "a".repeat(600)],
  ] as const)("%s rejects %s", (platform, input) => {
    expect(canonicalProfileLink(platform, input)).toBeNull();
  });
});

describe("validateProfileLinks", () => {
  it("canonicalizes each slot, drops blanks, keeps platform order", () => {
    const r = validateProfileLinks({ researchGate: "", x: " @paul ", linkedin: "in-paul" });
    expect(r).toEqual({
      ok: true,
      value: { linkedin: "https://www.linkedin.com/in/in-paul", x: "https://x.com/paul" },
    });
    expect(Object.keys((r as { value: object }).value)).toEqual(["linkedin", "x"]);
  });

  it("accepts the stored JSON string form", () => {
    expect(validateProfileLinks('{"x":"https://x.com/paul"}')).toEqual({
      ok: true,
      value: { x: "https://x.com/paul" },
    });
  });

  it("names the bad slot", () => {
    expect(validateProfileLinks({ x: "ok_handle", bluesky: "https://x.com/paul" })).toEqual({
      ok: false,
      error: "invalid_link",
      platform: "bluesky",
    });
  });

  it("rejects bad shapes", () => {
    const bad: unknown[] = [
      null,
      [],
      "not json",
      { labWebsite: "https://a.b" },
      { x: 1 },
      { constructor: "x" },
    ];
    for (const input of bad) {
      expect(validateProfileLinks(input)).toEqual({ ok: false, error: "invalid_value" });
    }
  });
});

describe("profileLinkHandle — a pasted full URL shows as the handle the label's prefix expects", () => {
  it.each([
    ["linkedin", "https://www.linkedin.com/in/oelemento/?originalSubdomain=us", "oelemento"],
    ["linkedin", "uk.linkedin.com/in/oelemento", "oelemento"],
    ["x", "https://twitter.com/oelemento?s=21", "oelemento"],
    ["x", "@oelemento", "oelemento"],
    ["bluesky", "https://bsky.app/profile/olivier.bsky.social", "olivier.bsky.social"],
    ["bluesky", "@olivier.bsky.social", "olivier.bsky.social"],
    [
      "googleScholar",
      "https://scholar.google.com/citations?hl=en&user=AbCdEfGhIjKl&view_op=list_works",
      "AbCdEfGhIjKl",
    ],
    ["googleScholar", "AbCdEfGhIjKl", "AbCdEfGhIjKl"],
    [
      "researchGate",
      "https://www.researchgate.net/profile/Olivier-Elemento#publications",
      "Olivier-Elemento",
    ],
    ["researchGate", "Olivier-Elemento", "Olivier-Elemento"],
  ] as const)("%s: %s → %s", (platform, raw, handle) => {
    expect(profileLinkHandle(platform, raw)).toBe(handle);
  });

  it("round-trips: the stored canonical URL shows as a handle, and the handle sent back canonicalizes to the same URL", () => {
    const canon = {
      linkedin: "https://www.linkedin.com/in/john.smith",
      x: "https://x.com/oelemento",
      bluesky: "https://bsky.app/profile/olivier.bsky.social",
      googleScholar: "https://scholar.google.com/citations?user=AbCdEfGhIjKl",
      researchGate: "https://www.researchgate.net/profile/Olivier-Elemento",
    } as const;
    for (const [platform, url] of Object.entries(canon) as Array<[keyof typeof canon, string]>) {
      const handle = profileLinkHandle(platform, url);
      expect(handle).not.toContain("/");
      expect(canonicalProfileLink(platform, profileLinkInput(platform, handle))).toBe(url);
    }
    // A value that is still a path (legacy LinkedIn /pub/…) is sent as typed.
    expect(profileLinkInput("linkedin", "pub/john-smith/1/2/3")).toBe("pub/john-smith/1/2/3");
    expect(profileLinkInput("x", "")).toBe("");
  });
});
