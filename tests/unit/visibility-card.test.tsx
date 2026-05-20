/**
 * `components/edit/visibility-card.tsx` — the four-state machine + hide/revoke
 * flows (#356 Phase 6 C6).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { VisibilityCard } from "@/components/edit/visibility-card";

const CWID = "self01";

type Sup = { ownRow: { id: string; reason: string } | null; adminRow: { id: string; reason: string; createdAt: Date } | null };

const NEITHER: Sup = { ownRow: null, adminRow: null };
const SELF: Sup = { ownRow: { id: "sup-self", reason: "privacy" }, adminRow: null };
const ADMIN: Sup = {
  ownRow: null,
  adminRow: { id: "sup-adm", reason: "compliance", createdAt: new Date("2026-05-01") },
};
const BOTH: Sup = { ...SELF, adminRow: ADMIN.adminRow };

beforeEach(() => {
  vi.restoreAllMocks();
  mockRefresh.mockReset();
});

function stubFetch(opts: { ok?: boolean; status?: number; body?: object } = {}) {
  const body = JSON.stringify(opts.body ?? { ok: true, suppressionId: "sup-new" });
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, { status: opts.status ?? 200 }),
  );
}

describe("VisibilityCard — visible state", () => {
  it("renders 'Hide my profile' and no alert", () => {
    render(<VisibilityCard cwid={CWID} suppression={NEITHER} />);
    expect(screen.getByText("Your profile is visible to the public.")).toBeTruthy();
    expect(screen.getByTestId("visibility-hide")).toBeTruthy();
    expect(screen.queryByText(/profile is hidden/i)).toBeNull();
  });

  it("Hide → dialog open → confirm → POST /api/edit/suppress → flips into hidden-self", async () => {
    const f = stubFetch({ body: { ok: true, suppressionId: "sup-fresh" } });
    render(<VisibilityCard cwid={CWID} suppression={NEITHER} />);
    fireEvent.click(screen.getByTestId("visibility-hide"));
    // Dialog opens with the optional-preset reason selector.
    const confirm = await screen.findByRole("button", { name: "Hide my profile" });
    fireEvent.click(confirm);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/suppress");
    // The dialog defaults to the "Information is out of date" preset; that
    // label is the stored reason (`self-edit-spec.md` § Suppression UX —
    // "the UI collects ... a preset", the preset IS the reason).
    expect(JSON.parse(opts.body as string)).toEqual({
      entityType: "scholar",
      entityId: CWID,
      reason: "Information is out of date",
    });
    // After success, the card flips into the hidden-self state.
    await waitFor(() =>
      expect(screen.getByText(/Your profile is hidden/i)).toBeTruthy(),
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("hide failure: shows destructive Alert and stays visible", async () => {
    stubFetch({ status: 500, body: { ok: false, error: "write_failed" } });
    render(<VisibilityCard cwid={CWID} suppression={NEITHER} />);
    fireEvent.click(screen.getByTestId("visibility-hide"));
    fireEvent.click(await screen.findByRole("button", { name: "Hide my profile" }));
    await waitFor(() =>
      expect(
        screen.getByText("We couldn't hide your profile. Please try again."),
      ).toBeTruthy(),
    );
    // Did not flip into hidden-self — the visible-state copy is still here.
    expect(screen.getByText("Your profile is visible to the public.")).toBeTruthy();
  });
});

describe("VisibilityCard — hidden-self state", () => {
  it("renders the self alert + 'Make my profile visible' button", () => {
    render(<VisibilityCard cwid={CWID} suppression={SELF} />);
    expect(screen.getByText(/Your profile is hidden/i)).toBeTruthy();
    expect(screen.getByTestId("visibility-revoke-self")).toBeTruthy();
  });

  it("revoke posts /api/edit/revoke with the own row's id; flips back to visible", async () => {
    const f = stubFetch({ body: { ok: true, suppressionId: "sup-self" } });
    render(<VisibilityCard cwid={CWID} suppression={SELF} />);
    fireEvent.click(screen.getByTestId("visibility-revoke-self"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/revoke");
    expect(JSON.parse(opts.body as string)).toEqual({ suppressionId: "sup-self" });
    await waitFor(() =>
      expect(screen.getByText("Your profile is visible to the public.")).toBeTruthy(),
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("revoke failure renders the destructive Alert", async () => {
    stubFetch({ status: 500, body: { ok: false, error: "write_failed" } });
    render(<VisibilityCard cwid={CWID} suppression={SELF} />);
    fireEvent.click(screen.getByTestId("visibility-revoke-self"));
    await waitFor(() =>
      expect(
        screen.getByText("We couldn't make your profile visible. Please try again."),
      ).toBeTruthy(),
    );
    // Still in the hidden-self state.
    expect(screen.getByTestId("visibility-revoke-self")).toBeTruthy();
  });
});

describe("VisibilityCard — hidden-admin state", () => {
  it("renders the admin alert and no restore control", () => {
    render(<VisibilityCard cwid={CWID} suppression={ADMIN} />);
    expect(
      screen.getByText(/Your profile has been hidden by a site administrator/i),
    ).toBeTruthy();
    expect(screen.queryByTestId("visibility-hide")).toBeNull();
    expect(screen.queryByTestId("visibility-revoke-self")).toBeNull();
    expect(screen.queryByTestId("visibility-revoke-own-hold")).toBeNull();
  });
});

describe("VisibilityCard — hidden-both state (edge case 4)", () => {
  it("shows admin alert + the 'You have also hidden it yourself.' line + 'Remove my hold'", () => {
    render(<VisibilityCard cwid={CWID} suppression={BOTH} />);
    expect(
      screen.getByText(/Your profile has been hidden by a site administrator/i),
    ).toBeTruthy();
    expect(screen.getByText("You have also hidden it yourself.")).toBeTruthy();
    expect(
      screen.getByText("The profile stays hidden while the administrator hold remains."),
    ).toBeTruthy();
    expect(screen.getByTestId("visibility-revoke-own-hold")).toBeTruthy();
  });

  it("Remove my hold posts /api/edit/revoke with the own row's id; the admin alert stays", async () => {
    stubFetch({ body: { ok: true, suppressionId: "sup-self" } });
    render(<VisibilityCard cwid={CWID} suppression={BOTH} />);
    fireEvent.click(screen.getByTestId("visibility-revoke-own-hold"));
    // After success, ownRow becomes null but adminRow remains — flips to admin-only state.
    await waitFor(() => expect(screen.queryByTestId("visibility-revoke-own-hold")).toBeNull());
    expect(
      screen.getByText(/Your profile has been hidden by a site administrator/i),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — superuser arm
// ---------------------------------------------------------------------------

describe("VisibilityCard — superuser arm (Phase 7) — visible target", () => {
  it("renders 'Hide this scholar's profile' and no admin alert", () => {
    render(
      <VisibilityCard cwid="other7" suppression={NEITHER} mode="superuser" scholarName="Alex Other" />,
    );
    expect(screen.getByText(/This scholar's profile is visible to the public/i)).toBeTruthy();
    expect(screen.getByTestId("visibility-hide")).toBeTruthy();
    expect(screen.getByTestId("visibility-hide").textContent).toContain("Hide this scholar");
  });

  it("Hide → dialog uses required-text, title includes the scholar name; confirm POSTs the reason", async () => {
    const f = stubFetch({ body: { ok: true, suppressionId: "sup-adm-new" } });
    render(
      <VisibilityCard cwid="other7" suppression={NEITHER} mode="superuser" scholarName="Alex Other" />,
    );
    fireEvent.click(screen.getByTestId("visibility-hide"));
    // The dialog title carries the scholar's name.
    expect(await screen.findByText("Hide Alex Other's profile?")).toBeTruthy();
    // The dialog renders a required textarea (UI-SPEC § Suppression — superuser
    // suppression's reason is mandatory).
    const ta = screen.getByLabelText("Reason") as HTMLTextAreaElement;
    expect(ta.getAttribute("aria-required")).toBe("true");
    // The confirm button is disabled with no reason text.
    const confirm = screen.getByRole("button", { name: "Hide profile" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    // Enter a reason → confirm enables → POST.
    fireEvent.change(ta, { target: { value: "compliance ticket SP-2026-019" } });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/suppress");
    expect(JSON.parse(opts.body as string)).toEqual({
      entityType: "scholar",
      entityId: "other7",
      reason: "compliance ticket SP-2026-019",
    });
    // After success the card flips into the hidden-admin state.
    await waitFor(() =>
      expect(screen.getByTestId("visibility-revoke-admin")).toBeTruthy(),
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("self-hidden-only target: superuser sees a self-hold note + can still add an admin hold", () => {
    render(
      <VisibilityCard cwid="other7" suppression={SELF} mode="superuser" scholarName="Alex Other" />,
    );
    expect(screen.getByText(/has self-hidden their profile/i)).toBeTruthy();
    expect(screen.getByTestId("visibility-hide")).toBeTruthy();
  });
});

describe("VisibilityCard — superuser arm (Phase 7) — admin-hidden target", () => {
  it("renders the admin reason + 'Restore this scholar's profile' button", () => {
    render(
      <VisibilityCard cwid="other7" suppression={ADMIN} mode="superuser" scholarName="Alex Other" />,
    );
    expect(screen.getByText(/administrator hold is in place/i)).toBeTruthy();
    expect(screen.getByText(/compliance/i)).toBeTruthy();
    expect(screen.getByTestId("visibility-revoke-admin")).toBeTruthy();
  });

  it("Restore POSTs /api/edit/revoke with the admin row's id; flips to visible", async () => {
    const f = stubFetch({ body: { ok: true, suppressionId: "sup-adm" } });
    render(
      <VisibilityCard cwid="other7" suppression={ADMIN} mode="superuser" scholarName="Alex Other" />,
    );
    fireEvent.click(screen.getByTestId("visibility-revoke-admin"));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, opts] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/revoke");
    expect(JSON.parse(opts.body as string)).toEqual({ suppressionId: "sup-adm" });
    await waitFor(() =>
      expect(screen.getByText(/This scholar's profile is visible/i)).toBeTruthy(),
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("admin + self: shows the self-hold note alongside the restore control", () => {
    render(
      <VisibilityCard cwid="other7" suppression={BOTH} mode="superuser" scholarName="Alex Other" />,
    );
    expect(screen.getByText(/administrator hold is in place/i)).toBeTruthy();
    expect(screen.getByText(/has also self-hidden/i)).toBeTruthy();
    expect(screen.getByTestId("visibility-revoke-admin")).toBeTruthy();
  });

  it("restore failure renders the destructive Alert and leaves the admin hold", async () => {
    stubFetch({ status: 500, body: { ok: false, error: "write_failed" } });
    render(
      <VisibilityCard cwid="other7" suppression={ADMIN} mode="superuser" scholarName="Alex Other" />,
    );
    fireEvent.click(screen.getByTestId("visibility-revoke-admin"));
    await waitFor(() =>
      expect(
        screen.getByText("We couldn't restore this scholar's profile. Please try again."),
      ).toBeTruthy(),
    );
    expect(screen.getByTestId("visibility-revoke-admin")).toBeTruthy();
  });
});

describe("VisibilityCard — props default ('self') is unchanged behavior", () => {
  it("omitting mode defaults to self — Phase 6 surface", () => {
    render(<VisibilityCard cwid={CWID} suppression={NEITHER} />);
    expect(screen.getByText("Your profile is visible to the public.")).toBeTruthy();
    // The data-mode attribute reflects the default.
    expect(document.querySelector('[data-slot="visibility-card"]')?.getAttribute("data-mode")).toBe(
      "self",
    );
  });
});
