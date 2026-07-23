import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
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

  it("emits a valid data-headshot-state when identityImageEndpoint is non-empty", () => {
    const { container } = render(
      <HeadshotAvatar
        cwid="abc1234"
        preferredName="Jane Doe"
        identityImageEndpoint="https://directory.weill.cornell.edu/api/v1/person/profile/abc1234.png?returnGenericOn404=false"
        size="md"
      />
    );
    const root = getRoot(container);
    // In jsdom the image never resolves to "loaded"; it transitions to either
    // "loading" or "fallback" (when Radix's primitive surfaces an error event
    // for the next/image wrapper). Both are valid runtime states; "image" is
    // not reachable without a real browser network stack.
    const state = root.getAttribute("data-headshot-state");
    expect(["loading", "fallback"]).toContain(state);
  });

  it("derives the URL from cwid when identityImageEndpoint is omitted, without forcing fallback (#1410)", () => {
    // SSR is deterministic (no img-load events fire), so data-headshot-state
    // reflects `noImage` directly. Omitting the endpoint must take the image
    // path (derived from cwid → "loading"), NOT the empty-endpoint fallback —
    // and an explicit "" must still force "fallback" (`??`, not `||`).
    const derived = renderToString(
      <HeadshotAvatar cwid="abc1234" preferredName="Jane Doe" size="md" />
    );
    const empty = renderToString(
      <HeadshotAvatar cwid="abc1234" preferredName="Jane Doe" identityImageEndpoint="" size="md" />
    );
    expect(derived).toContain('data-headshot-state="loading"');
    expect(empty).toContain('data-headshot-state="fallback"');
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

  it("hydrates without a mismatch — SSR renders no <img>, matching the initial client render (#1387)", () => {
    const props = {
      cwid: "abc1234",
      preferredName: "Jane Doe",
      identityImageEndpoint:
        "https://directory.weill.cornell.edu/api/v1/person/profile/abc1234.png?returnGenericOn404=false",
      size: "lg" as const,
    };
    // Radix AvatarImage is client-only; SSR must be fallback-only (no <img>) so
    // the deferred-mount initial client render matches it.
    const html = renderToString(<HeadshotAvatar {...props} />);
    expect(html).not.toContain("<img");

    const container = document.createElement("div");
    container.innerHTML = html;
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a) => errors.push(a.map(String).join(" ")));
    act(() => {
      hydrateRoot(container, <HeadshotAvatar {...props} />);
    });
    spy.mockRestore();
    const mismatch = errors.filter((e) =>
      /hydrat|did not match|server rendered|#?418/i.test(e)
    );
    expect(mismatch).toEqual([]);
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
