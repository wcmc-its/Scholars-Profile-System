import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Badge } from "@/components/ui/badge";
import type { MenteeChip } from "@/lib/api/mentoring";

export function MentoringSection({
  mentees,
  mentorSlug,
}: {
  mentees: MenteeChip[];
  /** Kept on the props for telemetry symmetry with the mentee CWID, even
   *  though the badge link only needs `mentorSlug` to build the URL. */
  mentorCwid: string;
  mentorSlug: string;
}) {
  if (mentees.length === 0) return null;

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {mentees.map((m) => (
        <MenteeChipCard key={m.cwid} mentee={m} mentorSlug={mentorSlug} />
      ))}
    </ul>
  );
}

function MenteeChipCard({
  mentee,
  mentorSlug,
}: {
  mentee: MenteeChip;
  mentorSlug: string;
}) {
  const isLinked = mentee.scholar !== null;
  const programLabel = formatProgramLabel(mentee.programType);
  const yearLabel = mentee.graduationYear ? `Class of ${mentee.graduationYear}` : null;
  const displayName = mentee.scholar?.publishedName ?? mentee.fullName;
  const copubCount = mentee.copublications.length;

  // Body region: avatar + name + meta. Becomes a link for linked mentees,
  // static content for unlinked alumni. Sits as a sibling of the badge so
  // the two click targets stay disjoint (no nested interactive elements).
  const body = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <HeadshotAvatar
        size="sm"
        cwid={mentee.cwid}
        preferredName={mentee.fullName}
        identityImageEndpoint={mentee.identityImageEndpoint}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{displayName}</div>
        <div className="text-muted-foreground text-xs leading-snug">
          {[programLabel, yearLabel].filter(Boolean).join(" · ")}
        </div>
      </div>
    </div>
  );

  // The co-pubs badge is a plain anchor to the dedicated page (#184).
  // The page replaces the inline popover from #181 — bookmarkable, with
  // CSV/Word exports. The inline-preview interaction (#185) will later
  // wrap this same target with expandable behavior.
  const badge =
    copubCount > 0 ? (
      <a
        href={`/scholars/${mentorSlug}/co-pubs/${mentee.cwid}`}
        className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`View ${copubCount} publication${copubCount === 1 ? "" : "s"} co-authored with ${mentee.fullName}`}
      >
        <Badge
          variant="secondary"
          className="whitespace-nowrap transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-800"
        >
          {copubCount} co-pub{copubCount === 1 ? "" : "s"}
        </Badge>
      </a>
    ) : null;

  // Row darkening is scoped to the body anchor via a data attribute so
  // hovering the co-pubs badge link only darkens the badge, not the row.
  const containerClasses = isLinked
    ? "flex items-center gap-2 rounded-md border border-border bg-zinc-50 px-3 py-2.5 transition-colors has-[[data-mentee-body]:hover]:bg-zinc-100 dark:bg-zinc-900/40 dark:has-[[data-mentee-body]:hover]:bg-zinc-900/60"
    : "flex items-center gap-2 rounded-md border border-border border-dashed bg-transparent px-3 py-2.5 opacity-80";

  return (
    <li className={containerClasses}>
      {isLinked ? (
        <a
          href={`/scholars/${mentee.scholar!.slug}`}
          data-mentee-body
          className="flex min-w-0 flex-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </a>
      ) : (
        body
      )}
      {badge}
    </li>
  );
}

/** Map raw `reporting_students_mentors.programType` codes to user-facing
 *  labels. AOC and AOC-2025 are the same scholarly-concentration program
 *  and collapse to the same "MD mentee" bucket — the AOC acronym is not
 *  exposed in the UI because it's not widely recognized outside the
 *  registrar / Grad School audience. */
function formatProgramLabel(programType: string | null): string | null {
  if (!programType) return null;
  if (programType === "AOC" || programType.startsWith("AOC-")) return "MD mentee";
  if (programType === "MDPHD") return "MD-PhD mentee";
  if (programType === "ECR") return "Early career mentee";
  return programType;
}
