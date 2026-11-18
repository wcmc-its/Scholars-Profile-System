/**
 * The department page's Vice Chairs: a compact list under the chair card.
 * Executive first, then Senior / Vice / Associate / Assistant; a site-based
 * Vice Chair is listed under the name of their hospital site. The title is the
 * department's own wording, shown verbatim — tier and site only order it.
 */
import Link from "next/link";

import type { PublicViceChair } from "@/lib/api/unit-leadership-roles";
import { profilePath } from "@/lib/profile-url";
import { LEADERSHIP_SITES, LEADERSHIP_SITE_LABELS } from "@/lib/unit-leadership";

const EYEBROW = "text-[11px] uppercase tracking-[0.12em] text-muted-foreground";

function Rows({ rows }: { rows: PublicViceChair[] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {rows.map((v) => (
        <li key={`${v.cwid}-${v.displayTitle}`} className="text-[14px] leading-[21px]">
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
    <section aria-labelledby="vice-chairs-heading" className="mt-5 max-w-[600px]" data-testid="vice-chairs">
      <h2 id="vice-chairs-heading" className={EYEBROW}>
        Vice Chairs
      </h2>
      {general.length > 0 && <Rows rows={general} />}
      {bySite.map((g) => (
        <div key={g.site} className="mt-3">
          <h3 className={EYEBROW}>{LEADERSHIP_SITE_LABELS[g.site]}</h3>
          <Rows rows={g.rows} />
        </div>
      ))}
    </section>
  );
}
