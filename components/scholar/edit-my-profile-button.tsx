"use client";

/**
 * Issue #640 — owner-only "Edit my profile" affordance, rendered client-side.
 *
 * The profile page (`/scholars/[slug]`) is ISR-cached and served via
 * CloudFront's cacheable default behavior, which strips the Cookie header
 * before it reaches the origin (see `components/site/header-auth-slot.tsx`
 * and `app/api/auth/session/route.ts`). A server-rendered owner check
 * (`getSession()` → `cookies()`) is therefore both:
 *   (a) wrong on a cached page — the cookie never reaches the origin, so the
 *       signed-in owner would never (or inconsistently) see the button; and
 *   (b) a `DYNAMIC_SERVER_USAGE` throw inside the statically-generated route,
 *       which 500'd every profile in production builds (#640).
 *
 * So we probe `/api/auth/session` client-side (one of the few cookie-
 * forwarding CloudFront behaviors) and render the button only when the
 * signed-in scholar's slug matches this profile. Mirrors `HeaderAuthSlot`.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function EditMyProfileButton({ profileSlug }: { profileSlug: string }) {
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: { authenticated?: boolean; scholar?: { slug?: string } | null } | null,
        ) => {
          if (!active) return;
          if (data?.authenticated && data.scholar?.slug === profileSlug) {
            setIsOwner(true);
          }
        },
      )
      .catch(() => {
        /* Never block the page on the probe — leave the button hidden. */
      });
    return () => {
      active = false;
    };
  }, [profileSlug]);

  if (!isOwner) return null;

  return (
    <div className="mt-4 flex justify-center">
      <Button asChild variant="outline" size="sm">
        <Link href="/edit" data-testid="edit-my-profile">
          Edit my profile
        </Link>
      </Button>
    </div>
  );
}
