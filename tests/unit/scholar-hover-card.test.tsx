/**
 * ScholarHoverCard reused with a new cwid (the grant attribution queue's
 * detail pane keeps one instance and swaps the scholar) must load the new
 * person, not keep the previous person's card. And the optional `footer`
 * slot (reports 24 and 25): an action above the bottom row and a link at its
 * left; a card given no footer is the card every other caller always had.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import { ScholarHoverCard, type ScholarCardFooter } from "@/components/edit/scholar-hover-card";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (over: object = {}) => ({
  cwid: "abc1001",
  name: "Example Person",
  slug: "example-person",
  email: null,
  hasHeadshot: false,
  isVisible: true,
  personType: "Full-time faculty",
  titles: [],
  hasOverview: false,
  overviewExcerpt: null,
  overviewUpdatedAt: null,
  ...over,
});

/** Hover the name and wait for the open card. Each test uses its own cwid: loaded cards are cached per page. */
async function open(cwid: string, footer?: ScholarCardFooter, over: object = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(card({ cwid, ...over })), { status: 200 })),
  );
  render(
    <ScholarHoverCard cwid={cwid} footer={footer}>
      <span>Example Person</span>
    </ScholarHoverCard>,
  );
  fireEvent.pointerEnter(screen.getByText("Example Person"));
  const content = await screen.findByTestId(`scholar-card-${cwid}`, {}, { timeout: 3000 });
  await within(content).findByText("Full-time faculty");
  return content;
}

const FOOTER: ScholarCardFooter = {
  action: <a href="/only">Show only this person&rsquo;s papers</a>,
  link: <a href="/bibliometrics">Full bibliometrics report</a>,
};

describe("ScholarHoverCard", () => {
  it("loads the new scholar when the cwid changes", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <ScholarHoverCard cwid="aaa1001">
        <span>First</span>
      </ScholarHoverCard>,
    );
    fireEvent.pointerEnter(screen.getByText("First"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(
      <ScholarHoverCard cwid="bbb2002">
        <span>Second</span>
      </ScholarHoverCard>,
    );
    fireEvent.pointerEnter(screen.getByText("Second"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/edit/scholar-card/bbb2002");
    vi.unstubAllGlobals();
  });

  it("no footer: the card ends with Public profile alone, at the right, as before", async () => {
    const content = await open("nof1001");
    expect(content.querySelector("[data-testid^='scholar-card-action-']")).toBeNull();
    const links = within(content).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Public profile"]);
    const row = links[0].parentElement!;
    expect(row.className).toContain("justify-end");
    expect(row.className).not.toContain("justify-between");
    expect(content.lastElementChild).toBe(row);
  });

  it("no footer and a hidden profile: no bottom row at all", async () => {
    const content = await open("hid1002", undefined, { isVisible: false });
    expect(within(content).queryAllByRole("link")).toEqual([]);
    expect(content.querySelector(".bg-apollo-surface-2")).toBeNull();
  });

  it("footer: the action above the bottom row; the link at its left, Public profile at its right", async () => {
    const content = await open("foo1003", FOOTER);
    const links = within(content).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      "Show only this person\u2019s papers",
      "Full bibliometrics report",
      "Public profile",
    ]);
    expect(within(content).getByTestId("scholar-card-action-foo1003").contains(links[0])).toBe(true);
    const row = links[2].parentElement!;
    expect(links[1].parentElement).toBe(row);
    expect(row.className).toContain("justify-between");
    expect(content.lastElementChild).toBe(row);
    expect(within(content).getByTestId("scholar-card-action-foo1003").nextElementSibling).toBe(row);
  });

  it("footer with the action only: Public profile stays alone at the right", async () => {
    const content = await open("act1004", { action: FOOTER.action, link: null });
    const links = within(content).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Show only this person\u2019s papers", "Public profile"]);
    expect(links[1].parentElement!.className).toContain("justify-end");
  });

  it("footer on a hidden profile: the link shows without Public profile", async () => {
    const content = await open("hid1005", FOOTER, { isVisible: false });
    expect(within(content).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Show only this person\u2019s papers",
      "Full bibliometrics report",
    ]);
  });
});
