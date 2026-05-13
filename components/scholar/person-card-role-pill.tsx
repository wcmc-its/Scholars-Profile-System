/**
 * Authorship role pill for PersonPopover on the pub-chip / co-author surfaces.
 *
 * Mirrors AuthorChipRow's chipRoleLabel logic so the role displayed on hover
 * matches the chip border color (slate=first, amber=senior). Co-equal authorship
 * is preserved per #18 (Co-first / Co-senior).
 */
export type AuthorshipRole =
  | "first"
  | "co-first"
  | "senior"
  | "co-senior"
  | "first-and-senior"
  | "co-author";

export function authorshipRoleFromFlags(
  isFirst: boolean,
  isLast: boolean,
  firstCount: number,
  lastCount: number,
): AuthorshipRole {
  if (isFirst && isLast) return "first-and-senior";
  if (isFirst) return firstCount > 1 ? "co-first" : "first";
  if (isLast) return lastCount > 1 ? "co-senior" : "senior";
  return "co-author";
}

const ROLE_LABEL: Record<AuthorshipRole, string> = {
  first: "First author",
  "co-first": "Co-first author",
  senior: "Senior author",
  "co-senior": "Co-senior author",
  "first-and-senior": "First and senior author",
  "co-author": "Co-author",
};

const ROLE_TONE: Record<AuthorshipRole, "first" | "senior" | "neutral"> = {
  first: "first",
  "co-first": "first",
  senior: "senior",
  "co-senior": "senior",
  "first-and-senior": "senior",
  "co-author": "neutral",
};

export function PersonCardRolePill({
  role,
  onPub,
}: {
  role: AuthorshipRole;
  /** When true, suffixes "on this pub" for added clarity in the popover. */
  onPub?: boolean;
}) {
  const tone = ROLE_TONE[role];
  const label = ROLE_LABEL[role];
  const toneClass =
    tone === "first"
      ? "border-[var(--color-accent-slate)] bg-[rgba(44,79,110,0.06)] text-[var(--color-accent-slate)]"
      : tone === "senior"
        ? "border-amber-700/70 bg-amber-50 text-amber-900"
        : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] ${toneClass}`}
    >
      {label}
      {onPub ? <span className="ml-1 font-normal normal-case tracking-normal">on this pub</span> : null}
    </span>
  );
}
