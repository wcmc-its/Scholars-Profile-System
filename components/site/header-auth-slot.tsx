"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { AccountMenu } from "./account-menu";

/**
 * The header's auth area — a thin client island so the Sign-in link can
 * carry `?return={currentPath}` via `usePathname()` / `useSearchParams()`.
 * The wider header is a Server Component (`header.tsx`) that fetches the
 * session + scholar row and passes them down here as props.
 *
 * Why a client island instead of a middleware `x-pathname` header: the
 * existing `middleware.ts` matcher is scoped to `["/edit", "/edit/:path*",
 * "/api/edit", "/api/edit/:path*"]`, so it does not run on the public
 * pages where this header also renders; broadening that matcher just to
 * expose the pathname would attach the auth-gate middleware to every
 * request for the sake of one header value (#356 Phase 5 D5.1 + § 3.3).
 *
 * The post-SSO return target is allow-listed by `lib/auth/return-path.ts`
 * (the public-page broaden lives in C4).
 */
export type HeaderAuthSlotProps = {
  /** True when the visitor has a valid session cookie. */
  isAuthenticated: boolean;
  /**
   * The signed-in scholar's slug + preferredName, or `null` if no `Scholar`
   * row exists for the session's cwid (a staff-only superuser — D5.3).
   * Only consulted when `isAuthenticated` is true.
   */
  scholar: { slug: string; preferredName: string } | null;
};

export function HeaderAuthSlot({ isAuthenticated, scholar }: HeaderAuthSlotProps) {
  if (isAuthenticated) {
    return <AccountMenu scholar={scholar} />;
  }
  return <SignInLink />;
}

function SignInLink() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  // Returning the user to their current path + query lets the public-profile
  // re-render pick up `session.cwid == profile.cwid` on the navigation back
  // (UI-SPEC line 125). `safeReturnPath` (lib/auth/return-path.ts) re-confines
  // the value server-side, so this client value is advisory only.
  const returnTo = search ? `${pathname}?${search}` : pathname;

  return (
    <Link
      href={`/api/auth/saml/login?return=${encodeURIComponent(returnTo)}`}
      className="text-sm font-medium text-white/85 transition-colors hover:text-white focus:text-white focus:outline-none"
      data-testid="header-sign-in"
    >
      Sign in
    </Link>
  );
}
