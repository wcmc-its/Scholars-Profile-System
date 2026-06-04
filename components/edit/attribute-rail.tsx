/**
 * The Apollo ATTRIBUTES rail (#160 UI follow-up, `self-edit-launch-spec.md`
 * § Layout; vision-round T2.2). A `<nav>` landmark of attribute **links**
 * (`?attr=…`) so each attribute is deep-linkable and server-rendered per
 * selection — no client-only routing. The active item is a maroon fill +
 * chevron + `aria-current="page"`.
 *
 * Editability is legible at a glance via two mechanisms:
 *   - optional GROUP headers ("Yours to edit" / "From WCM systems") so the
 *     scholar-editable surface is separated from the sourced one; when no item
 *     carries a `group` the rail falls back to one flat list (back-compat for
 *     the unit / sibling-division rails that reuse `RailItem`);
 *   - a per-item `kind` cue — a lock glyph for read-only fields, an sr-only
 *     "(sourced…)" note for hide-only-sourced ones — never glyph-only and never
 *     a disabled control (a keyboard/SR user must still reach the panel).
 *
 * Focus is contrast-correct on both backgrounds: a white ring on the maroon
 * active item, a maroon (`--apollo-ring`) ring on the pale rail.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export type RailKind = "owned" | "sourced" | "readonly";

export type RailItem = {
  /** The `?attr=` value (e.g. "appointments"). */
  key: string;
  label: string;
  /** Read-only (SOR) attribute — lock glyph, muted. */
  readonly?: boolean;
  /** Optional group header. When no item has one, the rail renders flat. */
  group?: string;
  /** Editability tier; defaults from `readonly` when omitted. */
  kind?: RailKind;
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
                <RailLink key={item.key} item={item} active={active} basePath={basePath} />
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
              <RailLink key={item.key} item={item} active={active} basePath={basePath} />
            ))}
          </ul>
        </>
      )}
    </nav>
  );
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
  basePath,
}: {
  item: RailItem;
  active: string;
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
          isActive
            ? "bg-apollo-maroon text-apollo-maroon-foreground focus-visible:ring-offset-apollo-maroon font-medium focus-visible:ring-white"
            : "text-foreground hover:bg-apollo-rail-hover hover:border-apollo-maroon focus-visible:ring-apollo-ring focus-visible:ring-offset-apollo-rail",
          !isActive && kind === "readonly" && "text-muted-foreground",
        )}
      >
        <span className="flex items-center gap-2">
          {item.label}
          {kind === "sourced" && <span className="sr-only"> (sourced from WCM systems)</span>}
          {kind === "readonly" && <span className="sr-only"> (read-only, from WCM systems)</span>}
        </span>
        {isActive && <ChevronRight className="size-4 shrink-0" aria-hidden />}
      </Link>
    </li>
  );
}
