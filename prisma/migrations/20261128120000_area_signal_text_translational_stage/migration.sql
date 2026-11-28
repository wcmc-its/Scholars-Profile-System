-- ReCiterAI translational stage on a grant TEXT, from the DynamoDB
-- AREASIGNAL#grant:<text_key> record (etl/dynamodb Block 10). Same raw values
-- as publication: stage T0 / T1 / T2 / T3-4 / NA, confidence high / medium /
-- low. Additive and nullable; display rules live in lib/translational-stage.ts.
ALTER TABLE `area_signal_text` ADD COLUMN `translational_stage` VARCHAR(8) NULL;
ALTER TABLE `area_signal_text` ADD COLUMN `translational_stage_confidence` VARCHAR(8) NULL;
