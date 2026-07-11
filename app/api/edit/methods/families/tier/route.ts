/**
 * POST /api/edit/methods/families/tier — set a Method-Family's visibility tier
 * (`docs/comms-steward-methods-visibility-spec.md` §7).
 *
 * Body `{ supercategory, familyLabel, tier: 'public'|'suppressed'|'sensitive' }`.
 * The tier is NOT a stored column — it is overlay membership, so a write moves
 * the family's row between the two overlay tables:
 *
 *   - "suppressed" => upsert the #800 suppression overlay (source:'steward'),
 *                     delete any #801 sensitivity row for the family.
 *   - "sensitive"  => upsert the #801 sensitivity overlay (source:'steward'),
 *                     delete any #800 suppression row for the family.
 *   - "public"     => delete the family's row from BOTH overlays (no overlay
 *                     row == the default public tier).
 *
 * Keyed on the STABLE `(supercategory, family_label)` identity. The before/after
 * tier is derived from pre-write overlay membership and recorded on a
 * `family_tier_set` / `method_family` audit row inside the SAME transaction. The
 * change is a query-time-merged overlay write: reversible, no reindex, no ETL.
 *
 * Gate order (§7/§9): COMMS_STEWARD_ENABLED off => 404; anonymous => 401 (via the
 * shared preamble); non-steward/superuser => 403 (`not_comms_steward`, logged).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { isCommsStewardEnabled } from "@/lib/auth/comms-steward";
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeCommsStewardAction, logEditDenial } from "@/lib/edit/authz";
import { apiError } from "@/lib/api/error-response";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { familyOverlayKey } from "@/lib/api/methods-overlay";
import { FAMILY_TIERS, type FamilyTier } from "@/lib/api/methods-families";
import { bust } from "@/lib/api/swr-cache";

const PATH = "/api/edit/methods/families/tier";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Master kill switch first — the whole surface 404s when off (§9), before any
  // session/origin work so the route is indistinguishable from a missing one.
  if (!isCommsStewardEnabled()) return apiError("not_found", 404);

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // comms_steward OR superuser (§3 superset).
  const authz = authorizeCommsStewardAction(session);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  // Validate the body — stable family key + a known tier value.
  const { supercategory, familyLabel, tier } = body;
  if (typeof supercategory !== "string" || supercategory.length === 0) {
    return editError(400, "invalid_supercategory", "supercategory");
  }
  if (typeof familyLabel !== "string" || familyLabel.length === 0) {
    return editError(400, "invalid_family_label", "familyLabel");
  }
  if (typeof tier !== "string" || !FAMILY_TIERS.has(tier as FamilyTier)) {
    return editError(400, "invalid_tier", "tier");
  }
  const nextTier = tier as FamilyTier;
  const auditId = familyOverlayKey(supercategory, familyLabel);

  try {
    await db.write.$transaction(async (tx) => {
      // Derive the BEFORE tier from current overlay membership (suppression
      // precedence, matching the resolver + the roster builder).
      const [supRow, senRow] = await Promise.all([
        tx.familySuppressionOverlay.findUnique({
          where: { supercategory_familyLabel: { supercategory, familyLabel } },
          select: { supercategory: true },
        }),
        tx.familySensitivityOverlay.findUnique({
          where: { supercategory_familyLabel: { supercategory, familyLabel } },
          select: { supercategory: true },
        }),
      ]);
      const beforeTier: FamilyTier = supRow
        ? "suppressed"
        : senRow
          ? "sensitive"
          : "public";

      if (nextTier === "suppressed") {
        await tx.familySuppressionOverlay.upsert({
          where: { supercategory_familyLabel: { supercategory, familyLabel } },
          create: { supercategory, familyLabel, source: "steward" },
          update: { source: "steward", refreshedAt: new Date() },
        });
        if (senRow) {
          await tx.familySensitivityOverlay.delete({
            where: { supercategory_familyLabel: { supercategory, familyLabel } },
          });
        }
      } else if (nextTier === "sensitive") {
        await tx.familySensitivityOverlay.upsert({
          where: { supercategory_familyLabel: { supercategory, familyLabel } },
          create: { supercategory, familyLabel, source: "steward" },
          update: { source: "steward", refreshedAt: new Date() },
        });
        if (supRow) {
          await tx.familySuppressionOverlay.delete({
            where: { supercategory_familyLabel: { supercategory, familyLabel } },
          });
        }
      } else {
        // "public" — no overlay row in either table.
        if (supRow) {
          await tx.familySuppressionOverlay.delete({
            where: { supercategory_familyLabel: { supercategory, familyLabel } },
          });
        }
        if (senRow) {
          await tx.familySensitivityOverlay.delete({
            where: { supercategory_familyLabel: { supercategory, familyLabel } },
          });
        }
      }

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "method_family",
        targetEntityId: auditId,
        action: "family_tier_set",
        fieldsChanged: ["tier"],
        beforeValues: { tier: beforeTier },
        afterValues: { tier: nextTier, supercategory, family_label: familyLabel },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // #1537 — the /methods rollup is served through the swr-cache; a tier change
  // must evict it so a newly suppressed family disappears immediately.
  bust("methods:");

  return editOk({ supercategory, familyLabel, tier: nextTier });
}
