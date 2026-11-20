"use client";

/**
 * "Edit this department / division / center" on the public unit pages, for
 * the people who can edit that unit: its Owner or Curator (`unit_admin`,
 * including the department→division cascade), a superuser, comms steward or
 * content editor. Links to the unit's `/edit/<kind>/<code>` console page.
 *
 * Client island for the same reason as `EditMyProfileButton`: the unit pages
 * are ISR-cached behind CloudFront, which strips the session cookie, so only a
 * client-side probe can tell who is looking. It first probes
 * `/api/auth/session` (cheap and anonymous-safe), and only for a signed-in
 * viewer asks `/api/edit/can-edit-unit`, which runs the same authz as the
 * `/edit/<kind>/<code>` page. Hidden while in flight and on any error.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export type EditableUnitKind = "department" | "division" | "center";

export function EditUnitLink({
  kind,
  code,
  className = "mt-4 flex",
}: {
  kind: EditableUnitKind;
  code: string;
  /** The wrapper's layout; the default puts it on its own line. */
  className?: string;
}) {
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    let active = true;
    const opts: RequestInit = { cache: "no-store", credentials: "same-origin" };
    fetch("/api/auth/session", opts)
      .then((r) => (r.ok ? r.json() : null))
      .then((session: { authenticated?: boolean } | null) => {
        if (!active || !session?.authenticated) return null;
        const qs = new URLSearchParams({ kind, code });
        return fetch(`/api/edit/can-edit-unit?${qs.toString()}`, opts).then((r) =>
          r.ok ? r.json() : null,
        );
      })
      .then((data: { canEdit?: boolean } | null) => {
        if (active && data?.canEdit === true) setCanEdit(true);
      })
      .catch(() => {
        /* Never block the page on the probe — leave the link hidden. */
      });
    return () => {
      active = false;
    };
  }, [kind, code]);

  if (!canEdit) return null;

  return (
    <div className={className}>
      <Button asChild variant="outline" size="sm">
        <Link href={`/edit/${kind}/${encodeURIComponent(code)}`} data-testid="edit-unit-link">
          Edit this {kind}
        </Link>
      </Button>
    </div>
  );
}
