import { describe, expect, it, vi } from "vitest";

import {
  checkSlugCollision,
  findSuppressibleEntityOwner,
  isChairAppointment,
  isEditableField,
  isEditableUnitField,
  isSectionVisibilityField,
  publicationAuthorshipExists,
  sanitizeOverview,
  SECTION_VISIBILITY_FIELDS,
  validateSectionVisibilityValue,
  validateSlugFormat,
  validateUnitFieldValue,
  validateUnitUrl,
} from "@/lib/edit/validators";

// ---------------------------------------------------------------------------
// isEditableField
// ---------------------------------------------------------------------------

describe("isEditableField", () => {
  it("admits exactly the allowlist", () => {
    expect(isEditableField("overview")).toBe(true);
    expect(isEditableField("slug")).toBe(true);
    // #836 — the manual-Highlights override field name (the route additionally
    // gates it behind SELF_EDIT_MANUAL_HIGHLIGHTS).
    expect(isEditableField("selectedHighlightPmids")).toBe(true);
  });

  it("admits the seven section-visibility keys", () => {
    for (const f of SECTION_VISIBILITY_FIELDS) {
      expect(isEditableField(f)).toBe(true);
    }
  });

  it("rejects every other field name", () => {
    for (const f of ["email", "status", "preferredName", "orcid", "", "OVERVIEW"]) {
      expect(isEditableField(f)).toBe(false);
    }
  });

  it("rejects hideDisclosures — COI is compliance-mandated, never hideable", () => {
    // The deliberate omission from the allowlist is the 400 gate on the route.
    expect(isEditableField("hideDisclosures")).toBe(false);
    expect(isSectionVisibilityField("hideDisclosures")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// section visibility (section-visibility-spec.md)
// ---------------------------------------------------------------------------

describe("section visibility", () => {
  it("SECTION_VISIBILITY_FIELDS lists exactly the seven hideable sections", () => {
    expect([...SECTION_VISIBILITY_FIELDS]).toEqual([
      "hideMentoring",
      "hideEducation",
      "hideFunding",
      "hideCenters",
      "hidePostdocMentor",
      "hideClinicalTrials",
      "hideMethods",
    ]);
  });

  it("isSectionVisibilityField narrows only the seven keys", () => {
    for (const f of SECTION_VISIBILITY_FIELDS) {
      expect(isSectionVisibilityField(f)).toBe(true);
    }
    for (const f of ["overview", "slug", "hideDisclosures", "hidePublications", ""]) {
      expect(isSectionVisibilityField(f)).toBe(false);
    }
  });

  it("validateSectionVisibilityValue accepts exactly 'true' / 'false'", () => {
    expect(validateSectionVisibilityValue("true")).toEqual({ ok: true, value: "true" });
    expect(validateSectionVisibilityValue("false")).toEqual({ ok: true, value: "false" });
  });

  it("validateSectionVisibilityValue rejects any other value", () => {
    for (const bad of ["True", "1", "yes", "", "hidden", "null"]) {
      expect(validateSectionVisibilityValue(bad)).toEqual({ ok: false, error: "invalid_value" });
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizeOverview  (self-edit-spec.md edge cases 8, 9)
// ---------------------------------------------------------------------------

describe("sanitizeOverview — allowed content", () => {
  it("keeps the structural tag allowlist", () => {
    const r = sanitizeOverview("<p>Hello <strong>bold</strong> <em>it</em></p><ul><li>x</li></ul>");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain("<p>");
    expect(r.value).toContain("<strong>");
    expect(r.value).toContain("<em>");
    expect(r.value).toContain("<ul>");
    expect(r.value).toContain("<li>");
  });

  it("normalizes <b> to <strong> and <i> to <em>", () => {
    const r = sanitizeOverview("<p><b>bold</b> and <i>italic</i></p>");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain("<strong>bold</strong>");
    expect(r.value).toContain("<em>italic</em>");
    expect(r.value).not.toContain("<b>");
    expect(r.value).not.toContain("<i>");
  });
});

describe("sanitizeOverview — XSS boundary (edge case 8)", () => {
  it("strips <script> and its content", () => {
    const r = sanitizeOverview("<p>safe</p><script>alert(1)</script>");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain("safe");
    expect(r.value).not.toContain("script");
    expect(r.value).not.toContain("alert");
  });

  it("strips event-handler attributes", () => {
    const r = sanitizeOverview('<p onclick="steal()">text</p>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain("text");
    expect(r.value).not.toContain("onclick");
    expect(r.value).not.toContain("steal");
  });

  it("strips disallowed tags but keeps their text", () => {
    const r = sanitizeOverview("<div>kept</div><h1>also</h1><span>here</span>");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain("kept");
    expect(r.value).toContain("also");
    expect(r.value).toContain("here");
    expect(r.value).not.toContain("<div");
    expect(r.value).not.toContain("<h1");
    expect(r.value).not.toContain("<span");
  });

  it("drops <img> and <iframe> entirely", () => {
    const r = sanitizeOverview('<p><img src=x onerror="alert(1)">body</p><iframe src="evil"></iframe>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain("body");
    expect(r.value).not.toContain("img");
    expect(r.value).not.toContain("iframe");
    expect(r.value).not.toContain("onerror");
  });
});

describe("sanitizeOverview — links", () => {
  it("keeps an https link and hardens it with rel + target", () => {
    const r = sanitizeOverview('<p><a href="https://example.com">site</a></p>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('href="https://example.com"');
    expect(r.value).toContain('rel="noopener noreferrer nofollow"');
    expect(r.value).toContain('target="_blank"');
  });

  it("keeps a mailto link with rel but no target", () => {
    const r = sanitizeOverview('<p><a href="mailto:a@b.edu">mail</a></p>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('href="mailto:a@b.edu"');
    expect(r.value).toContain('rel="noopener noreferrer nofollow"');
    expect(r.value).not.toContain("target");
  });

  it("drops a javascript: href but keeps the link text", () => {
    const r = sanitizeOverview('<p><a href="javascript:alert(1)">click</a></p>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain("click");
    expect(r.value).not.toContain("javascript");
    expect(r.value).not.toContain("href");
  });

  it("drops a data: href", () => {
    const r = sanitizeOverview('<p><a href="data:text/html;base64,PHM=">x</a></p>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toContain("data:");
    expect(r.value).not.toContain("href");
  });
});

describe("sanitizeOverview — emptiness and length (edge case 9)", () => {
  it("treats an empty string as a valid empty overview", () => {
    expect(sanitizeOverview("")).toEqual({ ok: true, value: "" });
  });

  it("normalizes a structurally-empty document to an empty string", () => {
    for (const empty of ["<p></p>", "<p><br></p>", "<p>   </p>", "<ul><li></li></ul>"]) {
      expect(sanitizeOverview(empty)).toEqual({ ok: true, value: "" });
    }
  });

  it("accepts content at the 20,000-char boundary", () => {
    const r = sanitizeOverview(`<p>${"a".repeat(19_000)}</p>`);
    expect(r.ok).toBe(true);
  });

  it("rejects sanitized HTML over 20,000 chars", () => {
    const r = sanitizeOverview(`<p>${"a".repeat(21_000)}</p>`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("too_long");
    expect(r.length).toBeGreaterThan(20_000);
  });

  it("rejects a pathologically large raw payload without sanitizing it", () => {
    const r = sanitizeOverview("a".repeat(200_000));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("too_long");
  });
});

// ---------------------------------------------------------------------------
// validateSlugFormat
// ---------------------------------------------------------------------------

describe("validateSlugFormat", () => {
  it("accepts a well-formed slug", () => {
    expect(validateSlugFormat("jane-smith-2")).toEqual({ ok: true, value: "jane-smith-2" });
  });

  it("lowercases and trims", () => {
    expect(validateSlugFormat("  Jane-Smith  ")).toEqual({ ok: true, value: "jane-smith" });
  });

  it("rejects leading/trailing hyphens, underscores, spaces, and empties", () => {
    for (const bad of ["-jane", "jane-", "jane_smith", "jane smith", "", "jane.smith"]) {
      const r = validateSlugFormat(bad);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects a doubled hyphen", () => {
    const r = validateSlugFormat("jane--smith");
    expect(r).toEqual({ ok: false, error: "format" });
  });

  it("rejects a slug over 64 characters", () => {
    const r = validateSlugFormat("a".repeat(65));
    expect(r).toEqual({ ok: false, error: "too_long" });
  });

  it("rejects a reserved route segment", () => {
    expect(validateSlugFormat("by-cwid")).toEqual({ ok: false, error: "reserved" });
  });

  it("rejects the expanded reserved-word denylist (#497 §6.1)", () => {
    for (const w of ["search", "about", "api", "edit", "scholars", "admin", "login"]) {
      expect(validateSlugFormat(w)).toEqual({ ok: false, error: "reserved" });
    }
  });

  it("admits a name slug that merely contains a reserved word as a part", () => {
    expect(validateSlugFormat("jane-about-smith")).toEqual({
      ok: true,
      value: "jane-about-smith",
    });
  });
});

// ---------------------------------------------------------------------------
// checkSlugCollision  (self-edit-spec.md edge cases 10, 11, 20, 21)
// ---------------------------------------------------------------------------

type SlugClient = Parameters<typeof checkSlugCollision>[2];

function slugClient(rows: {
  scholar?: unknown;
  fieldOverride?: unknown;
  slugHistory?: unknown;
}): SlugClient {
  return {
    scholar: { findFirst: vi.fn().mockResolvedValue(rows.scholar ?? null) },
    fieldOverride: { findFirst: vi.fn().mockResolvedValue(rows.fieldOverride ?? null) },
    slugHistory: { findFirst: vi.fn().mockResolvedValue(rows.slugHistory ?? null) },
  } as unknown as SlugClient;
}

describe("checkSlugCollision", () => {
  it("passes when the slug is free everywhere", async () => {
    expect(await checkSlugCollision("free", "cwid1", slugClient({}))).toEqual({ ok: true });
  });

  it("rejects a slug another live scholar already holds", async () => {
    const r = await checkSlugCollision("taken", "cwid1", slugClient({ scholar: { cwid: "cwid2" } }));
    expect(r).toEqual({ ok: false, error: "collision" });
  });

  it("rejects a slug another CWID has as a field override", async () => {
    const r = await checkSlugCollision("taken", "cwid1", slugClient({ fieldOverride: { id: "fo1" } }));
    expect(r).toEqual({ ok: false, error: "collision" });
  });

  it("rejects a slug that is another scholar's former slug (identity-bleed guard)", async () => {
    const r = await checkSlugCollision("old", "cwid1", slugClient({ slugHistory: { oldSlug: "old" } }));
    expect(r).toEqual({ ok: false, error: "collision" });
  });

  it("excludes the target CWID from every lookup (own-history reclaim is allowed)", async () => {
    const client = slugClient({});
    await checkSlugCollision("mine", "cwid1", client);
    expect(client.scholar.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cwid: { not: "cwid1" } }),
      }),
    );
    expect(client.fieldOverride.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityId: { not: "cwid1" } }),
      }),
    );
    expect(client.slugHistory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { oldSlug: "mine", currentCwid: { not: "cwid1" } },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// publicationAuthorshipExists  (self-edit-spec.md edge case 18)
// ---------------------------------------------------------------------------

type AuthorClient = Parameters<typeof publicationAuthorshipExists>[2];

function authorClient(row: unknown): AuthorClient {
  return {
    publicationAuthor: { findFirst: vi.fn().mockResolvedValue(row) },
  } as unknown as AuthorClient;
}

describe("publicationAuthorshipExists", () => {
  it("is true when a confirmed authorship row exists", async () => {
    expect(await publicationAuthorshipExists("123", "cwid1", authorClient({ id: "pa1" }))).toBe(true);
  });

  it("is false when no authorship row exists", async () => {
    expect(await publicationAuthorshipExists("123", "cwid1", authorClient(null))).toBe(false);
  });

  it("only counts confirmed authorships", async () => {
    const client = authorClient(null);
    await publicationAuthorshipExists("123", "cwid1", client);
    expect(client.publicationAuthor.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pmid: "123", cwid: "cwid1", isConfirmed: true },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// findSuppressibleEntityOwner + isChairAppointment  (#160)
// ---------------------------------------------------------------------------

type OwnerClient = Parameters<typeof findSuppressibleEntityOwner>[2];

function ownerClient(rows: {
  grant?: unknown;
  education?: unknown;
  appointment?: unknown;
}): OwnerClient {
  return {
    grant: { findUnique: vi.fn().mockResolvedValue(rows.grant ?? null) },
    education: { findUnique: vi.fn().mockResolvedValue(rows.education ?? null) },
    appointment: { findUnique: vi.fn().mockResolvedValue(rows.appointment ?? null) },
  } as unknown as OwnerClient;
}

describe("findSuppressibleEntityOwner (#160)", () => {
  it("resolves a grant owner (title null — grants carry no chair guard)", async () => {
    expect(
      await findSuppressibleEntityOwner("grant", "INFOED-1-abc", ownerClient({ grant: { cwid: "abc" } })),
    ).toEqual({ ownerCwid: "abc", title: null });
  });

  it("resolves an appointment owner with its title (fed to the chair guard)", async () => {
    expect(
      await findSuppressibleEntityOwner(
        "appointment",
        "APPT-1",
        ownerClient({ appointment: { cwid: "abc", title: "Professor of Medicine" } }),
      ),
    ).toEqual({ ownerCwid: "abc", title: "Professor of Medicine" });
  });

  it("returns null when no row carries the externalId (-> 400 at the route)", async () => {
    expect(await findSuppressibleEntityOwner("education", "MISSING", ownerClient({}))).toBeNull();
  });
});

type ChairClient = Parameters<typeof isChairAppointment>[2];

function chairClient(dept: { name: string } | null): ChairClient {
  return {
    department: { findFirst: vi.fn().mockResolvedValue(dept) },
  } as unknown as ChairClient;
}

describe("isChairAppointment (#160 D-leader)", () => {
  it("is true when the owner chairs a dept and the title matches that dept's chair phrase", async () => {
    expect(
      await isChairAppointment("abc", "Chair of Medicine", chairClient({ name: "Medicine" })),
    ).toBe(true);
  });

  it("is false for a non-chair title of a chair (their other appointments stay suppressible)", async () => {
    expect(
      await isChairAppointment("abc", "Professor of Medicine", chairClient({ name: "Medicine" })),
    ).toBe(false);
  });

  it("is false when the owner chairs no department", async () => {
    expect(await isChairAppointment("abc", "Chair of Medicine", chairClient(null))).toBe(false);
  });

  it("excludes vice/associate chairs (isChairTitleFor)", async () => {
    expect(
      await isChairAppointment("abc", "Vice-Chair of Medicine", chairClient({ name: "Medicine" })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateUnitUrl (#1021)
// ---------------------------------------------------------------------------

describe("validateUnitUrl", () => {
  it("accepts a well-formed https URL and trims whitespace", () => {
    expect(validateUnitUrl("  https://medicine.weill.cornell.edu/lab  ")).toEqual({
      ok: true,
      value: "https://medicine.weill.cornell.edu/lab",
    });
  });

  it("accepts an empty string — the curator clears the link", () => {
    expect(validateUnitUrl("")).toEqual({ ok: true, value: "" });
    expect(validateUnitUrl("   ")).toEqual({ ok: true, value: "" });
  });

  it("rejects http:// (https-only, mirrors clinicalProfileUrl)", () => {
    expect(validateUnitUrl("http://example.org")).toEqual({ ok: false, error: "invalid_url" });
  });

  it("rejects non-web schemes", () => {
    expect(validateUnitUrl("mailto:dept@cornell.edu")).toEqual({ ok: false, error: "invalid_url" });
    expect(validateUnitUrl("javascript:alert(1)")).toEqual({ ok: false, error: "invalid_url" });
  });

  it("rejects garbage that does not parse as a URL", () => {
    expect(validateUnitUrl("not a url")).toEqual({ ok: false, error: "invalid_url" });
    expect(validateUnitUrl("example.org")).toEqual({ ok: false, error: "invalid_url" });
  });

  it("rejects a value over 512 chars", () => {
    const tooLong = "https://example.org/" + "a".repeat(520);
    expect(validateUnitUrl(tooLong)).toEqual({ ok: false, error: "url_too_long" });
  });
});

// ---------------------------------------------------------------------------
// EDITABLE_UNIT_FIELDS / validateUnitFieldValue dispatch (#1021)
// ---------------------------------------------------------------------------

describe("unit field allowlist + dispatch", () => {
  it("`url` is an editable unit field", () => {
    expect(isEditableUnitField("url")).toBe(true);
  });

  it("validateUnitFieldValue dispatches `url` to validateUnitUrl", () => {
    expect(validateUnitFieldValue("url", "https://example.org")).toEqual({
      ok: true,
      value: "https://example.org",
    });
    expect(validateUnitFieldValue("url", "http://example.org")).toEqual({
      ok: false,
      error: "invalid_url",
    });
  });
});
