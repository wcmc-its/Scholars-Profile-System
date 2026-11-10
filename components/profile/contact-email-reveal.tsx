"use client";

import { Mail } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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
 * Crawler hardening (2026-11-09 institution-email-reveal spec): only a SESSION
 * viewer gets the address on mount. An anonymous on-campus ("network") viewer
 * gets `{ revealable }` and sees a "Show email" button; the address is fetched
 * with `?reveal=1` only on click, so a JS-rendering indexer on the WCM network
 * (which renders but never clicks) never sees it.
 *
 * `mode`:
 *   - "li"   → renders just the `<li>` (inserted into an existing Contact card,
 *              e.g. alongside a clinical-profile link).
 *   - "card" → renders its own Contact `SidebarCard` (only once an email
 *              resolves), used when there is no server-baked contact content so an
 *              external viewer never sees an empty card.
 */
type RevealResponse = { email?: string | null; revealable?: boolean };

function fetchContactEmail(cwid: string, reveal: boolean): Promise<RevealResponse> {
  const qs = reveal ? "?reveal=1" : "";
  return fetch(`/api/profile/${encodeURIComponent(cwid)}/contact-email${qs}`, {
    cache: "no-store",
    credentials: "same-origin",
  }).then((r) => (r.ok ? r.json() : {}));
}

export function ContactEmailReveal({
  cwid,
  mode = "li",
}: {
  cwid: string;
  mode?: "li" | "card";
}) {
  const [email, setEmail] = useState<string | null>(null);
  const [revealable, setRevealable] = useState(false);

  useEffect(() => {
    let active = true;
    fetchContactEmail(cwid, false)
      .then((d) => {
        if (!active) return;
        if (typeof d?.email === "string" && d.email) setEmail(d.email);
        else if (d?.revealable === true) setRevealable(true);
      })
      .catch(() => {
        /* leave hidden — fail-closed */
      });
    return () => {
      active = false;
    };
  }, [cwid]);

  const onReveal = () => {
    fetchContactEmail(cwid, true)
      .then((d) => {
        if (typeof d?.email === "string" && d.email) setEmail(d.email);
        else setRevealable(false);
      })
      .catch(() => setRevealable(false));
  };

  let content: ReactNode;
  if (email) {
    content = (
      <a
        href={`mailto:${email}`}
        className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
      >
        {email}
      </a>
    );
  } else if (revealable) {
    content = (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="sm" onClick={onReveal}>
              <Mail aria-hidden="true" />
              Show email
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Shown only to on-campus and signed-in visitors</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  } else {
    return null;
  }

  if (mode === "card") {
    return (
      <SidebarCard title="Contact">
        <ul className="flex flex-col gap-2">
          <li>{content}</li>
        </ul>
      </SidebarCard>
    );
  }

  return <li>{content}</li>;
}
