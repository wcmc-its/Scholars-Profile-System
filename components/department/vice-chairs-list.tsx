/**
 * The department page's Vice Chairs: a compact list under the hero's title
 * row, two columns on wide screens once it reaches six names, three at nine.
 * The hospital-site groups sit side by side rather than stacked.
 * Executive first, then Senior / Vice / Associate / Assistant; a site-based
 * Vice Chair is listed under the name of their hospital site. The title is the
 * department's own wording, shown verbatim — tier and site only order it.
 */
import Link from "next/link";

import type { PublicViceChair } from "@/lib/api/unit-leadership-roles";
import { profilePath } from "@/lib/profile-url";
import { LEADERSHIP_SITES, LEADERSHIP_SITE_LABELS } from "@/lib/unit-leadership";

const EYEBROW = "text-[11px] uppercase tracking-[0.12em] text-muted-foreground";

/** A list this long or longer flows into two columns on wide screens. */
const TWO_COLUMN_MIN = 6;
/** ...and this long or longer into three. */
const THREE_COLUMN_MIN = 9;

function Rows({ rows }: { rows: PublicViceChair[] }) {
  // CSS columns fill down the first column, then the second, so the modifier
  // order (Executive first) still reads top to bottom. One column on a phone.
  const n = rows.length >= THREE_COLUMN_MIN ? 3 : rows.length >= TWO_COLUMN_MIN ? 2 : 1;
  const columns = n === 3 ? "lg:columns-3 lg:gap-x-8" : n === 2 ? "lg:columns-2 lg:gap-x-10" : "";
  return (
    <ul className={`mt-1.5 ${columns}`} data-columns={String(n)}>
      {rows.map((v) => (
        <li key={`${v.cwid}-${v.displayTitle}`} className="mb-1 break-inside-avoid text-[14px] leading-[21px]">
          <Link href={profilePath(v.slug)} className="font-medium hover:underline">
            {v.preferredName}
          </Link>
          <span className="text-muted-foreground">, {v.displayTitle}</span>
        </li>
      ))}
    </ul>
  );
}

export function ViceChairsList({ viceChairs }: { viceChairs: PublicViceChair[] }) {
  if (viceChairs.length === 0) return null;
  const general = viceChairs.filter((v) => v.site === null);
  const bySite = LEADERSHIP_SITES.map((site) => ({
    site,
    rows: viceChairs.filter((v) => v.site === site),
  })).filter((g) => g.rows.length > 0);

  return (
    <section aria-labelledby="vice-chairs-heading" className="mt-5" data-testid="vice-chairs">
      <h2 id="vice-chairs-heading" className={EYEBROW}>
        Vice Chairs
      </h2>
      {general.length > 0 && <Rows rows={general} />}
      {bySite.length > 0 ? (
        <div className="flex flex-wrap gap-x-10">
          {bySite.map((g) => (
            <div key={g.site} className="mt-3">
              <h3 className={EYEBROW}>{LEADERSHIP_SITE_LABELS[g.site]}</h3>
              <Rows rows={g.rows} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
