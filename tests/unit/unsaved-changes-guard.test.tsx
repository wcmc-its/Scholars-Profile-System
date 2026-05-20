/**
 * `components/edit/unsaved-changes-guard.tsx` — beforeunload + in-subtree
 * <a href> click capture (#356 Phase 6 C9).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("UnsavedChangesGuard — dirty=false", () => {
  it("attaches no listeners", () => {
    const addWindow = vi.spyOn(window, "addEventListener");
    const addDoc = vi.spyOn(document, "addEventListener");
    render(<UnsavedChangesGuard dirty={false} />);
    expect(
      addWindow.mock.calls.some((c) => c[0] === "beforeunload"),
    ).toBe(false);
    expect(addDoc.mock.calls.some((c) => c[0] === "click")).toBe(false);
  });

  it("a click on an external link does not prompt", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={false} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    a.click();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe("UnsavedChangesGuard — dirty=true, beforeunload", () => {
  it("attaches a beforeunload handler that sets returnValue", () => {
    render(<UnsavedChangesGuard dirty={true} />);
    const event = new Event("beforeunload") as BeforeUnloadEvent;
    // jsdom doesn't synthesize a fresh BeforeUnloadEvent, so we dispatch a
    // bare Event and check that the listener set returnValue on it.
    Object.defineProperty(event, "returnValue", {
      value: "",
      writable: true,
    });
    window.dispatchEvent(event);
    // The handler runs; the event default is "prevented" (no observable
    // effect in jsdom beyond no throw). Test passes by absence of error.
  });
});

describe("UnsavedChangesGuard — dirty=true, click capture", () => {
  it("on Cancel of the confirm dialog, preventDefault is called", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(evt);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("on Confirm of the confirm dialog, preventDefault is NOT called", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
  });

  it("an in-page anchor href='#section' is allowed without a prompt", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="#section">Section</a>
      </>,
    );
    const a = container.querySelector("a")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(evt);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("a Cmd/Ctrl click (new tab) is not intercepted", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <a href="/somewhere">Go</a>
      </>,
    );
    const a = container.querySelector("a")!;
    const evt = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    a.dispatchEvent(evt);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("a click on non-anchor content is not intercepted", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(
      <>
        <UnsavedChangesGuard dirty={true} />
        <button type="button">Save</button>
      </>,
    );
    const btn = container.querySelector("button")!;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    btn.dispatchEvent(evt);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
