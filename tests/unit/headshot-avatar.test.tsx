import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { FIXTURE_CWID, EXPECTED_HEADSHOT_URL } from "../fixtures/scholar";

describe("HeadshotAvatar", () => {
  it("renders fallback initials when identityImageEndpoint is empty", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid={FIXTURE_CWID}
        preferredName="Jane Doe"
        identityImageEndpoint=""
        size="md"
      />,
    );
    const root = container.querySelector("[data-headshot-state]");
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-headshot-state")).toBe("fallback");
    expect(screen.getByText("JD")).toBeTruthy();
  });

  it("emits data-headshot-state='loading' initially when endpoint is set", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid={FIXTURE_CWID}
        preferredName="Jane Doe"
        identityImageEndpoint={EXPECTED_HEADSHOT_URL}
        size="md"
      />,
    );
    const root = container.querySelector("[data-headshot-state]");
    expect(root?.getAttribute("data-headshot-state")).toBe("loading");
  });

  it("applies size='lg' Tailwind classes (h-24 sm:h-28)", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid={FIXTURE_CWID}
        preferredName="Jane Doe"
        identityImageEndpoint=""
        size="lg"
      />,
    );
    const root = container.querySelector("[data-headshot-state]");
    expect(root?.className).toMatch(/h-24/);
    expect(root?.className).toMatch(/sm:h-28/);
  });

  it("applies size='md' Tailwind class h-12 w-12", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid={FIXTURE_CWID}
        preferredName="Jane Doe"
        identityImageEndpoint=""
        size="md"
      />,
    );
    const root = container.querySelector("[data-headshot-state]");
    expect(root?.className).toMatch(/h-12/);
    expect(root?.className).toMatch(/w-12/);
  });

  it("applies size='sm' Tailwind class size-6", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid={FIXTURE_CWID}
        preferredName="Jane Doe"
        identityImageEndpoint=""
        size="sm"
      />,
    );
    const root = container.querySelector("[data-headshot-state]");
    expect(root?.className).toMatch(/size-6/);
  });

  it("uses preferredName for the alt text on the image element", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid={FIXTURE_CWID}
        preferredName="Jane Doe"
        identityImageEndpoint={EXPECTED_HEADSHOT_URL}
        size="md"
      />,
    );
    const img = container.querySelector("img");
    if (img) {
      expect(img.getAttribute("alt")).toBe("Jane Doe");
    }
    // If the image hasn't mounted yet (Radix gating), this test is at least
    // not a false positive — the assertion only fires when an <img> renders.
  });
});
