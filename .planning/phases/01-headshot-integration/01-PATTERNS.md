# Phase 1: Headshot integration - Pattern Map

**Mapped:** 2026-04-30
**Files analyzed:** 9 new/modified files
**Analogs found:** 8 / 9

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `components/scholar/headshot-avatar.tsx` | component | request-response (image load + fallback state) | `components/profile/show-more-list.tsx` | role-match (client component with useState) |
| `lib/headshot.ts` | utility | transform (string → URL) | `lib/utils.ts` | role-match (pure utility export) |
| `lib/utils.ts` (add `initials`) | utility | transform | `lib/utils.ts` itself | exact (same file, same export pattern) |
| `lib/api/profile.ts` (add `identityImageEndpoint`) | service | CRUD (DB read → payload) | `lib/api/scholars.ts` | exact (same serializer shape pattern) |
| `lib/api/scholars.ts` (add `identityImageEndpoint`) | service | CRUD (DB read → payload) | `lib/api/profile.ts` | exact (same serializer shape pattern) |
| `lib/api/search.ts` (add `identityImageEndpoint` to `PeopleHit`) | service | CRUD (OpenSearch hit → payload) | `lib/api/scholars.ts` | role-match (payload type + mapper) |
| `next.config.ts` (add `images.remotePatterns`) | config | — | `ReCiter-Publication-Manager/next.config.js:9-17` | exact (identical block to mirror) |
| `app/(public)/scholars/[slug]/page.tsx` (replace Avatar at :83) | component | request-response | itself (lines 83-85 replaced) | exact (target already exists) |
| `app/(public)/search/page.tsx` (replace Avatar at :154) | component | request-response | itself (lines 154-156 replaced) | exact (target already exists) |

---

## Pattern Assignments

### `components/scholar/headshot-avatar.tsx` (NEW — client component, request-response)

**Analog:** `components/profile/show-more-list.tsx`

**Imports pattern** (`components/profile/show-more-list.tsx` lines 1-4):
```typescript
"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
```

Copy the `"use client"` directive at line 1 and named import from `react`. For `HeadshotAvatar`, replace with:
```typescript
"use client";

import { useState } from "react";
import Image from "next/image";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/utils";
```

**State management pattern** (`components/profile/show-more-list.tsx` lines 25-26):
```typescript
const [expanded, setExpanded] = useState(false);
```
Copy this exact `useState` pattern. For `HeadshotAvatar` the state tracks image load status:
```typescript
const [imgStatus, setImgStatus] = useState<"loading" | "loaded" | "error">("loading");
```

**Component function signature pattern** (`components/profile/show-more-list.tsx` lines 14-23):
```typescript
export function ShowMoreList({
  defaultItems,
  rest,
  showAllLabel = "Show all",
  showLessLabel = "Show fewer",
}: {
  defaultItems: ReactNode[];
  rest: ReactNode[];
  showAllLabel?: string;
  showLessLabel?: string;
}) {
```
Copy the named-export function with inline props destructuring and inline type. For `HeadshotAvatar`:
```typescript
export function HeadshotAvatar({
  cwid,
  preferredName,
  identityImageEndpoint,
  size,
  className,
}: {
  cwid: string;
  preferredName: string;
  identityImageEndpoint: string;
  size: "sm" | "md" | "lg";
  className?: string;
}) {
```

**Avatar primitive usage — existing call site pattern** (`app/(public)/scholars/[slug]/page.tsx` lines 83-85):
```tsx
<Avatar className="h-24 w-24 sm:h-28 sm:w-28">
  <AvatarFallback className="text-xl">{initials(profile.preferredName)}</AvatarFallback>
</Avatar>
```
This is the pattern being replaced. `HeadshotAvatar` wraps this exact structure and adds `AvatarImage` as a sibling of `AvatarFallback`.

**Avatar primitive — `AvatarImage` props surface** (`components/ui/avatar.tsx` lines 28-39):
```typescript
function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  )
}
```
`AvatarPrimitive.Image` (Radix) accepts `onLoadingStatusChange: (status: "idle" | "loading" | "loaded" | "error") => void` as a prop — passed through via `{...props}`. Use this to drive `data-headshot-state`.

**`cn` utility pattern** (`components/ui/avatar.tsx` line 6, 19-21):
```typescript
import { cn } from "@/lib/utils"
// ...
className={cn(
  "group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full ...",
  className
)}
```
Copy `cn(baseClasses, className)` for all className composition in `HeadshotAvatar`.

**Size → className mapping** (from UI-SPEC `01-UI-SPEC.md` lines 50-53):
```typescript
const sizeClass = {
  sm:  "size-6",                           // 24px — Phase 2 chip rows
  md:  "h-12 w-12",                        // 48px — search row
  lg:  "h-24 w-24 sm:h-28 sm:w-28",       // 96/112px — profile sidebar
}[size];
```

**`data-headshot-state` instrumentation** (from `01-RESEARCH.md` lines 443-464):
```tsx
const noImage = !identityImageEndpoint;

const dataState: "loading" | "image" | "fallback" =
  noImage ? "fallback"
  : imgStatus === "loaded" ? "image"
  : imgStatus === "error" ? "fallback"
  : "loading";

<Avatar
  data-headshot-state={dataState}
  className={cn(sizeClass, className)}
>
  {!noImage && (
    <AvatarImage
      asChild
      onLoadingStatusChange={(s) =>
        setImgStatus(s === "loaded" ? "loaded" : s === "error" ? "error" : "loading")
      }
    >
      <Image
        src={identityImageEndpoint}
        alt={preferredName}
        fill
        unoptimized
      />
    </AvatarImage>
  )}
  <AvatarFallback>{initials(preferredName)}</AvatarFallback>
</Avatar>
```
If `asChild` + `next/image` causes `onLoadingStatusChange` not to fire (Pitfall 1 in RESEARCH.md), fall back to a plain `<img>` without `asChild` and manage `onError` manually.

---

### `lib/headshot.ts` (NEW — pure utility, transform)

**Analog:** `lib/utils.ts`

**File structure pattern** (`lib/utils.ts` lines 1-6):
```typescript
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```
Copy the pattern: no default export, named `export function`. For `lib/headshot.ts`:
```typescript
const BASE =
  process.env.SCHOLARS_HEADSHOT_BASE ??
  "https://directory.weill.cornell.edu/api/v1/person/profile";

export function identityImageEndpoint(cwid: string): string {
  return `${BASE}/${cwid}.png?returnGenericOn404=false`;
}
```
The `SCHOLARS_HEADSHOT_BASE` env var is read at module load — no import needed. The hardcoded default is the full production prefix from `ReCiter-Publication-Manager/config/local.js:32-33` and `config/report.js:113`.

---

### `lib/utils.ts` — add `initials` export (MODIFIED)

**Analog:** `lib/utils.ts` itself (lines 1-6)

**Existing file** (`lib/utils.ts` lines 1-6):
```typescript
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

**Source for `initials` body** (identical in both page files):
`app/(public)/scholars/[slug]/page.tsx` lines 346-354:
```typescript
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
```
Copy this function verbatim; change `function` → `export function` to match the `cn` export pattern in the same file.

---

### `lib/api/profile.ts` — add `identityImageEndpoint` to `ProfilePayload` + return (MODIFIED)

**Analog:** `lib/api/scholars.ts` (same serializer pattern)

**Type field pattern** (`lib/api/scholars.ts` lines 10-27):
```typescript
export type ScholarPayload = {
  cwid: string;
  slug: string;
  preferredName: string;
  // ...
};
```
Add `identityImageEndpoint: string` (never null, always populated) to `ProfilePayload` at `lib/api/profile.ts` lines 45-89. Remove (or keep as deprecated) `headshotUrl: string | null` at line 53 per D-03.

**Import pattern** — add to top of `lib/api/profile.ts` line 9:
```typescript
import { identityImageEndpoint } from "@/lib/headshot";
```

**Return object pattern** (`lib/api/scholars.ts` lines 50-67):
```typescript
return {
  cwid: scholar.cwid,
  slug: scholar.slug,
  // ... other fields
};
```
In `lib/api/profile.ts` at the return object (lines 205-252), replace:
```typescript
headshotUrl: scholar.headshotUrl,
```
with:
```typescript
identityImageEndpoint: identityImageEndpoint(scholar.cwid),
```

---

### `lib/api/scholars.ts` — add `identityImageEndpoint` to `ScholarPayload` + return (MODIFIED)

**Analog:** `lib/api/profile.ts` (same pattern, already described above)

**Type to modify** (`lib/api/scholars.ts` lines 10-27):
```typescript
export type ScholarPayload = {
  cwid: string;
  slug: string;
  preferredName: string;
  fullName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  email: string | null;
  overview: string | null;
  appointments: Array<{...}>;
};
```
Add `identityImageEndpoint: string` after `overview`.

**Return object to modify** (`lib/api/scholars.ts` lines 50-67):
```typescript
return {
  cwid: scholar.cwid,
  slug: scholar.slug,
  preferredName: scholar.preferredName,
  fullName: scholar.fullName,
  primaryTitle: scholar.primaryTitle,
  primaryDepartment: scholar.primaryDepartment,
  email: scholar.email,
  overview: scholar.overview,
  appointments: scholar.appointments.map((a) => ({...})),
};
```
Add after `overview`:
```typescript
identityImageEndpoint: identityImageEndpoint(scholar.cwid),
```
And add the import at the top:
```typescript
import { identityImageEndpoint } from "@/lib/headshot";
```

---

### `lib/api/search.ts` — add `identityImageEndpoint` to `PeopleHit` + mapper (MODIFIED)

**Analog:** `lib/api/scholars.ts` (same type + mapper pattern)

**Type to modify** (`lib/api/search.ts` lines 46-55):
```typescript
export type PeopleHit = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  publicationCount: number;
  hasActiveGrants: boolean;
  highlight?: string[];
};
```
Add `identityImageEndpoint: string` after `hasActiveGrants`.

**Mapper to modify** (`lib/api/search.ts` lines 188-198):
```typescript
hits: r.hits.hits.map((h) => ({
  cwid: h._source.cwid,
  slug: h._source.slug,
  preferredName: h._source.preferredName,
  primaryTitle: h._source.primaryTitle,
  primaryDepartment: h._source.primaryDepartment,
  publicationCount: h._source.publicationCount,
  hasActiveGrants: h._source.hasActiveGrants,
  highlight: h.highlight ? Object.values(h.highlight).flat() : undefined,
})),
```
Add after `hasActiveGrants`:
```typescript
identityImageEndpoint: identityImageEndpoint(h._source.cwid),
```
And add the import at the top of the file:
```typescript
import { identityImageEndpoint } from "@/lib/headshot";
```

---

### `next.config.ts` — add `images.remotePatterns` (MODIFIED)

**Analog:** `ReCiter-Publication-Manager/next.config.js` lines 9-17

**Reference excerpt** (verified from PubMan, as recorded in `01-RESEARCH.md` lines 149-163):
```javascript
images: {
  remotePatterns: [
    {
      protocol: 'https',
      hostname: 'directory.weill.cornell.edu',
      pathname: '/**',
    },
  ],
}
```

**Current `next.config.ts`** (lines 1-8):
```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
```
Add `images` block inside `nextConfig`:
```typescript
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "directory.weill.cornell.edu",
        pathname: "/**",
      },
    ],
  },
};
```
Use double quotes (TypeScript file convention in this codebase).

---

### `app/(public)/scholars/[slug]/page.tsx` — replace Avatar at line 83 (MODIFIED)

**This is its own analog.** Lines 83-85 are the exact pattern being replaced.

**Current code** (lines 83-85):
```tsx
<Avatar className="h-24 w-24 sm:h-28 sm:w-28">
  <AvatarFallback className="text-xl">{initials(profile.preferredName)}</AvatarFallback>
</Avatar>
```

**Replacement:**
```tsx
<HeadshotAvatar
  size="lg"
  cwid={profile.cwid}
  preferredName={profile.preferredName}
  identityImageEndpoint={profile.identityImageEndpoint}
/>
```

**Import to add** (line 3, alongside existing Avatar imports — or replace them if `Avatar` / `AvatarFallback` are no longer used on this page after the swap):
```typescript
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
```

Remove the now-unused local `initials` function (lines 346-354) after `initials` is extracted to `lib/utils.ts`.

---

### `app/(public)/search/page.tsx` — replace Avatar at line 154 (MODIFIED)

**This is its own analog.** Lines 154-156 are the exact pattern being replaced.

**Current code** (lines 154-156):
```tsx
<Avatar className="h-12 w-12 shrink-0">
  <AvatarFallback>{initials(h.preferredName)}</AvatarFallback>
</Avatar>
```

**Replacement:**
```tsx
<HeadshotAvatar
  size="md"
  cwid={h.cwid}
  preferredName={h.preferredName}
  identityImageEndpoint={h.identityImageEndpoint}
/>
```

**Import to add** (alongside existing Avatar imports at line 2):
```typescript
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
```

Remove the now-unused local `initials` function (lines 613-621) after extraction to `lib/utils.ts`. The `h.identityImageEndpoint` field is sourced from `PeopleHit` (after the `lib/api/search.ts` modification above).

---

## Shared Patterns

### Named export functions (no default exports)
**Source:** `lib/utils.ts`, `lib/api/scholars.ts`, `components/profile/show-more-list.tsx`
**Apply to:** `lib/headshot.ts`, `components/scholar/headshot-avatar.tsx`
```typescript
// Pattern: always named exports, no `export default`
export function cn(...) { ... }
export function ShowMoreList(...) { ... }
export function getScholarByCwid(...) { ... }
```

### Path alias `@/` for all project imports
**Source:** `lib/api/profile.ts` line 9, `app/(public)/scholars/[slug]/page.tsx` lines 3-16
**Apply to:** all new/modified files
```typescript
import { prisma } from "@/lib/db";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
```
Never use relative `../` imports — always use `@/`.

### `"use client"` directive for stateful components
**Source:** `components/ui/avatar.tsx` line 1, `components/profile/show-more-list.tsx` line 1
**Apply to:** `components/scholar/headshot-avatar.tsx`
```typescript
"use client"
```
Must be the absolute first line (before all imports). Required because `HeadshotAvatar` uses `useState`.

### `cn()` for className composition
**Source:** `components/ui/avatar.tsx` lines 19-22
**Apply to:** `components/scholar/headshot-avatar.tsx`
```typescript
className={cn(baseClasses, className)}
```

### Environment variable with hardcoded fallback
**Source:** `01-RESEARCH.md` lines 285-292 (recommended pattern); PubMan `config/local.js:32-33`
**Apply to:** `lib/headshot.ts`
```typescript
const BASE =
  process.env.SCHOLARS_HEADSHOT_BASE ??
  "https://directory.weill.cornell.edu/api/v1/person/profile";
```
Never import from `.env`; never hardcode credentials. The base URL is not a secret (public URL), but follow the env-var convention per CLAUDE.md.

---

## Test File Patterns

### `tests/unit/headshot.test.ts` (NEW — unit test for utility + serializers)

**Analog:** `tests/unit/slug.test.ts`

**Full file pattern** (`tests/unit/slug.test.ts` lines 1-5):
```typescript
import { describe, expect, it } from "vitest";
import { deriveSlug, looksLikeSlug, nextAvailableSlug } from "@/lib/slug";

describe("deriveSlug", () => {
  it("handles plain ASCII names", () => {
    expect(deriveSlug("Jane Smith")).toBe("jane-smith");
  });
```
Copy `import { describe, expect, it } from "vitest"` as the first line. Use `describe` + `it` blocks. Import the function under test from its `@/lib/...` path. No mocking framework needed for pure utility functions.

For `headshot.test.ts`, test:
- `identityImageEndpoint("abc1234")` returns the correct URL with `returnGenericOn404=false`
- `initials("Augustine M.K. Choi")` returns `"AM"`
- `identityImageEndpoint("")` behavior (empty CWID edge case)

### `tests/unit/headshot-avatar.test.tsx` (NEW — component render test)

**Analog:** No existing component render tests in the repo (first `.tsx` test). Use vitest + jsdom (already configured in `vitest.config.ts` line 7: `environment: "jsdom"`).

**vitest.config.ts confirm** (lines 1-18):
```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
// ...
test: {
  environment: "jsdom",
  globals: true,
  include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
```
`*.test.tsx` files are already included. Use `@testing-library/react` + `render` pattern (standard with `@vitejs/plugin-react`). Test `data-headshot-state` attribute values for each of the four states.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `tests/unit/headshot-avatar.test.tsx` | test | — | No existing component render tests in the repo; first `.tsx` test file. Use vitest + jsdom (already configured) + `@testing-library/react` |

---

## Metadata

**Analog search scope:** `components/`, `lib/`, `app/(public)/`, `tests/`, `next.config.ts`
**Files scanned:** 14 source files + 2 PubMan reference files
**Pattern extraction date:** 2026-04-30
