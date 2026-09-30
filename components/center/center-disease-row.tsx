import type { CenterMemberDisease } from "@/lib/center-member-diseases";

/** Chips shown before the "+N more" text. */
export const DISEASE_ROW_CAP = 3;

// Same shape as the TOPICS chip (`MESH_CHIP_CLASS`, person-row.tsx): 26px pill,
// 12.5px, truncating label so a long name stays inside the 1fr column at 390px.
const CHIP_BASE =
  "inline-flex h-[26px] min-w-0 max-w-full items-center whitespace-nowrap rounded-full border px-[10px] text-[12.5px] leading-none";
const PRIMARY_CHIP = `${CHIP_BASE} border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate`;
const OTHER_CHIP = `${CHIP_BASE} border-apollo-slate bg-background text-apollo-slate`;

/**
 * The public center roster card's DISEASES row (D1 — curated diseases sit
 * BESIDE topics, above the TOPICS row, in the same visual grammar: small-caps
 * label + pill chips). Primary-focus diseases get the filled slate tint, the
 * rest are outlined; order is primary first then rank (the loader's order,
 * `compareMemberDiseases`); at most three chips, then "+N more". Chips are not
 * links — there is no public disease page. Renders nothing for no diseases.
 */
export function CenterDiseaseRow({ diseases }: { diseases?: CenterMemberDisease[] }) {
  if (!diseases || diseases.length === 0) return null;
  const shown = diseases.slice(0, DISEASE_ROW_CAP);
  const more = diseases.length - shown.length;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-[6px]">
      <span
        aria-hidden
        className="mr-[2px] text-[10.5px] tracking-[0.12em] text-muted-foreground"
      >
        DISEASES
      </span>
      <ul
        aria-label="Disease focus"
        className="m-0 flex min-w-0 max-w-full list-none flex-wrap gap-[6px] p-0"
      >
        {shown.map((d) => {
          const primary = d.focus === "primary";
          return (
            <li key={d.diseaseCode} className="min-w-0 max-w-full">
              <span
                className={primary ? PRIMARY_CHIP : OTHER_CHIP}
                title={primary ? `${d.label} (primary focus)` : d.label}
                data-focus={primary ? "primary" : "other"}
              >
                <span className="truncate">{d.label}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <span className="text-[12px] text-muted-foreground">+{more} more</span>
      )}
    </div>
  );
}
