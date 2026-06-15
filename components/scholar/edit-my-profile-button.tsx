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
 *
 * #955 item 2 — a superuser (one who may impersonate, R1) viewing ANY public
 * profile gets a deep-link straight into that scholar's admin surface
 * (`/edit/scholar/<cwid>`). The same probe already reports `canImpersonate`, so
 * no extra request is needed. The owner link wins when the viewer is looking at
 * their own profile (a superuser on their own page edits via the plain `/edit`
 * self surface); a non-superuser never sees the deep-link, since the probe fails
 * closed to `canImpersonate: false` while in flight, on error, or off-flag.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function EditMyProfileButton({
  profileSlug,
  profileCwid,
}: {
  profileSlug: string;
  profileCwid: string;
}) {
  const [isOwner, setIsOwner] = useState(false);
  const [canImpersonate, setCanImpersonate] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            authenticated?: boolean;
            scholar?: { slug?: string } | null;
            canImpersonate?: boolean;
          } | null,
        ) => {
          if (!active) return;
          if (data?.authenticated && data.scholar?.slug === profileSlug) {
            setIsOwner(true);
          }
          if (data?.canImpersonate) {
            setCanImpersonate(true);
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

  // Owner wins: a superuser on their own profile edits via the self surface.
  if (isOwner) {
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

  // #955 item 2 — superuser deep-link into this scholar's admin surface.
  if (canImpersonate) {
    return (
      <div className="mt-4 flex justify-center">
        <Button asChild variant="outline" size="sm">
          <Link
            href={`/edit/scholar/${encodeURIComponent(profileCwid)}`}
            data-testid="edit-profile-superuser"
          >
            Edit profile
          </Link>
        </Button>
      </div>
    );
  }

  return null;
}
