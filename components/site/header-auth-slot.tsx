"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AccountMenu } from "./account-menu";

/**
 * The header's auth area — a thin client island so the Sign-in link can
 * carry `?return={currentPath}` via `usePathname()`. The wider header is a
 * Server Component (`header.tsx`) that fetches the session + scholar row
 * and passes them down here as props.
 *
 * **Why this also probes `/api/auth/session` client-side.** The header renders
 * on every public surface, but those are served by CloudFront's *cacheable*
 * default behavior, which strips the Cookie header before it reaches the
 * origin (cdk/lib/edge-stack.ts — the cache spec's "single most important
 * knob"). So the server-rendered `isAuthenticated` is always `false` on a
 * cached public page, even for a signed-in user. We treat the server prop as
 * the initial value (it is authoritative on the cookie-forwarding `/edit/*`
 * surface) and confirm it against `/api/auth/session`, which lives on the
 * cookie-forwarding `/api/auth/*` behavior and so can read the session. The
 * probe is skipped when the server already says authenticated.
 *
 * Why a client island instead of a middleware `x-pathname` header: the
 * existing `middleware.ts` matcher is scoped to `["/edit", "/edit/:path*",
 * "/api/edit", "/api/edit/:path*"]`, so it does not run on the public
 * pages where this header also renders; broadening that matcher just to
 * expose the pathname would attach the auth-gate middleware to every
 * request for the sake of one header value (#356 Phase 5 D5.1 + § 3.3).
 *
 * **Why pathname only, not pathname + query.** `useSearchParams()` opts
 * the consuming page into CSR bailout — Next.js requires it inside a
 * `<Suspense>` boundary, otherwise `next build` fails to prerender
 * `app/page.tsx` (the homepage statically prerenders). Dropping the query
 * keeps prerendering working without ceremony; the trade-off is that
 * signing in from `/search?q=cancer` returns the user to `/search` rather
 * than `/search?q=cancer`. UI-SPEC's stated unit is "the page they were
 * on" — the path satisfies that contract; the query loss is a mild
 * after-effect of the simplest correct fix.
 *
 * The post-SSO return target is allow-listed by `lib/auth/return-path.ts`
 * (the public-page broaden lives in C4).
 */
type ScholarLite = { slug: string; preferredName: string };

export type HeaderAuthSlotProps = {
  /** True when the visitor has a valid session cookie. */
  isAuthenticated: boolean;
  /**
   * The signed-in scholar's slug + preferredName, or `null` if no `Scholar`
   * row exists for the session's cwid (a staff-only superuser — D5.3).
   * Only consulted when `isAuthenticated` is true.
   */
  scholar: ScholarLite | null;
};

export function HeaderAuthSlot({ isAuthenticated, scholar }: HeaderAuthSlotProps) {
  const [auth, setAuth] = useState<{ isAuthenticated: boolean; scholar: ScholarLite | null }>(
    { isAuthenticated, scholar },
  );
  // GrantRecs Phase 4 — the "Researchers for funding" top-nav link. Gated client-
  // side off the same probe (a superuser OR a development-role member); the header
  // can't read roles server-side without breaking the public cache (see above).
  const [canFunding, setCanFunding] = useState(false);

  useEffect(() => {
    // The server prop is correct on cookie-forwarding surfaces; only probe
    // when it says signed-out, which is also what a cached public page reports
    // for a genuinely signed-in user.
    if (isAuthenticated) return;
    let active = true;
    fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            authenticated?: boolean;
            scholar?: ScholarLite | null;
            canAccessFundingMatcher?: boolean;
          } | null,
        ) => {
          if (!active || !data?.authenticated) return;
          setAuth({ isAuthenticated: true, scholar: data.scholar ?? null });
          setCanFunding(Boolean(data.canAccessFundingMatcher));
        },
      )
      .catch(() => {
        /* leave the server-prop default — header stays as "Sign in" */
      });
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  return (
    <>
      {canFunding ? (
        <Link
          href="/edit/find-researchers"
          prefetch={false}
          className="text-sm font-medium text-white/85 transition-colors hover:text-white focus:text-white focus:outline-none"
        >
          Researchers for funding
        </Link>
      ) : null}
      {auth.isAuthenticated ? <AccountMenu scholar={auth.scholar} /> : <SignInLink />}
    </>
  );
}

function SignInLink() {
  const pathname = usePathname();
  // `safeReturnPath` (lib/auth/return-path.ts) re-confines the value
  // server-side, so this client value is advisory only.
  return (
    <Link
      href={`/api/auth/saml/login?return=${encodeURIComponent(pathname)}`}
      // Never prefetch: this is an API route that 302-redirects cross-origin to
      // the SAML IdP. Next's viewport RSC prefetch fires on every public page
      // (the link is always in the header), and each one fails the CORS
      // preflight on the cross-origin redirect — "Failed to fetch RSC payload …
      // Falling back to browser navigation" — flooding the console and burning
      // a connection slot. The real click navigates fine without a prefetch.
      prefetch={false}
      className="text-sm font-medium text-white/85 transition-colors hover:text-white focus:text-white focus:outline-none"
      data-testid="header-sign-in"
    >
      Sign in
    </Link>
  );
}
