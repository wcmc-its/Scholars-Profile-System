/**
 * #2209 — a publication-title control must ALWAYS have a discernible accessible
 * name (WCAG 4.1.2), and must never render as an empty click target.
 *
 * The prod defect: three publications carry an empty `title`, so the profile row
 * emitted `<button type="button" class="text-left hover:…"></button>` — a
 * completely empty, unlabeled control whose entire purpose is to open the detail
 * modal. The name must be a property of the component, not an accident of
 * whether that row's title happens to be populated, so `pubTitleProps` sets
 * `aria-label` on EVERY title control, titled or not.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  UNTITLED_PUBLICATION,
  pubTitleAccessibleName,
  pubTitleProps,
} from "@/components/publication/pub-html";
import { sanitizePubTitle } from "@/lib/utils";

vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/publication/author-chip-row", () => ({
  AuthorChipRow: () => <div data-testid="chip-row" />,
}));
vi.mock("@/components/publication/publication-meta", () => ({
  PublicationMeta: () => <div data-testid="meta" />,
}));

import { PublicationRow } from "@/components/profile/publication-row";
import type { ProfilePublication } from "@/lib/api/profile";

describe("pubTitleAccessibleName", () => {
  it("is the plain text of the title, markup stripped", () => {
    expect(pubTitleAccessibleName("<i>BRCA1</i> in H<sub>2</sub>O")).toBe("BRCA1 in H2O");
  });

  it("falls back for empty, whitespace-only, markup-only and nullish titles", () => {
    for (const v of ["", "   ", "<sup></sup>", null, undefined]) {
      expect(pubTitleAccessibleName(v)).toBe(UNTITLED_PUBLICATION);
    }
  });

  it("survives a search-highlight fragment without splitting the words", () => {
    expect(pubTitleAccessibleName('Acute <mark class="pill">Myeloid</mark> Leukemia')).toBe(
      "Acute Myeloid Leukemia",
    );
  });
});

describe("pubTitleProps", () => {
  it("names a populated title with its own visible text (WCAG 2.5.3 Label in Name)", () => {
    const p = pubTitleProps(sanitizePubTitle("A real <i>title</i>"), "text-left");
    expect(p["aria-label"]).toBe("A real title");
    expect(p.dangerouslySetInnerHTML.__html).toBe("A real <i>title</i>");
    // No stand-in styling on a titled row.
    expect(p.className).toBe("text-left");
  });

  it("renders AND announces the stand-in when the title is blank", () => {
    const p = pubTitleProps("", "text-left");
    expect(p["aria-label"]).toBe(UNTITLED_PUBLICATION);
    expect(p.dangerouslySetInnerHTML.__html).toBe(UNTITLED_PUBLICATION);
    expect(p.className).toContain("italic");
    expect(p.className).toContain("text-left");
  });
});

function makePub(title: string): ProfilePublication {
  return {
    pmid: "30258629",
    title,
    journal: "Cancer Metab",
    year: 2018,
    citationCount: 0,
    doi: null,
    pmcid: null,
    pubmedUrl: null,
    ecommonsLink: null,
    hasAbstract: false,
    authorship: { isFirst: false, isLast: false, isPenultimate: false },
    wcmAuthors: [],
  } as unknown as ProfilePublication;
}

describe("PublicationRow — the reported prod surface", () => {
  it("gives the modal trigger an accessible name when the title is EMPTY", () => {
    render(<PublicationRow pub={makePub("")} />);
    const button = screen.getByRole("button", { name: UNTITLED_PUBLICATION });
    // The defect was a button with no accessible name AND no text content.
    expect(button.textContent).toBe(UNTITLED_PUBLICATION);
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("gives the modal trigger an accessible name when the title is present", () => {
    render(<PublicationRow pub={makePub("CD38 is methylated in <i>prostate</i> cancer")} />);
    const button = screen.getByRole("button", {
      name: "CD38 is methylated in prostate cancer",
    });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("never emits a button with an empty accessible name, whatever the title", () => {
    for (const title of ["", "   ", "<sup></sup>", "Real title"]) {
      const { unmount } = render(<PublicationRow pub={makePub(title)} />);
      const button = screen.getByRole("button");
      const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
      expect(name.trim(), `empty accessible name for title=${JSON.stringify(title)}`).not.toBe("");
      unmount();
    }
  });
});
