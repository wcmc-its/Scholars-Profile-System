/**
 * In-page help on the /edit review queues: the shared "How this queue works"
 * toggle (`components/edit/queue-intro.tsx`) and the read-only notice
 * (`components/edit/queue-help.tsx`) on the Honors, News and Media highlights
 * pages, including under "View as" (`viewAsWriteState`). Grant attribution,
 * ORCID coverage and Titles are covered in their own page tests.
 *
 * Fixture people are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  viewAs: vi.fn(),
  honorsProps: vi.fn(),
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
vi.mock("@/lib/edit/request", () => ({ viewAsWriteState: h.viewAs }));
vi.mock("@/components/edit/honors-queue", () => ({
  HonorsQueue: (p: unknown) => {
    h.honorsProps(p);
    return null;
  },
}));
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
import { OrcidQueueGuide } from "@/components/edit/queue-guides";

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

const NOT_VIEWING = { viewingAs: false, writesRefused: false };
// View as started by an observer or content editor: every write refused.
const REFUSED = { viewingAs: true, writesRefused: true };
// View as started by a superuser, IMPERSONATION_READONLY off: writes allowed.
const ALLOWED = { viewingAs: true, writesRefused: false };
const VIEW_AS_TEXT = "Read-only while viewing as someone else.";
const BULK = "An administrator may approve strong matches in bulk";

beforeEach(() => {
  h.session.mockReset();
  h.viewAs.mockReset().mockResolvedValue(NOT_VIEWING);
  h.honorsProps.mockReset();
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

  it("a refused View as is read-only with the View as wording, even over a curator", async () => {
    h.viewAs.mockResolvedValue(REFUSED);
    const r = await renderPage(HonorsQueuePage, CURATOR);
    expect(r.getByTestId("honors-read-only-note").textContent).toContain(VIEW_AS_TEXT);
    expect(h.honorsProps.mock.calls.at(-1)![0]).toMatchObject({ readOnly: true });
  });

  it("a superuser's View as of a curator can still decide", async () => {
    h.viewAs.mockResolvedValue(ALLOWED);
    const r = await renderPage(HonorsQueuePage, CURATOR);
    expect(r.queryByTestId("honors-read-only-note")).toBeNull();
    expect(h.honorsProps.mock.calls.at(-1)![0]).toMatchObject({ readOnly: false });
  });

  it("a superuser's View as of an observer says View as, not ask an administrator", async () => {
    h.viewAs.mockResolvedValue(ALLOWED);
    const r = await renderPage(HonorsQueuePage, OBSERVER);
    expect(r.getByTestId("honors-read-only-note").textContent).toContain(VIEW_AS_TEXT);
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
    expect(panel.textContent).toContain(BULK);
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

  it.each([
    ["comms steward", STEWARD],
    ["content editor", EDITOR],
  ])("a refused View as over a %s → the View as note", async (_n, s) => {
    h.viewAs.mockResolvedValue(REFUSED);
    const r = await renderPage(page, s);
    expect(r.getByTestId(`${id}-read-only-note`).textContent).toContain(VIEW_AS_TEXT);
  });

  it("a superuser's View as: no note for a steward, the View as note for an observer", async () => {
    h.viewAs.mockResolvedValue(ALLOWED);
    let r = await renderPage(page, STEWARD);
    expect(r.queryByTestId(`${id}-read-only-note`)).toBeNull();
    r.unmount();
    r = await renderPage(page, OBSERVER);
    expect(r.getByTestId(`${id}-read-only-note`).textContent).toContain(VIEW_AS_TEXT);
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

describe("match and action copy", () => {
  async function panelText(page: () => Promise<unknown>) {
    const r = await renderPage(page, STEWARD);
    const text = r.getByTestId(
      page === NewsQueuePage ? "news-queue-guide" : "media-highlights-queue-guide",
    ).textContent;
    r.unmount();
    return text ?? "";
  }

  it("News: HIGH needs a tag or several signs, and Approve all is scoped", async () => {
    const text = await panelText(NewsQueuePage);
    expect(text).toContain("The newsroom tagged this scholar on the story, or several signs agree");
    expect(text).toContain("One sign alone is not enough.");
    expect(text).toContain("Shown when a story names more than one scholar.");
    expect(text).toContain("A shared name stays waiting until you pick the right person.");
    expect(text).toContain(BULK);
  });

  it("Media highlights: High is the Dr. name in the clip summary; no bulk approval", async () => {
    const text = await panelText(MediaHighlightsQueuePage);
    expect(text).toContain("The clip summary from Communications names the scholar as “Dr.”");
    expect(text).not.toContain(BULK);
    expect(text).not.toContain("Bulk approval");
    expect(text).not.toContain("photo caption");
  });

  it("ORCID: email-verified auto-confirm is a may, not a promise", () => {
    const r = render(<OrcidQueueGuide />);
    const text = r.container.textContent ?? "";
    expect(text).toContain("Email-verified iDs with no conflict may be confirmed automatically");
    expect(text).not.toContain("is confirmed automatically");
    expect(text).not.toContain("—");
    expect(text).toContain(BULK);
    r.unmount();
  });
});

describe("copy rules", () => {
  it("uses no em dashes and none of the internal words", async () => {
    for (const [page, s] of [
      [HonorsQueuePage, CURATOR],
      [HonorsQueuePage, OBSERVER],
      [NewsQueuePage, OBSERVER],
      [MediaHighlightsQueuePage, OBSERVER],
      [NewsQueuePage, STEWARD],
      [MediaHighlightsQueuePage, STEWARD],
    ] as const) {
      const r = await renderPage(page, s);
      const text = r.container.textContent ?? "";
      expect(text).not.toContain("—");
      expect(text).not.toMatch(/\b(band|cue)s?\b/i);
      r.unmount();
    }
  });
});
