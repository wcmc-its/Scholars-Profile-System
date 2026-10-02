/**
 * PersonPopover loads on pointer-enter (before the HoverCard's open delay
 * elapses) and shares one request per URL across every popover on the page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

vi.mock("@/components/ui/hover-card", () => ({
  HoverCard: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "hovercard", onClick: () => onOpenChange?.(true) },
      children,
    ),
  // Forward the trigger's pointer handler onto the child, as Radix's Slot does.
  HoverCardTrigger: ({
    children,
    onPointerEnter,
  }: {
    children: React.ReactElement;
    onPointerEnter?: () => void;
  }) =>
    React.cloneElement(children as React.ReactElement<{ onPointerEnter?: () => void }>, {
      onPointerEnter,
    }),
  HoverCardContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

import { PersonPopover, resetPopoverCache } from "@/components/scholar/person-popover";

const payload = {
  header: {
    cwid: "abc1234",
    preferredName: "Jane Doe",
    postnominal: null,
    primaryTitle: "Professor",
    primaryDepartment: "Medicine",
    slug: "jane-doe",
    identityImageEndpoint: "/headshot/abc1234",
    totalPubCount: 3,
    totalGrantCount: 0,
    topTopic: null,
  },
  authorship: null,
  coPubs: null,
  topicRank: null,
  recentPubs: [],
  recentGrants: [],
  topSponsor: null,
  methodFamilies: [],
};

let fetchFn: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetPopoverCache();
  fetchFn = vi.fn(async () => ({ ok: true, json: async () => payload }));
  global.fetch = fetchFn as unknown as typeof fetch;
});

describe("PersonPopover early fetch", () => {
  it("starts the request on pointer-enter, before the card opens", () => {
    render(
      <PersonPopover cwid="abc1234" surface="facet">
        <a href="#">Jane</a>
      </PersonPopover>,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    fireEvent.pointerEnter(screen.getByText("Jane"));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("shares one request across popovers for the same scholar and context", async () => {
    render(
      <>
        <PersonPopover cwid="abc1234" surface="facet">
          <a href="#">First</a>
        </PersonPopover>
        <PersonPopover cwid="abc1234" surface="facet">
          <a href="#">Second</a>
        </PersonPopover>
      </>,
    );
    fireEvent.pointerEnter(screen.getByText("First"));
    fireEvent.pointerEnter(screen.getByText("Second"));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Both cards resolve from the one shared request.
    expect(await screen.findAllByText("View profile")).toHaveLength(2);
  });

  it("still loads when opened without a pointer-enter (touch / keyboard)", async () => {
    render(
      <PersonPopover cwid="abc1234" surface="facet">
        <a href="#">Jane</a>
      </PersonPopover>,
    );
    fireEvent.click(screen.getByTestId("hovercard"));
    expect(await screen.findByText("View profile")).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
