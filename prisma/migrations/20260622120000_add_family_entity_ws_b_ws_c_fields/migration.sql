-- #1168 Methods Surface B — generalize per-paper usage snippets to ALL tool/method families.
-- Additive WS-B (#252) + WS-C (#253/#254) producer fields on the entity layer; all nullable
-- or defaulted, so the columns are inert until the producer emits them (current artifact has
-- is_generic=false / dominant_kind=organism_or_cells everywhere — all cell lines).
--   family_entity.is_generic        — WS-B generic-vocabulary flag (soft-suppressed in UI)
--   family_entity.dominant_kind     — the family's `kind` (ReciterAI #260) → rail-header noun
--   family_entity_usage.informativeness_score — WS-C sentence informativeness [0,1]
--   family_entity_usage.mention_class         — WS-C {usage, mention} → snippet badge label
--   family_entity_usage.sentence_complete     — #254 sentence-boundary completeness hint

-- AlterTable
ALTER TABLE `family_entity` ADD COLUMN `dominant_kind` VARCHAR(32) NULL,
    ADD COLUMN `is_generic` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `family_entity_usage` ADD COLUMN `informativeness_score` DECIMAL(6, 4) NULL,
    ADD COLUMN `mention_class` VARCHAR(32) NULL,
    ADD COLUMN `sentence_complete` BOOLEAN NULL;
