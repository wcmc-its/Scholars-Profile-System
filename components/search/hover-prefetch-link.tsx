"use client";

import { useState, type ComponentProps } from "react";
import Link from "next/link";

/**
 * A <Link> that prefetches on hover/touch intent instead of on viewport entry.
 *
 * Profile pages are force-dynamic and never cached at the edge, so Next's default
 * viewport prefetch costs a full origin render for every profile link on screen
 * (~20 per results page) to serve maybe one click. The 2026-10-01 RPT load test
 * showed those prefetches as the slowest requests in a search (3-4 s each).
 * `prefetch={false}` alone also kills hover prefetch, so flip it on at intent:
 * once enabled, the link (already visible) prefetches immediately.
 */
export function HoverPrefetchLink({
  onMouseEnter,
  onTouchStart,
  ...props
}: Omit<ComponentProps<typeof Link>, "prefetch">) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      prefetch={intent ? null : false}
      onMouseEnter={(e) => {
        setIntent(true);
        onMouseEnter?.(e);
      }}
      onTouchStart={(e) => {
        setIntent(true);
        onTouchStart?.(e);
      }}
    />
  );
}
