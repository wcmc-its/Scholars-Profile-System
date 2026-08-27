/**
 * #2519 — Cornell (Ithaca) directory-members feature flag. Gates the entire
 * dark surface added by PR 1: `GET /api/directory/people?source=cornell` and
 * the `source:"cornell"` branch of `POST /api/edit/roster`'s `add` action.
 * Everything else in this PR (schema, LDAP client) has no runtime effect on
 * its own — this is the one switch.
 *
 * Default OFF in both envs (`cdk/lib/app-stack.ts`). To turn it on in a
 * deployed env, set `CORNELL_DIRECTORY_MEMBERS` to `"on"` in the per-env
 * `environment:` block AND `cdk deploy Sps-App-<env>` — a merged flag is
 * `undefined` at runtime until that deploy (the flag-parity rule).
 */
export function isCornellDirectoryMembersEnabled(): boolean {
  return process.env.CORNELL_DIRECTORY_MEMBERS === "on";
}
