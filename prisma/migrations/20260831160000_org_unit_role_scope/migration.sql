-- #2557 Phase E amendment — explicit role scoping, not default-allow.
--
-- `research` and `clinical` are NCI CCSG vocabulary seeded into the SHARED
-- `center` role vocabulary, so all 11 centers could use them, but only Meyer
-- does (298 `research` rows, 54 `clinical`, all at `meyer_cancer_center` —
-- measured prod 2026-08-31). Nothing enforced that scoping before this
-- branch. This table is what does: `app/api/edit/roster/route.ts` gates
-- every center-membership write that stamps a role key against it, via
-- `isRoleAllowedAtUnit` (`lib/api/org-unit-role-scope.ts`). Not yet gated:
-- the director assignment write path in `app/api/edit/unit/route.ts`
-- (`OrgUnitRoleAssignment`, hardcoded `DIRECTOR_ROLE_KEY`) — no practical hole
-- today since `director` carries no scope rows, but a future scope row on a
-- leadership role would not be enforced until that path is gated too. There
-- is also no steward UI yet for editing the rows this table holds.
--
-- SEMANTICS: zero rows for a (entity_type, role_key) pair means UNRESTRICTED
-- — assignable at any unit of that kind, exactly as today's no-scope-table
-- behavior. One or more rows means the role is allowed ONLY at those
-- entity_ids, denied everywhere else. This is DELIBERATELY NOT a global
-- default-deny: an empty table stays permissive so no unit can be born unable
-- to render a leader (creating a center already mints no `unit_admin` row —
-- a model requiring rows to exist before assignment works would inherit that
-- same fail-closed hazard). Full rationale: issue #2557.
--
-- NO FK on entity_id — polymorphic, same reason `org_unit_role_assignment`
-- has none: a scope row is a fact about a unit, not a child row, and an
-- informal unit's synthetic code is known only to the manual layer.
--
-- EXPAND ONLY. NO DATA: seeding (the two Meyer rows) belongs in a script, not
-- here — `tests/unit/migrations-empty-db-safe.test.ts` fails any `INSERT INTO`
-- in a migration because a fresh CI database has no `org_unit_role` parent
-- rows yet (MySQL 1452, the #584 regression).
--
-- Hand-written. `prisma migrate diff` is unusable in this repo: it emits 44
-- unrelated `MODIFY ... JSON` statements on an UNMODIFIED master checkout.

CREATE TABLE `org_unit_role_scope` (
    `entity_type` VARCHAR(32)  NOT NULL,
    `role_key`    VARCHAR(32)  NOT NULL,
    `entity_id`   VARCHAR(64)  NOT NULL,
    `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`entity_type`, `role_key`, `entity_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Closure IN THE DATABASE, mirroring `org_unit_role_assignment`: a scope row
-- can only ever reference a vocabulary entry a superuser put on the list.
ALTER TABLE `org_unit_role_scope`
    ADD CONSTRAINT `org_unit_role_scope_entity_type_role_key_fkey`
    FOREIGN KEY (`entity_type`, `role_key`)
    REFERENCES `org_unit_role`(`entity_type`, `key`)
    ON DELETE NO ACTION ON UPDATE NO ACTION;
