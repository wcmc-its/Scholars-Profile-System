/**
 * R1 (`canImpersonate`): a content editor may start a read-only "View as",
 * like an observer. The role checks are stubbed so the leg is driven directly;
 * write refusal under a non-superuser's overlay is covered in
 * observer-role.test.ts (`impersonation_readonly`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIsSuperuser, mockIsObserver, mockIsContentEditor } = vi.hoisted(() => ({
  mockIsSuperuser: vi.fn(),
  mockIsObserver: vi.fn(),
  mockIsContentEditor: vi.fn(),
}));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: mockIsSuperuser }));
vi.mock("@/lib/auth/observer", () => ({ isObserver: mockIsObserver }));
vi.mock("@/lib/auth/content-editor", () => ({ isContentEditor: mockIsContentEditor }));

import { canImpersonate } from "@/lib/auth/effective-identity";

beforeEach(() => {
  mockIsSuperuser.mockResolvedValue(false);
  mockIsObserver.mockResolvedValue(false);
  mockIsContentEditor.mockResolvedValue(false);
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
