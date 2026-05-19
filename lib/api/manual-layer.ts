/**
 * Self-edit v1 — the read-merge layer (#356; ADR-005 § read-merge).
 *
 * The manual-override layer (`field_override`) holds human-entered data that
 * survives every ETL rebuild. At read time a `field_override` row takes
 * precedence over the ETL-managed column it shadows.
 *
 * v1 runtime-merges exactly one field — `overview`. This module is therefore a
 * single function rather than the generic `Merged<T>` machinery ADR-005
 * anticipates for a wider merged-field set; that generalization is worth its
 * ceremony only once a second field is runtime-merged. (`slug` is also
 * override-able, but a slug override is consumed by `etl/ed`, not merged at
 * runtime — there is nothing to merge for it here.)
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { sanitizeVIVOHtml } from "@/lib/utils";

/** The Prisma surface `getEffectiveOverview` needs — a client or a tx satisfies it. */
type OverrideReadClient = Pick<PrismaClient, "fieldOverride">;

/**
 * The effective `overview` for a scholar.
 *
 * If a `field_override(scholar, cwid, 'overview')` row exists it is
 * **authoritative** — including an empty value, which is the scholar
 * deliberately clearing their bio; the ETL seed is not shown in that case.
 * The override value was sanitized on write (`lib/edit/validators.ts`
 * `sanitizeOverview`), so it is returned as-is — the public render's existing
 * raw `dangerouslySetInnerHTML` path needs no change (`self-edit-spec.md`
 * § The v1 editable-field set).
 *
 * With no override, the ETL-managed `Scholar.overview` column is used, cleaned
 * of legacy VIVO serializer artifacts.
 *
 * Returns `null` for "no overview" — an absent column, or an override whose
 * sanitized value is the empty string.
 */
export async function getEffectiveOverview(
  cwid: string,
  etlOverview: string | null,
  client: OverrideReadClient,
): Promise<string | null> {
  const override = await client.fieldOverride.findUnique({
    where: {
      entityType_entityId_fieldName: {
        entityType: "scholar",
        entityId: cwid,
        fieldName: "overview",
      },
    },
    select: { value: true },
  });
  if (override) {
    return override.value === "" ? null : override.value;
  }
  return etlOverview ? sanitizeVIVOHtml(etlOverview) : null;
}
