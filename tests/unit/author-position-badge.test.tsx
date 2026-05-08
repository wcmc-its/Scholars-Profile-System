import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  AuthorPositionBadge,
  deriveAuthorPositionRole,
  matchesPositionFilter,
  positionBucketForRole,
  type AuthorPositionRole,
} from "@/components/profile/author-position-badge";

describe("AuthorPositionBadge", () => {
  it("returns null for null role (middle author)", () => {
    const { container } = render(<AuthorPositionBadge role={null} />);
    expect(container.firstChild).toBeNull();
  });

  it.each<[AuthorPositionRole, string]>([
    ["First and senior author", "senior"],
    ["Senior author", "senior"],
    ["Co-senior author", "senior"],
    ["First author", "first"],
    ["Co-first author", "first"],
  ])("renders %s as the %s variant", (role, variant) => {
    render(<AuthorPositionBadge role={role} />);
    const el = screen.getByText(role);
    expect(el.className).toContain(`author-position-badge--${variant}`);
  });

  it("never emits the deprecated 'Co-last author' string", () => {
    // Sanity check that the rename from #18's "Co-last author" → "Co-senior
    // author" landed everywhere.
    render(<AuthorPositionBadge role={"Co-senior author"} />);
    expect(screen.queryByText(/Co-last author/)).toBeNull();
  });
});

describe("deriveAuthorPositionRole", () => {
  it("returns null for middle authors", () => {
    expect(
      deriveAuthorPositionRole(
        { isFirst: false, isLast: false },
        [
          { isFirst: true, isLast: false },
          { isFirst: false, isLast: false },
          { isFirst: false, isLast: true },
        ],
      ),
    ).toBeNull();
  });

  it("returns 'First and senior author' when both flags set (sole/two-author paper)", () => {
    expect(
      deriveAuthorPositionRole(
        { isFirst: true, isLast: true },
        [{ isFirst: true, isLast: true }],
      ),
    ).toBe("First and senior author");
  });

  it("returns 'Senior author' when one last-author flag exists", () => {
    expect(
      deriveAuthorPositionRole(
        { isFirst: false, isLast: true },
        [
          { isFirst: true, isLast: false },
          { isFirst: false, isLast: true },
        ],
      ),
    ).toBe("Senior author");
  });

  it("returns 'Co-senior author' when ≥2 authors share isLast", () => {
    expect(
      deriveAuthorPositionRole(
        { isFirst: false, isLast: true },
        [
          { isFirst: true, isLast: false },
          { isFirst: false, isLast: true },
          { isFirst: false, isLast: true },
        ],
      ),
    ).toBe("Co-senior author");
  });

  it("returns 'Co-first author' when ≥2 authors share isFirst", () => {
    expect(
      deriveAuthorPositionRole(
        { isFirst: true, isLast: false },
        [
          { isFirst: true, isLast: false },
          { isFirst: true, isLast: false },
          { isFirst: false, isLast: true },
        ],
      ),
    ).toBe("Co-first author");
  });
});

describe("matchesPositionFilter", () => {
  it("matches everything for 'all'", () => {
    expect(matchesPositionFilter(null, "all")).toBe(true);
    expect(matchesPositionFilter("First author", "all")).toBe(true);
    expect(matchesPositionFilter("Senior author", "all")).toBe(true);
  });

  it("co_author matches only the null/middle-author role", () => {
    expect(matchesPositionFilter(null, "co_author")).toBe(true);
    expect(matchesPositionFilter("First author", "co_author")).toBe(false);
    expect(matchesPositionFilter("Senior author", "co_author")).toBe(false);
    expect(matchesPositionFilter("Co-first author", "co_author")).toBe(false);
  });

  it("first matches first/co-first, not senior/co-senior", () => {
    expect(matchesPositionFilter("First author", "first")).toBe(true);
    expect(matchesPositionFilter("Co-first author", "first")).toBe(true);
    expect(matchesPositionFilter("Senior author", "first")).toBe(false);
    expect(matchesPositionFilter("Co-senior author", "first")).toBe(false);
  });

  it("senior matches senior/co-senior, not first/co-first", () => {
    expect(matchesPositionFilter("Senior author", "senior")).toBe(true);
    expect(matchesPositionFilter("Co-senior author", "senior")).toBe(true);
    expect(matchesPositionFilter("First author", "senior")).toBe(false);
    expect(matchesPositionFilter("Co-first author", "senior")).toBe(false);
  });

  it("'First and senior author' matches BOTH first and senior filters", () => {
    expect(matchesPositionFilter("First and senior author", "first")).toBe(true);
    expect(matchesPositionFilter("First and senior author", "senior")).toBe(true);
    expect(matchesPositionFilter("First and senior author", "co_author")).toBe(false);
  });
});

describe("positionBucketForRole", () => {
  it("classifies null as co_author", () => {
    expect(positionBucketForRole(null)).toBe("co_author");
  });

  it("classifies first/co-first as first", () => {
    expect(positionBucketForRole("First author")).toBe("first");
    expect(positionBucketForRole("Co-first author")).toBe("first");
  });

  it("classifies senior/co-senior as senior", () => {
    expect(positionBucketForRole("Senior author")).toBe("senior");
    expect(positionBucketForRole("Co-senior author")).toBe("senior");
  });

  it("classifies dual-role as senior (two-author papers convention)", () => {
    expect(positionBucketForRole("First and senior author")).toBe("senior");
  });
});
