import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import type { DepartmentChair } from "@/lib/api/departments";

export function ChairCard({ chair }: { chair: DepartmentChair }) {
  // Omit italic title line if title equals literal "Chair" or "Chairman" (would be redundant).
  const title = chair.chairTitle.trim();
  const showTitle =
    title.toLowerCase() !== "chair" && title.toLowerCase() !== "chairman";

  return (
    <div className="mt-8 flex flex-col items-start gap-6 rounded-lg border border-border bg-card p-6 sm:flex-row sm:items-start">
      <HeadshotAvatar
        size="lg"
        cwid={chair.cwid}
        preferredName={chair.preferredName}
        identityImageEndpoint={chair.identityImageEndpoint}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-sm uppercase tracking-wider text-muted-foreground">
          Chair
        </div>
        <a
          href={`/scholars/${chair.slug}`}
          className="text-base font-semibold hover:underline"
        >
          {chair.preferredName}
        </a>
        {showTitle && (
          <div className="mt-0.5 text-sm italic text-muted-foreground">
            {title}
          </div>
        )}
      </div>
    </div>
  );
}
