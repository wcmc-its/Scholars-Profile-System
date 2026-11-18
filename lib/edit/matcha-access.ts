/**
 * The Matcha write-side gate, shared by `POST /api/edit/matcha` and `POST /api/edit/matcha/export`.
 * `readEditRequest` strips the observer's synthetic read view, so `session.isObserver` is always
 * false here; ask the directory for the EFFECTIVE cwid (a superuser viewing as an observer sees
 * what the observer sees). An observer's own View-as overlay never reaches this:
 * `readEditRequest` refuses writes under it.
 */
import { isObserver } from "@/lib/auth/observer";
import type { EditSession } from "@/lib/auth/superuser";

export async function canUseMatchaForWrite(session: EditSession): Promise<boolean> {
  return session.isSuperuser || session.isDeveloper === true || (await isObserver(session.cwid));
}
