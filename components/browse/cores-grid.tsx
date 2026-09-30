/**
 * Core facilities section — peer of Departments/Centers on the Browse hub.
 * Cores-as-org-units P4 (core-as-org-unit-plan.md).
 *
 * Renders a 2-col card grid of publicly-visible core facilities. Each card
 * carries name, facility, and description (when present). Cores are
 * flat-listed without grouping, and share CentersGrid's section header and
 * card styling so the hub reads as one system. /browse omits this section
 * (and its anchor tab) while no core is visible.
 */
import { corePath } from "@/lib/core-url";
import type { BrowseCore } from "@/lib/api/browse";
import {
  BROWSE_CARD_CLASS,
  BROWSE_COUNT_CLASS,
  BROWSE_DESC_CLASS,
  BROWSE_H2_CLASS,
  BROWSE_SECTION_CLASS,
} from "@/components/browse/browse-styles";

export function CoresGrid({ cores }: { cores: BrowseCore[] }) {
  return (
    <section id="cores" data-spy="cores" className={`mt-[72px] ${BROWSE_SECTION_CLASS}`}>
      <div className="flex items-baseline gap-3">
        <h2 className={BROWSE_H2_CLASS}>Core facilities</h2>
        <span className={BROWSE_COUNT_CLASS}>
          {cores.length} shared research {cores.length === 1 ? "facility" : "facilities"}
        </span>
      </div>
      <p className={BROWSE_DESC_CLASS}>
        Shared instrumentation and expertise available across departments and
        centers.
      </p>

      {cores.length === 0 ? (
        <p className="mt-4 text-[14px] text-muted-foreground">
          Core facility information is being loaded. Check back soon.
        </p>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {cores.map((c) => (
            <li key={c.id}>
              <a href={corePath(c.id)} className={BROWSE_CARD_CLASS}>
                <span className="text-[16px] leading-[22px]">{c.name}</span>
                {c.facility && c.facility !== c.name && (
                  <span className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
                    {c.facility}
                  </span>
                )}
                {c.description && (
                  <span className="mt-2 text-[13px] leading-[19px] text-pretty text-muted-foreground">
                    {c.description}
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
