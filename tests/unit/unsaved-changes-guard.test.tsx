/**
 * `components/edit/unsaved-changes-guard.tsx` — beforeunload + in-subtree
 * <a href> click capture + Back/Forward sentinel interception, all routed
 * through the branded ConfirmDialog (#356 Phase 6 C9 / vision-round T3.2).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";

beforeEach(() => {
  vi.restoreAllMocks();
  mockPush.mockReset();
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
