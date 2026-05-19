-- Slug-override uniqueness guard — self-edit-spec.md § The v1 editable-field set.
--
-- A slug override is checked for collisions in application code
-- (lib/edit/validators.ts checkSlugCollision), but that check is NOT atomic:
-- two superusers writing the same slug for *different* CWIDs each pass the
-- application check independently. The field_override @@unique is on the
-- target (entity_type, entity_id, field_name), not on the value, so it does
-- not catch this. This migration closes the race at the database.
--
-- MySQL / MariaDB has no partial index, so uniqueness is scoped to slug-
-- override rows via a STORED generated column, `slug_guard`, that holds the
-- override `value` ONLY for (entity_type='scholar', field_name='slug') rows
-- and NULL for every other row. A UNIQUE index over it permits unlimited NULLs
-- (every non-slug override) and rejects a duplicate slug value across CWIDs.
-- A concurrent duplicate fails here and surfaces to the caller as the same
-- 400 the application collision check returns.
--
-- `slug_guard` is a generated column. It is marked `@ignore` in
-- prisma/schema.prisma so it is absent from the generated Prisma client —
-- application code cannot write a generated column (the DB would reject it),
-- and `@ignore` makes that unrepresentable rather than merely discouraged.

ALTER TABLE `field_override`
  ADD COLUMN `slug_guard` VARCHAR(64)
    GENERATED ALWAYS AS (
      CASE
        WHEN `entity_type` = 'scholar' AND `field_name` = 'slug' THEN `value`
      END
    ) STORED;

CREATE UNIQUE INDEX `field_override_slug_guard_key` ON `field_override`(`slug_guard`);
