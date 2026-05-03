import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import type { DepartmentChair } from "@/lib/api/departments";

export function ChairCard({ chair }: { chair: DepartmentChair }) {
  // Omit italic title line if title equals literal "Chair" or "Chairman" (would be redundant).
  const title = chair.chairTitle.trim();
  const showTitle =
    title.toLowerCase() !== "chair" && title.toLowerCase() !== "chairman";

  return (
    <div className="mt-8 max-w-[560px] flex flex-col items-start gap-6 rounded-lg border border-border p-6 sm:flex-row sm:items-start" style={{ backgroundColor: "#f7f6f3" }}>
      <HeadshotAvatar
        size="lg"
        cwid={chair.cwid}
        preferredName={chair.preferredName}
        identityImageEndpoint={chair.identityImageEndpoint}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-xs font-semibold tracking-wider text-[var(--color-accent-slate)]">
          Department Chair
        </div>
        <a
          href={`/scholars/${chair.slug}`}
          className="text-base font-semibold hover:underline"
        >
          {chair.preferredName}
        </a>
        {chair.primaryTitle && (
          <div className="mt-0.5 text-sm text-muted-foreground">
            {chair.primaryTitle}
          </div>
        )}
      </div>
    </div>
  );
}
