/**
 * `scripts/release/flag-parity.mjs --drift` — the running-vs-synthesized
 * task-def env drift classifier (#1765). Runs the script's own assert-based
 * `--selfcheck`, which covers the sidecar-reorder gotcha (select the container
 * by name === "app", not [0]) plus missing / value-drift / removed-key cases.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

describe("flag-parity drift classifier (#1765)", () => {
  it("passes the --selfcheck (throws non-zero if the drift logic regresses)", () => {
    const out = execFileSync("node", ["scripts/release/flag-parity.mjs", "--selfcheck"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/selfcheck OK/);
  });
});
