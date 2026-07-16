/**
 * The Apollo ATTRIBUTES rail (#160 UI follow-up, `self-edit-launch-spec.md`
 * § Layout; vision-round T2.2). A `<nav>` landmark of attribute **links**
 * (`?attr=…`) so each attribute is deep-linkable and server-rendered per
 * selection — no client-only routing. The active item is a maroon fill +
 * chevron + `aria-current="page"`.
 *
 * Editability is legible at a glance via GROUP headers ("Yours to edit" /
 * "From WCM systems") that separate the scholar-editable surface from the
 * sourced one; when no item carries a `group` the rail falls back to one flat
 * list (back-compat for the unit / sibling-division rails that reuse
 * `RailItem`). Beyond the headers the links are NOT visually differentiated by
 * tier — every item reads the same so the rail stays simple — but read-only and
 * hide-only-sourced items each carry an sr-only note, and no item is ever a
 * disabled control (a keyboard / screen-reader user must still reach the panel).
 *
 * Focus is contrast-correct on both backgrounds: a white ring on the maroon
 * active item, a maroon (`--apollo-ring`) ring on the pale rail.
 */
import Link from "next/link";
import { ChevronRight, CornerDownRight, HomeIcon, type LucideIcon } from "lucide-react";

import { GroupInfoButton } from "@/components/edit/group-info-button";
import { cn } from "@/lib/utils";

export type RailKind = "owned" | "service" | "sourced" | "readonly";

/**
 * Leading-icon keys a rail item may carry. A STRING (not the component) so the
 * item stays serializable across the server→client boundary — `railItems` is
 * passed to the mobile `RailSelect`, a client component, and React Server
 * Components cannot serialize a function/component prop. `RailLink` maps the key
 * to the glyph.
 */
export type RailIconKey = "home";

const RAIL_ICONS: Record<RailIconKey, LucideIcon> = { home: HomeIcon };

export type RailItem = {
  /** The `?attr=` value (e.g. "appointments"). */
  key: string;
  label: string;
  /** Read-only (SOR) attribute — view-only on Scholars (sr-only note only). */
  readonly?: boolean;
  /** Optional group header. When no item has one, the rail renders flat. */
  group?: string;
  /** Editability tier; defaults from `readonly` when omitted. */
  kind?: RailKind;
  /**
   * A nested sub-item rendered indented beneath the preceding non-child item
   * (its parent). Used for "From your publications", which is a sub-view of
   * Conflicts of Interest, not a flat sibling. When a child is active the parent
   * stays highlighted so the scholar keeps their place in the tree.
   */
  child?: boolean;
  /**
   * Optional count of items to review, rendered as a quiet muted pill after the
   * label (capped at "9+"). Used by "From your publications" to show how many
   * High-tier COI-gap relationships are pending — a discoverability cue, never an
   * alert. Omit (or 0) to render no chip.
   */
  count?: number;
  /**
   * Optional sub-section header within a group (e.g. "Identity · read-only" vs
   * "Records · hide, show, or flag" inside "From WCM records"). Consecutive items
   * that share a `subgroup` render under one quiet sub-label; a change starts the
   * next. Items without a `subgroup` render flush under the group header.
   */
  subgroup?: string;
  /**
   * Optional quiet right-aligned annotation (e.g. "landing" on Home). Muted, never
   * an alert; coexists with the active chevron.
   */
  tag?: string;
  /**
   * Optional leading-icon key (e.g. "home" on the floating landing item in the
   * restructured rail). A string, NOT a component, so the item stays serializable
   * across the server→client boundary (see `RailIconKey`). `RailLink` resolves it
   * to the glyph, which inherits the row's text color (reads on both the pale rail
   * and the active maroon fill).
   */
  icon?: RailIconKey;
};

export type AttributeRailProps = {
  items: ReadonlyArray<RailItem>;
  /** The currently selected attribute key. */
  active: string;
  /** Base path the links hang off — "/edit" or "/edit/scholar/{cwid}". */
  basePath: string;
  /**
   * Optional per-group descriptions, keyed by the group label. When present the
   * one-line note is tucked behind an info button beside the group header
   * (`GroupInfoButton`, e.g. "Profile administration." for "Settings"). Groups
   * without an entry render header-only (back-compat for the unit /
   * sibling-division rails, which pass nothing).
   */
  groupMeta?: Record<string, { description?: string }>;
};

export function AttributeRail({ items, active, basePath, groupMeta }: AttributeRailProps) {
  const grouped = items.some((i) => i.group);
  // When the active item is a nested child, its parent (the nearest preceding
  // non-child item) stays highlighted so the tree position reads clearly.
  const activeParentKey = parentKeyOf(items, active);
  return (
    <nav
      aria-label="Profile attributes"
      className="bg-apollo-rail border-apollo-rail-border rounded-md border p-2"
    >
      {grouped ? (
        groupItems(items).map((g, groupIndex) => {
          // An empty group label is the floating leading block (e.g. Home): no
          // header, just the item(s) at the top of the rail.
          const isFloating = g.label === "";
          const description = groupMeta?.[g.label]?.description;
          // Hairline rule between sections — restructured rail only (groupMeta is
          // present only there); skipped before the first (floating Home) group.
          const showDivider = groupMeta != null && groupIndex > 0;
          // All rail group headers are neutral gray — provenance lives on the
          // panel (the green "Yours to edit" badge / neutral lock cue), not the nav.
          const accent = groupAccent();
          return (
            <div
              key={g.label || "__floating"}
              className={cn("mb-2 border-l-2 pl-1 last:mb-0", accent.spine)}
            >
              {showDivider && (
                <hr className="border-apollo-rail-border mx-1 mb-2 border-0 border-t" />
              )}
              {!isFloating && (
                <div className="flex items-center gap-1.5 px-2 py-1">
                  {accent.dot && (
                    <span
                      className={cn("inline-block size-1.5 shrink-0 rounded-full", accent.dot)}
                      aria-hidden
                    />
                  )}
                  <p
                    className={cn(
                      "text-xs font-semibold tracking-wide uppercase",
                      accent.text,
                    )}
                  >
                    {g.label}
                  </p>
                  {description && <GroupInfoButton label={g.label} description={description} />}
                </div>
              )}
              {subgroupBuckets(g.items).map((sg) => (
                <div key={sg.label || "__nosub"}>
                  {sg.label && (
                    <p className="text-muted-foreground px-2.5 pt-2 pb-0.5 text-[0.6875rem]">
                      {sg.label}
                    </p>
                  )}
                  <ul className="flex flex-col gap-0.5">
                    {sg.items.map((item) => (
                      <RailLink
                        key={item.key}
                        item={item}
                        active={active}
                        parentActive={item.key === activeParentKey}
                        basePath={basePath}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          );
        })
      ) : (
        // Flat rail (superuser scholar rail, unit rails): undifferentiated, so
        // neutral — provenance is carried by the panel badges, not the nav.
        <div className="border-apollo-rail-border border-l-2 pl-1">
          <div className="flex items-center gap-1.5 px-2 py-1">
            <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Attributes
            </p>
          </div>
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => (
              <RailLink
                key={item.key}
                item={item}
                active={active}
                parentActive={item.key === activeParentKey}
                basePath={basePath}
              />
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}

/**
 * If `active` is a nested child, return its parent key (the nearest preceding
 * non-child item); otherwise `null`. Lets the parent render highlighted while a
 * child is selected.
 */
function parentKeyOf(items: ReadonlyArray<RailItem>, active: string): string | null {
  let lastParent: string | null = null;
  for (const item of items) {
    if (item.child) {
      if (item.key === active) return lastParent;
    } else {
      lastParent = item.key;
    }
  }
  return null;
}

/** Bucket items by `group`, preserving first-appearance group order. */
function groupItems(items: ReadonlyArray<RailItem>): Array<{ label: string; items: RailItem[] }> {
  const order: string[] = [];
  const map = new Map<string, RailItem[]>();
  for (const item of items) {
    const g = item.group ?? "";
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(item);
  }
  return order.map((label) => ({ label, items: map.get(label)! }));
}

/**
 * Split a group's items into consecutive runs by `subgroup`, preserving order.
 * Items without a `subgroup` form a single unlabeled run. Used to draw the quiet
 * "Identity · read-only" / "Records · hide, show, or flag" sub-labels inside one
 * group without splitting it into separate top-level sections.
 */
function subgroupBuckets(items: RailItem[]): Array<{ label: string; items: RailItem[] }> {
  const buckets: Array<{ label: string; items: RailItem[] }> = [];
  for (const item of items) {
    const label = item.subgroup ?? "";
    const last = buckets[buckets.length - 1];
    if (last && last.label === label) {
      last.items.push(item);
    } else {
      buckets.push({ label, items: [item] });
    }
  }
  return buckets;
}

/** Editability tier of a rail item (defaults from `readonly` when `kind` is
 *  omitted). */
function railTier(item: RailItem): RailKind {
  return item.kind ?? (item.readonly ? "readonly" : "owned");
}

/**
 * Per-group accent. ALL rail group headers are neutral gray now — provenance is
 * carried by the panel (the green "Yours to edit" badge / neutral lock cue),
 * never by the nav. Green is reserved exclusively for the ownership badge; maroon
 * for the active item. Applied to the group's header text and a left spine (no
 * hue, no dot).
 */
function groupAccent(): {
  text: string;
  dot: string;
  spine: string;
} {
  return { text: "text-muted-foreground", dot: "", spine: "border-apollo-rail-border" };
}

function RailLink({
  item,
  active,
  parentActive,
  basePath,
}: {
  item: RailItem;
  active: string;
  /** This item is the parent of the currently-active child — stays highlighted. */
  parentActive?: boolean;
  basePath: string;
}) {
  const isActive = item.key === active;
  const kind: RailKind = railTier(item);
  const Icon = item.icon ? RAIL_ICONS[item.icon] : undefined;
  return (
    <li>
      <Link
        href={`${basePath}?attr=${item.key}`}
        aria-current={isActive ? "page" : undefined}
        data-testid={`rail-${item.key}`}
        className={cn(
          "flex min-h-11 items-center justify-between gap-2 rounded-md border-l-2 border-transparent px-3 py-2 text-sm transition-colors md:min-h-9",
          "focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
          // Nested child ("From your publications"): indented and quieter, with a
          // down-right arrow (below) standing in for the connector to its parent.
          item.child && "pl-7 text-xs",
          isActive
            ? "bg-apollo-maroon text-apollo-maroon-foreground focus-visible:ring-offset-apollo-maroon font-medium focus-visible:ring-white"
            : cn(
                "text-foreground hover:bg-apollo-rail-hover hover:border-apollo-maroon focus-visible:ring-apollo-ring focus-visible:ring-offset-apollo-rail",
                // Parent of the active child: subtle persistent highlight.
                parentActive && "bg-apollo-rail-hover",
              ),
        )}
      >
        <span className="flex items-center gap-2">
          {item.child && (
            <CornerDownRight className="size-3.5 shrink-0 opacity-60" aria-hidden />
          )}
          {Icon && (
            <Icon data-testid={`rail-${item.key}-icon`} className="size-4 shrink-0" aria-hidden />
          )}
          {item.label}
          {item.count != null && item.count > 0 && (
            // Quiet "to review" count — a muted pill, deliberately NOT an alert
            // badge. Capped at "9+" so it stays a cue, not a scoreboard. White-on-
            // maroon variant when the row is active.
            <span
              aria-label={`${item.count} to review`}
              className={cn(
                "inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[0.6875rem] leading-none font-semibold tabular-nums",
                isActive
                  ? "text-apollo-maroon-foreground bg-white/20"
                  : "text-muted-foreground border-apollo-border-strong bg-apollo-border border",
              )}
            >
              {item.count > 9 ? "9+" : item.count}
            </span>
          )}
          {kind === "sourced" && <span className="sr-only"> (sourced from WCM systems)</span>}
          {kind === "readonly" && <span className="sr-only"> (read-only, from WCM systems)</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {item.tag && (
            <span
              className={cn(
                "text-[0.6875rem] font-normal",
                isActive ? "text-apollo-maroon-foreground/80" : "text-muted-foreground",
              )}
            >
              {item.tag}
            </span>
          )}
          {isActive && <ChevronRight className="size-4 shrink-0" aria-hidden />}
        </span>
      </Link>
    </li>
  );
}
