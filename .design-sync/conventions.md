## Using this library

No root provider is required for styling — every token is a CSS custom property already in `styles.css`'s import closure, so components render correctly the moment you import them. **One exception:** `Tooltip` is a bare Radix primitive — wrap every usage in `TooltipProvider` or it won't position/behave correctly:

```tsx
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "scholars-profile-system"

<TooltipProvider>
  <Tooltip>
    <TooltipTrigger asChild><Button size="icon"><InfoIcon /></Button></TooltipTrigger>
    <TooltipContent>Grant funded under an R01 mechanism</TooltipContent>
  </Tooltip>
</TooltipProvider>
```

## Styling idiom: variant props first, Tailwind utilities for layout

Most components take a `variant`/`size` prop instead of raw classes — prefer it over hand-composing utilities. `Button`: `variant="default"|"secondary"|"outline"|"ghost"|"link"|"apollo"|"destructive"`, `size="xs"|"sm"|"default"|"lg"|"icon"` (+ `icon-xs`/`icon-sm`/`icon-lg`). `Badge`/`Alert` take a similar `variant`. For layout glue (spacing, flex, grid) use Tailwind utility classes via `className` — the compiled stylesheet ships the full utility set, not just a subset.

Design tokens are CSS custom properties, consumed as Tailwind utilities (`bg-*`, `text-*`, `border-*`). Two families:

**shadcn base** — `primary`, `secondary`, `muted-foreground`, `destructive`, `border`, `accent`, `background`, `card`. Safe defaults for anything generic.

**Apollo (`apollo-*`)** — this app's own semantic layer, each with ONE job, never mixed:
| Token | Meaning | Never use for |
|---|---|---|
| `apollo-maroon` | Brand chrome only — active nav item, h2 rule, card spine | A "selected"/provenance signal |
| `apollo-green` / `apollo-green-tint` | "Yours to edit" badge only (pair with a pencil icon) | Generic success |
| `apollo-lock-bg` | Locked/WCM-sourced provenance (pair with a lock icon + text label, not color alone) | — |
| `apollo-page` / `apollo-surface` / `apollo-surface-2` / `apollo-rail` | Three-level elevation: page ground → card/input fill → chip/thead/rail. Adjacent levels are never the same value | Skipping a level |
| `apollo-border` / `apollo-border-strong` | Hairline on white surfaces / any greige or input edge — `apollo-border` is nearly invisible on `apollo-rail`, use `-strong` there | — |
| `destructive` | Danger — errors, destructive actions | — |

Surfacing a new semantic color: check this table first: a hue already has a job in this system more often than not.

## Where the truth lives

`styles.css` (root, pulls in `_ds_bundle.css` + fonts) is the full token/utility source — read it before inventing a class or color. Per-component `<Name>.d.ts` is the prop contract; `<Name>.prompt.md` has real composed examples for every authored component.

## Example

```tsx
import { Card, Badge, Button } from "scholars-profile-system"

<div className="rounded-lg border border-apollo-border bg-apollo-surface p-4">
  <div className="flex items-center justify-between">
    <h3 className="text-sm font-medium">Dr. Elena Vasquez, MD, PhD</h3>
    <Badge variant="secondary">Active grant</Badge>
  </div>
  <p className="mt-1 text-sm text-muted-foreground">Cardiology · Weill Cornell Medicine</p>
  <Button variant="apollo" size="sm" className="mt-3">View profile</Button>
</div>
```
