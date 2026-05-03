import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

// Role tag: design-spec-locked spacing/typography per UI-SPEC §6.10
// (10px font, 6px h-padding, 18px h, uppercase, 0.06em tracking)
function RoleTag({ role }: { role: string }) {
  return (
    <span
      className="inline-flex items-center rounded-[3px] border border-border bg-secondary text-muted-foreground"
      style={{
        fontSize: "10px",
        lineHeight: "18px",
        padding: "0 6px",
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      {role}
    </span>
  );
}

export function PersonRow({ hit }: { hit: DepartmentFacultyHit }) {
  // Department/division line per UI-SPEC §6.10 + design spec lines 906-920.
  const deptLine = hit.divisionName
    ? `${hit.divisionName} · Department of ${hit.departmentName}`
    : `Department of ${hit.departmentName}`;

  // Stats: omit individual line at 0; entire column omitted if both 0.
  const showStats = hit.pubCount > 0 || hit.grantCount > 0;
  const pubLabel = hit.pubCount === 1 ? "pub" : "pubs";
  const grantLabel = hit.grantCount === 1 ? "grant" : "grants";

  return (
    <div className="grid grid-cols-[40px_1fr] items-start gap-3 rounded-lg py-3 hover:bg-accent transition-colors sm:grid-cols-[56px_1fr_auto]">
      <div>
        <HeadshotAvatar
          size="md"
          cwid={hit.cwid}
          preferredName={hit.preferredName}
          identityImageEndpoint={hit.identityImageEndpoint}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <a
            href={`/scholars/${hit.slug}`}
            className="text-base font-semibold hover:underline"
          >
            {hit.preferredName}
          </a>
          {hit.roleCategory && <RoleTag role={hit.roleCategory} />}
        </div>
        {hit.primaryTitle && (
          <div className="text-sm">{hit.primaryTitle}</div>
        )}
        <div className="text-sm text-muted-foreground">{deptLine}</div>
      </div>
      {showStats && (
        <div className="col-start-1 col-end-3 mt-1 flex flex-col items-end gap-0.5 text-sm sm:col-start-3 sm:row-start-1 sm:mt-0">
          {hit.pubCount > 0 && (
            <div className="text-right text-muted-foreground">
              <span className="font-semibold text-foreground">{hit.pubCount.toLocaleString()}</span>{" "}
              {pubLabel}
            </div>
          )}
          {hit.grantCount > 0 && (
            <div className="text-right text-muted-foreground">
              <span className="font-semibold text-foreground">{hit.grantCount.toLocaleString()}</span>{" "}
              {grantLabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
