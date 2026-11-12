/**
 * In-page help on the /edit review queues: the shared "How this queue works"
 * toggle (`components/edit/queue-intro.tsx`) and the read-only notice
 * (`components/edit/queue-help.tsx`) on the Honors, News and Media highlights
 * pages. Grant attribution, ORCID coverage and Titles are covered in their
 * own page tests.
 *
 * Fixture people are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`__REDIRECT__ ${to}`);
  }),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("next/navigation", () => ({ notFound: h.notFound, redirect: h.redirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: () => null }));
vi.mock("@/components/edit/honors-queue", () => ({ HonorsQueue: () => null }));
vi.mock("@/components/edit/news-approval-queue", () => ({ NewsApprovalQueue: () => null }));
vi.mock("@/components/edit/media-highlights-queue", () => ({ MediaHighlightsQueue: () => null }));
vi.mock("@/lib/honors/run-now", () => ({ isHonorsRunNowEnabled: () => false }));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  loadSlugRequestQueue: vi.fn(async () => []),
  countPendingSlugRequests: vi.fn(),
}));
vi.mock("@/lib/edit/honor-queue", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/honor-queue")>()),
  isHonorQueueEnabled: () => true,
  loadHonorQueue: vi.fn(async () => []),
  loadHonorSources: vi.fn(async () => []),
  loadDoctoralDegrees: vi.fn(async () => new Map()),
  countPendingHonors: vi.fn(async () => 0),
}));
vi.mock("@/lib/edit/news-queue", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/news-queue")>()),
  isNewsQueueEnabled: () => true,
  isMediaHighlightsQueueEnabled: () => true,
  loadNewsQueue: vi.fn(async () => []),
  loadNewsQueueCounts: vi.fn(async () => ({})),
}));

import HonorsQueuePage from "@/app/edit/honors-queue/page";
import MediaHighlightsQueuePage from "@/app/edit/media-highlights-queue/page";
import NewsQueuePage from "@/app/edit/news-queue/page";

const SUPER = { cwid: "zzs0001", isSuperuser: true, isCommsSteward: false };
const CURATOR = {
  cwid: "zzh0001",
  isSuperuser: false,
  isCommsSteward: false,
  isHonorsCurator: true,
};
// The read session's synthetic steward views (`lib/auth/observer-view.ts`).
const OBSERVER = { cwid: "zzo0001", isSuperuser: false, isCommsSteward: true, isObserver: true };
const EDITOR = { cwid: "zze0001", isSuperuser: false, isCommsSteward: true, isContentEditor: true };
const STEWARD = { cwid: "zzc0001", isSuperuser: false, isCommsSteward: true };

beforeEach(() => {
  h.session.mockReset();
});

async function renderPage(page: () => Promise<unknown>, session: object) {
  h.session.mockResolvedValue(session);
  return render(<>{(await page()) as ReactNode}</>);
}

describe("Honors", () => {
  it.each([
    ["superuser", SUPER, false],
    ["honors curator", CURATOR, false],
    ["observer", OBSERVER, true],
    ["content editor", EDITOR, true],
  ])("%s → read-only note only when they cannot decide", async (_n, s, shown) => {
    const r = await renderPage(HonorsQueuePage, s);
    const note = r.queryByTestId("honors-read-only-note");
    expect(note !== null).toBe(shown);
    if (note) {
      expect(note.getAttribute("role")).toBe("note");
      expect(note.textContent).toContain(
        "Only administrators and honors curators can decide. If you should be able to, ask an administrator",
      );
    }
  });

  it("opens the match levels from How this queue works", async () => {
    await renderPage(HonorsQueuePage, CURATOR);
    const toggle = screen.getByTestId("honors-queue-guide-toggle");
    const panel = screen.getByTestId("honors-queue-guide");
    expect(toggle.textContent).toBe("How this queue works");
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.hasAttribute("hidden")).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("Hide how this queue works");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hasAttribute("hidden")).toBe(false);
    for (const term of ["Strong", "Likely", "Weak", "Pick 1 of N", "Approve", "Undo"]) {
      expect(panel.textContent).toContain(term);
    }
    expect(panel.textContent).toContain("A nickname match counts as a failed check.");
  });
});

describe.each([
  ["News", NewsQueuePage, "news-queue", "stories"],
  ["Media highlights", MediaHighlightsQueuePage, "media-highlights-queue", "clips"],
] as const)("%s", (_name, page, id, noun) => {
  it.each([
    ["superuser", SUPER, false],
    ["comms steward", STEWARD, false],
    ["content editor", EDITOR, false],
    ["observer", OBSERVER, true],
  ])("%s → read-only note only for an observer", async (_n, s, shown) => {
    const r = await renderPage(page, s);
    const note = r.queryByTestId(`${id}-read-only-note`);
    expect(note !== null).toBe(shown);
    if (note) expect(note.textContent).toContain(`you can’t approve or reject ${noun}`);
  });

  it("has a closed How this queue works panel naming who can decide", async () => {
    await renderPage(page, STEWARD);
    const panel = screen.getByTestId(`${id}-guide`);
    expect(panel.hasAttribute("hidden")).toBe(true);
    expect(panel.textContent).toContain(
      "Administrators, communications stewards and content editors. Observers can view.",
    );
  });
});

describe("copy rules", () => {
  it("uses no em dashes and none of the internal words", async () => {
    for (const [page, s] of [
      [HonorsQueuePage, CURATOR],
      [HonorsQueuePage, OBSERVER],
      [NewsQueuePage, OBSERVER],
      [MediaHighlightsQueuePage, OBSERVER],
    ] as const) {
      const r = await renderPage(page, s);
      const text = r.container.textContent ?? "";
      expect(text).not.toContain("—");
      expect(text).not.toMatch(/\b(band|cue)s?\b/i);
      r.unmount();
    }
  });
});
