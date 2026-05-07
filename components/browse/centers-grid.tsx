/**
 * Centers & institutes section — peer of Departments on the Browse hub.
 *
 * Renders a 2-col card grid of cross-disciplinary research centers. Each
 * card carries name, description, and director (when present). Membership
 * counts are intentionally omitted on the card per the design spec —
 * centers are flat-listed without grouping.
 */
import type { BrowseCenter } from "@/lib/api/browse";

export function CentersGrid({ centers }: { centers: BrowseCenter[] }) {
  return (
    <section id="centers" className="mt-16">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">Centers &amp; institutes</h2>
        <span className="text-xs text-muted-foreground">
          {centers.length} cross-disciplinary research centers
        </span>
      </div>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Research organizations that span departments. Faculty appointments
        roll up to a department; center affiliations are layered on top.
      </p>

      {centers.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Center information is being loaded. Check back soon.
        </p>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {centers.map((c) => (
            <li key={c.code}>
              <a
                href={`/centers/${c.slug}`}
                className="block rounded-md border border-border bg-white p-5 transition-all hover:border-[var(--color-accent-slate)] hover:shadow-sm hover:no-underline"
              >
                <div className="text-base font-semibold leading-snug">
                  {c.name}
                </div>
                {c.description && (
                  <p className="mt-2 text-sm leading-snug text-muted-foreground">
                    {c.description}
                  </p>
                )}
                {c.directorName && (
                  <div className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/70">
                      Director:
                    </span>{" "}
                    {c.directorName}
                  </div>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
