import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  AuthorChipRow,
  type AuthorChip,
} from "@/components/publication/author-chip-row";

const baseChip = (over: Partial<AuthorChip>): AuthorChip => ({
  name: "Test Author",
  cwid: "test001",
  slug: "test-author",
  identityImageEndpoint: "/headshot/test001",
  isFirst: false,
  isLast: false,
  ...over,
});

// Issue #132 — chip rows must render in the order the surface API hands them
// to us (PubMed author position ascending). The component MUST NOT re-sort or
// re-order the input array.
describe("AuthorChipRow ordering", () => {
  it("renders chips in input array order", () => {
    const authors: AuthorChip[] = [
      baseChip({ name: "Tony Rosen", cwid: "aer2006", slug: "tony-rosen", isFirst: true }),
      baseChip({ name: "Veronica Lo Faso", cwid: "vel2001", slug: "vel2001" }),
      baseChip({ name: "Christopher Reisig", cwid: "chr2019", slug: "chr2019" }),
      baseChip({ name: "Neal Flomenbaum", cwid: "nef2002", slug: "nef2002" }),
      baseChip({ name: "Rahul Sharma", cwid: "ras2022", slug: "ras2022", isLast: true }),
    ];
    render(<AuthorChipRow authors={authors} />);
    const rendered = screen.getAllByRole("link").map((el) => {
      const spans = el.querySelectorAll("span");
      return spans[spans.length - 1]?.textContent?.trim() ?? "";
    });
    expect(rendered).toEqual([
      "Tony Rosen",
      "Veronica Lo Faso",
      "Christopher Reisig",
      "Neal Flomenbaum",
      "Rahul Sharma",
    ]);
  });

  it("preserves a senior-author-last ordering for chip rows", () => {
    // Inverted input proves the component does not impose its own sort —
    // last author is rendered last only when the surface puts them last.
    const authors: AuthorChip[] = [
      baseChip({ name: "Senior", cwid: "snr001", slug: "snr", isLast: true }),
      baseChip({ name: "First", cwid: "fst001", slug: "fst", isFirst: true }),
    ];
    render(<AuthorChipRow authors={authors} />);
    const rendered = screen.getAllByRole("link").map((el) => {
      const spans = el.querySelectorAll("span");
      return spans[spans.length - 1]?.textContent?.trim() ?? "";
    });
    // Component renders in input order — Senior first, First second — even
    // though the data is "wrong". This test pins the contract: surfaces are
    // responsible for ordering, the component is responsible for rendering.
    expect(rendered).toEqual(["Senior", "First"]);
  });

  it("renders +N more pill when authors exceed the 5-chip cap", () => {
    const authors: AuthorChip[] = Array.from({ length: 8 }, (_, i) =>
      baseChip({
        name: `Author ${i + 1}`,
        cwid: `c${i + 1}`,
        slug: `c${i + 1}`,
        isFirst: i === 0,
        isLast: i === 7,
      }),
    );
    render(<AuthorChipRow authors={authors} />);
    const links = screen.getAllByRole("link").map((el) => {
      const spans = el.querySelectorAll("span");
      return spans[spans.length - 1]?.textContent?.trim() ?? "";
    });
    expect(links).toEqual([
      "Author 1",
      "Author 2",
      "Author 3",
      "Author 4",
      "Author 5",
    ]);
    expect(screen.getByText(/\+3 more/)).toBeTruthy();
  });
});
