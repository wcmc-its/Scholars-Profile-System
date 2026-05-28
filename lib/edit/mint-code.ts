/**
 * Server-only — mint a synthetic `code` for an Owner-creatable informal
 * center (#540 Phase 5b, `/api/edit/unit op:"create"`).
 *
 * Lives in its own file because it pulls `node:crypto`, which the Next.js
 * client bundle rejects. `lib/edit/validators.ts` is imported by client
 * components (`components/edit/slug-card.tsx`, …) so the mint helper
 * must NOT be re-exported through that module.
 *
 * The prefix `man-` is deliberately lowercase so a synthetic code is never
 * mistaken for an LDAP N-code (uppercase `N` + digits). 8 hex chars =
 * 4·10^9 possibilities; the caller retries the insert on the (rare)
 * collision against `Center.code @id`.
 */
import { randomBytes } from "node:crypto";

export function mintSyntheticUnitCode(randomHex: () => string = defaultRandomHex): string {
  return `man-${randomHex()}`;
}

function defaultRandomHex(): string {
  return randomBytes(4).toString("hex");
}
