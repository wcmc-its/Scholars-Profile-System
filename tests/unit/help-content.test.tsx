/**
 * Help corpus (#515) — content module + static `[slug]` template.
 *
 * Asserts the launch-MVP contract: generateStaticParams covers every entry,
 * each entry renders its H1, metadata maps faithfully, related links resolve,
 * the #514 gate holds (no office emails / contact mechanism published), and an
 * unknown slug triggers notFound().
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

import { HELP_ENTRIES, HELP_GROUPS, getHelpEntry } from "@/lib/docs/help-content";
import HelpEntryPage, {
  generateStaticParams,
  generateMetadata,
} from "@/app/(public)/about/help/[slug]/page";

const params = (slug: string): Promise<{ slug: string }> => Promise.resolve({ slug });

describe("HELP_ENTRIES — content module", () => {
  it("ships exactly the 8 launch-MVP slugs", () => {
    expect(HELP_ENTRIES.map((e) => e.slug).sort()).toEqual(
      [
        "request-a-correction",
        "what-does-impact-mean",
        "when-does-my-impact-score-update",
        "where-does-the-data-come-from",
        "why-is-impact-missing",
        "why-is-this-publication-on-my-profile",
        "why-isnt-my-impact-score-author-relative",
        "why-isnt-my-publication-showing-up-in-search",
      ].sort(),
    );
  });

  it("has no duplicate slugs", () => {
    const slugs = HELP_ENTRIES.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every entry has a title, description, group, and body", () => {
    for (const e of HELP_ENTRIES) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(HELP_GROUPS.some((g) => g.id === e.group)).toBe(true);
      expect(e.body).toBeTruthy();
    }
  });

  it("every group has at least one entry (no empty hub sections)", () => {
    for (const g of HELP_GROUPS) {
      expect(HELP_ENTRIES.some((e) => e.group === g.id)).toBe(true);
    }
  });

  it("getHelpEntry resolves known slugs and returns undefined for unknown", () => {
    expect(getHelpEntry("what-does-impact-mean")?.title).toMatch(/Impact/);
    expect(getHelpEntry("nope")).toBeUndefined();
  });
});

describe("generateStaticParams", () => {
  it("covers all 8 slugs", () => {
    const out = generateStaticParams();
    expect(out).toHaveLength(HELP_ENTRIES.length);
    expect(out.map((p) => p.slug).sort()).toEqual(HELP_ENTRIES.map((e) => e.slug).sort());
  });
});

describe("generateMetadata", () => {
  it("maps title/description/canonical for a known slug", async () => {
    const meta = await generateMetadata({ params: params("what-does-impact-mean") });
    expect(meta.title).toBe("What does Impact mean on my profile? — Scholars at WCM");
    expect(meta.description).toBe(getHelpEntry("what-does-impact-mean")!.description);
    expect(meta.alternates?.canonical).toBe("/about/help/what-does-impact-mean");
  });

  it("returns empty metadata for an unknown slug (no throw)", async () => {
    await expect(generateMetadata({ params: params("nope") })).resolves.toEqual({});
  });
});

describe("HelpEntryPage — render", () => {
  it.each(HELP_ENTRIES.map((e) => [e.slug, e.title] as const))(
    "renders the H1 for %s",
    async (slug, title) => {
      render(await HelpEntryPage({ params: params(slug) }));
      const h1 = screen.getByRole("heading", { level: 1 });
      expect(h1.textContent).toBe(title);
    },
  );

  it("renders the short-answer lead when present", async () => {
    const entry = getHelpEntry("what-does-impact-mean")!;
    render(await HelpEntryPage({ params: params(entry.slug) }));
    expect(screen.getByText(entry.shortAnswer!)).toBeTruthy();
  });

  it("drops unresolved Related slugs and renders only real help pages", async () => {
    // why-is-this-publication-on-my-profile's draft related list references
    // `how-do-i-hide-a-publication`, which isn't in the MVP corpus; it must be
    // dropped while the resolvable sibling still renders.
    const entry = getHelpEntry("why-is-this-publication-on-my-profile")!;
    expect(entry.related).toContain("how-do-i-hide-a-publication");

    const { container } = render(
      await HelpEntryPage({ params: params(entry.slug) }),
    );
    const related = within(container).getByRole("heading", { name: "Related" })
      .parentElement!;
    const hrefs = Array.from(related.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs).not.toContain("/about/help/how-do-i-hide-a-publication");
    for (const href of hrefs) {
      const slug = href!.replace("/about/help/", "");
      expect(getHelpEntry(slug)).toBeDefined();
    }
  });

  it("calls notFound() for an unknown slug", async () => {
    await expect(HelpEntryPage({ params: params("nope") })).rejects.toThrow("__NOT_FOUND__");
    expect(mockNotFound).toHaveBeenCalled();
  });
});

describe("request-a-correction — #514 gate", () => {
  it("publishes the source-system column but no office emails or contact form", async () => {
    render(await HelpEntryPage({ params: params("request-a-correction") }));
    // Source-system column is published.
    expect(screen.getByText("Enterprise Directory")).toBeTruthy();
    expect(screen.getByText("NYP IdentityIQ")).toBeTruthy();
    // No email addresses leaked into the rendered page (gated on #514).
    expect(document.body.textContent).not.toMatch(/@/);
    // The contact mechanism is a neutral placeholder, not a live form/route.
    expect(document.body.textContent).toMatch(/correction form .* is coming/i);
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});
