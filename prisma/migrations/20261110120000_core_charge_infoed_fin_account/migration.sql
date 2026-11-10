-- MCC shared-resource usage report, PR 1: ingest.
--
-- `core_charge` holds iLab core charges, loaded quarterly by
-- etl/ilab/import.ts (replaces every row in the file's ERP-date range).
-- `infoed_fin_account` maps an 8-digit InfoEd `proposal.acct` (the first 8
-- digits of an iLab WBS) to the parent InfoEd Account_Number used in
-- grant.external_id; full-replaced by etl/infoed/index.ts.

-- CreateTable
CREATE TABLE `core_charge` (
    `charge_id` VARCHAR(32) NOT NULL,
    `core_name` VARCHAR(255) NOT NULL,
    `customer_lab` VARCHAR(255) NULL,
    `pi_cwid` VARCHAR(32) NULL,
    `ilab_mcc` BOOLEAN NOT NULL,
    `total_price` DECIMAL(12, 2) NOT NULL,
    `is_subsidy` BOOLEAN NOT NULL,
    `payment_number` VARCHAR(32) NULL,
    `erp_date` DATE NOT NULL,
    `billing_date` DATE NULL,
    `purchase_date` DATE NULL,
    `imported_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `core_charge_erp_date_idx`(`erp_date`),
    INDEX `core_charge_pi_cwid_idx`(`pi_cwid`),
    PRIMARY KEY (`charge_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `infoed_fin_account` (
    `fin_account` VARCHAR(8) NOT NULL,
    `account_number` VARCHAR(64) NOT NULL,

    INDEX `infoed_fin_account_account_number_idx`(`account_number`),
    PRIMARY KEY (`fin_account`, `account_number`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
