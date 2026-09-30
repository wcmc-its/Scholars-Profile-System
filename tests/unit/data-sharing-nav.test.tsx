/**
 * `data-sharing-nav.tsx` — the /edit/data-sharing soft-navigation islands.
 * The dashboard test covers which links route through here; this file covers
 * the islands' own contract: the pending state while a navigation is in
 * flight, the no-provider fallback, and query-only href resolution.
 */
import { Suspense, use, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DataSharingNavProvider,
  DataSharingPendingRegion,
  DataSharingPendingStatus,
  formToQuery,
  SoftGetForm,
  SoftLink,
} from "@/components/edit/data-sharing-nav";

/** Stands in for the app router: `push` records the call and, when a test
 *  arms it, triggers a state update that suspends (like Next waiting on the
 *  new server render). */
let onPush: (() => void) | null = null;
const mockPush = vi.fn(() => onPush?.());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

beforeEach(() => {
  mockPush.mockClear();
  onPush = null;
  window.history.replaceState(null, "", "/edit/data-sharing?tier=US_OPEN");
});

function Suspends({ promise }: { promise: Promise<void> }) {
  use(promise);
  return <p>new render</p>;
}

describe("DataSharingNavProvider", () => {
  it("keeps the current content on screen, dimmed and busy, until the navigation lands", async () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));

    function Harness() {
      const [navigated, setNavigated] = useState(false);
      onPush = () => setNavigated(true);
      return (
        <DataSharingNavProvider>
          <DataSharingPendingStatus />
          <SoftLink href="?tier=CONCERN">Concern</SoftLink>
          <Suspense fallback={<p>skeleton</p>}>
            <DataSharingPendingRegion>
              {navigated ? <Suspends promise={promise} /> : <p>old render</p>}
            </DataSharingPendingRegion>
          </Suspense>
        </DataSharingNavProvider>
      );
    }

    render(<Harness />);
    const region = screen.getByTestId("ds-pending-region");
    expect(region.getAttribute("aria-busy")).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByText("Concern"));
    });
    expect(mockPush).toHaveBeenCalledWith("/edit/data-sharing?tier=CONCERN", { scroll: false });
    // The transition holds the revealed boundary: old content, no skeleton.
    expect(screen.getByText("old render")).toBeTruthy();
    expect(screen.queryByText("skeleton")).toBeNull();
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(region.className).toContain("opacity-55");
    expect(screen.getByRole("status").textContent).toBe("Updating…");

    await act(async () => {
      resolve();
      await promise;
    });
    expect(screen.getByText("new render")).toBeTruthy();
    expect(screen.getByTestId("ds-pending-region").getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("resolves a bare '?' (no filters) to the path with no query", () => {
    render(
      <DataSharingNavProvider>
        <SoftLink href="?">Any</SoftLink>
      </DataSharingNavProvider>,
    );
    fireEvent.click(screen.getByText("Any"));
    expect(mockPush).toHaveBeenCalledWith("/edit/data-sharing", { scroll: false });
  });

  it("does not intercept a link with a target", () => {
    render(
      <DataSharingNavProvider>
        <SoftLink href="?tier=CONCERN" target="_blank">
          New tab
        </SoftLink>
      </DataSharingNavProvider>,
    );
    expect(fireEvent.click(screen.getByText("New tab"))).toBe(true);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("outside a provider", () => {
  it("SoftLink and SoftGetForm fall back to the plain browser link and GET form", () => {
    const { container } = render(
      <>
        <SoftLink href="?tier=CONCERN">Concern</SoftLink>
        <SoftGetForm>
          <input name="yearFrom" defaultValue="2021" />
        </SoftGetForm>
      </>,
    );
    const form = container.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    // Default not prevented: the browser would navigate / submit as before.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    click.preventDefault = vi.fn(); // keep jsdom from attempting the navigation
    screen.getByText("Concern").dispatchEvent(click);
    expect(click.preventDefault).not.toHaveBeenCalled();
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    submit.preventDefault = vi.fn();
    form.dispatchEvent(submit);
    expect(submit.preventDefault).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("formToQuery", () => {
  it("serialises like a GET form, repeated names kept, empty fields dropped", () => {
    const form = document.createElement("form");
    form.innerHTML =
      '<input name="yearFrom" value="2021"><input name="yearTo" value="">' +
      '<input name="tier" value="US_OPEN"><input name="tier" value="CONCERN">';
    expect(formToQuery(form)).toBe("?yearFrom=2021&tier=US_OPEN&tier=CONCERN");
  });

  it("returns a bare '?' when every field is empty", () => {
    const form = document.createElement("form");
    form.innerHTML = '<input name="yearFrom" value="">';
    expect(formToQuery(form)).toBe("?");
  });
});
