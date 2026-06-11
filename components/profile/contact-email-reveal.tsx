"use client";

import { useEffect, useState } from "react";

import { SidebarCard } from "./sidebar-card";

/**
 * email-visibility-spec § Cache-safety — client island that reveals a scholar's
 * `institution` email to internal viewers WITHOUT baking it into the CloudFront
 * path-cached profile page.
 *
 * The server payload only bakes `public` emails (viewer-independent, cache-safe).
 * When `contactEmailRevealable` is true (gate on, email withheld because it is not
 * `public`), the Contact card mounts this island, which fetches the uncacheable
 * /api/profile/[cwid]/contact-email endpoint. That endpoint returns the email
 * ONLY to an internal viewer (authenticated session OR on-WCM-network, #866); an
 * external viewer gets `null` and this renders nothing — so external and `none`
 * cases are indistinguishable and the address never leaks via the shared cache.
 *
 * `mode`:
 *   - "li"   → renders just the `<li>` (inserted into an existing Contact card,
 *              e.g. alongside a clinical-profile link).
 *   - "card" → renders its own Contact `SidebarCard` (only once an email
 *              resolves), used when there is no server-baked contact content so an
 *              external viewer never sees an empty card.
 */
export function ContactEmailReveal({
  cwid,
  mode = "li",
}: {
  cwid: string;
  mode?: "li" | "card";
}) {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/profile/${encodeURIComponent(cwid)}/contact-email`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : { email: null }))
      .then((d: { email?: string | null }) => {
        if (active && typeof d?.email === "string" && d.email) setEmail(d.email);
      })
      .catch(() => {
        /* leave hidden — fail-closed */
      });
    return () => {
      active = false;
    };
  }, [cwid]);

  if (!email) return null;

  const link = (
    <a
      href={`mailto:${email}`}
      className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
    >
      {email}
    </a>
  );

  if (mode === "card") {
    return (
      <SidebarCard title="Contact">
        <ul className="flex flex-col gap-2">
          <li>{link}</li>
        </ul>
      </SidebarCard>
    );
  }

  return <li>{link}</li>;
}
