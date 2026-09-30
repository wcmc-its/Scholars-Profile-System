/**
 * CoreBasicsSection — the core editor's Basics block (replaces
 * `CoreDetailsCard`): Name locked for everyone, Description + Website behind
 * one floating save bar (one `/api/edit/core` POST per changed field), and the
 * public-listing toggle that POSTs `set_visible` immediately. Queries are
 * scoped to the rendered component.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: mockRefresh }),
}));

import { CoreBasicsSection } from "@/components/edit/core-basics-section";

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, changed: true }) });
}

function renderBasics(over: Partial<Parameters<typeof CoreBasicsSection>[0]> = {}) {
  const { container } = render(
    <CoreBasicsSection
      coreId="2"
      name="Example Core"
      description="Old blurb."
      url={null}
      visible={false}
      {...over}
    />,
  );
  return within(container);
}

const bodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CoreBasicsSection", () => {
  it("locks the name with the ask-a-superuser note; no name input", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    const view = renderBasics();
    expect(view.getByTestId("basics-name-locked").textContent).toBe("Example Core");
    expect(view.getByText(/Ask a superuser to rename it/)).toBeTruthy();
    expect(view.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect((view.getByTestId("basics-description") as HTMLTextAreaElement).value).toBe(
      "Old blurb.",
    );
  });

  it("no save bar until something changes; Discard restores", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    const view = renderBasics();
    expect(view.queryByTestId("basics-save-bar")).toBeNull();
    fireEvent.change(view.getByTestId("basics-url"), { target: { value: "https://x.test" } });
    expect(view.getByTestId("basics-save-bar")).toBeTruthy();
    fireEvent.click(view.getByTestId("basics-discard"));
    expect(view.queryByTestId("basics-save-bar")).toBeNull();
    expect((view.getByTestId("basics-url") as HTMLInputElement).value).toBe("");
  });

  it("one Save POSTs set_description and set_url, only for changed fields", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const view = renderBasics();
    fireEvent.change(view.getByTestId("basics-description"), { target: { value: "New blurb." } });
    fireEvent.change(view.getByTestId("basics-url"), { target: { value: "https://x.test" } });
    fireEvent.click(view.getByTestId("basics-save"));
    await waitFor(() => expect(view.getByTestId("basics-saved")).toBeTruthy());
    expect(bodies(fetchMock)).toEqual([
      { coreId: "2", action: "set_description", description: "New blurb." },
      { coreId: "2", action: "set_url", url: "https://x.test" },
    ]);
    expect(view.queryByTestId("basics-save-bar")).toBeNull();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("a failed field stays dirty with its error; the other still saves", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ ok: false, error: "invalid_url" }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;
    const view = renderBasics();
    fireEvent.change(view.getByTestId("basics-description"), { target: { value: "New." } });
    fireEvent.change(view.getByTestId("basics-url"), { target: { value: "nope" } });
    fireEvent.click(view.getByTestId("basics-save"));
    await waitFor(() => expect(view.getByTestId("basics-error")).toBeTruthy());
    expect(view.getByText("That doesn’t look like a valid https:// web address.")).toBeTruthy();
    expect(view.getByTestId("basics-save-bar")).toBeTruthy();
    expect(view.queryByTestId("basics-saved")).toBeNull();
  });

  it("the listing toggle POSTs set_visible immediately and refreshes the page", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const view = renderBasics();
    fireEvent.click(view.getByTestId("core-visible-toggle"));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(bodies(fetchMock)).toEqual([{ coreId: "2", action: "set_visible", visible: true }]);
    expect(view.getByTestId("core-visible-toggle").getAttribute("aria-checked")).toBe("true");
  });
});
