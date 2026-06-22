/**
 * The mobile stand-in for the ATTRIBUTES rail (vision-round T2.5 / finding 4.5).
 * On phones the full vertical rail pushed the editor ~540px down the page; below
 * `md` we hide the rail and render this compact `<select>` instead so the editor
 * is reachable immediately. Navigates to the same deep-linkable `?attr=` URLs as
 * the rail links, grouped to mirror the desktop "Yours to edit" / "From WCM
 * systems" sections.
 */
"use client";

import { useRouter } from "next/navigation";

import type { RailItem } from "@/components/edit/attribute-rail";

export function RailSelect({
  items,
  active,
  basePath,
}: {
  items: ReadonlyArray<RailItem>;
  active: string;
  basePath: string;
}) {
  const router = useRouter();
  const groups = groupItems(items);
  return (
    <label className="flex flex-col gap-1 md:hidden">
      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Attribute
      </span>
      <select
        aria-label="Choose a profile attribute to edit"
        value={active}
        onChange={(e) => router.push(`${basePath}?attr=${e.target.value}`)}
        data-testid="rail-select"
        className="border-apollo-border-strong bg-background focus-visible:ring-apollo-ring h-11 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
      >
        {groups.flat ? (
          items.map((it) => (
            <option key={it.key} value={it.key}>
              {it.label}
            </option>
          ))
        ) : (
          groups.buckets.map((g) =>
            // The empty-label bucket is the floating leading block (e.g. Home):
            // render it as bare option(s) rather than a blank-titled optgroup.
            // Sub-headers are desktop-only — on mobile each group is one flat
            // optgroup (a `<select>` can't nest), which is the expected fallback.
            g.label === "" ? (
              g.items.map((it) => (
                <option key={it.key} value={it.key}>
                  {it.label}
                </option>
              ))
            ) : (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((it) => (
                  <option key={it.key} value={it.key}>
                    {it.label}
                  </option>
                ))}
              </optgroup>
            ),
          )
        )}
      </select>
    </label>
  );
}

function groupItems(items: ReadonlyArray<RailItem>):
  | { flat: true; buckets: never[] }
  | { flat: false; buckets: Array<{ label: string; items: RailItem[] }> } {
  if (!items.some((i) => i.group)) return { flat: true, buckets: [] };
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
  return { flat: false, buckets: order.map((label) => ({ label, items: map.get(label)! })) };
}
