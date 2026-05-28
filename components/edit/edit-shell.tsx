/**
 * The Apollo master-detail shell (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Layout). The editor chrome only: a black top
 * bar, a sub-nav, and a two-region body (the ATTRIBUTES rail + the detail
 * panel). We MIRROR the Apollo Management Console design language (a real WCM
 * tool we can't integrate); the public Scholars site keeps its Cornell-red
 * header — these are deliberately distinct surfaces.
 *
 * The maroon is a placeholder pending the real Apollo token (D5, `globals.css`
 * `--apollo-maroon`). Layout-independent of the data contract.
 */
import Link from "next/link";

import { AttributeRail, type RailItem } from "@/components/edit/attribute-rail";

export type EditShellProps = {
  mode: "self" | "superuser";
  /** The entity display name (scholar preferred name, or a unit name). Kept as
   *  `scholarName` for call-site stability — it is the top-bar + banner label. */
  scholarName: string;
  /** Attribute rail items + the active key + the base path for the links. */
  railItems: ReadonlyArray<RailItem>;
  activeAttr: string;
  basePath: string;
  /** "Preview Profile" target (the public profile by slug). */
  previewHref?: string;
  /** Optional block rendered inside the rail column, below the attribute rail
   *  (e.g. a department's sibling-divisions list). Omitted ⇒ no visible change
   *  for the existing /edit/scholar callers. */
  subRail?: React.ReactNode;
  children: React.ReactNode;
};

export function EditShell({
  mode,
  scholarName,
  railItems,
  activeAttr,
  basePath,
  previewHref,
  subRail,
  children,
}: EditShellProps) {
  const isSuperuser = mode === "superuser";
  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="edit-shell" data-mode={mode}>
      {/* Top bar (black) — Apollo chrome. */}
      <header className="bg-apollo-bar text-white">
        <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <span
              className="bg-apollo-maroon flex size-7 items-center justify-center rounded-sm text-xs font-bold"
              aria-hidden
            >
              WCM
            </span>
            <h1 className="text-base font-semibold">Scholars Profile Console</h1>
          </div>
          <span className="text-sm text-white/70" aria-hidden>
            {scholarName}
          </span>
        </div>
      </header>

      {/* Sub-nav — maroon underline on the active tab. */}
      <div className="border-border border-b">
        <div className="mx-auto max-w-[var(--max-content)] px-6">
          <span className="border-apollo-maroon inline-block border-b-2 py-3 text-sm font-medium">
            {isSuperuser ? "Profiles" : "My Profile"}
          </span>
        </div>
      </div>

      {/* Body — rail + detail. */}
      <div className="mx-auto grid max-w-[var(--max-content)] grid-cols-1 gap-6 px-6 py-8 md:grid-cols-[16rem_1fr]">
        <div className="flex flex-col gap-3">
          <AttributeRail items={railItems} active={activeAttr} basePath={basePath} />
          {subRail}
        </div>

        <main className="min-w-0">
          {previewHref && (
            <div className="mb-4 flex justify-end">
              <Link
                href={previewHref}
                className="text-[var(--apollo-maroon)] text-sm underline"
                target="_blank"
                rel="noreferrer"
              >
                Preview Profile
              </Link>
            </div>
          )}

          {isSuperuser && (
            <div
              data-slot="superuser-banner"
              className="border-apollo-maroon/40 bg-apollo-maroon/5 mb-4 rounded-md border px-4 py-3 text-sm"
            >
              You are editing {scholarName}&apos;s profile as an administrator. A reason is required for
              every change.
            </div>
          )}

          {children}
        </main>
      </div>
    </div>
  );
}
