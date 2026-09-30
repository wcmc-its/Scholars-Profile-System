/**
 * Centers & institutes section — peer of Departments on the Browse hub.
 *
 * Renders a 2-col card grid of cross-disciplinary research centers. Each
 * card carries name, description, member count, and director (when
 * present). Centers are flat-listed without grouping. Cards in a row are
 * equal height with the footer pinned to the bottom.
 */
import type { BrowseCenter } from "@/lib/api/browse";
import {
  BROWSE_CARD_CLASS,
  BROWSE_COUNT_CLASS,
  BROWSE_DESC_CLASS,
  BROWSE_H2_CLASS,
  BROWSE_SECTION_CLASS,
} from "@/components/browse/browse-styles";

export function CentersGrid({ centers }: { centers: BrowseCenter[] }) {
  return (
    <section id="centers" data-spy="centers" className={`mt-[72px] ${BROWSE_SECTION_CLASS}`}>
      <div className="flex items-baseline gap-3">
        <h2 className={BROWSE_H2_CLASS}>Centers &amp; institutes</h2>
        <span className={BROWSE_COUNT_CLASS}>
          {centers.length} cross-disciplinary research centers
        </span>
      </div>
      <p className={BROWSE_DESC_CLASS}>
        Research organizations that span departments. Faculty appointments
        roll up to a department; center affiliations are layered on top.
      </p>

      {centers.length === 0 ? (
        <p className="mt-4 text-[14px] text-muted-foreground">
          Center information is being loaded. Check back soon.
        </p>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {centers.map((c) => (
            <li key={c.code}>
              <a href={`/centers/${c.slug}`} className={BROWSE_CARD_CLASS}>
                <span className="text-[16px] leading-[22px]">{c.name}</span>
                {c.description && (
                  <span className="mt-2 text-[13px] leading-[19px] text-pretty text-muted-foreground">
                    {c.description}
                  </span>
                )}
                {(c.scholarCount > 0 || c.directorName) && (
                  <span className="mt-auto block pt-3.5">
                    <span
                      data-testid="center-card-footer"
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-apollo-border pt-3 text-xs leading-4 text-muted-foreground"
                    >
                      {c.scholarCount > 0 && (
                        <span>
                          <strong className="font-semibold text-foreground">
                            {c.scholarCount.toLocaleString("en-US")}
                          </strong>{" "}
                          {c.scholarCount === 1 ? "member" : "members"}
                        </span>
                      )}
                      {c.scholarCount > 0 && c.directorName && (
                        <span aria-hidden="true">·</span>
                      )}
                      {c.directorName && (
                        <span className="flex gap-1.5">
                          <span>Director</span>
                          <span className="text-foreground">{c.directorName}</span>
                        </span>
                      )}
                    </span>
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
