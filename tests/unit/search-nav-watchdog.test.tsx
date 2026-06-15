/**
 * #1017 — client-side navigation watchdog for deploy-cutover skew.
 *
 * During the ~1-minute deployment cutover a search soft-nav (router.push inside
 * useTransition) can receive an RSC 200 the client neither applies nor
 * hard-reloads: isPending stays true and the URL never moves (the box spins
 * forever). The watchdog arms a ~7s timer on every soft-nav; if it's still
 * pending AND the URL hasn't moved when it fires, it forces a hard navigation
 * via window.location.assign(href). A successful soft-nav moves the URL (and
 * clears isPending), so the watchdog no-ops — no spurious reload.
 *
 * Mocking strategy mirrors search-autocomplete-pending.test.tsx (the
 * established convention for this component):
 *  - next/navigation: useRouter().push is a hoisted spy (URL does NOT move when
 *    push is mocked — exactly the hang signature).
 *  - react.useTransition: a hoisted mutable `h.pending` flag + a swappable
 *    startTransition stub. CRITICAL: to model the HANG we use a NO-OP
 *    startTransition `(_cb) => {}` with h.pending forced true, so isPending is
 *    stuck (the #1017 symptom). The default synchronous stub `(cb) => cb()`
 *    would make the transition resolve inline and the watchdog could never trip.
 *  - window.location: jsdom throws "Not implemented: navigation" on real
 *    assign/reload, so we Object.defineProperty-replace it with a spyable stub
 *    carrying pathname/search/href (submit() and the pre-fill effect read those)
 *    and restore the original in afterEach.
 *
 * Fake timers drive the 7s watchdog; the watchdog's setState/location side
 * effect is flushed inside act() (await act(async () => advanceTimersByTimeAsync)).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// Hoisted, mutable transition control:
//  - h.pending toggles the value isPending returns.
//  - h.start is the startTransition implementation. Swap it per test:
//      NO-OP `(_cb) => {}`   → models a transition that never resolves (hang).
//      sync  `(cb) => cb()`  → resolves inline (steady-state success).
const h = vi.hoisted(() => ({
  pending: false,
  start: (cb: () => void) => cb(),
}));
vi.mock("react", async (orig) => {
  const actual = (await orig()) as typeof import("react");
  return {
    ...actual,
    useTransition: () => [h.pending, (cb: () => void) => h.start(cb)],
  };
});

import { SearchAutocomplete } from "@/components/search/autocomplete";

/** Advance fake timers and flush the watchdog's setState/location commit in act(). */
async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let originalLocation: Location;

/**
 * Replace window.location with a spyable stub. `href`/`pathname`/`search` are
 * read by submit() and the pre-fill effect; `assign` is the hard-nav we assert.
 */
function stubLocation(
  href = "https://scholars-staging.weill.cornell.edu/",
  pathname = "/",
  search = "",
) {
  const assign = vi.fn();
  const reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { assign, reload, href, pathname, search },
  });
  return { assign, reload };
}

// jsdom does not implement navigator.sendBeacon; capture whatever is there at
// module load so afterEach can restore it and a spy can't leak into siblings.
const ORIGINAL_SEND_BEACON = navigator.sendBeacon;

/** Install a spyable navigator.sendBeacon and return the spy. */
function spyBeacon() {
  const sendBeacon = vi.fn().mockReturnValue(true);
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: sendBeacon,
  });
  return sendBeacon;
}

/** Parse the JSON body of the first sendBeacon call (the payload is a Blob). */
async function beaconPayload(sendBeacon: ReturnType<typeof vi.fn>) {
  const [, blob] = sendBeacon.mock.calls[0] as [string, Blob];
  return JSON.parse(await blob.text());
}

beforeEach(() => {
  vi.useFakeTimers();
  h.pending = false;
  h.start = (cb: () => void) => cb();
  pushMock.mockClear();
  originalLocation = window.location;
  // The suggest effect's 150ms timer awaits fetch; with fake timers on, stub it
  // to resolve so advancing the watchdog doesn't starve on a dangling promise.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ suggestions: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: ORIGINAL_SEND_BEACON,
  });
});

describe("#1017 navigation watchdog — autocomplete submit()", () => {
  it("A. HANG → hard-navigates once: push fires but isPending stuck true + URL frozen, fires assign(href) after 7s", async () => {
    // Model the real #1017 hang: startTransition runs its callback so
    // router.push DOES fire (the RSC request goes out, server returns 200) — but
    // the client never commits it, so isPending is stuck true and the URL never
    // moves. (`h.start = (cb) => cb()` + `h.pending = true`.)
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");

    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // router.push was attempted but URL did not move (push is mocked) and
    // isPending is stuck → the spinning-forever symptom. assign hasn't fired yet.
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer");
    expect(assign).not.toHaveBeenCalled();

    // Advance just shy of the watchdog: nothing yet.
    await settle(6900);
    expect(assign).not.toHaveBeenCalled();

    // Cross the 7s threshold: the watchdog hard-navigates to the intended href.
    await settle(200);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/search?q=cancer");
  });

  it("A2. HANG (hero Search button) → hard-navigates after 7s", async () => {
    // The hero Search button is `disabled={isPending}`, so the click that ARMS
    // the watchdog must happen while not yet pending (push fires, watchdog
    // arms). We then flip pending stuck-true (re-render updates isPendingRef) to
    // model the hung transition before advancing the timer.
    h.start = (cb: () => void) => cb();
    h.pending = false;
    const { assign } = stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");

    const { rerender } = render(<SearchAutocomplete variant="hero" />);
    fireEvent.change(screen.getByLabelText("Search scholars"), { target: { value: "cancer" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer");
    expect(assign).not.toHaveBeenCalled();

    // Transition is stuck: pending stays true and the URL never moves. Re-render
    // so the component reads h.pending=true into isPendingRef.current.
    h.pending = true;
    rerender(<SearchAutocomplete variant="hero" />);

    await settle(7100);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/search?q=cancer");
  });

  it("B. RESOLVED → no hard nav: transition resolves inline, isPending false, assign NOT called even past 7s", async () => {
    // Steady state: synchronous startTransition + not pending. The [isPending]
    // effect clears the armed timer; even advancing past 7s, assign never fires.
    h.start = (cb: () => void) => cb();
    h.pending = false;
    const { assign } = stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");

    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer");

    // Advance well past the watchdog window — a late-firing watchdog would fail here.
    await settle(10_000);
    expect(assign).toHaveBeenCalledTimes(0);
  });

  it("C. URL MOVED → no hard nav: pending true but window.location.href changed before the timer fires", async () => {
    // Proves the URL guard independent of isPending: the soft-nav DID land
    // (URL advanced) even though our pending flag is still true.
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const stub = stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");

    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Simulate the soft-nav actually committing: the URL moved.
    window.location.href = "https://scholars-staging.weill.cornell.edu/search?q=cancer";

    await settle(7500);
    // startHref !== current href → watchdog no-ops.
    expect(stub.assign).toHaveBeenCalledTimes(0);
  });

  it("D. rapid re-submit only hard-navigates once, to the latest href", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");

    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");

    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Re-submit before the first watchdog fires; the prior timer must be cleared.
    await settle(3000);
    fireEvent.change(input, { target: { value: "genomics" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // 3s + 7s = 10s total. The first timer (armed at t=0) would have fired at
    // t=7000 if not cleared; the second (armed at t=3000) fires at t=10000.
    await settle(7000);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/search?q=genomics");
  });

  it("E. unmount before the watchdog fires → no hard nav (timer cleared on unmount)", async () => {
    // Without the unmount-cleanup effect the armed timer outlives the component
    // and would yank a user who already left /search back via location.assign.
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");

    const { unmount } = render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer");

    unmount();
    await settle(7500);
    expect(assign).toHaveBeenCalledTimes(0);
  });

  it("F. transition resolves after arming → no hard nav (timer cleared on resolve)", async () => {
    // Arm while pending, then the transition resolves (pending true→false) before
    // 7s; the [isPending] effect clears the armed timer so nothing fires.
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");

    const { rerender } = render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer");

    h.pending = false;
    rerender(<SearchAutocomplete />);

    await settle(7500);
    expect(assign).toHaveBeenCalledTimes(0);
  });
});

describe("#1017 navigation watchdog — Enter-on-suggestion soft-nav", () => {
  it("hangs on a highlighted suggestion → hard-navigates to the suggestion href after 7s", async () => {
    // Populate one suggestion so ArrowDown sets activeIndex=0 and Enter routes
    // through the suggestion branch (not submit()).
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          suggestions: [
            { kind: "person", title: "Jane Cancer", href: "/scholars/jane-cancer" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");

    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    // Let the 150ms suggest debounce + fetch settle so suggestions render.
    await settle(300);
    fireEvent.keyDown(input, { key: "ArrowDown" }); // activeIndex → 0
    fireEvent.keyDown(input, { key: "Enter" }); // suggestion branch

    expect(pushMock).toHaveBeenCalledWith("/scholars/jane-cancer");
    expect(assign).not.toHaveBeenCalled();

    await settle(7100);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/scholars/jane-cancer");
  });
});

describe("#1017 navigation watchdog — SearchTransitionProvider.navigate()", () => {
  // The provider owns the shared transition used by facet/tab/sort/pagination
  // TransitionLinks. A tiny consumer exercises navigate() through the same
  // watchdog code path.
  it("HANG via provider navigate → hard-navigates to the facet href after 7s", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation(
      "https://scholars-staging.weill.cornell.edu/search?q=cancer",
      "/search",
      "?q=cancer",
    );

    // Import here so the next/navigation + react mocks above are already applied.
    const { SearchTransitionProvider, TransitionLink } = await import(
      "@/components/search/transition-link"
    );

    render(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=cancer&type=publications">Publications</TransitionLink>
      </SearchTransitionProvider>,
    );

    fireEvent.click(screen.getByText("Publications"));
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer&type=publications", undefined);
    expect(assign).not.toHaveBeenCalled();

    await settle(7100);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/search?q=cancer&type=publications");
  });

  it("RESOLVED via provider navigate → no hard nav", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = false;
    const { assign } = stubLocation(
      "https://scholars-staging.weill.cornell.edu/search?q=cancer",
      "/search",
      "?q=cancer",
    );

    const { SearchTransitionProvider, TransitionLink } = await import(
      "@/components/search/transition-link"
    );

    render(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=cancer&type=publications">Publications</TransitionLink>
      </SearchTransitionProvider>,
    );

    fireEvent.click(screen.getByText("Publications"));
    await settle(10_000);
    expect(assign).toHaveBeenCalledTimes(0);
  });

  it("URL MOVED via provider → no hard nav (URL guard, independent of isPending)", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation(
      "https://scholars-staging.weill.cornell.edu/search?q=cancer",
      "/search",
      "?q=cancer",
    );

    const { SearchTransitionProvider, TransitionLink } = await import(
      "@/components/search/transition-link"
    );

    render(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=cancer&type=publications">Publications</TransitionLink>
      </SearchTransitionProvider>,
    );

    fireEvent.click(screen.getByText("Publications"));
    // The facet soft-nav actually committed: the URL moved.
    window.location.href =
      "https://scholars-staging.weill.cornell.edu/search?q=cancer&type=publications";

    await settle(7500);
    expect(assign).toHaveBeenCalledTimes(0);
  });

  it("unmount via provider before the watchdog fires → no hard nav", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation(
      "https://scholars-staging.weill.cornell.edu/search?q=cancer",
      "/search",
      "?q=cancer",
    );

    const { SearchTransitionProvider, TransitionLink } = await import(
      "@/components/search/transition-link"
    );

    const { unmount } = render(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=cancer&type=publications">Publications</TransitionLink>
      </SearchTransitionProvider>,
    );

    fireEvent.click(screen.getByText("Publications"));
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer&type=publications", undefined);

    unmount();
    await settle(7500);
    expect(assign).toHaveBeenCalledTimes(0);
  });

  it("rapid re-navigate via provider only hard-navigates once, to the latest href", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation(
      "https://scholars-staging.weill.cornell.edu/search?q=cancer",
      "/search",
      "?q=cancer",
    );

    const { SearchTransitionProvider, TransitionLink } = await import(
      "@/components/search/transition-link"
    );

    render(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=cancer&type=publications">Publications</TransitionLink>
        <TransitionLink href="/search?q=cancer&type=grants">Grants</TransitionLink>
      </SearchTransitionProvider>,
    );

    fireEvent.click(screen.getByText("Publications"));
    await settle(3000);
    fireEvent.click(screen.getByText("Grants"));
    // First timer (armed t=0) would fire at 7000 if not cleared; second (armed
    // t=3000) fires at 10000. Total elapsed 3000 + 7000 = 10000.
    await settle(7000);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/search?q=cancer&type=grants");
  });

  it("transition resolves after arming via provider → no hard nav", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation(
      "https://scholars-staging.weill.cornell.edu/search?q=cancer",
      "/search",
      "?q=cancer",
    );

    const { SearchTransitionProvider, TransitionLink } = await import(
      "@/components/search/transition-link"
    );

    const { rerender } = render(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=cancer&type=publications">Publications</TransitionLink>
      </SearchTransitionProvider>,
    );

    fireEvent.click(screen.getByText("Publications"));

    h.pending = false;
    rerender(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=cancer&type=publications">Publications</TransitionLink>
      </SearchTransitionProvider>,
    );

    await settle(7500);
    expect(assign).toHaveBeenCalledTimes(0);
  });
});

describe("#1017 navigation watchdog — telemetry beacon", () => {
  // This environment's Blob has no .text(); reportNavWatchdog builds the beacon
  // body with `new Blob([...], { type: "application/json" })` (the repo idiom),
  // so stub a capturing Blob to read the payload back without touching prod code.
  class CapturingBlob {
    parts: string[];
    type: string;
    constructor(parts: string[], opts?: { type?: string }) {
      this.parts = parts;
      this.type = opts?.type ?? "";
    }
    text() {
      return Promise.resolve(this.parts.join(""));
    }
  }
  beforeEach(() => {
    vi.stubGlobal("Blob", CapturingBlob);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submit() hang fires a search_nav_watchdog beacon (surface=autocomplete_submit) before the hard nav", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = true;
    const { assign } = stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");
    const sendBeacon = spyBeacon();

    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await settle(7100);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0][0]).toBe("/api/analytics");
    const body = await beaconPayload(sendBeacon);
    expect(body.event).toBe("search_nav_watchdog");
    expect(body.surface).toBe("autocomplete_submit");
    expect(body.n).toBe(7000);
  });

  it("Enter-on-suggestion hang reports surface=autocomplete_suggestion", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          suggestions: [{ kind: "person", title: "Jane Cancer", href: "/scholars/jane-cancer" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    h.start = (cb: () => void) => cb();
    h.pending = true;
    stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");
    const sendBeacon = spyBeacon();

    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    await settle(300);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await settle(7100);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = await beaconPayload(sendBeacon);
    expect(body.surface).toBe("autocomplete_suggestion");
  });

  it("provider navigate() hang reports surface=search_results", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = true;
    stubLocation(
      "https://scholars-staging.weill.cornell.edu/search?q=cancer",
      "/search",
      "?q=cancer",
    );
    const sendBeacon = spyBeacon();

    const { SearchTransitionProvider, TransitionLink } = await import(
      "@/components/search/transition-link"
    );

    render(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=cancer&type=publications">Publications</TransitionLink>
      </SearchTransitionProvider>,
    );

    fireEvent.click(screen.getByText("Publications"));
    await settle(7100);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = await beaconPayload(sendBeacon);
    expect(body.event).toBe("search_nav_watchdog");
    expect(body.surface).toBe("search_results");
  });

  it("no beacon when the nav resolves (no false-positive telemetry)", async () => {
    h.start = (cb: () => void) => cb();
    h.pending = false;
    stubLocation("https://scholars-staging.weill.cornell.edu/", "/", "");
    const sendBeacon = spyBeacon();

    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await settle(10_000);
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});
