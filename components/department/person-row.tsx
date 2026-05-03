import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

function RoleTag({ role }: { role: string }) {
  return (
    <span
      className="inline-flex items-center rounded-[3px] text-muted-foreground"
      style={{
        fontSize: "10px",
        lineHeight: "18px",
        padding: "0 6px",
        fontWeight: 500,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        backgroundColor: "#f1f1f1",
      }}
    >
      {role}
    </span>
  );
}

export function PersonRow({ hit }: { hit: DepartmentFacultyHit }) {
  const deptLine = hit.divisionName
    ? `${hit.divisionName} · Department of ${hit.departmentName}`
    : `Department of ${hit.departmentName}`;

  const pubLabel = hit.pubCount === 1 ? "pub" : "pubs";
  const grantLabel = hit.grantCount === 1 ? "grant" : "grants";

  return (
    <div className="grid grid-cols-[40px_1fr_auto] items-start gap-3 rounded-lg py-3 transition-colors hover:bg-accent sm:grid-cols-[56px_1fr_auto]">
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
        {hit.overview ? (
          <div className="text-sm text-muted-foreground">{hit.overview}</div>
        ) : (
          <div className="text-sm text-muted-foreground">{deptLine}</div>
        )}
      </div>
      <div className="flex flex-col items-end gap-0.5 text-sm">
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
    </div>
  );
}
