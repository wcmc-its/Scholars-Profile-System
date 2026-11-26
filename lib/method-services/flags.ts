/**
 * Method services: the editor section on `/edit/department/[code]` and
 * `/edit/core/[coreId]`, and the `/api/edit/method-service` and
 * `/api/edit/method-families` routes behind it. Read lazily, never at module
 * load. Off by default: dark until a manual `cdk deploy`. SERVER-ONLY.
 *
 * A service is attached to method families, so the feature also needs the
 * method pages themselves: `METHODS_LENS_PAGES`, and the `METHODS_LENS_ENABLED`
 * master gate a method page cannot render without. With any of the three off,
 * the section is absent and both routes 404.
 */
import { isMethodPagesEnabled, isMethodsLensEnabled } from "@/lib/profile/methods-lens-flags";

export function isMethodServicesEnabled(): boolean {
  return process.env.METHOD_SERVICES === "on" && isMethodPagesEnabled() && isMethodsLensEnabled();
}
