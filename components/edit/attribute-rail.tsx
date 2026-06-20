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
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export type RailKind = "owned" | "service" | "sourced" | "readonly";

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
};

export type AttributeRailProps = {
  items: ReadonlyArray<RailItem>;
  /** The currently selected attribute key. */
  active: string;
  /** Base path the links hang off — "/edit" or "/edit/scholar/{cwid}". */
  basePath: string;
};

export function AttributeRail({ items, active, basePath }: AttributeRailProps) {
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
        groupItems(items).map((g) => (
          <div key={g.label} className="mb-2 last:mb-0">
            <p className="text-muted-foreground px-2 py-1 text-xs font-semibold tracking-wide uppercase">
              {g.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((item) => (
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
        ))
      ) : (
        <>
          <p className="text-muted-foreground px-2 py-1 text-xs font-semibold tracking-wide uppercase">
            Attributes
          </p>
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
        </>
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
  const kind: RailKind = item.kind ?? (item.readonly ? "readonly" : "owned");
  return (
    <li>
      <Link
        href={`${basePath}?attr=${item.key}`}
        aria-current={isActive ? "page" : undefined}
        data-testid={`rail-${item.key}`}
        className={cn(
          "flex min-h-11 items-center justify-between gap-2 rounded-md border-l-2 border-transparent px-3 py-2 text-sm transition-colors md:min-h-9",
          "focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
          // Nested child ("From your publications"): indented, with a short
          // connector elbow to its parent, and a touch smaller/quieter.
          item.child &&
            "relative pl-9 text-[0.9rem] before:absolute before:top-1/2 before:left-[1.15rem] before:h-px before:w-2 before:-translate-y-1/2 before:content-['']",
          isActive
            ? cn(
                "bg-apollo-maroon text-apollo-maroon-foreground focus-visible:ring-offset-apollo-maroon font-medium focus-visible:ring-white",
                item.child && "before:bg-white/50",
              )
            : cn(
                "text-foreground hover:bg-apollo-rail-hover hover:border-apollo-maroon focus-visible:ring-apollo-ring focus-visible:ring-offset-apollo-rail",
                // Parent of the active child: subtle persistent highlight.
                parentActive && "bg-apollo-rail-hover",
                item.child && "before:bg-apollo-border-strong",
              ),
        )}
      >
        <span className="flex items-center gap-2">
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
        {isActive && <ChevronRight className="size-4 shrink-0" aria-hidden />}
      </Link>
    </li>
  );
}
