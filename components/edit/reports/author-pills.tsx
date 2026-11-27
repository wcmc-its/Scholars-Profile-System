/**
 * A publication's WCM authors as headshot pills, each with its hover card.
 * In its own file so client components (the Bibliometrics tab) can import it
 * without the report bodies' server-side imports.
 */
import { ScholarHoverCard, type ScholarCardFooter } from "@/components/edit/scholar-hover-card";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";

export function AuthorPills({
  authors,
  footer,
}: {
  authors: readonly { cwid: string; name: string }[];
  footer?: (cwid: string) => ScholarCardFooter;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {authors.map((a) => (
        <ScholarHoverCard key={a.cwid} cwid={a.cwid} footer={footer?.(a.cwid)}>
          <span className="border-border bg-background inline-flex items-center gap-2 rounded-full border py-[3px] pr-3 pl-1 text-[13px] leading-[1.3] font-semibold">
            <HeadshotAvatar size="sm" cwid={a.cwid} preferredName={a.name} />
            {a.name}
          </span>
        </ScholarHoverCard>
      ))}
    </div>
  );
}
