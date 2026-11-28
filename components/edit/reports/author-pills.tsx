/**
 * A publication's WCM authors as headshot pills, each with its hover card.
 * In its own file so client components (the Bibliometrics tab) can import it
 * without the report bodies' server-side imports.
 *
 * `max` (report 27, spec B1): show that many, then "+N more". They are picked
 * as: authors `match` says put the paper in scope, then the first author, the
 * senior (last) author, then byline order. With `match` given, the rest are
 * muted.
 */
import { MoreChips } from "@/components/edit/reports/more-chips";
import { ScholarHoverCard, type ScholarCardFooter } from "@/components/edit/scholar-hover-card";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";

type Author = { cwid: string; name: string; position?: string };
const RANK: Record<string, number> = { first: 0, last: 1 };

export function AuthorPills<A extends Author>({
  authors,
  footer,
  max = Infinity,
  match,
}: {
  authors: readonly A[];
  footer?: (cwid: string) => ScholarCardFooter;
  max?: number;
  match?: (a: A) => boolean;
}) {
  const ordered =
    max === Infinity
      ? authors
      : [...authors].sort(
          (a, b) =>
            Number(match ? !match(a) : 0) - Number(match ? !match(b) : 0) ||
            (RANK[a.position ?? ""] ?? 2) - (RANK[b.position ?? ""] ?? 2),
        );
  const pill = (a: A) => (
    <ScholarHoverCard key={a.cwid} cwid={a.cwid} footer={footer?.(a.cwid)}>
      <span
        className={`border-border bg-background inline-flex items-center gap-2 rounded-full border py-[3px] pr-3 pl-1 text-[13px] leading-[1.3] font-semibold ${
          match && !match(a) ? "text-muted-foreground opacity-70" : ""
        }`}
      >
        <HeadshotAvatar size="sm" cwid={a.cwid} preferredName={a.name} />
        {a.name}
      </span>
    </ScholarHoverCard>
  );
  const rest = ordered.slice(max);
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {ordered.slice(0, max).map(pill)}
      {rest.length > 0 && <MoreChips count={rest.length}>{rest.map(pill)}</MoreChips>}
    </div>
  );
}
