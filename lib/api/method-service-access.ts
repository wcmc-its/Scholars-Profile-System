/**
 * Who may do what with a unit's method services (`method_service`).
 *
 * Connecting a unit to a method is a superuser's decision: creating a service,
 * removing it, and its name, link, methods and matching settings. Keeping the
 * list of publications the unit supported up to date is the unit's own job:
 * the people who may edit the unit can change `supportedPmids` and use
 * "Not ours" / "Undo", and nothing else.
 *
 * Shared by `/api/edit/method-service` and the two edit pages, so the page
 * never shows a control the route would refuse. Imports `@/lib/db`: server
 * only.
 */
import { loadMethodServicesForUnit } from "@/lib/api/method-services";
import { stripContentEditorView, stripObserverView } from "@/lib/auth/observer-view";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  authorizeCoreClaim,
  canEditUnit,
  getCoreOwnerRole,
  getEffectiveUnitRole,
  type AuthzResult,
  type CoreOwnerLookup,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import { isMethodServicesEnabled } from "@/lib/method-services/flags";
import {
  toPublicationsView,
  type MethodServiceEntityType,
  type MethodServicesForViewer,
} from "@/lib/method-services/validation";

/**
 * Whether `session` may edit the unit a service belongs to: the same
 * predicates the unit's edit page and sibling routes use.
 *   - department: `getEffectiveUnitRole` + `canEditUnit` (Owner / Curator,
 *     Superuser, comms_steward, content editor), as `/api/edit/unit-leadership`;
 *   - core: `getCoreOwnerRole` + `authorizeCoreClaim` (Owner / Curator,
 *     Superuser, comms_steward, content editor), as `/api/edit/core`.
 * Pass the session a WRITE is authorized against (observer and content-editor
 * read views stripped).
 */
export async function mayEditServiceUnit(
  session: EditSession,
  entityType: MethodServiceEntityType,
  entityId: string,
): Promise<AuthzResult> {
  if (entityType === "department") {
    const role = await getEffectiveUnitRole(
      session,
      { kind: "department", code: entityId },
      db.read as unknown as UnitAdminLookup,
    );
    return canEditUnit(session, role);
  }
  const role = await getCoreOwnerRole(session, entityId, db.read as unknown as CoreOwnerLookup);
  return authorizeCoreClaim(session, role);
}

/**
 * What a unit's edit page hands its Method services section, for this viewer.
 *   - a superuser: every service, the whole editor (`manage`);
 *   - someone else who may edit the unit: the unit's services without their
 *     affiliation phrases and author names (`publications`), and only when the
 *     unit already has at least one, since such a viewer cannot add one;
 *   - anyone else, or with the flag off: `null` (no section), and the list is
 *     not read.
 * `session` is the page's effective session; the unit check runs on the
 * session a write would be authorized against, so an observer's read-only
 * view is offered nothing it could not save.
 */
export async function loadMethodServicesForViewer(
  session: EditSession,
  entityType: MethodServiceEntityType,
  entityId: string,
): Promise<MethodServicesForViewer | null> {
  if (!isMethodServicesEnabled()) return null;
  if (session.isSuperuser) {
    return { mode: "manage", services: await loadMethodServicesForUnit(entityType, entityId) };
  }
  const writer = stripContentEditorView(stripObserverView(session));
  if (!(await mayEditServiceUnit(writer, entityType, entityId)).ok) return null;
  const services = await loadMethodServicesForUnit(entityType, entityId);
  if (services.length === 0) return null;
  return { mode: "publications", services: services.map(toPublicationsView) };
}
