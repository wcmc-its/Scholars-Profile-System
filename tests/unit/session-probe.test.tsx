/**
 * One `/api/auth/session` probe per page load (`components/site/session-probe.ts`).
 * The header, the always-mounted impersonation banner, the account menu it
 * upgrades to and a profile's owner button used to fetch it separately: up to
 * four identical uncached origin requests per page view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/scholars/jane-smith" }));

import { HeaderAuthSlot } from "@/components/site/header-auth-slot";
import { ImpersonationBanner } from "@/components/site/impersonation-banner";
import { EditMyProfileButton } from "@/components/scholar/edit-my-profile-button";
import { invalidateSessionProbe, probeSession, SIGNED_OUT } from "@/components/site/session-probe";

const SIGNED_IN = {
  authenticated: true,
  cwid: "abc1234",
  scholar: { slug: "jane-smith", preferredName: "Jane Smith" },
  impersonating: {
    targetCwid: "tgt0001",
    targetName: "Target Person",
    role: "scholar",
    unitKind: null,
    unit: null,
    startedAt: Math.floor(Date.now() / 1000),
  },
  canImpersonate: true,
  isSuperuser: true,
  consoleLinks: [],
};

function stubFetch(body: unknown = SIGNED_IN) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  invalidateSessionProbe();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared session probe", () => {
  it("makes ONE request per page load for the header, banner, account menu and owner button", async () => {
    const fetchMock = stubFetch();
    render(
      <>
        <ImpersonationBanner />
        <HeaderAuthSlot isAuthenticated={false} scholar={null} />
        <EditMyProfileButton profileSlug="jane-smith" profileCwid="abc1234" />
      </>,
    );

    // Every consumer rendered off the probe: the banner, the header's upgrade
    // to the account menu (which itself reads the probe), the owner button.
    await screen.findByTestId("impersonation-banner");
    await screen.findByLabelText("Account menu");
    await screen.findByTestId("edit-my-profile");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("reuses the settled answer, and refetches after invalidateSessionProbe()", async () => {
    const fetchMock = stubFetch();
    const first = await probeSession();
    expect(await probeSession()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateSessionProbe();
    const signedOut = { authenticated: false, scholar: null };
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(signedOut) });
    expect(await probeSession()).toEqual(signedOut);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const fetchMock = stubFetch();
    const [a, b] = await Promise.all([probeSession(), probeSession()]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed probe: the next caller retries", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) })
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(SIGNED_IN) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await probeSession()).toBeNull();
    expect(await probeSession()).toBeNull();
    expect((await probeSession())?.authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed to null when fetch is missing", async () => {
    vi.stubGlobal("fetch", undefined);
    expect(await probeSession()).toBeNull();
  });

  it("a mount after invalidation probes again (impersonation start/stop path)", async () => {
    const fetchMock = stubFetch();
    const { unmount } = render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);
    await screen.findByLabelText("Account menu");
    unmount();
    invalidateSessionProbe();
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

// tests/setup.ts gives every DOM test a browser holding the hint; these take it away.
describe("signed-in hint gate", () => {
  const cookieJar = (value: string) =>
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(value);

  it("skips the request and answers signed-out when the browser holds no hint", async () => {
    cookieJar("_ga=GA1.1.1");
    const fetchMock = stubFetch();
    render(
      <>
        <ImpersonationBanner />
        <HeaderAuthSlot isAuthenticated={false} scholar={null} />
        <EditMyProfileButton profileSlug="jane-smith" profileCwid="abc1234" />
      </>,
    );

    expect(await probeSession()).toEqual(SIGNED_OUT);
    await waitFor(() => expect(screen.getByTestId("header-sign-in")).toBeTruthy());
    expect(screen.queryByLabelText("Account menu")).toBeNull();
    expect(screen.queryByTestId("impersonation-banner")).toBeNull();
    expect(screen.queryByTestId("edit-my-profile")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an emptied or lookalike cookie as no hint", async () => {
    const fetchMock = stubFetch();
    for (const jar of [
      "sps_signed_in=",
      "xsps_signed_in=1",
      "sps_signed_in_old=1",
      "a=sps_signed_in=1",
    ]) {
      cookieJar(jar);
      expect(await probeSession()).toEqual(SIGNED_OUT);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes when the deployed __Host- hint is present", async () => {
    cookieJar("_ga=GA1.1.1; __Host-sps_signed_in=1");
    const fetchMock = stubFetch();
    expect((await probeSession())?.authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("probes when the local-http hint is present", async () => {
    cookieJar("sps_signed_in=1");
    const fetchMock = stubFetch();
    expect((await probeSession())?.authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
