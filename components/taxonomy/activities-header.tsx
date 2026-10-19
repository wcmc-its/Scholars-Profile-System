"use client";

/**
 * TOPIC_FEED_GRANTS_TRIALS — the Activities feed header, per the mockup
 * (`Subarea mockup tweaks/Activities Redesign`): the "Activities" heading with
 * an info button, the Scholars chips, the type tabs with Sort on the right, and
 * the "Include related …" switch. Presentational only; the feeds own the state.
 */
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { profilePath } from "@/lib/profile-url";
import { cn } from "@/lib/utils";

export type ActivityTab<T extends string> = { value: T; label: string; count: number | null };

export type ScholarChip = {
  cwid: string;
  name: string;
  slug: string;
  headshot: string;
  /** Activities in scope (papers + grants + trials). */
  count: number;
};

const SCHOLAR_LIMIT = 6;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Z]/.test(w))
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "hover:border-apollo-border-strong inline-flex h-8 items-center gap-[7px] rounded-full border pr-2.5 pl-1 text-[13px] text-[#1a1a1a]",
        on ? "bg-apollo-slate-tint border-apollo-slate" : "bg-apollo-surface border-apollo-border",
      )}
    >
      {children}
    </button>
  );
}

export function ActivitiesHeader<T extends string>({
  info,
  scholars,
  pickedCwid,
  onPick,
  tabs,
  activeTab,
  onTab,
  sortControl,
  related,
}: {
  /** The info button's text for the active tab. */
  info: string;
  /** Null while loading; sorted by count. */
  scholars: ScholarChip[] | null;
  pickedCwid: string | null;
  onPick: (cwid: string | null) => void;
  tabs: Array<ActivityTab<T>>;
  activeTab: T;
  onTab: (t: T) => void;
  sortControl: ReactNode;
  /** The switch, or null when the active tab has no related tier. */
  related: { label: string; count: number; on: boolean; onChange: (on: boolean) => void } | null;
}) {
  const [allScholars, setAllScholars] = useState(false);
  const list = scholars ?? [];
  let visible = allScholars ? list : list.slice(0, SCHOLAR_LIMIT);
  const picked = list.find((s) => s.cwid === pickedCwid);
  if (picked && !visible.includes(picked)) visible = [...visible, picked];

  return (
    <div className="flex flex-col" data-testid="activities-header">
      <div className="mb-3.5 flex items-center gap-2">
        <h3 className="m-0 text-[21px] font-medium">Activities</h3>
        <button
          type="button"
          title={info}
          aria-label={info}
          className="border-muted-foreground text-muted-foreground inline-flex size-4 cursor-help items-center justify-center rounded-full border-[1.5px] text-[10px] font-semibold"
        >
          i
        </button>
      </div>

      {list.length > 0 && (
        <div className="flex flex-col gap-2.5 pb-[18px]" data-testid="activities-scholars">
          <div className="text-muted-foreground text-xs font-semibold tracking-[.06em]">SCHOLARS</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip on={!pickedCwid} onClick={() => onPick(null)}>
              <span className="w-1" />
              <span>All</span>
            </Chip>
            {visible.map((s) => (
              <Chip
                key={s.cwid}
                on={s.cwid === pickedCwid}
                onClick={() => onPick(s.cwid === pickedCwid ? null : s.cwid)}
              >
                <Avatar size="sm" className="size-[22px]">
                  {s.headshot && <AvatarImage src={s.headshot} alt="" />}
                  <AvatarFallback className="text-[10px]">{initials(s.name)}</AvatarFallback>
                </Avatar>
                <span>{s.name}</span>
                <span
                  className="text-muted-foreground"
                  aria-label={`${s.count} ${s.count === 1 ? "activity" : "activities"}`}
                >
                  {s.count.toLocaleString()}
                </span>
              </Chip>
            ))}
            {list.length > SCHOLAR_LIMIT && (
              <button
                type="button"
                onClick={() => setAllScholars((v) => !v)}
                className="text-apollo-slate inline-flex h-[30px] items-center px-1.5 text-[13px]"
              >
                {allScholars ? "Show fewer" : `+${list.length - SCHOLAR_LIMIT} more`}
              </button>
            )}
          </div>
          {picked && (
            <Link
              href={profilePath(picked.slug)}
              className="text-apollo-slate w-max text-[13px] hover:underline"
              data-testid="activities-picked-profile"
            >
              View {picked.name}&apos;s profile →
            </Link>
          )}
        </div>
      )}

      <div className="border-apollo-border flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b">
        <div role="tablist" className="flex gap-6">
          {/* A type with nothing in scope gets no tab (the active one always stays). */}
          {tabs.filter((t) => t.value === activeTab || t.count !== 0).map((t) => {
            const active = t.value === activeTab;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTab(t.value)}
                className={cn(
                  "-mb-px flex items-baseline gap-1.5 pt-2.5 pb-[11px] text-[15px]",
                  active
                    ? "font-medium text-[#1a1a1a] shadow-[inset_0_-2px_0_var(--apollo-maroon)]"
                    : "text-muted-foreground hover:text-[#1a1a1a]",
                )}
              >
                {t.label}
                <span className="text-muted-foreground text-[13px] font-normal">
                  {t.count?.toLocaleString() ?? ""}
                </span>
              </button>
            );
          })}
        </div>
        <div className="text-muted-foreground flex items-center gap-2 py-1.5 text-sm">{sortControl}</div>
      </div>

      {related && (
        <div className="border-apollo-border flex items-center border-b py-3.5">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={related.on} onCheckedChange={related.onChange} />
            <span>
              {related.label}{" "}
              <span className="text-muted-foreground">+{related.count.toLocaleString()}</span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
