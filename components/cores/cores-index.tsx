/**
 * Public core-facilities index (`/cores`). Server Component — a simple list of
 * the WCM core facilities that have confirmed publications, each linking to its
 * per-core page (`/cores/[coreId]`). The route's flag gate + the empty-core
 * filtering live in the page file; this assumes a public, ready-to-render list.
 */
import Link from "next/link";

import { corePath } from "@/lib/core-url";
import type { CoreListItem } from "@/lib/api/cores";

export function CoresIndex({ cores }: { cores: CoreListItem[] }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-8">
        <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          Weill Cornell Medicine
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Core facilities</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Shared research facilities and the publications that used them.
        </p>
      </header>

      {cores.length === 0 ? (
        <p className="text-muted-foreground text-sm">No core facilities to show yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {cores.map((c) => (
            <li key={c.id} className="py-4">
              <Link href={corePath(c.id)} className="group block">
                <span className="font-medium tracking-tight group-hover:underline">{c.name}</span>
                {c.facility && c.facility !== c.name ? (
                  <span className="text-muted-foreground mt-0.5 block text-sm">{c.facility}</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
