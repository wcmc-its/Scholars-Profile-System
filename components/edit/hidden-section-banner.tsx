/**
 * The "hidden on the public profile" notice above an /edit panel whose public
 * section is currently hidden — the scholar's own Visibility switch
 * (`hideFunding`, `hideMentoring`, …) or, for Datasets, the env default-off
 * with no `showDatasets` opt-in. Without it a faculty member can edit a panel
 * and not know why nothing appears on their profile.
 *
 * "Show it" writes the same `/api/edit/field` row the Visibility card's switch
 * writes, then offers Undo in place. The component stays mounted after the
 * write (the server stops reporting the section hidden on `router.refresh()`,
 * so `hidden` flips false) — the local `justShown` state is what keeps Undo on
 * screen. Editors the field route refuses (proxy, unit admin, read-only
 * observer) get the notice without the button (`canShow`).
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";

/** One `/api/edit/field` write: the field and the string value to store. */
export type SectionFieldWrite = { fieldName: string; value: "true" | "false" };

export function HiddenSectionBanner({
  cwid,
  hidden,
  canShow,
  thirdPerson,
  show,
  undo,
}: {
  cwid: string;
  /** Whether the public section is hidden right now (server-computed). */
  hidden: boolean;
  /** The actor may change the scholar's section visibility. */
  canShow: boolean;
  /** Copy voice: "their" for an editor who isn't the scholar. */
  thirdPerson: boolean;
  /** The write that makes the section public. */
  show: SectionFieldWrite;
  /** The write that puts it back (Undo). */
  undo: SectionFieldWrite;
}) {
  const router = useRouter();
  const [justShown, setJustShown] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const poss = thirdPerson ? "their" : "your";

  async function write(w: SectionFieldWrite, nowShown: boolean) {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "scholar", entityId: cwid, ...w }),
      });
      const data = (await res.json()) as { ok?: boolean };
      if (!res.ok || data.ok !== true) {
        setError("We couldn't update that section. Please try again.");
        return;
      }
      setJustShown(nowShown);
      router.refresh();
    } catch {
      setError("We couldn't update that section. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (justShown && !hidden) {
    return (
      <div
        className="border-apollo-border flex flex-wrap items-center gap-2.5 rounded-md border bg-white px-3 py-2 text-sm"
        data-testid="hidden-section-shown"
        role="status"
      >
        <span className="text-muted-foreground">Now visible on {poss} public profile.</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => write(undo, false)}
        >
          Undo
        </Button>
        {error && <span className="text-destructive text-xs">{error}</span>}
      </div>
    );
  }
  if (!hidden) return null;
  return (
    <div
      className="border-apollo-amber-tint-border bg-apollo-amber-tint flex flex-wrap items-center gap-2.5 rounded-md border px-3 py-2 text-sm"
      data-testid="hidden-section-banner"
    >
      <EyeOff className="text-apollo-amber size-4 shrink-0" aria-hidden />
      <span>
        <span className="text-apollo-amber font-medium">Hidden on {poss} public profile.</span>{" "}
        <span className="text-muted-foreground">Visitors don&rsquo;t see this section.</span>
      </span>
      {canShow && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={pending}
          onClick={() => write(show, true)}
          data-testid="hidden-section-show"
        >
          Show it
        </Button>
      )}
      {error && <span className="text-destructive w-full text-xs">{error}</span>}
    </div>
  );
}
