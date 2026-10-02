import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HoverPrefetchLink } from "@/components/search/hover-prefetch-link";

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean | null;
    children: React.ReactNode;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

describe("HoverPrefetchLink", () => {
  it("does not prefetch until hover, then hands Next the default (auto) prefetch", () => {
    const onMouseEnter = vi.fn();
    render(
      <HoverPrefetchLink href="/jane-doe" onMouseEnter={onMouseEnter}>
        Jane Doe
      </HoverPrefetchLink>,
    );
    const link = screen.getByRole("link", { name: "Jane Doe" });
    expect(link.getAttribute("data-prefetch")).toBe("false");
    fireEvent.mouseEnter(link);
    expect(link.getAttribute("data-prefetch")).toBe("null");
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
  });

  it("enables prefetch on touch intent", () => {
    render(<HoverPrefetchLink href="/jane-doe">Jane Doe</HoverPrefetchLink>);
    const link = screen.getByRole("link", { name: "Jane Doe" });
    fireEvent.touchStart(link);
    expect(link.getAttribute("data-prefetch")).toBe("null");
  });
});
