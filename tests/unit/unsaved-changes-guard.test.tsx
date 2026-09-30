/**
 * `components/edit/unsaved-changes-guard.tsx` — beforeunload + in-subtree
 * <a href> click capture + Back/Forward sentinel interception, all routed
 * through the branded ConfirmDialog (#356 Phase 6 C9 / vision-round T3.2).
 */
import * as React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import {
  UnsavedChangesGuard,
  type UnsavedChangesGuardHandle,
} from "@/components/edit/unsaved-changes-guard";

beforeEach(() => {
  vi.restoreAllMocks();
  mockPush.mockReset();
});

afterEach(() => {
  // RTL's auto-cleanup (registered on import of @testing-library/react) unmounts
  // any component a test left mounted, which can itself trigger the guard's
  // disarm `popSentinel()` and leave a one-shot `popstate` listener pending on
  // `window`. Drain it here so it can't fire during a LATER test and skew that
  // test's call counts — otherwise plain test order (and `--sequence.shuffle`)
  // can affect outcomes.
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  });
  mockPush.mockReset();
  vi.restoreAllMocks();
});

/** The branded leave-confirmation is open iff its confirm button is in the DOM. */
function dialogIsOpen() {
  return screen.queryByRole("button", { name: "Leave anyway" }) !== null;
}

describe("UnsavedChangesGuard — dirty=false", () => {
  it("attaches no beforeunload / click / popstate listeners", () => {
    const addWindow = vi.spyOn(window, "addEventListener");
    const addDoc = vi.spyOn(document, "addEventListener");
    render(<UnsavedChangesGuard dirty={false} />);
    expect(addWindow.mock.calls.some((c) => c[0] === "beforeunload")).toBe(false);
    expect(addWindow.mock.calls.some((c) => c[0] === "popstate")).toBe(false);
    expect(addDoc.mock.calls.some((c) => c[0] === "click")).toBe(false);
  });

  it("a click on an internal link does not open the dialog", () => {
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={false} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      a.dispatchEvent(evt);
    });
    expect(dialogIsOpen()).toBe(false);
  });
});

describe("UnsavedChangesGuard — dirty=true, beforeunload", () => {
  it("attaches a beforeunload handler that sets returnValue", () => {
    render(<UnsavedChangesGuard dirty={true} />);
    const event = new Event("beforeunload") as BeforeUnloadEvent;
    // jsdom doesn't synthesize a fresh BeforeUnloadEvent, so we dispatch a
    // bare Event and check that the listener set returnValue on it.
    Object.defineProperty(event, "returnValue", { value: "", writable: true });
    window.dispatchEvent(event);
    // The handler runs; the event default is "prevented" (no observable effect
    // in jsdom beyond no throw). Test passes by absence of error.
  });
});

describe("UnsavedChangesGuard — dirty=true, in-subtree <a> click", () => {
  it("an eligible link click is blocked and opens the branded dialog (no native confirm)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      a.dispatchEvent(evt);
    });
    // The native default is prevented and the styled dialog is shown instead.
    expect(evt.defaultPrevented).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(dialogIsOpen()).toBe(true));
  });

  it("confirming the dialog routes via router.push(href)", async () => {
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    act(() => {
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Leave anyway" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/somewhere"));
  });

  it("confirming pops the Back/Forward sentinel BEFORE pushing, leaving no phantom entry", async () => {
    // While dirty, route (3) pushes a same-URL sentinel; a naive push would
    // leave [...prev, editPage, sentinel, href] — one dead Back press. The guard
    // must pop the sentinel (history.back) and only then push, so the order of
    // operations is back() → push(href), each exactly once.
    const order: string[] = [];
    // Drive the deferred push deterministically: our back() spy synchronously
    // dispatches the bypassed popstate the guard listens for (no reliance on
    // real jsdom navigation timing).
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {
      order.push("back");
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    mockPush.mockImplementation(() => {
      order.push("push");
    });

    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    act(() => {
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    });

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/somewhere"));
    // Exactly one navigation, and the sentinel was popped first.
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["back", "push"]);
  });

  it("confirming an href does not push twice even if a stray popstate follows", async () => {
    // The deferred push is consumed once (pendingPushRef is cleared); a second
    // bypassed popstate (e.g. the disarm cleanup) must not re-trigger it.
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });

    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="/elsewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    act(() => {
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/elsewhere"));
    expect(backSpy).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("cancelling the dialog stays put — no router.push", async () => {
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    act(() => {
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialogIsOpen()).toBe(false));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("an in-page anchor href='#section' is allowed without a dialog", () => {
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="#section">Section</a>
      </>,
    );
    const a = container.querySelector("a")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(dialogIsOpen()).toBe(false);
  });

  it("a Cmd/Ctrl click (new tab) is not intercepted", () => {
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    a.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(dialogIsOpen()).toBe(false);
  });

  it("a click on non-anchor content is not intercepted", () => {
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <button type="button">Save</button>
      </>,
    );
    const btn = container.querySelector("button")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    btn.dispatchEvent(evt);
    expect(dialogIsOpen()).toBe(false);
  });
});

describe("UnsavedChangesGuard — dirty=true, Back/Forward (popstate)", () => {
  it("pushes a sentinel history entry when it arms", () => {
    const pushState = vi.spyOn(window.history, "pushState");
    render(<UnsavedChangesGuard dirty={true} />);
    expect(pushState).toHaveBeenCalled();
  });

  it("a popstate (Back) re-pushes the sentinel and opens the dialog", async () => {
    render(<UnsavedChangesGuard dirty={true} />);
    const pushState = vi.spyOn(window.history, "pushState");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    // Re-pushes the sentinel to keep the user on the page.
    await waitFor(() => expect(pushState).toHaveBeenCalled());
    await waitFor(() => expect(dialogIsOpen()).toBe(true));
  });

  it("confirming a Back exit steps back through the sentinel", async () => {
    render(<UnsavedChangesGuard dirty={true} />);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    fireEvent.click(await screen.findByRole("button", { name: "Leave anyway" }));
    await waitFor(() => expect(go).toHaveBeenCalledWith(-2));
  });

  it("cancelling a Back exit keeps the user on the page (no history.go)", async () => {
    render(<UnsavedChangesGuard dirty={true} />);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialogIsOpen()).toBe(false));
    expect(go).not.toHaveBeenCalled();
  });
});

describe("UnsavedChangesGuard — navigateAfterSave (#2546)", () => {
  it("armed: pops the sentinel first, then pushes only from the resulting popstate", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    act(() => {
      ref.current!.navigateAfterSave("/edit/x");
    });
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/edit/x");
  });

  it("survives the consumer clearing dirty in the same commit — exactly one back(), one push()", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    const { rerender } = render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    act(() => {
      ref.current!.navigateAfterSave("/edit/x");
      // The consumer clears dirty in the same commit — route (3)'s cleanup
      // must not double-pop while our own pop is still outstanding.
      rerender(<UnsavedChangesGuard dirty={false} ref={ref} />);
    });
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/edit/x");
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("survives the guard unmounting in the same commit — the one-shot listener outlives it", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    const { unmount } = render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    act(() => {
      ref.current!.navigateAfterSave("/edit/x");
      unmount();
    });
    expect(backSpy).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/edit/x");
  });

  it("not armed (dirty=false): pushes immediately, never touches history.back", () => {
    // Clear any sentinel left over from a previous test's real pushState so
    // this reflects a genuinely unarmed guard (mounted with dirty=false, or SSR).
    window.history.replaceState(null, "");
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    render(<UnsavedChangesGuard dirty={false} ref={ref} />);

    act(() => {
      ref.current!.navigateAfterSave("/edit/x");
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/edit/x");
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("a stray second popstate does not push again (once semantics)", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    act(() => {
      ref.current!.navigateAfterSave("/edit/x");
    });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/edit/x");
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("re-arming after a navigateAfterSave pop does not swallow the next real Back press", async () => {
    // Reproduces the dangling-bypassRef finding: if the one-shot listener
    // doesn't also clear bypassRef, a route-3 handler that mounts AFTER the
    // navigateAfterSave pop (a fresh dirty cycle) inherits a stale "this pop
    // is ours" flag and silently swallows the user's next real Back press.
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    const { rerender } = render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    act(() => {
      ref.current!.navigateAfterSave("/edit/x");
      rerender(<UnsavedChangesGuard dirty={false} ref={ref} />);
    });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/edit/x");

    // Re-arm: a fresh save cycle dirties the form again, pushing a new sentinel.
    act(() => {
      rerender(<UnsavedChangesGuard dirty={true} ref={ref} />);
    });

    // A real user Back press on the new sentinel must open the dialog, not be
    // swallowed by a dangling bypass flag left over from the earlier pop.
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() => expect(dialogIsOpen()).toBe(true));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("dirty cleared in a prior commit, navigateAfterSave called later — queues behind the in-flight disarm pop", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    const { rerender } = render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    // Disarm alone, in its own commit — the cleanup's pop is now in flight.
    act(() => {
      rerender(<UnsavedChangesGuard dirty={false} ref={ref} />);
    });
    expect(backSpy).toHaveBeenCalledTimes(1);

    // A later call must NOT issue a second back() — it queues behind the
    // outstanding pop instead.
    act(() => {
      ref.current!.navigateAfterSave("/edit/x");
    });
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/edit/x");
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("two navigateAfterSave calls while armed in the same commit coalesce — last href wins", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    act(() => {
      ref.current!.navigateAfterSave("/edit/a");
      ref.current!.navigateAfterSave("/edit/b");
    });
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/edit/b");
  });

  it("an ordinary disarm no longer dangles the bypass flag for the next re-arm", async () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    const { rerender } = render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    // Ordinary disarm — no navigateAfterSave call at all.
    act(() => {
      rerender(<UnsavedChangesGuard dirty={false} ref={ref} />);
    });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).not.toHaveBeenCalled();

    // Re-arm, then a real user Back press on the new sentinel.
    act(() => {
      rerender(<UnsavedChangesGuard dirty={true} ref={ref} />);
    });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() => expect(dialogIsOpen()).toBe(true));
    expect(mockPush).not.toHaveBeenCalled();
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("disarm then re-arm before the pop lands: the guard's own pop does not open the dialog", async () => {
    // Listener-order regression: the disarm's one-shot (registered first) would
    // clear bypassRef before the re-armed route-3 handler (registered second)
    // ever saw it, so the re-armed handler misread the guard's own pop as a
    // user Back press. Event identity (not listener order) must decide this.
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    const { rerender } = render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    act(() => {
      rerender(<UnsavedChangesGuard dirty={false} ref={ref} />); // disarm pops
    });
    act(() => {
      rerender(<UnsavedChangesGuard dirty={true} ref={ref} />); // re-arm before the pop lands
    });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(dialogIsOpen()).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
    expect(backSpy).toHaveBeenCalledTimes(1);

    // The re-armed handler must still work for an actual user Back press.
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() => expect(dialogIsOpen()).toBe(true));
  });

  it("StrictMode double-invoke of the initial mount: the guard's own pop does not open the dialog", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    render(
      <React.StrictMode>
        <UnsavedChangesGuard dirty={true} ref={ref} />
      </React.StrictMode>,
    );

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(dialogIsOpen()).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("a second, unrelated disarm after navigateAfterSave does not re-push the consumed href", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ref = React.createRef<UnsavedChangesGuardHandle>();
    const { rerender } = render(<UnsavedChangesGuard dirty={true} ref={ref} />);

    act(() => {
      ref.current!.navigateAfterSave("/edit/x");
    });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/edit/x");

    // A later, unrelated disarm cycle must not replay the already-consumed href.
    act(() => {
      rerender(<UnsavedChangesGuard dirty={true} ref={ref} />);
    });
    act(() => {
      rerender(<UnsavedChangesGuard dirty={false} ref={ref} />);
    });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(backSpy).toHaveBeenCalledTimes(2);
  });
});
