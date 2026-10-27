-- #3115 ORCID /authenticate. Additive DDL only: a new table that nothing reads
-- until ORCID_CONNECT is on.

-- CreateTable
CREATE TABLE `orcid_authentication` (
    `cwid` VARCHAR(32) NOT NULL,
    `orcid` VARCHAR(19) NOT NULL,
    `name` VARCHAR(255) NULL,
    `access_token_enc` VARCHAR(512) NOT NULL,
    `scope` VARCHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NULL,
    `sandbox` BOOLEAN NOT NULL,
    `authenticated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `orcid_authentication` ADD CONSTRAINT `orcid_authentication_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
