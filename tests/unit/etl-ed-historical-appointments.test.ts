/**
 * Issue #2112 — `shouldReconcileHistoricalAppointments` gates the
 * ED-HISTORICAL (faculty:expired) appointment reconcile. Mirrors the NYP
 * affiliate guard (issue #162): a SUCCESSFUL fetch that returns zero rows is
 * a suspected truncated/misscoped read, not evidence that no historical
 * appointments exist, so it must be treated the same as a failed fetch —
 * existing rows are retained rather than reconciled against an empty
 * incoming set (which would tombstone every ED-HISTORICAL row, including
 * curator `showOnProfile` reveals).
 *
 * Pure-logic test: the ED ETL's `main()` is guarded by `!process.env.VITEST`,
 * so importing the module here runs no sync.
 */
import { describe, expect, it } from "vitest";

import { shouldReconcileHistoricalAppointments } from "@/etl/ed/index";

describe("shouldReconcileHistoricalAppointments (#2112)", () => {
  it("retains existing rows when the fetch succeeded but returned zero rows", () => {
    expect(shouldReconcileHistoricalAppointments(true, 0)).toBe(false);
  });

  it("retains existing rows when the fetch failed", () => {
    expect(shouldReconcileHistoricalAppointments(false, 0)).toBe(false);
  });

  it("reconciles when the fetch succeeded and returned rows", () => {
    expect(shouldReconcileHistoricalAppointments(true, 3)).toBe(true);
  });

  it("does not reconcile on a failed fetch even if a stale row count leaks through", () => {
    expect(shouldReconcileHistoricalAppointments(false, 3)).toBe(false);
  });
});
