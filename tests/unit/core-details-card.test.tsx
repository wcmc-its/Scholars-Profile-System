/**
 * cores-as-org-units P3 — CoreDetailsCard: the `Core.description` / `Core.url`
 * / `Core.visible` editor.
 *
 *  - renders the initial description/url and the visibility badge;
 *  - Save is disabled until the field is dirty; editing + Save POSTs
 *    set_description / set_url;
 *  - toggling the visibility switch POSTs set_visible immediately (no Save
 *    gate) and flips the badge.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { CoreDetailsCard } from "@/components/edit/core-details-card";

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, changed: true }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CoreDetailsCard", () => {
  it("renders the initial values and the Hidden badge", () => {
    global.fetch = okFetch() as unknown as typeof fetch;
    render(
      <CoreDetailsCard
        coreId="2"
        description="Old blurb."
        url="https://old.example.edu"
        visible={false}
      />,
    );
    expect((screen.getByTestId("core-description-input") as HTMLTextAreaElement).value).toBe(
      "Old blurb.",
    );
    expect((screen.getByTestId("core-url-input") as HTMLInputElement).value).toBe(
      "https://old.example.edu",
    );
    expect(screen.getByTestId("core-visible-badge").textContent).toBe("Hidden");
    expect((screen.getByTestId("core-description-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("editing the description enables Save, which POSTs set_description", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreDetailsCard coreId="2" description="Old blurb." url={null} visible={false} />);
    fireEvent.change(screen.getByTestId("core-description-input"), {
      target: { value: "New blurb." },
    });
    expect((screen.getByTestId("core-description-save") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("core-description-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ coreId: "2", action: "set_description", description: "New blurb." });
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("editing the URL and saving POSTs set_url", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreDetailsCard coreId="2" description={null} url={null} visible={false} />);
    fireEvent.change(screen.getByTestId("core-url-input"), {
      target: { value: "https://core.example.edu" },
    });
    fireEvent.click(screen.getByTestId("core-url-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "set_url", url: "https://core.example.edu" });
  });

  it("a failed save surfaces the mapped error and does not flip Saved", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: "description_too_long" }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreDetailsCard coreId="2" description="Old." url={null} visible={false} />);
    fireEvent.change(screen.getByTestId("core-description-input"), { target: { value: "New." } });
    fireEvent.click(screen.getByTestId("core-description-save"));
    await waitFor(() =>
      expect(screen.getByText("We couldn't save that. Check the value and try again.")).toBeTruthy(),
    );
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("toggling visibility POSTs set_visible immediately and flips the badge", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoreDetailsCard coreId="2" description={null} url={null} visible={false} />);
    fireEvent.click(screen.getByTestId("core-visible-toggle"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ coreId: "2", action: "set_visible", visible: true });
    await waitFor(() => expect(screen.getByTestId("core-visible-badge").textContent).toBe("Visible"));
  });
});
