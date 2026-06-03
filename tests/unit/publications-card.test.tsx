/**
 * `components/edit/publications-card.tsx` — list / filter / year-group /
 * optimistic hide-show / sole-author confirm dialog / admin-removed inline
 * text (#356 Phase 6 C7).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import {
  PublicationsCard,
  FIRST_HIDE_NOTICE_ACK_KEY,
} from "@/components/edit/publications-card";
import type { EditContextPublication } from "@/lib/api/edit-context";

const CWID = "self01";

function pub(overrides: Partial<EditContextPublication>): EditContextPublication {
  return {
    pmid: "pmid-1",
    title: "A publication",
    journal: "Journal X",
    year: 2025,
    state: "shown",
    suppressionId: null,
    isSoleDisplayedAuthor: false,
    ...overrides,
  };
}

function stubFetch(body: object, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockRefresh.mockReset();
  // Default to "first-hide notice already seen this session" so the existing
  // hide/show/sole-author specs exercise the post-acknowledgment path directly.
  // The first-hide notice block below clears this to test the notice itself.
  window.sessionStorage.clear();
  window.sessionStorage.setItem(FIRST_HIDE_NOTICE_ACK_KEY, "1");
});

describe("PublicationsCard — empty + count", () => {
  it("renders the empty-state copy with zero publications", () => {
    render(<PublicationsCard cwid={CWID} publications={[]} />);
    expect(
      screen.getByText("No publications are currently associated with your profile."),
    ).toBeTruthy();
  });

  it("renders the count and hidden-count", () => {
    const pubs = [
      pub({ pmid: "a", state: "shown" }),
      pub({ pmid: "b", state: "shown" }),
      pub({ pmid: "c", state: "hidden_by_self", suppressionId: "sup-c" }),
    ];
    render(<PublicationsCard cwid={CWID} publications={pubs} />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });
});

describe("PublicationsCard — filter", () => {
  it("filter narrows the list case-insensitively", () => {
    const pubs = [
      pub({ pmid: "a", title: "Alpha study" }),
      pub({ pmid: "b", title: "Beta study" }),
      pub({ pmid: "c", title: "Gamma study" }),
    ];
    render(<PublicationsCard cwid={CWID} publications={pubs} />);
    fireEvent.change(screen.getByTestId("publications-filter"), {
      target: { value: "alpha" },
    });
    expect(screen.getByText("Alpha study")).toBeTruthy();
    expect(screen.queryByText("Beta study")).toBeNull();
    expect(screen.queryByText("Gamma study")).toBeNull();
  });

  it("shows the no-match copy when the filter narrows to zero", () => {
    const pubs = [pub({ pmid: "a", title: "Alpha study" })];
    render(<PublicationsCard cwid={CWID} publications={pubs} />);
    fireEvent.change(screen.getByTestId("publications-filter"), {
      target: { value: "nothing matches this" },
    });
    expect(
      screen.getByText(/No publications match/i),
    ).toBeTruthy();
  });
});

describe("PublicationsCard — year grouping", () => {
  it("groups by year descending with 'Year unknown' last", () => {
    const pubs = [
      pub({ pmid: "a", year: 2024 }),
      pub({ pmid: "b", year: 2025 }),
      pub({ pmid: "c", year: null }),
      pub({ pmid: "d", year: 2024 }),
    ];
    render(<PublicationsCard cwid={CWID} publications={pubs} />);
    const headers = screen.getAllByText(/^(2024|2025|Year unknown)$/);
    const labels = headers.map((h) => h.textContent);
    // Header order = 2025 > 2024 > Year unknown.
    expect(labels.indexOf("2025")).toBeLessThan(labels.indexOf("2024"));
    expect(labels.indexOf("2024")).toBeLessThan(labels.indexOf("Year unknown"));
  });
});

describe("PublicationsCard — row states", () => {
  it("a 'shown' row has the Hide button", () => {
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    expect(screen.getByTestId("pub-hide-a")).toBeTruthy();
    expect(screen.queryByTestId("pub-show-a")).toBeNull();
  });

  it("a 'hidden_by_self' row has the Show button + Hidden badge", () => {
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "hidden_by_self", suppressionId: "sup-a" })]}
      />,
    );
    expect(screen.getByTestId("pub-show-a")).toBeTruthy();
    expect(screen.queryByTestId("pub-hide-a")).toBeNull();
    expect(screen.getByText("Hidden")).toBeTruthy();
  });

  it("a 'removed_by_admin' row has the inline destructive text and NO button", () => {
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "removed_by_admin" })]}
      />,
    );
    expect(screen.getByText("Removed by an administrator")).toBeTruthy();
    expect(
      screen.getByText(
        "An administrator removed this publication site-wide; hiding or showing it here has no effect.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("pub-hide-a")).toBeNull();
    expect(screen.queryByTestId("pub-show-a")).toBeNull();
  });
});

describe("PublicationsCard — optimistic hide", () => {
  it("hide flips the row to hidden_by_self optimistically", async () => {
    stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    // After click the optimistic state already flipped — the Show button appears.
    // No router.refresh(): the committed local list is authoritative (T3.7).
    await waitFor(() => expect(screen.getByTestId("pub-show-a")).toBeTruthy());
  });

  it("hide POSTs to /api/edit/suppress with the per-author body", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/suppress");
    expect(JSON.parse(opts.body as string)).toEqual({
      entityType: "publication",
      entityId: "a",
      contributorCwid: CWID,
    });
  });

  it("hide failure reverts the row and renders inline error", async () => {
    stubFetch({ ok: false, error: "write_failed" }, 500);
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    await waitFor(() =>
      expect(
        screen.getByText("We couldn't hide this publication. Please try again."),
      ).toBeTruthy(),
    );
    // Reverted — the Hide button is back. The optimistic revert lands when
    // the transition ends, which is a separate commit from the error setState
    // above, so await it rather than asserting synchronously.
    expect(await screen.findByTestId("pub-hide-a")).toBeTruthy();
  });
});

describe("PublicationsCard — sole-author confirm dialog (UI-SPEC edge case 11)", () => {
  it("clicking Hide on a sole-displayed-author row opens the confirm dialog (no POST yet)", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown", isSoleDisplayedAuthor: true })]}
      />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    expect(await screen.findByText("Hide this publication?")).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
  });

  it("confirming the sole-author dialog hides the publication", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown", isSoleDisplayedAuthor: true })]}
      />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    fireEvent.click(await screen.findByRole("button", { name: "Hide it anyway" }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("pub-show-a")).toBeTruthy());
  });

  it("canceling the sole-author dialog does not hide", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown", isSoleDisplayedAuthor: true })]}
      />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(f).not.toHaveBeenCalled();
    // Still in shown state.
    expect(screen.getByTestId("pub-hide-a")).toBeTruthy();
  });
});

describe("PublicationsCard — show (revoke)", () => {
  it("show POSTs to /api/edit/revoke with the suppression's id", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-a" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "hidden_by_self", suppressionId: "sup-a" })]}
      />,
    );
    fireEvent.click(screen.getByTestId("pub-show-a"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/revoke");
    expect(JSON.parse(opts.body as string)).toEqual({ suppressionId: "sup-a" });
  });

  it("show failure reverts to hidden_by_self and renders inline error", async () => {
    stubFetch({ ok: false, error: "write_failed" }, 500);
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "hidden_by_self", suppressionId: "sup-a" })]}
      />,
    );
    fireEvent.click(screen.getByTestId("pub-show-a"));
    await waitFor(() =>
      expect(
        screen.getByText("We couldn't restore this publication. Please try again."),
      ).toBeTruthy(),
    );
    // The Show button is back — reverted. Same transition-end timing as the
    // hide-failure case above; await the revert.
    expect(await screen.findByTestId("pub-show-a")).toBeTruthy();
  });
});

describe("PublicationsCard — first-hide-of-session notice (#570)", () => {
  const NOTICE_TITLE = "You're about to hide this paper.";

  beforeEach(() => {
    // Un-acknowledge — this block tests the notice itself (the global beforeEach
    // pre-acknowledges it for every other block).
    window.sessionStorage.clear();
  });

  it("the first hide of the session shows the notice and does not POST yet", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    expect(await screen.findByText(NOTICE_TITLE)).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
    // Still shown — nothing committed.
    expect(screen.getByTestId("pub-hide-a")).toBeTruthy();
  });

  it("'Hide it' proceeds with the hide the scholar initiated", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    fireEvent.click(await screen.findByTestId("first-hide-confirm"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("pub-show-a")).toBeTruthy());
  });

  it("subsequent hides in the same session skip the notice and POST directly", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[
          pub({ pmid: "a", state: "shown" }),
          pub({ pmid: "b", state: "shown" }),
        ]}
      />,
    );
    // First hide → notice → acknowledge.
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    fireEvent.click(await screen.findByTestId("first-hide-confirm"));
    await waitFor(() => expect(screen.getByTestId("pub-show-a")).toBeTruthy());
    // Second hide → no notice, posts straight away.
    fireEvent.click(screen.getByTestId("pub-hide-b"));
    expect(screen.queryByText(NOTICE_TITLE)).toBeNull();
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    const [, opts] = f.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(opts.body as string).entityId).toBe("b");
  });

  it("'It's not mine' opens Publication Manager in a new tab and does not hide", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    const notMine = await screen.findByTestId("first-hide-not-mine");
    expect(notMine.getAttribute("href")).toBe("https://reciter.weill.cornell.edu/");
    expect(notMine.getAttribute("target")).toBe("_blank");
    fireEvent.click(notMine);
    expect(f).not.toHaveBeenCalled();
    // Notice closed, publication still visible.
    await waitFor(() => expect(screen.queryByText(NOTICE_TITLE)).toBeNull());
    expect(screen.getByTestId("pub-hide-a")).toBeTruthy();
  });

  it("'Cancel' leaves the publication visible, does not POST, and does NOT acknowledge", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    fireEvent.click(await screen.findByTestId("first-hide-cancel"));
    expect(f).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(NOTICE_TITLE)).toBeNull());
    expect(screen.getByTestId("pub-hide-a")).toBeTruthy();
    // Backing out does not acknowledge — hiding again re-shows the notice.
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    expect(await screen.findByText(NOTICE_TITLE)).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
  });

  it("'It's not mine' acknowledges — a later hide skips the notice", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[
          pub({ pmid: "a", state: "shown" }),
          pub({ pmid: "b", state: "shown" }),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    fireEvent.click(await screen.findByTestId("first-hide-not-mine"));
    await waitFor(() => expect(screen.queryByText(NOTICE_TITLE)).toBeNull());
    expect(f).not.toHaveBeenCalled();
    // Acknowledged — hiding another paper proceeds straight to the write.
    fireEvent.click(screen.getByTestId("pub-hide-b"));
    expect(screen.queryByText(NOTICE_TITLE)).toBeNull();
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
  });

  it("composes with the sole-author confirm — notice first, then the site-wide warning, no double-prompt", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown", isSoleDisplayedAuthor: true })]}
      />,
    );
    // First click → the educational notice (NOT the sole-author confirm yet).
    fireEvent.click(screen.getByTestId("pub-hide-a"));
    expect(await screen.findByText(NOTICE_TITLE)).toBeTruthy();
    expect(screen.queryByText("Hide this publication?")).toBeNull();
    expect(f).not.toHaveBeenCalled();
    // 'Hide it' → the sole-author site-wide-removal confirm, still no POST.
    fireEvent.click(screen.getByTestId("first-hide-confirm"));
    expect(await screen.findByText("Hide this publication?")).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
    // 'Hide it anyway' → the write finally fires.
    fireEvent.click(screen.getByRole("button", { name: "Hide it anyway" }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("pub-show-a")).toBeTruthy());
  });

  it("Show / restore never triggers the notice", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-a" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "hidden_by_self", suppressionId: "sup-a" })]}
      />,
    );
    fireEvent.click(screen.getByTestId("pub-show-a"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/revoke");
    expect(screen.queryByText(NOTICE_TITLE)).toBeNull();
  });
});
