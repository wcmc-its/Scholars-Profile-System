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

  const renderedNames = () =>
    screen.getAllByRole("link").map((el) => {
      const spans = el.querySelectorAll("span");
      return spans[spans.length - 1]?.textContent?.trim() ?? "";
    });

  // #811 — the senior (last) author is the most important byline signal, so it
  // must never be sliced off the tail. On overflow the row keeps the first
  // (cap-1) authors, the +N pill, then the senior last:
  // [First] [Second] [Third] [Fourth] +N more [Senior]. The middle is hidden.
  it("pins the senior author to the tail and hides the middle on overflow", () => {
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
    // First four head authors, then the senior (Author 8) — Authors 5–7 hidden.
    expect(renderedNames()).toEqual([
      "Author 1",
      "Author 2",
      "Author 3",
      "Author 4",
      "Author 8",
    ]);
    // Overflow count excludes both the head chips and the pinned-to-tail senior.
    expect(screen.getByText(/\+3 more/)).toBeTruthy();
  });

  it("renders every author with no tail or overflow when within the cap", () => {
    const authors: AuthorChip[] = Array.from({ length: 5 }, (_, i) =>
      baseChip({
        name: `Author ${i + 1}`,
        cwid: `c${i + 1}`,
        slug: `c${i + 1}`,
        isFirst: i === 0,
        isLast: i === 4,
      }),
    );
    render(<AuthorChipRow authors={authors} />);
    // Exactly CHIP_CAP authors: all shown in order, no duplicate senior tail.
    expect(renderedNames()).toEqual([
      "Author 1",
      "Author 2",
      "Author 3",
      "Author 4",
      "Author 5",
    ]);
    expect(screen.queryByText(/more/)).toBeNull();
  });

  it("renders a single author (first == last) with no overflow tail", () => {
    render(
      <AuthorChipRow
        authors={[
          baseChip({ name: "Solo", cwid: "solo1", slug: "solo", isFirst: true, isLast: true }),
        ]}
      />,
    );
    expect(renderedNames()).toEqual(["Solo"]);
    expect(screen.queryByText(/more/)).toBeNull();
  });

  it("surfaces one co-last author at the tail when co-last authors overflow", () => {
    // 7 authors; the final two are co-last. The senior tail shows the last
    // co-last author (Author 7); the other co-last (Author 6) and the hidden
    // middle (Author 5) fall into the +N overflow.
    const authors: AuthorChip[] = Array.from({ length: 7 }, (_, i) =>
      baseChip({
        name: `Author ${i + 1}`,
        cwid: `c${i + 1}`,
        slug: `c${i + 1}`,
        isFirst: i === 0,
        isLast: i >= 5,
      }),
    );
    render(<AuthorChipRow authors={authors} />);
    const names = renderedNames();
    expect(names).toEqual([
      "Author 1",
      "Author 2",
      "Author 3",
      "Author 4",
      "Author 7",
    ]);
    expect(names[names.length - 1]).toBe("Author 7");
    expect(screen.getByText(/\+2 more/)).toBeTruthy();
  });
});

// #536 — a hidden identity class (doctoral student) keeps its name in the
// co-authorship row but gets no profile link (the route 404s).
describe("AuthorChipRow — hidden identity class (#536)", () => {
  it("renders a hidden-role author as plain text, not a profile link", () => {
    const authors: AuthorChip[] = [
      baseChip({
        name: "PI Faculty",
        cwid: "pi001",
        slug: "pi-faculty",
        roleCategory: "full_time_faculty",
        isFirst: true,
      }),
      baseChip({
        name: "Grad Student",
        cwid: "gs001",
        slug: "grad-student",
        roleCategory: "doctoral_student",
        isLast: true,
      }),
    ];
    render(<AuthorChipRow authors={authors} />);
    // Faculty chip links to the profile; the doctoral student does not.
    // #671 — profile links use the root `/{slug}` form (profilePath).
    expect(document.querySelector('a[href="/pi-faculty"]')).not.toBeNull();
    expect(document.querySelector('a[href="/grad-student"]')).toBeNull();
    // The hidden author's name is still visible (rendered as text).
    expect(screen.getByText("Grad Student")).toBeTruthy();
  });

  it("treats a missing roleCategory as linkable (fail-open)", () => {
    render(
      <AuthorChipRow
        authors={[baseChip({ name: "Unknown Role", cwid: "u001", slug: "unknown-role" })]}
      />,
    );
    expect(document.querySelector('a[href="/unknown-role"]')).not.toBeNull();
  });
});
