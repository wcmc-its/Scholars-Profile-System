/**
 * The shared admin sub-nav for the superuser `/edit` list surfaces (#497 PR-3c,
 * `slug-personalization-ui-spec.md` § 3.1). The maroon-underlined tab strip
 * under the black Apollo bar, linking the Profiles roster (`/edit/scholars`) and
 * the Profile-URL request queue (`/edit/slug-requests`). A pending-count pill
 * sits on the "URL requests" tab.
 *
 * `pendingSlugRequests === null` hides the URL-requests tab entirely — the
 * slug-request feature is flag-gated (`SELF_EDIT_SLUG_REQUEST`), so a surface
 * that doesn't exist isn't advertised.
 */
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";

export type AdminSubnavActive = "profiles" | "slug-requests" | "slugs" | "administrators";

export function AdminSubnav({
  active,
  pendingSlugRequests,
  administratorsTab,
  selfEditHref,
}: {
  active: AdminSubnavActive;
  pendingSlugRequests: number | null;
  /** `null` hides the "Administrators" tab — the feature is flag-gated
   *  (`SELF_EDIT_ADMINISTRATORS_TAB`), mirroring the `pendingSlugRequests`
   *  hide pattern. A number shows the tab (Phase B passes `0` — no badge). */
  administratorsTab?: number | null;
  /** Link back to the viewer's own self-edit surface (`/edit`), right-aligned.
   *  `null`/omitted when the viewer has no profile of their own (a staff
   *  superuser), so the link never lands on a 404. */
  selfEditHref?: string | null;
}) {
  return (
    <div className="border-border border-b" data-slot="admin-subnav">
      <div className="mx-auto flex max-w-[var(--max-content)] items-center gap-6 px-6">
        <AdminTab href="/edit/scholars" id="profiles" label="Profiles" active={active === "profiles"} />
        {pendingSlugRequests !== null && (
          <AdminTab
            href="/edit/slug-requests"
            id="slug-requests"
            label="URL requests"
            active={active === "slug-requests"}
            count={pendingSlugRequests}
          />
        )}
        {/* Always visible to superusers — the slug namespace (active / historical
            / override / reserved) exists regardless of the slug-request flag. */}
        <AdminTab
          href="/edit/slugs"
          id="slugs"
          label="Slug registry"
          active={active === "slugs"}
        />
        {administratorsTab !== null && administratorsTab !== undefined && (
          <AdminTab
            href="/edit/administrators"
            id="administrators"
            label="Administrators"
            active={active === "administrators"}
          />
        )}
        {selfEditHref ? (
          <Link
            href={selfEditHref}
            className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 py-3 text-sm"
            data-testid="admin-subnav-self-edit"
          >
            <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
            My profile
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function AdminTab({
  href,
  id,
  label,
  active,
  count,
}: {
  href: string;
  id: AdminSubnavActive;
  label: string;
  active: boolean;
  count?: number;
}) {
  const inner = (
    <span className="inline-flex items-center gap-2">
      {label}
      {count !== undefined && count > 0 && (
        <span
          className="bg-apollo-maroon inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold text-white"
          data-testid="admin-subnav-pending-count"
        >
          {count}
        </span>
      )}
    </span>
  );
  if (active) {
    return (
      <span
        className="border-apollo-maroon inline-block border-b-2 py-3 text-sm font-medium"
        aria-current="page"
        data-testid={`admin-tab-${id}`}
      >
        {inner}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground inline-block border-b-2 border-transparent py-3 text-sm"
      data-testid={`admin-tab-${id}`}
    >
      {inner}
    </Link>
  );
}
