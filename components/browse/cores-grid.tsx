/**
 * Core facilities section — peer of Departments/Centers on the Browse hub.
 * Cores-as-org-units P4 (core-as-org-unit-plan.md).
 *
 * Renders a 2-col card grid of publicly-visible core facilities. Each card
 * carries name, facility, and description (when present). Cores are
 * flat-listed without grouping, same as CentersGrid.
 */
import { corePath } from "@/lib/core-url";
import type { BrowseCore } from "@/lib/api/browse";

export function CoresGrid({ cores }: { cores: BrowseCore[] }) {
  return (
    <section id="cores" className="mt-16">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">Core facilities</h2>
        <span className="text-xs text-muted-foreground">
          {cores.length} shared research {cores.length === 1 ? "facility" : "facilities"}
        </span>
      </div>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Shared instrumentation and expertise available across departments and
        centers.
      </p>

      {cores.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Core facility information is being loaded. Check back soon.
        </p>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {cores.map((c) => (
            <li key={c.id}>
              <a
                href={corePath(c.id)}
                className="block rounded-md border border-border bg-white p-5 transition-all hover:border-[var(--color-accent-slate)] hover:shadow-sm hover:no-underline"
              >
                <div className="text-base font-semibold leading-snug">
                  {c.name}
                </div>
                {c.facility && c.facility !== c.name && (
                  <p className="mt-1 text-sm leading-snug text-muted-foreground">
                    {c.facility}
                  </p>
                )}
                {c.description && (
                  <p className="mt-2 text-sm leading-snug text-muted-foreground">
                    {c.description}
                  </p>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
