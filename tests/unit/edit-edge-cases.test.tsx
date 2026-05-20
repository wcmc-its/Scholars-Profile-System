/**
 * Phase 7 C8 — edge-case gap-fill (`#356`, plan §10.3, verification walk
 * recorded in `.planning/self-edit-v1-phase7-verification.md`).
 *
 * Most SPEC + UI-SPEC edge-case rows are already covered by per-component /
 * per-route unit tests; the walk identified these specific gaps that benefit
 * from explicit coverage at the integration seam. Each row referenced below
 * links back to the verification doc's table.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// SPEC #20 — slug override for a CWID with no Scholar row yet (incoming hire)
//
// ADR-005 edge case 6 / #29 reservation: the field route stores the override
// despite no Scholar row existing yet. checkSlugCollision is FK-less; the
// validator path is purely lookup-vs-existing. Gap-fill: the field route
// itself accepts the write end-to-end.
// ---------------------------------------------------------------------------

describe("SPEC edge 20 — slug override for a CWID with no Scholar row", () => {
  const {
    mockGetEditSession,
    mockTransaction,
    mockFieldOverrideFindUnique,
    mockFieldOverrideUpsert,
    mockExecuteRaw,
    mockScholarFindFirst,
    mockFieldOverrideFindFirst,
    mockSlugHistoryFindFirst,
    mockReflectOverviewEdit,
    mockResolveProfiles,
  } = vi.hoisted(() => ({
    mockGetEditSession: vi.fn(),
    mockTransaction: vi.fn(),
    mockFieldOverrideFindUnique: vi.fn(),
    mockFieldOverrideUpsert: vi.fn(),
    mockExecuteRaw: vi.fn(),
    mockScholarFindFirst: vi.fn(),
    mockFieldOverrideFindFirst: vi.fn(),
    mockSlugHistoryFindFirst: vi.fn(),
    mockReflectOverviewEdit: vi.fn(),
    mockResolveProfiles: vi.fn(),
  }));

  vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
  vi.mock("@/lib/db", () => ({
    db: {
      read: {
        scholar: { findFirst: mockScholarFindFirst },
        fieldOverride: { findFirst: mockFieldOverrideFindFirst },
        slugHistory: { findFirst: mockSlugHistoryFindFirst },
      },
      write: { $transaction: mockTransaction },
    },
  }));
  vi.mock("@/lib/edit/revalidation", () => ({
    reflectOverviewEdit: mockReflectOverviewEdit,
    resolveAffectedProfiles: mockResolveProfiles,
  }));

  const ADMIN = { cwid: "adm001", isSuperuser: true };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        fieldOverride: {
          findUnique: mockFieldOverrideFindUnique,
          upsert: mockFieldOverrideUpsert,
        },
        $executeRaw: mockExecuteRaw,
      }),
    );
    mockFieldOverrideFindUnique.mockResolvedValue(null);
    mockFieldOverrideUpsert.mockResolvedValue({});
    mockExecuteRaw.mockResolvedValue(1);
    // No live Scholar row, no other override, no slug history pointing here.
    mockScholarFindFirst.mockResolvedValue(null);
    mockFieldOverrideFindFirst.mockResolvedValue(null);
    mockSlugHistoryFindFirst.mockResolvedValue(null);
    mockResolveProfiles.mockResolvedValue([]); // no affected profile yet
  });

  it("a slug override write succeeds for a CWID with no Scholar row (incoming hire)", async () => {
    const { POST } = await import("@/app/api/edit/field/route");
    const res = await POST(
      new NextRequest("http://localhost/api/edit/field", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: "incoming-hire-cwid",
          fieldName: "slug",
          value: "future-faculty",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      fieldName: "slug",
      value: "future-faculty",
    });
    expect(mockFieldOverrideUpsert).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit row
  });
});

// ---------------------------------------------------------------------------
// UI-SPEC #17 — slug success copy includes the directory-sync caveat
//
// Extra integration assertion: the user-visible message after a successful
// slug save must include the SPEC's ETL-precedence language so a superuser
// understands the live URL does not change immediately.
// ---------------------------------------------------------------------------

describe("UI-SPEC #17 — slug save success copy", () => {
  vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  }));

  it("success copy after Save names the next directory sync", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, fieldName: "slug", value: "new-handle" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { SlugCard } = await import("@/components/edit/slug-card");
    render(<SlugCard cwid="sch5" liveSlug="alex" initialOverride={null} />);
    fireEvent.change(screen.getByTestId("slug-card-input"), {
      target: { value: "new-handle" },
    });
    fireEvent.click(screen.getByTestId("slug-card-save"));
    await waitFor(() =>
      expect(screen.getByTestId("slug-card-set-success")).toBeTruthy(),
    );
    const alert = screen.getByTestId("slug-card-set-success");
    expect(alert.textContent).toMatch(/takes effect after the next directory sync/i);
    expect(alert.textContent).toContain("/scholars/new-handle");
  });
});
