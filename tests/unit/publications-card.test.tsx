/**
 * `components/edit/publications-card.tsx` — list / filter / year-group /
 * select-and-bulk-hide behind its guards (the first-hide-of-session notice, the
 * sole-displayed-author confirm, and the superuser's required reason) /
 * optimistic show / admin-removed inline text (#356 Phase 6 C7).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

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

/** A FRESH Response per call — a single shared one can only have its body read
 *  once, so the second write of a bulk hide would fail on `res.json()`. */
function stubFetch(body: object, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

const bodies = (f: ReturnType<typeof stubFetch>) =>
  (f.mock.calls as unknown as [string, RequestInit][]).map(
    ([, init]) => JSON.parse(init.body as string) as Record<string, unknown>,
  );

const row = (pmid: string) => within(screen.getByTestId(`pub-row-${pmid}`));
const select = (pmid: string) => fireEvent.click(row(pmid).getByRole("checkbox"));
/** The selection bar's Hide — the card's only hide verb since #2716's pattern
 *  replaced the per-row button. */
const bulkHide = () => fireEvent.click(screen.getByRole("button", { name: "Hide from profile" }));
/** Select one row and hide it: what the old per-row Hide button did. */
function hideRow(pmid: string) {
  select(pmid);
  bulkHide();
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
  it("a 'shown' row has a checkbox labelled title + journal/year", () => {
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[
          pub({ pmid: "a", title: "Same title", journal: "Journal X", year: 2025 }),
          pub({ pmid: "b", title: "Same title", journal: "Journal Y", year: 2019 }),
        ]}
      />,
    );
    // Two rows share a title — the journal/year keeps their labels distinct.
    expect(
      row("a").getByRole("checkbox", { name: "Select Same title, Journal X · 2025" }),
    ).toBeTruthy();
    expect(
      row("b").getByRole("checkbox", { name: "Select Same title, Journal Y · 2019" }),
    ).toBeTruthy();
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
    expect(row("a").queryByRole("checkbox")).toBeNull();
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
    expect(row("a").queryByRole("checkbox")).toBeNull();
    expect(screen.queryByTestId("pub-show-a")).toBeNull();
  });

  it("a 'rejected' row shows the correction-pending badge + read-only note and NO Show/Hide/Not-mine control (#750)", () => {
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "rejected" })]} />,
    );
    // "Rejected — correction pending" badge replaces "Hidden".
    expect(screen.getByTestId("pub-rejected-badge-a")).toBeTruthy();
    expect(screen.getByText("Rejected — correction pending")).toBeTruthy();
    expect(screen.queryByText("Hidden")).toBeNull();
    // A read-only note, not a "Show" button — un-hiding locally would diverge
    // from ReCiter's gold standard, so revoke is disallowed here.
    expect(screen.getByTestId("pub-rejected-note-a")).toBeTruthy();
    expect(screen.queryByTestId("pub-show-a")).toBeNull();
    expect(row("a").queryByRole("checkbox")).toBeNull();
    // No standing "Not mine?" affordance — it's already been rejected.
    expect(screen.queryByTestId("pub-not-mine-a")).toBeNull();
  });
});

describe("PublicationsCard — bulk hide", () => {
  it("selecting a row and pressing Hide flips it to hidden_by_self", async () => {
    stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    hideRow("a");
    // No router.refresh(): the committed local list is authoritative (T3.7).
    await waitFor(() => expect(screen.getByTestId("pub-show-a")).toBeTruthy());
    // Batch done — the bar empties.
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("hide POSTs to /api/edit/suppress with the per-author body", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    hideRow("a");
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/suppress");
    expect(JSON.parse(opts.body as string)).toEqual({
      entityType: "publication",
      entityId: "a",
      contributorCwid: CWID,
    });
  });

  it("hiding two selected rows POSTs suppress once per pmid", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[
          pub({ pmid: "a", state: "shown" }),
          pub({ pmid: "b", state: "shown" }),
          pub({ pmid: "c", state: "shown" }),
        ]}
      />,
    );
    select("a");
    select("c");
    expect(screen.getByText("2 publications selected")).toBeTruthy();
    bulkHide();

    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(bodies(f)).toEqual([
      { entityType: "publication", entityId: "a", contributorCwid: CWID },
      { entityType: "publication", entityId: "c", contributorCwid: CWID },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId("pub-show-a")).toBeTruthy();
      expect(screen.getByTestId("pub-show-c")).toBeTruthy();
    });
    // The untouched row stays selectable; the bar is empty again.
    expect(row("b").getByRole("checkbox")).toBeTruthy();
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("a partial failure leaves the failed rows selected under one inline alert", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const { entityId } = JSON.parse(String((init as RequestInit).body)) as {
        entityId: string;
      };
      const failed = entityId === "a";
      return Promise.resolve(
        new Response(
          JSON.stringify(
            failed ? { ok: false, error: "write_failed" } : { ok: true, suppressionId: "sup-b" },
          ),
          { status: failed ? 500 : 200 },
        ),
      );
    });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown" }), pub({ pmid: "b", state: "shown" })]}
      />,
    );
    select("a");
    select("b");
    bulkHide();

    expect(
      await screen.findByText(
        "We couldn't hide 1 of the selected publications. Please try again.",
      ),
    ).toBeTruthy();
    // 'b' landed; 'a' stayed shown AND stayed selected, so a retry re-sends it.
    expect(screen.getByTestId("pub-show-b")).toBeTruthy();
    expect(screen.getByText("1 publication selected")).toBeTruthy();
    expect(row("a").getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });
});

describe("PublicationsCard — sole-author confirm dialog (UI-SPEC edge case 11)", () => {
  it("hiding a sole-displayed-author row opens the confirm dialog (no POST yet)", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown", isSoleDisplayedAuthor: true })]}
      />,
    );
    hideRow("a");
    expect(await screen.findByText("Hide 1 publication?")).toBeTruthy();
    // The one-row path keeps its own sentence — batch copy ("N of these list
    // you as…") reads wrong for the common case.
    expect(
      screen.getByText(
        "You are the only Weill Cornell author shown on this publication. Hiding it removes the" +
          " publication from the site entirely until you restore it, or another WCM author is" +
          " added.",
      ),
    ).toBeTruthy();
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
    hideRow("a");
    fireEvent.click(await screen.findByRole("button", { name: "Hide anyway" }));
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
    hideRow("a");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(f).not.toHaveBeenCalled();
    // Still shown — and still selected, so the batch survives the back-out.
    expect(row("a").getByRole("checkbox")).toBeTruthy();
    expect(screen.getByText("1 publication selected")).toBeTruthy();
  });

  it("ONE confirm for the batch, counting AND naming the sole-author papers", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[
          pub({ pmid: "a", title: "Alpha", state: "shown", isSoleDisplayedAuthor: true }),
          pub({ pmid: "b", title: "Beta", state: "shown", isSoleDisplayedAuthor: false }),
          pub({ pmid: "c", title: "<i>Gamma</i>", state: "shown", isSoleDisplayedAuthor: true }),
        ]}
      />,
    );
    select("a");
    select("b");
    select("c");
    bulkHide();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Hide 3 publications?")).toBeTruthy();
    // Which papers leave the site is the whole point of the warning — the bare
    // count never said. PubMed inline markup is stripped for the sentence.
    expect(
      within(dialog).getByText(
        "2 of these list you as the only displayed Weill Cornell author \u2014 \u201cAlpha\u201d;" +
          " \u201cGamma\u201d. Hiding a publication with no other WCM author removes it from the" +
          " site entirely until it is restored, or another WCM author is added.",
      ),
    ).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
    // One dialog, not one per sole-author row — confirming writes all three.
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide anyway" }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(3));
  });

  it("names at most five, then 'and N more'", async () => {
    stubFetch({ ok: true, suppressionId: "sup-fresh" });
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((id) =>
      pub({ pmid: id, title: id.toUpperCase(), state: "shown", isSoleDisplayedAuthor: true }),
    );
    render(<PublicationsCard cwid={CWID} publications={many} />);
    many.forEach((p) => select(p.pmid));
    bulkHide();

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        /\u201cA\u201d; \u201cB\u201d; \u201cC\u201d; \u201cD\u201d; \u201cE\u201d and 2 more\./,
      ),
    ).toBeTruthy();
  });
});

describe("PublicationsCard — superuser hide takes a required reason", () => {
  const renderSu = (pubs: EditContextPublication[]) =>
    render(
      <PublicationsCard cwid={CWID} mode="superuser" scholarName="Alex Self" publications={pubs} />,
    );

  it("EVERY superuser hide stops for a reason, which rides every write", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    renderSu([pub({ pmid: "a" }), pub({ pmid: "b" })]);
    select("a");
    select("b");
    bulkHide();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Hide 2 publications?")).toBeTruthy();
    expect(
      within(dialog).getByText("This removes them from Alex Self's public profile."),
    ).toBeTruthy();
    // Nothing written until a reason is typed: /api/edit/suppress answers 400
    // reason_required for a superuser hiding someone else's paper.
    expect(f).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Hide" }).hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Ticket 42" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide" }));

    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(bodies(f)).toEqual([
      { entityType: "publication", entityId: "a", contributorCwid: CWID, reason: "Ticket 42" },
      { entityType: "publication", entityId: "b", contributorCwid: CWID, reason: "Ticket 42" },
    ]);
  });

  it("a superuser sole-author hide carries the site-wide warning AND the reason box", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    renderSu([pub({ pmid: "a", title: "Alpha", isSoleDisplayedAuthor: true })]);
    hideRow("a");

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Alex Self is the only Weill Cornell author shown on this publication. Hiding it removes" +
          " the publication from the site entirely until it is restored, or another WCM author" +
          " is added.",
      ),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Retracted" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide anyway" }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(bodies(f)[0].reason).toBe("Retracted");
  });

  it("a SELF hide sends no reason and opens no dialog — the route defaults it", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(<PublicationsCard cwid={CWID} publications={[pub({ pmid: "a" })]} />);
    hideRow("a");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(bodies(f)[0]).not.toHaveProperty("reason");
  });
});

describe("PublicationsCard — selection integrity", () => {
  it("checkboxes and the extend link go dead while a batch is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify({ ok: true, suppressionId: "s" }), { status: 200 });
    });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a" }), pub({ pmid: "b" }), pub({ pmid: "c" })]}
      />,
    );
    select("a");
    bulkHide();

    // A tick made mid-batch would be wiped when the batch settles, so the rows
    // and the extend link are disabled with the bar's buttons.
    await waitFor(() => expect(row("b").getByRole("checkbox").hasAttribute("disabled")).toBe(true));
    expect(screen.getByRole("button", { name: /Also select/ }).hasAttribute("disabled")).toBe(true);

    release();
    await waitFor(() => expect(screen.getByTestId("pub-show-a")).toBeTruthy());
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
    hideRow("a");
    expect(await screen.findByText(NOTICE_TITLE)).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
    // Still shown — nothing committed. (The open dialog aria-hides the list, so
    // the row's checkbox is out of the a11y tree; assert on the Show control.)
    expect(screen.queryByTestId("pub-show-a")).toBeNull();
  });

  it("the notice gates the BULK path too — Cancel neither writes nor acknowledges", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown" }), pub({ pmid: "b", state: "shown" })]}
      />,
    );
    select("a");
    select("b");
    bulkHide();
    expect(await screen.findByText(NOTICE_TITLE)).toBeTruthy();
    expect(f).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("first-hide-cancel"));
    await waitFor(() => expect(screen.queryByText(NOTICE_TITLE)).toBeNull());
    expect(f).not.toHaveBeenCalled();
    expect(screen.getByText("2 publications selected")).toBeTruthy();

    // Not acknowledged — pressing Hide again re-raises it; 'Hide it' then
    // writes the WHOLE batch, once per pmid.
    bulkHide();
    fireEvent.click(await screen.findByTestId("first-hide-confirm"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(bodies(f).map((b) => b.entityId)).toEqual(["a", "b"]);
  });

  it("'Hide it' proceeds with the hide the scholar initiated", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    hideRow("a");
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
    hideRow("a");
    fireEvent.click(await screen.findByTestId("first-hide-confirm"));
    await waitFor(() => expect(screen.getByTestId("pub-show-a")).toBeTruthy());
    // Second hide → no notice, posts straight away.
    hideRow("b");
    expect(screen.queryByText(NOTICE_TITLE)).toBeNull();
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    const [, opts] = f.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(opts.body as string).entityId).toBe("b");
  });

  it("the notice's inline reject link opens Publication Manager in a new tab and does not hide", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    hideRow("a");
    await screen.findByText(NOTICE_TITLE);
    // The footer duplicate is gone; the educational inline body link is the
    // not-mine path inside the notice.
    const notMine = screen.getByRole("link", { name: /reject it in Publication Manager/i });
    expect(notMine.getAttribute("href")).toBe("https://reciter.weill.cornell.edu/");
    expect(notMine.getAttribute("target")).toBe("_blank");
    fireEvent.click(notMine);
    expect(f).not.toHaveBeenCalled();
    // Notice closed, publication still visible.
    await waitFor(() => expect(screen.queryByText(NOTICE_TITLE)).toBeNull());
    expect(row("a").getByRole("checkbox")).toBeTruthy();
  });

  it("'Cancel' leaves the publication visible, does not POST, and does NOT acknowledge", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />,
    );
    hideRow("a");
    fireEvent.click(await screen.findByTestId("first-hide-cancel"));
    expect(f).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(NOTICE_TITLE)).toBeNull());
    expect(row("a").getByRole("checkbox")).toBeTruthy();
    // Backing out does not acknowledge — the still-selected batch re-shows it.
    bulkHide();
    expect(await screen.findByText(NOTICE_TITLE)).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
  });

  it("the notice's inline reject link acknowledges — a later hide skips the notice", async () => {
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
    hideRow("a");
    await screen.findByText(NOTICE_TITLE);
    fireEvent.click(screen.getByRole("link", { name: /reject it in Publication Manager/i }));
    await waitFor(() => expect(screen.queryByText(NOTICE_TITLE)).toBeNull());
    expect(f).not.toHaveBeenCalled();
    // Acknowledged — hiding proceeds straight to the write. 'a' is still
    // selected from the backed-out attempt, so the batch is both rows.
    select("b");
    bulkHide();
    expect(screen.queryByText(NOTICE_TITLE)).toBeNull();
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
  });

  it("each shown/hidden row carries a standing 'Not mine?' affordance pre-selected to the not-mine route", async () => {
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[
          pub({ pmid: "a", state: "shown" }),
          pub({ pmid: "b", state: "hidden_by_self", suppressionId: "sup-b" }),
          pub({ pmid: "c", state: "removed_by_admin" }),
        ]}
      />,
    );
    // Shown + hidden rows get the quiet per-row trigger; the admin-removed row
    // (gone site-wide) does not.
    expect(screen.getByTestId("pub-not-mine-a")).toBeTruthy();
    expect(screen.getByTestId("pub-not-mine-b")).toBeTruthy();
    expect(screen.queryByTestId("pub-not-mine-c")).toBeNull();
    // Opening it lands straight on the not-mine route (no once-per-session
    // notice, nothing to pick) — its self-service verb is already shown.
    fireEvent.click(screen.getByTestId("pub-not-mine-a"));
    expect(
      (await screen.findByTestId("request-a-change-open")).textContent,
    ).toContain("Flag as not mine");
  });

  it("composes with the sole-author confirm — notice first, then the site-wide warning, no double-prompt", async () => {
    const f = stubFetch({ ok: true, suppressionId: "sup-fresh" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown", isSoleDisplayedAuthor: true })]}
      />,
    );
    // First press → the educational notice (NOT the sole-author confirm yet).
    hideRow("a");
    expect(await screen.findByText(NOTICE_TITLE)).toBeTruthy();
    expect(screen.queryByText("Hide 1 publication?")).toBeNull();
    expect(f).not.toHaveBeenCalled();
    // 'Hide it' → the sole-author site-wide-removal confirm, still no POST.
    fireEvent.click(screen.getByTestId("first-hide-confirm"));
    expect(await screen.findByText("Hide 1 publication?")).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
    // 'Hide anyway' → the write finally fires.
    fireEvent.click(screen.getByRole("button", { name: "Hide anyway" }));
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

describe("PublicationsCard — in-app reject (#746)", () => {
  const REJECT_TITLE = "Is this paper not yours?";

  it("rejectEnabled OFF (default): 'Not mine?' keeps the Publication-Manager off-ramp", async () => {
    render(<PublicationsCard cwid={CWID} publications={[pub({ pmid: "a", state: "shown" })]} />);
    fireEvent.click(screen.getByTestId("pub-not-mine-a"));
    // The off-ramp (Request-a-change) opens, NOT the in-app reject interstitial.
    expect(await screen.findByTestId("request-a-change-open")).toBeTruthy();
    expect(screen.queryByTestId("reject-confirm")).toBeNull();
  });

  it("rejectEnabled ON: 'Not mine?' opens the soft-warning interstitial", async () => {
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown" })]}
        rejectEnabled
      />,
    );
    fireEvent.click(screen.getByTestId("pub-not-mine-a"));
    expect(await screen.findByText(REJECT_TITLE)).toBeTruthy();
    expect(screen.getByTestId("reject-confirm")).toBeTruthy();
    // Cancel is the autofocused default — never the destructive action (#570).
    expect(screen.getByTestId("reject-cancel")).toBeTruthy();
  });

  it("confirming the reject POSTs /api/edit/reject and removes the row from view", async () => {
    const f = stubFetch({ ok: true, suppressionId: "supp-1" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", title: "Mistaken paper", state: "shown" })]}
        rejectEnabled
      />,
    );
    fireEvent.click(screen.getByTestId("pub-not-mine-a"));
    fireEvent.click(await screen.findByTestId("reject-confirm"));
    // Optimistic remove on success — the row is gone.
    await waitFor(() => expect(screen.queryByTestId("pub-row-a")).toBeNull());
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/reject");
    expect(JSON.parse(init.body as string)).toMatchObject({
      entityId: "a",
      contributorCwid: CWID,
    });
  });

  it("rejecting a selected row drops its pmid from the selection too", async () => {
    stubFetch({ ok: true, suppressionId: "supp-1" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a" }), pub({ pmid: "b" })]}
        rejectEnabled
      />,
    );
    select("a");
    select("b");
    expect(screen.getByText("2 publications selected")).toBeTruthy();

    fireEvent.click(screen.getByTestId("pub-not-mine-a"));
    fireEvent.click(await screen.findByTestId("reject-confirm"));

    // The row is gone from the list; leaving it in the selection would leave
    // the bar counting a phantom that Hide can never write.
    await waitFor(() => expect(screen.queryByTestId("pub-row-a")).toBeNull());
    expect(screen.getByText("1 publication selected")).toBeTruthy();
  });

  it("a failed reject keeps the interstitial open with an inline error (row stays)", async () => {
    stubFetch({ ok: false, error: "write_failed" }, 500);
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown" })]}
        rejectEnabled
      />,
    );
    fireEvent.click(screen.getByTestId("pub-not-mine-a"));
    fireEvent.click(await screen.findByTestId("reject-confirm"));
    expect(
      await screen.findByText("We couldn't reject this publication. Please try again."),
    ).toBeTruthy();
    // Not removed; the interstitial is still open.
    expect(screen.getByTestId("pub-row-a")).toBeTruthy();
    expect(screen.getByTestId("reject-confirm")).toBeTruthy();
  });

  it("'Hide it instead' closes the interstitial and routes to the reversible hide", async () => {
    const f = stubFetch({ ok: true, suppressionId: "supp-hide" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a", state: "shown" })]}
        rejectEnabled
      />,
    );
    fireEvent.click(screen.getByTestId("pub-not-mine-a"));
    fireEvent.click(await screen.findByTestId("reject-hide-instead"));
    // The reject interstitial closes…
    await waitFor(() => expect(screen.queryByTestId("reject-confirm")).toBeNull());
    // …and the hide write fires (first-hide notice already acknowledged this session).
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect((f.mock.calls[0] as [string, RequestInit])[0]).toBe("/api/edit/suppress");
  });

  it("'Hide it instead' on an UNSELECTED row leaves the rest of the selection alone", async () => {
    const f = stubFetch({ ok: true, suppressionId: "supp-hide" });
    render(
      <PublicationsCard
        cwid={CWID}
        publications={[pub({ pmid: "a" }), pub({ pmid: "b" })]}
        rejectEnabled
      />,
    );
    // 'b' is ticked; the rerouted hide is a batch of one that never included it.
    select("b");
    fireEvent.click(screen.getByTestId("pub-not-mine-a"));
    fireEvent.click(await screen.findByTestId("reject-hide-instead"));

    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(bodies(f)[0].entityId).toBe("a");
    await waitFor(() => expect(screen.getByText("1 publication selected")).toBeTruthy());
    expect(row("b").getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });
});
