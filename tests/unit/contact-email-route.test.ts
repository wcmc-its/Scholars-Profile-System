/**
 * email-visibility-spec § Cache-safety — GET /api/profile/[cwid]/contact-email.
 * The uncacheable institution-email reveal (the #866 sensitive-families pattern).
 * Entirely server-side and default-safe:
 *   - gate off                              → { email: null, viewer: "off" }
 *   - external viewer                       → { email: null, viewer: "external" }
 *   - internal viewer + public/institution  → { email, viewer: basis }
 *   - internal viewer + none/null/unknown   → { email: null, viewer: basis }
 * `isEmailVisibleToViewer` is the REAL pure gate (table A); the rest are mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/profile/[cwid]/contact-email/route";
import { resolveViewerContext } from "@/lib/auth/viewer-context";
import { isEmailReleaseGateEnabled } from "@/lib/profile/email-visibility-flags";
import { loadScholarContactEmail } from "@/lib/api/profile";

vi.mock("@/lib/auth/viewer-context", () => ({ resolveViewerContext: vi.fn() }));
vi.mock("@/lib/profile/email-visibility-flags", () => ({ isEmailReleaseGateEnabled: vi.fn() }));
vi.mock("@/lib/api/profile", () => ({ loadScholarContactEmail: vi.fn() }));

const EMAIL = "person@med.cornell.edu";

function call(cwid: string, opts: { reveal?: boolean; ua?: string } = {}) {
  const qs = opts.reveal ? "?reveal=1" : "";
  const headers = opts.ua ? { "user-agent": opts.ua } : undefined;
  return GET(
    new Request("http://localhost/api/profile/" + cwid + "/contact-email" + qs, {
      headers,
    }) as never,
    { params: Promise.resolve({ cwid }) },
  );
}

afterEach(() => {
  vi.mocked(resolveViewerContext).mockReset();
  vi.mocked(isEmailReleaseGateEnabled).mockReset();
  vi.mocked(loadScholarContactEmail).mockReset();
});

describe("GET /api/profile/[cwid]/contact-email", () => {
  it("gate off → null; never resolves a viewer or loads the email", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(false);
    const body = await (await call("p001")).json();
    expect(body.email).toBeNull();
    expect(body.viewer).toBe("off");
    expect(resolveViewerContext).not.toHaveBeenCalled();
    expect(loadScholarContactEmail).not.toHaveBeenCalled();
  });

  it("external viewer → null; never loads the email", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: false, basis: null });
    const body = await (await call("p001")).json();
    expect(body.email).toBeNull();
    expect(body.viewer).toBe("external");
    expect(loadScholarContactEmail).not.toHaveBeenCalled();
  });

  it("network viewer + institution + ?reveal=1 → reveals the email for ANY cwid", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "network" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue({
      email: EMAIL,
      emailVisibility: "institution",
    });
    const body = await (await call("p001", { reveal: true })).json();
    expect(body.email).toBe(EMAIL);
    expect(body.viewer).toBe("network");
    expect(loadScholarContactEmail).toHaveBeenCalledWith("p001");
  });

  it("internal viewer + public → reveals the email (endpoint stays consistent)", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "session" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue({ email: EMAIL, emailVisibility: "public" });
    const body = await (await call("p001")).json();
    expect(body.email).toBe(EMAIL);
  });

  it("internal viewer + none → null (fail-closed)", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "session" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue({ email: EMAIL, emailVisibility: "none" });
    const body = await (await call("p001")).json();
    expect(body.email).toBeNull();
  });

  it("internal viewer + unrecognized ('private') → null (fail-closed)", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "session" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue({ email: EMAIL, emailVisibility: "private" });
    const body = await (await call("p001")).json();
    expect(body.email).toBeNull();
  });

  it("internal viewer + unknown/soft-deleted scholar (null row) → null", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "session" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue(null);
    const body = await (await call("p001")).json();
    expect(body.email).toBeNull();
  });

  // Crawler hardening (2026-11-09 institution-email-reveal spec).

  it("network viewer WITHOUT ?reveal=1 → no address, revealable:true (button, not leak)", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "network" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue({
      email: EMAIL,
      emailVisibility: "institution",
    });
    const res = await call("p001");
    const text = await res.text();
    expect(text).not.toContain(EMAIL);
    expect(JSON.parse(text)).toEqual({ email: null, viewer: "network", revealable: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("network viewer WITHOUT ?reveal=1 + none → revealable:false (no dead button)", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "network" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue({ email: EMAIL, emailVisibility: "none" });
    const body = await (await call("p001")).json();
    expect(body).toEqual({ email: null, viewer: "network", revealable: false });
  });

  it("session viewer → auto-reveals without ?reveal=1", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "session" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue({
      email: EMAIL,
      emailVisibility: "institution",
    });
    const body = await (await call("p001")).json();
    expect(body.email).toBe(EMAIL);
  });

  it.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/131.0.0.0 Safari/537.36",
    "python-requests/2.32.3",
    "curl/8.7.1",
  ])("bot UA %s → external shape even with ?reveal=1; never resolves viewer or loads", async (ua) => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "network" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue({
      email: EMAIL,
      emailVisibility: "institution",
    });
    const body = await (await call("p001", { reveal: true, ua })).json();
    expect(body).toEqual({ email: null, viewer: "external" });
    expect(resolveViewerContext).not.toHaveBeenCalled();
    expect(loadScholarContactEmail).not.toHaveBeenCalled();
  });

  it("real browser UA from a network viewer still reveals on click", async () => {
    vi.mocked(isEmailReleaseGateEnabled).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "network" });
    vi.mocked(loadScholarContactEmail).mockResolvedValue({
      email: EMAIL,
      emailVisibility: "institution",
    });
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
    const body = await (await call("p001", { reveal: true, ua })).json();
    expect(body.email).toBe(EMAIL);
  });
});
