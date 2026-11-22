"use client";

import Link from "next/link";

type Props = {
  href: string;
  event:
    | "home_methods_stat_click"
    | "home_method_category_click"
    | "home_methods_explore_all_click";
  /** Category slug for category-card clicks; omitted for the stat/footer links. */
  slug?: string;
  className?: string;
  "aria-label"?: string;
  children: React.ReactNode;
};

/**
 * Fire-and-forget analytics beacon on click, mirroring spotlight-section.tsx.
 * SSR-guarded; never blocks navigation. Uses next/link for client navigation
 * (hash-only hrefs trigger same-route in-page navigation).
 *
 * No viewport prefetch: /methods pages are force-dynamic (#985), so each
 * prefetch is a full origin render, and the home page shows the "Explore all"
 * link plus one card per category. On 2026-11-21 that was ~446k uncached
 * /methods RSC renders from home-page views alone, the largest single source
 * of slow origin requests. A click still navigates client-side.
 */
export function MethodBeaconLink({ href, event, slug, className, children, ...rest }: Props) {
  function handleClick() {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const payload = { event, ...(slug ? { slug } : {}), ts: Date.now() };
    navigator.sendBeacon(
      "/api/analytics",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  }
  return (
    <Link href={href} prefetch={false} className={className} onClick={handleClick} {...rest}>
      {children}
    </Link>
  );
}
