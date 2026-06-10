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
 * SSR-guarded; never blocks navigation. Uses next/link so client navigation
 * + prefetch behave like every other internal link (hash-only hrefs trigger
 * same-route in-page navigation).
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
    <Link href={href} className={className} onClick={handleClick} {...rest}>
      {children}
    </Link>
  );
}
