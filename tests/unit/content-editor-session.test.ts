/**
 * The content editor in the two live session resolvers and R1. The role
 * checks are stubbed (the superuser one through its config, so it stays the
 * real function), which drives the composition directly:
 *   - `getEditSession` / `getEffectiveEditSession` apply the content-editor
 *     view BEFORE the observer view. Reversed, a member of both groups would
 *     come out an observer, and the write strip would leave them unable to
 *     edit anything.
 *   - `canImpersonate` admits a content editor (a read-only View as; write
 *     refusal under a non-superuser's overlay is in observer-role.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetSession, mockIsObserver, mockIsContentEditor } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockIsObserver: vi.fn(),
  mockIsContentEditor: vi.fn(),
}));
vi.mock("@/lib/auth/config", () => ({
  getSuperuserAllowlist: () => [],
  getSuperuserConfig: () => ({ groupCn: "" }),
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/auth/comms-steward", () => ({ isCommsSteward: vi.fn(async () => false) }));
vi.mock("@/lib/auth/data-sharing-viewer", () => ({ isDataSharingViewer: vi.fn(async () => false) }));
vi.mock("@/lib/auth/development", () => ({ isDeveloper: vi.fn(async () => false) }));
vi.mock("@/lib/auth/honors-curator", () => ({ isHonorsCurator: vi.fn(async () => false) }));
vi.mock("@/lib/auth/observer", () => ({ isObserver: mockIsObserver }));
vi.mock("@/lib/auth/content-editor", () => ({ isContentEditor: mockIsContentEditor }));

import { canImpersonate, getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { getEditSession } from "@/lib/auth/superuser";

beforeEach(() => {
  mockGetSession.mockResolvedValue({ cwid: "cedit1", iat: 0, exp: 0 });
  mockIsObserver.mockResolvedValue(false);
  mockIsContentEditor.mockResolvedValue(false);
});

describe.each([
  ["getEditSession", getEditSession],
  ["getEffectiveEditSession", getEffectiveEditSession],
])("%s", (_name, resolve) => {
  it("a content editor gets the flagged synthetic steward read view", async () => {
    mockIsContentEditor.mockResolvedValue(true);
    const s = await resolve();
    expect(s).toMatchObject({ isCommsSteward: true, isContentEditor: true });
    expect(s?.isObserver).toBeUndefined();
  });

  it("a member of both groups is a content editor, not a view-only observer", async () => {
    mockIsContentEditor.mockResolvedValue(true);
    mockIsObserver.mockResolvedValue(true);
    const s = await resolve();
    expect(s?.isContentEditor).toBe(true);
    expect(s?.isObserver).toBeUndefined();
  });

  it("an observer alone stays view-only", async () => {
    mockIsObserver.mockResolvedValue(true);
    const s = await resolve();
    expect(s).toMatchObject({ isCommsSteward: true, isObserver: true });
    expect(s?.isContentEditor).toBeUndefined();
  });
});

describe("canImpersonate — content editor", () => {
  it("admits a content editor", async () => {
    mockIsContentEditor.mockResolvedValue(true);
    expect(await canImpersonate("cedit1")).toBe(true);
  });

  it("still refuses someone with none of the three roles", async () => {
    expect(await canImpersonate("nobody")).toBe(false);
  });
});
