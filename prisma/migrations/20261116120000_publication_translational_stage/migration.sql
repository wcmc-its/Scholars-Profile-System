-- ReCiterAI translational stage on publication, from the DynamoDB IMPACT# record
-- (etl/dynamodb Block 4). Raw values: stage T0 / T1 / T2 / T3-4 / NA, confidence
-- high / medium / low. Additive and nullable; display rules live in
-- lib/translational-stage.ts.
ALTER TABLE `publication` ADD COLUMN `translational_stage` VARCHAR(8) NULL;
ALTER TABLE `publication` ADD COLUMN `translational_stage_confidence` VARCHAR(8) NULL;
