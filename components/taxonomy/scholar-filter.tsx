"use client";

/**
 * Per-scholar publication filter on topic and method family pages, set from the
 * scholar card hover ("Filter publications →"). The cards and the feed are
 * separate client islands, so the pick lives in a tiny module store.
 *
 * ponytail: in-memory only, no `?scholar=` URL sync; add it when a filtered view
 * needs to be shareable. The feed clears the pick on unmount, so a client-side
 * navigation to another page never carries it over.
 *
 * No db imports: this module is client-bundled.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { X } from "lucide-react";
import { profilePath } from "@/lib/profile-url";

export type PickedScholar = { cwid: string; name: string; slug: string | null };

let picked: PickedScholar | null = null;
const listeners = new Set<() => void>();

export function setScholarFilter(next: PickedScholar | null) {
  if (picked?.cwid === next?.cwid) return;
  picked = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useScholarFilter(): PickedScholar | null {
  return useSyncExternalStore(
    subscribe,
    () => picked,
    () => null,
  );
}

/** Wraps a scholar card: `data-pick` drives the picked highlight and the dim on
 *  the other cards (`group/pick` variants on the card itself). */
export function ScholarCardPickState({ cwid, children }: { cwid: string; children: ReactNode }) {
  const p = useScholarFilter();
  const state = !p ? undefined : p.cwid === cwid ? "picked" : "dimmed";
  return (
    <div
      data-pick={state}
      className="group/pick h-full min-w-0 transition-opacity data-[pick=dimmed]:opacity-60"
    >
      {children}
    </div>
  );
}

/** "Showing publications by X ×" above the filtered feed. */
export function ScholarFilterChip({ scholar }: { scholar: PickedScholar }) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm"
      data-testid="scholar-filter-chip"
    >
      <span className="text-muted-foreground">Showing publications by</span>
      <span className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border py-0.5 pr-0.5 pl-3 font-medium">
        <span className="truncate">{scholar.name}</span>
        <button
          type="button"
          onClick={() => setScholarFilter(null)}
          aria-label="Clear scholar filter"
          className="hover:bg-apollo-slate-tint-border inline-flex size-7 shrink-0 items-center justify-center rounded-full max-sm:size-11"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </span>
      {scholar.slug ? (
        <a
          href={profilePath(scholar.slug)}
          className="text-apollo-slate inline-flex min-h-11 items-center underline-offset-4 hover:underline sm:ml-auto sm:min-h-0"
        >
          View {scholar.name}&apos;s profile →
        </a>
      ) : null}
    </div>
  );
}
