/**
 * Public per-core page body (`/cores/[coreId]`). Server Component — the facility
 * header + the core's confirmed publications, each rendered with the shared
 * `<PublicationCard>` (no author chips). Renders an empty state when the catalog
 * core has no confirmed publications yet. The route's flag gate + `notFound()`
 * live in the page file; this assumes the data is present and public.
 */
import { PublicationCard } from "@/components/department/publication-card";
import type { CorePageData } from "@/lib/api/cores";

export function CorePage({ data }: { data: CorePageData }) {
  const { core, publications } = data;
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-8">
        <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          Core facility
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{core.name}</h1>
        {core.facility ? (
          <p className="text-muted-foreground mt-1 text-sm">{core.facility}</p>
        ) : null}
      </header>

      <section>
        <h2 className="mb-3 text-lg font-semibold tracking-tight">
          Publications{publications.length > 0 ? ` (${publications.length.toLocaleString()})` : ""}
        </h2>
        {publications.length === 0 ? (
          <p className="text-muted-foreground text-sm">No confirmed publications yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-border)]">
            {publications.map((p) => (
              <li key={p.pmid} className="py-4">
                <PublicationCard pub={{ ...p, authors: [] }} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
