import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";

function getRoot(container: HTMLElement): HTMLElement {
  const el = container.querySelector("[data-headshot-state]");
  if (!el) throw new Error("HeadshotAvatar root with data-headshot-state not found");
  return el as HTMLElement;
}

describe("HeadshotAvatar", () => {
  it("renders fallback state when identityImageEndpoint is empty", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid="abc1234"
        preferredName="Jane Doe"
        identityImageEndpoint=""
        size="md"
      />
    );
    const root = getRoot(container);
    expect(root.getAttribute("data-headshot-state")).toBe("fallback");
    // Fallback initials are visible
    expect(container.textContent).toContain("JD");
  });

  it("renders fallback state when cwid is empty (defensive)", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid=""
        preferredName="Jane Doe"
        identityImageEndpoint="https://directory.weill.cornell.edu/api/v1/person/profile/abc.png?returnGenericOn404=false"
        size="md"
      />
    );
    const root = getRoot(container);
    expect(root.getAttribute("data-headshot-state")).toBe("fallback");
  });

  it("starts in loading state when identityImageEndpoint is non-empty", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid="abc1234"
        preferredName="Jane Doe"
        identityImageEndpoint="https://directory.weill.cornell.edu/api/v1/person/profile/abc1234.png?returnGenericOn404=false"
        size="md"
      />
    );
    const root = getRoot(container);
    // jsdom never resolves the image, so we observe the initial loading state
    expect(root.getAttribute("data-headshot-state")).toBe("loading");
  });

  it("applies size=lg classes for profile sidebar", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid="abc1234"
        preferredName="Jane Doe"
        identityImageEndpoint=""
        size="lg"
      />
    );
    const root = getRoot(container);
    expect(root.className).toContain("h-24");
    expect(root.className).toContain("sm:h-28");
  });

  it("applies size=md classes for search row", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid="abc1234"
        preferredName="Jane Doe"
        identityImageEndpoint=""
        size="md"
      />
    );
    const root = getRoot(container);
    expect(root.className).toContain("h-12");
    expect(root.className).toContain("w-12");
  });

  it("applies size=sm classes for chip row (Phase 2 reserved)", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid="abc1234"
        preferredName="Jane Doe"
        identityImageEndpoint=""
        size="sm"
      />
    );
    const root = getRoot(container);
    expect(root.className).toContain("size-6");
  });
});
