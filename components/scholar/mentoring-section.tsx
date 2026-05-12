import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { CoPubPopover } from "@/components/scholar/copub-popover";
import type { MenteeChip } from "@/lib/api/mentoring";

export function MentoringSection({
  mentees,
  mentorCwid,
}: {
  mentees: MenteeChip[];
  mentorCwid: string;
}) {
  if (mentees.length === 0) return null;

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {mentees.map((m) => (
        <MenteeChipCard key={m.cwid} mentee={m} mentorCwid={mentorCwid} />
      ))}
    </ul>
  );
}

function MenteeChipCard({
  mentee,
  mentorCwid,
}: {
  mentee: MenteeChip;
  mentorCwid: string;
}) {
  const isLinked = mentee.scholar !== null;
  const programLabel = formatProgramLabel(mentee.programType);
  const yearLabel = mentee.graduationYear ? `Class of ${mentee.graduationYear}` : null;
  const displayName = mentee.scholar?.publishedName ?? mentee.fullName;
  const hasCopubs = mentee.copublications.length > 0;

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

  const badge = hasCopubs ? (
    <CoPubPopover
      copublications={mentee.copublications}
      menteeFullName={mentee.fullName}
      mentorCwid={mentorCwid}
      menteeCwid={mentee.cwid}
    />
  ) : null;

  const containerClasses = isLinked
    ? "flex items-center gap-2 rounded-md border border-border bg-zinc-50 px-3 py-2.5 transition-colors hover:bg-zinc-100 dark:bg-zinc-900/40 dark:hover:bg-zinc-900/60"
    : "flex items-center gap-2 rounded-md border border-border border-dashed bg-transparent px-3 py-2.5 opacity-80";

  return (
    <li className={containerClasses}>
      {isLinked ? (
        <a
          href={`/scholars/${mentee.scholar!.slug}`}
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
