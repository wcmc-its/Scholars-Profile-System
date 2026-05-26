/**
 * The Apollo ATTRIBUTES rail (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Layout). A `<nav>` landmark of attribute
 * **links** (`?attr=…`) so each attribute is deep-linkable and server-rendered
 * per selection — no client-only routing. The active item is a maroon fill +
 * chevron + `aria-current="page"`; a read-only attribute carries a lock glyph
 * and is muted (but is still a normal link to its read-only panel — never a
 * disabled control, which a keyboard/SR user couldn't reach).
 */
import Link from "next/link";
import { ChevronRight, Lock } from "lucide-react";

import { cn } from "@/lib/utils";

export type RailItem = {
  /** The `?attr=` value (e.g. "appointments"). */
  key: string;
  label: string;
  /** Read-only (SOR) attribute — lock glyph, muted. */
  readonly?: boolean;
};

export type AttributeRailProps = {
  items: ReadonlyArray<RailItem>;
  /** The currently selected attribute key. */
  active: string;
  /** Base path the links hang off — "/edit" or "/edit/scholar/{cwid}". */
  basePath: string;
};

export function AttributeRail({ items, active, basePath }: AttributeRailProps) {
  return (
    <nav aria-label="Profile attributes" className="bg-apollo-rail border-apollo-rail-border rounded-md border p-2">
      <p className="text-muted-foreground px-2 py-1 text-xs font-semibold tracking-wide uppercase">
        Attributes
      </p>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <li key={item.key}>
              <Link
                href={`${basePath}?attr=${item.key}`}
                aria-current={isActive ? "page" : undefined}
                data-testid={`rail-${item.key}`}
                className={cn(
                  "focus-visible:ring-ring flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none",
                  isActive
                    ? "bg-apollo-maroon text-apollo-maroon-foreground font-medium"
                    : "hover:bg-apollo-rail-border/60 text-foreground",
                  !isActive && item.readonly && "text-muted-foreground",
                )}
              >
                <span className="flex items-center gap-2">
                  {item.readonly && <Lock className="size-3.5 shrink-0" aria-hidden />}
                  {item.label}
                </span>
                {isActive && <ChevronRight className="size-4 shrink-0" aria-hidden />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
