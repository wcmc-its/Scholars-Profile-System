/**
 * Single chip in the Top scholars chip row.
 *
 * Server Component (HeadshotAvatar inside is a Client Component — that's fine,
 * RSC can render Client Components). Composition:
 *   - HeadshotAvatar size="sm" (24×24px) on the left.
 *   - Two-line text stack: preferred name (13px / weight 600) + primary title
 *     (13px / muted, weight 400). Title is hidden if absent (absence-as-default).
 *   - Anchor wrapper navigates to /scholars/{slug}.
 *   - Default border `var(--border)`; hover state Slate (#2c4f6e) outline 1.5px
 *     to match UI-SPEC §"/topics/{slug} — Top scholars chip row".
 *
 * Visual contract: 02-UI-SPEC.md §"/topics/{slug} — Top scholars chip row".
 */
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import type { TopScholarChipData } from "@/lib/api/topics";

export function TopScholarChip({ scholar }: { scholar: TopScholarChipData }) {
  return (
    <a
      href={`/scholars/${scholar.slug}`}
      className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-background px-3 py-1 hover:border-[1.5px] hover:border-[var(--color-accent-slate)]"
    >
      <HeadshotAvatar
        size="sm"
        cwid={scholar.cwid}
        preferredName={scholar.preferredName}
        identityImageEndpoint={scholar.identityImageEndpoint}
      />
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold">{scholar.preferredName}</span>
        {scholar.primaryTitle ? (
          <span className="text-sm text-muted-foreground">
            {scholar.primaryTitle}
          </span>
        ) : null}
      </div>
    </a>
  );
}
