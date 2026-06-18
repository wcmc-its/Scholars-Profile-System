"use client";

import { TransitionLink as Link } from "@/components/search/transition-link";

/**
 * Issue #396 — "Show only MeSH-tagged matches" facet toggle for the
 * Publications tab. A single checkbox-style row matching the surrounding
 * `FacetCheckbox` markup (same input + label typography/spacing). Server
 * precomputes the toggle target `href` (the ON url when off, the OFF url when
 * on) since Next can't pass a function across the server→client boundary; this
 * client wrapper exists only so it can fire the `search_mesh_restrict`
 * analytics beacon when the user turns the filter ON.
 *
 * The beacon is fire-and-forget (`navigator.sendBeacon`) and never blocks the
 * navigation — it mirrors the existing `search_click` / `search_nav_watchdog`
 * beacons. Emitted ONLY on turn-ON (when `isActive` is false at click time),
 * not on turn-OFF.
 */
export function MeshOnlyToggle({
  href,
  isActive,
  q,
}: {
  href: string;
  isActive: boolean;
  q: string;
}) {
  function handleClick() {
    // Only telemetry the restrict (turn-ON) action, not the broaden (turn-OFF).
    if (isActive) return;
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    navigator.sendBeacon(
      "/api/analytics",
      new Blob([JSON.stringify({ event: "search_mesh_restrict", q, ts: Date.now() })], {
        type: "application/json",
      }),
    );
  }

  return (
    <li className="flex items-center gap-2 py-1 leading-[1.4]">
      <Link
        href={href}
        scroll={false}
        onClick={handleClick}
        className="flex flex-1 items-center gap-2 text-[#1a1a1a] no-underline hover:no-underline"
      >
        <input
          type="checkbox"
          readOnly
          checked={isActive}
          tabIndex={-1}
          aria-hidden="true"
          className="cursor-pointer accent-[#2c4f6e]"
        />
        <span className="min-w-0 flex-1">Show only MeSH-tagged matches</span>
      </Link>
    </li>
  );
}
