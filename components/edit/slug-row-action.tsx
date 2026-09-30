/**
 * The Profile URLs registry's row actions (`/edit/slugs`; design canvas
 * "Profile URLs", 2026-09-25) — the one client island in the otherwise
 * server-rendered table.
 *
 *   - **Pin** (Live, auto rows): one click. Pins the scholar's current URL via
 *     the existing field write (`POST /api/edit/field`, `fieldName: "slug"`,
 *     `value` = the current slug) — the same write the scholar's `/edit` slug
 *     card makes — so the URL no longer follows name changes.
 *   - **Unpin** (Pinned rows): one click. The existing `POST
 *     /api/edit/clear-field`; the scholar returns to the name-derived URL, and
 *     when that differs the pinned URL becomes a redirect.
 *   - **Remove** (Redirects rows): asks first ("Old links to /<slug> will stop
 *     working."), then `POST /api/edit/slug-redirect`.
 *
 * All three are superuser-only on the server; the page itself is superuser-
 * gated. On success the page re-renders (`router.refresh()`), so the row moves
 * tab or disappears in place; on failure the error shows under the button.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";

export type SlugRowActionProps =
  | { kind: "pin"; cwid: string; slug: string }
  | { kind: "unpin"; cwid: string; slug: string }
  | { kind: "remove"; slug: string };

const LABEL = { pin: "Pin", unpin: "Unpin", remove: "Remove" } as const;
const WORKING = { pin: "Pinning…", unpin: "Unpinning…", remove: "Removing…" } as const;

/** The request each action makes. */
function requestFor(p: SlugRowActionProps): { url: string; body: Record<string, unknown> } {
  switch (p.kind) {
    case "pin":
      return {
        url: "/api/edit/field",
        body: { entityType: "scholar", entityId: p.cwid, fieldName: "slug", value: p.slug },
      };
    case "unpin":
      return {
        url: "/api/edit/clear-field",
        body: { entityType: "scholar", entityId: p.cwid, fieldName: "slug" },
      };
    case "remove":
      return { url: "/api/edit/slug-redirect", body: { oldSlug: p.slug } };
  }
}

/** Plain-language copy for an error code from the edit routes. */
export function slugActionErrorMessage(
  kind: SlugRowActionProps["kind"],
  slug: string,
  status: number,
  error: string | undefined,
): string {
  if (status === 401) return "Your session has expired. Sign in again.";
  if (error === "not_superuser") return "Only superusers can change profile URLs.";
  if (error === "impersonation_readonly") return "Not available while viewing as someone else.";
  if (kind === "remove" && (status === 404 || error === "not_found")) {
    return `/${slug} no longer redirects. Refresh to see the current list.`;
  }
  if (kind === "pin" && error === "collision") {
    return `/${slug} is held by another scholar, so it can’t be pinned here.`;
  }
  if (kind === "pin" && error === "profanity") {
    return `/${slug} fails the word screen, so it can’t be pinned.`;
  }
  const verb = kind === "pin" ? "pin" : kind === "unpin" ? "unpin" : "remove";
  return `Couldn’t ${verb} /${slug}. Try again.`;
}

export function SlugRowAction(props: SlugRowActionProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const { kind, slug } = props;
  const testKey = kind === "remove" ? slug : props.cwid;

  async function run(): Promise<void> {
    setPending(true);
    setError(null);
    const { url, body } = requestFor(props);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data: { ok?: boolean; error?: string } = {};
      try {
        data = (await res.json()) as { ok?: boolean; error?: string };
      } catch {
        // A bodiless 401 from the middleware — the status alone decides.
      }
      if (!res.ok || data.ok !== true) {
        setError(slugActionErrorMessage(kind, slug, res.status, data.error));
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError(slugActionErrorMessage(kind, slug, 0, undefined));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start md:items-end">
      <button
        type="button"
        onClick={() => (kind === "remove" ? setConfirmOpen(true) : void run())}
        disabled={pending || done}
        title={
          kind === "unpin"
            ? "Let this URL follow the scholar’s name again. If it changes, this URL will redirect."
            : kind === "pin"
              ? "Keep this URL even if the scholar’s name changes."
              : undefined
        }
        className="text-apollo-slate px-1.5 py-1 text-[13.5px] whitespace-nowrap hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-60"
        data-testid={`slug-${kind}-${testKey}`}
      >
        {pending ? WORKING[kind] : LABEL[kind]}
      </button>
      {error && (
        <span
          role="alert"
          className="text-destructive max-w-[16rem] px-1.5 text-xs md:text-right"
          data-testid={`slug-action-error-${testKey}`}
        >
          {error}
        </span>
      )}
      {kind === "remove" && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Remove the redirect from /${slug}?`}
          description={`Old links to /${slug} will stop working.`}
          reasonMode="none"
          confirmLabel="Remove redirect"
          confirmVariant="destructive"
          onConfirm={async () => {
            await run();
            setConfirmOpen(false);
          }}
        />
      )}
    </div>
  );
}
