import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session-server";
import { isSuperuser } from "@/lib/auth/superuser";
import { isCommsSteward, isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { buildConsoleLinks, type ConsoleLink } from "@/lib/auth/console-links";
import { impersonationActive } from "@/lib/auth/effective-identity";
import {
  resolveImpersonationDisplay,
  type ImpersonationUnitKind,
} from "@/lib/edit/impersonation-display";
import { loadManageableUnits } from "@/lib/edit/manageable-units";
import { db } from "@/lib/db";

/**
 * GET /api/auth/session — the header's client-side auth probe (#356 Phase 5,
 * extended for "View as" impersonation #637 §6/§7).
 *
 * The site header is rendered on every public surface, but those surfaces are
 * served by CloudFront's *cacheable* default behavior, which strips the Cookie
 * header before it reaches the origin (cdk/lib/edge-stack.ts: the cache spec's
 * "single most important knob"). So a server-rendered header on a public page
 * never sees the session cookie and always shows "Sign in", even for a
 * signed-in user.
 *
 * This route lives under `/api/auth/*`, one of the few CloudFront behaviors
 * that forwards cookies (CachingDisabled + AllViewer), so it CAN read the
 * session. `HeaderAuthSlot` fetches it client-side to render the real auth
 * state. Returns only what the header shows (auth flag + the scholar's public
 * slug/name) -- no PII, no session internals.
 *
 * **Impersonation (#637).** The amber banner and the switcher are also
 * client-probed (T6 — they must survive CloudFront-cached public pages, so a
 * server-only banner would vanish). This probe therefore also reports:
 *   - `impersonating` — the *live* overlay's target (name/slug/role/unit +
 *     `startedAt`), or `null`. Resolved from the EFFECTIVE seam so a stale
 *     (past-TTL) or flag-off overlay reads as `null`, exactly as the server
 *     treats it (spec §2 read-time expiry, E1/E5). The banner reads this; when
 *     null it renders nothing.
 *   - `canImpersonate` — whether the REAL signed-in CWID may *start*
 *     impersonating (`isSuperuser(session.cwid)`, R1, against the real cwid
 *     never the effective one). Gates the switcher entry. Always `false` when
 *     the feature flag is off, so the switcher stays hidden when dark.
 *   - `consoleLinks` — the ordered, role-aware `/edit` console entry points the
 *     viewer is entitled to (`lib/auth/console-links.ts`,
 *     role-aware-navigation-entry-points-spec.md). The account-menu renders them
 *     verbatim under one "Manage" section, so a non-superuser steward or unit
 *     admin finally has a clickable path into the console (replacing the old
 *     superuser-only `canBrowseProfiles` flag). Computed against the REAL cwid;
 *     `[]` for a plain scholar.
 */
export const dynamic = "force-dynamic";

type ScholarLite = { slug: string; preferredName: string };

type ImpersonatingBlock = {
  targetCwid: string;
  targetName: string;
  role: "owner" | "curator" | "scholar";
  unitKind: ImpersonationUnitKind | null;
  unit: string | null;
  startedAt: number;
};

export async function GET(): Promise<NextResponse> {
  const session = await getSession().catch(() => null);
  const noStore = { "cache-control": "no-store" };

  if (!session) {
    return NextResponse.json(
      {
        authenticated: false,
        scholar: null,
        impersonating: null,
        canImpersonate: false,
        consoleLinks: [],
      },
      { headers: noStore },
    );
  }

  // The real signed-in scholar (always the real `cwid`, never the effective
  // one — the banner's "You are <real>" line and the switcher gate both read
  // the human, per spec §2/§3).
  const scholar = await db.read.scholar
    .findUnique({
      where: { cwid: session.cwid },
      select: { slug: true, preferredName: true },
    })
    .catch(() => null);

  // The superuser verdict, resolved once and reused below. Live LDAPS check
  // against the REAL cwid; `isSuperuser` is fail-closed, so a directory hiccup
  // just hides the superuser surfaces.
  const superuser = await isSuperuser(session.cwid).catch(() => false);

  // R1 — only a superuser may initiate impersonation, AND the feature must be
  // enabled. The flag-off short-circuit (mirrored from `impersonationActive`)
  // keeps a dark deployment from advertising the switcher entry.
  const featureEnabled = process.env.IMPERSONATION_ENABLED === "true";
  const canImpersonate = featureEnabled && superuser;

  // Role-aware console entry points for the account-menu dropdown
  // (`lib/auth/console-links.ts`, role-aware-navigation-entry-points-spec.md).
  // A superuser collapses to the Profiles roster (its AdminSubnav fans out to
  // the rest) and skips the steward / unit lookups entirely — so a superuser
  // probe costs no extra directory or DB work. A non-superuser pays only for the
  // roles they might hold: `isCommsSteward` (flag-gated — short-circuits to
  // false with NO directory call when `COMMS_STEWARD_ENABLED` is off) and one
  // indexed `unit_admin` lookup. All verdicts are against the REAL cwid, like
  // `canImpersonate` above. Fail-closed: a lookup error just drops that link.
  let consoleLinks: ConsoleLink[];
  if (superuser) {
    consoleLinks = buildConsoleLinks({
      isSuperuser: true,
      canManageMethods: false,
      managesUnits: false,
    });
  } else {
    const commsSteward = await isCommsSteward(session.cwid).catch(() => false);
    const manageable = await loadManageableUnits(session.cwid, db.read).catch(() => null);
    consoleLinks = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: isMethodsTabVisible({ isSuperuser: false, isCommsSteward: commsSteward }),
      managesUnits: manageable !== null && manageable.total > 0,
    });
  }

  // The live overlay's target, if any. `impersonationActive` already folds in
  // the flag and the read-time TTL, so a stale or flag-off overlay yields null.
  let impersonating: ImpersonatingBlock | null = null;
  if (impersonationActive(session, Math.floor(Date.now() / 1000)) && session.impersonating) {
    const targetCwid = session.impersonating.targetCwid;
    const target = await db.read.scholar
      .findUnique({
        where: { cwid: targetCwid },
        select: { slug: true, preferredName: true, primaryDepartment: true },
      })
      .catch(() => null);
    if (target) {
      const display = await resolveImpersonationDisplay(
        targetCwid,
        db.read,
        target.primaryDepartment,
      ).catch(() => ({
        role: "scholar" as const,
        unitKind: null as ImpersonationUnitKind | null,
        unit: target.primaryDepartment,
      }));
      impersonating = {
        targetCwid,
        targetName: target.preferredName,
        role: display.role,
        unitKind: display.unitKind,
        unit: display.unit,
        startedAt: session.impersonating.startedAt,
      };
    }
  }

  return NextResponse.json(
    { authenticated: true, scholar, impersonating, canImpersonate, consoleLinks },
    { headers: noStore },
  );
}
