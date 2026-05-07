import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import type { DepartmentChair } from "@/lib/api/departments";

/**
 * Embedded chair card per neurology_dept_hero_per_spec.html.
 * Tight padding, 52px avatar, "CHAIR" uppercase eyebrow.
 */
export function ChairCard({ chair }: { chair: DepartmentChair }) {
  return (
    <div className="mt-6 flex max-w-[460px] items-center gap-[14px] rounded-md border border-border bg-background px-4 py-[14px]">
      <HeadshotAvatar
        size="md"
        cwid={chair.cwid}
        preferredName={chair.preferredName}
        identityImageEndpoint={chair.identityImageEndpoint}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-[3px] text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Chair
        </div>
        <a
          href={`/scholars/${chair.slug}`}
          className="text-[16px] font-medium leading-[1.2] hover:underline"
          style={{ textDecoration: "none" }}
        >
          {chair.preferredName}
        </a>
        {chair.primaryTitle && (
          <div className="text-[13px] leading-[1.4] text-muted-foreground">
            {chair.primaryTitle}
          </div>
        )}
      </div>
    </div>
  );
}
