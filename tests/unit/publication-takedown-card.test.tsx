/**
 * `components/edit/publication-takedown-card.tsx` — the three-state takedown
 * card (#356 Phase 7 C7, UI-SPEC § /edit/publication/[pmid] Card 2).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { PublicationTakedownCard } from "@/components/edit/publication-takedown-card";

const PMID = "12345";

beforeEach(() => {
  vi.restoreAllMocks();
  mockRefresh.mockReset();
});

function stubFetch(opts: { status?: number; body: object }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(opts.body), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const ACTIVE_TAKEDOWN = {
  id: "sup-takedown",
  reason: "retraction notice",
  actorCwid: "adm001",
  createdAt: new Date("2026-05-15"),
};

describe("PublicationTakedownCard — visible state (no takedown, ≥1 displayed WCM author)", () => {
  it("renders 'visible on the site' + the Remove button", () => {
    render(<PublicationTakedownCard pmid={PMID} takedown={null} derivedDark={false} />);
    expect(screen.getByText(/visible on the site/i)).toBeTruthy();
    expect(screen.getByTestId("publication-takedown-remove")).toBeTruthy();
  });

  it("Remove opens a required-text confirm dialog; submission posts /api/edit/suppress", async () => {
    const f = stubFetch({ body: { ok: true, suppressionId: "sup-new" } });
    render(<PublicationTakedownCard pmid={PMID} takedown={null} derivedDark={false} />);
    fireEvent.click(screen.getByTestId("publication-takedown-remove"));
    // Required-text dialog → confirm disabled until a reason is typed
    const confirm = await screen.findByRole("button", { name: "Remove publication" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    const ta = screen.getByLabelText("Reason") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "PMID retracted 2026-05-12" } });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/suppress");
    expect(JSON.parse(opts.body as string)).toEqual({
      entityType: "publication",
      entityId: PMID,
      contributorCwid: null,
      reason: "PMID retracted 2026-05-12",
    });
    // The card flips into the removed-state visualization.
    await waitFor(() =>
      expect(screen.getByTestId("publication-takedown-removed")).toBeTruthy(),
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("Remove failure renders the destructive error Alert and keeps the publication visible", async () => {
    stubFetch({ status: 500, body: { ok: false, error: "write_failed" } });
    render(<PublicationTakedownCard pmid={PMID} takedown={null} derivedDark={false} />);
    fireEvent.click(screen.getByTestId("publication-takedown-remove"));
    const confirm = await screen.findByRole("button", { name: "Remove publication" });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "x" } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(screen.getByTestId("publication-takedown-error")).toBeTruthy(),
    );
    // The card is still in visible state (not flipped into removed).
    expect(screen.queryByTestId("publication-takedown-removed")).toBeNull();
  });
});

describe("PublicationTakedownCard — removed state (explicit takedown)", () => {
  it("renders the destructive Alert with reason / actor / date + Restore button", () => {
    render(
      <PublicationTakedownCard pmid={PMID} takedown={ACTIVE_TAKEDOWN} derivedDark={false} />,
    );
    const alert = screen.getByTestId("publication-takedown-removed");
    expect(alert.textContent).toContain("Removed from the site");
    expect(alert.textContent).toContain("retraction notice");
    expect(alert.textContent).toContain("adm001");
    expect(screen.getByTestId("publication-takedown-restore")).toBeTruthy();
    // No Remove button in the removed state.
    expect(screen.queryByTestId("publication-takedown-remove")).toBeNull();
  });

  it("Restore POSTs /api/edit/revoke with the takedown row's id (no dialog)", async () => {
    const f = stubFetch({ body: { ok: true, suppressionId: ACTIVE_TAKEDOWN.id } });
    render(
      <PublicationTakedownCard pmid={PMID} takedown={ACTIVE_TAKEDOWN} derivedDark={false} />,
    );
    fireEvent.click(screen.getByTestId("publication-takedown-restore"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/revoke");
    expect(JSON.parse(opts.body as string)).toEqual({ suppressionId: ACTIVE_TAKEDOWN.id });
    // After success the card flips back to visible.
    await waitFor(() => expect(screen.getByText(/visible on the site/i)).toBeTruthy());
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("Restore failure renders the destructive Alert; card remains in removed state", async () => {
    stubFetch({ status: 500, body: { ok: false, error: "write_failed" } });
    render(
      <PublicationTakedownCard pmid={PMID} takedown={ACTIVE_TAKEDOWN} derivedDark={false} />,
    );
    fireEvent.click(screen.getByTestId("publication-takedown-restore"));
    await waitFor(() => expect(screen.getByTestId("publication-takedown-error")).toBeTruthy());
    expect(screen.getByTestId("publication-takedown-removed")).toBeTruthy();
  });
});

describe("PublicationTakedownCard — derived dark state", () => {
  it("renders the info Alert + the Remove button (takedown may still be added on top)", () => {
    render(<PublicationTakedownCard pmid={PMID} takedown={null} derivedDark={true} />);
    expect(screen.getByTestId("publication-takedown-dark")).toBeTruthy();
    // The Remove control is still present per UI-SPEC: "A takedown may still be added on top."
    expect(screen.getByTestId("publication-takedown-remove")).toBeTruthy();
  });

  it("the visible-state copy is NOT rendered in dark state", () => {
    render(<PublicationTakedownCard pmid={PMID} takedown={null} derivedDark={true} />);
    expect(screen.queryByText(/visible on the site/i)).toBeNull();
  });
});
